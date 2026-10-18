import { useEffect, useRef, useState } from "react";
import {
  type Cloud115AccountStatus,
  type Cloud115UserProfile,
} from "../services/mediaServices";
import { BrandMark } from "./BrandMark";
import { Icon } from "./Icon";
import { SidebarAccountMenu } from "./SidebarAccountMenu";

/** 侧栏导航标识；AI 整理并入右下角对话面板，不再占用侧栏入口。 */
export type SidebarNavId =
  | "cloud-files"
  | "recycle-bin"
  | "transfers"
  | "backup"
  | "tasks"
  | "video"
  | "comics"
  | "albums";

type SidebarProps = {
  active: SidebarNavId;
  taskCount: number;
  /** 115 账号身份位：点开底部账号菜单（概览 / 设置 / 退出登录）。 */
  account: Cloud115AccountStatus;
  profile: Cloud115UserProfile | null;
  onAccountChange: (account: Cloud115AccountStatus) => void;
  /** 打开设置弹窗（通用设置）。 */
  onOpenSettings: () => void;
  onNavigate: (id: SidebarNavId) => void;
};

const NAVIGATION: Array<{
  id: SidebarNavId;
  label: string;
  icon: "cloud" | "trash" | "download" | "refresh" | "tasks" | "play" | "book" | "images";
  group: "workspace" | "content";
}> = [
  { id: "cloud-files", label: "网盘", icon: "cloud", group: "workspace" },
  { id: "transfers", label: "传输", icon: "download", group: "workspace" },
  { id: "backup", label: "备份", icon: "refresh", group: "workspace" },
  { id: "recycle-bin", label: "回收站", icon: "trash", group: "workspace" },
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
  taskCount,
  account,
  profile,
  onAccountChange,
  onOpenSettings,
  onNavigate,
}: SidebarProps) {
  // 底部账号菜单开合：纯前端瞬时状态，不持久化。
  const [menuOpen, setMenuOpen] = useState(false);
  const accountSlotRef = useRef<HTMLDivElement | null>(null);
  const accountName = profile?.userName || account.userName || "115 用户";
  const avatarUrl = profile?.avatarUrl ?? null;

  // 菜单开启时响应 Esc 与点击外部：外部判定以整个账号位为界，
  // 避免点击头像本身被误判为“外部”而与按钮的 toggle 相互抵消。
  useEffect(() => {
    if (!menuOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    function handlePointerDown(event: PointerEvent) {
      if (!accountSlotRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [menuOpen]);

  return (
    <aside className="app-sidebar" aria-label="Sirius 功能导航">
      <div className="sidebar-brand" data-tauri-drag-region>
        <span className="brand-mark" aria-hidden="true" data-tauri-drag-region><BrandMark size={18} /></span>
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
                <span className="nav-item-label">{item.label}</span>
                {item.id === "tasks" && taskCount > 0 && (
                  <span className="nav-badge" aria-hidden="true">{taskCount > 99 ? "99+" : taskCount}</span>
                )}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        {/* 账号身份位：点头像从底部向左上展开账号菜单。 */}
        <div className="sidebar-account-slot" ref={accountSlotRef}>
          {menuOpen && (
            <SidebarAccountMenu
              account={account}
              profile={profile}
              onAccountChange={onAccountChange}
              onOpenSettings={() => {
                setMenuOpen(false);
                onOpenSettings();
              }}
            />
          )}
          <button
            type="button"
            className="sidebar-account"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`账号菜单：${accountName}`}
            title="账号"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="sidebar-account-avatar">
              {avatarUrl ? (
                <img src={avatarUrl} alt="" referrerPolicy="no-referrer" />
              ) : <Icon name="user" size={17} />}
            </span>
            <span className="sidebar-account-name">{accountName}</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
