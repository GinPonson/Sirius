mod ai;
mod ai_chat;
mod albums;
mod cloud115;
mod comics;
mod library;
mod media_info;
mod playback;
mod transfer;

use ai::{
    AiExecutionReport, AiExecutionRequest, AiOrganizationPlan, AiProviderSettingsView,
    AiProviderUpdateInput,
};
use ai_chat::{AiChatSendReceipt, ChatStreamRegistry};
use albums::{AlbumFolderInput, AlbumsIndexSummary, PhotosOverview};
use comics::{ComicOpenInput, ComicSession, ComicsIndexSummary, ComicsOverview};

use cloud115::{
    Cloud115AccountStatus, Cloud115AuthChallenge, Cloud115AuthPoll, Cloud115ClientApp,
    Cloud115DownloadResult, Cloud115DownloadSource, Cloud115FileMetadata, Cloud115FilePage,
    Cloud115FolderResult, Cloud115PlaybackSource, Cloud115Provider, Cloud115RecyclePage,
    Cloud115SearchScope, Cloud115SubtitleStream, Cloud115UploadResult, Cloud115UserProfile,
};
use library::{
    AiChatMessageRow, AiChatSession, AppSettings, LibraryRepository, LibraryTask, MediaInfo,
    MediaItem, PlaybackProgress, UploadSession,
};
use playback::{PlaybackManager, PlaybackSnapshot, RemoteSourceResolver};
use std::sync::Arc;
use tauri::{window::WindowBuilder, AppHandle, Emitter, Manager, State, Window};
use transfer::TransferProgress;

const VIDEO_WINDOW_LABEL: &str = "video";

/// 把传输进度事件转发到 WebView；负载契约与 `src/services/events.ts` 保持一致。
fn transfer_progress_callback(app: &AppHandle) -> transfer::ProgressCallback {
    let app = app.clone();
    Arc::new(move |progress: TransferProgress| {
        if let Err(error) = app.emit(transfer::TRANSFER_PROGRESS_EVENT, progress) {
            eprintln!("发送传输进度事件失败：{error}");
        }
    })
}

/// 返回 Sirius 支持选择的 115 开放平台应用身份。
#[tauri::command]
fn cloud115_client_apps(provider: State<'_, Arc<Cloud115Provider>>) -> Vec<Cloud115ClientApp> {
    provider.client_apps()
}

/// 返回本机钥匙串中的 115 登录状态，不向前端暴露 Token。
#[tauri::command]
fn cloud115_account_status(
    provider: State<'_, Arc<Cloud115Provider>>,
) -> Result<Cloud115AccountStatus, String> {
    provider.account_status()
}

/// 使用用户选择的 Client ID 申请 115 设备码和二维码。
#[tauri::command]
async fn cloud115_begin_auth(
    client_id: String,
    provider: State<'_, Arc<Cloud115Provider>>,
) -> Result<Cloud115AuthChallenge, String> {
    provider.begin_auth(&client_id).await
}

/// 对当前设备码执行一次授权状态长轮询。
#[tauri::command]
async fn cloud115_poll_auth(
    provider: State<'_, Arc<Cloud115Provider>>,
) -> Result<Cloud115AuthPoll, String> {
    provider.poll_auth().await
}

/// 清除本机保存的 115 登录态。
#[tauri::command]
fn cloud115_sign_out(provider: State<'_, Arc<Cloud115Provider>>) -> Result<(), String> {
    provider.sign_out()
}

/// 返回当前 115 用户的公开资料、容量与会员信息。
#[tauri::command]
async fn cloud115_user_profile(
    provider: State<'_, Arc<Cloud115Provider>>,
) -> Result<Cloud115UserProfile, String> {
    provider.user_profile().await
}

/// 列出目录内容；query 非空时在当前目录内搜索。
///
/// `search_scope` 为 "global" 时改为全账号跨目录搜索（对齐 StarVault 默认行为）；
/// 缺省按当前目录，保持旧调用方行为不变。
#[tauri::command]
async fn cloud115_list_files(
    parent_id: String,
    offset: u64,
    limit: u64,
    query: String,
    search_scope: Option<Cloud115SearchScope>,
    provider: State<'_, Arc<Cloud115Provider>>,
) -> Result<Cloud115FilePage, String> {
    match search_scope.unwrap_or_default() {
        Cloud115SearchScope::Current => {
            provider.list_files(&parent_id, offset, limit, &query).await
        }
        Cloud115SearchScope::Global => provider.search_files(offset, limit, &query).await,
    }
}

/// 列出全账号星标文件与文件夹（115 `star=1` + `cur=0` 组合）。
#[tauri::command]
async fn cloud115_list_starred_files(
    offset: u64,
    limit: u64,
    provider: State<'_, Arc<Cloud115Provider>>,
) -> Result<Cloud115FilePage, String> {
    provider.list_starred_files(offset, limit).await
}

/// 把视频 pick_code 换成短时效 HTTPS 播放直链。
#[tauri::command]
async fn cloud115_playback_source(
    pick_code: String,
    provider: State<'_, Arc<Cloud115Provider>>,
) -> Result<Cloud115PlaybackSource, String> {
    provider.playback_source(&pick_code).await
}

/// 返回视频关联的 115 外挂字幕列表。
#[tauri::command]
async fn cloud115_video_subtitles(
    pick_code: String,
    provider: State<'_, Arc<Cloud115Provider>>,
) -> Result<Vec<Cloud115SubtitleStream>, String> {
    provider.video_subtitles(&pick_code).await
}

/// 把普通文件 pick_code 换成短时效下载地址。
#[tauri::command]
async fn cloud115_download_source(
    pick_code: String,
    provider: State<'_, Arc<Cloud115Provider>>,
) -> Result<Cloud115DownloadSource, String> {
    provider.download_source(&pick_code).await
}

/// 将 115 文件下载到本地目录；存在 .sirius-part 临时文件时自动断点续传，成功后原子重命名。
/// 下载进度经 transfer://progress 事件限频推送。
#[tauri::command]
async fn cloud115_download_file(
    pick_code: String,
    target_dir: String,
    file_name: String,
    expected_size_bytes: u64,
    provider: State<'_, Arc<Cloud115Provider>>,
    app: AppHandle,
) -> Result<Cloud115DownloadResult, String> {
    provider
        .download_file(
            &pick_code,
            &target_dir,
            &file_name,
            expected_size_bytes,
            Some(transfer_progress_callback(&app)),
        )
        .await
}

/// 返回单个 115 文件或文件夹的完整元数据。
#[tauri::command]
async fn cloud115_file_metadata(
    file_id: String,
    provider: State<'_, Arc<Cloud115Provider>>,
) -> Result<Cloud115FileMetadata, String> {
    provider.file_metadata(&file_id).await
}

/// 在指定 115 目录中创建空文件夹。
#[tauri::command]
async fn cloud115_create_folder(
    parent_id: String,
    name: String,
    provider: State<'_, Arc<Cloud115Provider>>,
) -> Result<Cloud115FolderResult, String> {
    provider.create_folder(&parent_id, &name).await
}

/// 更新单个 115 文件或文件夹的名称/星标。
#[tauri::command]
async fn cloud115_update_file(
    file_id: String,
    name: Option<String>,
    starred: Option<bool>,
    provider: State<'_, Arc<Cloud115Provider>>,
) -> Result<(), String> {
    provider
        .update_file(&file_id, name.as_deref(), starred)
        .await
}

/// 批量移动 115 文件或文件夹。
#[tauri::command]
async fn cloud115_move_files(
    file_ids: Vec<String>,
    target_id: String,
    provider: State<'_, Arc<Cloud115Provider>>,
) -> Result<(), String> {
    provider.move_files(&file_ids, &target_id).await
}

/// 批量复制 115 文件或文件夹到指定目录。
#[tauri::command]
async fn cloud115_copy_files(
    file_ids: Vec<String>,
    target_id: String,
    allow_duplicates: bool,
    provider: State<'_, Arc<Cloud115Provider>>,
) -> Result<(), String> {
    provider
        .copy_files(&file_ids, &target_id, allow_duplicates)
        .await
}

/// 从磁盘流式上传本地文件到指定 115 目录：SHA1 与分块按需读取，≤20 MiB 单对象 PUT，更大文件 multipart。
/// 上传进度经 transfer://progress 事件按阶段推送。
#[tauri::command]
async fn cloud115_upload_file(
    path: String,
    target_id: String,
    provider: State<'_, Arc<Cloud115Provider>>,
    repository: State<'_, Arc<LibraryRepository>>,
    app: AppHandle,
) -> Result<Cloud115UploadResult, String> {
    provider
        .upload_file_from_disk(
            repository.inner(),
            &path,
            &target_id,
            Some(transfer_progress_callback(&app)),
        )
        .await
}

/// 批量删除 115 文件或文件夹到回收站。
#[tauri::command]
async fn cloud115_delete_files(
    file_ids: Vec<String>,
    provider: State<'_, Arc<Cloud115Provider>>,
) -> Result<(), String> {
    provider.delete_files(&file_ids).await
}

/// 分页返回 115 回收站条目。
#[tauri::command]
async fn cloud115_list_recycle_bin(
    offset: u64,
    limit: u64,
    provider: State<'_, Arc<Cloud115Provider>>,
) -> Result<Cloud115RecyclePage, String> {
    provider.list_recycle_bin(offset, limit).await
}

/// 批量恢复 115 回收站条目。
#[tauri::command]
async fn cloud115_restore_recycle_items(
    item_ids: Vec<String>,
    provider: State<'_, Arc<Cloud115Provider>>,
) -> Result<(), String> {
    provider.restore_recycle_items(&item_ids).await
}

/// 批量彻底删除 115 回收站条目。
#[tauri::command]
async fn cloud115_delete_recycle_items(
    item_ids: Vec<String>,
    provider: State<'_, Arc<Cloud115Provider>>,
) -> Result<(), String> {
    provider.delete_recycle_items(&item_ids).await
}

/// 返回 SQLite 中的全部媒体条目。
#[tauri::command]
async fn library_list(
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<Vec<MediaItem>, String> {
    let repository = Arc::clone(repository.inner());
    tauri::async_runtime::spawn_blocking(move || repository.list())
        .await
        .map_err(|error| format!("媒体库查询线程异常终止：{error}"))?
}

/// 使用参数化 SQL 搜索媒体库。
#[tauri::command]
async fn library_search(
    query: String,
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<Vec<MediaItem>, String> {
    let repository = Arc::clone(repository.inner());
    tauri::async_runtime::spawn_blocking(move || repository.search(&query))
        .await
        .map_err(|error| format!("媒体库搜索线程异常终止：{error}"))?
}

/// 返回持久化的扫描与整理任务。
#[tauri::command]
async fn library_tasks(
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<Vec<LibraryTask>, String> {
    let repository = Arc::clone(repository.inner());
    tauri::async_runtime::spawn_blocking(move || repository.tasks())
        .await
        .map_err(|error| format!("任务查询线程异常终止：{error}"))?
}

/// 返回 SQLite 中唯一一行应用设置。
#[tauri::command]
async fn app_settings(
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<AppSettings, String> {
    let repository = Arc::clone(repository.inner());
    tauri::async_runtime::spawn_blocking(move || repository.app_settings())
        .await
        .map_err(|error| format!("应用设置查询线程异常终止：{error}"))?
}

/// 校验并原子保存完整应用设置。
#[tauri::command]
async fn update_app_settings(
    settings: AppSettings,
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<AppSettings, String> {
    let repository = Arc::clone(repository.inner());
    tauri::async_runtime::spawn_blocking(move || repository.update_app_settings(&settings))
        .await
        .map_err(|error| format!("应用设置保存线程异常终止：{error}"))?
}

/// 返回 SQLite 中尚未完成的 115 multipart 会话，供任务页展示与恢复调度。
#[tauri::command]
async fn cloud115_upload_sessions(
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<Vec<UploadSession>, String> {
    let repository = Arc::clone(repository.inner());
    tauri::async_runtime::spawn_blocking(move || repository.upload_sessions())
        .await
        .map_err(|error| format!("上传会话查询线程异常终止：{error}"))?
}

/// 从 SQLite 会话恢复 multipart；本地文件按需流式读取与校验，不再有 64 MiB 上限。
/// 恢复进度同样经 transfer://progress 事件按阶段推送。
#[tauri::command]
async fn cloud115_resume_upload(
    session_id: String,
    provider: State<'_, Arc<Cloud115Provider>>,
    repository: State<'_, Arc<LibraryRepository>>,
    app: AppHandle,
) -> Result<Cloud115UploadResult, String> {
    if session_id.trim().is_empty() {
        return Err("上传会话 ID 不能为空".to_string());
    }
    let repository = Arc::clone(repository.inner());
    let query_repository = Arc::clone(&repository);
    let session = tauri::async_runtime::spawn_blocking(move || {
        query_repository
            .upload_sessions()?
            .into_iter()
            .find(|session| session.id == session_id)
            .ok_or_else(|| "未找到指定上传会话".to_string())
    })
    .await
    .map_err(|error| format!("上传会话查询线程异常终止：{error}"))??;
    provider
        .resume_upload_session(
            repository.as_ref(),
            session,
            Some(transfer_progress_callback(&app)),
        )
        .await
}

/// 返回 AI 整理服务商配置；密钥只返回是否已保存，永不返回内容。
#[tauri::command]
fn ai_provider_settings(
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<AiProviderSettingsView, String> {
    let settings = repository.ai_provider()?;
    Ok(AiProviderSettingsView {
        base_url: settings.base_url,
        model: settings.model,
        key_stored: ai::stored_api_key()?,
    })
}

/// 保存 AI 服务商配置；api_key 提供非空值时覆盖钥匙串中的密钥。
#[tauri::command]
async fn ai_update_provider(
    settings: AiProviderUpdateInput,
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<AiProviderSettingsView, String> {
    let repository = Arc::clone(repository.inner());
    tauri::async_runtime::spawn_blocking(move || {
        ai::persist_provider_settings(&repository, &settings)
    })
    .await
    .map_err(|error| format!("保存 AI 配置线程异常终止：{error}"))?
}

/// 只读分析 115 目录并生成整理计划预览；本命令不执行任何文件修改。
#[tauri::command]
async fn ai_analyze_folder(
    folder_id: String,
    provider: State<'_, Arc<Cloud115Provider>>,
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<AiOrganizationPlan, String> {
    ai::analyze_folder(provider.inner(), repository.inner(), &folder_id).await
}

/// 执行用户显式确认过的整理计划；策略引擎在 Rust 内重新校验快照绑定并强制执行重命名/移动/删除策略。
#[tauri::command]
async fn ai_execute_plan(
    request: AiExecutionRequest,
    provider: State<'_, Arc<Cloud115Provider>>,
) -> Result<AiExecutionReport, String> {
    ai::execute_plan(provider.inner(), &request).await
}

/// 新建 AI 对话会话并返回其元数据；title 缺省时使用默认标题。
#[tauri::command]
async fn ai_chat_create(
    title: Option<String>,
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<AiChatSession, String> {
    let repository = Arc::clone(repository.inner());
    tauri::async_runtime::spawn_blocking(move || {
        repository.create_ai_chat_session(&ai_chat::next_chat_session_id(), title.as_deref())
    })
    .await
    .map_err(|error| format!("创建对话会话线程异常终止：{error}"))?
}

/// 返回全部 AI 对话会话元数据，按最近更新倒序。
#[tauri::command]
async fn ai_chat_sessions_list(
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<Vec<AiChatSession>, String> {
    let repository = Arc::clone(repository.inner());
    tauri::async_runtime::spawn_blocking(move || repository.ai_chat_sessions())
        .await
        .map_err(|error| format!("对话会话查询线程异常终止：{error}"))?
}

/// 返回会话内全部消息（按时间顺序），含随消息存档的页面上下文快照。
#[tauri::command]
async fn ai_chat_history(
    session_id: String,
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<Vec<AiChatMessageRow>, String> {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("会话 ID 不能为空".to_string());
    }
    let repository = Arc::clone(repository.inner());
    tauri::async_runtime::spawn_blocking(move || repository.ai_chat_messages(&session_id))
        .await
        .map_err(|error| format!("对话历史查询线程异常终止：{error}"))?
}

/// 删除会话及其全部消息；存在进行中的回复时拒绝，避免流任务写回已删除的会话。
#[tauri::command]
async fn ai_chat_delete(
    session_id: String,
    repository: State<'_, Arc<LibraryRepository>>,
    registry: State<'_, Arc<ChatStreamRegistry>>,
) -> Result<(), String> {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("会话 ID 不能为空".to_string());
    }
    if registry.has_active(&session_id) {
        return Err("会话正在回复中，请先停止当前回复再删除".to_string());
    }
    let repository = Arc::clone(repository.inner());
    tauri::async_runtime::spawn_blocking(move || repository.delete_ai_chat_session(&session_id))
        .await
        .map_err(|error| format!("删除对话会话线程异常终止：{error}"))?
}

/// 中断会话当前进行中的流式回复；返回是否确实存在进行中的流。
/// 中断后已收到的部分回复会被持久化，并补发一次 done 事件（error=「已停止」）。
#[tauri::command]
fn ai_chat_stop(
    session_id: String,
    registry: State<'_, Arc<ChatStreamRegistry>>,
) -> Result<bool, String> {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("会话 ID 不能为空".to_string());
    }
    Ok(registry.stop(&session_id))
}

/// 发送一条用户消息并启动流式回复。
///
/// 校验通过后立即返回回执（含在首个增量前确定的助手消息 ID）；增量经
/// `ai://chat-token` 事件推送，终态事件恰好一次。页面上下文（context 摘要
/// 对象）随本条用户消息持久化，并并入该条消息的请求文本。
#[tauri::command]
async fn ai_chat_send(
    session_id: String,
    content: String,
    context: Option<serde_json::Value>,
    repository: State<'_, Arc<LibraryRepository>>,
    registry: State<'_, Arc<ChatStreamRegistry>>,
    app: AppHandle,
) -> Result<AiChatSendReceipt, String> {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("会话 ID 不能为空".to_string());
    }
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("消息内容不能为空".to_string());
    }
    let repository = Arc::clone(repository.inner());
    let registry = Arc::clone(registry.inner());

    // 配置与密钥在任何写入前快速校验；密钥值只进入请求头，不进日志或事件。
    let (settings, api_key) = {
        let repository = Arc::clone(&repository);
        tauri::async_runtime::spawn_blocking(move || {
            let settings = repository.ai_provider()?;
            let api_key = ai::require_api_key()?;
            Ok::<_, String>((settings, api_key))
        })
        .await
        .map_err(|error| format!("读取 AI 配置线程异常终止：{error}"))??
    };

    // 并发互斥：同一会话同时只允许一个进行中的回复。
    let stopper = registry.register(&session_id)?;

    let send_result = async {
        let history = {
            let repository = Arc::clone(&repository);
            let session_id = session_id.clone();
            tauri::async_runtime::spawn_blocking(move || repository.ai_chat_messages(&session_id))
                .await
                .map_err(|error| format!("读取对话历史线程异常终止：{error}"))??
        };
        let user_message_id = ai_chat::next_chat_message_id();
        // 上下文的解析与大小校验都发生在任何持久化之前。
        let turns = ai_chat::build_chat_turns(&history, &content, context.as_ref())?;
        let context_json = ai_chat::context_to_json(context.as_ref())?;

        // 先持久化用户消息再启动流：流失败或应用退出时消息也不丢失。
        {
            let repository = Arc::clone(&repository);
            let session_id = session_id.clone();
            let user_message_id = user_message_id.clone();
            let content = content.clone();
            tauri::async_runtime::spawn_blocking(move || {
                repository.append_ai_chat_message(
                    &user_message_id,
                    &session_id,
                    "user",
                    &content,
                    context_json.as_deref(),
                )
            })
            .await
            .map_err(|error| format!("保存对话消息线程异常终止：{error}"))??;
        }

        // 助手消息 ID 在首个增量事件前确定，前端用它聚合 delta。
        let message_id = ai_chat::next_chat_message_id();
        let task_repository = Arc::clone(&repository);
        let task_registry = Arc::clone(&registry);
        let task_session_id = session_id.clone();
        let task_message_id = message_id.clone();
        let task_app = app.clone();
        tauri::async_runtime::spawn(async move {
            let job = ai_chat::ChatStreamJob {
                settings: &settings,
                api_key: &api_key,
                turns: &turns,
                session_id: &task_session_id,
                message_id: &task_message_id,
            };
            ai_chat::run_chat_stream(
                task_repository.as_ref(),
                &job,
                &stopper,
                &task_registry,
                |event| {
                    if let Err(error) = task_app.emit(ai_chat::AI_CHAT_TOKEN_EVENT, event) {
                        eprintln!("发送 AI 对话事件失败：{error}");
                    }
                },
            )
            .await;
        });
        Ok(AiChatSendReceipt {
            // 克隆而非移动：外层在发送失败时还需要会话 ID 释放并发互斥。
            session_id: session_id.clone(),
            message_id,
            user_message_id,
        })
    }
    .await;

    // 后续任一步失败都要释放并发互斥，允许用户立即重试。
    if send_result.is_err() {
        registry.unregister(&session_id);
    }
    send_result
}

/// 识别 115 目录中的漫画压缩包并按系列分组；单次最多读取 200 项，结果持久化为本机索引。
#[tauri::command]
async fn comics_recognize(
    folder_id: String,
    provider: State<'_, Arc<Cloud115Provider>>,
    repository: State<'_, Arc<LibraryRepository>>,
    app: AppHandle,
) -> Result<ComicsOverview, String> {
    comics::recognize_comics(&app, provider.inner(), repository.inner(), &folder_id).await
}

/// 汇总本机已持久化的漫画索引为统一书架，并补齐缓存封面路径。
#[tauri::command]
fn comics_index(
    repository: State<'_, Arc<LibraryRepository>>,
    app: AppHandle,
) -> Result<ComicsIndexSummary, String> {
    comics::index_summary(&app, repository.inner())
}

/// 批量索引多个 115 目录；单次上限 20 个目录，顺序执行并持久化各自索引。
#[tauri::command]
async fn comics_index_folders(
    folder_ids: Vec<String>,
    provider: State<'_, Arc<Cloud115Provider>>,
    repository: State<'_, Arc<LibraryRepository>>,
    app: AppHandle,
) -> Result<Vec<ComicsOverview>, String> {
    comics::index_folders(&app, provider.inner(), repository.inner(), &folder_ids).await
}

/// 打开漫画卷：下载到有界缓存并解压出页图，返回页路径与本机续读页码。
#[tauri::command]
async fn comics_open_volume(
    input: ComicOpenInput,
    provider: State<'_, Arc<Cloud115Provider>>,
    repository: State<'_, Arc<LibraryRepository>>,
    app: AppHandle,
) -> Result<ComicSession, String> {
    comics::open_volume(&app, provider.inner(), repository.inner(), &input).await
}

/// 保存漫画阅读进度；只写入本机 SQLite，不写回 115。
#[tauri::command]
async fn comics_save_progress(
    file_id: String,
    page_index: u64,
    page_count: u64,
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<(), String> {
    if page_count == 0 || page_index >= page_count {
        return Err("漫画阅读进度页码无效".to_string());
    }
    let repository = Arc::clone(repository.inner());
    tauri::async_runtime::spawn_blocking(move || {
        repository.save_comics_progress(&file_id, page_index as i64, page_count as i64)
    })
    .await
    .map_err(|error| format!("保存阅读进度线程异常终止：{error}"))?
}

/// 识别 115 目录中的照片并按 UTC 月份聚合；单次最多读取 200 项，结果持久化为本机索引。
#[tauri::command]
async fn albums_recognize(
    input: AlbumFolderInput,
    provider: State<'_, Arc<Cloud115Provider>>,
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<PhotosOverview, String> {
    albums::recognize_photos(provider.inner(), repository.inner(), &input).await
}

/// 汇总本机已持久化的相册索引为统一时间线与专辑分组。
#[tauri::command]
fn albums_index(
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<AlbumsIndexSummary, String> {
    albums::index_summary(repository.inner())
}

/// 批量索引多个 115 目录；单次上限 20 个目录，顺序执行并持久化各自索引。
#[tauri::command]
async fn albums_index_folders(
    folders: Vec<AlbumFolderInput>,
    provider: State<'_, Arc<Cloud115Provider>>,
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<Vec<PhotosOverview>, String> {
    albums::index_folders(provider.inner(), repository.inner(), &folders).await
}

/// 从本机移除一个目录的相册索引；远程目录与照片不受影响。
#[tauri::command]
async fn albums_remove_index(
    folder_id: String,
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<(), String> {
    let repository = Arc::clone(repository.inner());
    tauri::async_runtime::spawn_blocking(move || repository.delete_albums_index(&folder_id))
        .await
        .map_err(|error| format!("移除相册索引线程异常终止：{error}"))?
}

/// 刮削 115 视频的媒体信息（时长）并持久化到本机 SQLite。
#[tauri::command]
async fn media_scrape_115(
    file_id: String,
    provider: State<'_, Arc<Cloud115Provider>>,
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<MediaInfo, String> {
    media_info::scrape_cloud_file(provider.inner(), repository.inner(), &file_id).await
}

/// 用无渲染 libmpv 实例探测本地视频的时长、分辨率与编码；不持久化。
#[tauri::command]
async fn media_probe_local(path: String) -> Result<MediaInfo, String> {
    tauri::async_runtime::spawn_blocking(move || media_info::probe_local_file(&path))
        .await
        .map_err(|error| format!("媒体探测线程异常终止：{error}"))?
}

/// 读取已刮削的媒体信息；未刮削过返回 null。
#[tauri::command]
async fn media_info_get(
    provider: String,
    file_id: String,
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<Option<MediaInfo>, String> {
    let repository = Arc::clone(repository.inner());
    tauri::async_runtime::spawn_blocking(move || repository.media_info(&provider, &file_id))
        .await
        .map_err(|error| format!("读取媒体信息线程异常终止：{error}"))?
}

/// 扫描本地目录，将视频文件和待刮削任务写入 SQLite。
#[tauri::command]
async fn scan_local_directory(
    path: String,
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<LibraryTask, String> {
    let repository = Arc::clone(repository.inner());
    tauri::async_runtime::spawn_blocking(move || repository.scan_local_directory(&path))
        .await
        .map_err(|error| format!("目录扫描线程异常终止：{error}"))?
}

/// 读取 115 视频保存在本机的播放位置。
#[tauri::command]
fn cloud115_playback_progress(
    file_id: String,
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<Option<PlaybackProgress>, String> {
    repository.playback_progress(&file_id)
}

/// 持久化 115 视频播放位置，供下次打开时续播。
#[tauri::command]
fn cloud115_save_playback_progress(
    file_id: String,
    position_seconds: f64,
    duration_seconds: f64,
    repository: State<'_, Arc<LibraryRepository>>,
) -> Result<(), String> {
    repository.save_playback_progress(&file_id, position_seconds, duration_seconds)
}

/// 创建或复用不含 WebView 的原生视频窗口。
///
/// 该窗口只提供 AppKit 绘制表面；控制界面仍由主 WebView 承载，避免两个渲染体系
/// 争用同一个 NSView。
fn ensure_video_window(app: &AppHandle) -> Result<Window, String> {
    if let Some(window) = app.get_window(VIDEO_WINDOW_LABEL) {
        return Ok(window);
    }

    WindowBuilder::new(app, VIDEO_WINDOW_LABEL)
        .title("Sirius Player")
        .inner_size(960.0, 540.0)
        .min_inner_size(640.0, 360.0)
        .background_color(tauri::window::Color(0, 0, 0, 255))
        .resizable(true)
        // POC 阶段统一由控制窗口关闭会话，避免用户直接销毁仍被 CGL 持有的窗口。
        .closable(false)
        .visible(false)
        .build()
        .map_err(|error| format!("创建播放器窗口失败：{error}"))
}

/// 打开本地媒体并创建或复用唯一的 libmpv 播放会话。
#[tauri::command]
async fn open_local_file(
    path: String,
    app: AppHandle,
    manager: State<'_, Arc<PlaybackManager>>,
) -> Result<PlaybackSnapshot, String> {
    let video_window = ensure_video_window(&app)?;
    let manager = Arc::clone(manager.inner());
    let snapshot =
        tauri::async_runtime::spawn_blocking(move || manager.open_local_file(&path, video_window))
            .await
            .map_err(|error| format!("播放工作线程异常终止：{error}"))??;

    let window = app
        .get_window(VIDEO_WINDOW_LABEL)
        .ok_or_else(|| "播放器窗口在初始化后意外丢失".to_string())?;
    window
        .show()
        .map_err(|error| format!("显示播放器窗口失败：{error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("聚焦播放器窗口失败：{error}"))?;
    Ok(snapshot)
}

/// 打开由 Cloud115Provider 解析出的 HTTPS 直链。
///
/// `audio_only` 为 true 时只初始化播放会话、**不显示播放器窗口**：libmpv 的 GL 渲染
/// 上下文必须绑定窗口才能创建，因此窗口仍需存在，但音频没有画面，弹出黑窗口是错误
/// 交互。窗口保持隐藏，由前端底部音频播放条承载控制。
#[tauri::command]
async fn open_remote_url(
    url: String,
    user_agent: String,
    subtitle_urls: Vec<String>,
    pick_code: String,
    audio_only: bool,
    app: AppHandle,
    manager: State<'_, Arc<PlaybackManager>>,
) -> Result<PlaybackSnapshot, String> {
    let video_window = ensure_video_window(&app)?;
    let manager = Arc::clone(manager.inner());
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        manager.open_remote_url(&url, &user_agent, subtitle_urls, &pick_code, video_window)
    })
    .await
    .map_err(|error| format!("远程播放工作线程异常终止：{error}"))??;

    // 音频没有画面：窗口保持隐藏即可，不抢焦点也不打断用户当前操作。
    if audio_only {
        return Ok(snapshot);
    }

    let window = app
        .get_window(VIDEO_WINDOW_LABEL)
        .ok_or_else(|| "播放器窗口在初始化后意外丢失".to_string())?;
    window
        .show()
        .map_err(|error| format!("显示播放器窗口失败：{error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("聚焦播放器窗口失败：{error}"))?;
    Ok(snapshot)
}

/// 切换播放/暂停。
#[tauri::command]
async fn toggle_pause(
    manager: State<'_, Arc<PlaybackManager>>,
) -> Result<PlaybackSnapshot, String> {
    let manager = Arc::clone(manager.inner());
    tauri::async_runtime::spawn_blocking(move || manager.toggle_pause())
        .await
        .map_err(|error| format!("播放工作线程异常终止：{error}"))?
}

/// 跳转到指定秒数。
#[tauri::command]
async fn seek(
    seconds: f64,
    manager: State<'_, Arc<PlaybackManager>>,
) -> Result<PlaybackSnapshot, String> {
    let manager = Arc::clone(manager.inner());
    tauri::async_runtime::spawn_blocking(move || manager.seek(seconds))
        .await
        .map_err(|error| format!("播放工作线程异常终止：{error}"))?
}

/// 设置 0–100 范围内的播放音量。
#[tauri::command]
async fn set_volume(
    volume: f64,
    manager: State<'_, Arc<PlaybackManager>>,
) -> Result<PlaybackSnapshot, String> {
    let manager = Arc::clone(manager.inner());
    tauri::async_runtime::spawn_blocking(move || manager.set_volume(volume))
        .await
        .map_err(|error| format!("播放工作线程异常终止：{error}"))?
}

/// 获取播放器状态，供前端低频轮询。
#[tauri::command]
async fn playback_snapshot(
    manager: State<'_, Arc<PlaybackManager>>,
) -> Result<PlaybackSnapshot, String> {
    let manager = Arc::clone(manager.inner());
    tauri::async_runtime::spawn_blocking(move || manager.snapshot())
        .await
        .map_err(|error| format!("播放状态工作线程异常终止：{error}"))?
}

/// 显式销毁播放会话并释放 libmpv 资源。
#[tauri::command]
async fn destroy_playback(
    app: AppHandle,
    manager: State<'_, Arc<PlaybackManager>>,
) -> Result<(), String> {
    let manager = Arc::clone(manager.inner());
    let destroy_result = tauri::async_runtime::spawn_blocking(move || manager.destroy())
        .await
        .map_err(|error| format!("播放工作线程异常终止：{error}"))?;

    let window_result = if let Some(window) = app.get_window(VIDEO_WINDOW_LABEL) {
        window
            .close()
            .map_err(|error| format!("关闭播放器窗口失败：{error}"))
    } else {
        Ok(())
    };

    match (destroy_result, window_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(destroy_error), Err(window_error)) => Err(format!("{destroy_error}；{window_error}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(PlaybackManager::default()))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let cloud115 = Arc::new(
                Cloud115Provider::new()
                    .map_err(|error| format!("初始化 115 Provider 失败：{error}"))?,
            );
            app.manage(Arc::clone(&cloud115));
            // 注入远程播放源恢复解析器：115 流错误（URL 过期等）时重新解析并续播。
            let resolver: RemoteSourceResolver = {
                let provider = Arc::clone(&cloud115);
                Arc::new(move |pick_code: &str| {
                    tauri::async_runtime::block_on(async {
                        let source = provider.playback_source(pick_code).await?;
                        Ok::<_, String>((source.url, source.user_agent))
                    })
                })
            };
            app.state::<Arc<PlaybackManager>>().set_recovery(resolver);
            let database_path = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("解析 Sirius 数据目录失败：{error}"))?
                .join("sirius.sqlite3");
            let repository = LibraryRepository::open(&database_path)
                .map_err(|error| format!("初始化 Sirius 媒体库失败：{error}"))?;
            app.manage(Arc::new(repository));
            // AI 对话流的停止令牌登记表：支撑 ai_chat_stop 跨命令中断与并发发送互斥。
            app.manage(Arc::new(ChatStreamRegistry::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cloud115_client_apps,
            cloud115_account_status,
            cloud115_begin_auth,
            cloud115_poll_auth,
            cloud115_sign_out,
            cloud115_user_profile,
            cloud115_list_files,
            cloud115_list_starred_files,
            cloud115_playback_source,
            cloud115_video_subtitles,
            cloud115_download_source,
            cloud115_download_file,
            cloud115_file_metadata,
            cloud115_create_folder,
            cloud115_update_file,
            cloud115_move_files,
            cloud115_copy_files,
            cloud115_upload_file,
            cloud115_upload_sessions,
            cloud115_resume_upload,
            cloud115_delete_files,
            cloud115_list_recycle_bin,
            cloud115_restore_recycle_items,
            cloud115_delete_recycle_items,
            library_list,
            library_search,
            library_tasks,
            app_settings,
            update_app_settings,
            scan_local_directory,
            cloud115_playback_progress,
            cloud115_save_playback_progress,
            ai_provider_settings,
            ai_update_provider,
            ai_analyze_folder,
            ai_execute_plan,
            ai_chat_create,
            ai_chat_send,
            ai_chat_stop,
            ai_chat_sessions_list,
            ai_chat_history,
            ai_chat_delete,
            comics_recognize,
            comics_index,
            comics_index_folders,
            comics_open_volume,
            comics_save_progress,
            albums_recognize,
            albums_index,
            albums_index_folders,
            albums_remove_index,
            media_scrape_115,
            media_probe_local,
            media_info_get,
            open_local_file,
            open_remote_url,
            toggle_pause,
            seek,
            set_volume,
            playback_snapshot,
            destroy_playback
        ])
        .run(tauri::generate_context!())
        .expect("Sirius 播放 POC 启动失败");
}
