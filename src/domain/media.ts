/** 应用一级导航；页面先保持轻量状态切换，后续可无痛映射到正式路由。 */
export type AppSection =
  | "home"
  | "library"
  | "discover"
  | "comics"
  | "albums"
  | "cloud-files"
  | "tasks"
  | "settings";

/** 媒体类型；后续剧集可以继续扩展季、集模型。 */
export type MediaKind = "movie" | "series";

/** 刮削后的媒体实体。 */
export type MediaItem = {
  id: string;
  title: string;
  originalTitle: string;
  year: number;
  kind: MediaKind;
  rating: number;
  runtimeMinutes: number;
  genres: string[];
  overview: string;
  director: string;
  cast: string[];
  posterTone: string;
  posterAccent: string;
  progress: number;
  sourceLabel: string;
  sourceStatus: "ready" | "unlinked";
};

/** 播放器只接受该统一模型，不感知文件来自本地还是网盘。 */
export type PlaybackSource = {
  mediaId: string;
  uri: string;
  origin: "local" | "cloud115";
  headers: Record<string, string>;
  title: string;
};

/** 扫描与刮削任务。 */
export type LibraryTask = {
  id: string;
  title: string;
  detail: string;
  status: "running" | "completed" | "attention";
  progress: number;
};

/** Rust PlaybackManager 返回的稳定状态快照。 */
export type PlaybackSnapshot = {
  initialized: boolean;
  source: string | null;
  paused: boolean;
  positionSeconds: number | null;
  durationSeconds: number | null;
  volume: number;
  /** 远程播放自动恢复失败后的错误；恢复成功时清除。 */
  error: string | null;
};
