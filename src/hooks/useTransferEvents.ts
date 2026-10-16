import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  isTransferActive,
  listenTransferProgress,
  type TransferKind,
  type TransferProgress,
  type TransferStage,
} from "../services/events";

/** 单条传输在界面上的折叠状态；由同一 transferId 的最新事件累积而成。 */
export type TransferState = {
  transferId: string;
  kind: TransferKind;
  fileName: string;
  stage: TransferStage;
  completedParts?: number;
  totalParts?: number;
  transferredBytes?: number;
  totalBytes?: number;
  speedBytesPerSec?: number;
  /** 最近一次事件到达时间，用于排序与终态条目淘汰。 */
  updatedAt: number;
};

/** 最多保留的已结束传输条数，避免长时间运行时列表无限增长。 */
const MAX_FINISHED_TRANSFERS = 20;

/** 模块级单例 store：全应用共享一份传输状态，多个组件订阅不重复注册事件监听。 */
const transfers = new Map<string, TransferState>();
const listeners = new Set<() => void>();
let unlistenPromise: Promise<UnlistenFn> | null = null;

/** 合并一次进度事件：数值字段缺省时保留上一次的值，终态速度不回填。 */
function handleTransferProgress(progress: TransferProgress) {
  const previous = transfers.get(progress.transferId);
  transfers.set(progress.transferId, {
    transferId: progress.transferId,
    kind: progress.kind,
    fileName: progress.fileName,
    stage: progress.stage,
    completedParts: progress.completedParts ?? previous?.completedParts,
    totalParts: progress.totalParts ?? previous?.totalParts,
    transferredBytes: progress.transferredBytes ?? previous?.transferredBytes,
    totalBytes: progress.totalBytes ?? previous?.totalBytes,
    speedBytesPerSec: isTransferActive(progress.stage)
      ? (progress.speedBytesPerSec ?? previous?.speedBytesPerSec)
      : progress.speedBytesPerSec,
    updatedAt: Date.now(),
  });
  pruneFinishedTransfers();
  for (const listener of listeners) listener();
}

/** 已结束条目超过上限时按结束时间淘汰最旧的；进行中的传输始终保留。 */
function pruneFinishedTransfers() {
  const finished = [...transfers.values()]
    .filter((transfer) => !isTransferActive(transfer.stage))
    .sort((a, b) => a.updatedAt - b.updatedAt);
  const overflow = finished.length - MAX_FINISHED_TRANSFERS;
  if (overflow <= 0) return;
  for (const transfer of finished.slice(0, overflow)) {
    transfers.delete(transfer.transferId);
  }
}

/** 建立唯一的模块级事件订阅；失败时允许下一次挂载重试。 */
function ensureTransferSubscription(): Promise<UnlistenFn> {
  if (unlistenPromise === null) {
    unlistenPromise = listenTransferProgress(handleTransferProgress).catch((error) => {
      unlistenPromise = null;
      throw error;
    });
  }
  return unlistenPromise;
}

/** 快照：进行中的传输在前，其后按最近更新时间倒序排列已结束传输。 */
function snapshotTransfers(): TransferState[] {
  const all = [...transfers.values()];
  const active = all
    .filter((transfer) => isTransferActive(transfer.stage))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const finished = all
    .filter((transfer) => !isTransferActive(transfer.stage))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return [...active, ...finished];
}

/** 订阅传输进度单例 store；返回当前活跃/最近完成的传输列表。 */
export function useTransferEvents(): TransferState[] {
  const [snapshot, setSnapshot] = useState<TransferState[]>(snapshotTransfers);
  useEffect(() => {
    const refresh = () => setSnapshot(snapshotTransfers());
    listeners.add(refresh);
    let disposed = false;
    ensureTransferSubscription().catch((error) => {
      if (!disposed) console.error("订阅传输进度事件失败", error);
    });
    return () => {
      disposed = true;
      listeners.delete(refresh);
    };
  }, []);
  return snapshot;
}
