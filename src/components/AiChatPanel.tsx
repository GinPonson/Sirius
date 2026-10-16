import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  AiChatService,
  AiChatStreamAggregator,
  listenAiChatTokens,
  type AiChatSession,
  type AiChatTokenEvent,
} from "../services/aiChatServices";
import { AiOrganizationService } from "../services/aiServices";
import {
  contextIdentity,
  formatContextLabel,
  getPageContext,
  subscribePageContext,
  toContextPayload,
  type AiPageContext,
} from "../domain/pageContext";
import { AiPlanCard, type PlanCardState } from "./AiPlanCard";
import { Icon } from "./Icon";

/**
 * AI 对话面板：右下角玻璃气泡入口 + 右侧可停靠对话面板。
 *
 * 状态机与契约：
 * - 发送即快照：`getPageContext()` 的结果随消息固定，显示在气泡下方并在切换页面时
 *   插入轻量分隔；面板只负责对话，模型不能自授权写操作，整理一律走方案卡
 *   （ai_analyze_folder → 用户勾选确认 → ai_execute_plan(confirmed)）。
 * - 流式：ai_chat_send 回执给出 messageId，增量经 `ai://chat-token` 聚合；
 *   终态恰好一次（done；停止 error=「已停止」）。
 * - 本组件在应用壳常驻挂载（仅可见性切换），切页与重挂载不丢消息与当前会话。
 */

const chat = new AiChatService();
const aiOrganization = new AiOrganizationService();

/** 对话流中的一条条目；方案卡与切页分隔同为流内条目。 */
type ChatEntry =
  | { kind: "user"; id: string; content: string; context: AiPageContext | null }
  | {
      kind: "assistant";
      id: string;
      content: string;
      status: "streaming" | "done" | "stopped" | "error";
      error?: string;
      /** 产生本条回复的用户消息 ID；重新生成时重发该条消息。 */
      replyToId: string;
    }
  | { kind: "divider"; id: string; label: string }
  | { kind: "plan"; id: string; card: PlanCardState };

type AiChatPanelProps = {
  open: boolean;
  onToggle: () => void;
  /** 内容区过窄时切换为覆盖式；回调供应用壳决定是否让内容列避让。 */
  onOverlayChange: (overlay: boolean) => void;
  /** 底部播放条可见时面板与气泡整体抬起避让。 */
  playing: boolean;
  /** 详情内容（媒体详情）；传入时面板顶部显示「详情 / AI」标签，两者共用同一区域。 */
  detail?: ReactNode;
  /** 详情对象标识；变化时自动切到「详情」标签。 */
  detailKey?: string | null;
};

/** 快捷问题：文件页走目录上下文；其他页面给通用整理咨询。 */
const FILE_PAGE_CHIPS = ["整理当前目录", "解释这个文件夹", "查找较大的文件"];
const GENERIC_CHIPS = ["如何规范命名影视文件", "网盘整理有哪些建议"];

/** 整理意图的启发式判断：提到整理与目标对象，且不是在咨询方法。 */
function looksLikeOrganizeIntent(content: string): boolean {
  if (!content.includes("整理")) return false;
  if (!/(目录|文件夹)/.test(content) && !content.includes("这些文件") && !content.includes("当前文件")) {
    return false;
  }
  return !/(建议|技巧|怎么|如何|什么|？|\?)/.test(content);
}

/** 从存档的 contextJson 还原上下文快照；损坏或缺失时返回 null。 */
function parseContextJson(raw: string | null): AiPageContext | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      value !== null &&
      typeof value === "object" &&
      typeof (value as AiPageContext).scope === "string"
    ) {
      return value as AiPageContext;
    }
  } catch {
    // 旧数据或损坏快照直接忽略，不阻塞历史渲染。
  }
  return null;
}

/** 分隔行用的作用域短标签：只含页面与页内细节，不带选择集。 */
function scopeLabel(context: AiPageContext): string {
  return context.detail ? `${context.scope} / ${context.detail}` : context.scope;
}

export function AiChatPanel({ open, onToggle, onOverlayChange, playing, detail, detailKey }: AiChatPanelProps) {
  const [sessions, setSessions] = useState<AiChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const [expandedPlanEntryId, setExpandedPlanEntryId] = useState<string | null>(null);
  const [confirmPlanEntryId, setConfirmPlanEntryId] = useState<string | null>(null);
  const [contextVersion, setContextVersion] = useState(0);
  /** 内容区过窄时的覆盖式形态；同步给应用壳以取消内容列避让。 */
  const [overlay, setOverlay] = useState(false);
  /** 面板内标签：传入详情时默认「详情」，否则始终为 AI 对话。 */
  const [activeTab, setActiveTab] = useState<"detail" | "ai">("ai");

  // 懒初始化的流聚合器与各处镜像 ref：事件回调与异步流程始终读取最新状态。
  const aggregatorRef = useRef<AiChatStreamAggregator | null>(null);
  if (aggregatorRef.current === null) aggregatorRef.current = new AiChatStreamAggregator();
  const streamMapRef = useRef(new Map<string, { entryId: string; sessionId: string }>());
  const lastContextKeyRef = useRef<string | null>(null);
  const composingRef = useRef(false);
  const entriesRef = useRef<ChatEntry[]>([]);
  entriesRef.current = entries;
  const sendingRef = useRef(sending);
  sendingRef.current = sending;
  const activeSessionRef = useRef(activeSessionId);
  activeSessionRef.current = activeSessionId;
  const openRef = useRef(open);
  openRef.current = open;
  const streamRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const streaming = entries.some((entry) => entry.kind === "assistant" && entry.status === "streaming");
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;

  // 当前页面上下面板标签：视图层注册变化时刷新（useSyncExternalStore 的轻量替身）。
  useEffect(() => subscribePageContext(() => setContextVersion((version) => version + 1)), []);
  const currentContext = useMemo(
    () => getPageContext(),
    // eslint 依赖豁免：contextVersion 仅作为刷新信号。
    [contextVersion],
  );

  // 停靠/覆盖切换：测量 .app-content 内容盒宽度；面板不是 .cloud-file-pane 后代，
  // 无法用容器查询表达同一语义，改用对同一容器的 ResizeObserver 测量。
  useEffect(() => {
    const host = document.querySelector(".app-content");
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((measures) => {
      const width = measures[0]?.contentRect.width ?? 0;
      const next = width > 0 && width < 640;
      setOverlay(next);
      onOverlayChange(next);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [onOverlayChange]);

  // 打开面板即清除未读标记。
  useEffect(() => {
    if (open) setUnseen(false);
  }, [open]);

  // 打开新的详情对象时自动切到「详情」标签；详情消失时回到 AI。
  useEffect(() => {
    setActiveTab(detailKey ? "detail" : "ai");
  }, [detailKey]);

  /** 加载会话历史并重建对话流（含随消息存档的上下文快照与切页分隔）。 */
  const loadHistory = useCallback(async (sessionId: string) => {
    try {
      const rows = await chat.history(sessionId);
      if (activeSessionRef.current !== sessionId) return;
      const rebuilt: ChatEntry[] = [];
      let lastKey: string | null = null;
      let lastUserId = "";
      for (const row of rows) {
        if (row.role === "user") {
          const context = parseContextJson(row.contextJson);
          const key = contextIdentity(context);
          if (key && lastKey && key !== lastKey) {
            rebuilt.push({ kind: "divider", id: `divider-${row.id}`, label: `已切换到 ${scopeLabel(context as AiPageContext)}` });
          }
          if (key) lastKey = key;
          rebuilt.push({ kind: "user", id: row.id, content: row.content, context });
          lastUserId = row.id;
        } else {
          rebuilt.push({ kind: "assistant", id: row.id, content: row.content, status: "done", replyToId: lastUserId });
        }
      }
      lastContextKeyRef.current = lastKey;
      setEntries(rebuilt);
    } catch (reason) {
      setSendError(`读取对话历史失败：${String(reason)}`);
    }
  }, []);
  const reloadHistoryRef = useRef(loadHistory);
  reloadHistoryRef.current = loadHistory;

  // 首次挂载即准备会话：有历史则取最近会话，否则新建，保证面板随时可用。
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const list = await chat.sessionsList();
        if (disposed) return;
        if (list.length > 0) {
          setSessions(list);
          setActiveSessionId(list[0].id);
        } else {
          const created = await chat.create();
          if (disposed) return;
          setSessions([created]);
          setActiveSessionId(created.id);
        }
      } catch (reason) {
        if (!disposed) setSendError(`读取对话会话失败：${String(reason)}`);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (activeSessionId) void loadHistory(activeSessionId);
    else setEntries([]);
  }, [activeSessionId, loadHistory]);

  /** 事件回调只通过 ref 与函数式 setState 读写状态，避免闭包过期。 */
  const handleTokenEvent = useCallback((event: AiChatTokenEvent) => {
    const aggregator = aggregatorRef.current;
    if (!aggregator) return;
    const state = aggregator.consume(event);
    if (!state) {
      // 未知终态（如会话切换后回归）：重载当前会话历史兜底。
      if (event.done && event.sessionId === activeSessionRef.current) {
        void reloadHistoryRef.current(event.sessionId);
      }
      return;
    }
    const mapping = streamMapRef.current.get(event.messageId);
    if (!mapping || mapping.sessionId !== activeSessionRef.current) {
      // 其他会话的流静默继续，历史在切换回时加载；面板收起时新结果点亮气泡。
      if (state.status !== "streaming" && !openRef.current) setUnseen(true);
      return;
    }
    setEntries((current) => current.map((entry) => {
      if (entry.kind !== "assistant" || entry.id !== mapping.entryId) return entry;
      if (state.status === "streaming") {
        return { ...entry, content: state.text, status: "streaming" as const };
      }
      if (state.status === "done") {
        return { ...entry, content: state.text, status: "done" as const };
      }
      // 终态错误：停止保留已生成的部分内容，其他错误展示为可重试错误条。
      return state.error === "已停止"
        ? { ...entry, content: state.text || entry.content, status: "stopped" as const }
        : { ...entry, content: state.text || entry.content, status: "error" as const, error: state.error };
    }));
    if (state.status !== "streaming") {
      streamMapRef.current.delete(event.messageId);
      if (!openRef.current) setUnseen(true);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    listenAiChatTokens(handleTokenEvent)
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((reason) => console.error("订阅 AI 对话事件失败", reason));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [handleTokenEvent]);

  const updatePlanCard = useCallback((entryId: string, patch: Partial<PlanCardState>) => {
    setEntries((current) => current.map((entry) => (
      entry.kind === "plan" && entry.id === entryId ? { ...entry, card: { ...entry.card, ...patch } } : entry
    )));
  }, []);

  /** 生成整理计划：永远绑定发起时的目录；失败保留原因并允许重试。 */
  const runAnalyze = useCallback(async (planEntryId: string, folderId: string | null, folderName?: string) => {
    if (!folderId) {
      updatePlanCard(planEntryId, {
        phase: "error",
        message: "当前页面没有可整理的目录；请到网盘文件页选择目录后再试。",
        plan: null,
        selected: new Set<string>(),
        report: null,
        folderId: undefined,
        folderName,
      });
      return;
    }
    updatePlanCard(planEntryId, { phase: "analyzing", plan: null, selected: new Set<string>(), report: null, folderId, folderName });
    try {
      const plan = await aiOrganization.analyzeFolder(folderId);
      // 重命名与移动默认勾选；删除必须由用户显式勾选。
      updatePlanCard(planEntryId, {
        phase: "ready",
        plan,
        selected: new Set(
          plan.items
            .filter((item) => item.action === "rename" || item.action === "move")
            .map((item) => item.fileId),
        ),
        report: null,
      });
    } catch (reason) {
      updatePlanCard(planEntryId, { phase: "error", message: `AI 分析失败：${String(reason)}` });
    }
  }, [updatePlanCard]);

  /** 发送一条消息；replaceAssistantId 用于重新生成时原位替换回复。 */
  const sendMessage = useCallback(async (rawContent: string, replaceAssistantId?: string) => {
    const content = rawContent.trim();
    const sessionId = activeSessionRef.current;
    if (!content || !sessionId || sendingRef.current || streamingRef.current) return;
    const context = getPageContext();
    setSendError(null);
    setSending(true);
    try {
      const receipt = await chat.send(sessionId, content, toContextPayload(context));
      const assistantId = replaceAssistantId ?? `assistant-${receipt.messageId}`;
      const key = contextIdentity(context);
      // 切页判断必须在 setEntries 之前完成：updater 会在渲染期执行，
      // 届时再读 lastContextKeyRef 已经是新值，会漏掉分隔。
      const needsSwitchDivider = Boolean(key && lastContextKeyRef.current && lastContextKeyRef.current !== key);
      const switchLabel = context ? scopeLabel(context) : "新页面";
      if (key) lastContextKeyRef.current = key;
      const planIntent = !replaceAssistantId
        && looksLikeOrganizeIntent(content)
        && typeof context?.folderId === "string"
        && context.folderId !== "";
      const planEntryId = `plan-${receipt.messageId}`;
      setEntries((current) => {
        const next: ChatEntry[] = [...current];
        if (needsSwitchDivider) {
          next.push({
            kind: "divider",
            id: `divider-${receipt.userMessageId}`,
            label: `已切换到 ${switchLabel}`,
          });
        }
        next.push({ kind: "user", id: receipt.userMessageId, content, context });
        if (planIntent) {
          next.push({
            kind: "plan",
            id: planEntryId,
            card: {
              phase: "analyzing",
              plan: null,
              selected: new Set<string>(),
              report: null,
              folderId: typeof context?.folderId === "string" ? context.folderId : undefined,
              folderName: typeof context?.folderName === "string" ? context.folderName : undefined,
            },
          });
        }
        next.push({ kind: "assistant", id: assistantId, content: "", status: "streaming", replyToId: receipt.userMessageId });
        return next;
      });
      streamMapRef.current.set(receipt.messageId, { entryId: assistantId, sessionId: receipt.sessionId });
      aggregatorRef.current?.track(receipt);
      if (planIntent) {
        void runAnalyze(
          planEntryId,
          typeof context?.folderId === "string" ? context.folderId : null,
          typeof context?.folderName === "string" ? context.folderName : undefined,
        );
      }
    } catch (reason) {
      setSendError(`发送消息失败：${String(reason)}`);
    } finally {
      setSending(false);
    }
  }, [runAnalyze]);

  /** 重新生成：重发该条回复对应的用户消息，并原位替换回复文本。 */
  const regenerate = useCallback(async (assistantEntryId: string) => {
    const target = entriesRef.current.find((entry) => entry.kind === "assistant" && entry.id === assistantEntryId);
    if (!target || target.kind !== "assistant") return;
    const userEntry = entriesRef.current.find((entry) => entry.kind === "user" && entry.id === target.replyToId);
    if (!userEntry || userEntry.kind !== "user") return;
    await sendMessage(userEntry.content, assistantEntryId);
  }, [sendMessage]);

  /** 停止当前会话的流式回复；终态事件会把回复标记为已停止。 */
  const stopStreaming = useCallback(async () => {
    const sessionId = activeSessionRef.current;
    if (!sessionId) return;
    try {
      await chat.stop(sessionId);
    } catch (reason) {
      setSendError(`停止生成失败：${String(reason)}`);
    }
  }, []);

  /** 确认执行：只提交用户勾选项；Rust 会重新校验快照绑定与策略。 */
  const executePlan = useCallback(async (planEntryId: string) => {
    const entry = entriesRef.current.find((current) => current.kind === "plan" && current.id === planEntryId);
    if (!entry || entry.kind !== "plan" || !entry.card.plan) return;
    const { plan, selected, folderName } = entry.card;
    const items = plan.items
      .filter((item) => selected.has(item.fileId))
      .map((item) => ({
        fileId: item.fileId,
        currentName: item.currentName,
        action: item.action,
        suggestedName: item.suggestedName,
        targetFolder: item.targetFolder,
      }));
    if (items.length === 0) return;
    setConfirmPlanEntryId(null);
    setExpandedPlanEntryId(null);
    updatePlanCard(planEntryId, { phase: "executing" });
    try {
      const report = await aiOrganization.executePlan({
        folderId: plan.folderId,
        confirmed: true,
        items,
      });
      updatePlanCard(planEntryId, { phase: "report", report });
      if (!openRef.current) setUnseen(true);
    } catch (reason) {
      // 快照漂移等会被 Rust 拒绝；回到错误态并允许重新分析。
      updatePlanCard(planEntryId, {
        phase: "error",
        message: `执行整理计划失败：${String(reason)}`,
        folderId: plan.folderId,
        folderName,
      });
    }
  }, [updatePlanCard]);

  async function createSession() {
    try {
      const created = await chat.create();
      setSessions((current) => [created, ...current]);
      setActiveSessionId(created.id);
      setSessionsOpen(false);
    } catch (reason) {
      setSendError(`新建会话失败：${String(reason)}`);
    }
  }

  async function deleteSession(sessionId: string) {
    try {
      await chat.delete(sessionId);
    } catch (reason) {
      setSendError(`删除会话失败：${String(reason)}`);
      return;
    }
    const remaining = sessions.filter((session) => session.id !== sessionId);
    setSessions(remaining);
    if (sessionId === activeSessionId) {
      if (remaining.length > 0) {
        setActiveSessionId(remaining[0].id);
      } else {
        try {
          const created = await chat.create();
          setSessions([created]);
          setActiveSessionId(created.id);
        } catch {
          setActiveSessionId(null);
        }
      }
    }
  }

  // 输入框自适应高度；发送后复位。
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 132)}px`;
  }, [input]);

  // 用户贴底时每次渲染后滚动到最新内容；上滚查阅历史时不打扰。
  useEffect(() => {
    const element = streamRef.current;
    if (!element || !pinnedRef.current) return;
    element.scrollTop = element.scrollHeight;
  });

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    // 输入法组词期间的回车用于确认候选词，不得误发送。
    if (composingRef.current || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void sendMessage(input);
    setInput("");
  }

  const chips = currentContext?.page === "cloud-files" ? FILE_PAGE_CHIPS : GENERIC_CHIPS;
  const contextTagText = currentContext ? formatContextLabel(currentContext) : "当前页面暂无上下文";

  const expandedEntry = expandedPlanEntryId
    ? entries.find((entry) => entry.kind === "plan" && entry.id === expandedPlanEntryId)
    : null;
  const confirmEntry = confirmPlanEntryId
    ? entries.find((entry) => entry.kind === "plan" && entry.id === confirmPlanEntryId)
    : null;
  const confirmCard = confirmEntry && confirmEntry.kind === "plan" ? confirmEntry.card : null;
  const confirmSelected = confirmCard?.plan
    ? confirmCard.plan.items.filter((item) => confirmCard.selected.has(item.fileId))
    : [];
  const confirmDeleteCount = confirmSelected.filter((item) => item.action === "delete").length;

  return (
    <>
      <aside
        className="ai-chat-panel"
        data-open={open ? "true" : "false"}
        data-mode={overlay ? "overlay" : "dock"}
        data-lift={playing ? "true" : "false"}
        data-tab={detail ? activeTab : "ai"}
        aria-label={detail && activeTab === "detail" ? "媒体详情" : "AI 助手"}
        aria-hidden={!open}
        inert={!open}
      >
        <header className="ai-chat-header">
          {detail && (
            <div role="tablist" aria-label="面板内容" className="ai-chat-tabs">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "detail"}
                className={activeTab === "detail" ? "active" : ""}
                onClick={() => setActiveTab("detail")}
              >
                详情
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "ai"}
                className={activeTab === "ai" ? "active" : ""}
                onClick={() => setActiveTab("ai")}
              >
                <Icon name="sparkles" size={14} />
                AI
              </button>
            </div>
          )}
          <div className="ai-chat-session-anchor">
            <button
              type="button"
              className="ai-chat-session-button"
              aria-expanded={sessionsOpen}
              aria-haspopup="listbox"
              onClick={() => setSessionsOpen((value) => !value)}
            >
              <Icon name="sparkles" size={15} />
              <span>{activeSession?.title ?? "新对话"}</span>
              <Icon name="chevron" size={13} />
            </button>
            {sessionsOpen && (
              <>
                <div className="ai-chat-sessions-backdrop" aria-hidden="true" onClick={() => setSessionsOpen(false)} />
                <div className="ai-chat-sessions" role="listbox" aria-label="对话历史">
                  <button type="button" className="ai-chat-session-new" onClick={() => void createSession()}>
                    <Icon name="plus" size={14} />
                    新建对话
                  </button>
                  {sessions.length === 0 && <div className="ai-chat-sessions-empty">还没有历史对话</div>}
                  {sessions.map((session) => (
                    <div
                      key={session.id}
                      className={session.id === activeSessionId ? "ai-chat-session-item active" : "ai-chat-session-item"}
                      role="option"
                      aria-selected={session.id === activeSessionId}
                    >
                      <button type="button" onClick={() => { setActiveSessionId(session.id); setSessionsOpen(false); }}>
                        <strong>{session.title}</strong>
                        <small>{session.updatedAt}</small>
                      </button>
                      <button
                        type="button"
                        className="ai-chat-session-delete"
                        aria-label={`删除对话 ${session.title}`}
                        disabled={streaming && session.id === activeSessionId}
                        onClick={() => void deleteSession(session.id)}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            type="button"
            className="ai-chat-close"
            aria-label="收起 AI 助手"
            onClick={onToggle}
          >
            <Icon name="close" size={15} />
          </button>
        </header>

        {detail && (
          <div className="ai-chat-detail-slot" data-active={activeTab === "detail" ? "true" : "false"}>
            {detail}
          </div>
        )}

        <div className="ai-chat-stream" data-active={activeTab === "ai" ? "true" : "false"} ref={streamRef} onScroll={() => {
          const element = streamRef.current;
          if (!element) return;
          pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}>
          {entries.length === 0 && (
            <div className="ai-chat-empty">
              <span className="ai-chat-empty-icon" aria-hidden="true"><Icon name="sparkles" size={22} /></span>
              <strong>让整理从对话开始</strong>
              <p>
                我会读取当前页面的上下文来帮你整理文件、解释目录或查找大文件。
                所有修改都先给出计划，由你逐项确认后才会执行。
              </p>
            </div>
          )}
          {entries.map((entry) => {
            if (entry.kind === "divider") {
              return (
                <div className="ai-chat-divider" key={entry.id}>
                  <span>{entry.label}</span>
                </div>
              );
            }
            if (entry.kind === "user") {
              return (
                <div className="ai-chat-msg-user" key={entry.id}>
                  <div className="ai-chat-bubble-user">{entry.content}</div>
                  {entry.context && (
                    <span className="ai-chat-msg-context">{formatContextLabel(entry.context)}</span>
                  )}
                </div>
              );
            }
            if (entry.kind === "plan") {
              return (
                <AiPlanCard
                  key={entry.id}
                  compact
                  state={entry.card}
                  onToggleItem={(fileId) => {
                    setEntries((current) => current.map((current2) => {
                      if (current2.kind !== "plan" || current2.id !== entry.id) return current2;
                      const selected = new Set(current2.card.selected);
                      if (selected.has(fileId)) selected.delete(fileId);
                      else selected.add(fileId);
                      return { ...current2, card: { ...current2.card, selected } };
                    }));
                  }}
                  onExpand={() => setExpandedPlanEntryId(entry.id)}
                  onConfirm={() => setConfirmPlanEntryId(entry.id)}
                  onRetry={() => void runAnalyze(entry.id, entry.card.folderId ?? null, entry.card.folderName)}
                />
              );
            }
            return (
              <div className="ai-chat-msg-assistant" key={entry.id}>
                {entry.content ? (
                  <p className={entry.status === "streaming" ? "ai-chat-text streaming" : "ai-chat-text"}>{entry.content}</p>
                ) : entry.status === "streaming" ? (
                  <span className="ai-chat-typing" role="status" aria-label="正在生成回复" />
                ) : null}
                {entry.status === "streaming" && <span className="ai-chat-status-note" role="status">生成中…</span>}
                {entry.status === "stopped" && <span className="ai-chat-status-note">已停止生成</span>}
                {entry.status === "error" && (
                  <div className="ai-chat-error-line" role="alert">
                    <Icon name="alert" size={13} />
                    <span>{entry.error ?? "生成失败"}</span>
                    <button type="button" onClick={() => void regenerate(entry.id)}>重试</button>
                  </div>
                )}
                {entry.status === "done" && entry.replyToId && !streaming && (
                  <button type="button" className="ai-chat-regenerate" onClick={() => void regenerate(entry.id)}>
                    <Icon name="refresh" size={12} />
                    重新生成
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="ai-chat-composer" data-active={activeTab === "ai" ? "true" : "false"}>
          {sendError && (
            <div className="ai-chat-error-line" role="alert">
              <Icon name="alert" size={13} />
              <span>{sendError}</span>
              <button type="button" aria-label="关闭错误提示" onClick={() => setSendError(null)}>
                <Icon name="close" size={12} />
              </button>
            </div>
          )}
          <div className="ai-chat-context-tag">
            <span>{contextTagText}</span>
          </div>
          {!streaming && !sending && (
            <div className="ai-chat-chips" aria-label="快捷问题">
              {chips.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  disabled={!activeSessionId}
                  onClick={() => {
                    setInput("");
                    void sendMessage(chip);
                  }}
                >
                  {chip}
                </button>
              ))}
            </div>
          )}
          <div className="ai-chat-input-wrap">
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              placeholder={streaming ? "正在回复中，可点击停止…" : "输入消息，Enter 发送，Shift+Enter 换行"}
              aria-label="AI 助手输入框"
              onChange={(event) => setInput(event.currentTarget.value)}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              onKeyDown={handleComposerKeyDown}
            />
            {streaming ? (
              <button
                type="button"
                className="ai-chat-send stop"
                aria-label="停止生成"
                title="停止生成"
                onClick={() => void stopStreaming()}
              >
                <Icon name="stop" size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="ai-chat-send"
                aria-label="发送消息"
                title="发送"
                disabled={!input.trim() || sending || !activeSessionId}
                onClick={() => {
                  const content = input;
                  setInput("");
                  void sendMessage(content);
                }}
              >
                <Icon name="send" size={15} />
              </button>
            )}
          </div>
        </div>
      </aside>

      {expandedEntry && expandedEntry.kind === "plan" && (
        <div
          className="ai-chat-expand-backdrop"
          onPointerDown={(event) => event.target === event.currentTarget && setExpandedPlanEntryId(null)}
        >
          <section className="ai-chat-expand-panel" role="dialog" aria-modal="true" aria-label="整理计划检查">
            <header className="ai-chat-expand-head">
              <strong>整理计划检查</strong>
              <button type="button" aria-label="收起检查视图" onClick={() => setExpandedPlanEntryId(null)}>
                <Icon name="close" size={15} />
              </button>
            </header>
            <div className="ai-chat-expand-body">
              <AiPlanCard
                compact={false}
                state={expandedEntry.card}
                onToggleItem={(fileId) => {
                  setEntries((current) => current.map((current2) => {
                    if (current2.kind !== "plan" || current2.id !== expandedEntry.id) return current2;
                    const selected = new Set(current2.card.selected);
                    if (selected.has(fileId)) selected.delete(fileId);
                    else selected.add(fileId);
                    return { ...current2, card: { ...current2.card, selected } };
                  }));
                }}
                onExpand={() => setExpandedPlanEntryId(null)}
                onConfirm={() => setConfirmPlanEntryId(expandedEntry.id)}
                onRetry={() => void runAnalyze(expandedEntry.id, expandedEntry.card.folderId ?? null, expandedEntry.card.folderName)}
              />
            </div>
          </section>
        </div>
      )}

      {confirmCard && confirmCard.plan && (
        <div
          className="cloud-operation-backdrop"
          onPointerDown={(event) => event.target === event.currentTarget && setConfirmPlanEntryId(null)}
        >
          <section className="cloud-operation-dialog" role="dialog" aria-modal="true" aria-label="确认执行整理计划">
            <strong>确认执行整理计划？</strong>
            <span>
              将对 {confirmSelected.length} 个文件执行修改并立即生效：重命名与移动直接应用，
              {confirmDeleteCount > 0
                ? `${confirmDeleteCount} 项删除会移入 115 回收站（可还原）`
                : "删除项会移入 115 回收站（可还原）"}
              。执行前系统会重新核对每个文件的当前状态。
            </span>
            <div>
              <button type="button" className="secondary-action" onClick={() => setConfirmPlanEntryId(null)}>取消</button>
              <button type="button" className="danger-action" onClick={() => void executePlan(confirmPlanEntryId ?? "")}>
                确认执行
              </button>
            </div>
          </section>
        </div>
      )}

      <button
        type="button"
        className="ai-chat-bubble"
        data-open={open ? "true" : "false"}
        data-lift={playing ? "true" : "false"}
        aria-label={open ? "收起 AI 助手" : "展开 AI 助手"}
        aria-expanded={open}
        onClick={onToggle}
      >
        <Icon name="sparkles" size={20} />
        {unseen && !open && <span className="ai-chat-bubble-dot" aria-hidden="true" />}
      </button>
    </>
  );
}
