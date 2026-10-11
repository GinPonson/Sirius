//! AI 多轮流式对话：`ai://chat-token` 事件契约、SSE 解码器、停止令牌与流式请求通道。
//!
//! 范围说明：本模块只负责「会话 + 流式通道」。对话即多轮 chat，不做 Rust 侧
//! function-calling 工具循环；页面上下文由前端随消息注入并随会话存档；
//! 目录整理计划的生成与执行继续走 `ai_analyze_folder` / `ai_execute_plan`，
//! 两条路径互不干扰（计划路径使用 JSON 输出与 temperature 0，对话路径为普通文本）。
//!
//! 事件负载（serde camelCase）与前端订阅契约逐字段对齐：
//! `{ sessionId, messageId, delta, done, error? }`。
//! 持久化只经 `LibraryRepository`；密钥只进入 Authorization 头，不进日志、事件或测试。

use crate::library::{AiChatMessageRow, AiProviderSettings, LibraryRepository};
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, OnceLock, PoisonError,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Notify;

/// WebView 事件通道名；前端按同一字符串订阅。
pub const AI_CHAT_TOKEN_EVENT: &str = "ai://chat-token";

/// 流式读取的空闲超时：连续这么久没有收到任何字节即判定流异常终止；
/// 同时保证停止令牌最迟在该间隔内被检查一次。
const CHUNK_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// 单条消息允许携带的页面上下文 JSON 上限；摘要必须有界，防止前端误传整页数据。
pub const MAX_CONTEXT_JSON_BYTES: usize = 32 * 1024;

/// 对话 system 提示：固定在 Rust 侧，与整理计划的 JSON 路径完全独立。
const CHAT_SYSTEM_PROMPT: &str = "你是 macOS 115 网盘客户端 Sirius 内置的文件助手，用简体中文简洁、准确地回答用户关于网盘文件整理、命名与归档的问题。你不能直接执行任何文件操作；如需整理目录，请提醒用户使用整理功能，所有改动都必须由用户在界面中显式确认后才会执行。";

/// 对话采样温度：比整理计划（temperature 0）略高，适合自然语言交流。
const CHAT_TEMPERATURE: f64 = 0.4;

/// `ai://chat-token` 事件负载；可空 error 字段在序列化时整体省略。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatTokenEvent {
    pub session_id: String,
    pub message_id: String,
    pub delta: String,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl AiChatTokenEvent {
    /// 进行中的增量事件。
    fn delta(session_id: &str, message_id: &str, delta: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            message_id: message_id.to_string(),
            delta: delta.to_string(),
            done: false,
            error: None,
        }
    }

    /// 终态事件：done 恒为 true，error 说明停止或失败原因（成功时缺省）。
    fn terminal(session_id: &str, message_id: &str, error: Option<String>) -> Self {
        Self {
            session_id: session_id.to_string(),
            message_id: message_id.to_string(),
            delta: String::new(),
            done: true,
            error,
        }
    }
}

/// `ai_chat_send` 的同步回执；流在后台继续，增量经 `ai://chat-token` 推送。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatSendReceipt {
    pub session_id: String,
    /// 助手消息 ID；在首个增量事件前确定，前端用它聚合 delta。
    pub message_id: String,
    /// 本次用户消息 ID，便于前端把乐观渲染的气泡与持久化行对齐。
    pub user_message_id: String,
}

/// 进程启动时的 Unix 毫秒时间戳；与进程内计数器一起生成不重复的 ID。
fn boot_unix_millis() -> u64 {
    static BOOT_MILLIS: OnceLock<u64> = OnceLock::new();
    *BOOT_MILLIS.get_or_init(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_millis() as u64)
            .unwrap_or(0)
    })
}

/// 用启动时间戳 + 进程内计数器生成 ID；不引入额外依赖。
fn next_id(prefix: &str) -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
    format!("{prefix}-{}-{sequence}", boot_unix_millis())
}

/// 生成对话会话 ID。
pub fn next_chat_session_id() -> String {
    next_id("chatsession")
}

/// 生成对话消息 ID。
pub fn next_chat_message_id() -> String {
    next_id("chatmsg")
}

/// 单条解析完成的 SSE 事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseItem {
    /// `choices[0].delta.content` 的文本增量。
    Delta(String),
    /// 服务端结束哨兵 `[DONE]`。
    Done,
}

/// OpenAI 兼容 SSE 流的字节级解码器。
///
/// 按行缓冲原始字节：完整的行以 `\n` 结尾，而多字节 UTF-8 字符不可能包含 `\n`，
/// 因此先按字节切分再解码是安全的；跨 chunk 断开的行保留在缓冲区里自动拼接。
/// 解析规则：`data:` 行累积为一个事件，空行触发分发，`:` 开头的注释行忽略，
/// 其余字段（event/id/retry 等）忽略。
#[derive(Debug, Default)]
pub struct SseDecoder {
    buffer: Vec<u8>,
    pending_data: Option<String>,
}

impl SseDecoder {
    /// 喂入一段原始字节，返回本次完整解析出的事件。
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<SseItem>, String> {
        self.buffer.extend_from_slice(chunk);
        let mut items = Vec::new();
        while let Some(position) = self.buffer.iter().position(|byte| *byte == b'\n') {
            // 连同换行符一起取出，随后按不含换行的行内容处理。
            let line_bytes: Vec<u8> = self.buffer.drain(..=position).collect();
            let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]);
            let line = line.trim_end_matches('\r');
            if let Some(item) = self.consume_line(line)? {
                items.push(item);
            }
        }
        Ok(items)
    }

    /// 流结束时调用：把缓冲区里不完整的尾行与尚未分发的事件处理掉。
    pub fn flush(&mut self) -> Result<Vec<SseItem>, String> {
        let mut items = Vec::new();
        if !self.buffer.is_empty() {
            let tail = String::from_utf8_lossy(&self.buffer)
                .trim_end_matches('\r')
                .to_string();
            self.buffer.clear();
            if let Some(item) = self.consume_line(&tail)? {
                items.push(item);
            }
        }
        if let Some(item) = self.dispatch()? {
            items.push(item);
        }
        Ok(items)
    }

    /// 处理一行字段；返回 Some 表示该行触发了一次事件分发。
    fn consume_line(&mut self, line: &str) -> Result<Option<SseItem>, String> {
        if line.is_empty() {
            return self.dispatch();
        }
        if let Some(field) = line.strip_prefix("data:") {
            // SSE 规定字段值至多带一个前导空格；有无空格都必须解析。
            let value = field.strip_prefix(' ').unwrap_or(field);
            if value.is_empty() {
                // 空的 data 字段没有可解析内容，直接忽略。
                return Ok(None);
            }
            match self.pending_data.as_mut() {
                Some(existing) => {
                    existing.push('\n');
                    existing.push_str(value);
                }
                None => self.pending_data = Some(value.to_string()),
            }
            return Ok(None);
        }
        // 注释行（以 : 开头）与其它字段一律忽略。
        Ok(None)
    }

    /// 分发当前累积的 data 字段；无待分发数据（连续空行）时返回 None。
    fn dispatch(&mut self) -> Result<Option<SseItem>, String> {
        let Some(data) = self.pending_data.take() else {
            return Ok(None);
        };
        parse_data_event(&data)
    }
}

/// 把一条完整的 data 载荷解析为事件；无法解析或服务端在流中报错时返回 Err。
fn parse_data_event(data: &str) -> Result<Option<SseItem>, String> {
    if data.trim() == "[DONE]" {
        return Ok(Some(SseItem::Done));
    }
    let payload: Value = serde_json::from_str(data).map_err(|error| {
        format!(
            "AI 流式响应包含无法解析的数据行：{error}；原文：{}",
            truncate_for_error(data)
        )
    })?;
    if let Some(message) = payload.pointer("/error/message").and_then(Value::as_str) {
        return Err(format!("AI 服务商在流中返回错误：{message}"));
    }
    let Some(delta) = payload
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
    else {
        // role 增量、finish_reason 增量等事件没有内容增量，直接忽略。
        return Ok(None);
    };
    Ok(Some(SseItem::Delta(delta.to_string())))
}

/// 错误信息中的原文截断上限，避免超长载荷刷爆事件。
fn truncate_for_error(text: &str) -> String {
    const LIMIT: usize = 120;
    if text.chars().count() <= LIMIT {
        return text.to_string();
    }
    let truncated: String = text.chars().take(LIMIT).collect();
    format!("{truncated}…")
}

/// 单个进行中对话流的停止令牌。
///
/// 故意不使用 `JoinHandle::abort()` 硬中断：abort 会在任意 await 点直接杀死任务，
/// 已收到的部分回复无法持久化，终态事件也无法补发。这里改用协作式停止——
/// 流循环在每个字节块之间检查停止标志并监听 `Notify`，停止请求最迟在下一个
/// 字节块（或空闲超时）到来时生效，从而保证「持久化部分回复 + 恰好一次终态事件」。
#[derive(Default)]
pub struct ChatStreamStopper {
    stopped: AtomicBool,
    notify: Notify,
}

impl ChatStreamStopper {
    /// 请求停止当前流；幂等。
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        // notify_one 会保留许可：即使此刻没有任务在等待，下一次 poll 也会立即唤醒。
        self.notify.notify_one();
    }

    /// 是否已请求停止。
    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// 等待停止请求到达；与 `stop` 配对使用。
    async fn wait(&self) {
        self.notify.notified().await;
    }
}

/// 会话 → 进行中流的停止令牌登记表；支撑 `ai_chat_stop` 跨命令中断与并发发送互斥。
#[derive(Default)]
pub struct ChatStreamRegistry {
    active: Mutex<HashMap<String, Arc<ChatStreamStopper>>>,
}

impl ChatStreamRegistry {
    /// 为会话登记新的停止令牌；该会话已有进行中的流时返回错误。
    pub fn register(&self, session_id: &str) -> Result<Arc<ChatStreamStopper>, String> {
        let mut active = Self::lock(&self.active);
        if active.contains_key(session_id) {
            return Err("该会话正在回复中，请等待完成或先停止当前回复".to_string());
        }
        let stopper = Arc::new(ChatStreamStopper::default());
        active.insert(session_id.to_string(), Arc::clone(&stopper));
        Ok(stopper)
    }

    /// 请求停止会话当前流；返回是否存在进行中的流（流已自然结束后的迟到停止是良性竞争，返回 false）。
    pub fn stop(&self, session_id: &str) -> bool {
        let active = Self::lock(&self.active);
        match active.get(session_id) {
            Some(stopper) => {
                stopper.stop();
                true
            }
            None => false,
        }
    }

    /// 会话是否存在进行中的流。
    pub fn has_active(&self, session_id: &str) -> bool {
        Self::lock(&self.active).contains_key(session_id)
    }

    /// 流结束后注销令牌；未登记的会话注销是幂等的。
    pub fn unregister(&self, session_id: &str) {
        Self::lock(&self.active).remove(session_id);
    }

    /// 锁损坏时直接恢复内部数据：登记表只做登记，不值得为此拒绝服务。
    fn lock(
        mutex: &Mutex<HashMap<String, Arc<ChatStreamStopper>>>,
    ) -> MutexGuard<'_, HashMap<String, Arc<ChatStreamStopper>>> {
        mutex.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// 请求中的一条消息；role 为 "system" | "user" | "assistant"。
#[derive(Debug, Clone)]
pub struct AiChatTurn {
    pub role: String,
    pub content: String,
}

/// 把前端提交的页面上下文对象规范化为待存储的 JSON 字符串；缺省或 null 返回 None。
///
/// 上限校验在这里完成：上下文超限必须在任何持久化与网络调用之前失败。
pub fn context_to_json(context: Option<&Value>) -> Result<Option<String>, String> {
    match context {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let json = serde_json::to_string(value)
                .map_err(|error| format!("序列化页面上下文失败：{error}"))?;
            if json.len() > MAX_CONTEXT_JSON_BYTES {
                return Err(format!(
                    "页面上下文过大（{} 字节，上限 {} 字节），请只传摘要对象",
                    json.len(),
                    MAX_CONTEXT_JSON_BYTES
                ));
            }
            Ok(Some(json))
        }
    }
}

/// 由 system 提示、会话历史与本次输入组装请求消息序列。
///
/// 页面上下文快照（context_json）并入其所属的 user 消息文本，使上下文随消息
/// 位置固定、随会话存档，而不是污染整段 system 提示。
pub fn build_chat_turns(
    history: &[AiChatMessageRow],
    content: &str,
    context: Option<&Value>,
) -> Result<Vec<AiChatTurn>, String> {
    let mut turns = vec![AiChatTurn {
        role: "system".to_string(),
        content: CHAT_SYSTEM_PROMPT.to_string(),
    }];
    for row in history {
        turns.push(AiChatTurn {
            role: row.role.clone(),
            content: merge_context_json(&row.content, row.context_json.as_deref())?,
        });
    }
    let context_json = context_to_json(context)?;
    turns.push(AiChatTurn {
        role: "user".to_string(),
        content: merge_context_json(content, context_json.as_deref())?,
    });
    Ok(turns)
}

/// 把页面上下文 JSON 以清晰分段并入消息文本；历史消息与本次输入共用同一格式。
fn merge_context_json(content: &str, context_json: Option<&str>) -> Result<String, String> {
    let Some(json) = context_json else {
        return Ok(content.to_string());
    };
    let value: Value =
        serde_json::from_str(json).map_err(|error| format!("解析页面上下文快照失败：{error}"))?;
    let pretty = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("序列化页面上下文失败：{error}"))?;
    Ok(format!(
        "{content}\n\n[当前页面上下文]\n{pretty}\n[/当前页面上下文]"
    ))
}

/// 组装对话请求体：普通文本输出，不带 response_format/JSON 约束，
/// 与整理计划路径（temperature 0 + JSON 输出）互不干扰。
fn build_request_body(model: &str, turns: &[AiChatTurn]) -> Value {
    serde_json::json!({
        "model": model,
        "temperature": CHAT_TEMPERATURE,
        "stream": true,
        "messages": turns
            .iter()
            .map(|turn| serde_json::json!({"role": turn.role, "content": turn.content}))
            .collect::<Vec<Value>>(),
    })
}

/// 一次流式调用的结果；content 是累计文本（停止或失败时为已收到的部分）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatStreamOutcome {
    pub content: String,
    pub stopped: bool,
    pub error: Option<String>,
}

/// 驱动一次 OpenAI 兼容的流式对话。
///
/// 每个 content 增量回调 `on_delta`；返回的 outcome 携带累计文本与终态原因。
/// 密钥只进入 Authorization 头；错误信息不回显密钥。
pub async fn stream_chat(
    settings: &AiProviderSettings,
    api_key: &str,
    turns: &[AiChatTurn],
    stopper: &ChatStreamStopper,
    on_delta: impl FnMut(&str),
) -> ChatStreamOutcome {
    stream_chat_with(
        settings,
        api_key,
        turns,
        stopper,
        CHUNK_IDLE_TIMEOUT,
        on_delta,
    )
    .await
}

/// `stream_chat` 的可注入版本；空闲超时作为参数便于离线测试。
async fn stream_chat_with(
    settings: &AiProviderSettings,
    api_key: &str,
    turns: &[AiChatTurn],
    stopper: &ChatStreamStopper,
    idle_timeout: Duration,
    mut on_delta: impl FnMut(&str),
) -> ChatStreamOutcome {
    let mut response = match send_stream_request(settings, api_key, turns).await {
        Ok(response) => response,
        Err(error) => {
            return ChatStreamOutcome {
                content: String::new(),
                stopped: false,
                error: Some(error),
            }
        }
    };
    let mut decoder = SseDecoder::default();
    let mut content = String::new();

    // 循环的终点；Chunk 只表示继续读取。
    enum Step {
        Chunk,
        Eof,
        Stopped,
        Fatal(String),
    }

    let end = loop {
        // 每轮循环先检查停止标志：stop 的标志写入先于通知，这里能覆盖竞态窗口。
        if stopper.is_stopped() {
            break Step::Stopped;
        }
        // biased：停止请求优先于新的字节块，保证中断语义确定。
        let step = tokio::select! {
            biased;
            _ = stopper.wait() => Step::Stopped,
            chunk = tokio::time::timeout(idle_timeout, response.chunk()) => match chunk {
                // 空闲超时同时是停止令牌的兜底唤醒：流卡死时错误退出而非永久挂起。
                Err(_) => Step::Fatal(format!(
                    "AI 服务商响应中断：连续 {idle_timeout:?} 没有收到任何数据"
                )),
                Ok(Err(error)) => Step::Fatal(format!("AI 流式响应读取失败：{error}")),
                Ok(Ok(None)) => Step::Eof,
                Ok(Ok(Some(bytes))) => {
                    match decoder
                        .feed(bytes.as_ref())
                        .and_then(|items| deliver_items(items, &mut content, &mut on_delta))
                    {
                        Ok(false) => Step::Chunk,
                        Ok(true) => Step::Eof,
                        Err(error) => Step::Fatal(error),
                    }
                }
            },
        };
        match step {
            Step::Chunk => {}
            Step::Eof => {
                // 正常结束（或收到 [DONE]）：把残余的不完整行与未分发事件处理完。
                break match decoder
                    .flush()
                    .and_then(|items| deliver_items(items, &mut content, &mut on_delta))
                {
                    Ok(_) => Step::Eof,
                    Err(error) => Step::Fatal(error),
                };
            }
            other => break other,
        }
    };

    match end {
        // 停止不是失败：以 error=「已停止」告知前端按部分文本收尾。
        Step::Stopped => ChatStreamOutcome {
            content,
            stopped: true,
            error: Some("已停止".to_string()),
        },
        Step::Eof => ChatStreamOutcome {
            content,
            stopped: false,
            error: None,
        },
        Step::Fatal(error) => ChatStreamOutcome {
            content,
            stopped: false,
            error: Some(error),
        },
        Step::Chunk => unreachable!("Chunk 不是循环终点"),
    }
}

/// 把解析出的事件追加到累计文本并回调；返回是否已收到 [DONE]。
fn deliver_items(
    items: Vec<SseItem>,
    content: &mut String,
    on_delta: &mut impl FnMut(&str),
) -> Result<bool, String> {
    let mut done = false;
    for item in items {
        match item {
            SseItem::Delta(delta) => {
                if delta.is_empty() {
                    continue;
                }
                content.push_str(&delta);
                on_delta(&delta);
            }
            SseItem::Done => done = true,
        }
    }
    Ok(done)
}

/// 建立流式请求并返回响应；非 2xx 时读取错误详情后报错。
async fn send_stream_request(
    settings: &AiProviderSettings,
    api_key: &str,
    turns: &[AiChatTurn],
) -> Result<reqwest::Response, String> {
    // 流式客户端不设置整体超时：生成可能持续数分钟，空闲检测由读取循环负责。
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("初始化 AI 客户端失败：{error}"))?;
    let endpoint = format!(
        "{}/chat/completions",
        settings.base_url.trim_end_matches('/')
    );
    let response = client
        .post(&endpoint)
        .bearer_auth(api_key)
        .json(&build_request_body(&settings.model, turns))
        .send()
        .await
        .map_err(|error| format!("连接 AI 服务商失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        // 错误体通常是 JSON；尽量提取 error.message，失败时截断原文，绝不回显密钥。
        let detail = match response.text().await {
            Ok(text) => serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|value| {
                    value
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| truncate_for_error(&text)),
            Err(_) => "无法读取错误详情".to_string(),
        };
        return Err(format!("AI 服务商返回 HTTP {status}：{detail}"));
    }
    Ok(response)
}

/// 一次对话流任务的静态参数；会话与消息 ID 同时用于事件与持久化。
pub struct ChatStreamJob<'a> {
    pub settings: &'a AiProviderSettings,
    pub api_key: &'a str,
    pub turns: &'a [AiChatTurn],
    pub session_id: &'a str,
    pub message_id: &'a str,
}

/// 运行一次流式对话并完成终态：持久化助手回复、注销停止令牌、补发终态事件。
///
/// 持久化语义（本次 user 消息已在发送时持久化，这里只处理 assistant 侧）：
/// - 成功：写入完整回复；
/// - 停止：写入已收到的部分文本，终态事件 error=「已停止」；
/// - 失败：已收到部分文本时照常写入（保留现场），否则不写 assistant 行。
///
/// 事件序列恒为「若干 delta(done=false) → 恰好一次终态(done=true, error?)」。
pub async fn run_chat_stream(
    repository: &LibraryRepository,
    job: &ChatStreamJob<'_>,
    stopper: &ChatStreamStopper,
    registry: &ChatStreamRegistry,
    mut emit: impl FnMut(AiChatTokenEvent),
) {
    let ChatStreamJob {
        settings,
        api_key,
        turns,
        session_id,
        message_id,
    } = *job;
    let outcome = stream_chat(settings, api_key, turns, stopper, |delta| {
        emit(AiChatTokenEvent::delta(session_id, message_id, delta));
    })
    .await;

    // 终态归一：成功但没有任何内容也视为失败，避免持久化空消息。
    let mut terminal_error = match &outcome.error {
        None if outcome.content.is_empty() => Some("AI 没有返回内容".to_string()),
        other => other.clone(),
    };
    if !outcome.content.is_empty() {
        if let Err(error) = repository.append_ai_chat_message(
            message_id,
            session_id,
            "assistant",
            &outcome.content,
            None,
        ) {
            eprintln!("保存 AI 对话回复失败：{error}");
            terminal_error = Some(format!("保存对话回复失败：{error}"));
        }
    }

    // 先注销再发终态：前端收到 done 后立刻发起的下一轮发送不应被误判为并发。
    registry.unregister(session_id);
    emit(AiChatTokenEvent::terminal(
        session_id,
        message_id,
        terminal_error,
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::Mutex as StdMutex;
    use std::time::Instant;

    fn chat_turns() -> Vec<AiChatTurn> {
        vec![
            AiChatTurn {
                role: "system".to_string(),
                content: "sys".to_string(),
            },
            AiChatTurn {
                role: "user".to_string(),
                content: "hi".to_string(),
            },
        ]
    }

    #[test]
    fn sse_decoder_parses_deltas_done_and_ignores_noise() {
        let mut decoder = SseDecoder::default();
        // 注释行与空行必须被容忍。
        assert!(decoder.feed(b": keep-alive\n\n").unwrap().is_empty());
        // role 增量没有 content，必须被忽略；data: 后可以没有空格。
        let items = decoder
            .feed(
                concat!(
                    "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
                    "data:{\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n",
                )
                .as_bytes(),
            )
            .unwrap();
        assert_eq!(items, vec![SseItem::Delta("你".to_string())]);
        let items = decoder
            .feed("data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n".as_bytes())
            .unwrap();
        assert_eq!(items, vec![SseItem::Delta("好".to_string())]);
        let items = decoder.feed(b"data: [DONE]\n\n").unwrap();
        assert_eq!(items, vec![SseItem::Done]);
        assert!(decoder.flush().unwrap().is_empty());
    }

    #[test]
    fn sse_decoder_joins_lines_split_across_chunks() {
        let mut decoder = SseDecoder::default();
        let first = b"data: {\"choices\":[{\"delta\":{\"content\":\"ab";
        let second = b"c\"}}]}\n\ndata: [DONE]\n";
        // 第一段在 JSON 中间截断：不应产生任何事件。
        assert!(decoder.feed(&first[..10]).unwrap().is_empty());
        assert!(decoder.feed(&first[10..]).unwrap().is_empty());
        let items = decoder.feed(second).unwrap();
        assert_eq!(items, vec![SseItem::Delta("abc".to_string())]);
        // [DONE] 行缺少结尾空行：按 SSE 语义由 flush 分发。
        let items = decoder.flush().unwrap();
        assert_eq!(items, vec![SseItem::Done]);
    }

    #[test]
    fn sse_decoder_keeps_multibyte_characters_across_chunks() {
        let mut decoder = SseDecoder::default();
        let prefix = b"data: {\"choices\":[{\"delta\":{\"content\":\"";
        let rest = "\"}}]}\n\n".as_bytes();
        let mut payload = prefix.to_vec();
        payload.extend_from_slice("你好".as_bytes());
        payload.extend_from_slice(rest);
        // 把多字节字符「你」从中间切开：字节级缓冲必须保住 UTF-8 边界。
        let split = prefix.len() + 2;
        assert!(decoder.feed(&payload[..split]).unwrap().is_empty());
        let items = decoder.feed(&payload[split..]).unwrap();
        assert_eq!(items, vec![SseItem::Delta("你好".to_string())]);
    }

    #[test]
    fn sse_decoder_tolerates_crlf_and_flushes_tail_without_newline() {
        let mut decoder = SseDecoder::default();
        let items = decoder
            .feed(b"\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\r\n\r\n")
            .unwrap();
        assert_eq!(items, vec![SseItem::Delta("a".to_string())]);
        // 结尾没有换行符的 data 行也要在 flush 时分发。
        assert!(decoder
            .feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"b\"}}]}")
            .unwrap()
            .is_empty());
        let items = decoder.flush().unwrap();
        assert_eq!(items, vec![SseItem::Delta("b".to_string())]);
    }

    #[test]
    fn sse_decoder_rejects_invalid_payload_and_surfaces_stream_errors() {
        let mut decoder = SseDecoder::default();
        let error = decoder.feed(b"data: not-json\n\n").unwrap_err();
        assert!(error.contains("无法解析的数据行"));
        let mut decoder = SseDecoder::default();
        let error = decoder
            .feed("data: {\"error\":{\"message\":\"余额不足\"}}\n\n".as_bytes())
            .unwrap_err();
        assert!(error.contains("余额不足"));
    }

    #[test]
    fn chat_token_event_serializes_camel_case_and_skips_absent_error() {
        let event = AiChatTokenEvent {
            session_id: "s1".to_string(),
            message_id: "m1".to_string(),
            delta: "你".to_string(),
            done: false,
            error: None,
        };
        let payload = serde_json::to_string(&event).unwrap();
        assert!(payload.contains("\"sessionId\":\"s1\""));
        assert!(payload.contains("\"messageId\":\"m1\""));
        assert!(payload.contains("\"delta\":\"你\""));
        assert!(payload.contains("\"done\":false"));
        assert!(!payload.contains("error"));
        let terminal = AiChatTokenEvent {
            delta: String::new(),
            done: true,
            error: Some("已停止".to_string()),
            ..event
        };
        let payload = serde_json::to_string(&terminal).unwrap();
        assert!(payload.contains("\"done\":true"));
        assert!(payload.contains("\"error\":\"已停止\""));
    }

    #[test]
    fn chat_ids_are_unique_within_process() {
        assert!(next_chat_session_id().starts_with("chatsession-"));
        assert!(next_chat_message_id().starts_with("chatmsg-"));
        assert_ne!(next_chat_message_id(), next_chat_message_id());
    }

    #[test]
    fn build_chat_turns_merges_context_into_user_messages() {
        let history = vec![
            AiChatMessageRow {
                id: "m1".to_string(),
                session_id: "s1".to_string(),
                role: "user".to_string(),
                content: "帮我看看这个目录".to_string(),
                context_json: Some(r#"{"folderId":"123"}"#.to_string()),
                created_at: "2026-01-01 00:00:00".to_string(),
            },
            AiChatMessageRow {
                id: "m2".to_string(),
                session_id: "s1".to_string(),
                role: "assistant".to_string(),
                content: "这个目录包含 12 个视频".to_string(),
                context_json: None,
                created_at: "2026-01-01 00:00:01".to_string(),
            },
        ];
        let context = serde_json::json!({"folderId":"456","selected":["a.mkv"]});
        let turns = build_chat_turns(&history, "那推荐怎么命名？", Some(&context)).unwrap();
        assert_eq!(turns.len(), 4);
        assert_eq!(turns[0].role, "system");
        // 历史中的上下文快照并入其所属消息。
        assert!(turns[1].content.starts_with("帮我看看这个目录"));
        assert!(turns[1].content.contains("\"folderId\": \"123\""));
        assert_eq!(turns[2].role, "assistant");
        assert_eq!(turns[2].content, "这个目录包含 12 个视频");
        // 本次输入的上下文以清晰分段并入。
        assert!(turns[3].content.starts_with("那推荐怎么命名？"));
        assert!(turns[3].content.contains("[当前页面上下文]"));
        assert!(turns[3].content.contains("a.mkv"));
        // 无上下文与 null 上下文都保持原文。
        let turns = build_chat_turns(&[], "纯文本", None).unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[1].content, "纯文本");
        let turns = build_chat_turns(&[], "纯文本", Some(&Value::Null)).unwrap();
        assert_eq!(turns[1].content, "纯文本");
    }

    #[test]
    fn context_to_json_normalizes_and_enforces_size_cap() {
        let small = serde_json::json!({"page":"files"});
        assert_eq!(
            context_to_json(Some(&small)).unwrap().as_deref(),
            Some(r#"{"page":"files"}"#)
        );
        assert_eq!(context_to_json(None).unwrap(), None);
        assert_eq!(context_to_json(Some(&Value::Null)).unwrap(), None);
        let big = serde_json::json!({"blob": "x".repeat(MAX_CONTEXT_JSON_BYTES)});
        let error = context_to_json(Some(&big)).unwrap_err();
        assert!(error.contains("页面上下文过大"));
    }

    #[test]
    fn build_request_body_uses_plain_text_streaming_settings() {
        let body = build_request_body("test-model", &chat_turns());
        assert_eq!(body["model"], "test-model");
        assert_eq!(body["stream"], true);
        assert_eq!(body["temperature"], 0.4);
        // 对话请求不得携带 JSON 输出约束，与整理计划路径互不干扰。
        assert!(body.get("response_format").is_none());
        assert_eq!(body["messages"].as_array().unwrap().len(), 2);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["content"], "hi");
    }

    #[test]
    fn chat_stream_registry_serializes_send_and_stop() {
        let registry = ChatStreamRegistry::default();
        let stopper = registry.register("s1").unwrap();
        // 并发发送被拒绝；停止不存在的会话返回 false。
        assert!(registry.register("s1").is_err());
        assert!(registry.has_active("s1"));
        assert!(!registry.stop("ghost"));
        assert!(registry.stop("s1"));
        assert!(stopper.is_stopped());
        registry.unregister("s1");
        assert!(!registry.has_active("s1"));
        // 流结束后的迟到停止是良性竞争。
        assert!(!registry.stop("s1"));
    }

    /// 启动一个只服务一次连接的本地 HTTP 服务，按给定分片顺序写出响应；
    /// hold_after 用于写完后保持连接一段时间，驱动空闲超时与停止路径。
    fn serve_once(pieces: Vec<Vec<u8>>, hold_after: Option<Duration>) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("本地监听应可用");
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut buffer = [0u8; 2048];
            let _ = stream.read(&mut buffer);
            for piece in &pieces {
                if stream.write_all(piece).is_err() {
                    return;
                }
                let _ = stream.flush();
            }
            if let Some(hold) = hold_after {
                std::thread::sleep(hold);
            }
            drop(stream);
        });
        port
    }

    fn sse_headers() -> Vec<u8> {
        // 不带 Content-Length/分块声明：body 持续到连接关闭，reqwest 可直接读取。
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n".to_vec()
    }

    fn sse_delta(piece: &str) -> Vec<u8> {
        format!("data: {{\"choices\":[{{\"delta\":{{\"content\":\"{piece}\"}}}}]}}\n\n")
            .into_bytes()
    }

    fn chat_settings(port: u16) -> AiProviderSettings {
        AiProviderSettings {
            base_url: format!("http://127.0.0.1:{port}"),
            model: "test-model".to_string(),
        }
    }

    #[test]
    fn stream_chat_emits_deltas_and_done_over_local_http() {
        let port = serve_once(
            vec![
                sse_headers(),
                sse_delta("第一段"),
                sse_delta("第二段"),
                b"data: [DONE]\n\n".to_vec(),
            ],
            None,
        );
        let settings = chat_settings(port);
        let stopper = ChatStreamStopper::default();
        let deltas = Arc::new(StdMutex::new(Vec::new()));
        let sink = Arc::clone(&deltas);
        let outcome = tauri::async_runtime::block_on(stream_chat(
            &settings,
            "test-key",
            &chat_turns(),
            &stopper,
            move |delta| {
                sink.lock()
                    .expect("增量收集锁应可用")
                    .push(delta.to_string());
            },
        ));
        assert_eq!(outcome.error, None);
        assert!(!outcome.stopped);
        assert_eq!(outcome.content, "第一段第二段");
        assert_eq!(
            *deltas.lock().expect("增量收集锁应可用"),
            vec!["第一段".to_string(), "第二段".to_string()]
        );
    }

    #[test]
    fn stream_chat_reports_http_error_details() {
        let body = "{\"error\":{\"message\":\"密钥无效\"}}".as_bytes();
        let head = format!(
            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        let port = serve_once(vec![head, body.to_vec()], None);
        let settings = chat_settings(port);
        let outcome = tauri::async_runtime::block_on(stream_chat(
            &settings,
            "test-key",
            &chat_turns(),
            &ChatStreamStopper::default(),
            |_| {},
        ));
        let error = outcome.error.as_deref().unwrap_or_default();
        assert!(error.contains("401"), "错误应包含状态码：{error}");
        assert!(error.contains("密钥无效"), "错误应包含服务端详情：{error}");
        assert!(outcome.content.is_empty());
    }

    #[test]
    fn stream_chat_reports_connection_failures() {
        // 绑定后立刻释放端口，连接必然被拒绝。
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let settings = chat_settings(port);
        let outcome = tauri::async_runtime::block_on(stream_chat(
            &settings,
            "test-key",
            &chat_turns(),
            &ChatStreamStopper::default(),
            |_| {},
        ));
        assert!(outcome
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("连接 AI 服务商失败"));
    }

    #[test]
    fn stream_chat_idle_timeout_ends_a_stalled_stream() {
        // 服务端只发响应头，随后长时间不发送任何数据。
        let port = serve_once(vec![sse_headers()], Some(Duration::from_secs(30)));
        let settings = chat_settings(port);
        let outcome = tauri::async_runtime::block_on(stream_chat_with(
            &settings,
            "test-key",
            &chat_turns(),
            &ChatStreamStopper::default(),
            Duration::from_millis(150),
            |_| {},
        ));
        assert!(!outcome.stopped);
        assert!(outcome
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("没有收到任何数据"));
    }

    #[test]
    fn stream_chat_stop_keeps_partial_text_and_reports_terminal() {
        // 先发一段增量，然后长时间保持连接不再发送数据。
        let port = serve_once(
            vec![sse_headers(), sse_delta("部分")],
            Some(Duration::from_secs(30)),
        );
        let settings = chat_settings(port);
        let stopper = Arc::new(ChatStreamStopper::default());
        let stream_stopper = Arc::clone(&stopper);
        let deltas = Arc::new(StdMutex::new(Vec::new()));
        let sink = Arc::clone(&deltas);
        let handle = tauri::async_runtime::spawn(async move {
            stream_chat(
                &settings,
                "test-key",
                &chat_turns(),
                &stream_stopper,
                move |delta| {
                    sink.lock()
                        .expect("增量收集锁应可用")
                        .push(delta.to_string());
                },
            )
            .await
        });
        // 等首段增量送达后再请求停止，避免时序抖动。
        let started = Instant::now();
        while deltas.lock().expect("增量收集锁应可用").is_empty() {
            assert!(
                started.elapsed() < Duration::from_secs(3),
                "首段增量迟迟未到达"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        stopper.stop();
        let outcome = tauri::async_runtime::block_on(async {
            tokio::time::timeout(Duration::from_secs(5), handle)
                .await
                .expect("停止后流必须立即结束")
                .expect("流任务不应 panic")
        });
        assert!(outcome.stopped);
        assert_eq!(outcome.error.as_deref(), Some("已停止"));
        assert_eq!(outcome.content, "部分");
    }
}
