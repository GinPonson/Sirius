import { useState } from "react";
import type { LibraryTask } from "../domain/media";
import { useTransferEvents, type TransferState } from "../hooks/useTransferEvents";
import { isTransferActive } from "../services/events";
import { Icon } from "./Icon";

type TaskDrawerProps = {
  tasks: LibraryTask[];
  scanning: boolean;
  onScan: () => void;
  /** 打开完整任务页（整理任务分区）。 */
  onOpenFullPage: () => void;
};

/** 字节格式化：与传输事件口径一致，不做精度虚报。 */
function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "";
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
function transferStageLabel(transfer: TransferState): string {
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

/** 传输进度百分比；无总字节时返回 null，界面不显示假进度。 */
function transferPercent(transfer: TransferState): number | null {
  if (transfer.transferredBytes === undefined || transfer.totalBytes === undefined || transfer.totalBytes <= 0) {
    return null;
  }
  return Math.min(100, Math.max(0, (transfer.transferredBytes / transfer.totalBytes) * 100));
}

/**
 * 任务抽屉：统一承载「上传 / 下载 / 扫描与索引 / AI 执行」四类任务。
 * 收起时入口保留进行中数量；展开显示任务行（名称、阶段、进度、操作、失败原因）。
 */
export function TaskDrawer({ tasks, scanning, onScan, onOpenFullPage }: TaskDrawerProps) {
  const [open, setOpen] = useState(false);
  const transfers = useTransferEvents();
  const activeTransfers = transfers.filter((transfer) => isTransferActive(transfer.stage));
  const activeTaskCount = tasks.filter((task) => task.status !== "completed").length;
  // 入口徽标：进行中的传输 + 未完成的扫描任务。
  const badgeCount = activeTransfers.length + (scanning ? 1 : 0) + activeTaskCount;

  return (
    <>
      <button
        type="button"
        className="task-drawer-toggle"
        aria-expanded={open}
        aria-label={open ? "收起任务中心" : "展开任务中心"}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="tasks" size={16} />
        {badgeCount > 0 && <span className="task-drawer-badge">{badgeCount}</span>}
      </button>

      <aside className="task-drawer" data-open={open ? "true" : "false"} aria-hidden={!open} inert={!open} aria-label="任务中心">
        <header className="task-drawer-head">
          <strong>任务中心</strong>
          <button type="button" onClick={onOpenFullPage}>扫描与刮削详情</button>
          <button type="button" aria-label="收起任务中心" onClick={() => setOpen(false)}>
            <Icon name="close" size={15} />
          </button>
        </header>

        <div className="task-drawer-body">
          {scanning && (
            <article className="task-drawer-row" aria-live="polite">
              <span className="task-drawer-icon running"><Icon name="tasks" size={16} /></span>
              <div className="task-drawer-copy">
                <strong>正在扫描媒体目录</strong>
                <small>读取文件并生成待刮削任务</small>
              </div>
              <span className="task-drawer-stage">进行中</span>
            </article>
          )}

          {transfers.map((transfer) => {
            const percent = transferPercent(transfer);
            return (
              <article key={transfer.transferId} className="task-drawer-row">
                <span className={`task-drawer-icon ${isTransferActive(transfer.stage) ? "running" : transfer.stage}`}>
                  <Icon name={transfer.kind === "upload" ? "upload" : "download"} size={16} />
                </span>
                <div className="task-drawer-copy">
                  <strong title={transfer.fileName}>{transfer.fileName}</strong>
                  <small>
                    {transfer.kind === "upload" ? "上传" : "下载"}
                    {transfer.transferredBytes !== undefined && transfer.totalBytes !== undefined
                      ? ` · ${formatBytes(transfer.transferredBytes)} / ${formatBytes(transfer.totalBytes)}`
                      : ""}
                    {isTransferActive(transfer.stage) && transfer.speedBytesPerSec !== undefined
                      ? ` · ${formatSpeed(transfer.speedBytesPerSec)}`
                      : ""}
                  </small>
                  {percent !== null && isTransferActive(transfer.stage) && (
                    <span className="task-drawer-progress"><span style={{ width: `${percent}%` }} /></span>
                  )}
                </div>
                <span className={`task-drawer-stage ${transfer.stage}`}>{transferStageLabel(transfer)}</span>
              </article>
            );
          })}

          {tasks.map((task) => (
            <article key={task.id} className="task-drawer-row">
              <span className={`task-drawer-icon ${task.status === "attention" ? "failed" : task.status === "completed" ? "done" : "running"}`}>
                <Icon name={task.status === "attention" ? "alert" : task.status === "completed" ? "check" : "tasks"} size={16} />
              </span>
              <div className="task-drawer-copy">
                <strong>{task.title}</strong>
                <small>{task.detail}</small>
              </div>
              <span className={`task-drawer-stage ${task.status === "attention" ? "failed" : task.status === "completed" ? "done" : "running"}`}>
                {task.status === "attention" ? "需要处理" : task.status === "completed" ? "已完成" : "进行中"}
              </span>
            </article>
          ))}

          {!scanning && transfers.length === 0 && tasks.length === 0 && (
            <div className="task-drawer-empty">
              <Icon name="tasks" size={20} />
              <p>还没有进行中的任务。上传、下载、扫描与整理执行都会出现在这里。</p>
              <button type="button" className="secondary-action" disabled={scanning} onClick={onScan}>
                扫描媒体目录
              </button>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
