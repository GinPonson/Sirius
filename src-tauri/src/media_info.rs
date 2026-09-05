use crate::cloud115::{Cloud115FileMetadata, Cloud115Provider};
use crate::library::{LibraryRepository, MediaInfo};
use libmpv2::Mpv;
use std::time::{Duration, Instant};
use std::{sync::mpsc, thread};

/// 单次媒体探测的最长等待；加载失败或超时都显式报错。
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// 探测属性轮询间隔；duration 就绪即代表文件加载完成。
const PROBE_POLL_INTERVAL: Duration = Duration::from_millis(120);

/// 用无渲染的 libmpv 实例探测本地视频的时长、分辨率与编码。
/// 探测在独立线程完成，避免阻塞异步运行时；超时或加载失败均显式报错。
pub fn probe_local_file(path: &str) -> Result<MediaInfo, String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("请提供要探测的本地文件路径".to_string());
    }
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let result = run_probe(&path);
        let _ = sender.send(result);
    });
    receiver
        .recv_timeout(PROBE_TIMEOUT + Duration::from_secs(5))
        .map_err(|_| "媒体探测线程异常终止".to_string())?
}

fn run_probe(path: &str) -> Result<MediaInfo, String> {
    let mpv = Mpv::with_initializer(|initializer| {
        initializer.set_property("vo", "null")?;
        initializer.set_property("ao", "null")?;
        initializer.set_property("keep-open", true)?;
        Ok(())
    })
    .map_err(|error| format!("初始化媒体探测实例失败：{error}"))?;
    mpv.command("loadfile", &[path, "replace"])
        .map_err(|error| format!("libmpv 无法加载待探测文件：{error}"))?;

    // duration 属性就绪代表文件已加载并可读取媒体信息。
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let duration = loop {
        if Instant::now() >= deadline {
            return Err("探测媒体信息超时，文件可能已损坏或不是受支持格式".to_string());
        }
        match mpv.get_property::<f64>("duration") {
            Ok(value) if value > 0.0 => break value,
            _ => thread::sleep(PROBE_POLL_INTERVAL),
        }
    };

    Ok(MediaInfo {
        provider: "local".to_string(),
        file_id: path.to_string(),
        duration_seconds: Some(duration),
        width: mpv.get_property::<i64>("width").ok(),
        height: mpv.get_property::<i64>("height").ok(),
        video_codec: mpv.get_property::<String>("video-format").ok(),
        audio_codec: mpv.get_property::<String>("audio-codec-name").ok(),
    })
}

/// 115 刮削：读取 OpenAPI 文件元数据中的时长并持久化；分辨率与编码暂无来源字段。
pub async fn scrape_cloud_file(
    provider: &Cloud115Provider,
    repository: &LibraryRepository,
    file_id: &str,
) -> Result<MediaInfo, String> {
    let file_id = file_id.trim();
    if file_id.is_empty() {
        return Err("请提供要刮削的 115 文件 ID".to_string());
    }
    let metadata = provider.file_metadata(file_id).await?;
    if metadata.is_folder {
        return Err("115 目录没有媒体信息，请选择视频文件".to_string());
    }
    let info = media_info_from_metadata(&metadata);
    repository.save_media_info(&info)?;
    Ok(info)
}

/// 纯映射：把 115 文件元数据转换为媒体信息；无效时长保持为空。
fn media_info_from_metadata(metadata: &Cloud115FileMetadata) -> MediaInfo {
    MediaInfo {
        provider: "cloud115".to_string(),
        file_id: metadata.id.clone(),
        duration_seconds: (metadata.duration_seconds > 0.0).then_some(metadata.duration_seconds),
        width: None,
        height: None,
        video_codec: None,
        audio_codec: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_info_from_metadata_maps_duration_only() {
        let mut metadata = Cloud115FileMetadata {
            id: "8".to_string(),
            name: "Arrival.mkv".to_string(),
            parent_id: "42".to_string(),
            is_folder: false,
            file_type: "1".to_string(),
            size_bytes: 1024,
            modified_at: 0,
            duration_seconds: 7200.5,
            pick_code: String::new(),
            sha1: String::new(),
            starred: false,
            path: Vec::new(),
        };
        let info = media_info_from_metadata(&metadata);
        assert_eq!(info.provider, "cloud115");
        assert_eq!(info.duration_seconds, Some(7200.5));
        assert_eq!(info.width, None);
        assert_eq!(info.video_codec, None);

        // 115 未返回有效时长时保持为空，而不是伪装成 0。
        metadata.duration_seconds = 0.0;
        assert_eq!(media_info_from_metadata(&metadata).duration_seconds, None);
    }
}
