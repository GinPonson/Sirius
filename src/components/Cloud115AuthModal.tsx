import { useState } from "react";
import {
  Cloud115Service,
  type Cloud115AccountStatus,
  type Cloud115UserProfile,
} from "../services/mediaServices";
import { Icon } from "./Icon";
import { StorageBar } from "./charts/Charts";

type Cloud115AuthModalProps = {
  account: Cloud115AccountStatus;
  profile: Cloud115UserProfile | null;
  onAccountChange: (account: Cloud115AccountStatus) => void;
  onClose: () => void;
};

const cloud115 = new Cloud115Service();

/** 已登录账号面板：资料概览与退出登录；扫码授权由登录首屏承担。 */
export function Cloud115AuthModal({ account, profile, onAccountChange, onClose }: Cloud115AuthModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Esc 与点击遮罩都只关闭面板，不影响登录状态。 */
  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") onClose();
  }

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
    <div
      className="cloud-account-backdrop"
      role="presentation"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="cloud-account-modal cloud-account-modal-profile" role="dialog" aria-modal="true" aria-label="115 账号">
        <button className="cloud-account-close" aria-label="关闭" onClick={onClose}><Icon name="close" size={16} /></button>
        <div className="cloud-account-profile">
          <div className="cloud-profile-summary">
            <span className="cloud-account-avatar">
              {profile?.avatarUrl ? <img src={profile.avatarUrl} alt="115 用户头像" referrerPolicy="no-referrer" /> : <Icon name="cloud" size={24} />}
            </span>
            <div>
              <strong>{profile?.userName || account.userName || "115 用户"}</strong>
              <span>{account.userId ? `UID ${account.userId}` : "115 网盘已连接"}</span>
            </div>
            <button className="cloud-signout" disabled={busy} onClick={() => void signOut()}>退出登录</button>
          </div>

          <div className="cloud-profile-settings" aria-label="账号概览">
            <div className="cloud-settings-heading"><Icon name="cloud" size={15} /><strong>账号概览</strong></div>
            <div className="cloud-setting-row">
              <span><strong>存储空间</strong><small>{profile ? `${profile.usedFormatted} / ${profile.totalFormatted}` : "正在读取容量信息"}</small></span>
              <span className="setting-value">{profile?.remainingFormatted || "—"} 可用</span>
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
            <div className="cloud-setting-row">
              <span><strong>会员等级</strong><small>由 115 账号资料返回</small></span>
              <span className="setting-value">{profile?.vipLevel || "普通用户"}</span>
            </div>
            <div className="cloud-setting-row">
              <span><strong>默认播放器</strong><small>Sirius 内置播放窗口</small></span>
              <span className="setting-value">内置播放器</span>
            </div>
            <div className="cloud-setting-row app-version">
              <span><strong>Sirius Desktop</strong><small>115 第三方客户端</small></span>
              <span className="setting-value">0.1.0</span>
            </div>
          </div>
          {error && <p className="cloud-inline-error" role="alert">{error}</p>}
        </div>
      </section>
    </div>
  );
}
