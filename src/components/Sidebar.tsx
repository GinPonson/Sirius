import type { AppSection } from "../domain/media";
import type { Cloud115AccountStatus, Cloud115UserProfile } from "../services/mediaServices";
import { Icon } from "./Icon";

type SidebarProps = {
  active: AppSection;
  taskCount: number;
  query: string;
  onQueryChange: (query: string) => void;
  onNavigate: (section: AppSection) => void;
  cloudAccount: Cloud115AccountStatus | null;
  cloudProfile: Cloud115UserProfile | null;
  onAccountClick: () => void;
};

const NAVIGATION: Array<{
  id: AppSection;
  label: string;
  icon:
    | "cloud"
    | "tasks"
    | "sparkles"
    | "home"
    | "library"
    | "discover"
    | "book"
    | "images"
    | "settings";
  group: "workspace" | "content";
}> = [
  { id: "cloud-files", label: "网盘文件", icon: "cloud", group: "workspace" },
  { id: "tasks", label: "整理任务", icon: "tasks", group: "workspace" },
  { id: "ai-organize", label: "AI 整理", icon: "sparkles", group: "workspace" },
  { id: "settings", label: "设置", icon: "settings", group: "workspace" },
  { id: "home", label: "首页", icon: "home", group: "content" },
  { id: "library", label: "媒体库", icon: "library", group: "content" },
  { id: "discover", label: "发现", icon: "discover", group: "content" },
  { id: "comics", label: "漫画", icon: "book", group: "content" },
  { id: "albums", label: "相册", icon: "images", group: "content" },
];

/** 文件优先的常驻侧栏；115 文件工作区是默认入口，媒体浏览退居内容模式。 */
export function Sidebar({
  active,
  taskCount,
  query,
  onQueryChange,
  onNavigate,
  cloudAccount,
  cloudProfile,
  onAccountClick,
}: SidebarProps) {
  return (
    <aside className="app-sidebar">
      <div className="window-drag-region" data-tauri-drag-region />
      <div className="sidebar-brand">
        <span className="brand-mark">S</span>
        <div>
          <strong>Sirius</strong>
          <small>115 第三方客户端</small>
        </div>
      </div>

      <label className="sidebar-search">
        <Icon name="search" size={16} />
        <input
          value={query}
          placeholder="搜索影片"
          onChange={(event) => onQueryChange(event.currentTarget.value)}
        />
        <kbd>⌘ K</kbd>
      </label>

      <nav aria-label="主导航">
        {(["workspace", "content"] as const).map((group) => (
          <div className="nav-group" key={group}>
            <span className="nav-group-label">{group === "workspace" ? "工作区" : "内容"}</span>
            {NAVIGATION.filter((item) => item.group === group).map((item) => (
              <button
                key={item.id}
                className={active === item.id ? "nav-item active" : "nav-item"}
                onClick={() => onNavigate(item.id)}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
                {item.id === "tasks" && taskCount > 0 && (
                  <span className="nav-badge">{taskCount}</span>
                )}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <button className="source-summary account-summary" onClick={onAccountClick}>
        <div className="source-icon">
          {cloudAccount?.connected && cloudProfile?.avatarUrl ? (
            <img src={cloudProfile.avatarUrl} alt="" referrerPolicy="no-referrer" />
          ) : (
            <Icon name={cloudAccount?.connected ? "home" : "cloud"} size={16} />
          )}
        </div>
        <div>
          <strong>{cloudAccount?.connected ? cloudAccount.userName || "115 用户" : "登录 115"}</strong>
          <small>{cloudAccount?.connected ? "账号已连接" : "点击扫码登录"}</small>
        </div>
        <Icon name="chevron" size={13} />
      </button>
    </aside>
  );
}
