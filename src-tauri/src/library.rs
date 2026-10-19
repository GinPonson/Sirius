use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

/// 一条备份配对：本地目录 → 115 目录的单向同步关系。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPair {
    pub id: String,
    pub local_path: String,
    pub remote_folder_id: String,
    pub remote_folder_name: String,
    /// 最近一次同步时间；从未同步过为 None。
    pub last_synced_at: Option<String>,
    /// 已记录同步完成的文件数。
    pub synced_files: u64,
    /// 待同步文件数；只有扫描命令能给出准确值，列表接口固定为 0。
    pub pending_files: u64,
}

/// 单个文件的上次同步指纹；用于判断本地文件是否自上次同步后发生变化。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupFileState {
    pub local_size: u64,
    pub local_modified_at: u64,
    pub remote_file_id: String,
}

/// 一次磁盘文件快照；纳秒级时间避免同一秒内的等长编辑被误判为未变化。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackupFingerprint {
    pub size_bytes: u64,
    pub modified_at: u64,
}

impl BackupFingerprint {
    /// 读取普通文件的大小与修改时间；路径无效、符号链接或时间不可读时返回错误。
    pub fn read(path: &Path) -> Result<Self, String> {
        let metadata = std::fs::symlink_metadata(path)
            .map_err(|error| format!("读取备份文件 {} 信息失败：{error}", path.display()))?;
        if !metadata.is_file() {
            return Err(format!("备份源不是普通文件：{}", path.display()));
        }
        let modified_at = metadata
            .modified()
            .map_err(|error| format!("读取备份文件修改时间失败：{error}"))?
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("备份文件修改时间无效：{error}"))?
            .as_nanos();
        Ok(Self {
            size_bytes: metadata.len(),
            modified_at: u64::try_from(modified_at)
                .map_err(|_| "备份文件修改时间超出支持范围".to_string())?,
        })
    }
}

/// 扫描结果：需要上传的文件与统计。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupScanResult {
    pub pair_id: String,
    /// 本地目录中发现的文件总数。
    pub total_files: u64,
    /// 新增或内容已变化、需要上传的文件数。
    pub pending_files: u64,
    /// 与上次同步一致、可跳过的文件数。
    pub unchanged_files: u64,
    /// 需要上传的相对路径（已排序，供界面预览与逐条执行）。
    pub pending_paths: Vec<String>,
}

/// 用户可持久化调整的应用设置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// 刮削结果的首选语言；当前只允许界面中公开的两个语言选项。
    pub metadata_language: String,
    /// 扫描发现新媒体文件后，是否自动创建待刮削任务。
    pub auto_scrape: bool,
    /// 是否读取和保存 115 视频的本地播放进度。
    pub playback_history: bool,
}

/// AI 整理服务商配置；API 密钥只存钥匙串，绝不写入 SQLite。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderSettings {
    /// OpenAI 兼容接口的根地址，例如 https://api.deepseek.com。
    pub base_url: String,
    /// 用于整理分析的模型名称。
    pub model: String,
}

/// AI 对话会话元数据；消息正文与页面上下文快照保存在 ai_chat_messages。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatSession {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

/// AI 对话消息行；context_json 是前端随该条消息注入的页面上下文 JSON 快照（可空）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessageRow {
    pub id: String,
    pub session_id: String,
    /// "user" 或 "assistant"。
    pub role: String,
    pub content: String,
    pub context_json: Option<String>,
    pub created_at: String,
}

/// AI 对话的默认标题；前端未指定标题时使用。
const AI_CHAT_DEFAULT_TITLE: &str = "新对话";

/// 经过刮削后供前端展示的媒体实体。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: String,
    pub title: String,
    pub original_title: String,
    pub year: i64,
    pub kind: String,
    pub rating: f64,
    pub runtime_minutes: i64,
    pub genres: Vec<String>,
    pub overview: String,
    pub director: String,
    pub cast: Vec<String>,
    pub poster_tone: String,
    pub poster_accent: String,
    pub progress: f64,
    pub source_label: String,
    pub source_status: String,
}

/// 展示在任务页的持久化扫描或刮削任务。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTask {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub status: String,
    pub progress: f64,
}

/// 漫画目录索引行；payload 是 ComicsOverview 的 JSON 快照。
#[derive(Debug, Clone)]
pub struct ComicsIndexRow {
    pub folder_id: String,
    pub payload_json: String,
    pub scanned_at: String,
}

/// 刮削并持久化的媒体信息；时长/分辨率/编码允许为空，取决于来源能提供多少。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    /// "cloud115" 或 "local"。
    pub provider: String,
    pub file_id: String,
    pub duration_seconds: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
}

/// 相册目录索引行；payload 是 PhotosOverview 的 JSON 快照。
#[derive(Debug, Clone)]
pub struct AlbumsIndexRow {
    pub folder_id: String,
    pub payload_json: String,
    pub scanned_at: String,
}

/// 云端视频的本地播放位置；不向 115 写入任何观看行为。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackProgress {
    pub file_id: String,
    pub position_seconds: f64,
    pub duration_seconds: f64,
}

/// 已完成 OSS 分片的编号与 ETag；恢复上传时用于跳过已确认分片。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadPartState {
    pub number: u32,
    pub etag: String,
}

/// 可跨 App 重启恢复的 115 multipart 会话；STS 临时密钥明确不持久化。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadSession {
    /// 创建会话的 115 用户；恢复上传时必须与当前登录账号一致。
    pub account_id: u64,
    pub id: String,
    pub local_path: String,
    pub file_name: String,
    pub target_id: String,
    pub file_size: u64,
    pub file_sha1: String,
    pub pre_sha1: String,
    pub pick_code: String,
    pub bucket: String,
    pub object_key: String,
    pub upload_id: String,
    pub callback: String,
    pub callback_var: String,
    pub part_size: u64,
    pub completed_parts: Vec<UploadPartState>,
    pub status: String,
}

/// SQLite 媒体仓储。
///
/// Connection 由 Mutex 串行化，避免多个 Tauri command 同时操作同一连接。
/// 后续扫描和刮削任务也必须通过该仓储写入，不能从前端直接拼 SQL。
pub struct LibraryRepository {
    connection: Mutex<Connection>,
}

impl LibraryRepository {
    /// 打开数据库、执行幂等迁移，并在全新数据库中写入可验收的初始目录。
    pub fn open(database_path: &Path) -> Result<Self, String> {
        if database_path != Path::new(":memory:") {
            let parent = database_path
                .parent()
                .ok_or_else(|| "SQLite 媒体库路径缺少父目录".to_string())?;
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("创建媒体库目录失败：{error}"))?;
        }
        let connection = Connection::open(database_path)
            .map_err(|error| format!("打开 SQLite 媒体库失败：{error}"))?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA journal_mode = WAL;
                 CREATE TABLE IF NOT EXISTS schema_migrations (
                   version INTEGER PRIMARY KEY,
                   applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );
                 CREATE TABLE IF NOT EXISTS media_items (
                   id TEXT PRIMARY KEY,
                   title TEXT NOT NULL,
                   original_title TEXT NOT NULL,
                   year INTEGER NOT NULL,
                   kind TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
                   rating REAL NOT NULL,
                   runtime_minutes INTEGER NOT NULL,
                   genres_json TEXT NOT NULL,
                   overview TEXT NOT NULL,
                   director TEXT NOT NULL,
                   cast_json TEXT NOT NULL,
                   poster_tone TEXT NOT NULL,
                   poster_accent TEXT NOT NULL,
                   progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
                   source_label TEXT NOT NULL,
                   source_status TEXT NOT NULL CHECK (source_status IN ('ready', 'unlinked')),
                   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );
                 CREATE INDEX IF NOT EXISTS idx_media_items_title ON media_items(title);
                 CREATE INDEX IF NOT EXISTS idx_media_items_kind ON media_items(kind);
                 CREATE TABLE IF NOT EXISTS media_files (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   provider TEXT NOT NULL,
                   provider_file_id TEXT,
                   path TEXT NOT NULL UNIQUE,
                   filename TEXT NOT NULL,
                   extension TEXT NOT NULL,
                   size_bytes INTEGER NOT NULL,
                   modified_at INTEGER,
                   discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );
                 CREATE TABLE IF NOT EXISTS scrape_tasks (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   media_file_id INTEGER NOT NULL UNIQUE REFERENCES media_files(id) ON DELETE CASCADE,
                   status TEXT NOT NULL CHECK (status IN ('pending', 'matched', 'attention', 'failed')),
                   error_message TEXT,
                   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );
                 CREATE TABLE IF NOT EXISTS library_tasks (
                   id TEXT PRIMARY KEY,
                   title TEXT NOT NULL,
                   detail TEXT NOT NULL,
                   status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'attention')),
                   progress REAL NOT NULL CHECK (progress >= 0 AND progress <= 1),
                   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );
                 CREATE INDEX IF NOT EXISTS idx_library_tasks_updated ON library_tasks(updated_at DESC);
                 CREATE TABLE IF NOT EXISTS upload_sessions (
                   id TEXT PRIMARY KEY,
                   local_path TEXT NOT NULL,
                   file_name TEXT NOT NULL,
                   target_id TEXT NOT NULL,
                   file_size INTEGER NOT NULL CHECK (file_size > 0),
                   file_sha1 TEXT NOT NULL,
                   pre_sha1 TEXT NOT NULL,
                   pick_code TEXT NOT NULL,
                   bucket TEXT NOT NULL,
                   object_key TEXT NOT NULL,
                   upload_id TEXT NOT NULL,
                   callback TEXT NOT NULL,
                   callback_var TEXT NOT NULL,
                   part_size INTEGER NOT NULL CHECK (part_size > 0),
                   completed_parts_json TEXT NOT NULL DEFAULT '[]',
                   status TEXT NOT NULL CHECK (status IN ('uploading', 'paused', 'failed')),
                   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );
                 CREATE INDEX IF NOT EXISTS idx_upload_sessions_updated
                   ON upload_sessions(updated_at DESC);
                 CREATE TABLE IF NOT EXISTS playback_progress (
                   provider TEXT NOT NULL,
                   file_id TEXT NOT NULL,
                   position_seconds REAL NOT NULL CHECK (position_seconds >= 0),
                   duration_seconds REAL NOT NULL CHECK (duration_seconds >= 0),
                   updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   PRIMARY KEY (provider, file_id)
                 );
                 CREATE INDEX IF NOT EXISTS idx_playback_progress_updated
                   ON playback_progress(updated_at DESC);
                 CREATE TABLE IF NOT EXISTS app_settings (
                   id INTEGER PRIMARY KEY CHECK (id = 1),
                   metadata_language TEXT NOT NULL
                     CHECK (metadata_language IN ('zh-CN', 'en-US')),
                   auto_scrape INTEGER NOT NULL CHECK (auto_scrape IN (0, 1)),
                   playback_history INTEGER NOT NULL CHECK (playback_history IN (0, 1)),
                   updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );
                 INSERT OR IGNORE INTO app_settings
                   (id,metadata_language,auto_scrape,playback_history)
                   VALUES (1,'zh-CN',1,1);
                 CREATE TABLE IF NOT EXISTS ai_provider (
                   id INTEGER PRIMARY KEY CHECK (id = 1),
                   base_url TEXT NOT NULL DEFAULT 'https://api.deepseek.com',
                   model TEXT NOT NULL DEFAULT 'deepseek-chat',
                   updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );
                 INSERT OR IGNORE INTO ai_provider (id,base_url,model)
                   VALUES (1,'https://api.deepseek.com','deepseek-chat');
                 CREATE TABLE IF NOT EXISTS comics_read_progress (
                   file_id TEXT PRIMARY KEY,
                   page_index INTEGER NOT NULL CHECK (page_index >= 0),
                   page_count INTEGER NOT NULL CHECK (page_count > 0),
                   updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );
                 CREATE TABLE IF NOT EXISTS comics_index (
                   folder_id TEXT PRIMARY KEY,
                   payload_json TEXT NOT NULL,
                   scanned_count INTEGER NOT NULL CHECK (scanned_count >= 0),
                   series_count INTEGER NOT NULL CHECK (series_count >= 0),
                   scanned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );
                 CREATE TABLE IF NOT EXISTS albums_index (
                   folder_id TEXT PRIMARY KEY,
                   payload_json TEXT NOT NULL,
                   scanned_count INTEGER NOT NULL CHECK (scanned_count >= 0),
                   photo_count INTEGER NOT NULL CHECK (photo_count >= 0),
                   scanned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );
                 CREATE TABLE IF NOT EXISTS media_info (
                   provider TEXT NOT NULL,
                   file_id TEXT NOT NULL,
                   duration_seconds REAL,
                   width INTEGER,
                   height INTEGER,
                   video_codec TEXT,
                   audio_codec TEXT,
                   updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   PRIMARY KEY (provider, file_id)
                 );
                 CREATE TABLE IF NOT EXISTS ai_chat_sessions (
                   id TEXT PRIMARY KEY,
                   title TEXT NOT NULL,
                   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );
                 CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_updated
                   ON ai_chat_sessions(updated_at DESC);
                 CREATE TABLE IF NOT EXISTS ai_chat_messages (
                   seq INTEGER PRIMARY KEY AUTOINCREMENT,
                   id TEXT NOT NULL UNIQUE,
                   session_id TEXT NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
                   role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                   content TEXT NOT NULL,
                   context_json TEXT,
                   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );
                 CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_session
                   ON ai_chat_messages(session_id, seq);
                 CREATE TABLE IF NOT EXISTS backup_pairs (
                   id TEXT PRIMARY KEY,
                   account_id INTEGER CHECK (account_id > 0),
                   local_path TEXT NOT NULL,
                   remote_folder_id TEXT NOT NULL,
                   remote_folder_name TEXT NOT NULL,
                   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   last_synced_at TEXT,
                   UNIQUE(account_id,local_path)
                 );
                 CREATE INDEX IF NOT EXISTS idx_backup_pairs_created
                   ON backup_pairs(created_at DESC);
                 CREATE TABLE IF NOT EXISTS backup_file_state (
                   pair_id TEXT NOT NULL REFERENCES backup_pairs(id) ON DELETE CASCADE,
                   relative_path TEXT NOT NULL,
                   local_size INTEGER NOT NULL,
                   local_modified_at INTEGER NOT NULL,
                   remote_file_id TEXT NOT NULL,
                   synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   PRIMARY KEY (pair_id, relative_path)
                 );",
            )
            .map_err(|error| format!("迁移 SQLite 媒体库失败：{error}"))?;

        let mut connection = connection;
        migrate_account_ownership(&mut connection)?;
        seed_library_if_empty(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// 返回全部媒体，按年份和标题稳定排序。
    pub fn list(&self) -> Result<Vec<MediaItem>, String> {
        self.query(None)
    }

    /// 在标题、原始标题和类型 JSON 中执行参数化搜索。
    pub fn search(&self, query: &str) -> Result<Vec<MediaItem>, String> {
        let normalized = query.trim();
        if normalized.is_empty() {
            return self.list();
        }
        self.query(Some(normalized))
    }

    /// 返回唯一一行应用设置；迁移阶段已保证该行存在。
    pub fn app_settings(&self) -> Result<AppSettings, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        connection
            .query_row(
                "SELECT metadata_language,auto_scrape,playback_history
                 FROM app_settings WHERE id=1",
                [],
                |row| {
                    Ok(AppSettings {
                        metadata_language: row.get(0)?,
                        auto_scrape: row.get(1)?,
                        playback_history: row.get(2)?,
                    })
                },
            )
            .map_err(|error| format!("读取应用设置失败：{error}"))
    }

    /// 原子覆盖完整设置，避免多个独立开关写入时形成部分更新状态。
    pub fn update_app_settings(&self, settings: &AppSettings) -> Result<AppSettings, String> {
        validate_app_settings(settings)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        connection
            .execute(
                "UPDATE app_settings SET metadata_language=?1,auto_scrape=?2,
                 playback_history=?3,updated_at=CURRENT_TIMESTAMP WHERE id=1",
                params![
                    settings.metadata_language,
                    settings.auto_scrape,
                    settings.playback_history
                ],
            )
            .map_err(|error| format!("保存应用设置失败：{error}"))?;
        Ok(settings.clone())
    }

    /// 返回 AI 整理服务商配置；迁移阶段已保证该行存在。
    pub fn ai_provider(&self) -> Result<AiProviderSettings, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        connection
            .query_row(
                "SELECT base_url,model FROM ai_provider WHERE id=1",
                [],
                |row| {
                    Ok(AiProviderSettings {
                        base_url: row.get(0)?,
                        model: row.get(1)?,
                    })
                },
            )
            .map_err(|error| format!("读取 AI 配置失败：{error}"))
    }

    /// 覆盖 AI 服务商地址与模型；API 密钥不经过 SQLite。
    pub fn update_ai_provider(&self, settings: &AiProviderSettings) -> Result<(), String> {
        validate_ai_provider(settings)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        connection
            .execute(
                "UPDATE ai_provider SET base_url=?1,model=?2,updated_at=CURRENT_TIMESTAMP WHERE id=1",
                params![settings.base_url, settings.model],
            )
            .map_err(|error| format!("保存 AI 配置失败：{error}"))?;
        Ok(())
    }

    /// 返回全部 AI 对话会话，按最近更新倒序。
    pub fn ai_chat_sessions(&self) -> Result<Vec<AiChatSession>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT id,title,created_at,updated_at
                 FROM ai_chat_sessions ORDER BY updated_at DESC, id DESC",
            )
            .map_err(|error| format!("读取对话会话失败：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(AiChatSession {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })
            .map_err(|error| format!("读取对话会话失败：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("读取对话会话失败：{error}"))
    }

    /// 新建 AI 对话会话；id 由调用方生成，title 缺省时使用默认标题。
    pub fn create_ai_chat_session(
        &self,
        id: &str,
        title: Option<&str>,
    ) -> Result<AiChatSession, String> {
        let id = id.trim();
        if id.is_empty() {
            return Err("会话 ID 不能为空".to_string());
        }
        let title = title
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .unwrap_or(AI_CHAT_DEFAULT_TITLE);
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        connection
            .execute(
                "INSERT INTO ai_chat_sessions (id,title) VALUES (?1,?2)",
                params![id, title],
            )
            .map_err(|error| format!("创建对话会话失败：{error}"))?;
        // 回读真实的时间戳，避免调用方拿到的元数据与数据库不一致。
        connection
            .query_row(
                "SELECT title,created_at,updated_at FROM ai_chat_sessions WHERE id=?1",
                [id],
                |row| {
                    Ok(AiChatSession {
                        id: id.to_string(),
                        title: row.get(0)?,
                        created_at: row.get(1)?,
                        updated_at: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(|error| format!("读取新建对话会话失败：{error}"))?
            .ok_or_else(|| "对话会话创建后读取失败".to_string())
    }

    /// 返回会话内全部消息（按写入顺序）；会话不存在时显式报错，避免空历史掩盖问题。
    pub fn ai_chat_messages(&self, session_id: &str) -> Result<Vec<AiChatMessageRow>, String> {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return Err("会话 ID 不能为空".to_string());
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        ai_chat_messages_with(&connection, session_id)
    }

    /// 追加一条对话消息并刷新会话 updated_at；context_json 提供时必须是合法 JSON。
    pub fn append_ai_chat_message(
        &self,
        id: &str,
        session_id: &str,
        role: &str,
        content: &str,
        context_json: Option<&str>,
    ) -> Result<(), String> {
        let id = id.trim();
        let session_id = session_id.trim();
        if id.is_empty() || session_id.is_empty() {
            return Err("对话消息 ID 或会话 ID 不能为空".to_string());
        }
        if !matches!(role, "user" | "assistant") {
            return Err("对话消息角色必须是 user 或 assistant".to_string());
        }
        if content.trim().is_empty() {
            return Err("对话消息内容不能为空".to_string());
        }
        if let Some(json) = context_json {
            serde_json::from_str::<serde_json::Value>(json)
                .map_err(|error| format!("对话上下文快照不是合法 JSON：{error}"))?;
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("开始对话消息写入事务失败：{error}"))?;
        ai_chat_ensure_session(&transaction, session_id)?;
        transaction
            .execute(
                "INSERT INTO ai_chat_messages (id,session_id,role,content,context_json)
                 VALUES (?1,?2,?3,?4,?5)",
                params![id, session_id, role, content, context_json],
            )
            .map_err(|error| format!("保存对话消息失败：{error}"))?;
        transaction
            .execute(
                "UPDATE ai_chat_sessions SET updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                params![session_id],
            )
            .map_err(|error| format!("刷新对话会话时间失败：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("提交对话消息写入事务失败：{error}"))?;
        Ok(())
    }

    /// 读取重生成目标、对应用户消息和截至该用户的历史；拒绝跨会话或非助手目标。
    /// 返回顺序为（原助手、原用户、含原用户的历史），后续轮次不会进入新请求。
    pub fn regenerate_ai_chat_context(
        &self,
        session_id: &str,
        assistant_id: &str,
    ) -> Result<(AiChatMessageRow, AiChatMessageRow, Vec<AiChatMessageRow>), String> {
        let history = self.ai_chat_messages(session_id)?;
        let target_index = history
            .iter()
            .position(|row| row.id == assistant_id && row.role == "assistant")
            .ok_or_else(|| "重新生成目标不存在或不是当前会话的助手消息".to_string())?;
        let user_index = history[..target_index]
            .iter()
            .rposition(|row| row.role == "user")
            .ok_or_else(|| "助手消息缺少对应的用户消息，无法重新生成".to_string())?;
        Ok((
            history[target_index].clone(),
            history[user_index].clone(),
            history[..=user_index].to_vec(),
        ))
    }

    /// 原位替换指定会话的助手内容；保留消息顺序、用户上下文和后续轮次。
    pub fn replace_ai_chat_assistant_content(
        &self,
        session_id: &str,
        assistant_id: &str,
        content: &str,
    ) -> Result<(), String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("开始替换助手回复失败：{error}"))?;
        let changed = transaction.execute(
            "UPDATE ai_chat_messages SET content=?3 WHERE session_id=?1 AND id=?2 AND role='assistant'",
            params![session_id, assistant_id, content],
        ).map_err(|error| format!("替换助手回复失败：{error}"))?;
        if changed != 1 {
            return Err("重新生成目标不存在或不属于当前会话".to_string());
        }
        transaction
            .execute(
                "UPDATE ai_chat_sessions SET updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                [session_id],
            )
            .map_err(|error| format!("更新对话时间失败：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("提交助手回复失败：{error}"))
    }

    /// 删除会话及其全部消息；消息经外键级联清除（open 时已开启 foreign_keys）。
    pub fn delete_ai_chat_session(&self, session_id: &str) -> Result<(), String> {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return Err("会话 ID 不能为空".to_string());
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        connection
            .execute("DELETE FROM ai_chat_sessions WHERE id=?1", [session_id])
            .map_err(|error| format!("删除对话会话失败：{error}"))?;
        Ok(())
    }

    /// 返回漫画卷的本地阅读进度；进度只存本机 SQLite，不写回 115。
    pub fn comics_progress(&self, file_id: &str) -> Result<Option<(i64, i64)>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        connection
            .query_row(
                "SELECT page_index,page_count FROM comics_read_progress WHERE file_id=?1",
                params![file_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("读取漫画阅读进度失败：{error}"))
    }

    /// 保存漫画阅读进度；翻页与关闭时幂等覆盖。
    pub fn save_comics_progress(
        &self,
        file_id: &str,
        page_index: i64,
        page_count: i64,
    ) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        connection
            .execute(
                "INSERT INTO comics_read_progress (file_id,page_index,page_count,updated_at)
                 VALUES (?1,?2,?3,CURRENT_TIMESTAMP)
                 ON CONFLICT(file_id) DO UPDATE
                 SET page_index=?2,page_count=?3,updated_at=CURRENT_TIMESTAMP",
                params![file_id, page_index, page_count],
            )
            .map_err(|error| format!("保存漫画阅读进度失败：{error}"))?;
        Ok(())
    }

    /// 保存或覆盖目录漫画索引，并把索引总量限制在最近 50 个目录。
    pub fn save_comics_index(
        &self,
        folder_id: &str,
        payload_json: &str,
        scanned_count: i64,
        series_count: i64,
    ) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        connection
            .execute(
                "INSERT INTO comics_index (folder_id,payload_json,scanned_count,series_count,scanned_at)
                 VALUES (?1,?2,?3,?4,CURRENT_TIMESTAMP)
                 ON CONFLICT(folder_id) DO UPDATE
                 SET payload_json=?2,scanned_count=?3,series_count=?4,scanned_at=CURRENT_TIMESTAMP",
                params![folder_id, payload_json, scanned_count, series_count],
            )
            .map_err(|error| format!("保存漫画索引失败：{error}"))?;
        // 上限裁剪：只保留最近扫描的 50 个目录，避免索引无界增长。
        connection
            .execute(
                "DELETE FROM comics_index WHERE folder_id NOT IN (
                   SELECT folder_id FROM comics_index ORDER BY scanned_at DESC, folder_id LIMIT 50
                 )",
                [],
            )
            .map_err(|error| format!("裁剪漫画索引失败：{error}"))?;
        Ok(())
    }

    /// 返回全部目录漫画索引，按扫描时间倒序。
    pub fn list_comics_indexes(&self) -> Result<Vec<ComicsIndexRow>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT folder_id,payload_json,scanned_at
                 FROM comics_index ORDER BY scanned_at DESC, folder_id",
            )
            .map_err(|error| format!("读取漫画索引失败：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(ComicsIndexRow {
                    folder_id: row.get(0)?,
                    payload_json: row.get(1)?,
                    scanned_at: row.get(2)?,
                })
            })
            .map_err(|error| format!("读取漫画索引失败：{error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("读取漫画索引失败：{error}"))?;
        Ok(rows)
    }

    /// 保存或覆盖目录相册索引，并把索引总量限制在最近 50 个目录。
    pub fn save_albums_index(
        &self,
        folder_id: &str,
        payload_json: &str,
        scanned_count: i64,
        photo_count: i64,
    ) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        connection
            .execute(
                "INSERT INTO albums_index (folder_id,payload_json,scanned_count,photo_count,scanned_at)
                 VALUES (?1,?2,?3,?4,CURRENT_TIMESTAMP)
                 ON CONFLICT(folder_id) DO UPDATE
                 SET payload_json=?2,scanned_count=?3,photo_count=?4,scanned_at=CURRENT_TIMESTAMP",
                params![folder_id, payload_json, scanned_count, photo_count],
            )
            .map_err(|error| format!("保存相册索引失败：{error}"))?;
        // 上限裁剪：只保留最近扫描的 50 个目录，避免索引无界增长。
        connection
            .execute(
                "DELETE FROM albums_index WHERE folder_id NOT IN (
                   SELECT folder_id FROM albums_index ORDER BY scanned_at DESC, folder_id LIMIT 50
                 )",
                [],
            )
            .map_err(|error| format!("裁剪相册索引失败：{error}"))?;
        Ok(())
    }

    /// 返回全部目录相册索引，按扫描时间倒序。
    pub fn list_albums_indexes(&self) -> Result<Vec<AlbumsIndexRow>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT folder_id,payload_json,scanned_at
                 FROM albums_index ORDER BY scanned_at DESC, folder_id",
            )
            .map_err(|error| format!("读取相册索引失败：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(AlbumsIndexRow {
                    folder_id: row.get(0)?,
                    payload_json: row.get(1)?,
                    scanned_at: row.get(2)?,
                })
            })
            .map_err(|error| format!("读取相册索引失败：{error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("读取相册索引失败：{error}"))?;
        Ok(rows)
    }

    /// 从本机索引移除一个目录；远程目录与照片不受影响。
    pub fn delete_albums_index(&self, folder_id: &str) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        connection
            .execute(
                "DELETE FROM albums_index WHERE folder_id=?1",
                params![folder_id],
            )
            .map_err(|error| format!("移除相册索引失败：{error}"))?;
        Ok(())
    }

    /// 读取已刮削的媒体信息；未刮削过返回 None。
    pub fn media_info(&self, provider: &str, file_id: &str) -> Result<Option<MediaInfo>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        connection
            .query_row(
                "SELECT duration_seconds,width,height,video_codec,audio_codec
                 FROM media_info WHERE provider=?1 AND file_id=?2",
                params![provider, file_id],
                |row| {
                    Ok(MediaInfo {
                        provider: provider.to_string(),
                        file_id: file_id.to_string(),
                        duration_seconds: row.get(0)?,
                        width: row.get(1)?,
                        height: row.get(2)?,
                        video_codec: row.get(3)?,
                        audio_codec: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(|error| format!("读取媒体信息失败：{error}"))
    }

    /// 覆盖保存媒体信息；同一来源同一文件只保留最新一次刮削结果。
    pub fn save_media_info(&self, info: &MediaInfo) -> Result<(), String> {
        if info.provider.trim().is_empty() || info.file_id.trim().is_empty() {
            return Err("媒体信息的来源或文件标识不能为空".to_string());
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        connection
            .execute(
                "INSERT INTO media_info (provider,file_id,duration_seconds,width,height,video_codec,audio_codec,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,CURRENT_TIMESTAMP)
                 ON CONFLICT(provider,file_id) DO UPDATE
                 SET duration_seconds=?3,width=?4,height=?5,video_codec=?6,audio_codec=?7,updated_at=CURRENT_TIMESTAMP",
                params![
                    info.provider,
                    info.file_id,
                    info.duration_seconds,
                    info.width,
                    info.height,
                    info.video_codec,
                    info.audio_codec
                ],
            )
            .map_err(|error| format!("保存媒体信息失败：{error}"))?;
        Ok(())
    }

    /// 返回最近的扫描和整理任务。
    pub fn tasks(&self) -> Result<Vec<LibraryTask>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT id,title,detail,status,progress FROM library_tasks
                 ORDER BY updated_at DESC,id DESC LIMIT 100",
            )
            .map_err(|error| format!("准备任务查询失败：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(LibraryTask {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    detail: row.get(2)?,
                    status: row.get(3)?,
                    progress: row.get(4)?,
                })
            })
            .map_err(|error| format!("执行任务查询失败：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("读取任务查询结果失败：{error}"))
    }

    /// 读取指定 115 文件上次保存的播放位置。
    pub fn playback_progress(&self, file_id: &str) -> Result<Option<PlaybackProgress>, String> {
        let normalized = file_id.trim();
        if normalized.is_empty() {
            return Err("播放进度文件 ID 不能为空".to_string());
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        connection
            .query_row(
                "SELECT file_id,position_seconds,duration_seconds
                 FROM playback_progress WHERE provider='cloud115' AND file_id=?1",
                [normalized],
                |row| {
                    Ok(PlaybackProgress {
                        file_id: row.get(0)?,
                        position_seconds: row.get(1)?,
                        duration_seconds: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(|error| format!("读取播放进度失败：{error}"))
    }

    /// 使用 UPSERT 保存 115 视频进度；非法浮点值必须显式拒绝。
    pub fn save_playback_progress(
        &self,
        file_id: &str,
        position_seconds: f64,
        duration_seconds: f64,
    ) -> Result<(), String> {
        let normalized = file_id.trim();
        if normalized.is_empty() {
            return Err("播放进度文件 ID 不能为空".to_string());
        }
        if !position_seconds.is_finite()
            || !duration_seconds.is_finite()
            || position_seconds < 0.0
            || duration_seconds < 0.0
        {
            return Err("播放进度必须是非负有限数值".to_string());
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        connection
            .execute(
                "INSERT INTO playback_progress(provider,file_id,position_seconds,duration_seconds)
                 VALUES ('cloud115',?1,?2,?3)
                 ON CONFLICT(provider,file_id) DO UPDATE SET
                   position_seconds=excluded.position_seconds,
                   duration_seconds=excluded.duration_seconds,
                   updated_at=CURRENT_TIMESTAMP",
                params![normalized, position_seconds, duration_seconds],
            )
            .map_err(|error| format!("保存播放进度失败：{error}"))?;
        Ok(())
    }

    /// 原子保存 multipart 会话；同一 ID 的分片进度使用 UPSERT 覆盖。
    pub fn save_upload_session(&self, session: &UploadSession) -> Result<(), String> {
        validate_upload_session(session)?;
        let completed_parts_json = serde_json::to_string(&session.completed_parts)
            .map_err(|error| format!("序列化上传分片状态失败：{error}"))?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        let changed = connection
            .execute(
                "INSERT INTO upload_sessions
                 (id,local_path,file_name,target_id,file_size,file_sha1,pre_sha1,pick_code,
                  bucket,object_key,upload_id,callback,callback_var,part_size,
                  completed_parts_json,status,account_id)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
                 ON CONFLICT(id) DO UPDATE SET
                   local_path=excluded.local_path,file_name=excluded.file_name,
                   target_id=excluded.target_id,file_size=excluded.file_size,
                   file_sha1=excluded.file_sha1,pre_sha1=excluded.pre_sha1,
                   pick_code=excluded.pick_code,bucket=excluded.bucket,
                   object_key=excluded.object_key,upload_id=excluded.upload_id,
                   callback=excluded.callback,callback_var=excluded.callback_var,
                   part_size=excluded.part_size,
                   completed_parts_json=excluded.completed_parts_json,
                   status=excluded.status,updated_at=CURRENT_TIMESTAMP
                 WHERE upload_sessions.account_id=excluded.account_id",
                params![
                    session.id,
                    session.local_path,
                    session.file_name,
                    session.target_id,
                    i64::try_from(session.file_size)
                        .map_err(|_| "上传文件大小超出 SQLite 整数范围".to_string())?,
                    session.file_sha1,
                    session.pre_sha1,
                    session.pick_code,
                    session.bucket,
                    session.object_key,
                    session.upload_id,
                    session.callback,
                    session.callback_var,
                    i64::try_from(session.part_size)
                        .map_err(|_| "上传分片大小超出 SQLite 整数范围".to_string())?,
                    completed_parts_json,
                    session.status,
                    account_key(session.account_id)?,
                ],
            )
            .map_err(|error| format!("保存上传会话失败：{error}"))?;
        if changed == 0 {
            return Err("上传会话不属于当前 115 账号，拒绝覆盖".to_string());
        }
        Ok(())
    }

    /// 返回指定 115 账号的未完成上传会话；未知归属的历史记录不对任何账号开放。
    pub fn upload_sessions(&self, account_id: u64) -> Result<Vec<UploadSession>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT id,local_path,file_name,target_id,file_size,file_sha1,pre_sha1,
                        pick_code,bucket,object_key,upload_id,callback,callback_var,part_size,
                        completed_parts_json,status,account_id
                 FROM upload_sessions WHERE account_id=?1 ORDER BY updated_at DESC,id DESC",
            )
            .map_err(|error| format!("准备上传会话查询失败：{error}"))?;
        let rows = statement
            .query_map([account_key(account_id)?], upload_session_from_row)
            .map_err(|error| format!("执行上传会话查询失败：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("读取上传会话失败：{error}"))?
            .into_iter()
            .map(|stored| stored.into_upload_session())
            .collect()
    }

    /// 上传完成或用户明确取消后删除对应会话，不影响其它任务记录。
    pub fn delete_upload_session(&self, account_id: u64, id: &str) -> Result<(), String> {
        if id.trim().is_empty() {
            return Err("上传会话 ID 不能为空".to_string());
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        let changed = connection
            .execute(
                "DELETE FROM upload_sessions WHERE id=?1 AND account_id=?2",
                params![id, account_key(account_id)?],
            )
            .map_err(|error| format!("删除上传会话失败：{error}"))?;
        if changed == 0 {
            return Err("上传会话不存在或不属于当前 115 账号".to_string());
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // 备份：本地目录 → 115 目录的单向同步状态。
    // -----------------------------------------------------------------------

    /// 新增一条备份配对；本地路径唯一，重复添加会被 SQLite 拒绝。
    pub fn add_backup_pair(
        &self,
        account_id: u64,
        local_path: &str,
        remote_folder_id: &str,
        remote_folder_name: &str,
    ) -> Result<BackupPair, String> {
        if local_path.trim().is_empty()
            || remote_folder_id.trim().is_empty()
            || remote_folder_name.trim().is_empty()
        {
            return Err("备份的本地路径与云端目录都不能为空".to_string());
        }
        let account_id = account_key(account_id)?;
        let id = format!("backup-{account_id}-{}", unix_timestamp_millis()?);
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        connection
            .execute(
                "INSERT INTO backup_pairs (id,local_path,remote_folder_id,remote_folder_name,account_id)
                 VALUES (?1,?2,?3,?4,?5)",
                rusqlite::params![
                    id,
                    local_path.trim(),
                    remote_folder_id.trim(),
                    remote_folder_name.trim(),
                    account_id
                ],
            )
            .map_err(|error| {
                if error.to_string().contains("UNIQUE") {
                    format!("该本地目录已在备份列表中：{}", local_path.trim())
                } else {
                    format!("保存备份配对失败：{error}")
                }
            })?;
        Ok(BackupPair {
            id,
            local_path: local_path.trim().to_string(),
            remote_folder_id: remote_folder_id.trim().to_string(),
            remote_folder_name: remote_folder_name.trim().to_string(),
            last_synced_at: None,
            synced_files: 0,
            pending_files: 0,
        })
    }

    /// 返回全部备份配对，并附带已同步/待同步文件数（按本地状态表统计）。
    pub fn backup_pairs(&self, account_id: u64) -> Result<Vec<BackupPair>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT p.id,p.local_path,p.remote_folder_id,p.remote_folder_name,p.last_synced_at,
                        (SELECT COUNT(*) FROM backup_file_state s WHERE s.pair_id = p.id)
                 FROM backup_pairs p WHERE p.account_id=?1 ORDER BY p.created_at DESC, p.id DESC",
            )
            .map_err(|error| format!("准备备份列表查询失败：{error}"))?;
        let rows = statement
            .query_map([account_key(account_id)?], |row| {
                Ok(BackupPair {
                    id: row.get(0)?,
                    local_path: row.get(1)?,
                    remote_folder_id: row.get(2)?,
                    remote_folder_name: row.get(3)?,
                    last_synced_at: row.get(4)?,
                    synced_files: row.get::<_, i64>(5)? as u64,
                    // 待同步数量依赖实时扫描本地目录，列表接口不猜测；由扫描命令单独返回。
                    pending_files: 0,
                })
            })
            .map_err(|error| format!("执行备份列表查询失败：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("读取备份列表失败：{error}"))
    }

    /// 删除一条备份配对；已同步记录随外键级联清理，不影响云端文件。
    pub fn delete_backup_pair(&self, account_id: u64, id: &str) -> Result<(), String> {
        if id.trim().is_empty() {
            return Err("备份配对 ID 不能为空".to_string());
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        let affected = connection
            .execute(
                "DELETE FROM backup_pairs WHERE id=?1 AND account_id=?2",
                params![id, account_key(account_id)?],
            )
            .map_err(|error| format!("删除备份配对失败：{error}"))?;
        if affected == 0 {
            return Err("备份配对不存在或不属于当前 115 账号".to_string());
        }
        Ok(())
    }

    /// 返回某个配对已同步文件的相对路径 → 本地指纹映射，供扫描时判断是否需要上传。
    pub fn backup_file_states(
        &self,
        account_id: u64,
        pair_id: &str,
    ) -> Result<HashMap<String, BackupFileState>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        ensure_backup_owner(&connection, account_id, pair_id)?;
        let mut statement = connection
            .prepare(
                "SELECT relative_path,local_size,local_modified_at,remote_file_id
                 FROM backup_file_state WHERE pair_id=?1",
            )
            .map_err(|error| format!("准备备份状态查询失败：{error}"))?;
        let rows = statement
            .query_map([pair_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    BackupFileState {
                        local_size: row.get::<_, i64>(1)? as u64,
                        local_modified_at: row.get::<_, i64>(2)? as u64,
                        remote_file_id: row.get(3)?,
                    },
                ))
            })
            .map_err(|error| format!("执行备份状态查询失败：{error}"))?;
        rows.collect::<Result<HashMap<_, _>, _>>()
            .map_err(|error| format!("读取备份状态失败：{error}"))
    }

    /// 记录单个文件已同步；同一相对路径重复同步时覆盖指纹。
    pub fn record_backup_file(
        &self,
        account_id: u64,
        pair_id: &str,
        relative_path: &str,
        local_size: u64,
        local_modified_at: u64,
        remote_file_id: &str,
    ) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        ensure_backup_owner(&connection, account_id, pair_id)?;
        connection
            .execute(
                "INSERT INTO backup_file_state
                   (pair_id,relative_path,local_size,local_modified_at,remote_file_id)
                 VALUES (?1,?2,?3,?4,?5)
                 ON CONFLICT(pair_id,relative_path) DO UPDATE SET
                   local_size=excluded.local_size,
                   local_modified_at=excluded.local_modified_at,
                   remote_file_id=excluded.remote_file_id,
                   synced_at=CURRENT_TIMESTAMP",
                rusqlite::params![
                    pair_id,
                    relative_path,
                    i64::try_from(local_size).map_err(|_| "备份文件大小超出支持范围".to_string())?,
                    i64::try_from(local_modified_at)
                        .map_err(|_| "备份修改时间超出支持范围".to_string())?,
                    remote_file_id
                ],
            )
            .map_err(|error| format!("记录备份文件状态失败：{error}"))?;
        Ok(())
    }

    /// 更新配对的最近同步时间。
    pub fn touch_backup_pair(&self, account_id: u64, pair_id: &str) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        ensure_backup_owner(&connection, account_id, pair_id)?;
        connection
            .execute(
                "UPDATE backup_pairs SET last_synced_at=CURRENT_TIMESTAMP WHERE id=?1",
                [pair_id],
            )
            .map_err(|error| format!("更新备份同步时间失败：{error}"))?;
        Ok(())
    }

    /// 取单条备份配对；不存在时返回可读错误。
    pub fn backup_pair(&self, account_id: u64, pair_id: &str) -> Result<BackupPair, String> {
        self.backup_pairs(account_id)?
            .into_iter()
            .find(|pair| pair.id == pair_id)
            .ok_or_else(|| "备份配对不存在或不属于当前 115 账号".to_string())
    }

    /// 扫描本地目录，对比上次同步指纹，得出需要上传的相对路径。
    ///
    /// 只比较「大小 + 修改时间」，不重新计算 SHA1：扫描阶段对整棵目录做摘要
    /// 会让大目录的预览等待过久，真正的秒传判定由上传链路自己完成。
    pub fn scan_backup_pair(
        &self,
        account_id: u64,
        pair_id: &str,
    ) -> Result<BackupScanResult, String> {
        let pair = self.backup_pair(account_id, pair_id)?;
        let root = validate_scan_directory(&pair.local_path)?;
        let known = self.backup_file_states(account_id, pair_id)?;

        let mut pending_paths = Vec::new();
        let mut total_files = 0_u64;
        let mut unchanged_files = 0_u64;
        for (path, size, modified_at) in collect_backup_files(&root)? {
            total_files += 1;
            let relative = path
                .strip_prefix(&root)
                .map_err(|error| format!("计算备份相对路径失败：{error}"))?
                .to_string_lossy()
                .replace('\\', "/");
            let changed = known.get(&relative).is_none_or(|state| {
                state.local_size != size || state.local_modified_at != modified_at
            });
            if changed {
                pending_paths.push(relative);
            } else {
                unchanged_files += 1;
            }
        }
        pending_paths.sort();
        Ok(BackupScanResult {
            pair_id: pair_id.to_string(),
            total_files,
            pending_files: pending_paths.len() as u64,
            unchanged_files,
            pending_paths,
        })
    }

    /// 递归扫描一个本地目录，将视频文件和待刮削任务原子写入 SQLite。
    pub fn scan_local_directory(&self, path: &str) -> Result<LibraryTask, String> {
        let directory = validate_scan_directory(path)?;
        let task_id = new_task_id()?;
        let title = directory
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("本地媒体目录")
            .to_string();
        self.insert_task(&task_id, &title, "正在扫描视频文件", "running", 0.0)?;

        let files = match collect_video_files(&directory) {
            Ok(files) => files,
            Err(error) => {
                self.update_task(&task_id, &error, "attention", 1.0)?;
                return Err(error);
            }
        };
        let result = self.persist_scanned_files(&task_id, &title, &files);
        if let Err(error) = &result {
            self.update_task(&task_id, error, "attention", 1.0)?;
        }
        result
    }

    fn persist_scanned_files(
        &self,
        task_id: &str,
        title: &str,
        files: &[ScannedFile],
    ) -> Result<LibraryTask, String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("开始扫描写入事务失败：{error}"))?;
        let auto_scrape: bool = transaction
            .query_row(
                "SELECT auto_scrape FROM app_settings WHERE id=1",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("读取自动刮削设置失败：{error}"))?;
        let mut pending_count = 0usize;
        for file in files {
            transaction
                .execute(
                    "INSERT INTO media_files
                     (provider,path,filename,extension,size_bytes,modified_at)
                     VALUES ('local',?1,?2,?3,?4,?5)
                     ON CONFLICT(path) DO UPDATE SET
                       filename=excluded.filename,extension=excluded.extension,
                       size_bytes=excluded.size_bytes,modified_at=excluded.modified_at",
                    params![
                        file.path,
                        file.filename,
                        file.extension,
                        file.size_bytes,
                        file.modified_at
                    ],
                )
                .map_err(|error| format!("写入媒体文件失败：{error}"))?;
            let file_id: i64 = transaction
                .query_row(
                    "SELECT id FROM media_files WHERE path=?1",
                    [&file.path],
                    |row| row.get(0),
                )
                .map_err(|error| format!("读取媒体文件 ID 失败：{error}"))?;
            if auto_scrape {
                pending_count += transaction
                    .execute(
                        "INSERT OR IGNORE INTO scrape_tasks(media_file_id,status)
                         VALUES (?1,'pending')",
                        [file_id],
                    )
                    .map_err(|error| format!("创建待刮削任务失败：{error}"))?;
            }
        }
        let detail = if auto_scrape {
            format!(
                "发现 {} 个视频，新增 {} 个待刮削任务",
                files.len(),
                pending_count
            )
        } else {
            format!("发现 {} 个视频，自动刮削已关闭", files.len())
        };
        transaction
            .execute(
                "UPDATE library_tasks SET detail=?2,status='completed',progress=1,
                 updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                params![task_id, detail],
            )
            .map_err(|error| format!("更新扫描任务失败：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("提交扫描写入事务失败：{error}"))?;
        Ok(LibraryTask {
            id: task_id.to_string(),
            title: title.to_string(),
            detail,
            status: "completed".to_string(),
            progress: 1.0,
        })
    }

    fn insert_task(
        &self,
        id: &str,
        title: &str,
        detail: &str,
        status: &str,
        progress: f64,
    ) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        connection
            .execute(
                "INSERT INTO library_tasks(id,title,detail,status,progress) VALUES (?1,?2,?3,?4,?5)",
                params![id, title, detail, status, progress],
            )
            .map_err(|error| format!("创建扫描任务失败：{error}"))?;
        Ok(())
    }

    fn update_task(
        &self,
        id: &str,
        detail: &str,
        status: &str,
        progress: f64,
    ) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        connection
            .execute(
                "UPDATE library_tasks SET detail=?2,status=?3,progress=?4,
                 updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                params![id, detail, status, progress],
            )
            .map_err(|error| format!("更新扫描任务失败：{error}"))?;
        Ok(())
    }

    fn query(&self, query: Option<&str>) -> Result<Vec<MediaItem>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        let sql = if query.is_some() {
            "SELECT id,title,original_title,year,kind,rating,runtime_minutes,genres_json,
                    overview,director,cast_json,poster_tone,poster_accent,progress,
                    source_label,source_status
             FROM media_items
             WHERE title LIKE ?1 OR original_title LIKE ?1 OR genres_json LIKE ?1
             ORDER BY year DESC,title COLLATE NOCASE"
        } else {
            "SELECT id,title,original_title,year,kind,rating,runtime_minutes,genres_json,
                    overview,director,cast_json,poster_tone,poster_accent,progress,
                    source_label,source_status
             FROM media_items ORDER BY year DESC,title COLLATE NOCASE"
        };
        let mut statement = connection
            .prepare(sql)
            .map_err(|error| format!("准备媒体库查询失败：{error}"))?;
        let pattern = query.map(|value| format!("%{value}%"));
        let mut rows = if let Some(pattern) = pattern.as_deref() {
            statement.query([pattern])
        } else {
            statement.query([])
        }
        .map_err(|error| format!("执行媒体库查询失败：{error}"))?;
        let mut items = Vec::new();
        while let Some(row) = rows
            .next()
            .map_err(|error| format!("读取媒体库查询结果失败：{error}"))?
        {
            items.push(media_from_row(row)?);
        }
        Ok(items)
    }
}

/// 给旧版远端任务增加账号归属；无法证明归属的旧记录保留为 NULL，禁止自动认领。
/// 迁移幂等执行，重建备份表以把本地路径唯一约束收窄到同一账号。
fn migrate_account_ownership(connection: &mut Connection) -> Result<(), String> {
    let has_column = |table: &str| -> Result<bool, String> {
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name='account_id')",
                [table],
                |row| row.get(0),
            )
            .map_err(|error| format!("检查账号归属迁移失败：{error}"))
    };
    let migrate_backups = !has_column("backup_pairs")?;
    let migrate_uploads = !has_column("upload_sessions")?;
    if !migrate_backups && !migrate_uploads {
        return Ok(());
    }
    // 暂停外键仅为了原子替换父表；子表与全部历史数据均保留，提交后恢复校验。
    connection
        .execute_batch("PRAGMA foreign_keys = OFF;")
        .map_err(|error| format!("准备账号归属迁移失败：{error}"))?;
    let migrated = (|| -> Result<(), String> {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("开始账号归属迁移失败：{error}"))?;
        if migrate_backups {
            transaction.execute_batch(
                "CREATE TABLE backup_pairs_scoped (
                   id TEXT PRIMARY KEY,
                   account_id INTEGER CHECK (account_id > 0),
                   local_path TEXT NOT NULL,
                   remote_folder_id TEXT NOT NULL,
                   remote_folder_name TEXT NOT NULL,
                   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   last_synced_at TEXT,
                   UNIQUE(account_id,local_path)
                 );
                 INSERT INTO backup_pairs_scoped
                   (id,local_path,remote_folder_id,remote_folder_name,created_at,last_synced_at)
                   SELECT id,local_path,remote_folder_id,remote_folder_name,created_at,last_synced_at
                   FROM backup_pairs;
                 DROP TABLE backup_pairs;
                 ALTER TABLE backup_pairs_scoped RENAME TO backup_pairs;
                 CREATE INDEX idx_backup_pairs_created ON backup_pairs(created_at DESC);"
            ).map_err(|error| format!("迁移备份账号归属失败：{error}"))?;
        }
        if migrate_uploads {
            transaction
                .execute_batch("ALTER TABLE upload_sessions ADD COLUMN account_id INTEGER CHECK (account_id > 0);")
                .map_err(|error| format!("迁移上传账号归属失败：{error}"))?;
        }
        transaction
            .execute(
                "INSERT OR IGNORE INTO schema_migrations(version) VALUES (1)",
                [],
            )
            .map_err(|error| format!("记录账号归属迁移失败：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("提交账号归属迁移失败：{error}"))
    })();
    let restored = connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|error| format!("恢复 SQLite 外键校验失败：{error}"));
    match (migrated, restored) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(first), Err(second)) => Err(format!("{first}；{second}")),
    }
}

/// 将有效 115 用户 ID 转为 SQLite 整数；拒绝未登录或超出范围的账号。
fn account_key(account_id: u64) -> Result<i64, String> {
    if account_id == 0 {
        return Err("缺少有效的 115 账号归属".to_string());
    }
    i64::try_from(account_id).map_err(|_| "115 账号 ID 超出支持范围".to_string())
}

/// 在持有数据库锁时校验配对归属，防止凭前端传入 ID 操作其他账号记录。
fn ensure_backup_owner(
    connection: &Connection,
    account_id: u64,
    pair_id: &str,
) -> Result<(), String> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM backup_pairs WHERE id=?1 AND account_id=?2)",
            params![pair_id, account_key(account_id)?],
            |row| row.get(0),
        )
        .map_err(|error| format!("校验备份账号归属失败：{error}"))?;
    if !exists {
        return Err("备份配对不存在或不属于当前 115 账号".to_string());
    }
    Ok(())
}

struct StoredUploadSession {
    account_id: i64,
    id: String,
    local_path: String,
    file_name: String,
    target_id: String,
    file_size: i64,
    file_sha1: String,
    pre_sha1: String,
    pick_code: String,
    bucket: String,
    object_key: String,
    upload_id: String,
    callback: String,
    callback_var: String,
    part_size: i64,
    completed_parts_json: String,
    status: String,
}

fn upload_session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredUploadSession> {
    Ok(StoredUploadSession {
        account_id: row.get(16)?,
        id: row.get(0)?,
        local_path: row.get(1)?,
        file_name: row.get(2)?,
        target_id: row.get(3)?,
        file_size: row.get(4)?,
        file_sha1: row.get(5)?,
        pre_sha1: row.get(6)?,
        pick_code: row.get(7)?,
        bucket: row.get(8)?,
        object_key: row.get(9)?,
        upload_id: row.get(10)?,
        callback: row.get(11)?,
        callback_var: row.get(12)?,
        part_size: row.get(13)?,
        completed_parts_json: row.get(14)?,
        status: row.get(15)?,
    })
}

impl StoredUploadSession {
    fn into_upload_session(self) -> Result<UploadSession, String> {
        Ok(UploadSession {
            account_id: u64::try_from(self.account_id)
                .map_err(|_| "上传会话账号归属无效".to_string())?,
            id: self.id,
            local_path: self.local_path,
            file_name: self.file_name,
            target_id: self.target_id,
            file_size: u64::try_from(self.file_size)
                .map_err(|_| "上传会话 file_size 无效".to_string())?,
            file_sha1: self.file_sha1,
            pre_sha1: self.pre_sha1,
            pick_code: self.pick_code,
            bucket: self.bucket,
            object_key: self.object_key,
            upload_id: self.upload_id,
            callback: self.callback,
            callback_var: self.callback_var,
            part_size: u64::try_from(self.part_size)
                .map_err(|_| "上传会话 part_size 无效".to_string())?,
            completed_parts: serde_json::from_str(&self.completed_parts_json)
                .map_err(|error| format!("解析上传分片状态失败：{error}"))?,
            status: self.status,
        })
    }
}

fn validate_upload_session(session: &UploadSession) -> Result<(), String> {
    account_key(session.account_id)?;
    if session.id.trim().is_empty()
        || session.file_name.trim().is_empty()
        || session.target_id.trim().is_empty()
        || session.file_size == 0
        || session.part_size == 0
        || session.file_sha1.len() != 40
        || session.pre_sha1.len() != 40
        || session.bucket.trim().is_empty()
        || session.object_key.trim().is_empty()
        || session.upload_id.trim().is_empty()
        || session.callback.trim().is_empty()
    {
        return Err("上传会话包含缺失或无效字段".to_string());
    }
    if !Path::new(&session.local_path).is_absolute() {
        return Err("上传会话本地路径必须是绝对路径".to_string());
    }
    if !matches!(session.status.as_str(), "uploading" | "paused" | "failed") {
        return Err("上传会话状态无效".to_string());
    }
    let mut previous = 0u32;
    for part in &session.completed_parts {
        if part.number == 0 || part.number <= previous || part.etag.trim().is_empty() {
            return Err("上传会话分片必须按编号递增且包含 ETag".to_string());
        }
        previous = part.number;
    }
    Ok(())
}

struct ScannedFile {
    path: String,
    filename: String,
    extension: String,
    size_bytes: i64,
    modified_at: Option<i64>,
}

fn validate_scan_directory(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("未选择扫描目录".to_string());
    }
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        return Err("扫描目录必须是绝对路径".to_string());
    }
    if !candidate.is_dir() {
        return Err(format!("扫描路径不是目录：{}", candidate.display()));
    }
    candidate
        .canonicalize()
        .map_err(|error| format!("解析扫描目录失败：{error}"))
}

/// 递归收集备份目录下的全部普通文件，返回 (绝对路径, 字节数, 修改时间纳秒)。
///
/// 与媒体扫描共用同一套遍历约束：显式栈、跳过符号链接、跳过非普通文件。
/// 修改时间统一为纳秒级时间戳，避免同秒修改且大小不变的文件被跳过。
fn collect_backup_files(root: &Path) -> Result<Vec<(PathBuf, u64, u64)>, String> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        let entries = std::fs::read_dir(&directory)
            .map_err(|error| format!("读取备份目录 {} 失败：{error}", directory.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                format!("读取备份目录 {} 中的条目失败：{error}", directory.display())
            })?;
            let metadata = std::fs::symlink_metadata(entry.path()).map_err(|error| {
                format!("读取备份文件 {} 信息失败：{error}", entry.path().display())
            })?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                pending.push(entry.path());
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            let fingerprint = BackupFingerprint::read(&entry.path())?;
            files.push((
                entry.path(),
                fingerprint.size_bytes,
                fingerprint.modified_at,
            ));
        }
    }
    Ok(files)
}

/// 使用显式栈遍历目录，跳过符号链接以避免循环。
fn collect_video_files(root: &Path) -> Result<Vec<ScannedFile>, String> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        let entries = std::fs::read_dir(&directory)
            .map_err(|error| format!("读取目录 {} 失败：{error}", directory.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                format!("读取目录 {} 中的条目失败：{error}", directory.display())
            })?;
            let metadata = std::fs::symlink_metadata(entry.path()).map_err(|error| {
                format!("读取文件 {} 信息失败：{error}", entry.path().display())
            })?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                pending.push(entry.path());
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            let path = entry.path();
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase);
            let Some(extension) = extension else {
                continue;
            };
            if !VIDEO_EXTENSIONS.contains(&extension.as_str()) {
                continue;
            }
            let filename = path
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| format!("视频文件名不是有效 UTF-8：{}", path.display()))?;
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs() as i64);
            files.push(ScannedFile {
                path: path.to_string_lossy().into_owned(),
                filename: filename.to_string(),
                extension,
                size_bytes: metadata.len() as i64,
                modified_at,
            });
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn new_task_id() -> Result<String, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("系统时间异常，无法创建任务：{error}"))?;
    Ok(format!("scan-{}", timestamp.as_nanos()))
}

/// 毫秒时间戳；备份配对 ID 需要单调且可读，毫秒精度足够区分用户操作。
fn unix_timestamp_millis() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .map_err(|error| format!("系统时间异常，无法创建备份记录：{error}"))
}

const VIDEO_EXTENSIONS: &[&str] = &["mkv", "mp4", "mov", "avi", "webm", "m4v", "ts"];

/// 设置值来自 WebView IPC，必须在写入数据库前执行白名单校验。
fn validate_app_settings(settings: &AppSettings) -> Result<(), String> {
    if !matches!(settings.metadata_language.as_str(), "zh-CN" | "en-US") {
        return Err("元数据语言必须是 zh-CN 或 en-US".to_string());
    }
    Ok(())
}

/// AI 服务商配置同样来自 WebView IPC，写入前必须校验。
fn validate_ai_provider(settings: &AiProviderSettings) -> Result<(), String> {
    let base_url = settings.base_url.trim();
    if !(base_url.starts_with("https://") || base_url.starts_with("http://")) {
        return Err("AI 服务商地址必须以 http(s):// 开头".to_string());
    }
    if settings.model.trim().is_empty() {
        return Err("AI 模型名称不能为空".to_string());
    }
    Ok(())
}

/// 校验会话存在；供消息写入与历史读取共用，未找到时报错而非返回空列表。
fn ai_chat_ensure_session(connection: &Connection, session_id: &str) -> Result<(), String> {
    let exists: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM ai_chat_sessions WHERE id=?1",
            [session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("查询对话会话失败：{error}"))?;
    if exists.is_none() {
        return Err("未找到指定对话会话".to_string());
    }
    Ok(())
}

/// 读取一个会话的全部消息，按写入顺序返回。
fn ai_chat_messages_with(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<AiChatMessageRow>, String> {
    ai_chat_ensure_session(connection, session_id)?;
    let mut statement = connection
        .prepare(
            "SELECT id,session_id,role,content,context_json,created_at
             FROM ai_chat_messages WHERE session_id=?1 ORDER BY seq",
        )
        .map_err(|error| format!("读取对话历史失败：{error}"))?;
    let rows = statement
        .query_map([session_id], |row| {
            Ok(AiChatMessageRow {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                context_json: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(|error| format!("读取对话历史失败：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取对话历史失败：{error}"))
}

fn media_from_row(row: &rusqlite::Row<'_>) -> Result<MediaItem, String> {
    let genres_json: String = row.get(7).map_err(row_error)?;
    let cast_json: String = row.get(10).map_err(row_error)?;
    Ok(MediaItem {
        id: row.get(0).map_err(row_error)?,
        title: row.get(1).map_err(row_error)?,
        original_title: row.get(2).map_err(row_error)?,
        year: row.get(3).map_err(row_error)?,
        kind: row.get(4).map_err(row_error)?,
        rating: row.get(5).map_err(row_error)?,
        runtime_minutes: row.get(6).map_err(row_error)?,
        genres: serde_json::from_str(&genres_json)
            .map_err(|error| format!("解析媒体类型失败：{error}"))?,
        overview: row.get(8).map_err(row_error)?,
        director: row.get(9).map_err(row_error)?,
        cast: serde_json::from_str(&cast_json)
            .map_err(|error| format!("解析演员信息失败：{error}"))?,
        poster_tone: row.get(11).map_err(row_error)?,
        poster_accent: row.get(12).map_err(row_error)?,
        progress: row.get(13).map_err(row_error)?,
        source_label: row.get(14).map_err(row_error)?,
        source_status: row.get(15).map_err(row_error)?,
    })
}

fn row_error(error: rusqlite::Error) -> String {
    format!("读取媒体字段失败：{error}")
}

/// 仅在数据库完全为空时插入初始目录，绝不覆盖用户已经扫描或修改的数据。
fn seed_library_if_empty(connection: &mut Connection) -> Result<(), String> {
    let existing: Option<i64> = connection
        .query_row("SELECT 1 FROM media_items LIMIT 1", [], |row| row.get(0))
        .optional()
        .map_err(|error| format!("检查媒体库初始化状态失败：{error}"))?;
    if existing.is_none() {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("开始媒体库初始化事务失败：{error}"))?;
        for item in SEED_MEDIA {
            transaction
                .execute(
                    "INSERT INTO media_items
                     (id,title,original_title,year,kind,rating,runtime_minutes,genres_json,
                      overview,director,cast_json,poster_tone,poster_accent,progress,
                      source_label,source_status)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
                    params![
                        item.0, item.1, item.2, item.3, item.4, item.5, item.6, item.7, item.8,
                        item.9, item.10, item.11, item.12, item.13, item.14, item.15
                    ],
                )
                .map_err(|error| format!("写入初始媒体条目失败：{error}"))?;
        }
        transaction
            .commit()
            .map_err(|error| format!("提交媒体库初始化事务失败：{error}"))?;
    }
    Ok(())
}

type SeedMedia = (
    &'static str,
    &'static str,
    &'static str,
    i64,
    &'static str,
    f64,
    i64,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    f64,
    &'static str,
    &'static str,
);

const SEED_MEDIA: &[SeedMedia] = &[
    ("arrival","降临","Arrival",2016,"movie",7.8,116,"[\"科幻\",\"剧情\",\"悬疑\"]","十二艘外星飞船降临地球，语言学家露易丝受命解析来客的语言。理解一种全新的表达方式，也逐渐改变了她感知时间的方式。","丹尼斯·维伦纽瓦","[\"艾米·亚当斯\",\"杰瑞米·雷纳\",\"福里斯特·惠特克\"]","#172c38","#d6b676",0.42,"115 · 电影收藏","ready"),
    ("dune-two","沙丘 2","Dune: Part Two",2024,"movie",8.2,166,"[\"科幻\",\"冒险\"]","保罗与契妮并肩踏上复仇之路，在爱情、家族命运与已知宇宙的未来之间作出选择。","丹尼斯·维伦纽瓦","[\"提莫西·查拉梅\",\"赞达亚\",\"丽贝卡·弗格森\"]","#a34c24","#f0c690",0.0,"115 · 电影收藏","ready"),
    ("perfect-days","完美的日子","Perfect Days",2023,"movie",8.0,124,"[\"剧情\"]","平山在东京过着规律而安静的生活。音乐、书籍和树影组成日常，也让微小的相遇显得格外清晰。","维姆·文德斯","[\"役所广司\",\"柄本时生\",\"中野有纱\"]","#cfddd3","#da4c35",0.78,"115 · 待整理","ready"),
    ("severance","人生切割术","Severance",2022,"series",9.0,50,"[\"剧情\",\"科幻\",\"悬疑\"]","卢蒙公司用手术切断员工的工作记忆与生活记忆，一群职员开始追查这项制度背后的真实目的。","本·斯蒂勒","[\"亚当·斯科特\",\"布丽特·洛薇尔\",\"扎克·切利\"]","#e9e7de","#2b6a56",0.18,"115 · 美剧","ready"),
    ("monster","怪物","Monster",2023,"movie",8.6,126,"[\"剧情\"]","一场校园风波从母亲、老师与孩子的不同视角反复展开，真相在彼此错位的理解中逐渐显现。","是枝裕和","[\"安藤樱\",\"永山瑛太\",\"黑川想矢\"]","#305b52","#d9d5a8",0.0,"尚未关联文件","unlinked"),
    ("poor-things","可怜的东西","Poor Things",2023,"movie",7.6,141,"[\"奇幻\",\"喜剧\"]","贝拉离开实验室踏上旅程，以不受时代规训的目光重新认识世界、欲望与自由。","欧格斯·兰斯莫斯","[\"艾玛·斯通\",\"马克·鲁法洛\",\"威廉·达福\"]","#5d2244","#efb2b0",0.0,"115 · 电影收藏","ready"),
];

#[cfg(test)]
mod tests {
    use super::{
        AppSettings, BackupFingerprint, LibraryRepository, MediaInfo, UploadPartState,
        UploadSession,
    };
    use rusqlite::Connection;
    use std::time::UNIX_EPOCH;
    use std::{fs, path::Path, time::SystemTime};

    #[test]
    fn initializes_and_queries_in_memory_library() {
        let repository = LibraryRepository::open(Path::new(":memory:")).unwrap();
        assert_eq!(repository.list().unwrap().len(), 6);
        assert_eq!(repository.search("科幻").unwrap().len(), 3);
        assert_eq!(repository.search("Arrival").unwrap()[0].id, "arrival");
    }

    #[test]
    fn persists_and_removes_albums_index() {
        let repository = LibraryRepository::open(Path::new(":memory:")).unwrap();
        assert!(repository.list_albums_indexes().unwrap().is_empty());
        repository
            .save_albums_index("folder-1", r#"{"folderId":"folder-1"}"#, 3, 2)
            .unwrap();
        // 覆盖写入是幂等的。
        repository
            .save_albums_index("folder-1", r#"{"folderId":"folder-1"}"#, 4, 2)
            .unwrap();
        repository
            .save_albums_index("folder-2", r#"{"folderId":"folder-2"}"#, 1, 1)
            .unwrap();
        let rows = repository.list_albums_indexes().unwrap();
        assert_eq!(rows.len(), 2);
        // 移除只影响目标目录，其他索引保持不变。
        repository.delete_albums_index("folder-1").unwrap();
        let rows = repository.list_albums_indexes().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].folder_id, "folder-2");
    }

    #[test]
    fn persists_cloud_playback_progress() {
        let repository = LibraryRepository::open(Path::new(":memory:")).unwrap();
        assert!(repository.playback_progress("video-1").unwrap().is_none());
        repository
            .save_playback_progress("video-1", 125.5, 3600.0)
            .unwrap();
        let progress = repository.playback_progress("video-1").unwrap().unwrap();
        assert_eq!(progress.file_id, "video-1");
        assert_eq!(progress.position_seconds, 125.5);
        assert_eq!(progress.duration_seconds, 3600.0);
        assert!(repository
            .save_playback_progress("video-1", f64::NAN, 1.0)
            .is_err());
    }

    #[test]
    fn persists_and_overwrites_media_info() {
        let repository = LibraryRepository::open(Path::new(":memory:")).unwrap();
        assert!(repository.media_info("cloud115", "8").unwrap().is_none());
        let mut info = MediaInfo {
            provider: "cloud115".to_string(),
            file_id: "8".to_string(),
            duration_seconds: Some(7200.5),
            width: None,
            height: None,
            video_codec: None,
            audio_codec: None,
        };
        repository.save_media_info(&info).unwrap();
        info.width = Some(1920);
        info.height = Some(1080);
        info.video_codec = Some("h264".to_string());
        repository.save_media_info(&info).unwrap();
        // 同键覆盖，不产生第二行。
        assert_eq!(repository.media_info("cloud115", "8").unwrap(), Some(info));
        assert!(repository.media_info("cloud115", "9").unwrap().is_none());
        // 来源或文件标识为空必须在写入前拒绝。
        assert!(repository
            .save_media_info(&MediaInfo {
                provider: String::new(),
                file_id: "8".to_string(),
                duration_seconds: None,
                width: None,
                height: None,
                video_codec: None,
                audio_codec: None,
            })
            .is_err());
    }

    #[test]
    fn persists_settings_and_respects_disabled_auto_scrape() {
        let repository = LibraryRepository::open(Path::new(":memory:")).unwrap();
        assert_eq!(
            repository.app_settings().unwrap(),
            AppSettings {
                metadata_language: "zh-CN".to_string(),
                auto_scrape: true,
                playback_history: true,
            }
        );
        let updated = AppSettings {
            metadata_language: "en-US".to_string(),
            auto_scrape: false,
            playback_history: false,
        };
        repository.update_app_settings(&updated).unwrap();
        assert_eq!(repository.app_settings().unwrap(), updated);

        let unique = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("sirius-settings-test-{unique}"));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("Film.2026.mp4"), b"video").unwrap();
        let task = repository
            .scan_local_directory(root.to_str().unwrap())
            .unwrap();
        assert!(task.detail.contains("自动刮削已关闭"));
        let connection = repository.connection.lock().unwrap();
        let scrape_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM scrape_tasks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(scrape_count, 0);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scans_video_files_and_creates_persistent_tasks() {
        let unique = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("sirius-library-test-{unique}"));
        let nested = root.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(root.join("Film.2026.mp4"), b"video").unwrap();
        fs::write(nested.join("Episode01.mkv"), b"video").unwrap();
        fs::write(root.join("notes.txt"), b"ignore").unwrap();

        let repository = LibraryRepository::open(Path::new(":memory:")).unwrap();
        let task = repository
            .scan_local_directory(root.to_str().unwrap())
            .unwrap();
        assert_eq!(task.status, "completed");
        assert!(task.detail.contains("发现 2 个视频"));
        assert_eq!(repository.tasks().unwrap().len(), 1);

        let connection = repository.connection.lock().unwrap();
        let file_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM media_files", [], |row| row.get(0))
            .unwrap();
        let scrape_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM scrape_tasks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(file_count, 2);
        assert_eq!(scrape_count, 2);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn persists_updates_and_deletes_upload_sessions() {
        let repository = LibraryRepository::open(Path::new(":memory:")).unwrap();
        let mut session = UploadSession {
            account_id: 1,
            id: "upload-1".to_string(),
            local_path: "/tmp/video.mkv".to_string(),
            file_name: "video.mkv".to_string(),
            target_id: "0".to_string(),
            file_size: 42,
            file_sha1: "A".repeat(40),
            pre_sha1: "B".repeat(40),
            pick_code: "pick".to_string(),
            bucket: "bucket".to_string(),
            object_key: "object/key".to_string(),
            upload_id: "upload-id".to_string(),
            callback: "callback".to_string(),
            callback_var: "callback-var".to_string(),
            part_size: 20,
            completed_parts: vec![],
            status: "uploading".to_string(),
        };
        repository.save_upload_session(&session).unwrap();
        session.completed_parts.push(UploadPartState {
            number: 1,
            etag: "etag-1".to_string(),
        });
        session.status = "paused".to_string();
        repository.save_upload_session(&session).unwrap();
        assert_eq!(
            repository.upload_sessions(1).unwrap(),
            vec![session.clone()]
        );
        assert!(repository.upload_sessions(2).unwrap().is_empty());
        assert!(repository.delete_upload_session(2, &session.id).is_err());
        let mut wrong_owner = session.clone();
        wrong_owner.account_id = 2;
        assert!(repository.save_upload_session(&wrong_owner).is_err());
        assert_eq!(
            repository.upload_sessions(1).unwrap(),
            vec![session.clone()]
        );
        repository.delete_upload_session(1, &session.id).unwrap();
        assert!(repository.upload_sessions(1).unwrap().is_empty());
    }

    #[test]
    fn persists_and_cascades_ai_chat_sessions_and_messages() {
        let repository = LibraryRepository::open(Path::new(":memory:")).unwrap();
        // 缺省标题与指定标题都可用。
        let default_session = repository.create_ai_chat_session("s1", None).unwrap();
        assert_eq!(default_session.title, "新对话");
        let titled = repository
            .create_ai_chat_session("s2", Some("  整理讨论  "))
            .unwrap();
        assert_eq!(titled.title, "整理讨论");
        assert_eq!(repository.ai_chat_sessions().unwrap().len(), 2);

        repository
            .append_ai_chat_message(
                "m1",
                "s1",
                "user",
                "帮我把下载目录整理一下",
                Some(r#"{"page":"files","folderId":"0"}"#),
            )
            .unwrap();
        repository
            .append_ai_chat_message("m2", "s1", "assistant", "可以按文件类型归档", None)
            .unwrap();
        let history = repository.ai_chat_messages("s1").unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].role, "user");
        assert_eq!(history[0].content, "帮我把下载目录整理一下");
        assert_eq!(
            history[0].context_json.as_deref(),
            Some(r#"{"page":"files","folderId":"0"}"#)
        );
        assert_eq!(history[1].role, "assistant");
        assert_eq!(history[1].content, "可以按文件类型归档");
        assert_eq!(history[1].context_json, None);

        // 非法角色与空内容必须在写入前拒绝。
        assert!(repository
            .append_ai_chat_message("m3", "s1", "system", "x", None)
            .is_err());
        assert!(repository
            .append_ai_chat_message("m4", "s1", "user", "   ", None)
            .is_err());
        // 上下文快照必须是合法 JSON。
        assert!(repository
            .append_ai_chat_message("m5", "s1", "user", "hi", Some("not-json"))
            .is_err());
        // 会话不存在时写入与读取都要显式报错。
        assert!(repository
            .append_ai_chat_message("m6", "ghost", "user", "hi", None)
            .is_err());
        assert!(repository.ai_chat_messages("ghost").is_err());

        // 删除会话后消息经外键级联清除，其它会话不受影响。
        repository.delete_ai_chat_session("s1").unwrap();
        assert!(repository.ai_chat_messages("s1").is_err());
        assert_eq!(repository.ai_chat_sessions().unwrap().len(), 1);
        assert_eq!(repository.ai_chat_sessions().unwrap()[0].id, "s2");
        let connection = repository.connection.lock().unwrap();
        let orphan_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM ai_chat_messages WHERE session_id='s1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(orphan_count, 0);
        drop(connection);
        assert!(repository.delete_ai_chat_session(" ").is_err());
    }

    #[test]
    fn ai_chat_migration_is_idempotent_and_preserves_existing_data() {
        let unique = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("sirius-chat-migration-{unique}.sqlite3"));
        {
            let repository = LibraryRepository::open(&path).unwrap();
            repository
                .create_ai_chat_session("s1", Some("迁移前会话"))
                .unwrap();
            repository
                .append_ai_chat_message("m1", "s1", "user", "迁移前消息", None)
                .unwrap();
        }
        // 重新打开：迁移幂等重放，已有的会话与消息必须原样保留。
        {
            let repository = LibraryRepository::open(&path).unwrap();
            let history = repository.ai_chat_messages("s1").unwrap();
            assert_eq!(history.len(), 1);
            assert_eq!(history[0].content, "迁移前消息");
            assert_eq!(history[0].session_id, "s1");
            // 迁移后的库必须继续可写。
            repository
                .append_ai_chat_message("m2", "s1", "assistant", "重新打开后仍可写入", None)
                .unwrap();
            assert_eq!(repository.ai_chat_messages("s1").unwrap().len(), 2);
        }
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    /// 备份配对：新增、去重、级联清理与状态记录必须自洽。
    #[test]
    fn backup_pairs_persist_and_cascade() {
        let repository = LibraryRepository::open(Path::new(":memory:")).unwrap();
        assert!(repository.backup_pairs(1).unwrap().is_empty());

        let pair = repository
            .add_backup_pair(1, "/tmp/sirius-backup-a", "folder-9", "纪录片")
            .unwrap();
        assert_eq!(pair.remote_folder_id, "folder-9");
        assert_eq!(pair.synced_files, 0);
        assert!(pair.last_synced_at.is_none());

        // 同一本地目录不允许重复登记，错误信息必须点明原因。
        let duplicate = repository
            .add_backup_pair(1, "/tmp/sirius-backup-a", "folder-1", "电影")
            .unwrap_err();
        assert!(duplicate.contains("已在备份列表"), "实际错误：{duplicate}");

        repository
            .record_backup_file(1, &pair.id, "a/b.txt", 12, 1_700_000_000, "pick-1")
            .unwrap();
        // 同一相对路径再次记录是覆盖而非插入。
        repository
            .record_backup_file(1, &pair.id, "a/b.txt", 24, 1_700_000_100, "pick-2")
            .unwrap();
        let states = repository.backup_file_states(1, &pair.id).unwrap();
        assert_eq!(states.len(), 1);
        assert_eq!(states["a/b.txt"].local_size, 24);
        assert_eq!(states["a/b.txt"].remote_file_id, "pick-2");
        assert_eq!(repository.backup_pairs(1).unwrap()[0].synced_files, 1);

        repository.touch_backup_pair(1, &pair.id).unwrap();
        assert!(repository.backup_pairs(1).unwrap()[0]
            .last_synced_at
            .is_some());

        // 删除配对必须级联清理同步记录，避免孤儿行。
        repository.delete_backup_pair(1, &pair.id).unwrap();
        assert!(repository.backup_pairs(1).unwrap().is_empty());
        assert!(repository.backup_file_states(1, &pair.id).is_err());
        let connection = repository.connection.lock().unwrap();
        let remaining: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM backup_file_state WHERE pair_id=?1",
                [&pair.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0);
        drop(connection);
        let missing = repository.delete_backup_pair(1, &pair.id).unwrap_err();
        assert!(missing.contains("不存在"), "实际错误：{missing}");
    }

    /// 备份扫描只比较「大小 + 修改时间」：指纹未变的文件必须跳过。
    #[test]
    fn backup_scan_skips_unchanged_files() {
        let root = std::env::temp_dir().join(format!(
            "sirius-backup-scan-{}",
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("top.txt"), b"top").unwrap();
        fs::write(root.join("nested/inner.txt"), b"inner").unwrap();

        let repository = LibraryRepository::open(Path::new(":memory:")).unwrap();
        let pair = repository
            .add_backup_pair(1, &root.to_string_lossy(), "folder-1", "目标")
            .unwrap();

        let first = repository.scan_backup_pair(1, &pair.id).unwrap();
        assert_eq!(first.total_files, 2);
        assert_eq!(first.pending_files, 2);
        assert_eq!(first.unchanged_files, 0);
        assert_eq!(first.pending_paths, vec!["nested/inner.txt", "top.txt"]);

        // 把两个文件都标记为已同步，且指纹与磁盘当前状态一致。
        for relative in ["nested/inner.txt", "top.txt"] {
            let fingerprint = BackupFingerprint::read(&root.join(relative)).unwrap();
            repository
                .record_backup_file(
                    1,
                    &pair.id,
                    relative,
                    fingerprint.size_bytes,
                    fingerprint.modified_at,
                    "pick",
                )
                .unwrap();
        }
        let second = repository.scan_backup_pair(1, &pair.id).unwrap();
        assert_eq!(second.pending_files, 0);
        assert_eq!(second.unchanged_files, 2);

        // 修改内容后（大小变化）必须重新进入待上传列表。
        fs::write(root.join("top.txt"), b"top changed").unwrap();
        let third = repository.scan_backup_pair(1, &pair.id).unwrap();
        assert_eq!(third.pending_paths, vec!["top.txt"]);

        let _ = fs::remove_dir_all(&root);
    }

    /// 未登记配对或目录不存在时，扫描必须显式失败而不是返回空结果。
    #[test]
    fn backup_scan_rejects_unknown_pair_and_missing_directory() {
        let repository = LibraryRepository::open(Path::new(":memory:")).unwrap();
        assert!(repository.scan_backup_pair(1, "backup-missing").is_err());

        let pair = repository
            .add_backup_pair(1, "/tmp/sirius-definitely-missing-dir", "folder-1", "目标")
            .unwrap();
        let error = repository.scan_backup_pair(1, &pair.id).unwrap_err();
        assert!(error.contains("不是目录"), "实际错误：{error}");
    }

    /// 不同账号可备份同一本地目录，但不能读取、写入或删除彼此的配对。
    #[test]
    fn backup_pairs_are_isolated_by_account() {
        let repository = LibraryRepository::open(Path::new(":memory:")).unwrap();
        let first = repository
            .add_backup_pair(1, "/tmp/shared-source", "folder-a", "A")
            .unwrap();
        let second = repository
            .add_backup_pair(2, "/tmp/shared-source", "folder-b", "B")
            .unwrap();
        assert_eq!(repository.backup_pairs(1).unwrap()[0].id, first.id);
        assert_eq!(repository.backup_pairs(2).unwrap()[0].id, second.id);
        assert!(repository.backup_pair(2, &first.id).is_err());
        assert!(repository.backup_file_states(2, &first.id).is_err());
        assert!(repository
            .record_backup_file(2, &first.id, "file.txt", 1, 1, "pick")
            .is_err());
        assert!(repository.touch_backup_pair(2, &first.id).is_err());
        assert!(repository.delete_backup_pair(2, &first.id).is_err());
        assert_eq!(repository.backup_pairs(1).unwrap().len(), 1);
        assert!(repository.backup_pairs(0).is_err());
    }

    /// 旧版记录无法证明账号归属时完整保留，但不暴露给首次登录的新账号。
    #[test]
    fn account_migration_preserves_unowned_backup_data_and_is_idempotent() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("sirius-account-migration-{unique}"));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("state.sqlite3");
        {
            let connection = Connection::open(&path).unwrap();
            connection.execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE backup_pairs (id TEXT PRIMARY KEY, local_path TEXT NOT NULL UNIQUE,
                   remote_folder_id TEXT NOT NULL, remote_folder_name TEXT NOT NULL,
                   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_synced_at TEXT);
                 CREATE TABLE backup_file_state (pair_id TEXT NOT NULL REFERENCES backup_pairs(id) ON DELETE CASCADE,
                   relative_path TEXT NOT NULL, local_size INTEGER NOT NULL, local_modified_at INTEGER NOT NULL,
                   remote_file_id TEXT NOT NULL, synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   PRIMARY KEY(pair_id,relative_path));
                 INSERT INTO backup_pairs(id,local_path,remote_folder_id,remote_folder_name)
                   VALUES('legacy','/tmp/legacy','old-folder','旧配对');
                 INSERT INTO backup_file_state(pair_id,relative_path,local_size,local_modified_at,remote_file_id)
                   VALUES('legacy','nested/file.txt',3,42,'old-pick');"
            ).unwrap();
        }
        for _ in 0..2 {
            let repository = LibraryRepository::open(&path).unwrap();
            assert!(repository.backup_pairs(1).unwrap().is_empty());
            assert!(repository.upload_sessions(1).unwrap().is_empty());
            let connection = repository.connection.lock().unwrap();
            let preserved: (String, Option<i64>) = connection
                .query_row(
                    "SELECT local_path,account_id FROM backup_pairs WHERE id='legacy'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(preserved, ("/tmp/legacy".to_string(), None));
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM backup_file_state WHERE pair_id='legacy'",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                1
            );
            assert_eq!(
                connection
                    .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert!(!connection
                .prepare("PRAGMA foreign_key_check")
                .unwrap()
                .exists([])
                .unwrap());
        }
        fs::remove_dir_all(root).unwrap();
    }

    /// 重生成只能使用原提问之前的上下文，不可借助手 ID 访问另一个会话。
    #[test]
    fn regeneration_context_excludes_later_turns_and_rejects_wrong_targets() {
        let repository = LibraryRepository::open(Path::new(":memory:")).unwrap();
        repository.create_ai_chat_session("first", None).unwrap();
        repository.create_ai_chat_session("other", None).unwrap();
        for (id, role, text) in [
            ("u1", "user", "原提问"),
            ("a1", "assistant", "原回复"),
            ("u2", "user", "后续提问"),
            ("a2", "assistant", "后续回复"),
        ] {
            repository
                .append_ai_chat_message(id, "first", role, text, None)
                .unwrap();
        }
        let (target, user, history) = repository
            .regenerate_ai_chat_context("first", "a1")
            .unwrap();
        assert_eq!(target.id, "a1");
        assert_eq!(user.id, "u1");
        assert_eq!(
            history
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            ["u1"]
        );
        assert!(repository
            .regenerate_ai_chat_context("other", "a1")
            .is_err());
        assert!(repository
            .regenerate_ai_chat_context("first", "u1")
            .is_err());
        assert!(repository
            .replace_ai_chat_assistant_content("other", "a1", "替换")
            .is_err());
        assert_eq!(repository.ai_chat_messages("first").unwrap().len(), 4);
    }
}
