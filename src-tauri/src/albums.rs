use crate::cloud115::{Cloud115FileEntry, Cloud115Provider};
use crate::library::LibraryRepository;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::Duration;

/// 单次识别读取的目录条目上限：大目录性能上限先行，自动索引与缩略图缓存留待后续。
const SCAN_PAGE_LIMIT: u64 = 200;
/// 批量索引单次目录数上限：超过即显式拒绝。
const INDEX_BATCH_LIMIT: usize = 20;
/// 顶层图片扩展名（不含点，大小写不敏感）；视频/RAW 留待后续模式。
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "heic"];

/// 前端提交的识别目标；folder_name 仅作展示元数据，由前端的目录列表提供。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumFolderInput {
    pub folder_id: String,
    pub folder_name: String,
}

/// 时间线中的一张照片；taken_at 来自 115 的文件修改时间（秒级时间戳）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumPhoto {
    pub file_id: String,
    pub folder_id: String,
    pub pick_code: String,
    pub name: String,
    pub size_bytes: u64,
    pub taken_at: u64,
    /// 115 服务端缩略图地址；可能缺失。
    pub thumb_url: Option<String>,
}

/// 按月聚合的时间线分组；month_key 为 UTC 的 YYYY-MM。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumMonthGroup {
    pub month_key: String,
    pub photo_count: usize,
    pub photos: Vec<AlbumPhoto>,
}

/// 一个被索引目录构成的专辑；封面取该目录最新一张照片的缩略图。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumGroup {
    pub folder_id: String,
    pub folder_name: String,
    pub photo_count: usize,
    pub cover_url: Option<String>,
}

/// 一次只读识别的完整结果；识别是手动触发，不建立任何自动索引。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotosOverview {
    pub folder_id: String,
    pub folder_name: String,
    pub scanned_count: usize,
    pub truncated: bool,
    pub months: Vec<AlbumMonthGroup>,
    pub skipped_count: usize,
}

/// 本机持久化索引汇总：统一时间线 + 专辑分组。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumsIndexSummary {
    pub folder_count: usize,
    pub last_scanned_at: String,
    pub photo_count: usize,
    pub months: Vec<AlbumMonthGroup>,
    pub albums: Vec<AlbumGroup>,
}

/// 将秒级时间戳转换为 UTC 月份键（YYYY-MM）；时区本地化留给展示层。
fn month_key(taken_at: u64) -> String {
    let days = taken_at / 86_400;
    let (year, month, _) = civil_from_days(days as i64);
    format!("{year:04}-{month:02}")
}

/// 把 Unix 天数换算为（年, 月, 日）；Howard Hinnant 的 civil_from_days 算法。
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 只读识别一个目录：图片按 UTC 月份聚合成时间线，其他文件只计数；结果持久化到本机索引。
/// 识别的总 list_files 请求预算（含首层）：BFS 逐层下探直到照片层或预算耗尽，
/// 与每层 200 项上限共同构成大目录性能边界（最坏 12 次控制请求 ≈ 12 秒）。
const SCAN_REQUEST_BUDGET: usize = 12;
/// 每一层最多下探的文件夹数，防止单层海量目录吃光预算。
const SUBFOLDERS_PER_LEVEL: usize = 8;

pub async fn recognize_photos(
    provider: &Cloud115Provider,
    repository: &LibraryRepository,
    input: &AlbumFolderInput,
) -> Result<PhotosOverview, String> {
    let folder_id = input.folder_id.trim();
    if folder_id.is_empty() {
        return Err("请选择要识别的目录".to_string());
    }
    let page = provider
        .list_files(folder_id, 0, SCAN_PAGE_LIMIT, "")
        .await?;
    if page.entries.is_empty() {
        return Err("该目录没有可识别的内容".to_string());
    }

    // 手机备份把照片嵌套在「相册/设备/分类」等多层文件夹里：
    // BFS 逐层下探（每层最多 8 个文件夹），直到照片层或请求预算耗尽。
    let mut all_entries = page.entries.clone();
    let mut truncated = page.has_more;
    let mut budget = SCAN_REQUEST_BUDGET.saturating_sub(1);
    let mut queue: std::collections::VecDeque<Cloud115FileEntry> = page
        .entries
        .iter()
        .filter(|entry| entry.kind == "folder")
        .take(SUBFOLDERS_PER_LEVEL)
        .cloned()
        .collect();
    while budget > 0 {
        let Some(next) = queue.pop_front() else {
            break;
        };
        budget -= 1;
        if let Ok(mut sub_page) = provider.list_files(&next.id, 0, SCAN_PAGE_LIMIT, "").await {
            // 命中照片层后停止下探：更深的目录通常是应用私有结构。
            let has_images = sub_page
                .entries
                .iter()
                .any(|entry| IMAGE_EXTENSIONS.contains(&entry.extension.to_lowercase().as_str()));
            truncated = truncated || sub_page.has_more;
            if !has_images {
                for entry in sub_page
                    .entries
                    .iter()
                    .filter(|entry| entry.kind == "folder")
                    .take(SUBFOLDERS_PER_LEVEL)
                {
                    queue.push_back(entry.clone());
                }
            }
            all_entries.append(&mut sub_page.entries);
        }
    }
    if all_entries.is_empty() {
        return Err("该目录没有可识别的内容".to_string());
    }

    let overview = group_photos(&all_entries, folder_id, input.folder_name.trim(), truncated);
    // 幂等覆盖该目录的索引；索引行数由仓储层限制在最近 50 个目录。
    let payload =
        serde_json::to_string(&overview).map_err(|error| format!("序列化相册索引失败：{error}"))?;
    repository.save_albums_index(
        folder_id,
        &payload,
        overview.scanned_count as i64,
        overview
            .months
            .iter()
            .map(|month| month.photo_count)
            .sum::<usize>() as i64,
    )?;
    Ok(overview)
}

/// 批量索引：顺序识别多个目录并各自持久化；单次上限 20 个目录，写操作间留出限速间隔。
pub async fn index_folders(
    provider: &Cloud115Provider,
    repository: &LibraryRepository,
    folders: &[AlbumFolderInput],
) -> Result<Vec<PhotosOverview>, String> {
    if folders.len() > INDEX_BATCH_LIMIT {
        return Err(format!("单次批量索引最多 {INDEX_BATCH_LIMIT} 个目录"));
    }
    if folders.is_empty() {
        return Err("请选择要批量索引的目录".to_string());
    }
    let mut overviews = Vec::with_capacity(folders.len());
    for input in folders {
        overviews.push(recognize_photos(provider, repository, input).await?);
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    Ok(overviews)
}

/// 汇总本机已持久化的全部目录索引：统一时间线 + 按目录分组的专辑。
pub fn index_summary(repository: &LibraryRepository) -> Result<AlbumsIndexSummary, String> {
    let rows = repository.list_albums_indexes()?;
    let mut overviews = Vec::with_capacity(rows.len());
    for row in &rows {
        let overview: PhotosOverview = serde_json::from_str(&row.payload_json)
            .map_err(|error| format!("解析相册索引失败（{}）：{error}", row.folder_id))?;
        overviews.push(overview);
    }
    let albums = build_albums(&overviews);
    let months = merge_months(overviews);
    Ok(AlbumsIndexSummary {
        folder_count: rows.len(),
        last_scanned_at: rows
            .iter()
            .map(|row| row.scanned_at.as_str())
            .max()
            .unwrap_or_default()
            .to_string(),
        photo_count: months.iter().map(|month| month.photo_count).sum(),
        months,
        albums,
    })
}

/// 按目录聚合专辑：封面取目录内最新一张有缩略图的照片；名称缺失时回退目录 ID。
fn build_albums(overviews: &[PhotosOverview]) -> Vec<AlbumGroup> {
    let mut albums: BTreeMap<String, AlbumGroup> = BTreeMap::new();
    for overview in overviews {
        let photo_count = overview.months.iter().map(|month| month.photo_count).sum();
        // 月份与月内照片都按时间倒序，取第一张带缩略图的照片作封面。
        let cover_url = overview
            .months
            .iter()
            .flat_map(|month| month.photos.iter())
            .find_map(|photo| photo.thumb_url.clone());
        let entry = albums
            .entry(overview.folder_id.clone())
            .or_insert_with(|| AlbumGroup {
                folder_id: overview.folder_id.clone(),
                folder_name: String::new(),
                photo_count: 0,
                cover_url: None,
            });
        entry.photo_count = photo_count;
        entry.cover_url = cover_url;
        let name = overview.folder_name.trim();
        entry.folder_name = if name.is_empty() {
            overview.folder_id.clone()
        } else {
            name.to_string()
        };
    }
    albums.into_values().collect()
}

/// 合并多个目录索引为统一时间线：同月聚合，照片按 file_id 去重，月份从新到旧。
fn merge_months(overviews: Vec<PhotosOverview>) -> Vec<AlbumMonthGroup> {
    let mut photos: BTreeMap<String, AlbumPhoto> = BTreeMap::new();
    for overview in overviews {
        for month in overview.months {
            for photo in month.photos {
                photos.insert(photo.file_id.clone(), photo);
            }
        }
    }
    let mut by_month: BTreeMap<String, Vec<AlbumPhoto>> = BTreeMap::new();
    for photo in photos.into_values() {
        by_month
            .entry(month_key(photo.taken_at))
            .or_default()
            .push(photo);
    }
    let mut months: Vec<AlbumMonthGroup> = by_month
        .into_iter()
        .map(|(month_key, mut month_photos)| {
            month_photos.sort_by(|a, b| {
                b.taken_at
                    .cmp(&a.taken_at)
                    .then_with(|| a.name.cmp(&b.name))
            });
            let photo_count = month_photos.len();
            AlbumMonthGroup {
                month_key,
                photo_count,
                photos: month_photos,
            }
        })
        .collect();
    // 月份键即时间序：字符串倒序 = 从新到旧。
    months.sort_by(|a, b| b.month_key.cmp(&a.month_key));
    months
}

/// 纯分组逻辑：从目录快照构建月度时间线，BTreeMap 保证输出顺序稳定。
fn group_photos(
    entries: &[Cloud115FileEntry],
    folder_id: &str,
    folder_name: &str,
    truncated: bool,
) -> PhotosOverview {
    let _ = folder_name; // 目录名仅写入索引 payload，用于专辑分组展示。
    let mut by_month: BTreeMap<String, Vec<AlbumPhoto>> = BTreeMap::new();
    let mut skipped_count = 0usize;
    for entry in entries {
        let extension = entry.extension.to_lowercase();
        if !IMAGE_EXTENSIONS.contains(&extension.as_str()) {
            skipped_count += 1;
            continue;
        }
        let photo = AlbumPhoto {
            file_id: entry.id.clone(),
            folder_id: folder_id.to_string(),
            pick_code: entry.pick_code.clone(),
            name: entry.name.clone(),
            size_bytes: entry.size_bytes,
            taken_at: entry.modified_at,
            thumb_url: entry.thumb_url.clone(),
        };
        by_month
            .entry(month_key(photo.taken_at))
            .or_default()
            .push(photo);
    }
    let mut months: Vec<AlbumMonthGroup> = by_month
        .into_iter()
        .map(|(month_key, mut month_photos)| {
            month_photos.sort_by(|a, b| {
                b.taken_at
                    .cmp(&a.taken_at)
                    .then_with(|| a.name.cmp(&b.name))
            });
            let photo_count = month_photos.len();
            AlbumMonthGroup {
                month_key,
                photo_count,
                photos: month_photos,
            }
        })
        .collect();
    months.sort_by(|a, b| b.month_key.cmp(&a.month_key));
    PhotosOverview {
        folder_id: folder_id.to_string(),
        folder_name: folder_name.trim().to_string(),
        scanned_count: entries.len(),
        truncated,
        months,
        skipped_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(
        id: &str,
        name: &str,
        extension: &str,
        modified_at: u64,
        thumb_url: Option<&str>,
    ) -> Cloud115FileEntry {
        Cloud115FileEntry {
            id: id.to_string(),
            parent_id: "0".to_string(),
            name: name.to_string(),
            kind: if extension.is_empty() {
                "folder".to_string()
            } else {
                "file".to_string()
            },
            extension: extension.to_string(),
            size_bytes: 1024,
            modified_at,
            pick_code: String::new(),
            thumb_url: thumb_url.map(str::to_string),
            children: None,
        }
    }

    fn overview(
        folder_id: &str,
        folder_name: &str,
        entries: &[Cloud115FileEntry],
    ) -> PhotosOverview {
        group_photos(entries, folder_id, folder_name, false)
    }

    #[test]
    fn month_key_converts_utc_calendar_months() {
        // 2026-01-01 00:00:00 UTC。
        assert_eq!(month_key(1_767_225_600), "2026-01");
        // 2026-08-31 23:59:59 UTC 与 2026-09-01 00:00:00 UTC 分属两月。
        assert_eq!(month_key(1_788_220_799), "2026-08");
        assert_eq!(month_key(1_788_220_800), "2026-09");
        // Unix 纪元起点。
        assert_eq!(month_key(0), "1970-01");
    }

    #[test]
    fn group_photos_builds_descending_timeline_and_counts_skipped() {
        let entries = vec![
            entry("1", "a.jpg", "jpg", 1_788_220_800, None), // 2026-09
            entry("2", "b.png", "png", 1_788_220_799, None), // 2026-08
            entry("3", "c.heic", "HEIC", 1_785_542_400, None), // 2026-08
            entry("4", "notes.txt", "txt", 1_788_220_800, None),
            entry("5", "已归档", "", 1_788_220_800, None),
        ];
        let over = overview("folder-1", "旅行照片", &entries);
        assert_eq!(over.scanned_count, 5);
        assert_eq!(over.folder_name, "旅行照片");
        assert_eq!(over.months.len(), 2);
        assert_eq!(over.months[0].month_key, "2026-09");
        assert_eq!(over.months[0].photo_count, 1);
        assert_eq!(over.months[1].month_key, "2026-08");
        assert_eq!(over.months[1].photo_count, 2);
        // 同月内从新到旧。
        assert_eq!(over.months[1].photos[0].name, "b.png");
        assert_eq!(over.skipped_count, 2);
    }

    #[test]
    fn build_albums_covers_from_newest_thumb_and_fallback_naming() {
        let has_thumb = overview(
            "folder-1",
            "旅行照片",
            &[
                entry("1", "a.jpg", "jpg", 1_788_220_800, None),
                entry("2", "b.jpg", "jpg", 1_788_200_000, Some("https://thumb/b")),
            ],
        );
        let no_thumb = overview(
            "folder-2",
            "",
            &[entry("3", "c.jpg", "jpg", 1_767_225_600, None)],
        );
        let albums = build_albums(&[has_thumb, no_thumb]);
        assert_eq!(albums.len(), 2);
        assert_eq!(albums[0].folder_name, "旅行照片");
        assert_eq!(albums[0].photo_count, 2);
        // 封面取最新一张有缩略图的照片（月份与月内均按时间倒序，第一个带 thumb 的即是）。
        assert_eq!(albums[0].cover_url.as_deref(), Some("https://thumb/b"));
        // 目录名缺失时回退目录 ID。
        assert_eq!(albums[1].folder_name, "folder-2");
        assert_eq!(albums[1].cover_url, None);
    }

    #[test]
    fn merge_months_dedupes_and_merges_across_folders() {
        let mut first = overview(
            "folder-1",
            "旅行照片",
            &[entry("1", "a.jpg", "jpg", 1_788_220_800, None)],
        );
        let second = overview(
            "folder-2",
            "收藏",
            &[
                entry("1", "a.jpg", "jpg", 1_788_220_800, None),
                entry("2", "b.jpg", "jpg", 1_767_225_600, None),
            ],
        );
        first.months[0].photos[0].name = "renamed.jpg".to_string();
        let months = merge_months(vec![first, second]);
        assert_eq!(months.len(), 2);
        assert_eq!(months[0].month_key, "2026-09");
        // file_id 去重：后合并的目录覆盖同名照片。
        assert_eq!(months[0].photos.len(), 1);
        assert_eq!(months[0].photos[0].name, "a.jpg");
        assert_eq!(months[1].month_key, "2026-01");
        assert_eq!(months[1].photo_count, 1);
    }
}
