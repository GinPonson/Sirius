import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** `ai://chat-token` 事件名；与 Rust 侧 ai_chat::AI_CHAT_TOKEN_EVENT 保持一致。 */
export const AI_CHAT_TOKEN_EVENT = "ai://chat-token";

/** AI 对话会话元数据；与 Rust AiChatSession（camelCase）逐字段对齐。 */
export type AiChatSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

/** AI 对话消息行；contextJson 是发送时随消息存档的页面上下文快照 JSON（可空）。 */
export type AiChatMessageRow = {
  id: string;
  sessionId: string;
  /** "user" 或 "assistant"。 */
  role: string;
  content: string;
  contextJson: string | null;
  createdAt: string;
};

/** `ai_chat_send` 的同步回执；流在后台继续，增量经 `ai://chat-token` 推送。 */
export type AiChatSendReceipt = {
  sessionId: string;
  /** 助手消息 ID；在首个增量事件前确定，前端用它聚合 delta。 */
  messageId: string;
  /** 本次用户消息 ID，与持久化行一致，供乐观渲染对齐。 */
  userMessageId: string;
};

/** `ai://chat-token` 事件负载；增量若干次后恰好一次终态（done=true）。 */
export type AiChatTokenEvent = {
  sessionId: string;
  messageId: string;
  delta: string;
  done: boolean;
  /** 终态错误说明（停止、失败）；成功时缺省。 */
  error?: string;
};

/** 单条助手回复在聚合器中的状态；由同一 messageId 的事件流累积而成。 */
export type AiChatStreamState = {
  sessionId: string;
  messageId: string;
  /** 已聚合的全部增量文本。 */
  text: string;
  status: "streaming" | "done" | "error";
  /** 终态错误说明；仅 error 状态存在。 */
  error?: string;
};

/**
 * `ai://chat-token` 聚合器：按 messageId 拼接 delta，终态回传错误。
 * 面板组件持有一个实例，把事件流折叠成可渲染的流式状态。
 */
export class AiChatStreamAggregator {
  private readonly streams = new Map<string, AiChatStreamState>();

  /** 消费一条事件；返回受影响的流状态，未知或终态重复事件返回 null。 */
  consume(event: AiChatTokenEvent): AiChatStreamState | null {
    if (event.done) {
      const previous = this.streams.get(event.messageId);
      this.streams.delete(event.messageId);
      if (!previous) return null;
      return {
        ...previous,
        status: event.error ? "error" : "done",
        error: event.error,
      };
    }
    const previous = this.streams.get(event.messageId);
    const next: AiChatStreamState = {
      sessionId: event.sessionId,
      messageId: event.messageId,
      text: (previous?.text ?? "") + event.delta,
      status: "streaming",
    };
    this.streams.set(event.messageId, next);
    return next;
  }

  /** 登记一条由 ai_chat_send 回执确定的进行中流；首增量到达前即可追踪。 */
  track(receipt: AiChatSendReceipt): AiChatStreamState {
    const state: AiChatStreamState = {
      sessionId: receipt.sessionId,
      messageId: receipt.messageId,
      text: "",
      status: "streaming",
    };
    this.streams.set(receipt.messageId, state);
    return state;
  }

  /** 查询某条消息是否仍在流式输出。 */
  isStreaming(messageId: string): boolean {
    return this.streams.get(messageId)?.status === "streaming";
  }
}

/** 订阅 `ai://chat-token` 事件；返回取消订阅函数。 */
export function listenAiChatTokens(
  handler: (event: AiChatTokenEvent) => void,
): Promise<UnlistenFn> {
  return listen<AiChatTokenEvent>(AI_CHAT_TOKEN_EVENT, (event) => handler(event.payload));
}

/** AI 对话应用服务：G2 六命令的类型化封装；会话与消息持久化都在 Rust 侧。 */
export class AiChatService {
  /** 新建会话；title 缺省时 Rust 使用默认标题「新对话」。 */
  create(title?: string): Promise<AiChatSession> {
    return invoke("ai_chat_create", { title: title ?? null });
  }

  /** 发送一条用户消息并启动流式回复；同会话并发发送会被 Rust 拒绝。 */
  send(
    sessionId: string,
    content: string,
    context?: Record<string, unknown> | null,
  ): Promise<AiChatSendReceipt> {
    return invoke("ai_chat_send", { sessionId, content, context: context ?? null });
  }

  /** 中断会话当前流式回复；返回是否确实存在进行中的流。 */
  stop(sessionId: string): Promise<boolean> {
    return invoke("ai_chat_stop", { sessionId });
  }

  /** 全部会话元数据，按最近更新倒序。 */
  sessionsList(): Promise<AiChatSession[]> {
    return invoke("ai_chat_sessions_list");
  }

  /** 会话内全部消息（按时间顺序），含随消息存档的上下文快照。 */
  history(sessionId: string): Promise<AiChatMessageRow[]> {
    return invoke("ai_chat_history", { sessionId });
  }

  /** 删除会话及其全部消息；会话正在回复中时 Rust 会拒绝。 */
  delete(sessionId: string): Promise<void> {
    return invoke("ai_chat_delete", { sessionId });
  }
}
