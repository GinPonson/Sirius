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
  /** 启动时读取 115 账号失败后展示的错误和恢复指引。 */
  initialError?: string | null;
};

const cloud115 = new Cloud115Service();

/**
 * 登录专属首屏：非对称双区构图。深色叙事舞台承载品牌与能力说明，
 * 浅色操作面板承载二维码与应用身份切换；未登录时不展示任何受保护界面。
 */
export function LoginGate({ onAccountChange, initialError = null }: LoginGateProps) {
  const [apps, setApps] = useState<Cloud115ClientApp[]>([]);
  const [clientId, setClientId] = useState("");
  const [challenge, setChallenge] = useState<Cloud115AuthChallenge | null>(null);
  const [message, setMessage] = useState("正在生成登录二维码");
  /** 二维码过期：保留已生成的二维码作为淡化背景，覆盖刷新提示层。 */
  const [expired, setExpired] = useState(false);
  const [showAppPicker, setShowAppPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 扫码流程的当前错误更具体；启动读取错误在流程成功前持续可见。
  const visibleError = error ?? initialError;
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
          // 保留二维码本身，交给界面叠加「已过期」刷新层；避免闪回空白加载态。
          setExpired(true);
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
    setExpired(false);
    setMessage("正在生成登录二维码");
    try {
      setChallenge(await cloud115.beginAuth(nextClientId));
      setMessage("请使用 115 App 扫描二维码");
    } catch (reason) {
      setChallenge(null);
      setExpired(false);
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
          {/* 品牌标记兼作隐藏入口：点击才展开登录应用选择，不在界面上暴露额外按钮。 */}
          <div ref={appSwitcherRef} className="cloud-app-switcher">
            <button
              type="button"
              className={showAppPicker ? "brand-mark cloud-app-trigger active" : "brand-mark cloud-app-trigger"}
              aria-label="选择登录应用"
              aria-expanded={showAppPicker}
              title="选择登录应用"
              onClick={() => setShowAppPicker((value) => !value)}
            >
              <BrandMark size={20} />
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
          <div>
            <strong>登录 115</strong>
            <span>使用 115 App 扫码并确认</span>
          </div>
        </header>

        <button
          className="login-qr"
          data-expired={expired ? "true" : "false"}
          aria-label={expired ? "二维码已过期，点击刷新" : challenge ? "重新生成登录二维码" : "正在生成登录二维码"}
          disabled={busy || !clientId}
          onClick={() => void generateQr(clientId)}
        >
          {challenge ? <img src={challenge.qrDataUri} alt="" /> : <span className="cloud-auth-loading" />}
          {expired && (
            // 过期态保留淡化的二维码作为背景，整块区域仍是一个按钮，点击即重新生成。
            <span className="login-qr-expired" aria-hidden="true">
              <span className="login-qr-refresh"><Icon name="refresh" size={24} /></span>
              <span className="login-qr-expired-text">二维码过期，请刷新</span>
            </span>
          )}
        </button>
        {!expired && <strong className="login-status">{busy ? "正在生成登录二维码" : message}</strong>}
        {!expired && <span className="login-tip">二维码失效后点击二维码区域可重新生成</span>}
        {visibleError && <p className="cloud-inline-error" role="alert">{visibleError}</p>}
      </section>
    </div>
  );
}
