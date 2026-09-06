/**
 * UI 冒烟测试专用：在浏览器（非 Tauri 环境）中模拟 Tauri IPC。
 * 仅当 URL 带 `?e2e-mock=1` 时由 main.tsx 加载；打包产物不包含任何真实数据。
 */

type CmdHandler = (args: Record<string, unknown>) => unknown;

declare global {
  interface Window {
    __TAURI_INTERNALS__: {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
      convertFileSrc: (path: string) => string;
      transformCallback: (callback: unknown) => unknown;
    };
  }
}

const now = Math.floor(Date.now() / 1000);

function entry(
  id: string,
  name: string,
  kind: "folder" | "video" | "subtitle" | "file",
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    parentId: "0",
    name,
    kind,
    extension: kind === "folder" ? "" : name.split(".").pop() ?? "",
    sizeBytes: 4 * 1024 * 1024,
    modifiedAt: now - 86_400,
    pickCode: `pick-${id}`,
    thumbUrl: null,
    children: kind === "folder" ? 3 : null,
    ...overrides,
  };
}

const FOLDER_PAGE = {
  entries: [
    entry("d1", "电影", "folder"),
    entry("d2", "纪录片", "folder"),
    entry("f1", "Arrival.2016.mkv", "video"),
    entry("f2", "Perfect.Days.2023.mkv", "video"),
    entry("f3", "Arrival.2016.chs.srt", "subtitle"),
    entry("f4", "笔记.txt", "file"),
  ],
  total: 6,
  offset: 0,
  limit: 100,
  hasMore: false,
};

const HANDLERS: Record<string, CmdHandler> = {
  cloud115_account_status: () => ({ connected: true, userName: "冒烟测试员", userId: 42 }),
  cloud115_client_apps: () => [
    { id: "100195125", name: "媒体播放器" },
    { id: "100195127", name: "蒙太奇播放器" },
  ],
  cloud115_user_profile: () => ({
    userId: 42,
    userName: "冒烟测试员",
    avatarUrl: "",
    totalBytes: 1024 ** 4,
    usedBytes: 512 * 1024 ** 3,
    remainingBytes: 1024 ** 4 - 512 * 1024 ** 3,
    totalFormatted: "1 TB",
    usedFormatted: "512 GB",
    remainingFormatted: "512 GB",
    vipLevel: " platinum",
    vipExpiresAt: 0,
  }),
  cloud115_list_files: () => FOLDER_PAGE,
  cloud115_video_subtitles: () => [],
  cloud115_playback_source: () => ({
    url: "https://example.invalid/video.m3u8",
    userAgent: "Mozilla/5.0",
  }),
  cloud115_upload_sessions: () => [],
  cloud115_file_metadata: () => ({
    id: "f1",
    name: "Arrival.2016.mkv",
    parentId: "0",
    isFolder: false,
    fileType: "1",
    sizeBytes: FOLDER_PAGE.entries[2].sizeBytes,
    modifiedAt: now,
    durationSeconds: 7163,
    pickCode: "pick-f1",
    sha1: "",
    starred: false,
    path: [],
  }),
  ai_provider_settings: () => ({
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    keyStored: true,
  }),
  ai_update_provider: () => ({
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    keyStored: true,
  }),
  ai_analyze_folder: () => ({
    folderId: "d1",
    analyzedCount: 6,
    truncated: false,
    summary: "建议规范化影视文件名并按主题归类。",
    model: "deepseek-chat",
    items: [
      {
        fileId: "f1",
        currentName: "Arrival.2016.mkv",
        action: "rename",
        suggestedName: "降临 Arrival 2016.mkv",
        targetFolder: "",
        reason: "补充中文译名便于识别",
      },
      {
        fileId: "f2",
        currentName: "Perfect.Days.2023.mkv",
        action: "move",
        suggestedName: "",
        targetFolder: "电影",
        reason: "归类到电影目录",
      },
      { fileId: "d1", currentName: "电影", action: "keep", suggestedName: "", targetFolder: "", reason: "" },
    ],
  }),
  ai_execute_plan: () => ({
    executed: 2,
    skipped: 1,
    failed: 0,
    deletedToRecycleBin: 0,
    createdFolders: 0,
    details: [
      { fileId: "f1", currentName: "Arrival.2016.mkv", action: "rename", status: "done", detail: "已重命名为“降临 Arrival 2016.mkv”" },
      { fileId: "f2", currentName: "Perfect.Days.2023.mkv", action: "move", status: "done", detail: "已移动到“电影”" },
      { fileId: "d1", currentName: "电影", action: "keep", status: "skipped", detail: "保持现状，无需执行" },
    ],
  }),
  comics_index: () => ({
    folderCount: 1,
    lastScannedAt: "2026-09-05 10:00:00",
    series: [
      {
        title: "一拳超人",
        volumeCount: 2,
        totalBytes: 900 * 1024 * 1024,
        volumes: [
          { fileId: "c1", pickCode: "pick-c1", name: "一拳超人 第01卷.cbz", sizeBytes: 400 * 1024 * 1024, coverPath: null },
          { fileId: "c2", pickCode: "pick-c2", name: "一拳超人 第02卷.cbz", sizeBytes: 500 * 1024 * 1024, coverPath: null },
        ],
      },
    ],
  }),
  comics_open_volume: () => ({
    fileId: "c1",
    seriesTitle: "一拳超人",
    pages: [],
    pageCount: 3,
    resumePageIndex: 1,
  }),
  albums_index: () => ({
    folderCount: 2,
    lastScannedAt: "2026-09-05 10:00:00",
    photoCount: 3,
    months: [
      {
        monthKey: "2026-09",
        photoCount: 2,
        photos: [
          { fileId: "p1", folderId: "d2", pickCode: "pick-p1", name: "IMG_0001.jpg", sizeBytes: 3 * 1024 * 1024, takenAt: now - 3600, thumbUrl: null },
          { fileId: "p2", folderId: "d2", pickCode: "pick-p2", name: "IMG_0002.png", sizeBytes: 2 * 1024 * 1024, takenAt: now - 7200, thumbUrl: null },
        ],
      },
      {
        monthKey: "2026-01",
        photoCount: 1,
        photos: [
          { fileId: "p3", folderId: "d1", pickCode: "pick-p3", name: "新年.jpg", sizeBytes: 1024 * 1024, takenAt: 1_767_225_600, thumbUrl: null },
        ],
      },
    ],
    albums: [
      { folderId: "d1", folderName: "电影", photoCount: 1, coverUrl: null },
      { folderId: "d2", folderName: "纪录片", photoCount: 2, coverUrl: null },
    ],
  }),
  library_list: () => [],
  library_search: () => [],
  library_tasks: () => [],
  app_settings: () => ({ metadataLanguage: "zh-CN", autoScrape: true, playbackHistory: true }),
  "plugin:dialog|open": () => null,
};

window.__TAURI_INTERNALS__ = {
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    const handler = HANDLERS[cmd];
    return Promise.resolve(handler ? handler(args ?? {}) : null);
  },
  convertFileSrc: (path: string) => path,
  transformCallback: (callback: unknown) => callback,
};

export {};
