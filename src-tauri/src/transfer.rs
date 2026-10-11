//! 传输进度事件通道：定义 `transfer://progress` 契约、下载限频门与阶段上报器。
//!
//! 事件负载（serde camelCase）与前端 `src/services/events.ts` 逐字段对齐：
//! `{ transferId, kind, fileName, stage, completedParts?, totalParts?,
//!    transferredBytes?, totalBytes?, speedBytesPerSec? }`。
//! 本模块不依赖 Tauri：限频与上报逻辑可离线单测，命令层负责把回调接到 Emitter。

use serde::Serialize;
use std::{
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// WebView 事件通道名；前端按同一字符串订阅。
pub const TRANSFER_PROGRESS_EVENT: &str = "transfer://progress";

/// 传输方向；与前端 `TransferKind` 字面量一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferKind {
    Upload,
    Download,
}

/// 传输阶段；与前端 `TransferStage` 字面量一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferStage {
    Preparing,
    Transferring,
    Finalizing,
    Done,
    Failed,
}

/// `transfer://progress` 事件负载；可空字段在序列化时整体省略。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transfer_id: String,
    pub kind: TransferKind,
    pub file_name: String,
    pub stage: TransferStage,
    /// multipart 上传已完成分片数；其余传输缺省。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_parts: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_parts: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transferred_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed_bytes_per_sec: Option<u64>,
}

/// 阶段事件携带的可选数值；固定字段（transferId/kind/fileName）由 `TransferReporter` 补齐。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TransferUpdate {
    pub completed_parts: Option<u64>,
    pub total_parts: Option<u64>,
    pub transferred_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub speed_bytes_per_sec: Option<u64>,
}

impl TransferUpdate {
    /// 返回附带速度的副本，便于在同一组数值上补充限频器估算出的速率。
    pub fn with_speed(mut self, speed_bytes_per_sec: Option<u64>) -> Self {
        self.speed_bytes_per_sec = speed_bytes_per_sec;
        self
    }
}

/// 传输进度回调；命令层用 Tauri Emitter 实现它，离线测试传 `None` 即可关闭上报。
pub type ProgressCallback = Arc<dyn Fn(TransferProgress) + Send + Sync>;

/// 阶段上报器：为每次回调补齐固定字段，回调缺省时全部静默。
pub struct TransferReporter {
    callback: Option<ProgressCallback>,
    transfer_id: String,
    kind: TransferKind,
    file_name: String,
}

impl TransferReporter {
    /// 创建上传进度上报器；事件文件名取路径末段，便于界面直接展示。
    pub fn upload(callback: Option<ProgressCallback>, source: &Path) -> Self {
        let file_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| source.to_string_lossy().into_owned());
        Self::new(callback, TransferKind::Upload, file_name)
    }

    /// 创建下载进度上报器。
    pub fn download(callback: Option<ProgressCallback>, file_name: &str) -> Self {
        Self::new(callback, TransferKind::Download, file_name.to_string())
    }

    fn new(callback: Option<ProgressCallback>, kind: TransferKind, file_name: String) -> Self {
        Self {
            callback,
            transfer_id: next_transfer_id(),
            kind,
            file_name,
        }
    }

    /// 发射一次阶段事件；数值字段由调用方按阶段语义填充。
    pub fn report(&self, stage: TransferStage, update: TransferUpdate) {
        if let Some(callback) = &self.callback {
            callback(TransferProgress {
                transfer_id: self.transfer_id.clone(),
                kind: self.kind,
                file_name: self.file_name.clone(),
                stage,
                completed_parts: update.completed_parts,
                total_parts: update.total_parts,
                transferred_bytes: update.transferred_bytes,
                total_bytes: update.total_bytes,
                speed_bytes_per_sec: update.speed_bytes_per_sec,
            });
        }
    }

    /// 传输结束时补发终态：成功发 done，失败发 failed，保证终态恰好一次。
    pub fn finish(&self, success: bool) {
        self.report(
            if success {
                TransferStage::Done
            } else {
                TransferStage::Failed
            },
            TransferUpdate::default(),
        );
    }
}

/// 进程首个传输发生时的 Unix 毫秒时间戳；与进程内计数器一起生成不重复的 transferId。
fn boot_unix_millis() -> u64 {
    static BOOT_MILLIS: OnceLock<u64> = OnceLock::new();
    *BOOT_MILLIS.get_or_init(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_millis() as u64)
            .unwrap_or(0)
    })
}

/// 用启动时间戳 + 进程内计数器生成传输 ID；不引入额外依赖。
pub fn next_transfer_id() -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
    format!("transfer-{}-{sequence}", boot_unix_millis())
}

/// 下载进度限频门：距上次发射不足 200ms 且新增不足 1 MiB 时丢弃，结束可强制放行。
#[derive(Debug)]
pub struct DownloadProgressGate {
    last: Option<(Instant, u64)>,
}

/// 一次放行的下载进度：累计字节与可选的瞬时速度估算。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DownloadEmission {
    pub transferred_bytes: u64,
    pub speed_bytes_per_sec: Option<u64>,
}

impl DownloadProgressGate {
    /// 两次下载进度发射的最小时间间隔。
    pub const MIN_INTERVAL: Duration = Duration::from_millis(200);
    /// 触发发射的最小新增字节量（1 MiB）。
    pub const MIN_BYTES: u64 = 1024 * 1024;

    /// 创建尚未发射过任何进度的限频门。
    pub const fn new() -> Self {
        Self { last: None }
    }

    /// 判定是否放行一次进度发射；`force` 用于结束时必发。
    /// 累计字节无新增时即便强制也不重复发射；进度回退（服务端忽略 Range）按重新开始处理。
    pub fn admit(
        &mut self,
        now: Instant,
        received_bytes: u64,
        force: bool,
    ) -> Option<DownloadEmission> {
        let Some((last_at, last_bytes)) = self.last else {
            self.last = Some((now, received_bytes));
            return Some(DownloadEmission {
                transferred_bytes: received_bytes,
                speed_bytes_per_sec: None,
            });
        };
        if received_bytes == last_bytes {
            return None;
        }
        if received_bytes < last_bytes {
            // 服务端忽略 Range 请求时会从头重下：进度回退视为新的起点且暂无速度。
            self.last = Some((now, received_bytes));
            return Some(DownloadEmission {
                transferred_bytes: received_bytes,
                speed_bytes_per_sec: None,
            });
        }
        let elapsed = now.saturating_duration_since(last_at);
        let new_bytes = received_bytes - last_bytes;
        if !force && elapsed < Self::MIN_INTERVAL && new_bytes < Self::MIN_BYTES {
            return None;
        }
        let speed = speed_bytes_per_sec(new_bytes, elapsed);
        self.last = Some((now, received_bytes));
        Some(DownloadEmission {
            transferred_bytes: received_bytes,
            speed_bytes_per_sec: speed,
        })
    }
}

/// 由两次发射之间的新增字节与耗时估算速度；耗时为零时视为未知。
pub fn speed_bytes_per_sec(new_bytes: u64, elapsed: Duration) -> Option<u64> {
    if elapsed.is_zero() {
        return None;
    }
    Some((new_bytes as f64 / elapsed.as_secs_f64()).round() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn collecting_reporter(events: &Arc<Mutex<Vec<TransferProgress>>>) -> TransferReporter {
        let sink = Arc::clone(events);
        TransferReporter::download(
            Some(Arc::new(move |progress| {
                sink.lock().expect("事件收集锁应可用").push(progress);
            })),
            "sample.mp4",
        )
    }

    #[test]
    fn transfer_progress_serializes_camel_case_and_skips_absent_fields() {
        let progress = TransferProgress {
            transfer_id: "transfer-1-1".to_string(),
            kind: TransferKind::Upload,
            file_name: "movie.mkv".to_string(),
            stage: TransferStage::Transferring,
            completed_parts: Some(1),
            total_parts: Some(3),
            transferred_bytes: None,
            total_bytes: Some(64),
            speed_bytes_per_sec: None,
        };
        let payload = serde_json::to_string(&progress).expect("进度事件应可序列化");
        assert!(payload.contains("\"transferId\":\"transfer-1-1\""));
        assert!(payload.contains("\"kind\":\"upload\""));
        assert!(payload.contains("\"fileName\":\"movie.mkv\""));
        assert!(payload.contains("\"stage\":\"transferring\""));
        assert!(payload.contains("\"completedParts\":1"));
        assert!(payload.contains("\"totalBytes\":64"));
        assert!(!payload.contains("transferredBytes"));
        assert!(!payload.contains("speedBytesPerSec"));
    }

    #[test]
    fn transfer_reporter_pads_fixed_fields_and_reports_terminal_once() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let reporter = collecting_reporter(&events);
        reporter.report(TransferStage::Preparing, TransferUpdate::default());
        reporter.report(
            TransferStage::Transferring,
            TransferUpdate {
                transferred_bytes: Some(64),
                total_bytes: Some(128),
                ..TransferUpdate::default()
            },
        );
        reporter.finish(false);
        let events = events.lock().expect("事件收集锁应可用");
        assert_eq!(events.len(), 3);
        assert!(events
            .iter()
            .all(|progress| progress.transfer_id.starts_with("transfer-")));
        assert!(events
            .iter()
            .all(|progress| progress.kind == TransferKind::Download));
        assert_eq!(events[0].stage, TransferStage::Preparing);
        assert_eq!(events[1].file_name, "sample.mp4");
        assert_eq!(events[1].transferred_bytes, Some(64));
        assert_eq!(events[2].stage, TransferStage::Failed);
    }

    #[test]
    fn transfer_reporter_without_callback_stays_silent() {
        // None 回调必须完全静默：调用不应 panic，也不产生任何副作用。
        let reporter = TransferReporter::upload(None, Path::new("/tmp/a.bin"));
        reporter.report(
            TransferStage::Transferring,
            TransferUpdate {
                transferred_bytes: Some(1),
                ..TransferUpdate::default()
            },
        );
        reporter.finish(true);
    }

    #[test]
    fn transfer_reporter_upload_uses_file_name_from_path() {
        let reporter = TransferReporter::upload(None, Path::new("/tmp/dir/movie.mkv"));
        assert_eq!(reporter.file_name, "movie.mkv");
    }

    #[test]
    fn next_transfer_id_is_unique_within_process() {
        let first = next_transfer_id();
        let second = next_transfer_id();
        assert_ne!(first, second);
        assert!(first.starts_with("transfer-"));
    }

    #[test]
    fn speed_bytes_per_sec_divides_bytes_by_elapsed_seconds() {
        assert_eq!(
            speed_bytes_per_sec(2048, Duration::from_secs(2)),
            Some(1024)
        );
        assert_eq!(speed_bytes_per_sec(1, Duration::from_millis(4)), Some(250));
        assert_eq!(speed_bytes_per_sec(1024, Duration::ZERO), None);
    }

    #[test]
    fn download_gate_emits_first_sample_without_speed() {
        let start = Instant::now();
        let mut gate = DownloadProgressGate::new();
        let emission = gate.admit(start, 512, false).expect("首次采样应放行");
        assert_eq!(emission.transferred_bytes, 512);
        assert_eq!(emission.speed_bytes_per_sec, None);
    }

    #[test]
    fn download_gate_throttles_until_interval_or_byte_threshold() {
        let start = Instant::now();
        let mut gate = DownloadProgressGate::new();
        gate.admit(start, 0, false);
        // 100ms 且新增 512 KiB：时间与字节阈值都未达到，丢弃。
        assert!(gate
            .admit(start + Duration::from_millis(100), 512 * 1024, false)
            .is_none());
        // 150ms 但已新增 1 MiB：字节阈值放行（上次发射时刻随之刷新）。
        let emission = gate
            .admit(start + Duration::from_millis(150), 1024 * 1024, false)
            .expect("字节阈值达到应放行");
        assert_eq!(emission.transferred_bytes, 1024 * 1024);
        // 距上次发射 250ms 且新增不足 1 MiB：时间阈值放行，并给出速度。
        let emission = gate
            .admit(start + Duration::from_millis(400), 1024 * 1024 + 512, false)
            .expect("时间阈值达到应放行");
        assert_eq!(emission.transferred_bytes, 1024 * 1024 + 512);
        assert!(emission.speed_bytes_per_sec.is_some());
        // 无新增字节：即使强制也不重复发射。
        assert!(gate
            .admit(start + Duration::from_millis(400), 1024 * 1024 + 512, true)
            .is_none());
    }

    #[test]
    fn download_gate_force_emits_final_sample() {
        let start = Instant::now();
        let mut gate = DownloadProgressGate::new();
        gate.admit(start, 0, false);
        let emission = gate
            .admit(start + Duration::from_millis(10), 4096, true)
            .expect("结束时强制放行应生效");
        assert_eq!(emission.transferred_bytes, 4096);
        assert!(emission.speed_bytes_per_sec.is_some());
    }

    #[test]
    fn download_gate_treats_rewound_progress_as_restart() {
        let start = Instant::now();
        let mut gate = DownloadProgressGate::new();
        gate.admit(start, 2048, false);
        let emission = gate
            .admit(start + Duration::from_millis(10), 1024, false)
            .expect("进度回退应按重新开始放行");
        assert_eq!(emission.transferred_bytes, 1024);
        assert_eq!(emission.speed_bytes_per_sec, None);
    }
}
