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
use tauri::Window;

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
    /// 远程播放自动恢复失败后的显式错误；恢复成功时清空。
    pub error: Option<String>,
}

/// 渲染线程可以执行的播放器命令。
///
/// 每个业务命令都附带一次性响应通道，调用方因此能拿到 libmpv 的权威结果，
struct RemoteSession {
    pick_code: String,
    last_position: Option<f64>,
    recoveries: u32,
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
    /// - `window`: 不含 WebView 的 Tauri 原生视频窗口。
    pub fn open_local_file(&self, path: &str, window: Window) -> Result<PlaybackSnapshot, String> {
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
            reply,
        })
    }

    /// 打开经过 Provider 校验的 HTTP(S) 远程媒体地址。
    pub fn open_remote_url(
        &self,
        url: &str,
        user_agent: &str,
        subtitle_urls: Vec<String>,
        pick_code: &str,
        window: Window,
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
        let worker = self
            .lock_worker()?
            .take()
            .ok_or_else(|| "播放会话尚未初始化，请先选择视频文件".to_string())?;
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
        combine_shutdown_results(request_result, join_result)
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
    window: Window,
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
    window: Window,
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

    // SAFETY: Tauri Window 由本线程持有，原生 display/window 句柄在整个渲染循环中有效。
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
        .inner_size()
        .map_err(|error| format!("读取播放器窗口尺寸失败：{error}"))?;
    let width = non_zero_dimension(size.width, "宽度")?;
    let height = non_zero_dimension(size.height, "高度")?;
    let surface_attributes =
        SurfaceAttributesBuilder::<WindowSurface>::new().build(raw_window, width, height);
    // SAFETY: raw_window 来自仍存活的 Tauri Window，尺寸均为非零物理像素。
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
                reply,
            }) => {
                let result = (|| {
                    if let Some(value) = user_agent {
                        mpv.set_property("user-agent", value)
                            .map_err(|error| format!("设置远程播放 User-Agent 失败：{error}"))?;
                    }
                    mpv.command("loadfile", &[&next_source, "replace"])
                        .map_err(|error| format!("libmpv 无法加载所选文件：{error}"))?;
                    source = Some(next_source);
                    // 只有 115 远程会话记录 pick_code，供流错误时重新解析播放源。
                    remote = pick_code.map(|pick_code| RemoteSession {
                        pick_code,
                        last_position: None,
                        recoveries: 0,
                    });
                    last_error = None;

                    let opened = (|| {
                        // 第一条字幕由 mpv 自动选中，其余轨道继续追加供播放器切换。
                        for (index, subtitle_url) in subtitle_urls.iter().enumerate() {
                            let selection = if index == 0 { "select" } else { "auto" };
                            mpv.command("sub-add", &[subtitle_url, selection])
                                .map_err(|error| format!("libmpv 无法加载远程字幕：{error}"))?;
                        }
                        snapshot_from_mpv(&mpv, source.as_deref(), last_error.as_deref())
                    })();

                    match opened {
                        Ok(snapshot) => Ok(snapshot),
                        Err(open_error) => {
                            // loadfile 已成功时，后续任何失败都必须停止新媒体并清空状态，
                            // 避免前端收到错误后仍有隐藏音频或不可控会话继续运行。
                            let stop_result = mpv.command("stop", &[]).map_err(|error| {
                                format!("回滚失败播放会话时无法停止媒体：{error}")
                            });
                            source = None;
                            remote = None;
                            match stop_result {
                                Ok(()) => Err(open_error),
                                Err(stop_error) => Err(format!("{open_error}；{stop_error}")),
                            }
                        }
                    }
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
                                    mpv.command("loadfile", &[&url, "replace"]).map_err(
                                        |error| format!("libmpv 重新加载播放源失败：{error}"),
                                    )?;
                                    if let Some(position) = state.last_position {
                                        mpv.set_property("time-pos", position).map_err(
                                            |error| format!("恢复播放位置失败：{error}"),
                                        )?;
                                    }
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
    window: &Window,
    surface: &glutin::surface::Surface<WindowSurface>,
    context: &glutin::context::PossiblyCurrentContext,
    render_context: &libmpv2::render::RenderContext<'_>,
) -> Result<(), String> {
    let size = window
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
        error: error.map(str::to_string),
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
    use super::{combine_shutdown_results, recovery_allowed, validate_local_media_path};

    #[test]
    fn recovery_policy_limits_remote_sessions_only() {
        // 本地文件流错误不属于远程恢复的适用范围。
        assert!(!recovery_allowed(None));
        let mut state = RemoteSession {
            pick_code: "pick".to_string(),
            last_position: None,
            recoveries: 0,
        };
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
}
