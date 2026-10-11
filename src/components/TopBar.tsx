import { useEffect, useRef } from "react";
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

type TopBarStorage = {
  used: string;
  total: string;
  percent: number;
};

type TopBarProps = {
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  /** null 表示当前页面没有搜索能力（漫画/相册等），顶栏不渲染搜索框，不造假。 */
  search: TopBarSearch | null;
  accountName: string;
  avatarUrl: string | null;
  storage: TopBarStorage | null;
  onManageAccount: () => void;
};

/** 壳层顶栏（玻璃固定层）：前进/后退、页面标题、统一搜索与 115 账号区。 */
export function TopBar({
  title,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  search,
  accountName,
  avatarUrl,
  storage,
  onManageAccount,
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

      <div className="shell-account-area">
        {storage && (
          <div className="shell-storage" title={`已用 ${storage.used}，总容量 ${storage.total}`}>
            <span>{storage.used}<span> / {storage.total}</span></span>
            <div
              className="shell-storage-meter"
              role="meter"
              aria-label="115 网盘空间使用率"
              aria-valuenow={storage.percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <i style={{ width: `${storage.percent}%` }} />
            </div>
          </div>
        )}
        <button
          type="button"
          className="shell-account-button"
          aria-label={`管理 115 账号：${accountName}`}
          title="管理 115 账号"
          onClick={onManageAccount}
        >
          <span className="shell-account-avatar">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" referrerPolicy="no-referrer" />
            ) : <Icon name="user" size={17} />}
          </span>
          <span className="shell-account-name">{accountName}</span>
          <Icon name="chevron" size={12} />
        </button>
      </div>
    </header>
  );
}
