use crate::cloud115::{
    sanitize_remote_file_name, Cloud115FileEntry, Cloud115FilePage, Cloud115FolderResult,
    Cloud115Provider,
};
use crate::library::{AiProviderSettings, LibraryRepository};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::time::Duration;

/// AI 整理密钥只存放在 macOS 钥匙串（开发构建使用 0600 临时文件），绝不进入 SQLite、日志或前端。
#[cfg(debug_assertions)]
const DEV_AI_KEY_FILE: &str = "sirius-desktop-ai-key-dev.txt";
#[cfg(all(not(debug_assertions), target_os = "macos"))]
const AI_KEYCHAIN_SERVICE: &str = "com.sirius.desktop.ai";
#[cfg(all(not(debug_assertions), target_os = "macos"))]
const AI_KEYCHAIN_ACCOUNT: &str = "provider-api-key";

/// 单次分析读取的目录条目上限；115 list_files 的协议上限是 200。
const ANALYZE_PAGE_LIMIT: u64 = 200;

/// 计划中一个建议项的动作；语义由 Rust 解释，模型输出永远不直接成为命令。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiPlanAction {
    Keep,
    Rename,
    Move,
    /// 建议删除文件；执行时由 Rust 强制走回收站语义。
    Delete,
}

/// 绑定到目录快照的整理建议；current_name 来自 Rust 读取的真实列表而非模型输出。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPlanItem {
    pub file_id: String,
    pub current_name: String,
    pub action: AiPlanAction,
    pub suggested_name: String,
    pub target_folder: String,
    pub reason: String,
}

/// 一次只读分析的完整结果；items 仅是建议，执行必须经过后续的显式确认步骤。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiOrganizationPlan {
    pub folder_id: String,
    pub analyzed_count: usize,
    pub truncated: bool,
    pub summary: String,
    pub model: String,
    pub items: Vec<AiPlanItem>,
}

/// 返回给前端的配置视图；密钥只暴露“是否已保存”，永不返回内容。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderSettingsView {
    pub base_url: String,
    pub model: String,
    pub key_stored: bool,
}

/// WebView 提交的配置更新；api_key 为 None 表示保持现有密钥。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderUpdateInput {
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}

#[cfg(debug_assertions)]
fn load_api_key() -> Result<Option<String>, String> {
    match std::fs::read_to_string(std::env::temp_dir().join(DEV_AI_KEY_FILE)) {
        Ok(value) => {
            let trimmed = value.trim().to_string();
            Ok((!trimmed.is_empty()).then_some(trimmed))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取开发模式 AI 密钥失败：{error}")),
    }
}

#[cfg(debug_assertions)]
fn save_api_key(api_key: &str) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let path = std::env::temp_dir().join(DEV_AI_KEY_FILE);
    let temporary_path = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&temporary_path)
        .map_err(|error| format!("创建开发模式 AI 密钥文件失败：{error}"))?;
    file.write_all(api_key.as_bytes())
        .map_err(|error| format!("写入开发模式 AI 密钥失败：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("同步开发模式 AI 密钥失败：{error}"))?;
    std::fs::rename(&temporary_path, &path)
        .map_err(|error| format!("保存开发模式 AI 密钥失败：{error}"))
}

#[cfg(all(not(debug_assertions), target_os = "macos"))]
fn load_api_key() -> Result<Option<String>, String> {
    match security_framework::passwords::get_generic_password(
        AI_KEYCHAIN_SERVICE,
        AI_KEYCHAIN_ACCOUNT,
    ) {
        Ok(bytes) => {
            let value =
                String::from_utf8(bytes).map_err(|_| "钥匙串中的 AI 密钥无效".to_string())?;
            let trimmed = value.trim().to_string();
            Ok((!trimmed.is_empty()).then_some(trimmed))
        }
        Err(error) if error.code() == -25300 => Ok(None),
        Err(error) => Err(format!("读取 macOS 钥匙串失败：{error}")),
    }
}

#[cfg(all(not(debug_assertions), target_os = "macos"))]
fn save_api_key(api_key: &str) -> Result<(), String> {
    security_framework::passwords::set_generic_password(
        AI_KEYCHAIN_SERVICE,
        AI_KEYCHAIN_ACCOUNT,
        api_key.as_bytes(),
    )
    .map_err(|error| format!("保存 AI 密钥到 macOS 钥匙串失败：{error}"))
}

/// 当前是否已保存服务商密钥；只返回布尔值。
pub fn stored_api_key() -> Result<bool, String> {
    Ok(load_api_key()?.is_some())
}

/// 读取已保存的 AI 密钥；未配置时返回带指引的错误。
/// 密钥值只允许进入请求的 Authorization 头，调用方不得记录或回传给前端。
pub fn require_api_key() -> Result<String, String> {
    load_api_key()?.ok_or_else(|| "尚未保存 AI 服务商密钥，请先在 AI 整理页完成配置".to_string())
}

/// 保存服务商配置并按需覆盖密钥；SQLite 与钥匙串写入都在调用方的阻塞线程执行。
pub fn persist_provider_settings(
    repository: &LibraryRepository,
    input: &AiProviderUpdateInput,
) -> Result<AiProviderSettingsView, String> {
    let settings = AiProviderSettings {
        base_url: input.base_url.trim().trim_end_matches('/').to_string(),
        model: input.model.trim().to_string(),
    };
    if let Some(api_key) = input.api_key.as_deref().map(str::trim) {
        if api_key.is_empty() {
            return Err("API 密钥不能为空；如需保留现有密钥请留空该字段".to_string());
        }
        save_api_key(api_key)?;
    }
    repository.update_ai_provider(&settings)?;
    Ok(AiProviderSettingsView {
        base_url: settings.base_url,
        model: settings.model,
        key_stored: stored_api_key()?,
    })
}

/// 只读分析链路：读取目录快照 → 调用模型 → 在 Rust 内逐项绑定与校验，返回纯建议数据。
pub async fn analyze_folder(
    provider: &Cloud115Provider,
    repository: &LibraryRepository,
    folder_id: &str,
) -> Result<AiOrganizationPlan, String> {
    let folder_id = folder_id.trim();
    if folder_id.is_empty() {
        return Err("请选择要分析的目录".to_string());
    }
    let settings = repository.ai_provider()?;
    let api_key = require_api_key()?;
    // 目录快照是计划的事实来源；后续执行步骤必须重新校验，不信任本快照之外的状态。
    let page = provider
        .list_files(folder_id, 0, ANALYZE_PAGE_LIMIT, "")
        .await?;
    if page.entries.is_empty() {
        return Err("该目录没有可分析的文件".to_string());
    }
    let content = request_plan(&settings, &api_key, &page.entries).await?;
    parse_plan(
        &content,
        &page.entries,
        folder_id,
        page.has_more,
        &settings.model,
    )
}

/// 调用 OpenAI 兼容的 chat/completions 接口；密钥只出现在 Authorization 头，错误信息不得回显密钥。
async fn request_plan(
    settings: &AiProviderSettings,
    api_key: &str,
    entries: &[Cloud115FileEntry],
) -> Result<String, String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| format!("初始化 AI 客户端失败：{error}"))?;
    let endpoint = format!(
        "{}/chat/completions",
        settings.base_url.trim_end_matches('/')
    );
    let mut listing = String::new();
    for entry in entries {
        listing.push_str(&format!(
            "- id={} 类型={} 名称={} 大小={}字节\n",
            entry.id,
            if entry.kind == "folder" {
                "文件夹"
            } else {
                "文件"
            },
            entry.name,
            entry.size_bytes
        ));
    }
    let system = "你是 115 网盘的文件整理助手。根据文件名推断内容，为每个文件给出整理建议。\
只输出一个 JSON 对象，不要输出任何其他文字，格式：\
{\"summary\":\"一句话总结\",\"items\":[{\"fileId\":\"文件id\",\"action\":\"keep|rename|move|delete\",\"suggestedName\":\"\",\"targetFolder\":\"\",\"reason\":\"简要理由\"}]}。\
规则：action 为 rename 时 suggestedName 填新文件名并保留扩展名；action 为 move 时 targetFolder 填目标文件夹名称；\
action 为 delete 表示建议把该文件移入回收站，仅当文件名明显显示其已损坏或完全重复时才允许使用，必须说明理由；\
不确定或名称已规范时用 keep；只能使用列表中出现的 fileId；文件夹只能用 keep。";
    let user = format!("目录文件列表（共 {} 项）：\n{listing}", entries.len());
    let body = serde_json::json!({
        "model": settings.model,
        "temperature": 0,
        "max_tokens": 4000,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ]
    });
    let response = client
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("连接 AI 服务商失败：{error}"))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("解析 AI 服务商响应失败：HTTP {status}；{error}"))?;
    if !status.is_success() {
        let detail = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("无详细信息");
        return Err(format!("AI 服务商返回 HTTP {status}：{detail}"));
    }
    payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "AI 服务商响应缺少 choices[0].message.content".to_string())
}

/// 去掉模型可能添加的 ```json 围栏。
fn strip_code_fence(raw: &str) -> &str {
    let trimmed = raw.trim();
    let Some(rest) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    let without_first_line = rest.split_once('\n').map(|(_, line)| line).unwrap_or("");
    without_first_line
        .trim_end()
        .strip_suffix("```")
        .unwrap_or(without_first_line)
        .trim()
}

/// 从模型输出解析计划并逐项绑定到目录快照；越权、重复与非法名称一律拒绝。
fn parse_plan(
    raw: &str,
    entries: &[Cloud115FileEntry],
    folder_id: &str,
    truncated: bool,
    model: &str,
) -> Result<AiOrganizationPlan, String> {
    let content = strip_code_fence(raw);
    let payload: Value = serde_json::from_str(content)
        .map_err(|error| format!("AI 返回的计划不是有效 JSON：{error}"))?;
    let items_value = payload
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| "AI 计划缺少 items 数组".to_string())?;
    let summary = payload
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();

    let snapshot: HashSet<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for (index, item) in items_value.iter().enumerate() {
        let file_id = text_field(item, "fileId")
            .ok_or_else(|| format!("AI 计划第 {} 项缺少 fileId", index + 1))?;
        if !snapshot.contains(file_id.as_str()) {
            return Err(format!(
                "AI 计划第 {} 项引用了目录中不存在的文件（{}），已整体拒绝",
                index + 1,
                file_id
            ));
        }
        if !seen.insert(file_id.clone()) {
            return Err(format!("AI 计划第 {} 项重复引用同一文件", index + 1));
        }
        let entry = entries
            .iter()
            .find(|entry| entry.id == file_id)
            .expect("file_id 已通过快照校验");
        let action = match item.get("action").and_then(Value::as_str) {
            Some("keep") => AiPlanAction::Keep,
            Some("rename") => AiPlanAction::Rename,
            Some("move") => AiPlanAction::Move,
            Some("delete") => AiPlanAction::Delete,
            _ => {
                return Err(format!(
                    "AI 计划第 {} 项的 action 不是 keep/rename/move/delete",
                    index + 1
                ))
            }
        };
        // 文件夹在本阶段只允许保持现状；重命名、移动与删除只对文件生效。
        let (suggested_name, target_folder) = match action {
            AiPlanAction::Keep => (String::new(), String::new()),
            AiPlanAction::Rename if entry.kind == "folder" => {
                return Err(format!(
                    "AI 计划第 {} 项试图重命名文件夹，已整体拒绝",
                    index + 1
                ))
            }
            AiPlanAction::Rename => (
                sanitize_remote_file_name(&text_field(item, "suggestedName").unwrap_or_default())
                    .map_err(|error| format!("AI 计划第 {} 项的新文件名无效：{error}", index + 1))?,
                String::new(),
            ),
            AiPlanAction::Move if entry.kind == "folder" => {
                return Err(format!(
                    "AI 计划第 {} 项试图移动文件夹，已整体拒绝",
                    index + 1
                ))
            }
            AiPlanAction::Move => {
                let target = text_field(item, "targetFolder")
                    .ok_or_else(|| format!("AI 计划第 {} 项缺少 targetFolder", index + 1))?;
                (
                    String::new(),
                    sanitize_remote_file_name(&target).map_err(|error| {
                        format!("AI 计划第 {} 项的目标文件夹无效：{error}", index + 1)
                    })?,
                )
            }
            AiPlanAction::Delete if entry.kind == "folder" => {
                return Err(format!(
                    "AI 计划第 {} 项试图删除文件夹，已整体拒绝",
                    index + 1
                ))
            }
            // 删除建议不需要额外名称字段；执行时由 Rust 强制走回收站。
            AiPlanAction::Delete => (String::new(), String::new()),
        };
        items.push(AiPlanItem {
            file_id,
            current_name: entry.name.clone(),
            action,
            suggested_name,
            target_folder,
            reason: item
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string(),
        });
    }

    Ok(AiOrganizationPlan {
        folder_id: folder_id.to_string(),
        analyzed_count: entries.len(),
        truncated,
        summary,
        model: model.to_string(),
        items,
    })
}

/// 读取模型输出对象中的非空字符串字段。
fn text_field(item: &Value, name: &str) -> Option<String> {
    item.get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// 前端确认后提交的执行项；current_name 必须与分析计划一致，用于执行前的重新绑定校验。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiExecutionItem {
    pub file_id: String,
    pub current_name: String,
    pub action: AiPlanAction,
    pub suggested_name: String,
    pub target_folder: String,
}

/// 显式确认请求；confirmed 不为 true 时策略引擎拒绝执行任何操作。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiExecutionRequest {
    pub folder_id: String,
    pub confirmed: bool,
    pub items: Vec<AiExecutionItem>,
}

/// 单个建议项的执行结果；status 为 done | skipped | failed。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiExecutionDetail {
    pub file_id: String,
    pub current_name: String,
    pub action: AiPlanAction,
    pub status: String,
    pub detail: String,
}

/// 确定性执行的结果报告。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiExecutionReport {
    pub executed: usize,
    pub skipped: usize,
    pub failed: usize,
    pub deleted_to_recycle_bin: usize,
    pub created_folders: usize,
    pub details: Vec<AiExecutionDetail>,
}

/// 重命名策略：仅文件、名称合法、不得与目录内其他条目重名；返回确定的新名称。
fn policy_rename(
    entry: &Cloud115FileEntry,
    suggested: &str,
    other_names: &HashSet<String>,
) -> Result<String, String> {
    if entry.kind == "folder" {
        return Err("策略拒绝：不允许重命名文件夹".to_string());
    }
    let new_name = sanitize_remote_file_name(suggested)?;
    if new_name == entry.name {
        return Err("策略拒绝：新名称与当前名称相同".to_string());
    }
    if other_names.contains(&new_name) {
        return Err(format!("策略拒绝：目录内已存在同名条目“{new_name}”"));
    }
    Ok(new_name)
}

/// 移动策略：仅文件、目标文件夹名称合法；返回目标文件夹名称，由调用方解析或创建。
fn policy_move_target(entry: &Cloud115FileEntry, target: &str) -> Result<String, String> {
    if entry.kind == "folder" {
        return Err("策略拒绝：不允许移动文件夹".to_string());
    }
    sanitize_remote_file_name(target)
}

/// 删除策略：仅文件；执行调用 115 删除接口，回收站语义由 115 服务端保证。
fn policy_delete(entry: &Cloud115FileEntry) -> Result<(), String> {
    if entry.kind == "folder" {
        return Err("策略拒绝：不允许删除文件夹".to_string());
    }
    Ok(())
}

/// 执行链路对 115 provider 的最小依赖面；独立成 trait 以便单元测试注入脚本化失败。
/// 返回值显式标注 `+ Send`，保证 execute_plan 的 future 满足 Tauri 命令的 Send 约束。
trait ExecutionProvider {
    fn list_files(
        &self,
        parent_id: &str,
        offset: u64,
        limit: u64,
        query: &str,
    ) -> impl Future<Output = Result<Cloud115FilePage, String>> + Send;

    fn update_file(
        &self,
        file_id: &str,
        name: Option<&str>,
        starred: Option<bool>,
    ) -> impl Future<Output = Result<(), String>> + Send;

    fn move_files(
        &self,
        file_ids: &[String],
        target_id: &str,
    ) -> impl Future<Output = Result<(), String>> + Send;

    fn delete_files(&self, file_ids: &[String]) -> impl Future<Output = Result<(), String>> + Send;

    fn create_folder(
        &self,
        parent_id: &str,
        name: &str,
    ) -> impl Future<Output = Result<Cloud115FolderResult, String>> + Send;
}

impl ExecutionProvider for Cloud115Provider {
    fn list_files(
        &self,
        parent_id: &str,
        offset: u64,
        limit: u64,
        query: &str,
    ) -> impl Future<Output = Result<Cloud115FilePage, String>> + Send {
        Cloud115Provider::list_files(self, parent_id, offset, limit, query)
    }

    fn update_file(
        &self,
        file_id: &str,
        name: Option<&str>,
        starred: Option<bool>,
    ) -> impl Future<Output = Result<(), String>> + Send {
        Cloud115Provider::update_file(self, file_id, name, starred)
    }

    fn move_files(
        &self,
        file_ids: &[String],
        target_id: &str,
    ) -> impl Future<Output = Result<(), String>> + Send {
        Cloud115Provider::move_files(self, file_ids, target_id)
    }

    fn delete_files(&self, file_ids: &[String]) -> impl Future<Output = Result<(), String>> + Send {
        Cloud115Provider::delete_files(self, file_ids)
    }

    fn create_folder(
        &self,
        parent_id: &str,
        name: &str,
    ) -> impl Future<Output = Result<Cloud115FolderResult, String>> + Send {
        Cloud115Provider::create_folder(self, parent_id, name)
    }
}

/// 显式确认后的确定性执行。执行前重新读取目录快照并逐项重新绑定：
/// 文件必须仍在同一目录且名称与分析计划一致；重命名/移动/删除策略全部在 Rust 内强制执行。
pub async fn execute_plan(
    provider: &Cloud115Provider,
    request: &AiExecutionRequest,
) -> Result<AiExecutionReport, String> {
    execute_plan_with_provider(provider, request).await
}

/// 以任意 provider 实现执行计划；与 execute_plan 共享全部执行语义，供测试注入脚本化结果。
async fn execute_plan_with_provider<P: ExecutionProvider>(
    provider: &P,
    request: &AiExecutionRequest,
) -> Result<AiExecutionReport, String> {
    if !request.confirmed {
        return Err("执行被拒绝：缺少用户显式确认".to_string());
    }
    let folder_id = request.folder_id.trim();
    if folder_id.is_empty() {
        return Err("缺少执行目录".to_string());
    }
    if request.items.is_empty() {
        return Err("没有选择要执行的建议项".to_string());
    }
    let mut seen = HashSet::new();
    for item in &request.items {
        if !seen.insert(item.file_id.as_str()) {
            return Err(format!("执行请求重复引用文件 {}", item.file_id));
        }
    }

    // 执行前重新校验：绝不信任分析阶段的旧状态。
    let page = provider
        .list_files(folder_id, 0, ANALYZE_PAGE_LIMIT, "")
        .await?;
    let snapshot: HashMap<&str, &Cloud115FileEntry> = page
        .entries
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect();
    let mut known_names: HashSet<String> = page
        .entries
        .iter()
        .map(|entry| entry.name.clone())
        .collect();
    // 本轮执行中新建的目标文件夹：同名目标直接复用，避免重复创建。
    let mut created_folders: HashMap<String, String> = HashMap::new();

    let mut report = AiExecutionReport {
        executed: 0,
        skipped: 0,
        failed: 0,
        deleted_to_recycle_bin: 0,
        created_folders: 0,
        details: Vec::new(),
    };
    for item in &request.items {
        let mut detail = AiExecutionDetail {
            file_id: item.file_id.clone(),
            current_name: item.current_name.clone(),
            action: item.action,
            status: "failed".to_string(),
            detail: String::new(),
        };
        let entry = match snapshot.get(item.file_id.as_str()) {
            Some(entry) => *entry,
            None => {
                detail.detail = "文件已不在该目录（可能已被移动或删除），请重新分析".to_string();
                report.failed += 1;
                report.details.push(detail);
                continue;
            }
        };
        if entry.name != item.current_name {
            detail.detail = "文件名已与计划不一致，请重新分析后再执行".to_string();
            report.failed += 1;
            report.details.push(detail);
            continue;
        }
        // 顺序执行并在写操作之间留出间隔，与 115 控制面限速保持安全距离。
        let mut mutated = false;
        match item.action {
            AiPlanAction::Keep => {
                detail.status = "skipped".to_string();
                detail.detail = "保持现状，无需执行".to_string();
                report.skipped += 1;
            }
            AiPlanAction::Rename => {
                match policy_rename(entry, &item.suggested_name, &known_names) {
                    Ok(new_name) => {
                        match provider
                            .update_file(&item.file_id, Some(&new_name), None)
                            .await
                        {
                            Ok(()) => {
                                detail.status = "done".to_string();
                                detail.detail = format!("已重命名为“{new_name}”");
                                report.executed += 1;
                                known_names.remove(entry.name.as_str());
                                known_names.insert(new_name);
                                mutated = true;
                            }
                            Err(error) => {
                                report.failed += 1;
                                detail.detail = format!("重命名失败：{error}");
                            }
                        }
                    }
                    Err(error) => {
                        report.failed += 1;
                        detail.detail = error;
                    }
                }
            }
            AiPlanAction::Move => match policy_move_target(entry, &item.target_folder) {
                Ok(target_name) => {
                    let target = match created_folders.get(&target_name) {
                        Some(target_id) => Ok(target_id.clone()),
                        None => match page.entries.iter().find(|candidate| {
                            candidate.kind == "folder" && candidate.name == target_name
                        }) {
                            Some(folder) => Ok(folder.id.clone()),
                            None => provider.create_folder(folder_id, &target_name).await.map(
                                |folder| {
                                    created_folders.insert(target_name.clone(), folder.id.clone());
                                    // 只统计本次执行真实新建的文件夹；复用快照目录或本轮已建目录不重复计数。
                                    report.created_folders += 1;
                                    folder.id
                                },
                            ),
                        },
                    };
                    match target {
                        Ok(target_id) => {
                            match provider
                                .move_files(std::slice::from_ref(&item.file_id), &target_id)
                                .await
                            {
                                Ok(()) => {
                                    detail.status = "done".to_string();
                                    detail.detail = format!("已移动到“{target_name}”");
                                    report.executed += 1;
                                    mutated = true;
                                }
                                Err(error) => {
                                    report.failed += 1;
                                    detail.detail = format!("移动失败：{error}");
                                }
                            }
                        }
                        Err(error) => {
                            report.failed += 1;
                            detail.detail = format!("准备目标文件夹失败：{error}");
                        }
                    }
                }
                Err(error) => {
                    report.failed += 1;
                    detail.detail = error;
                }
            },
            AiPlanAction::Delete => match policy_delete(entry) {
                Ok(()) => match provider
                    .delete_files(std::slice::from_ref(&item.file_id))
                    .await
                {
                    Ok(()) => {
                        detail.status = "done".to_string();
                        detail.detail = "已移入回收站，可在 115 回收站还原".to_string();
                        report.executed += 1;
                        report.deleted_to_recycle_bin += 1;
                        mutated = true;
                    }
                    Err(error) => {
                        report.failed += 1;
                        detail.detail = format!("删除失败：{error}");
                    }
                },
                Err(error) => {
                    report.failed += 1;
                    detail.detail = error;
                }
            },
        }
        if mutated {
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        report.details.push(detail);
    }
    // 不变量：明细中 status 为 failed 的条数必须等于顶层 failed 计数，保证汇总与明细一致。
    debug_assert_eq!(
        report
            .details
            .iter()
            .filter(|detail| detail.status == "failed")
            .count(),
        report.failed,
        "执行报告 failed 计数与明细不一致"
    );
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execution_policies_enforce_scope_names_and_bindings() {
        let video = entry("v1", "a.mkv", "video");
        let folder = entry("d1", "已归档", "folder");
        let names: HashSet<String> = ["a.mkv".to_string(), "b.mkv".to_string()].into();

        // 重命名：合法、同名拒绝、目录内重名拒绝、文件夹拒绝、路径穿越拒绝。
        assert_eq!(
            policy_rename(&video, "b - new.mkv", &names).unwrap(),
            "b - new.mkv"
        );
        assert!(policy_rename(&video, "a.mkv", &names).is_err());
        assert!(policy_rename(&video, "b.mkv", &names).is_err());
        assert!(policy_rename(&folder, "x.mkv", &names).is_err());
        assert!(policy_rename(&video, "../evil.mkv", &names).is_err());

        // 移动：合法目标、文件夹拒绝。
        assert_eq!(policy_move_target(&video, "纪录片").unwrap(), "纪录片");
        assert!(policy_move_target(&folder, "纪录片").is_err());

        // 删除：文件允许、文件夹拒绝。
        assert!(policy_delete(&video).is_ok());
        assert!(policy_delete(&folder).is_err());
    }

    #[test]
    fn execute_plan_rejects_missing_confirmation_or_empty_items() {
        // 两个前置校验都必须发生在任何网络调用之前。
        tauri::async_runtime::block_on(async {
            let provider = Cloud115Provider::new().expect("provider should initialize");
            let unconfirmed = AiExecutionRequest {
                folder_id: "0".to_string(),
                confirmed: false,
                items: vec![],
            };
            assert!(execute_plan(&provider, &unconfirmed).await.is_err());
            let empty = AiExecutionRequest {
                folder_id: "0".to_string(),
                confirmed: true,
                items: vec![],
            };
            assert!(execute_plan(&provider, &empty).await.is_err());
        });
    }

    fn entry(id: &str, name: &str, kind: &str) -> Cloud115FileEntry {
        Cloud115FileEntry {
            id: id.to_string(),
            parent_id: "0".to_string(),
            name: name.to_string(),
            kind: kind.to_string(),
            extension: String::new(),
            size_bytes: 1024,
            modified_at: 0,
            pick_code: String::new(),
            thumb_url: None,
            children: None,
        }
    }

    fn sample_entries() -> Vec<Cloud115FileEntry> {
        vec![
            entry("f1", "IMG_20240101.mp4", "video"),
            entry("f2", "纪录片.地球脉动.S01E01.mkv", "video"),
            entry("f3", "笔记.txt", "file"),
            entry("d1", "已归档", "folder"),
        ]
    }

    #[test]
    fn parse_plan_binds_items_to_folder_snapshot() {
        let raw = r#"{"summary":"整理影像文件","items":[
            {"fileId":"f2","action":"rename","suggestedName":"地球脉动 S01E01.mkv","reason":"去除杂乱标点"},
            {"fileId":"f1","action":"move","targetFolder":"旅行视频","reason":"按主题归类"},
            {"fileId":"d1","action":"keep","reason":"目录保持不动"}
        ]}"#;
        let plan = parse_plan(raw, &sample_entries(), "folder-1", true, "test-model").unwrap();
        assert_eq!(plan.analyzed_count, 4);
        assert!(plan.truncated);
        assert_eq!(plan.model, "test-model");
        assert_eq!(plan.items.len(), 3);
        // current_name 来自 Rust 快照而非模型输出，保证计划与真实文件绑定。
        assert_eq!(plan.items[0].current_name, "纪录片.地球脉动.S01E01.mkv");
        assert_eq!(plan.items[0].action, AiPlanAction::Rename);
        assert_eq!(plan.items[0].suggested_name, "地球脉动 S01E01.mkv");
        assert_eq!(plan.items[1].action, AiPlanAction::Move);
        assert_eq!(plan.items[1].target_folder, "旅行视频");
        assert_eq!(plan.items[2].action, AiPlanAction::Keep);
    }

    #[test]
    fn parse_plan_strips_code_fence() {
        let raw = "```json\n{\"summary\":\"\",\"items\":[]}\n```";
        let plan = parse_plan(raw, &sample_entries(), "folder-1", false, "m").unwrap();
        assert!(plan.items.is_empty());
        assert!(plan.summary.is_empty());
    }

    #[test]
    fn parse_plan_rejects_out_of_snapshot_and_invalid_items() {
        let entries = sample_entries();
        // 未知 fileId：模型不得引用目录之外的文件。
        let raw = r#"{"items":[{"fileId":"ghost","action":"keep","reason":""}]}"#;
        assert!(parse_plan(raw, &entries, "fd", false, "m").is_err());
        // 非法 action。
        let raw = r#"{"items":[{"fileId":"f1","action":"archive","reason":""}]}"#;
        assert!(parse_plan(raw, &entries, "fd", false, "m").is_err());
        // 对文件的建议删除合法；对文件夹的删除仍然拒绝。
        let raw = r#"{"items":[{"fileId":"f1","action":"delete","reason":"完全重复"}]}"#;
        assert!(parse_plan(raw, &entries, "fd", false, "m").is_ok());
        let raw = r#"{"items":[{"fileId":"d1","action":"delete","reason":"清理空目录"}]}"#;
        assert!(parse_plan(raw, &entries, "fd", false, "m").is_err());
        // 重命名携带路径穿越。
        let raw = r#"{"items":[{"fileId":"f1","action":"rename","suggestedName":"../evil.mp4","reason":""}]}"#;
        assert!(parse_plan(raw, &entries, "fd", false, "m").is_err());
        // 移动文件夹超出本阶段语义。
        let raw = r#"{"items":[{"fileId":"d1","action":"move","targetFolder":"x","reason":""}]}"#;
        assert!(parse_plan(raw, &entries, "fd", false, "m").is_err());
        // 重复引用同一文件。
        let raw = r#"{"items":[{"fileId":"f1","action":"keep","reason":""},{"fileId":"f1","action":"keep","reason":""}]}"#;
        assert!(parse_plan(raw, &entries, "fd", false, "m").is_err());
        // 非 JSON 输出。
        assert!(parse_plan("不是 JSON", &entries, "fd", false, "m").is_err());
    }

    /// 脚本化 provider：目录快照固定，写操作按文件 ID 返回预置结果（未预置的默认成功），
    /// 用于离线驱动 execute_plan 的各失败分支。
    struct ScriptedProvider {
        snapshot: Vec<Cloud115FileEntry>,
        update_outcomes: HashMap<String, Result<(), String>>,
        move_outcomes: HashMap<String, Result<(), String>>,
        delete_outcomes: HashMap<String, Result<(), String>>,
        create_folder_outcome: Option<Result<Cloud115FolderResult, String>>,
    }

    impl ExecutionProvider for ScriptedProvider {
        fn list_files(
            &self,
            _parent_id: &str,
            _offset: u64,
            _limit: u64,
            _query: &str,
        ) -> impl Future<Output = Result<Cloud115FilePage, String>> + Send {
            let entries = self.snapshot.clone();
            let total = entries.len() as u64;
            async move {
                Ok(Cloud115FilePage {
                    entries,
                    total,
                    offset: 0,
                    limit: 200,
                    has_more: false,
                })
            }
        }

        fn update_file(
            &self,
            file_id: &str,
            _name: Option<&str>,
            _starred: Option<bool>,
        ) -> impl Future<Output = Result<(), String>> + Send {
            let outcome = self.update_outcomes.get(file_id).cloned().unwrap_or(Ok(()));
            async move { outcome }
        }

        fn move_files(
            &self,
            file_ids: &[String],
            _target_id: &str,
        ) -> impl Future<Output = Result<(), String>> + Send {
            let outcome = file_ids
                .first()
                .and_then(|file_id| self.move_outcomes.get(file_id))
                .cloned()
                .unwrap_or(Ok(()));
            async move { outcome }
        }

        fn delete_files(
            &self,
            file_ids: &[String],
        ) -> impl Future<Output = Result<(), String>> + Send {
            let outcome = file_ids
                .first()
                .and_then(|file_id| self.delete_outcomes.get(file_id))
                .cloned()
                .unwrap_or(Ok(()));
            async move { outcome }
        }

        fn create_folder(
            &self,
            _parent_id: &str,
            name: &str,
        ) -> impl Future<Output = Result<Cloud115FolderResult, String>> + Send {
            let outcome = self.create_folder_outcome.clone().unwrap_or_else(|| {
                Ok(Cloud115FolderResult {
                    id: format!("created-{name}"),
                    name: name.to_string(),
                })
            });
            async move { outcome }
        }
    }

    fn scripted_provider(snapshot: Vec<Cloud115FileEntry>) -> ScriptedProvider {
        ScriptedProvider {
            snapshot,
            update_outcomes: HashMap::new(),
            move_outcomes: HashMap::new(),
            delete_outcomes: HashMap::new(),
            create_folder_outcome: None,
        }
    }

    fn execution_item(
        file_id: &str,
        current_name: &str,
        action: AiPlanAction,
        suggested_name: &str,
        target_folder: &str,
    ) -> AiExecutionItem {
        AiExecutionItem {
            file_id: file_id.to_string(),
            current_name: current_name.to_string(),
            action,
            suggested_name: suggested_name.to_string(),
            target_folder: target_folder.to_string(),
        }
    }

    fn execution_request(items: Vec<AiExecutionItem>) -> AiExecutionRequest {
        AiExecutionRequest {
            folder_id: "folder-1".to_string(),
            confirmed: true,
            items,
        }
    }

    /// 断言 execute_plan 的核心不变量：顶层 failed 计数必须等于明细中 status 为 failed 的条数。
    fn assert_failed_count_matches_details(report: &AiExecutionReport) {
        let failed_details = report
            .details
            .iter()
            .filter(|detail| detail.status == "failed")
            .count();
        assert_eq!(report.failed, failed_details, "failed 计数必须与明细一致");
    }

    #[test]
    fn execute_plan_counts_rename_provider_failure_as_failed() {
        tauri::async_runtime::block_on(async {
            let mut provider = scripted_provider(vec![entry("f1", "旧名.mp4", "video")]);
            provider
                .update_outcomes
                .insert("f1".to_string(), Err("网络中断".to_string()));
            let request = execution_request(vec![execution_item(
                "f1",
                "旧名.mp4",
                AiPlanAction::Rename,
                "新名.mp4",
                "",
            )]);
            let report = execute_plan_with_provider(&provider, &request)
                .await
                .unwrap();
            assert_eq!(report.executed, 0);
            assert_eq!(report.failed, 1);
            assert_eq!(report.details.len(), 1);
            assert_eq!(report.details[0].status, "failed");
            assert!(report.details[0].detail.contains("重命名失败"));
            assert!(report.details[0].detail.contains("网络中断"));
            assert_failed_count_matches_details(&report);
        });
    }

    #[test]
    fn execute_plan_counts_move_target_preparation_failure_as_failed() {
        tauri::async_runtime::block_on(async {
            // 快照中不存在目标文件夹，执行时现场创建；创建失败必须计为失败。
            let mut provider = scripted_provider(vec![entry("f1", "旅行.raw", "file")]);
            provider.create_folder_outcome = Some(Err("创建文件夹失败".to_string()));
            let request = execution_request(vec![execution_item(
                "f1",
                "旅行.raw",
                AiPlanAction::Move,
                "",
                "纪录片",
            )]);
            let report = execute_plan_with_provider(&provider, &request)
                .await
                .unwrap();
            assert_eq!(report.executed, 0);
            assert_eq!(report.failed, 1);
            // 文件夹创建失败时不得计入新建数量。
            assert_eq!(report.created_folders, 0);
            assert_eq!(report.details[0].status, "failed");
            assert!(report.details[0].detail.contains("准备目标文件夹失败"));
            assert!(report.details[0].detail.contains("创建文件夹失败"));
            assert_failed_count_matches_details(&report);
        });
    }

    #[test]
    fn execute_plan_counts_delete_provider_failure_as_failed() {
        tauri::async_runtime::block_on(async {
            let mut provider = scripted_provider(vec![entry("f1", "损坏.mp4", "video")]);
            provider
                .delete_outcomes
                .insert("f1".to_string(), Err("删除被拒绝".to_string()));
            let request = execution_request(vec![execution_item(
                "f1",
                "损坏.mp4",
                AiPlanAction::Delete,
                "",
                "",
            )]);
            let report = execute_plan_with_provider(&provider, &request)
                .await
                .unwrap();
            assert_eq!(report.executed, 0);
            assert_eq!(report.failed, 1);
            assert_eq!(report.deleted_to_recycle_bin, 0);
            assert_eq!(report.details[0].status, "failed");
            assert!(report.details[0].detail.contains("删除失败"));
            assert!(report.details[0].detail.contains("删除被拒绝"));
            assert_failed_count_matches_details(&report);
        });
    }

    #[test]
    fn execute_plan_counts_policy_rejections_as_failed() {
        tauri::async_runtime::block_on(async {
            // 脚本化写操作默认成功：若计数来自 provider 失败而非策略拒绝，下方断言会失败。
            let provider = scripted_provider(vec![
                entry("f1", "a.mkv", "video"),
                entry("f2", "b.mkv", "video"),
                entry("d1", "已归档", "folder"),
                entry("d2", "已整理", "folder"),
            ]);
            let request = execution_request(vec![
                // 重命名与目录内已有条目重名。
                execution_item("f1", "a.mkv", AiPlanAction::Rename, "b.mkv", ""),
                // 文件夹不允许移动。
                execution_item("d1", "已归档", AiPlanAction::Move, "", "x"),
                // 文件夹不允许删除。
                execution_item("d2", "已整理", AiPlanAction::Delete, "", ""),
            ]);
            let report = execute_plan_with_provider(&provider, &request)
                .await
                .unwrap();
            assert_eq!(report.executed, 0);
            assert_eq!(report.failed, 3);
            assert_eq!(report.details.len(), 3);
            assert!(report.details[0].detail.contains("策略拒绝"));
            assert!(report.details[0].detail.contains("同名"));
            assert!(report.details[1].detail.contains("不允许移动文件夹"));
            assert!(report.details[2].detail.contains("不允许删除文件夹"));
            for detail in &report.details {
                assert_eq!(detail.status, "failed");
            }
            assert_failed_count_matches_details(&report);
        });
    }

    #[test]
    fn execute_plan_report_sums_mixed_success_failure_and_skips() {
        tauri::async_runtime::block_on(async {
            let mut provider = scripted_provider(vec![
                entry("f1", "IMG_20240101.mp4", "video"),
                entry("f2", "旅行.jpg", "file"),
                entry("f3", "未完成.doc", "file"),
                entry("f4", "raw_clip.mov", "video"),
                entry("f6", "微距虫鸣.wav", "file"),
                entry("d1", "已归档", "folder"),
            ]);
            provider
                .delete_outcomes
                .insert("f3".to_string(), Err("删除被拒绝".to_string()));
            let request = execution_request(vec![
                // 成功：重命名。
                execution_item(
                    "f1",
                    "IMG_20240101.mp4",
                    AiPlanAction::Rename,
                    "家庭视频 2024.mp4",
                    "",
                ),
                // 成功：移动并现场新建目标文件夹。
                execution_item("f4", "raw_clip.mov", AiPlanAction::Move, "", "旅行视频"),
                // 成功：移动复用本轮已新建的同名目标文件夹。
                execution_item("f6", "微距虫鸣.wav", AiPlanAction::Move, "", "旅行视频"),
                // 成功：删除到回收站。
                execution_item("f2", "旅行.jpg", AiPlanAction::Delete, "", ""),
                // 失败：provider 删除失败。
                execution_item("f3", "未完成.doc", AiPlanAction::Delete, "", ""),
                // 失败：文件已不在目录。
                execution_item("f5", "ghost.mp4", AiPlanAction::Delete, "", ""),
                // 跳过：保持现状。
                execution_item("d1", "已归档", AiPlanAction::Keep, "", ""),
            ]);
            let report = execute_plan_with_provider(&provider, &request)
                .await
                .unwrap();
            assert_eq!(report.executed, 4);
            assert_eq!(report.failed, 2);
            assert_eq!(report.skipped, 1);
            assert_eq!(report.deleted_to_recycle_bin, 1);
            // 两次移动共用同一个新建文件夹；去重复用不得重复计数。
            assert_eq!(report.created_folders, 1);
            assert_eq!(report.details.len(), 7);
            let statuses: Vec<&str> = report
                .details
                .iter()
                .map(|detail| detail.status.as_str())
                .collect();
            assert_eq!(
                statuses,
                vec!["done", "done", "done", "done", "failed", "failed", "skipped"]
            );
            assert!(report.details[4].detail.contains("删除失败"));
            assert!(report.details[5].detail.contains("文件已不在该目录"));
            assert_failed_count_matches_details(&report);
        });
    }
}
