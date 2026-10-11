/**
 * 页面上下文注册：AI 对话面板发送消息时对当前页面取一次快照，
 * 随消息发给模型并存档。快照必须有界（仅摘要字段，不含整页数据），
 * Rust 侧限制单条上下文 32KiB。
 *
 * 注册分两层：
 * - 应用层（App 按当前分区注册兜底描述，保证任何页面都有上下文）；
 * - 视图层（CloudFilesView 等注册更细的目录/选择信息，覆盖应用层）。
 */

/** 页面上下文摘要；额外字段（如文件页的 folderId）允许按需扩展。 */
export type AiPageContext = {
  /** 页面标识，如 "cloud-files"。 */
  page: string;
  /** 页面中文名，如「网盘文件」。 */
  scope: string;
  /** 页内作用域细节，如目录名、当前影片、当前专辑。 */
  detail?: string;
  /** 已选条目名称（有界：至多前 8 项）。 */
  selection?: string[];
  /** 已加载数/总数的紧凑描述，如 "100 / 128"。 */
  loaded?: string;
  /** 视图自定义扩展字段；值必须是可 JSON 序列化的摘要。 */
  [key: string]: unknown;
};

type PageContextProvider = () => AiPageContext | null;

let appProvider: PageContextProvider | null = null;
let viewProvider: PageContextProvider | null = null;

/** 注册应用层兜底上下文；传 null 注销。同一时刻只保留一份。 */
export function registerAppPageContext(provider: PageContextProvider | null): void {
  appProvider = provider;
}

/** 注册视图层上下文；存在时优先于应用层。传 null 注销。 */
export function registerViewPageContext(provider: PageContextProvider | null): void {
  viewProvider = provider;
}

/** 获取当前页面上下文快照；视图层优先，两层都未注册或返回 null 时为 null。 */
export function getPageContext(): AiPageContext | null {
  return viewProvider?.() ?? appProvider?.() ?? null;
}

/** 上下文变化订阅：面板用它刷新输入框上方的当前上下文标签。 */
const contextListeners = new Set<() => void>();

export function subscribePageContext(listener: () => void): () => void {
  contextListeners.add(listener);
  return () => contextListeners.delete(listener);
}

/** 视图在上下文可能变化后调用（注册、目录切换、选择变化等）；通知面板刷新标签。 */
export function notifyPageContextChanged(): void {
  for (const listener of contextListeners) listener();
}

/** selection 数组的安全上限；与 CloudFilesView 的截断约定一致。 */
const MAX_SELECTION_NAMES = 8;

/** 生成用户气泡下方的轻量上下文标签，如「网盘文件 / 电影 · 已选 3 项」。 */
export function formatContextLabel(context: AiPageContext | null): string {
  if (!context) return "";
  const parts: string[] = [];
  const scope = context.detail ? `${context.scope} / ${context.detail}` : context.scope;
  parts.push(scope);
  const selectionNames = context.selection ?? [];
  if (selectionNames.length > 0) {
    parts.push(`已选 ${selectionNames.length} 项`);
  } else if (typeof context.selectedCount === "number" && context.selectedCount > 0) {
    parts.push(`已选 ${context.selectedCount} 项`);
  }
  if (typeof context.query === "string" && context.query) {
    parts.push(`搜索“${context.query}”`);
  }
  return parts.join(" · ");
}

/**
 * 上下文身份键：用于判断「切页」。页面、作用域或细节任一变化即视为切换；
 * 选择集与搜索词的变化不触发切页提示。
 */
export function contextIdentity(context: AiPageContext | null): string | null {
  if (!context) return null;
  return [context.page, context.scope, context.detail ?? ""].join("\u0000");
}

/** 发送前把上下文收敛为有界载荷：截断选择名，丢弃无法序列化的字段。 */
export function toContextPayload(context: AiPageContext | null): Record<string, unknown> | null {
  if (!context) return null;
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;
    payload[key] = value;
  }
  if (Array.isArray(payload.selection)) {
    payload.selection = (payload.selection as unknown[]).slice(0, MAX_SELECTION_NAMES);
  }
  return payload;
}
