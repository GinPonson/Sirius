import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import "./Toast.css";

/** 单条 toast 的语义；决定图标与强调色。 */
export type ToastTone = "error" | "success" | "info";

export type Toast = {
  id: number;
  tone: ToastTone;
  message: string;
};

export type ToastApi = {
  show: (message: string, tone?: ToastTone) => void;
};

/** toast 自动消失时长；错误信息允许用户读完，取上限。 */
const TOAST_TTL_MS = 6000;

/** 同一文案的重复提示在该时间窗口内合并，避免恢复轮询刷屏。 */
const DEDUPE_WINDOW_MS = 1200;

/** 同时可见的 toast 上限；超出时挤掉最早一条，避免堆叠遮住内容。 */
const MAX_VISIBLE_TOASTS = 3;

const TONE_ICON: Record<ToastTone, "alert" | "check" | "sparkles"> = {
  error: "alert",
  success: "check",
  info: "sparkles",
};

const TONE_LABEL: Record<ToastTone, string> = {
  error: "错误",
  success: "成功",
  info: "提示",
};

let nextToastId = 1;

/**
 * 应用级轻提示。
 *
 * 替代原先的常驻错误横幅：非阻断的操作反馈（播放失败、保存失败、字幕不可用）
 * 不应占据内容区顶部位置直到用户手动关闭，也不该在错误消失后留下空白条。
 */
export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // 每条 toast 的自动消失定时器与最近一次展示时间；卸载时必须全部清理。
  const timersRef = useRef<Map<number, number>>(new Map());
  const lastShownAtRef = useRef<Map<string, number>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (message: string, tone: ToastTone = "error") => {
      const text = message.trim();
      if (!text) return;
      const now = Date.now();
      const lastShownAt = lastShownAtRef.current.get(text);
      // 播放状态轮询与同一路径的连续失败会产生同文案提示，窗口内直接吞掉。
      if (lastShownAt !== undefined && now - lastShownAt < DEDUPE_WINDOW_MS) return;
      lastShownAtRef.current.set(text, now);

      const id = nextToastId++;
      setToasts((current) => [...current, { id, tone, message: text }].slice(-MAX_VISIBLE_TOASTS));
      const timer = window.setTimeout(() => dismiss(id), TOAST_TTL_MS);
      timersRef.current.set(id, timer);
    },
    [dismiss],
  );

  // 供命令式调用方（Promise catch 等）复用同一实例。
  // ToastHost 作为 App 子组件挂载，其 effect 先于父组件的加载 effect 执行，
  // 因此启动阶段的失败提示不会落在未初始化的 api 上。
  useEffect(() => {
    toastApi = { show };
    return () => {
      for (const timer of timersRef.current.values()) {
        window.clearTimeout(timer);
      }
      timersRef.current.clear();
      toastApi = null;
    };
  }, [show]);

  useEffect(() => {
    // Esc 关闭全部提示：与项目内其它浮层的键盘退出行为保持一致。
    if (toasts.length === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setToasts([]);
      for (const timer of timersRef.current.values()) {
        window.clearTimeout(timer);
      }
      timersRef.current.clear();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toasts.length]);

  return (
    <div className="toast-host" role="region" aria-label="操作提示">
      {toasts.map((toast) => (
        <output
          key={toast.id}
          className={`toast tone-${toast.tone}`}
          aria-live={toast.tone === "error" ? "assertive" : "polite"}
        >
          <span className="toast-icon">
            <Icon name={TONE_ICON[toast.tone]} size={16} label={`${TONE_LABEL[toast.tone]}图标`} />
          </span>
          <span className="toast-message">{toast.message}</span>
          <button type="button" aria-label="关闭提示" onClick={() => dismiss(toast.id)}>
            <Icon name="close" size={14} />
          </button>
        </output>
      ))}
    </div>
  );
}

/** 命令式 toast 入口；ToastHost 卸载期间为 null，调用方需判空。 */
let toastApi: ToastApi | null = null;

export function showToast(message: string, tone: ToastTone = "error"): void {
  toastApi?.show(message, tone);
}
