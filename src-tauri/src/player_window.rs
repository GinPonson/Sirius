//! 原生视频窗口中的 CGL 表面与透明控制 WebView。

use raw_window_handle::{
    AppKitWindowHandle, HandleError, HasDisplayHandle, HasWindowHandle, RawWindowHandle,
    WindowHandle,
};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Webview, Window, WindowEvent};

pub const VIDEO_WINDOW_LABEL: &str = "video";
pub const VIDEO_CONTROLS_LABEL: &str = "video-controls";

/// 每次窗口实例对应的实际 native `Destroyed` 事件信号。
pub struct WindowDestroyedSignal {
    sender: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    receiver: tokio::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
}

impl WindowDestroyedSignal {
    /// 创建当前窗口实例唯一的销毁完成信号。
    pub(crate) fn new() -> Arc<Self> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        Arc::new(Self {
            sender: Mutex::new(Some(sender)),
            receiver: tokio::sync::Mutex::new(Some(receiver)),
        })
    }

    /// 在 Tauri 发出 `WindowEvent::Destroyed` 后唤醒正在等待的关闭流程。
    pub(crate) fn signal(&self) {
        let mut sender = self
            .sender
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(sender) = sender.take() {
            let _ = sender.send(());
        }
    }

    /// 等待窗口真正销毁；超时后保留 pending 状态，禁止复用旧 NSView 句柄。
    pub(crate) async fn wait(&self, timeout: std::time::Duration) -> Result<(), String> {
        let mut receiver = self.receiver.lock().await;
        let result = tokio::time::timeout(
            timeout,
            receiver
                .as_mut()
                .ok_or_else(|| "播放器窗口销毁信号已被消费".to_string())?,
        )
        .await;
        match result {
            Ok(Ok(())) => {
                receiver.take();
                Ok(())
            }
            Ok(Err(_)) => Err("播放器窗口销毁通知通道已关闭".to_string()),
            Err(_) => Err("等待播放器窗口 Destroyed 事件超时".to_string()),
        }
    }
}

/// 串行化播放器窗口创建、打开与关闭，并持有原生视频子视图的非拥有句柄。
///
/// `operation_gate` 保证 native close 与 open/destroy 命令不会同时释放或复用同一表面。
pub struct PlayerWindowLifecycle {
    pub(crate) operation_gate: tokio::sync::Mutex<()>,
    video_view: AtomicUsize,
    close_requested: AtomicBool,
    closed: AtomicBool,
    destroy_signal: Mutex<Option<Arc<WindowDestroyedSignal>>>,
}

impl Default for PlayerWindowLifecycle {
    fn default() -> Self {
        Self {
            operation_gate: tokio::sync::Mutex::new(()),
            video_view: AtomicUsize::new(0),
            close_requested: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            destroy_signal: Mutex::new(None),
        }
    }
}

impl PlayerWindowLifecycle {
    pub(crate) fn video_view(&self) -> Option<usize> {
        let handle = self.video_view.load(Ordering::Acquire);
        (handle != 0).then_some(handle)
    }

    pub(crate) fn set_video_view(&self, handle: usize) {
        self.video_view.store(handle, Ordering::Release);
    }

    pub(crate) fn clear_video_view(&self) {
        self.video_view.store(0, Ordering::Release);
    }

    pub(crate) fn set_destroy_signal(&self, signal: Arc<WindowDestroyedSignal>) {
        *self
            .destroy_signal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(signal);
    }

    pub(crate) fn destroy_signal(&self) -> Option<Arc<WindowDestroyedSignal>> {
        self.destroy_signal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn clear_destroy_signal(&self) {
        *self
            .destroy_signal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    pub(crate) fn request_close_once(&self) -> bool {
        !self.close_requested.swap(true, Ordering::AcqRel)
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub(crate) fn is_closing(&self) -> bool {
        self.close_requested.load(Ordering::Acquire) && !self.is_closed()
    }

    pub(crate) fn mark_closed(&self, closed: bool) {
        self.closed.store(closed, Ordering::Release);
        if !closed {
            self.close_requested.store(false, Ordering::Release);
        }
        if closed {
            self.clear_video_view();
        }
    }
}

/// 播放线程使用的窗口句柄：尺寸来自 Tauri 窗口，CGL surface 绑定独立原生子视图。
#[derive(Clone)]
pub struct VideoWindow {
    window: Window,
    #[cfg(target_os = "macos")]
    video_view: usize,
}

impl VideoWindow {
    /// 将 Tauri 窗口与已挂入其视图树的原生视频 NSView 绑定。
    pub(crate) fn new(window: Window, video_view: usize) -> Result<Self, String> {
        #[cfg(target_os = "macos")]
        if video_view == 0 {
            return Err("播放器原生视频视图尚未创建".to_string());
        }

        #[cfg(not(target_os = "macos"))]
        let _ = video_view;

        Ok(Self {
            window,
            #[cfg(target_os = "macos")]
            video_view,
        })
    }

    /// 返回宿主窗口，供渲染线程读取物理尺寸与窗口事件状态。
    pub(crate) fn window(&self) -> &Window {
        &self.window
    }
}

impl HasDisplayHandle for VideoWindow {
    fn display_handle(&self) -> Result<raw_window_handle::DisplayHandle<'_>, HandleError> {
        self.window.display_handle()
    }
}

#[cfg(target_os = "macos")]
impl HasWindowHandle for VideoWindow {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let view = std::ptr::NonNull::new(self.video_view as *mut std::ffi::c_void)
            .ok_or(HandleError::Unavailable)?;
        let raw = RawWindowHandle::AppKit(AppKitWindowHandle::new(view));
        // SAFETY: the NSView is retained by its AppKit superview and remains in the window tree
        // until the playback worker has joined; window teardown is serialized after that join.
        Ok(unsafe { WindowHandle::borrow_raw(raw) })
    }
}

#[cfg(not(target_os = "macos"))]
impl HasWindowHandle for VideoWindow {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        self.window.window_handle()
    }
}

/// 在窗口主线程创建全尺寸、layer-backed 的视频 NSView，并返回其稳定指针值。
///
/// NSView 的父子关系负责保持对象存活；调用方必须先 join 播放线程，再销毁宿主窗口。
pub(crate) async fn create_video_view(window: &Window) -> Result<usize, String> {
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let main_window = window.clone();
        window
            .run_on_main_thread(move || {
                let result = create_video_view_on_main(&main_window);
                let _ = sender.send(result);
            })
            .map_err(|error| format!("调度原生视频视图创建失败：{error}"))?;

        tauri::async_runtime::spawn_blocking(move || {
            receiver
                .recv()
                .map_err(|error| format!("等待原生视频视图创建失败：{error}"))?
        })
        .await
        .map_err(|error| format!("原生视频视图创建线程异常终止：{error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Ok(0)
    }
}

#[cfg(target_os = "macos")]
fn create_video_view_on_main(window: &Window) -> Result<usize, String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAutoresizingMaskOptions, NSView};
    use raw_window_handle::RawWindowHandle;

    let marker = MainThreadMarker::new()
        .ok_or_else(|| "创建原生视频视图时不在 AppKit 主线程".to_string())?;
    let root_handle = window
        .window_handle()
        .map_err(|error| format!("读取播放器宿主视图失败：{error}"))?
        .as_raw();
    let RawWindowHandle::AppKit(root_handle) = root_handle else {
        return Err("播放器宿主窗口未提供 AppKit 视图句柄".to_string());
    };

    // SAFETY: Tauri 提供的 AppKit 句柄在宿主窗口存活期间指向有效 NSView；本函数只在主线程调用。
    let root = unsafe { &*(root_handle.ns_view.as_ptr().cast::<NSView>()) };
    let view = NSView::new(marker);
    view.setFrame(root.bounds());
    view.setWantsLayer(true);
    view.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    // 先挂载视频面，随后创建的 WKWebView 会被显式排序到它上方。
    root.addSubview(&view);

    Ok((&*view as *const NSView) as usize)
}

/// 在宿主窗口中创建铺满客户区的透明控制 WebView。
///
/// 该 WebView 使用 `index.html?player=1`，与主窗口共享同一应用资源和权限配置。
pub(crate) fn create_controls_webview(
    window: &Window,
    video_view: usize,
) -> Result<Webview, String> {
    use tauri::{webview::WebviewBuilder, WebviewUrl};

    let physical_size = window
        .inner_size()
        .map_err(|error| format!("读取播放器窗口尺寸失败：{error}"))?;
    let scale_factor = window
        .scale_factor()
        .map_err(|error| format!("读取播放器窗口缩放比例失败：{error}"))?;
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return Err("播放器窗口缩放比例无效".to_string());
    }
    let logical_size = LogicalSize::new(
        f64::from(physical_size.width) / scale_factor,
        f64::from(physical_size.height) / scale_factor,
    );

    let mut builder = WebviewBuilder::new(
        VIDEO_CONTROLS_LABEL,
        WebviewUrl::App("index.html?player=1".into()),
    )
    .accept_first_mouse(true)
    .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
    .focused(true);

    #[cfg(target_os = "macos")]
    {
        // `macos-private-api` enables Wry's WKWebView drawsBackground=false implementation.
        builder = builder.transparent(true);
    }

    let webview = window
        .add_child(builder, LogicalPosition::new(0.0, 0.0), logical_size)
        .map_err(|error| format!("创建播放器控制 WebView 失败：{error}"))?;

    #[cfg(target_os = "macos")]
    order_controls_above_video(window, &webview, video_view)?;

    install_resize_handler(window, webview.clone());
    Ok(webview)
}

#[cfg(target_os = "macos")]
fn order_controls_above_video(
    window: &Window,
    webview: &Webview,
    video_view: usize,
) -> Result<(), String> {
    use objc2_app_kit::{NSView, NSWindowOrderingMode};
    use raw_window_handle::RawWindowHandle;

    let root_handle = window
        .window_handle()
        .map_err(|error| format!("读取播放器宿主视图失败：{error}"))?
        .as_raw();
    let RawWindowHandle::AppKit(root_handle) = root_handle else {
        return Err("播放器宿主窗口未提供 AppKit 视图句柄".to_string());
    };
    let root_view = root_handle.ns_view.as_ptr() as usize;
    webview
        .with_webview(move |platform_webview| {
            // SAFETY: the callback runs on AppKit's main thread; both views are retained by the
            // same live window hierarchy for the lifetime of this callback.
            unsafe {
                let root = &*(root_view as *const NSView);
                let video = &*(video_view as *const NSView);
                let controls = &*(platform_webview.inner() as *const NSView);
                root.addSubview_positioned_relativeTo(
                    controls,
                    NSWindowOrderingMode::Above,
                    Some(video),
                );
            }
        })
        .map_err(|error| format!("设置播放器控制层级失败：{error}"))
}

/// 让透明控制 WebView 始终覆盖窗口客户区，并使用物理尺寸转换为逻辑点。
fn install_resize_handler(window: &Window, webview: Webview) {
    let host = window.clone();
    window.on_window_event(move |event| {
        let (physical_size, scale_factor) = match event {
            WindowEvent::Resized(size) => match host.scale_factor() {
                Ok(scale_factor) => (*size, scale_factor),
                Err(error) => {
                    eprintln!("读取播放器窗口缩放比例失败：{error}");
                    return;
                }
            },
            WindowEvent::ScaleFactorChanged {
                scale_factor,
                new_inner_size,
                ..
            } => (*new_inner_size, *scale_factor),
            _ => return,
        };

        if !scale_factor.is_finite() || scale_factor <= 0.0 {
            eprintln!("播放器窗口缩放比例无效：{scale_factor}");
            return;
        }
        let logical_size = LogicalSize::new(
            f64::from(physical_size.width) / scale_factor,
            f64::from(physical_size.height) / scale_factor,
        );
        if let Err(error) = webview.set_position(LogicalPosition::new(0.0, 0.0)) {
            eprintln!("更新播放器控制 WebView 位置失败：{error}");
        }
        if let Err(error) = webview.set_size(logical_size) {
            eprintln!("更新播放器控制 WebView 尺寸失败：{error}");
        }
    });
}

/// 在恢复或切焦播放器时将键盘焦点交给透明控制 WebView。
pub(crate) fn focus_controls(app: &AppHandle) -> Result<(), String> {
    let controls = app
        .get_webview(VIDEO_CONTROLS_LABEL)
        .ok_or_else(|| "播放器控制 WebView 尚未创建".to_string())?;
    controls
        .set_focus()
        .map_err(|error| format!("聚焦播放器控制 WebView 失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::{PlayerWindowLifecycle, WindowDestroyedSignal};

    #[test]
    fn destroyed_signal_retains_notification_until_waited() {
        let signal = WindowDestroyedSignal::new();
        signal.signal();

        tauri::async_runtime::block_on(signal.wait(std::time::Duration::from_millis(50)))
            .expect("销毁事件在等待开始前到达时也必须完成等待");
    }

    #[test]
    fn closed_generation_clears_native_view_handle() {
        let lifecycle = PlayerWindowLifecycle::default();
        lifecycle.set_video_view(42);

        assert!(lifecycle.request_close_once());
        assert!(lifecycle.is_closing());
        lifecycle.mark_closed(true);

        assert!(lifecycle.is_closed());
        assert!(!lifecycle.is_closing());
        assert_eq!(lifecycle.video_view(), None);
    }
}
