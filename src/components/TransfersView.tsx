import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Cloud115Service,
  type Cloud115AccountStatus,
  type Cloud115UploadSession,
} from "../services/mediaServices";
import { isTransferActive } from "../services/events";
import { useTransferEvents, type TransferState } from "../hooks/useTransferEvents";
import { Icon } from "./Icon";

/** 模块级单例服务：与服务层其它组件一致，避免每次渲染重复构造。 */
const cloud115 = new Cloud115Service();

/** 传输页的二级标签：上传 / 下载按方向过滤，待恢复是 SQLite 中未完成的会话。 */
type TransferTab = "upload" | "download" | "pending";

const TABS: Array<{ id: TransferTab; label: string; icon: "upload" | "download" | "history" }> = [
  { id: "upload", label: "上传", icon: "upload" },
  { id: "download", label: "下载", icon: "download" },
  { id: "pending", label: "待恢复", icon: "history" },
];

/** 字节格式化：与传输事件口径一致，不做精度虚报。 */
function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 速度展示：与字节同单位换算，后缀 /s。 */
function formatSpeed(bytesPerSecond: number | undefined): string {
  if (bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "";
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** 传输阶段的中文文案（与 Rust 事件契约一一对应）。 */
function stageLabel(transfer: TransferState): string {
  switch (transfer.stage) {
    case "preparing":
      return "正在准备";
    case "transferring":
      return transfer.kind === "upload" && transfer.completedParts !== undefined && transfer.totalParts !== undefined
        ? `第 ${transfer.completedParts}/${transfer.totalParts} 片`
        : "正在传输";
    case "finalizing":
      return "正在确认文件";
    case "done":
      return "已完成";
    case "failed":
      return "失败";
  }
}

/** 进度百分比；无总字节时返回 null，界面不显示假进度。 */
function transferPercent(transfer: TransferState): number | null {
  if (transfer.transferredBytes === undefined || transfer.totalBytes === undefined || transfer.totalBytes <= 0) {
    return null;
  }
  return Math.min(100, Math.max(0, (transfer.transferredBytes / transfer.totalBytes) * 100));
}

type TransfersViewProps = {
  account: Cloud115AccountStatus | null;
  onRequireLogin: () => void;
};

/**
 * 传输页：集中展示上传、下载与可恢复的 multipart 会话。
 *
 * 数据全部来自真实来源——上传/下载用 `transfer://progress` 事件累积的状态，
 * 待恢复列表来自 SQLite 中未完成的 multipart 会话。页面不提供暂停/取消：
 * Rust 侧当前没有对应的中断命令，放一个点了没反应的按钮属于假承诺。
 *
 * @param props.account 115 账号状态；未连接时禁止恢复上传
 * @param props.onRequireLogin 触发扫码登录
 */
export function TransfersView({ account, onRequireLogin }: TransfersViewProps) {
  const [tab, setTab] = useState<TransferTab>("upload");
  const [sessions, setSessions] = useState<Cloud115UploadSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const transfers = useTransferEvents();
  const activeCount = transfers.filter((transfer) => isTransferActive(transfer.stage)).length;

  /** 读取未完成的 multipart 会话；仅在「待恢复」标签下有意义。 */
  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    setError(null);
    try {
      const items = await cloud115.uploadSessions();
      setSessions(items);
    } catch (reason) {
      setError(`读取待恢复会话失败：${String(reason)}`);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab !== "pending") return;
    void loadSessions();
  }, [tab, loadSessions]);

  const visibleTransfers = useMemo(
    () => transfers.filter((transfer) => transfer.kind === tab),
    [transfers, tab],
  );

  const counts: Record<TransferTab, number> = {
    upload: transfers.filter((transfer) => transfer.kind === "upload" && isTransferActive(transfer.stage)).length,
    download: transfers.filter((transfer) => transfer.kind === "download" && isTransferActive(transfer.stage)).length,
    pending: sessions.length,
  };

  /** 恢复一条 multipart 会话；进度仍走统一的 transfer://progress 事件。 */
  async function resume(session: Cloud115UploadSession) {
    setResumingId(session.id);
    setError(null);
    try {
      const result = await cloud115.resumeUpload(session.id);
      setNotice(`“${result.fileName}”已恢复上传${result.instant ? "（秒传）" : ""}`);
      // 恢复成功后该会话已完成，重新拉取以反映真实剩余项。
      await loadSessions();
    } catch (reason) {
      setError(`恢复上传失败：${String(reason)}`);
    } finally {
      setResumingId(null);
    }
  }

  return (
    <section className="page-section transfers-view">
      <div className="transfers-heading">
        <div>
          <span className="context-label">上传与下载</span>
          <h2>传输</h2>
        </div>
        <span className="transfers-count">
          {activeCount > 0 ? `${activeCount} 项进行中` : "当前没有进行中的传输"}
        </span>
      </div>

      <div className="transfers-layout">
        <nav className="transfers-tabs" aria-label="传输分类">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={tab === item.id ? "active" : ""}
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => setTab(item.id)}
            >
              <Icon name={item.icon} size={16} />
              <span>{item.label}</span>
              {counts[item.id] > 0 && <span className="transfers-tab-count">{counts[item.id]}</span>}
            </button>
          ))}
        </nav>

        <div className="transfers-body">
          {error && <div className="cloud-inline-error" role="alert">{error}</div>}
          {notice && (
            <div className="cloud-action-notice" role="status">
              <Icon name="check" size={14} />
              {notice}
              <button aria-label="关闭提示" onClick={() => setNotice(null)}><Icon name="close" size={13} /></button>
            </div>
          )}
          {!account?.connected && (
            <div className="transfers-login-hint" role="status">
              <Icon name="cloud" size={16} />
              <span>未登录 115，历史传输仍会显示，但恢复上传需要登录。</span>
              <button className="secondary-action" onClick={onRequireLogin}>扫码登录</button>
            </div>
          )}

          {tab === "pending" ? (
            sessionsLoading ? (
              <div className="transfers-empty" role="status">正在读取待恢复会话…</div>
            ) : sessions.length === 0 ? (
              <div className="transfers-empty" role="status">
                <Icon name="history" size={22} />
                <strong>没有待恢复的上传</strong>
                <span>大文件上传中断后，会话会保存在本机；重新连接后可在这里继续，不必从头开始。</span>
              </div>
            ) : (
              <div className="transfers-list" role="list" aria-label="待恢复上传">
                {sessions.map((session) => (
                  <article className="transfers-row" role="listitem" key={session.id}>
                    <span className="transfers-row-icon"><Icon name="upload" size={16} /></span>
                    <div className="transfers-row-copy">
                      <strong title={session.fileName}>{session.fileName}</strong>
                      <small>
                        {formatBytes(session.fileSize)}
                        {session.completedParts.length > 0 && ` · 已完成 ${session.completedParts.length} 片`}
                      </small>
                    </div>
                    <button
                      type="button"
                      className="secondary-action"
                      disabled={resumingId !== null || !account?.connected}
                      title={account?.connected ? "从已上传的分片继续" : "登录后才能恢复上传"}
                      onClick={() => void resume(session)}
                    >
                      {resumingId === session.id ? "恢复中…" : "恢复"}
                    </button>
                  </article>
                ))}
              </div>
            )
          ) : visibleTransfers.length === 0 ? (
            <div className="transfers-empty" role="status">
              <Icon name={tab === "upload" ? "upload" : "download"} size={22} />
              <strong>{tab === "upload" ? "还没有上传记录" : "还没有下载记录"}</strong>
              <span>
                {tab === "upload"
                  ? "在网盘文件页选择「上传文件」后，进度会显示在这里。"
                  : "在文件菜单里选择「下载」后，进度会显示在这里。"}
              </span>
            </div>
          ) : (
            <div className="transfers-list" role="list" aria-label={tab === "upload" ? "上传记录" : "下载记录"}>              {visibleTransfers.map((transfer) => {
                const percent = transferPercent(transfer);
                const active = isTransferActive(transfer.stage);
                return (
                  <article className="transfers-row" role="listitem" key={transfer.transferId}>
                    <span className={`transfers-row-icon ${active ? "running" : transfer.stage}`}>
                      <Icon name={transfer.kind === "upload" ? "upload" : "download"} size={16} />
                    </span>
                    <div className="transfers-row-copy">
                      <strong title={transfer.fileName}>{transfer.fileName}</strong>
                      <small>
                        {transfer.transferredBytes !== undefined && transfer.totalBytes !== undefined
                          ? `${formatBytes(transfer.transferredBytes)} / ${formatBytes(transfer.totalBytes)}`
                          : "大小未知"}
                        {active && transfer.speedBytesPerSec !== undefined
                          ? ` · ${formatSpeed(transfer.speedBytesPerSec)}`
                          : ""}
                      </small>
                      {percent !== null && active && (
                        <span className="transfers-row-progress"><span style={{ width: `${percent}%` }} /></span>
                      )}
                    </div>
                    <span className={`transfers-row-stage ${transfer.stage}`}>{stageLabel(transfer)}</span>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
