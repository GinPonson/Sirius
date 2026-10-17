import { useEffect, useRef, useState } from "react";
import {
  Cloud115Service,
  type Cloud115AccountStatus,
  type Cloud115AuthChallenge,
  type Cloud115ClientApp,
} from "../services/mediaServices";
import { BrandMark } from "./BrandMark";
import { Icon } from "./Icon";

type LoginGateProps = {
  onAccountChange: (account: Cloud115AccountStatus) => void;
};

const cloud115 = new Cloud115Service();

/**
 * 登录专属首屏：非对称双区构图。深色叙事舞台承载品牌与能力说明，
 * 浅色操作面板承载二维码与应用身份切换；未登录时不展示任何受保护界面。
 */
export function LoginGate({ onAccountChange }: LoginGateProps) {
  const [apps, setApps] = useState<Cloud115ClientApp[]>([]);
  const [clientId, setClientId] = useState("");
  const [challenge, setChallenge] = useState<Cloud115AuthChallenge | null>(null);
  const [message, setMessage] = useState("正在生成登录二维码");
  const [showAppPicker, setShowAppPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const appSwitcherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    cloud115.clientApps()
      .then((items) => {
        if (!active) return;
        const defaultClientId = items[0]?.id ?? "";
        setApps(items);
        setClientId(defaultClientId);
        if (defaultClientId) {
          void generateQr(defaultClientId);
        } else {
          setMessage("没有可用的登录应用");
          setError("115 登录应用列表为空，请重启应用后再试");
        }
      })
      .catch((reason) => {
        if (!active) return;
        setMessage("暂时无法生成登录二维码");
        setError(`读取登录应用失败：${String(reason)}`);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    /** 点击应用菜单外部只关闭菜单，不离开登录首屏。 */
    function handlePointerDown(event: PointerEvent) {
      if (showAppPicker && !appSwitcherRef.current?.contains(event.target as Node)) {
        setShowAppPicker(false);
      }
    }

    /** Esc 只收起应用菜单；登录是唯一出口，不提供绕过路径。 */
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && showAppPicker) {
        setShowAppPicker(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showAppPicker]);

  useEffect(() => {
    if (!challenge) return;
    let active = true;
    let timeout: number | null = null;

    /** 每次长轮询结束后再调度下一次，避免并发请求同一设备码会话。 */
    async function poll() {
      try {
        const result = await cloud115.pollAuth();
        if (!active) return;
        setMessage(result.message);
        if (result.status === "authorized" && result.account) {
          onAccountChange(result.account);
          return;
        }
        if (result.status === "expired" || result.status === "denied") {
          setChallenge(null);
          return;
        }
        timeout = window.setTimeout(poll, 1200);
      } catch (reason) {
        if (!active) return;
        setError(`查询授权状态失败：${String(reason)}`);
        timeout = window.setTimeout(poll, 2500);
      }
    }

    void poll();
    return () => {
      active = false;
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [challenge, onAccountChange]);

  /** 为指定应用身份重新申请设备码；切换身份后旧会话立即被覆盖。 */
  async function generateQr(nextClientId: string) {
    if (!nextClientId) {
      setError("尚未选择可用的登录应用");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage("正在生成登录二维码");
    try {
      setChallenge(await cloud115.beginAuth(nextClientId));
      setMessage("请使用 115 App 扫描二维码");
    } catch (reason) {
      setChallenge(null);
      setMessage("登录二维码未能生成");
      setError(`生成登录二维码失败：${String(reason)}`);
    } finally {
      setBusy(false);
    }
  }

  async function selectApp(nextClientId: string) {
    setClientId(nextClientId);
    setShowAppPicker(false);
    await generateQr(nextClientId);
  }

  return (
    <div className="login-gate" role="dialog" aria-modal="true" aria-label="登录 Sirius">
      <section className="login-gate-stage">
        <div className="login-stage-orbs" aria-hidden="true"><i /><i /></div>
        <span className="login-stage-eyebrow">115 THIRD-PARTY CLIENT</span>
        <h1 className="login-stage-title">Sirius</h1>
        <p className="login-stage-lede">
          把 115 网盘当作本机文件来管理：浏览、播放与整理在同一工作台完成。
        </p>
        <ul className="login-stage-points">
          <li><Icon name="cloud" size={17} /> 网盘文件与批量操作</li>
          <li><Icon name="play" size={17} /> 原生播放引擎直接解码云端视频</li>
          <li><Icon name="tasks" size={17} /> 可审查的整理任务与回收站保护</li>
        </ul>
        <p className="login-stage-security">授权 Token 保存在 macOS 钥匙串，不会离开本机。</p>
      </section>

      <section className="login-gate-panel">
        <header className="login-panel-head">
          <span className="brand-mark"><BrandMark size={20} /></span>
          <div>
            <strong>登录 115</strong>
            <span>使用 115 App 扫码并确认</span>
          </div>
          <div ref={appSwitcherRef} className="cloud-app-switcher">
            <button
              className={showAppPicker ? "cloud-app-icon active" : "cloud-app-icon"}
              aria-label="选择登录应用"
              aria-expanded={showAppPicker}
              title="选择登录应用"
              onClick={() => setShowAppPicker((value) => !value)}
            >
              <Icon name="more" size={16} />
            </button>
            {showAppPicker && (
              <div className="cloud-app-picker" role="menu">
                {apps.map((app) => (
                  <button
                    key={app.id}
                    role="menuitemradio"
                    aria-checked={clientId === app.id}
                    className={clientId === app.id ? "active" : ""}
                    onClick={() => void selectApp(app.id)}
                  >
                    <span>{app.name}</span>
                    <i />
                  </button>
                ))}
              </div>
            )}
          </div>
        </header>

        <button
          className="login-qr"
          aria-label={challenge ? "重新生成登录二维码" : "正在生成登录二维码"}
          disabled={busy || !clientId}
          onClick={() => void generateQr(clientId)}
        >
          {challenge ? <img src={challenge.qrDataUri} alt="115 App 登录二维码" /> : <span className="cloud-auth-loading" />}
        </button>
        <strong className="login-status">{busy ? "正在生成登录二维码" : message}</strong>
        <span className="login-tip">二维码失效后点击二维码区域可重新生成</span>
        {!challenge && !busy && <button className="secondary-action" onClick={() => void generateQr(clientId)}>重新生成</button>}
        {error && <p className="cloud-inline-error" role="alert">{error}</p>}
      </section>
    </div>
  );
}
