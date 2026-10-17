import { useEffect, type ReactNode } from "react";
import { Icon } from "./Icon";

type SettingsModalProps = {
  /** 通用设置内容由应用壳注入。 */
  children: ReactNode;
  onClose: () => void;
};

/** 设置弹窗（玻璃固定层）：承载通用设置，内容区独立滚动。 */
export function SettingsModal({ children, onClose }: SettingsModalProps) {
  // Esc 关闭：浮层语义与其它对话框一致，不修改任何设置状态。
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="preferences-backdrop"
      role="presentation"
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="preferences-modal" role="dialog" aria-modal="true" aria-label="设置">
        <header className="preferences-head">
          <strong className="preferences-title">设置</strong>
          <button type="button" className="preferences-close" aria-label="关闭设置" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="preferences-body">
          {children}
        </div>
      </section>
    </div>
  );
}
