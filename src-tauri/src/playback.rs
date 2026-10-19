use crate::player_window::VideoWindow;
use glutin::{
    config::{ConfigTemplateBuilder, GlConfig},
    context::{ContextApi, ContextAttributesBuilder, NotCurrentGlContext, Version},
    display::{Display, DisplayApiPreference, GetGlDisplay, GlDisplay},
    prelude::GlSurface,
    surface::{SurfaceAttributesBuilder, SwapInterval, WindowSurface},
};
use libmpv2::{
    events::Event,
    mpv_end_file_reason, mpv_error,
    render::{OpenGLInitParams, RenderParam, RenderParamApiType},
    Error as MpvError, Mpv,
};
use raw_window_handle::{HasDisplayHandle, HasWindowHandle};
use serde::Serialize;
use std::{
    ffi::{c_void, CString},
    num::NonZeroU32,
    path::{Path, PathBuf},
    sync::{
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const RENDER_TICK: Duration = Duration::from_millis(16);

/// 前端可读取的播放会话快照。
///
/// `position_seconds` 与 `duration_seconds` 在媒体仍在加载时允许为空；
/// 其他 libmpv 错误会原样上抛，避免把真实播放故障伪装成默认值。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSnapshot {
    pub initialized: bool,
    pub source: Option<String>,
    pub paused: bool,
    pub position_seconds: Option<f64>,
    pub duration_seconds: Option<f64>,
    pub volume: f64,
    /// 远程播放自动恢复失败等会中断播放的显式错误；恢复成功时清空。
    pub error: Option<String>,
    /// 不影响视频播放的提示，例如外挂字幕挂载失败。
    pub warning: Option<String>,
}

/// 渲染线程可以执行的播放器命令。
///
/// 每个业务命令都附带一次性响应通道，调用方因此能拿到 libmpv 的权威结果，
struct RemoteSession {
    pick_code: String,
    last_position: Option<f64>,
    recoveries: u32,
    /// 本次会话待挂载的外挂字幕地址；自动恢复重新 loadfile 后必须重新挂载，
    /// 否则 `replace` 会随旧条目丢弃字幕轨，用户侧表现为「播到一半字幕消失」。
    ///
    /// 在渲染线程事件循环内维护：媒体未 ready 时 `sub-add` 会直接返回
    /// `MPV_ERROR_COMMAND`，因此 Open 只登记地址，等到媒体加载完成事件后再挂。
    subtitle_urls: Vec<String>,
    /// 已进入挂载流程的字幕条数；用于跨事件幂等推进，避免重复挂载同一条。
    subtitles_mounted: usize,
}

/// 远程会话自动恢复上限；超过后停止重试并把错误呈报给前端。
const MAX_REMOTE_RECOVERIES: u32 = 3;

/// 恢复策略：仅远程会话在重试上限内允许自动恢复；本地文件流错误不适用。
fn recovery_allowed(remote: Option<&RemoteSession>) -> bool {
    match remote {
        Some(state) => state.recoveries < MAX_REMOTE_RECOVERIES,
        None => false,
    }
}

/// 把会话登记的远程字幕挂到当前媒体上；无待挂字幕时立即返回。
///
/// `loadfile` 与 `sub-add` 在同一同步区间连续调用时后者必然失败：libmpv 的
/// `sub-add` 只在媒体进入 ready 状态（收到 FileLoaded / PlaybackRestart）后才会
/// 被接受，booting 阶段一律返回 `MPV_ERROR_COMMAND`。因此挂载必须在事件循环内
/// 由这两个事件触发，而不是塞进 Open 的同步路径。
///
/// 失败语义：单条字幕加载失败（URL 过期、404、格式不支持）只写提示性 error，
/// 绝不中断播放会话——视频可以没有字幕播放，不能反过来。
fn mount_pending_subtitles(
    mpv: &Mpv,
    remote: Option<&mut RemoteSession>,
    last_error: &mut Option<String>,
) {
    let Some(state) = remote else {
        return;
    };
    let plan = plan_subtitle_mounts(state);
    if plan.is_empty() {
        return;
    }
    let mut failures: Vec<String> = Vec::new();
    for (index, selection) in plan {
        let subtitle_url = &state.subtitle_urls[index];
        if let Err(error) = mpv.command("sub-add", &[subtitle_url, selection]) {
            // 单条失败给出序号便于用户对照字幕列表；多条时序号更能定位问题轨。
            failures.push(format!("第 {} 条：{error}", index + 1));
        }
    }
    // 无论成败都推进到末尾：失败 URL 不会因为事件重放而变成可用，重复重试只刷屏；
    // FileLoaded 与 PlaybackRestart 都可能多次触发，进度必须幂等。
    state.subtitles_mounted = state.subtitle_urls.len();
    if failures.is_empty() {
        // 本次字幕全部就位：清掉此前的字幕提示，不碰播放中断错误。
        if last_error
            .as_deref()
            .is_some_and(|message| message.starts_with(SUBTITLE_ERROR_PREFIX))
        {
            *last_error = None;
        }
    } else {
        *last_error = Some(format!("{SUBTITLE_ERROR_PREFIX}{}", failures.join("；")));
    }
}

/// 计算下一次挂载动作：返回 (索引, 选择模式)。第一条字幕 select，其余 auto。
///
/// 纯函数，供单测覆盖：调用方拿到计划后执行 mpv 命令，并必须把
/// `subtitles_mounted` 推进到 `subtitle_urls.len()`，否则每次
/// FileLoaded/PlaybackRestart 都会重复尝试同一条失败 URL。
fn plan_subtitle_mounts(state: &RemoteSession) -> Vec<(usize, &'static str)> {
    (state.subtitles_mounted..state.subtitle_urls.len())
        .map(|index| {
            let selection = if index == 0 { "select" } else { "auto" };
            (index, selection)
        })
        .collect()
}

/// 字幕类提示前缀；用于区分非致命提示与播放中断错误，两者不能互相覆盖。
const SUBTITLE_ERROR_PREFIX: &str = "字幕加载失败：";

/// 由 lib.rs 注入的远程源恢复解析器：把 pick_code 重新解析为 (url, user_agent)。
pub type RemoteSourceResolver = Arc<dyn Fn(&str) -> Result<(String, String), String> + Send + Sync>;

/// 渲染线程可以执行的播放器命令。
///
/// 每个业务命令都附带一次性响应通道，调用方因此能拿到 libmpv 的权威结果，
/// 而不是提前假设命令已经成功。
enum PlaybackRequest {
    Open {
        source: String,
        user_agent: Option<String>,
        subtitle_urls: Vec<String>,
        pick_code: Option<String>,
        start_position_seconds: Option<f64>,
        reply: SyncSender<Result<PlaybackSnapshot, String>>,
    },
    TogglePause {
        reply: SyncSender<Result<PlaybackSnapshot, String>>,
    },
    Seek {
        seconds: f64,
        reply: SyncSender<Result<PlaybackSnapshot, String>>,
    },
    SetVolume {
        volume: f64,
        reply: SyncSender<Result<PlaybackSnapshot, String>>,
    },
    Snapshot {
        reply: SyncSender<Result<PlaybackSnapshot, String>>,
    },
    Shutdown {
        reply: SyncSender<Result<(), String>>,
    },
    Redraw,
}

/// 正在运行的专用渲染线程。
struct PlaybackWorker {
    sender: SyncSender<PlaybackRequest>,
    join_handle: JoinHandle<()>,
}

/// 应用级唯一播放管理器。
///
/// libmpv、CGL/OpenGL context 和 RenderContext 都只存在于同一个工作线程；
/// Tauri 命令仅通过通道通信，从根源上避免跨线程使用图形上下文。
#[derive(Default)]
pub struct PlaybackManager {
    worker: Mutex<Option<PlaybackWorker>>,
    recovery: Mutex<Option<RemoteSourceResolver>>,
}

impl PlaybackManager {
    /// 注入远程源恢复解析器；仅 115 远程会话在流错误时使用。
    pub fn set_recovery(&self, resolver: RemoteSourceResolver) {
        // 注入只发生在启动阶段，此时工作线程尚未创建，锁不可能损坏。
        if let Ok(mut guard) = self.recovery.lock() {
            *guard = Some(resolver);
        }
    }

    /// 打开本地视频，并在首次调用时启动专用渲染线程。
    ///
    /// # 参数
    /// - `path`: 文件选择器返回的绝对本地路径。
    /// - `window`: Tauri 宿主窗口与其独立原生视频 NSView 组成的表面句柄。
    pub fn open_local_file(
        &self,
        path: &str,
        window: VideoWindow,
    ) -> Result<PlaybackSnapshot, String> {
        let canonical_path = validate_local_media_path(path)?;
        let source = canonical_path.to_string_lossy().into_owned();
        let mut guard = self.lock_worker()?;

        if guard.is_none() {
            *guard = Some(spawn_playback_worker(window, None)?);
        }

        let worker = guard
            .as_ref()
            .ok_or_else(|| "播放渲染线程初始化后意外丢失".to_string())?;
        request_snapshot(&worker.sender, |reply| PlaybackRequest::Open {
            source,
            user_agent: None,
            subtitle_urls: Vec::new(),
            pick_code: None,
            start_position_seconds: None,
            reply,
        })
    }

    /// 打开经过 Provider 校验的 HTTP(S) 远程媒体地址，并在媒体加载时恢复可选位置。
    ///
    /// # 参数
    /// - `start_position_seconds`: 起播位置（秒）；`None` 表示从默认位置开始。
    /// - 其余参数分别是媒体 URL、请求 User-Agent、字幕 URL、115 `pick_code` 与原生窗口句柄。
    ///
    /// # 返回
    /// 返回 libmpv 当前会话快照；参数无效或播放初始化失败时返回错误。
    pub fn open_remote_url(
        &self,
        url: &str,
        user_agent: &str,
        subtitle_urls: Vec<String>,
        pick_code: &str,
        start_position_seconds: Option<f64>,
        window: VideoWindow,
    ) -> Result<PlaybackSnapshot, String> {
        // 115 的转码 HLS 目前可能签发 http URL；仍严格拒绝文件路径和其它自定义协议。
        if !(url.starts_with("https://") || url.starts_with("http://"))
            || user_agent.trim().is_empty()
        {
            return Err("远程播放源必须是 HTTP(S) 地址并提供 User-Agent".to_string());
        }
        if pick_code.trim().is_empty() {
            return Err("远程播放必须提供 pick_code 才能在 URL 过期时自动恢复".to_string());
        }
        if subtitle_urls.iter().any(|url| !is_http_url(url)) {
            return Err("远程字幕必须使用 HTTP(S) 地址".to_string());
        }
        // 在窗口/worker 创建之前验证 Tauri 输入，避免无效位置留下隐藏播放器窗口。
        loadfile_command_arguments(start_position_seconds)?;
        let mut guard = self.lock_worker()?;
        if guard.is_none() {
            let recovery = self.recovery.lock().ok().and_then(|guard| guard.clone());
            *guard = Some(spawn_playback_worker(window, recovery)?);
        }
        let worker = guard
            .as_ref()
            .ok_or_else(|| "播放渲染线程初始化后意外丢失".to_string())?;
        request_snapshot(&worker.sender, |reply| PlaybackRequest::Open {
            source: url.to_string(),
            user_agent: Some(user_agent.to_string()),
            subtitle_urls,
            pick_code: Some(pick_code.to_string()),
            start_position_seconds,
            reply,
        })
    }

    /// 切换暂停状态并返回更新后的会话快照。
    pub fn toggle_pause(&self) -> Result<PlaybackSnapshot, String> {
        self.with_worker(|sender| {
            request_snapshot(sender, |reply| PlaybackRequest::TogglePause { reply })
        })
    }

    /// 跳转到绝对时间点。
    pub fn seek(&self, seconds: f64) -> Result<PlaybackSnapshot, String> {
        if !seconds.is_finite() || seconds < 0.0 {
            return Err("播放位置必须是有限且非负的秒数".to_string());
        }
        self.with_worker(|sender| {
            request_snapshot(sender, |reply| PlaybackRequest::Seek { seconds, reply })
        })
    }

    /// 设置 0 到 100 之间的音量。
    pub fn set_volume(&self, volume: f64) -> Result<PlaybackSnapshot, String> {
        if !volume.is_finite() || !(0.0..=100.0).contains(&volume) {
            return Err("音量必须位于 0 到 100 之间".to_string());
        }
        self.with_worker(|sender| {
            request_snapshot(sender, |reply| PlaybackRequest::SetVolume { volume, reply })
        })
    }

    /// 获取当前播放状态。
    pub fn snapshot(&self) -> Result<PlaybackSnapshot, String> {
        let guard = self.lock_worker()?;
        let Some(worker) = guard.as_ref() else {
            return Ok(idle_snapshot());
        };
        request_snapshot(&worker.sender, |reply| PlaybackRequest::Snapshot { reply })
    }

    /// 终止渲染线程并释放 OpenGL、RenderContext 和 libmpv。
    pub fn destroy(&self) -> Result<(), String> {
        // shutdown 必须在管理锁已损坏时仍取出并 join worker；否则窗口关闭会释放仍被
        // CGL 使用的 NSView。把锁损坏作为结果保留，但先完成能做的资源清理。
        let (worker, lock_error) = match self.worker.lock() {
            Ok(mut guard) => (guard.take(), None),
            Err(poisoned) => (
                poisoned.into_inner().take(),
                Some("播放管理器锁已损坏，关闭时已尝试回收渲染线程".to_string()),
            ),
        };
        let Some(worker) = worker else {
            return lock_error.map_or(Ok(()), Err);
        };
        let (reply_sender, reply_receiver) = mpsc::sync_channel(1);
        let request_result = worker
            .sender
            .send(PlaybackRequest::Shutdown {
                reply: reply_sender,
            })
            .map_err(|_| "播放渲染线程已提前退出".to_string())
            .and_then(|()| {
                reply_receiver
                    .recv_timeout(COMMAND_TIMEOUT)
                    .map_err(|_| "等待播放渲染线程关闭超时".to_string())?
            });
        let join_result = worker
            .join_handle
            .join()
            .map_err(|_| "播放渲染线程在关闭时发生 panic".to_string());
        let mut result = combine_shutdown_results(request_result, join_result);
        if let Some(lock_error) = lock_error {
            result = match result {
                Ok(()) => Err(lock_error),
                Err(error) => Err(format!("{lock_error}；{error}")),
            };
        }
        result
    }

    fn with_worker<T>(
        &self,
        operation: impl FnOnce(&SyncSender<PlaybackRequest>) -> Result<T, String>,
    ) -> Result<T, String> {
        let guard = self.lock_worker()?;
        let worker = guard
            .as_ref()
            .ok_or_else(|| "播放会话尚未初始化，请先选择视频文件".to_string())?;
        operation(&worker.sender)
    }

    fn lock_worker(&self) -> Result<std::sync::MutexGuard<'_, Option<PlaybackWorker>>, String> {
        self.worker
            .lock()
            .map_err(|_| "播放管理器锁已损坏，必须重启应用".to_string())
    }
}

/// 创建工作线程，并等待图形环境完成初始化。
fn spawn_playback_worker(
    window: VideoWindow,
    recovery: Option<RemoteSourceResolver>,
) -> Result<PlaybackWorker, String> {
    let (sender, receiver) = mpsc::sync_channel(64);
    let redraw_sender = sender.clone();
    let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
    let join_handle = thread::Builder::new()
        .name("sirius-mpv-render".to_string())
        .spawn(move || {
            let result = run_render_thread(window, receiver, redraw_sender, ready_sender, recovery);
            if let Err(error) = result {
                eprintln!("Sirius 播放渲染线程退出：{error}");
            }
        })
        .map_err(|error| format!("创建播放渲染线程失败：{error}"))?;

    match ready_receiver.recv_timeout(COMMAND_TIMEOUT) {
        Ok(Ok(())) => Ok(PlaybackWorker {
            sender,
            join_handle,
        }),
        Ok(Err(error)) => {
            join_handle
                .join()
                .map_err(|_| "渲染线程初始化失败后发生 panic".to_string())?;
            Err(error)
        }
        Err(_) => Err("等待播放渲染线程初始化超时".to_string()),
    }
}

/// 渲染线程主循环。
///
/// 初始化顺序必须保持为：CGL display → surface/context → libmpv →
/// RenderContext。销毁时 Rust 的逆序 drop 会先释放 RenderContext，再释放 mpv。
fn run_render_thread(
    window: VideoWindow,
    receiver: Receiver<PlaybackRequest>,
    redraw_sender: SyncSender<PlaybackRequest>,
    ready_sender: SyncSender<Result<(), String>>,
    recovery: Option<RemoteSourceResolver>,
) -> Result<(), String> {
    let raw_display = window
        .display_handle()
        .map_err(|error| format!("读取 macOS 显示句柄失败：{error}"))?
        .as_raw();
    let raw_window = window
        .window_handle()
        .map_err(|error| format!("读取 macOS 窗口句柄失败：{error}"))?
        .as_raw();

    // SAFETY: VideoWindow 由本线程持有，其宿主窗口与原生视频 NSView 在整个渲染循环中有效。
    let display = unsafe { Display::new(raw_display, DisplayApiPreference::Cgl) }
        .map_err(|error| format!("创建 CGL display 失败：{error}"))?;
    let template = ConfigTemplateBuilder::new()
        .with_alpha_size(8)
        .with_depth_size(0)
        .build();
    // SAFETY: template 中的窗口句柄为空，配置查询只读取有效的 CGL display。
    let config = unsafe { display.find_configs(template) }
        .map_err(|error| format!("查询 OpenGL 配置失败：{error}"))?
        .max_by_key(|config| config.num_samples())
        .ok_or_else(|| "系统没有可用的 OpenGL 配置".to_string())?;

    let size = window
        .window()
        .inner_size()
        .map_err(|error| format!("读取播放器窗口尺寸失败：{error}"))?;
    let width = non_zero_dimension(size.width, "宽度")?;
    let height = non_zero_dimension(size.height, "高度")?;
    let surface_attributes =
        SurfaceAttributesBuilder::<WindowSurface>::new().build(raw_window, width, height);
    // SAFETY: raw_window 指向 VideoWindow 持有的原生视频 NSView，尺寸均为非零物理像素。
    let surface = unsafe { display.create_window_surface(&config, &surface_attributes) }
        .map_err(|error| format!("创建 OpenGL 窗口表面失败：{error}"))?;
    let context_attributes = ContextAttributesBuilder::new()
        .with_context_api(ContextApi::OpenGl(Some(Version::new(3, 2))))
        .build(Some(raw_window));
    // SAFETY: context 与 surface 使用同一 display、config 和有效窗口句柄。
    let context = unsafe { display.create_context(&config, &context_attributes) }
        .map_err(|error| format!("创建 OpenGL context 失败：{error}"))?
        .make_current(&surface)
        .map_err(|error| format!("激活 OpenGL context 失败：{error}"))?;
    surface
        .set_swap_interval(
            &context,
            SwapInterval::Wait(non_zero_dimension(1, "交换间隔")?),
        )
        .map_err(|error| format!("设置垂直同步失败：{error}"))?;

    let mpv = Mpv::with_initializer(|initializer| {
        initializer.set_property("vo", "libmpv")?;
        initializer.set_property("hwdec", "auto-safe")?;
        initializer.set_property("keep-open", true)?;
        Ok(())
    })
    .map_err(|error| format!("初始化 libmpv 失败：{error}"))?;
    let mut render_context = mpv
        .create_render_context(vec![
            RenderParam::ApiType(RenderParamApiType::OpenGl),
            RenderParam::InitParams(OpenGLInitParams {
                get_proc_address,
                ctx: GlProcLoader {
                    display: config.display(),
                },
            }),
        ])
        .map_err(|error| format!("创建 mpv RenderContext 失败：{error}"))?;
    render_context.set_update_callback(move || {
        // 回调来自 libmpv 内部线程，只负责发信号，绝不直接调用 mpv 或 OpenGL。
        let _ = redraw_sender.try_send(PlaybackRequest::Redraw);
    });
    ready_sender
        .send(Ok(()))
        .map_err(|_| "渲染线程初始化结果无人接收".to_string())?;

    let mut source: Option<String> = None;
    let mut remote: Option<RemoteSession> = None;
    let mut last_error: Option<String> = None;
    loop {
        match receiver.recv_timeout(RENDER_TICK) {
            Ok(PlaybackRequest::Open {
                source: next_source,
                user_agent,
                subtitle_urls,
                pick_code,
                start_position_seconds,
                reply,
            }) => {
                let result = (|| {
                    if let Some(value) = user_agent {
                        mpv.set_property("user-agent", value)
                            .map_err(|error| format!("设置远程播放 User-Agent 失败：{error}"))?;
                    }
                    loadfile_with_start(
                        &mpv,
                        &next_source,
                        start_position_seconds,
                        "libmpv 无法加载所选文件：",
                    )?;
                    source = Some(next_source);
                    // 只有 115 远程会话记录 pick_code，供流错误时重新解析播放源。
                    // 字幕地址一并登记：媒体 ready 后由事件循环统一挂载，
                    // 自动恢复重新 loadfile 时也能重新走一遍挂载流程。
                    remote = pick_code.map(|pick_code| RemoteSession {
                        pick_code,
                        last_position: start_position_seconds,
                        recoveries: 0,
                        subtitle_urls,
                        subtitles_mounted: 0,
                    });
                    last_error = None;

                    // loadfile 成功即代表媒体已接管会话；字幕挂载挪到事件循环，
                    // 见 mount_pending_subtitles 的说明。快照按当前 mpv 状态如实返回。
                    snapshot_from_mpv(&mpv, source.as_deref(), last_error.as_deref())
                })();
                let _ = reply.send(result);
            }
            Ok(PlaybackRequest::TogglePause { reply }) => {
                let result = toggle_pause(&mpv).and_then(|()| {
                    snapshot_from_mpv(&mpv, source.as_deref(), last_error.as_deref())
                });
                let _ = reply.send(result);
            }
            Ok(PlaybackRequest::Seek { seconds, reply }) => {
                let result = mpv
                    .set_property("time-pos", seconds)
                    .map_err(|error| format!("跳转播放位置失败：{error}"))
                    .and_then(|()| {
                        snapshot_from_mpv(&mpv, source.as_deref(), last_error.as_deref())
                    });
                if let Some(state) = remote.as_mut() {
                    state.last_position = Some(seconds);
                }
                let _ = reply.send(result);
            }
            Ok(PlaybackRequest::SetVolume { volume, reply }) => {
                let result = mpv
                    .set_property("volume", volume)
                    .map_err(|error| format!("设置音量失败：{error}"))
                    .and_then(|()| {
                        snapshot_from_mpv(&mpv, source.as_deref(), last_error.as_deref())
                    });
                let _ = reply.send(result);
            }
            Ok(PlaybackRequest::Snapshot { reply }) => {
                let result = snapshot_from_mpv(&mpv, source.as_deref(), last_error.as_deref());
                if let Ok(snapshot) = &result {
                    if let (Some(state), Some(position)) =
                        (remote.as_mut(), snapshot.position_seconds)
                    {
                        if position.is_finite() && position > 0.0 {
                            state.last_position = Some(position);
                        }
                    }
                }
                let _ = reply.send(result);
            }
            Ok(PlaybackRequest::Shutdown { reply }) => {
                let _ = reply.send(Ok(()));
                break;
            }
            Ok(PlaybackRequest::Redraw) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }

        // 轮询 libmpv 事件：远程会话遇到流错误（URL 过期等）时自动重建播放源并恢复时间码。
        while let Some(event) = mpv.wait_event(0.0) {
            match event {
                // 媒体加载完成是 sub-add 合法的最早时点：booting 阶段命令会被拒绝。
                // 首条字幕默认选中，其余按 auto 追加供播放器内切换。
                Ok(Event::FileLoaded) | Ok(Event::PlaybackRestart) => {
                    mount_pending_subtitles(&mpv, remote.as_mut(), &mut last_error);
                }
                Ok(Event::EndFile(reason)) if reason == mpv_end_file_reason::Error => {
                    let Some(state) = remote.as_mut() else {
                        continue;
                    };
                    if !recovery_allowed(Some(state)) {
                        if last_error.is_none() {
                            last_error = Some(
                                "远程播放中断，自动恢复次数已达上限；请结束播放后重新打开"
                                    .to_string(),
                            );
                        }
                        continue;
                    }
                    // EndFile 时 time-pos 往往仍可读，先记录最后已知时间码。
                    if let Ok(position) = mpv.get_property::<f64>("time-pos") {
                        if position.is_finite() && position > 0.0 {
                            state.last_position = Some(position);
                        }
                    }
                    let resumed = recovery.as_ref().and_then(|resolver| {
                        resolver(&state.pick_code)
                            .ok()
                            .and_then(|(url, user_agent)| {
                                (|| -> Result<(), String> {
                                    mpv.set_property("user-agent", user_agent).map_err(
                                        |error| format!("设置远程播放 User-Agent 失败：{error}"),
                                    )?;
                                    loadfile_with_start(
                                        &mpv,
                                        &url,
                                        state.last_position,
                                        "libmpv 重新加载播放源失败：",
                                    )?;
                                    // replace 会随旧条目丢弃字幕轨：置零挂载进度，
                                    // 由 FileLoaded/PlaybackRestart 事件重新挂载，
                                    // 否则用户会在恢复瞬间丢失字幕且界面无任何提示。
                                    state.subtitles_mounted = 0;
                                    Ok(())
                                })()
                                .ok()
                            })
                    });
                    match resumed {
                        Some(()) => {
                            state.recoveries += 1;
                            last_error = None;
                        }
                        None => {
                            state.recoveries = MAX_REMOTE_RECOVERIES;
                            last_error = Some(
                                "远程播放中断，自动恢复失败；请结束播放后重新打开".to_string(),
                            );
                        }
                    }
                }
                Ok(_) | Err(_) => {}
            }
        }

        render_frame(&window, &surface, &context, &render_context)?;
    }
    Ok(())
}

/** 仅允许播放器访问标准网络媒体协议，拒绝 file 等可读取本机资源的 URL。 */
fn is_http_url(value: &str) -> bool {
    value.starts_with("https://") || value.starts_with("http://")
}

/// 构造 `loadfile` 的参数，并将可选起播位置作为媒体级 `start` 选项原子设置。
///
/// mpv 0.38 起 `loadfile` 第三个参数用于索引；使用第四个 per-file options 参数时，
/// 必须显式传入 `-1` 作为第三参数。起播位置约束为有限、非负秒数。
///
/// # 参数
/// - `start_position_seconds`: 起播位置秒数；`None` 保持 mpv 默认行为。
///
/// # 返回
/// 返回 `loadfile` 的 flags、index 与 per-file options 参数；非法位置返回错误。
pub(crate) fn loadfile_command_arguments(
    start_position_seconds: Option<f64>,
) -> Result<Vec<String>, String> {
    let mut arguments = vec!["replace".to_string()];
    let Some(seconds) = start_position_seconds else {
        return Ok(arguments);
    };
    if !seconds.is_finite() || seconds < 0.0 {
        return Err("初始播放位置必须是有限且非负的秒数".to_string());
    }

    // mpv 将带负号的 start 解释为从媒体末尾倒数；将 -0.0 规范成普通零。
    let seconds = if seconds == 0.0 { 0.0 } else { seconds };
    let mut start_option = format!("{seconds:.9}");
    while start_option.contains('.') && start_option.ends_with('0') {
        start_option.pop();
    }
    if start_option.ends_with('.') {
        start_option.pop();
    }

    arguments.push("-1".to_string());
    arguments.push(format!("start={start_option}"));
    Ok(arguments)
}

/// 以单条 `loadfile` 命令加载媒体，避免在媒体尚未 ready 时另发 `time-pos` seek。
///
/// # 参数
/// - `mpv`: 当前专用渲染线程中的 libmpv 实例。
/// - `source`: 要加载的本地路径或已校验 HTTP(S) URL。
/// - `start_position_seconds`: 可选非负起播时间。
/// - `error_prefix`: libmpv 命令失败时附加的上下文前缀。
///
/// # 返回
/// 命令成功时返回 `Ok(())`，参数校验或 libmpv 失败时返回错误。
fn loadfile_with_start(
    mpv: &Mpv,
    source: &str,
    start_position_seconds: Option<f64>,
    error_prefix: &str,
) -> Result<(), String> {
    let options = loadfile_command_arguments(start_position_seconds)?;
    let mut arguments = Vec::with_capacity(options.len() + 1);
    arguments.push(source);
    arguments.extend(options.iter().map(String::as_str));
    mpv.command("loadfile", &arguments)
        .map_err(|error| format!("{error_prefix}{error}"))
}

/// 将不影响会话存活的字幕失败与播放错误分开提供给前端。
fn playback_error_fields(error: Option<&str>) -> (Option<String>, Option<String>) {
    match error {
        Some(message) if message.starts_with(SUBTITLE_ERROR_PREFIX) => {
            (None, Some(message.to_string()))
        }
        Some(message) => (Some(message.to_string()), None),
        None => (None, None),
    }
}

/// OpenGL 函数加载器；libmpv 使用它解析当前 CGL display 的符号。
struct GlProcLoader {
    display: Display,
}

fn get_proc_address(loader: &GlProcLoader, name: &str) -> *mut c_void {
    let Ok(name) = CString::new(name) else {
        return std::ptr::null_mut();
    };
    loader.display.get_proc_address(&name) as *mut c_void
}

/// 将最新视频帧绘制到窗口默认 framebuffer 并交换前后缓冲。
fn render_frame(
    window: &VideoWindow,
    surface: &glutin::surface::Surface<WindowSurface>,
    context: &glutin::context::PossiblyCurrentContext,
    render_context: &libmpv2::render::RenderContext<'_>,
) -> Result<(), String> {
    let size = window
        .window()
        .inner_size()
        .map_err(|error| format!("读取播放器窗口尺寸失败：{error}"))?;
    let width = non_zero_dimension(size.width, "宽度")?;
    let height = non_zero_dimension(size.height, "高度")?;
    surface.resize(context, width, height);
    render_context
        .render::<GlProcLoader>(0, size.width as i32, size.height as i32, true)
        .map_err(|error| format!("mpv 提交视频帧失败：{error}"))?;
    surface
        .swap_buffers(context)
        .map_err(|error| format!("交换视频窗口缓冲失败：{error}"))?;
    render_context.report_swap();
    Ok(())
}

fn toggle_pause(mpv: &Mpv) -> Result<(), String> {
    let paused = mpv
        .get_property::<bool>("pause")
        .map_err(|error| format!("读取暂停状态失败：{error}"))?;
    mpv.set_property("pause", !paused)
        .map_err(|error| format!("切换暂停状态失败：{error}"))
}

/// 无论关闭请求是否成功都等待线程退出，并保留两条失败信息。
fn combine_shutdown_results(
    request_result: Result<(), String>,
    join_result: Result<(), String>,
) -> Result<(), String> {
    match (request_result, join_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(request_error), Err(join_error)) => Err(format!("{request_error}；{join_error}")),
    }
}

fn snapshot_from_mpv(
    mpv: &Mpv,
    source: Option<&str>,
    error: Option<&str>,
) -> Result<PlaybackSnapshot, String> {
    let (error, warning) = playback_error_fields(error);
    Ok(PlaybackSnapshot {
        initialized: source.is_some(),
        source: source.map(str::to_string),
        paused: mpv
            .get_property::<bool>("pause")
            .map_err(|error| format!("读取暂停状态失败：{error}"))?,
        position_seconds: optional_property(mpv, "time-pos")?,
        duration_seconds: optional_property(mpv, "duration")?,
        volume: mpv
            .get_property::<f64>("volume")
            .map_err(|error| format!("读取音量失败：{error}"))?,
        error,
        warning,
    })
}

fn idle_snapshot() -> PlaybackSnapshot {
    PlaybackSnapshot {
        initialized: false,
        source: None,
        paused: true,
        position_seconds: None,
        duration_seconds: None,
        volume: 80.0,
        error: None,
        warning: None,
    }
}

fn request_snapshot(
    sender: &SyncSender<PlaybackRequest>,
    request: impl FnOnce(SyncSender<Result<PlaybackSnapshot, String>>) -> PlaybackRequest,
) -> Result<PlaybackSnapshot, String> {
    let (reply_sender, reply_receiver) = mpsc::sync_channel(1);
    sender
        .send(request(reply_sender))
        .map_err(|_| "播放渲染线程已退出".to_string())?;
    reply_receiver
        .recv_timeout(COMMAND_TIMEOUT)
        .map_err(|_| "等待播放命令响应超时".to_string())?
}

fn optional_property(mpv: &Mpv, name: &str) -> Result<Option<f64>, String> {
    match mpv.get_property::<f64>(name) {
        Ok(value) => Ok(Some(value)),
        Err(MpvError::Raw(code)) if code == mpv_error::PropertyUnavailable => Ok(None),
        Err(error) => Err(format!("读取播放属性 {name} 失败：{error}")),
    }
}

fn non_zero_dimension(value: u32, name: &str) -> Result<NonZeroU32, String> {
    NonZeroU32::new(value.max(1)).ok_or_else(|| format!("播放器窗口{name}无效"))
}

/// 校验并规范化文件选择器返回的本地路径。
fn validate_local_media_path(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("未选择视频文件".to_string());
    }

    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        return Err("播放器只接受绝对本地路径".to_string());
    }
    if !candidate.exists() {
        return Err(format!("所选文件不存在：{}", candidate.display()));
    }
    if !candidate.is_file() {
        return Err(format!("所选路径不是文件：{}", candidate.display()));
    }

    candidate
        .canonicalize()
        .map_err(|error| format!("无法解析所选文件路径：{error}"))
}

#[cfg(test)]
mod tests {
    use super::RemoteSession;
    use super::{
        combine_shutdown_results, loadfile_command_arguments, plan_subtitle_mounts,
        playback_error_fields, recovery_allowed, validate_local_media_path,
    };

    #[test]
    fn loadfile_start_option_is_atomic_and_uses_fourth_argument() {
        assert_eq!(loadfile_command_arguments(None).unwrap(), vec!["replace"]);
        assert_eq!(
            loadfile_command_arguments(Some(1222.4)).unwrap(),
            vec!["replace", "-1", "start=1222.4"]
        );
        assert_eq!(
            loadfile_command_arguments(Some(-0.0)).unwrap(),
            vec!["replace", "-1", "start=0"]
        );
    }

    #[test]
    fn loadfile_start_option_rejects_invalid_positions() {
        assert!(loadfile_command_arguments(Some(-0.01)).is_err());
        assert!(loadfile_command_arguments(Some(f64::NAN)).is_err());
        assert!(loadfile_command_arguments(Some(f64::INFINITY)).is_err());
        assert!(loadfile_command_arguments(Some(f64::NEG_INFINITY)).is_err());
    }

    #[test]
    fn subtitle_failure_is_a_warning_not_a_playback_error() {
        assert_eq!(
            playback_error_fields(Some("字幕加载失败：第 1 条：Raw(-12)")),
            (None, Some("字幕加载失败：第 1 条：Raw(-12)".to_string()))
        );
        assert_eq!(
            playback_error_fields(Some("远程播放中断")),
            (Some("远程播放中断".to_string()), None)
        );
        assert_eq!(playback_error_fields(None), (None, None));
    }

    #[test]
    fn recovery_policy_limits_remote_sessions_only() {
        // 本地文件流错误不属于远程恢复的适用范围。
        assert!(!recovery_allowed(None));
        let mut state = local_session();
        assert!(recovery_allowed(Some(&state)));
        // 达到重试上限后停止自动恢复。
        state.recoveries = 3;
        assert!(!recovery_allowed(Some(&state)));
    }

    #[test]
    fn rejects_empty_and_relative_paths() {
        assert!(validate_local_media_path("").is_err());
        assert!(validate_local_media_path("movie.mkv").is_err());
    }

    #[test]
    fn rejects_missing_absolute_paths() {
        assert!(validate_local_media_path("/definitely/missing/sirius-test.mkv").is_err());
    }

    #[test]
    fn shutdown_preserves_request_and_join_failures() {
        assert!(combine_shutdown_results(Ok(()), Ok(())).is_ok());
        assert_eq!(
            combine_shutdown_results(Err("请求失败".into()), Ok(())).unwrap_err(),
            "请求失败"
        );
        assert_eq!(
            combine_shutdown_results(Ok(()), Err("线程失败".into())).unwrap_err(),
            "线程失败"
        );
        assert_eq!(
            combine_shutdown_results(Err("请求失败".into()), Err("线程失败".into())).unwrap_err(),
            "请求失败；线程失败"
        );
    }

    #[test]
    fn subtitle_mount_plan_selects_first_track_only() {
        let state = RemoteSession {
            pick_code: "pick".to_string(),
            last_position: None,
            recoveries: 0,
            subtitle_urls: vec![
                "https://115.com/a.ass?x=1".to_string(),
                "https://115.com/b.srt?x=2".to_string(),
                "https://115.com/c.vtt?x=3".to_string(),
            ],
            subtitles_mounted: 0,
        };
        assert_eq!(
            plan_subtitle_mounts(&state),
            vec![(0, "select"), (1, "auto"), (2, "auto")]
        );
    }

    #[test]
    fn subtitle_mount_plan_is_idempotent_after_progress() {
        // 推进后不再重复挂载同一条：FileLoaded/PlaybackRestart 可能多次触发。
        let mut state = RemoteSession {
            pick_code: "pick".to_string(),
            last_position: None,
            recoveries: 0,
            subtitle_urls: vec!["https://115.com/a.ass?x=1".to_string()],
            subtitles_mounted: 0,
        };
        assert_eq!(plan_subtitle_mounts(&state).len(), 1);
        state.subtitles_mounted = state.subtitle_urls.len();
        assert!(plan_subtitle_mounts(&state).is_empty());
    }

    #[test]
    fn subtitle_mount_plan_empty_without_session() {
        // 本地文件没有远程会话，字幕挂载直接跳过。
        assert!(plan_subtitle_mounts(&local_session()).is_empty());
    }

    fn local_session() -> RemoteSession {
        RemoteSession {
            pick_code: "pick".to_string(),
            last_position: None,
            recoveries: 0,
            subtitle_urls: Vec::new(),
            subtitles_mounted: 0,
        }
    }
}
