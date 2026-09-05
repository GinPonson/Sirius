import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  MediaItem,
  LibraryTask,
  PlaybackSnapshot,
  PlaybackSource,
} from "../domain/media";

/** 媒体目录仓储，后续由 SQLite 实现替换。 */
export interface MediaRepository {
  list(): Promise<MediaItem[]>;
  search(query: string): Promise<MediaItem[]>;
}

/** 媒体文件扫描与任务查询服务。 */
export class LibraryTaskService {
  tasks(): Promise<LibraryTask[]> {
    return invoke<LibraryTask[]>("library_tasks");
  }

  async scanLocalDirectory(): Promise<LibraryTask> {
    const selected = await open({
      multiple: false,
      directory: true,
      title: "选择要扫描的媒体目录",
    });
    if (selected === null) {
      throw new Error("已取消选择目录");
    }
    if (Array.isArray(selected)) {
      throw new Error("当前每次只允许扫描一个目录");
    }
    return invoke<LibraryTask>("scan_local_directory", { path: selected });
  }
}

/** 用户可持久化调整的应用设置，与 Rust SQLite 模型保持一致。 */
export type AppSettings = {
  metadataLanguage: "zh-CN" | "en-US";
  autoScrape: boolean;
  playbackHistory: boolean;
};

/** 通过单行 SQLite 配置读取和原子更新应用设置。 */
export class AppSettingsService {
  get(): Promise<AppSettings> {
    return invoke<AppSettings>("app_settings");
  }

  update(settings: AppSettings): Promise<AppSettings> {
    return invoke<AppSettings>("update_app_settings", { settings });
  }
}

/** 将具体来源解析成播放器可消费的统一模型。 */
export interface SourceResolver {
  resolve(media: MediaItem): Promise<PlaybackSource>;
}

/** 通过 Tauri command 访问 Rust SQLite Repository。 */
export class TauriMediaRepository implements MediaRepository {
  async list(): Promise<MediaItem[]> {
    return invoke<MediaItem[]>("library_list");
  }

  async search(query: string): Promise<MediaItem[]> {
    return invoke<MediaItem[]>("library_search", { query });
  }
}

/** 当前可工作的本地来源解析器；选择器返回的绝对路径交给 Rust 再次校验。 */
export class LocalSourceResolver implements SourceResolver {
  async resolve(media: MediaItem): Promise<PlaybackSource> {
    const selected = await open({
      multiple: false,
      directory: false,
      title: `为《${media.title}》选择视频文件`,
      filters: [
        {
          name: "视频",
          extensions: ["mkv", "mp4", "mov", "avi", "webm", "m4v", "ts"],
        },
      ],
    });

    if (selected === null) {
      throw new Error("已取消选择视频");
    }
    if (Array.isArray(selected)) {
      throw new Error("当前播放器只接受单个视频文件");
    }

    return {
      mediaId: media.id,
      uri: selected,
      origin: "local",
      headers: {},
      title: media.title,
    };
  }
}

/** 播放应用服务；统一封装前端到 Rust PlaybackManager 的命令协议。 */
export class PlaybackService {
  open(source: PlaybackSource): Promise<PlaybackSnapshot> {
    return invoke<PlaybackSnapshot>("open_local_file", { path: source.uri });
  }

  /** 打开由 Rust Provider 解析并校验的 HTTPS 远程播放源；pickCode 供 URL 过期时自动恢复。 */
  openRemote(
    source: Cloud115PlaybackSource,
    subtitles: Cloud115SubtitleStream[] = [],
    pickCode = "",
  ): Promise<PlaybackSnapshot> {
    return invoke<PlaybackSnapshot>("open_remote_url", {
      url: source.url,
      userAgent: source.userAgent,
      subtitleUrls: subtitles.map((subtitle) => subtitle.url),
      pickCode,
    });
  }

  snapshot(): Promise<PlaybackSnapshot> {
    return invoke<PlaybackSnapshot>("playback_snapshot");
  }

  togglePause(): Promise<PlaybackSnapshot> {
    return invoke<PlaybackSnapshot>("toggle_pause");
  }

  seek(seconds: number): Promise<PlaybackSnapshot> {
    return invoke<PlaybackSnapshot>("seek", { seconds });
  }

  setVolume(volume: number): Promise<PlaybackSnapshot> {
    return invoke<PlaybackSnapshot>("set_volume", { volume });
  }

  destroy(): Promise<void> {
    return invoke("destroy_playback");
  }
}

export type Cloud115ClientApp = { id: string; name: string };
export type Cloud115AccountStatus = { connected: boolean; userName: string | null; userId: number | null };
export type Cloud115UserProfile = {
  userId: number;
  userName: string;
  avatarUrl: string;
  totalBytes: number;
  usedBytes: number;
  remainingBytes: number;
  totalFormatted: string;
  usedFormatted: string;
  remainingFormatted: string;
  vipLevel: string;
  vipExpiresAt: number;
};
export type Cloud115AuthChallenge = { qrDataUri: string; expiresAt: number };
export type Cloud115AuthPoll = {
  status: "waiting" | "scanned" | "authorized" | "expired" | "denied";
  message: string;
  account: Cloud115AccountStatus | null;
};
export type Cloud115FileEntry = {
  id: string;
  parentId: string;
  name: string;
  kind: "folder" | "video" | "subtitle" | "file";
  extension: string;
  sizeBytes: number;
  modifiedAt: number;
  pickCode: string;
  children: number | null;
};
export type Cloud115FilePage = {
  entries: Cloud115FileEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
};
export type Cloud115PlaybackSource = { url: string; userAgent: string };
export type Cloud115PlaybackProgress = { fileId: string; positionSeconds: number; durationSeconds: number };
export type Cloud115SubtitleStream = { id: string; name: string; language: string; format: string; url: string };
export type Cloud115DownloadSource = { url: string; userAgent: string };
export type Cloud115DownloadResult = { fileName: string; savedPath: string; sizeBytes: number; resumedBytes: number };
export type Cloud115FileMetadata = {
  id: string;
  name: string;
  parentId: string;
  isFolder: boolean;
  fileType: string;
  sizeBytes: number;
  modifiedAt: number;
  durationSeconds: number;
  pickCode: string;
  sha1: string;
  starred: boolean;
  path: Array<{ id: string; name: string }>;
};
export type Cloud115FolderResult = { id: string; name: string };
export type Cloud115RecycleItem = { id: string; name: string; isFolder: boolean; sizeBytes: number; deletedAt: number; parentId: string; parentName: string };
export type Cloud115RecyclePage = { entries: Cloud115RecycleItem[]; total: number; offset: number; limit: number; hasMore: boolean };
export type Cloud115UploadResult = { fileName: string; pickCode: string; instant: boolean };

/** 刮削并持久化的媒体信息；时长/分辨率/编码可能为空，取决于来源。 */
export type MediaInfo = {
  provider: string;
  fileId: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
};

/** 媒体信息应用服务；115 走元数据刮削，本地走无渲染 libmpv 探测。 */
export class MediaInfoService {
  scrape115(fileId: string): Promise<MediaInfo> {
    return invoke("media_scrape_115", { fileId });
  }

  probeLocal(path: string): Promise<MediaInfo> {
    return invoke("media_probe_local", { path });
  }
}
export type Cloud115UploadSession = {
  id: string;
  localPath: string;
  fileName: string;
  targetId: string;
  fileSize: number;
  fileSha1: string;
  preSha1: string;
  pickCode: string;
  bucket: string;
  objectKey: string;
  uploadId: string;
  callback: string;
  callbackVar: string;
  partSize: number;
  completedParts: Array<{ number: number; etag: string }>;
  status: "uploading" | "paused" | "failed";
};

/** 115 OpenAPI 的前端应用服务；Token 始终只存在于 Rust 与系统钥匙串。 */
export class Cloud115Service {
  clientApps(): Promise<Cloud115ClientApp[]> {
    return invoke("cloud115_client_apps");
  }

  accountStatus(): Promise<Cloud115AccountStatus> {
    return invoke("cloud115_account_status");
  }

  beginAuth(clientId: string): Promise<Cloud115AuthChallenge> {
    return invoke("cloud115_begin_auth", { clientId });
  }

  pollAuth(): Promise<Cloud115AuthPoll> {
    return invoke("cloud115_poll_auth");
  }

  signOut(): Promise<void> {
    return invoke("cloud115_sign_out");
  }

  /** 获取当前登录用户的公开资料、空间容量与会员状态。 */
  userProfile(): Promise<Cloud115UserProfile> {
    return invoke("cloud115_user_profile");
  }

  listFiles(parentId: string, query: string, offset = 0, limit = 100): Promise<Cloud115FilePage> {
    return invoke("cloud115_list_files", { parentId, query, offset, limit });
  }

  playbackSource(pickCode: string): Promise<Cloud115PlaybackSource> {
    return invoke("cloud115_playback_source", { pickCode });
  }

  videoSubtitles(pickCode: string): Promise<Cloud115SubtitleStream[]> {
    return invoke("cloud115_video_subtitles", { pickCode });
  }

  /** 读取保存在 Sirius 本机的 115 视频播放位置。 */
  playbackProgress(fileId: string): Promise<Cloud115PlaybackProgress | null> {
    return invoke("cloud115_playback_progress", { fileId });
  }

  /** 定期保存进度；该数据只写入 Sirius 本地 SQLite。 */
  savePlaybackProgress(fileId: string, positionSeconds: number, durationSeconds: number): Promise<void> {
    return invoke("cloud115_save_playback_progress", { fileId, positionSeconds, durationSeconds });
  }

  downloadSource(pickCode: string): Promise<Cloud115DownloadSource> {
    return invoke("cloud115_download_source", { pickCode });
  }

  /** 下载文件到本地目录；Rust 侧自动断点续传并在成功后原子重命名。 */
  downloadFile(pickCode: string, targetDir: string, fileName: string, expectedSizeBytes: number): Promise<Cloud115DownloadResult> {
    return invoke("cloud115_download_file", { pickCode, targetDir, fileName, expectedSizeBytes });
  }

  /** 选择下载保存目录；用户取消时返回 null。 */
  async pickDownloadDirectory(): Promise<string | null> {
    const selected = await open({
      multiple: false,
      directory: true,
      title: "选择下载保存目录",
    });
    if (selected === null || Array.isArray(selected)) return null;
    return selected;
  }

  fileMetadata(fileId: string): Promise<Cloud115FileMetadata> {
    return invoke("cloud115_file_metadata", { fileId });
  }

  createFolder(parentId: string, name: string): Promise<Cloud115FolderResult> {
    return invoke("cloud115_create_folder", { parentId, name });
  }

  updateFile(fileId: string, options: { name?: string; starred?: boolean }): Promise<void> {
    return invoke("cloud115_update_file", { fileId, name: options.name ?? null, starred: options.starred ?? null });
  }

  moveFiles(fileIds: string[], targetId: string): Promise<void> {
    return invoke("cloud115_move_files", { fileIds, targetId });
  }

  /** 批量复制文件；默认不允许目标目录存在同名项。 */
  copyFiles(fileIds: string[], targetId: string, allowDuplicates = false): Promise<void> {
    return invoke("cloud115_copy_files", { fileIds, targetId, allowDuplicates });
  }

  /** 从磁盘流式上传本地文件；≤20 MiB 单对象 PUT，更大文件由 Rust 走 multipart 并持久化会话。 */
  uploadFile(path: string, targetId: string): Promise<Cloud115UploadResult> {
    return invoke("cloud115_upload_file", { path, targetId });
  }

  /** 选择要上传到当前目录的本地文件；用户取消时返回空数组。 */
  async pickUploadFiles(): Promise<string[]> {
    const selected = await open({
      multiple: true,
      directory: false,
      title: "选择要上传的文件",
    });
    if (selected === null) return [];
    return Array.isArray(selected) ? selected : [selected];
  }

  /** 返回可恢复的 multipart 会话，不包含任何 OSS 临时密钥。 */
  uploadSessions(): Promise<Cloud115UploadSession[]> {
    return invoke("cloud115_upload_sessions");
  }

  /** 校验本地文件后，从持久化的首个缺失分片继续上传。 */
  resumeUpload(sessionId: string): Promise<Cloud115UploadResult> {
    return invoke("cloud115_resume_upload", { sessionId });
  }

  deleteFiles(fileIds: string[]): Promise<void> {
    return invoke("cloud115_delete_files", { fileIds });
  }

  listRecycleBin(offset = 0, limit = 100): Promise<Cloud115RecyclePage> {
    return invoke("cloud115_list_recycle_bin", { offset, limit });
  }

  restoreRecycleItems(itemIds: string[]): Promise<void> {
    return invoke("cloud115_restore_recycle_items", { itemIds });
  }

  deleteRecycleItems(itemIds: string[]): Promise<void> {
    return invoke("cloud115_delete_recycle_items", { itemIds });
  }
}
