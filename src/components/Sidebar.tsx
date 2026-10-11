import { Icon } from "./Icon";

/** 侧栏导航标识；影视三个内部视图（首页/媒体库/发现）归并为单一「影视」入口。 */
export type SidebarNavId =
  | "cloud-files"
  | "tasks"
  | "ai-organize"
  | "video"
  | "comics"
  | "albums"
  | "settings";

type SidebarProps = {
  active: SidebarNavId;
  /** true 为展开态（图标 + 文字 + 分组标题），false 为 80px 图标轨道；持久化由应用壳负责。 */
  expanded: boolean;
  taskCount: number;
  onNavigate: (id: SidebarNavId) => void;
  onToggleExpanded: () => void;
};

const NAVIGATION: Array<{
  id: Exclude<SidebarNavId, "settings">;
  label: string;
  icon: "cloud" | "tasks" | "sparkles" | "play" | "book" | "images";
  group: "workspace" | "content";
}> = [
  { id: "cloud-files", label: "网盘文件", icon: "cloud", group: "workspace" },
  { id: "tasks", label: "整理任务", icon: "tasks", group: "workspace" },
  { id: "ai-organize", label: "AI 整理", icon: "sparkles", group: "workspace" },
  { id: "video", label: "影视", icon: "play", group: "content" },
  { id: "comics", label: "漫画", icon: "book", group: "content" },
  { id: "albums", label: "相册", icon: "images", group: "content" },
];

const GROUP_LABELS: Record<"workspace" | "content", string> = {
  workspace: "工作区",
  content: "内容",
};

/** 文件优先的常驻侧栏；收起为图标轨道，展开显示分组标题与文字标签。 */
export function Sidebar({
  active,
  expanded,
  taskCount,
  onNavigate,
  onToggleExpanded,
}: SidebarProps) {
  return (
    <aside className="app-sidebar" aria-label="Sirius 功能导航">
      <div className="sidebar-brand" data-tauri-drag-region>
        <span className="brand-mark" aria-hidden="true" data-tauri-drag-region>S</span>
        <strong data-tauri-drag-region>Sirius</strong>
      </div>

      <nav aria-label="主导航">
        {(["workspace", "content"] as const).map((group) => (
          <div className="nav-group" key={group} role="group" aria-label={GROUP_LABELS[group]}>
            {/* 分组标题仅在展开态可见；收起轨道依赖图标与 tooltip 辨识。 */}
            <span className="nav-group-label" aria-hidden="true">{GROUP_LABELS[group]}</span>
            {NAVIGATION.filter((item) => item.group === group).map((item) => (
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
        <button
          type="button"
          className="sidebar-toggle"
          aria-label={expanded ? "收起侧栏" : "展开侧栏"}
          title={expanded ? "收起侧栏" : "展开侧栏"}
          aria-expanded={expanded}
          onClick={onToggleExpanded}
        >
          <Icon name="chevron" size={16} />
        </button>
      </div>
    </aside>
  );
}
