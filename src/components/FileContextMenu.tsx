import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";

/**
 * 文件页统一菜单浮层：右键与行尾「更多操作」打开同一组件，
 * 排序菜单等无条目菜单也复用。参考 W3C menu-button 模式：
 * 方向键移动焦点、Escape/Tab 关闭、关闭后焦点由父级送回触发位置。
 * 通过 portal 挂到 body：.cloud-file-pane 的 container-type 使 fixed
 * 后代以它为包含块，直接渲染会跟随容器偏移。
 */
export type FileMenuItem =
  | {
      kind?: "item";
      id: string;
      label: string;
      icon?: IconName;
      /** 单选组当前项（排序菜单用）；定义了 checked 的项渲染前置勾选位。 */
      checked?: boolean;
      danger?: boolean;
      disabled?: boolean;
      /** 人读说明（tooltip），如实描述行为，不做假承诺。 */
      hint?: string;
      onSelect: () => void;
    }
  | { kind: "separator"; id: string };

type FileContextMenuProps = {
  /** 视口坐标锚点：右键取指针位置，按钮取右下缘；溢出时自动翻回屏内。 */
  x: number;
  y: number;
  items: FileMenuItem[];
  /** 可选说明行（如排序口径），保持诚实文案。 */
  note?: string;
  label?: string;
  onClose: () => void;
};

const VIEWPORT_MARGIN = 8;

export function FileContextMenu({ x, y, items, note, label, onClose }: FileContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: x, top: y, placed: false });

  // 定位防溢出：先按锚点放置，测量后把越界方向翻回屏内，再显示并聚焦首项。
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const left = x + rect.width > window.innerWidth - VIEWPORT_MARGIN
      ? Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN)
      : x;
    const top = y + rect.height > window.innerHeight - VIEWPORT_MARGIN
      ? Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN)
      : y;
    setPosition({ left, top, placed: true });
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (menuRef.current && event.target instanceof Node && !menuRef.current.contains(event.target)) {
        onClose();
      }
    }

    /** 键盘收容：菜单打开期间方向键在菜单项间移动，Escape/Tab 关闭。 */
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      const menu = menuRef.current;
      if (!menu) return;
      const itemButtons = Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      if (itemButtons.length === 0) return;
      const currentIndex = itemButtons.findIndex((button) => button === document.activeElement);
      let nextIndex: number | null = null;
      if (event.key === "ArrowDown") nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % itemButtons.length;
      else if (event.key === "ArrowUp") nextIndex = currentIndex < 0 ? itemButtons.length - 1 : (currentIndex - 1 + itemButtons.length) % itemButtons.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = itemButtons.length - 1;
      if (nextIndex !== null) {
        event.preventDefault();
        event.stopPropagation();
        itemButtons[nextIndex].focus();
      }
    }

    /** 菜单是视口锚定的浮层，滚动或改变窗口尺寸时直接关闭，避免错位。 */
    function handleViewportChange() {
      onClose();
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="file-context-menu"
      role="menu"
      aria-label={label}
      style={{ left: position.left, top: position.top, visibility: position.placed ? "visible" : "hidden" }}
    >
      {items.map((item) => item.kind === "separator" ? (
        <div key={item.id} className="file-context-menu-separator" role="separator" />
      ) : (
        <button
          key={item.id}
          role="menuitem"
          className={item.danger ? "danger" : ""}
          title={item.hint}
          disabled={item.disabled}
          onClick={() => item.onSelect()}
        >
          <span className="file-context-menu-slot" aria-hidden="true">
            {item.checked ? <Icon name="check" size={13} /> : item.icon ? <Icon name={item.icon} size={14} /> : null}
          </span>
          <span>{item.label}</span>
        </button>
      ))}
      {note && <p className="file-context-menu-note">{note}</p>}
    </div>,
    document.body,
  );
}
