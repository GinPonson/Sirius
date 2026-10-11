import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** transfer://progress 事件名；与 Rust 侧 transfer::TRANSFER_PROGRESS_EVENT 保持一致。 */
export const TRANSFER_PROGRESS_EVENT = "transfer://progress";

/** 传输方向；与 Rust TransferKind 序列化值一致。 */
export type TransferKind = "upload" | "download";

/** 传输阶段；与 Rust TransferStage 序列化值一致。 */
export type TransferStage = "preparing" | "transferring" | "finalizing" | "done" | "failed";

/** transfer://progress 事件负载；字段与 Rust TransferProgress（camelCase）逐一对齐。 */
export type TransferProgress = {
  transferId: string;
  kind: TransferKind;
  fileName: string;
  stage: TransferStage;
  /** multipart 上传已完成分片数；其余传输缺省。 */
  completedParts?: number;
  totalParts?: number;
  transferredBytes?: number;
  totalBytes?: number;
  speedBytesPerSec?: number;
};

/** 判断阶段是否仍在进行中（非终态 done/failed）。 */
export function isTransferActive(stage: TransferStage): boolean {
  return stage === "preparing" || stage === "transferring" || stage === "finalizing";
}

/** 订阅传输进度事件；返回取消订阅函数。 */
export function listenTransferProgress(
  handler: (progress: TransferProgress) => void,
): Promise<UnlistenFn> {
  return listen<TransferProgress>(TRANSFER_PROGRESS_EVENT, (event) => handler(event.payload));
}
