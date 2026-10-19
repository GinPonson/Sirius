/**
 * 判断一次对话回执或事件是否仍属于当前会话。
 *
 * @param requestedSessionId 发起请求时捕获的会话 ID。
 * @param activeSessionId 处理结果时界面当前选中的会话 ID。
 * @param resultSessionId 后端回执或事件携带的会话 ID。
 * @returns 三个 ID 一致时返回 true。
 */
export function isCurrentChatSession(
  requestedSessionId: string,
  activeSessionId: string | null,
  resultSessionId: string,
): boolean {
  return requestedSessionId === activeSessionId && requestedSessionId === resultSessionId;
}

type ChatEntryIdentity = {
  kind: string;
  id: string;
};

/**
 * 只更新指定助手条目，保留对应用户消息及其后的所有对话条目。
 *
 * @param entries 当前会话展示条目。
 * @param assistantId 需要原位更新的助手消息 ID。
 * @param update 对目标助手条目执行的不可变更新函数。
 * @returns 新的条目数组；不存在目标助手时返回原数组。
 */
export function updateAssistantEntry<T extends ChatEntryIdentity>(
  entries: T[],
  assistantId: string,
  update: (entry: T) => T,
): T[] {
  const targetExists = entries.some((entry) => entry.kind === "assistant" && entry.id === assistantId);
  if (!targetExists) return entries;
  return entries.map((entry) => (
    entry.kind === "assistant" && entry.id === assistantId ? update(entry) : entry
  ));
}
