import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

/** 顶栏搜索范围：media=影视库检索，files=网盘当前目录检索。 */
export type TopBarSearchScope = "media" | "files";

/** 顶栏统一搜索框；scope 决定清除按钮语义，占位文案由调用方给定。 */
export type TopBarSearch = {
  scope: TopBarSearchScope;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
};

type TopBarProps = {
  title: string;
  /** 侧栏开合态；顶栏左侧的开合按钮据此切换方向。持久化由应用壳负责。 */
  sidebarExpanded: boolean;
  onToggleSidebar: () => void;
  /** null 表示当前页面没有搜索能力（漫画/相册等），顶栏不渲染搜索框，不造假。 */
  search: TopBarSearch | null;
  /** 轻量导航历史：后退/前进可否执行；两条栈均为空时按钮整体隐藏。 */
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  /** 任务中心入口（含抽屉本体）；由应用壳注入，固定在顶栏右侧。 */
  taskDrawer?: ReactNode;
};

/** 壳层顶栏（玻璃固定层）：侧栏开合、导航历史、页面标题、统一搜索与任务中心。 */
export function TopBar({
  title,
  sidebarExpanded,
  onToggleSidebar,
  search,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  taskDrawer,
}: TopBarProps) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchVisible = search !== null;

  // ⌘K 聚焦顶栏搜索：影视库与文件搜索共用同一入口；无搜索能力的页面不监听。
  useEffect(() => {
    if (!searchVisible) return;
    function focusSearch(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [searchVisible]);

  return (
    <header className="topbar shell-topbar" data-tauri-drag-region>
      {/* 导航历史置于最左，与标题同组；两条栈均空时整组不渲染，避免常驻禁用按钮。 */}
      {(canGoBack || canGoForward) && (
        <div className="shell-nav-cluster">
          <button
            type="button"
            className="shell-nav-button back"
            aria-label="返回上一视图"
            title="返回"
            disabled={!canGoBack}
            onClick={onBack}
          >
            <Icon name="chevron" size={17} />
          </button>
          <button
            type="button"
            className="shell-nav-button"
            aria-label="前进下一视图"
            title="前进"
            disabled={!canGoForward}
            onClick={onForward}
          >
            <Icon name="chevron" size={17} />
          </button>
        </div>
      )}

      <button
        type="button"
        className="shell-sidebar-toggle"
        aria-label={sidebarExpanded ? "收起侧栏" : "展开侧栏"}
        title={sidebarExpanded ? "收起侧栏" : "展开侧栏"}
        aria-expanded={sidebarExpanded}
        onClick={onToggleSidebar}
      >
        <Icon name="panel" size={18} />
      </button>

      <div className="shell-heading" data-tauri-drag-region>
        <span className="shell-app-name" data-tauri-drag-region>Sirius</span>
        <span className="shell-title-divider" aria-hidden="true" />
        <h1 data-tauri-drag-region>{title}</h1>
      </div>

      {search && (
        <div className="shell-media-search" role="search" aria-label={search.placeholder}>
          <Icon name="search" size={16} />
          <input
            ref={searchInputRef}
            value={search.value}
            placeholder={search.placeholder}
            aria-label={search.placeholder}
            aria-keyshortcuts="Meta+K Control+K"
            onChange={(event) => search.onChange(event.currentTarget.value)}
          />
          {search.value ? (
            <button
              type="button"
              aria-label={search.scope === "files" ? "清除文件搜索" : "清除影片搜索"}
              onClick={() => search.onChange("")}
            >
              <Icon name="close" size={14} />
            </button>
          ) : <kbd aria-hidden="true">⌘ K</kbd>}
        </div>
      )}

      <div className="shell-topbar-actions">
        {taskDrawer}
      </div>
    </header>
  );
}
