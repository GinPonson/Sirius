import type { AppSection } from "../domain/media";
import { Icon } from "./Icon";

type SidebarProps = {
  active: AppSection;
  taskCount: number;
  onNavigate: (section: AppSection) => void;
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
  onNavigate,
}: SidebarProps) {
  return (
    <aside className="app-sidebar" aria-label="Sirius 功能导航">
      <div className="sidebar-brand" data-tauri-drag-region>
        <span className="brand-mark" aria-hidden="true" data-tauri-drag-region>S</span>
        <strong data-tauri-drag-region>Sirius</strong>
      </div>

      <nav aria-label="主导航">
        {(["workspace", "content"] as const).map((group) => (
          <div className="nav-group" key={group} role="group" aria-label={group === "workspace" ? "工作区" : "内容"}>
            {NAVIGATION.filter((item) => item.group === group && item.id !== "settings").map((item) => (
              <button
                key={item.id}
                type="button"
                className={active === item.id ? "nav-item active" : "nav-item"}
                aria-current={active === item.id ? "page" : undefined}
                aria-label={item.id === "tasks" && taskCount > 0 ? `${item.label}，${taskCount} 项需要处理` : item.label}
                title={item.label}
                onClick={() => onNavigate(item.id)}
              >
                <Icon name={item.icon} size={20} />
                <span>{item.label}</span>
                {item.id === "tasks" && taskCount > 0 && (
                  <span className="nav-badge" aria-hidden="true">{taskCount > 99 ? "99+" : taskCount}</span>
                )}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <button
          type="button"
          className={active === "settings" ? "nav-item active" : "nav-item"}
          aria-current={active === "settings" ? "page" : undefined}
          title="设置"
          onClick={() => onNavigate("settings")}
        >
          <Icon name="settings" size={20} />
          <span>设置</span>
        </button>
      </div>
    </aside>
  );
}
