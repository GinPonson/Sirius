use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

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
                 );",
            )
            .map_err(|error| format!("迁移 SQLite 媒体库失败：{error}"))?;

        let mut connection = connection;
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
        connection
            .execute(
                "INSERT INTO upload_sessions
                 (id,local_path,file_name,target_id,file_size,file_sha1,pre_sha1,pick_code,
                  bucket,object_key,upload_id,callback,callback_var,part_size,
                  completed_parts_json,status)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
                 ON CONFLICT(id) DO UPDATE SET
                   local_path=excluded.local_path,file_name=excluded.file_name,
                   target_id=excluded.target_id,file_size=excluded.file_size,
                   file_sha1=excluded.file_sha1,pre_sha1=excluded.pre_sha1,
                   pick_code=excluded.pick_code,bucket=excluded.bucket,
                   object_key=excluded.object_key,upload_id=excluded.upload_id,
                   callback=excluded.callback,callback_var=excluded.callback_var,
                   part_size=excluded.part_size,
                   completed_parts_json=excluded.completed_parts_json,
                   status=excluded.status,updated_at=CURRENT_TIMESTAMP",
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
                ],
            )
            .map_err(|error| format!("保存上传会话失败：{error}"))?;
        Ok(())
    }

    /// 返回全部未完成上传会话，供启动恢复与任务页展示。
    pub fn upload_sessions(&self) -> Result<Vec<UploadSession>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT id,local_path,file_name,target_id,file_size,file_sha1,pre_sha1,
                        pick_code,bucket,object_key,upload_id,callback,callback_var,part_size,
                        completed_parts_json,status
                 FROM upload_sessions ORDER BY updated_at DESC,id DESC",
            )
            .map_err(|error| format!("准备上传会话查询失败：{error}"))?;
        let rows = statement
            .query_map([], upload_session_from_row)
            .map_err(|error| format!("执行上传会话查询失败：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("读取上传会话失败：{error}"))?
            .into_iter()
            .map(|stored| stored.into_upload_session())
            .collect()
    }

    /// 上传完成或用户明确取消后删除对应会话，不影响其它任务记录。
    pub fn delete_upload_session(&self, id: &str) -> Result<(), String> {
        if id.trim().is_empty() {
            return Err("上传会话 ID 不能为空".to_string());
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 媒体库锁已损坏，必须重启应用".to_string())?;
        connection
            .execute("DELETE FROM upload_sessions WHERE id=?1", [id])
            .map_err(|error| format!("删除上传会话失败：{error}"))?;
        Ok(())
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

struct StoredUploadSession {
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
    use super::{AppSettings, LibraryRepository, MediaInfo, UploadPartState, UploadSession};
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
        assert_eq!(repository.upload_sessions().unwrap(), vec![session.clone()]);
        repository.delete_upload_session(&session.id).unwrap();
        assert!(repository.upload_sessions().unwrap().is_empty());
    }
}
