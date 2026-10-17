use crate::cloud115::{sanitize_remote_file_name, Cloud115FileEntry, Cloud115Provider};
use crate::library::LibraryRepository;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

/// 单次识别读取的目录条目上限：先确立大目录性能上限，自动索引与缩略图缓存留待阅读器阶段。
const SCAN_PAGE_LIMIT: u64 = 200;

/// 阅读器有界缓存总预算；超出后按最近打开时间淘汰最旧的卷目录。
const CACHE_BUDGET_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// 阅读器当前支持的压缩包扩展名；CBZ 即 ZIP，RAR/7Z 解压暂未接入。
const READER_EXTENSIONS: &[&str] = &["cbz", "zip"];
/// 封面缩略图最长边；缩放后统一存 JPEG，保证单张封面体积有界。
const COVER_MAX_WIDTH: u32 = 320;
/// 批量索引单次目录数上限：大目录性能上限先行，超过即显式拒绝。
const INDEX_BATCH_LIMIT: usize = 20;
/// 视为漫画压缩包的扩展名（不含点，大小写不敏感）。
const ARCHIVE_EXTENSIONS: &[&str] = &["cbz", "zip", "cbr", "rar", "7z"];
/// 顶层松散图片只计数上报，不参与分组；整目录图片漫画的识别留给阅读器阶段。
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "heic"];

/// 识别出的单卷漫画（一个压缩包）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicsVolume {
    pub file_id: String,
    pub pick_code: String,
    pub name: String,
    pub size_bytes: u64,
    /// 本机已缓存的封面缩略图路径；未打开过的卷为 null。
    pub cover_path: Option<String>,
}

/// 按系列名聚合的漫画组。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicsSeriesGroup {
    pub title: String,
    pub volume_count: usize,
    pub total_bytes: u64,
    pub volumes: Vec<ComicsVolume>,
}

/// 一次只读识别的完整结果；识别是手动触发，不建立任何自动索引。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicsOverview {
    pub folder_id: String,
    pub scanned_count: usize,
    pub truncated: bool,
    pub series: Vec<ComicsSeriesGroup>,
    pub loose_image_count: usize,
    pub skipped_count: usize,
}

/// 本机持久化索引汇总后的统一书架。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicsIndexSummary {
    pub folder_count: usize,
    pub last_scanned_at: String,
    pub series: Vec<ComicsSeriesGroup>,
}

/// 从压缩包文件名推断系列名：反复剥离尾部括号组与卷号标记，供分组聚合。
fn parse_series_title(file_stem: &str) -> String {
    let mut title = file_stem.trim().to_string();
    for _ in 0..8 {
        let next = strip_trailing_group(&title)
            .map(str::to_string)
            .or_else(|| strip_trailing_volume_marker(&title).map(str::to_string));
        match next {
            Some(value) if !value.trim().is_empty() => title = value,
            _ => break,
        }
    }
    let trimmed = title
        .trim()
        .trim_end_matches(['-', '_', '~', '·', ':', '：', ' '])
        .trim();
    if trimmed.is_empty() {
        file_stem.trim().to_string()
    } else {
        trimmed.to_string()
    }
}

/// 剥离延伸到末尾的成对括号组：(...) （…） [...] 【…】。
fn strip_trailing_group(title: &str) -> Option<&str> {
    let trimmed = title.trim_end();
    let close = trimmed.chars().last()?;
    let open = match close {
        ')' => '(',
        '）' => '（',
        ']' => '[',
        '】' => '【',
        _ => return None,
    };
    let open_pos = trimmed.rfind(open)?;
    let inner = &trimmed[open_pos + 1..trimmed.len() - close.len_utf8()];
    if inner.is_empty() || inner.contains(close) {
        return None;
    }
    Some(&trimmed[..open_pos])
}

/// 剥离尾部的卷号标记：第N卷/话/册/集/篇、Vol.N、纯数字或 vN。
fn strip_trailing_volume_marker(title: &str) -> Option<&str> {
    let trimmed = title.trim_end();
    // “第…卷”形态：第 + 数字 + 单位。
    if let Some(pos) = trimmed.rfind('第') {
        let tail = &trimmed[pos + '第'.len_utf8()..];
        let digit_end = tail
            .char_indices()
            .take_while(|(_, ch)| ch.is_ascii_digit() || matches!(ch, '０'..='９'))
            .last()
            .map(|(index, ch)| index + ch.len_utf8());
        if let Some(digit_end) = digit_end {
            if matches!(
                tail[digit_end..].chars().next(),
                Some('卷' | '话' | '話' | '册' | '冊' | '集' | '篇')
            ) {
                return Some(&trimmed[..pos]);
            }
        }
    }
    // Vol.12 / vol 12（大小写不敏感）。
    let lower = trimmed.to_lowercase();
    for marker in ["vol.", "vol "] {
        if let Some(pos) = lower.rfind(marker) {
            let rest = &trimmed[pos + marker.len()..];
            if !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_digit()) {
                return Some(&trimmed[..pos]);
            }
        }
    }
    // 纯数字或紧贴的 vN 尾缀。
    let without_digits = trimmed.trim_end_matches(|ch: char| ch.is_ascii_digit());
    if without_digits.len() < trimmed.len() {
        let base = without_digits.trim_end_matches(['v', 'V']);
        let candidate = base.trim_end_matches([' ', '-', '_', '~', '·', ':', '：']);
        if !candidate.is_empty() && candidate != trimmed {
            return Some(candidate);
        }
    }
    None
}

/// 只读识别一个目录：压缩包按系列分组，松散图片与其他文件只计数；结果持久化到本机索引。
pub async fn recognize_comics(
    app: &tauri::AppHandle,
    provider: &Cloud115Provider,
    repository: &LibraryRepository,
    folder_id: &str,
) -> Result<ComicsOverview, String> {
    let folder_id = folder_id.trim();
    if folder_id.is_empty() {
        return Err("请选择要识别的目录".to_string());
    }
    let page = provider
        .list_files(folder_id, 0, SCAN_PAGE_LIMIT, "")
        .await?;
    if page.entries.is_empty() {
        return Err("该目录没有可识别的内容".to_string());
    }
    let mut overview = group_comics(&page.entries, folder_id, page.has_more);
    let cache_root = comics_cache_root(app)?;
    enrich_covers(&cache_root, &mut overview.series);
    // 幂等覆盖该目录的索引；索引行数由仓储层限制在最近 50 个目录。
    let payload =
        serde_json::to_string(&overview).map_err(|error| format!("序列化漫画索引失败：{error}"))?;
    repository.save_comics_index(
        folder_id,
        &payload,
        overview.scanned_count as i64,
        overview.series.len() as i64,
    )?;
    Ok(overview)
}

/// 批量索引：顺序识别多个目录并各自持久化；单次上限 20 个目录，写操作间留出限速间隔。
pub async fn index_folders(
    app: &tauri::AppHandle,
    provider: &Cloud115Provider,
    repository: &LibraryRepository,
    folder_ids: &[String],
) -> Result<Vec<ComicsOverview>, String> {
    if folder_ids.len() > INDEX_BATCH_LIMIT {
        return Err(format!("单次批量索引最多 {INDEX_BATCH_LIMIT} 个目录"));
    }
    if folder_ids.is_empty() {
        return Err("请选择要批量索引的目录".to_string());
    }
    let mut overviews = Vec::with_capacity(folder_ids.len());
    for folder_id in folder_ids {
        overviews.push(recognize_comics(app, provider, repository, folder_id).await?);
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    Ok(overviews)
}

/// 汇总本机已持久化的全部目录索引：按系列名合并为一个书架，并补充缓存的封面路径。
pub fn index_summary(
    app: &tauri::AppHandle,
    repository: &LibraryRepository,
) -> Result<ComicsIndexSummary, String> {
    let rows = repository.list_comics_indexes()?;
    let cache_root = comics_cache_root(app)?;
    let mut overviews = Vec::with_capacity(rows.len());
    for row in &rows {
        let overview: ComicsOverview = serde_json::from_str(&row.payload_json)
            .map_err(|error| format!("解析漫画索引失败（{}）：{error}", row.folder_id))?;
        overviews.push(overview);
    }
    Ok(ComicsIndexSummary {
        folder_count: rows.len(),
        last_scanned_at: rows
            .iter()
            .map(|row| row.scanned_at.as_str())
            .max()
            .unwrap_or_default()
            .to_string(),
        series: merge_series(&cache_root, overviews),
    })
}

/// 合并多个目录索引为统一书架：同系列聚合卷，封面路径按本机缓存补齐。
fn merge_series(cache_root: &Path, overviews: Vec<ComicsOverview>) -> Vec<ComicsSeriesGroup> {
    let mut merged: BTreeMap<String, ComicsSeriesGroup> = BTreeMap::new();
    for overview in overviews {
        for mut group in overview.series {
            enrich_covers(cache_root, std::slice::from_mut(&mut group));
            let entry = merged
                .entry(group.title.clone())
                .or_insert_with(|| ComicsSeriesGroup {
                    title: group.title.clone(),
                    volume_count: 0,
                    total_bytes: 0,
                    volumes: Vec::new(),
                });
            entry.volumes.append(&mut group.volumes);
        }
    }
    let mut series: Vec<ComicsSeriesGroup> = merged.into_values().collect();
    for group in &mut series {
        group.volumes.sort_by(|a, b| a.name.cmp(&b.name));
        group.volume_count = group.volumes.len();
        group.total_bytes = group.volumes.iter().map(|volume| volume.size_bytes).sum();
    }
    series
}

/// 漫画缓存根目录；所有封面与页图都居住在它的预算淘汰范围内。
fn comics_cache_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("定位漫画缓存目录失败：{error}"))?
        .join("comics"))
}

/// 为有封面缓存的卷补齐 cover 路径；封面缩略图与页图同住一个受预算淘汰的卷目录。
fn enrich_covers(cache_root: &Path, groups: &mut [ComicsSeriesGroup]) {
    for group in groups {
        for volume in &mut group.volumes {
            let Ok(safe_id) = sanitize_remote_file_name(&volume.file_id) else {
                continue;
            };
            let cover = cache_root.join(safe_id).join("cover.jpg");
            if cover.is_file() {
                volume.cover_path = Some(cover.to_string_lossy().into_owned());
            }
        }
    }
}

/// 从已解压的第一页生成有界封面缩略图；无法解码的格式回退为复制原图。
/// 封面是装饰性缓存：失败不阻断阅读，索引补齐时按文件实际存在性判断。
fn generate_cover(pages: &[String], volume_dir: &Path) -> Result<bool, String> {
    let Some(first_page) = pages.first() else {
        return Ok(false);
    };
    let cover_path = volume_dir.join("cover.jpg");
    if cover_path.is_file() {
        return Ok(true);
    }
    if let Ok(image) = image::open(first_page) {
        let thumbnail = image.thumbnail(COVER_MAX_WIDTH, COVER_MAX_WIDTH);
        thumbnail
            .save_with_format(&cover_path, image::ImageFormat::Jpeg)
            .map_err(|error| format!("写入封面缩略图失败：{error}"))?;
        return Ok(true);
    }
    // 解码失败（如 HEIC/AVIF）：回退为复制原图作为封面。
    std::fs::copy(first_page, &cover_path)
        .map(|_| true)
        .map_err(|error| format!("复制封面失败：{error}"))
}

/// 纯分组逻辑：从目录快照构建识别结果，BTreeMap 保证输出顺序稳定。
fn group_comics(entries: &[Cloud115FileEntry], folder_id: &str, truncated: bool) -> ComicsOverview {
    let mut groups: BTreeMap<String, Vec<ComicsVolume>> = BTreeMap::new();
    let mut loose_image_count = 0usize;
    let mut skipped_count = 0usize;
    for entry in entries {
        let extension = entry.extension.to_lowercase();
        if ARCHIVE_EXTENSIONS.contains(&extension.as_str()) {
            let stem = entry
                .name
                .strip_suffix(&entry.extension)
                .map(|value| value.trim_end_matches('.'))
                .unwrap_or(&entry.name);
            groups
                .entry(parse_series_title(stem))
                .or_default()
                .push(ComicsVolume {
                    file_id: entry.id.clone(),
                    pick_code: entry.pick_code.clone(),
                    name: entry.name.clone(),
                    size_bytes: entry.size_bytes,
                    cover_path: None,
                });
        } else if IMAGE_EXTENSIONS.contains(&extension.as_str()) {
            loose_image_count += 1;
        } else {
            skipped_count += 1;
        }
    }
    let series = groups
        .into_iter()
        .map(|(title, mut volumes)| {
            volumes.sort_by(|a, b| a.name.cmp(&b.name));
            let total_bytes = volumes.iter().map(|volume| volume.size_bytes).sum();
            let volume_count = volumes.len();
            ComicsSeriesGroup {
                title,
                volume_count,
                total_bytes,
                volumes,
            }
        })
        .collect();
    ComicsOverview {
        folder_id: folder_id.to_string(),
        scanned_count: entries.len(),
        truncated,
        series,
        loose_image_count,
        skipped_count,
    }
}

/// 前端提交的打开请求；size_bytes 用于下载续传与缓存校验。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicOpenInput {
    pub file_id: String,
    pub pick_code: String,
    pub file_name: String,
    pub series_title: String,
    pub size_bytes: u64,
}

/// 一次阅读会话：解压后的页图路径、页数与续读页码。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicSession {
    pub file_id: String,
    pub series_title: String,
    pub pages: Vec<String>,
    pub page_count: usize,
    pub resume_page_index: usize,
}

/// 打开漫画卷：命中本地缓存则跳过下载；否则断点续传下载到有界缓存并解压出页图。
pub async fn open_volume(
    app: &tauri::AppHandle,
    provider: &Cloud115Provider,
    repository: &LibraryRepository,
    input: &ComicOpenInput,
) -> Result<ComicSession, String> {
    let extension = Path::new(&input.file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !READER_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!(
            "阅读器目前支持 CBZ/ZIP，暂不支持「.{extension}」格式"
        ));
    }
    let file_id = sanitize_remote_file_name(&input.file_id)?;
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("定位漫画缓存目录失败：{error}"))?
        .join("comics");
    let volume_dir = cache_root.join(&file_id);
    let archive_name = format!("source.{extension}");
    let archive_path = volume_dir.join(&archive_name);

    // 目录准备与缓存命中检查在阻塞线程完成；marker 文件的修改时间兼作 LRU 依据。
    let archive_ready = tokio::task::spawn_blocking({
        let volume_dir = volume_dir.clone();
        move || -> Result<bool, String> {
            std::fs::create_dir_all(&volume_dir)
                .map_err(|error| format!("创建漫画缓存目录失败：{error}"))?;
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "系统时钟异常".to_string())?
                .as_millis()
                .to_string();
            std::fs::write(volume_dir.join("lastopen"), stamp)
                .map_err(|error| format!("更新漫画缓存标记失败：{error}"))?;
            Ok(volume_dir.join("pages").is_dir())
        }
    })
    .await
    .map_err(|error| format!("漫画缓存准备线程异常终止：{error}"))??;

    if !archive_ready {
        // 未下载：走断点续传下载（磁盘满、签名过期等错误显式返回，保留 .sirius-part 进度）。
        // 漫画缓存属于内部取数，不进入任务中心进度事件，回调传 None。
        provider
            .download_file(
                &input.pick_code,
                &volume_dir.to_string_lossy(),
                &archive_name,
                input.size_bytes,
                None,
            )
            .await?;
    }

    let pages = tokio::task::spawn_blocking({
        let archive_path = archive_path.clone();
        let volume_dir = volume_dir.clone();
        move || extract_pages(&archive_path, &volume_dir)
    })
    .await
    .map_err(|error| format!("漫画解压线程异常终止：{error}"))??;
    if pages.is_empty() {
        return Err("压缩包中没有找到可显示的图片".to_string());
    }

    // 封面缩略图：解压后生成一次（已有则复用）；失败不阻断阅读，索引按文件实际存在性补齐。
    tokio::task::spawn_blocking({
        let pages = pages.clone();
        let volume_dir = volume_dir.clone();
        move || generate_cover(&pages, &volume_dir)
    })
    .await
    .map_err(|error| format!("封面生成线程异常终止：{error}"))??;

    // 续读页码：本地进度有效则恢复，越界时回落到第一页。
    let resume_page_index = match repository.comics_progress(&input.file_id)? {
        Some((page_index, _)) if page_index >= 0 && (page_index as usize) < pages.len() => {
            page_index as usize
        }
        _ => 0,
    };

    tokio::task::spawn_blocking({
        let cache_root = cache_root.clone();
        let volume_dir = volume_dir.clone();
        move || enforce_cache_budget(&cache_root, &volume_dir, CACHE_BUDGET_BYTES)
    })
    .await
    .map_err(|error| format!("漫画缓存清理线程异常终止：{error}"))??;

    Ok(ComicSession {
        file_id: input.file_id.clone(),
        series_title: input.series_title.clone(),
        page_count: pages.len(),
        resume_page_index,
        pages,
    })
}

/// 解压页图：跳过 macOS 元数据与隐藏文件，按自然排序输出零填充页名。
fn extract_pages(archive_path: &Path, volume_dir: &Path) -> Result<Vec<String>, String> {
    let pages_dir = volume_dir.join("pages");
    // 缓存命中：pages 目录已有内容则直接列出，不重复解压。
    if pages_dir.is_dir() {
        let cached: Vec<String> = read_page_files(&pages_dir)?;
        if !cached.is_empty() {
            return Ok(cached);
        }
    }
    std::fs::create_dir_all(&pages_dir).map_err(|error| format!("创建页图目录失败：{error}"))?;

    let archive_file = std::fs::File::open(archive_path)
        .map_err(|error| format!("打开漫画压缩包失败：{error}"))?;
    let mut archive = zip::ZipArchive::new(archive_file)
        .map_err(|error| format!("解析漫画压缩包失败：{error}"))?;

    let mut image_indexes: Vec<(usize, String)> = Vec::new();
    for index in 0..archive.len() {
        let zip_file = archive
            .by_index(index)
            .map_err(|error| format!("读取压缩包条目失败：{error}"))?;
        if !zip_file.is_file() {
            continue;
        }
        let full_name = zip_file.name().to_string();
        let file_name = full_name
            .rsplit('/')
            .next()
            .unwrap_or(&full_name)
            .to_string();
        if full_name.starts_with("__MACOSX") || file_name.starts_with('.') {
            continue;
        }
        let extension = file_name.rsplit('.').next().unwrap_or("").to_lowercase();
        if IMAGE_EXTENSIONS.contains(&extension.as_str()) {
            image_indexes.push((index, file_name));
        }
    }
    image_names_sort(&mut image_indexes);

    let mut pages = Vec::with_capacity(image_indexes.len());
    for (target_index, (zip_index, file_name)) in image_indexes.iter().enumerate() {
        let extension = file_name.rsplit('.').next().unwrap_or("jpg");
        let target = pages_dir.join(format!("{:04}.{extension}", target_index + 1));
        let mut zip_file = archive
            .by_index(*zip_index)
            .map_err(|error| format!("读取压缩包条目失败：{error}"))?;
        let mut output =
            std::fs::File::create(&target).map_err(|error| format!("写入页图失败：{error}"))?;
        std::io::copy(&mut zip_file, &mut output)
            .map_err(|error| format!("解压页图失败：{error}"))?;
        pages.push(target.to_string_lossy().into_owned());
    }
    Ok(pages)
}

/// 列出已解压的页图；文件名零填充，按名称排序即页序。
fn read_page_files(pages_dir: &Path) -> Result<Vec<String>, String> {
    let mut pages = Vec::new();
    for dir_entry in
        std::fs::read_dir(pages_dir).map_err(|error| format!("读取页图目录失败：{error}"))?
    {
        let path = dir_entry
            .map_err(|error| format!("读取页图目录失败：{error}"))?
            .path();
        if path.is_file() {
            pages.push(path.to_string_lossy().into_owned());
        }
    }
    pages.sort();
    Ok(pages)
}

/// 按 lastopen 标记从旧到新淘汰卷目录（永不淘汰当前卷），直到缓存总量回到预算内。
fn enforce_cache_budget(cache_root: &Path, keep: &Path, budget: u64) -> Result<(), String> {
    let read_marker = |path: &Path| -> u64 {
        std::fs::read_to_string(path.join("lastopen"))
            .ok()
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(0)
    };
    let mut volumes: Vec<(u64, u64, PathBuf)> = Vec::new();
    let dir_entries = match std::fs::read_dir(cache_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取漫画缓存目录失败：{error}")),
    };
    for dir_entry in dir_entries {
        let path = match dir_entry {
            Ok(value) => value.path(),
            Err(_) => continue,
        };
        if !path.is_dir() {
            continue;
        }
        volumes.push((read_marker(&path), directory_size(&path), path));
    }
    let mut total: u64 = volumes.iter().map(|(_, size, _)| size).sum();
    if total <= budget {
        return Ok(());
    }
    volumes.sort_by_key(|(lastopen, _, _)| *lastopen);
    for (lastopen, size, path) in volumes {
        if total <= budget {
            break;
        }
        if path == keep {
            continue;
        }
        match std::fs::remove_dir_all(&path) {
            Ok(()) => {
                total = total.saturating_sub(size);
                let _ = lastopen;
            }
            // 单个目录删除失败不阻断阅读，留给下次打开时重试。
            Err(_) => continue,
        }
    }
    Ok(())
}

/// 递归统计目录大小；不可读的条目按 0 处理，不阻断淘汰决策。
fn directory_size(path: &Path) -> u64 {
    let mut total = 0;
    let Ok(dir_entries) = std::fs::read_dir(path) else {
        return 0;
    };
    for dir_entry in dir_entries.flatten() {
        let child = dir_entry.path();
        if child.is_dir() {
            total += directory_size(&child);
        } else if let Ok(metadata) = std::fs::metadata(&child) {
            total += metadata.len();
        }
    }
    total
}

/// 页图自然排序：数字段按数值比较，保证 page2 排在 page10 之前。
fn image_names_sort(image_indexes: &mut [(usize, String)]) {
    image_indexes.sort_by(|a, b| natural_cmp(&a.1, &b.1));
}

#[derive(Debug, PartialEq, Eq)]
enum NaturalChunk<'a> {
    Number(&'a str),
    Text(&'a str),
}

fn natural_chunks(value: &str) -> Vec<NaturalChunk<'_>> {
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut current_digits = false;
    for (index, ch) in value.char_indices() {
        let is_digit = ch.is_ascii_digit();
        if index > start && is_digit != current_digits {
            chunks.push(chunk_at(value, start, index, current_digits));
            start = index;
        }
        current_digits = is_digit;
    }
    if start < value.len() {
        chunks.push(chunk_at(value, start, value.len(), current_digits));
    }
    chunks
}

fn chunk_at<'a>(value: &'a str, start: usize, end: usize, digits: bool) -> NaturalChunk<'a> {
    if digits {
        NaturalChunk::Number(&value[start..end])
    } else {
        NaturalChunk::Text(&value[start..end])
    }
}

fn natural_cmp(a: &str, b: &str) -> Ordering {
    let a_chunks = natural_chunks(a);
    let b_chunks = natural_chunks(b);
    let mut index = 0;
    loop {
        match (a_chunks.get(index), b_chunks.get(index)) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(left), Some(right)) => {
                let ordering = match (left, right) {
                    (NaturalChunk::Number(a_num), NaturalChunk::Number(b_num)) => {
                        // 去掉前导零后，更长的数字串数值更大；数值相等时按原串字典序稳定排序。
                        let a_value = a_num.trim_start_matches('0');
                        let b_value = b_num.trim_start_matches('0');
                        a_value
                            .len()
                            .cmp(&b_value.len())
                            .then_with(|| a_value.cmp(b_value))
                            .then_with(|| a_num.cmp(b_num))
                    }
                    (NaturalChunk::Number(_), NaturalChunk::Text(_)) => Ordering::Less,
                    (NaturalChunk::Text(_), NaturalChunk::Number(_)) => Ordering::Greater,
                    (NaturalChunk::Text(a_text), NaturalChunk::Text(b_text)) => a_text.cmp(b_text),
                };
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
        }
        index += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_cover_downscales_first_page() {
        let volume_dir =
            std::env::temp_dir().join(format!("sirius-comics-cover-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&volume_dir);
        std::fs::create_dir_all(&volume_dir).unwrap();
        // 生成 800x600 的 PNG 首页。
        let first_page = volume_dir.join("page.png");
        image::RgbImage::from_pixel(800, 600, image::Rgb([90, 120, 200]))
            .save(&first_page)
            .unwrap();
        let pages = vec![first_page.to_string_lossy().into_owned()];
        assert!(generate_cover(&pages, &volume_dir).unwrap());
        let cover = image::open(volume_dir.join("cover.jpg")).unwrap();
        assert!(cover.width() <= 320 && cover.height() <= 320);
        // 幂等：已有封面直接复用。
        assert!(generate_cover(&pages, &volume_dir).unwrap());
        std::fs::remove_dir_all(&volume_dir).unwrap();
    }

    #[test]
    fn natural_cmp_orders_pages_numerically() {
        let mut names = vec![
            "page10.jpg".to_string(),
            "page2.jpg".to_string(),
            "001.jpg".to_string(),
            "2.jpg".to_string(),
            "封面.jpg".to_string(),
        ];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            names,
            vec!["001.jpg", "2.jpg", "page2.jpg", "page10.jpg", "封面.jpg"]
        );
    }

    #[test]
    fn enforce_cache_budget_evicts_least_recent_volumes() {
        let root = std::env::temp_dir().join(format!("sirius-comics-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (name, marker) in [("vol-a", 100), ("vol-b", 200), ("vol-c", 300)] {
            let path = root.join(name);
            std::fs::create_dir_all(&path).unwrap();
            std::fs::write(path.join("lastopen"), marker.to_string()).unwrap();
            std::fs::write(path.join("pages.bin"), vec![0u8; 10]).unwrap();
        }
        // 每卷 10 字节页文件 + 3 字节 marker = 13 字节，总量 39：预算 30 时只淘汰最旧的 vol-a。
        enforce_cache_budget(&root, &root.join("vol-c"), 30).unwrap();
        assert!(!root.join("vol-a").exists());
        assert!(root.join("vol-b").exists());
        assert!(root.join("vol-c").exists());

        // 预算 15：继续淘汰 vol-b，当前阅读的 vol-c 即使超预算也保留。
        enforce_cache_budget(&root, &root.join("vol-c"), 15).unwrap();
        assert!(!root.join("vol-b").exists());
        assert!(root.join("vol-c").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    fn entry(id: &str, name: &str, extension: &str, size_bytes: u64) -> Cloud115FileEntry {
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
            size_bytes,
            modified_at: 0,
            pick_code: String::new(),
            // 测试夹具不涉及内容去重，sha1 留空即可满足契约。
            sha1: String::new(),
            thumb_url: None,
            children: None,
        }
    }

    #[test]
    fn parse_series_title_strips_volume_markers() {
        assert_eq!(parse_series_title("一拳超人 第24卷"), "一拳超人");
        assert_eq!(parse_series_title("一拳超人 第０３話"), "一拳超人");
        assert_eq!(parse_series_title("进击的巨人(3)"), "进击的巨人");
        assert_eq!(parse_series_title("海贼王 Vol.99"), "海贼王");
        assert_eq!(parse_series_title("vinland saga v5"), "vinland saga");
        assert_eq!(parse_series_title("Doubts - 01"), "Doubts");
        // 无卷号标记的名称保持原样。
        assert_eq!(parse_series_title("北极星综述手册"), "北极星综述手册");
        // 全部被剥掉时回退到原名。
        assert_eq!(parse_series_title("99"), "99");
    }

    #[test]
    fn group_comics_classifies_and_groups_series() {
        let entries = vec![
            entry("1", "一拳超人 第01卷.cbz", "cbz", 100),
            entry("2", "一拳超人 第02卷.CBZ", "CBZ", 200),
            entry("3", "_notes.txt", "txt", 10),
            entry("4", "cover.jpg", "jpg", 5),
            entry("5", "已归档", "", 0),
        ];
        let overview = group_comics(&entries, "folder-1", true);
        assert_eq!(overview.scanned_count, 5);
        assert!(overview.truncated);
        assert_eq!(overview.series.len(), 1);
        assert_eq!(overview.series[0].title, "一拳超人");
        assert_eq!(overview.series[0].volume_count, 2);
        assert_eq!(overview.series[0].total_bytes, 300);
        assert_eq!(overview.series[0].volumes[0].name, "一拳超人 第01卷.cbz");
        assert_eq!(overview.loose_image_count, 1);
        assert_eq!(overview.skipped_count, 2);
    }
}
