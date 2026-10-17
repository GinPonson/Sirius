import { forwardRef, useState } from "react";
import {
  Cloud115Service,
  type Cloud115AccountStatus,
  type Cloud115UserProfile,
} from "../services/mediaServices";
import { StorageBar } from "./charts/Charts";
import { Icon } from "./Icon";

type SidebarAccountMenuProps = {
  account: Cloud115AccountStatus;
  profile: Cloud115UserProfile | null;
  /** 退出登录成功后回传未连接状态，由应用壳回到登录首屏。 */
  onAccountChange: (account: Cloud115AccountStatus) => void;
  /** 打开设置弹窗（通用设置）。 */
  onOpenSettings: () => void;
};

const cloud115 = new Cloud115Service();

/**
 * 左下角账号菜单：从侧栏底部头像向右上移出。
 * 内容沿用既有账号面板口径——资料概览（账号、存储空间、会员等级、客户端信息）与退出登录，
 * 数据全部来自 provider profile，缺失时明示而非编造。
 */
export const SidebarAccountMenu = forwardRef<HTMLDivElement, SidebarAccountMenuProps>(
  function SidebarAccountMenu({ account, profile, onAccountChange, onOpenSettings }, ref) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const name = profile?.userName || account.userName || "115 用户";
    const uid = profile?.userId ?? account.userId ?? null;
    const identity = uid ? `UID ${uid}` : "115 网盘已连接";

    async function signOut() {
      setBusy(true);
      setError(null);
      try {
        await cloud115.signOut();
        onAccountChange({ connected: false, userName: null, userId: null });
      } catch (reason) {
        setError(`退出登录失败：${String(reason)}`);
      } finally {
        setBusy(false);
      }
    }

    return (
      <div className="account-menu" role="menu" aria-label="账号菜单" ref={ref}>
        <header className="account-menu-head">
          <span className="account-menu-avatar">
            {profile?.avatarUrl ? <img src={profile.avatarUrl} alt="" referrerPolicy="no-referrer" /> : <Icon name="user" size={19} />}
          </span>
          <div>
            <strong>{name}</strong>
            <small>{identity}</small>
          </div>
        </header>

        <div className="account-menu-body" role="group" aria-label="账号概览">
          <div className="account-menu-row">
            <span className="account-menu-row-label">
              <strong>存储空间</strong>
              <small>{profile ? `${profile.usedFormatted} / ${profile.totalFormatted}` : "正在读取容量信息"}</small>
            </span>
            <span className="account-menu-row-value">{profile?.remainingFormatted ? `${profile.remainingFormatted} 可用` : "—"}</span>
          </div>
          {profile && profile.totalBytes > 0 && (
            <StorageBar
              used={profile.usedBytes}
              total={profile.totalBytes}
              usedLabel={profile.usedFormatted}
              totalLabel={profile.remainingFormatted}
              ariaLabel="115 网盘容量使用情况"
            />
          )}

          <div className="account-menu-row">
            <span className="account-menu-row-label">
              <strong>会员等级</strong>
              <small>由 115 账号资料返回</small>
            </span>
            <span className="account-menu-row-value">{profile?.vipLevel || "普通用户"}</span>
          </div>

          <div className="account-menu-row">
            <span className="account-menu-row-label">
              <strong>默认播放器</strong>
              <small>Sirius 内置播放窗口</small>
            </span>
            <span className="account-menu-row-value">内置播放器</span>
          </div>

          <div className="account-menu-row">
            <span className="account-menu-row-label">
              <strong>Sirius Desktop</strong>
              <small>115 第三方客户端</small>
            </span>
            <span className="account-menu-row-value">0.1.0</span>
          </div>
        </div>

        <div className="account-menu-divider" aria-hidden="true" />

        <button type="button" className="account-menu-item" role="menuitem" onClick={onOpenSettings}>
          <Icon name="settings" size={17} />
          设置
        </button>

        <button type="button" className="account-menu-item" role="menuitem" disabled={busy} onClick={() => void signOut()}>
          <Icon name="logout" size={17} />
          {busy ? "正在退出…" : "退出登录"}
        </button>

        {error && <p className="cloud-inline-error" role="alert">{error}</p>}
      </div>
    );
  },
);
