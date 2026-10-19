/** 视频窗口可展示的会话状态；不包含播放直链、请求头或账号信息。 */
export type PlayerWindowState = {
  title: string;
  initialized: boolean;
  paused: boolean;
  positionSeconds: number | null;
  durationSeconds: number | null;
  volume: number;
  error: string | null;
  warning: string | null;
  qualities: string[];
  activeQuality: string;
};

/** 视频窗口发送给主窗口的用户意图；主窗口继续负责唯一播放会话和历史进度。 */
export type PlayerWindowAction =
  | { type: "ready" }
  | { type: "pause" }
  | { type: "seek"; seconds: number }
  | { type: "volume"; volume: number }
  | { type: "mute" }
  | { type: "quality"; quality: string }
  | { type: "stop" };

/** 每个操作携带唯一编号，只有收到对应结果才向用户确认操作完成。 */
export type PlayerActionRequest = { id: string; action: PlayerWindowAction };
export type PlayerActionResult = { id: string; error: string | null };

/** 原生窗口关闭后通知主界面清理状态；失败时保留真实错误。 */
export type PlayerWindowClosed = { error: string | null };
