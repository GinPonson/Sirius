/**
 * UI 冒烟测试专用：在浏览器（非 Tauri 环境）中模拟 Tauri IPC。
 * 仅当 URL 带 `?e2e-mock=1` 时由 main.tsx 加载；打包产物不包含任何真实数据。
 *
 * 能力概览：
 * - 有状态内存文件系统：建目录、重命名、收藏、移动、复制、删除（进回收站）
 *   都会真实变更状态，随后的列表与元数据查询反映变更；回收站支持还原与彻底删除。
 * - 事件模拟：拦截 `plugin:event|listen`/`plugin:event|unlisten` 维护监听表，
 *   复刻 Tauri v2 `transformCallback` + `runCallback` 的回调投递路径，
 *   使 `@tauri-apps/api/event` 的 `listen()` 在浏览器中可用；
 *   通过 `window.__SIRIUS_MOCK_EMIT__(event, payload)` 可手动触发任意事件。
 * - 传输模拟：`cloud115_upload_file`/`cloud115_resume_upload`/`cloud115_download_file`
 *   会按契约发出 `transfer://progress` 事件序列（preparing → transferring → finalizing → done）。
 * - AI 对话模拟：`ai_chat_*` 六命令（内存会话表），`ai_chat_send` 触发
 *   `ai://chat-token` 流（2-4 字增量、80-150ms 间隔、终态恰好一次，支持停止）。
 * - 暗色预览：URL 带 `theme=dark` 时为根元素写入 `data-theme="dark"`。
 */

type CmdHandler = (args: Record<string, unknown>) => unknown;

declare global {
  interface Window {
    __TAURI_INTERNALS__: {
      invoke: (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
      convertFileSrc: (path: string, protocol?: string) => string;
      transformCallback: (callback: ((data: unknown) => void) | undefined, once?: boolean) => number;
      runCallback?: (id: number, data: unknown) => void;
      unregisterCallback?: (id: number) => void;
    };
    /** 冒烟夹具专用：向已注册的 Tauri 事件监听投递一条事件，返回投递数量。 */
    __SIRIUS_MOCK_EMIT__: (event: string, payload: unknown) => number;
    /** @tauri-apps/api/event 取消订阅所需的内部监听表（见 event.js _unlisten）。 */
    __TAURI_EVENT_PLUGIN_INTERNALS__: {
      unregisterListener: (event: string, eventId: number) => void;
    };
  }
}

/** 暗色预览：并行工作包的 CSS 响应 `[data-theme="dark"]`，这里只负责写入属性。 */
if (new URLSearchParams(window.location.search).get("theme") === "dark") {
  document.documentElement.dataset.theme = "dark";
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

const now = () => Math.floor(Date.now() / 1000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 与 Rust 命令的 `Result<_, String>` 对齐：错误一律以字符串消息抛出。 */
function fail(message: string): never {
  throw new Error(message);
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** 稳定的字符串散列，用于从文件名或路径派生确定性的演示数据。 */
function hashOf(text: string): number {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) & 0x7fffffff;
  }
  return hash;
}

function formatStamp(seconds: number): string {
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function monthKeyOf(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** 生成一个演示用 SVG 数据 URI（相册缩略图、漫画页、二维码），避免外链图片。 */
function svgDataUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function photoThumbDataUri(tone: string): string {
  return svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${tone}"/><stop offset="1" stop-color="#1c2430"/>` +
      `</linearGradient></defs><rect width="160" height="120" fill="url(#g)"/></svg>`,
  );
}

/** 漫画假页：米白纸面 + 确定性分格框线 + 居中大页码，页码标注清晰，供阅读器自查翻页正确性。 */
function comicPageDataUri(pageIndex: number, pageCount: number): string {
  const page = pageIndex + 1;
  // 分格布局按页码确定性变化：页序 1..8 在四种分格模板间循环，保证翻页可见。
  const template = pageIndex % 4;
  const pageTemplates: Array<Array<[number, number, number, number]>> = [
    [
      [56, 64, 488, 300],
      [56, 392, 236, 300],
      [308, 392, 236, 300],
      [56, 720, 488, 80],
    ],
    [
      [56, 64, 236, 220],
      [308, 64, 236, 220],
      [56, 312, 488, 380],
      [56, 720, 488, 80],
    ],
    [
      [56, 64, 488, 424],
      [56, 516, 154, 284],
      [226, 516, 154, 284],
      [396, 516, 148, 284],
    ],
    [
      [56, 64, 154, 736],
      [238, 64, 306, 356],
      [238, 448, 306, 352],
      [56, 828, 488, 0],
    ],
  ];
  const panels = pageTemplates[template] ?? [];
  const rects = panels
    .filter(([, , , height]) => height > 0)
    .map(
      ([x, y, width, height]) =>
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#ffffff" stroke="#c9c2b4" stroke-width="2"/>`,
    )
    .join("");
  return svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="880" viewBox="0 0 600 880">` +
      `<rect width="600" height="880" fill="#efece5"/>` +
      `<rect x="28" y="28" width="544" height="824" fill="#fbfaf7"/>` +
      rects +
      `<text x="300" y="420" font-family="PingFang SC, sans-serif" font-size="88" font-weight="600" fill="#3a3630" text-anchor="middle">` +
      `${page}</text>` +
      `<text x="300" y="486" font-family="PingFang SC, sans-serif" font-size="24" fill="#6d675c" text-anchor="middle">` +
      `第 ${page} 页 / 共 ${pageCount} 页</text>` +
      `<text x="572" y="864" font-family="PingFang SC, sans-serif" font-size="14" fill="#9a9384" text-anchor="end">` +
      `${page} / ${pageCount}</text></svg>`,
  );
}

/** 漫画演示封面：2/3 海报比例、确定性三色调之一，竖排书名加卷号；仅供冒烟截图。 */
const COMIC_COVER_TONES: Array<[string, string]> = [
  ["#5969ed", "#2c3572"],
  ["#b86c4a", "#5e3421"],
  ["#4a8054", "#22402a"],
];

function comicCoverDataUri(title: string, volumeNumber: number): string {
  const [top, bottom] = COMIC_COVER_TONES[hashOf(title) % COMIC_COVER_TONES.length];
  const chars = [...title.slice(0, 6)];
  const spine = chars
    .map(
      (char, index) =>
        `<text x="52" y="${96 + index * 52}" font-family="PingFang SC, sans-serif" font-size="38" font-weight="600" fill="#ffffff">${char}</text>`,
    )
    .join("");
  return svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1.2">` +
      `<stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/>` +
      `</linearGradient></defs>` +
      `<rect width="300" height="450" fill="url(#g)"/>` +
      `<rect x="0" y="0" width="14" height="450" fill="rgba(255,255,255,0.22)"/>` +
      spine +
      `<text x="266" y="404" font-family="DM Sans, sans-serif" font-size="64" font-weight="700" fill="rgba(255,255,255,0.9)" text-anchor="end">${volumeNumber}</text>` +
      `<text x="266" y="432" font-family="PingFang SC, sans-serif" font-size="15" fill="rgba(255,255,255,0.72)" text-anchor="end">SIRIUS 漫画</text></svg>`,
  );
}

/** 伪二维码：三枚定位角加由 seed 决定的点阵，仅供冒烟截图，不可真实扫码。 */
function pseudoQrDataUri(seed: string): string {
  const size = 21;
  const cell = 8;
  const margin = 8;
  const dimension = size * cell + margin * 2;
  const finderOrigins: Array<[number, number]> = [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ];
  const inFinder = (x: number, y: number) =>
    finderOrigins.some(([fx, fy]) => x >= fx && x < fx + 7 && y >= fy && y < fy + 7);
  const rects: string[] = [];
  let state = (hashOf(seed) | 1) >>> 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (inFinder(x, y)) continue;
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      if ((state >> 8) & 1) {
        rects.push(`<rect x="${margin + x * cell}" y="${margin + y * cell}" width="${cell}" height="${cell}"/>`);
      }
    }
  }
  for (const [fx, fy] of finderOrigins) {
    rects.push(`<rect x="${margin + fx * cell}" y="${margin + fy * cell}" width="${7 * cell}" height="${7 * cell}"/>`);
    rects.push(
      `<rect x="${margin + (fx + 1) * cell}" y="${margin + (fy + 1) * cell}" width="${5 * cell}" height="${5 * cell}" fill="#ffffff"/>`,
    );
    rects.push(
      `<rect x="${margin + (fx + 2) * cell}" y="${margin + (fy + 2) * cell}" width="${3 * cell}" height="${3 * cell}"/>`,
    );
  }
  return svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}" viewBox="0 0 ${dimension} ${dimension}">` +
      `<rect width="${dimension}" height="${dimension}" fill="#ffffff"/><g fill="#111111">${rects.join("")}</g></svg>`,
  );
}

// ---------------------------------------------------------------------------
// 有状态内存文件系统
// ---------------------------------------------------------------------------

type MockKind = "folder" | "video" | "subtitle" | "file";

interface MockEntry {
  id: string;
  parentId: string;
  name: string;
  kind: MockKind;
  extension: string;
  sizeBytes: number;
  modifiedAt: number;
  starred: boolean;
  /** 照片拍摄时间（秒级时间戳）；仅照片类条目使用。 */
  takenAt: number | null;
  /** 视频时长（秒）；仅视频类条目使用。 */
  durationSeconds: number | null;
  thumbUrl: string | null;
}

const MiB = 1024 * 1024;
const ROOT_ID = "0";

const FS = new Map<string, MockEntry>();
let entrySeq = 0;

const nextEntryId = () => `u${(entrySeq += 1)}`;
const pickCodeOf = (id: string) => `pick-${id}`;

function makeEntry(id: string, parentId: string, name: string, kind: MockKind, overrides: Partial<MockEntry> = {}): MockEntry {
  const entry: MockEntry = {
    id,
    parentId,
    name,
    kind,
    extension: kind === "folder" ? "" : name.split(".").pop() ?? "",
    sizeBytes: 4 * MiB,
    modifiedAt: now() - 86_400,
    starred: false,
    takenAt: null,
    durationSeconds: null,
    thumbUrl: null,
    ...overrides,
  };
  FS.set(id, entry);
  return entry;
}

function seedFilesystem() {
  // 根目录
  makeEntry("d1", ROOT_ID, "电影", "folder");
  makeEntry("d2", ROOT_ID, "纪录片", "folder");
  makeEntry("d3", ROOT_ID, "照片", "folder");
  makeEntry("d4", ROOT_ID, "漫画", "folder");
  makeEntry("f4", ROOT_ID, "笔记.txt", "file", { sizeBytes: 12 * 1024 });
  // 电影
  makeEntry("f1", "d1", "Arrival.2016.mkv", "video", { sizeBytes: 356 * MiB, durationSeconds: 7163 });
  makeEntry("f2", "d1", "Perfect.Days.2023.mkv", "video", { sizeBytes: 412 * MiB, durationSeconds: 7371 });
  makeEntry("f3", "d1", "Arrival.2016.chs.srt", "subtitle", { sizeBytes: 88 * 1024 });
  // 纪录片
  makeEntry("g1", "d2", "蓝色星球.II.第01集.mkv", "video", { sizeBytes: 298 * MiB, durationSeconds: 2834 });
  // 照片（相册索引起始状态只收录 d3）
  makeEntry("p1", "d3", "IMG_0001.jpg", "file", {
    sizeBytes: 3 * MiB,
    takenAt: now() - 3600,
    thumbUrl: photoThumbDataUri("#6b7f96"),
  });
  makeEntry("p2", "d3", "IMG_0002.png", "file", {
    sizeBytes: 2 * MiB,
    takenAt: now() - 7200,
    thumbUrl: photoThumbDataUri("#8a6f5c"),
  });
  makeEntry("p3", "d3", "新年.jpg", "file", {
    sizeBytes: 1 * MiB,
    takenAt: 1_767_225_600,
    thumbUrl: photoThumbDataUri("#5c7a5e"),
  });
  // 漫画：cbz/zip 可在线阅读（与 Rust READER_EXTENSIONS 一致）；cbr/7z 仅识别，验证不可读标记。
  makeEntry("c1", "d4", "一拳超人 第01卷.cbz", "file", { sizeBytes: 400 * MiB });
  makeEntry("c2", "d4", "一拳超人 第02卷.cbz", "file", { sizeBytes: 500 * MiB });
  makeEntry("c3", "d4", "海贼王 第01卷.cbr", "file", { sizeBytes: 620 * MiB });
  makeEntry("c4", "d4", "进击的巨人 第01卷.7z", "file", { sizeBytes: 560 * MiB });
}

seedFilesystem();

const PHOTO_EXTENSIONS = new Set(["jpg", "jpeg", "png", "heic", "webp", "gif"]);
const COMIC_EXTENSIONS = new Set(["cbz", "cbr", "zip", "rar", "7z"]);
const VIDEO_EXTENSIONS = new Set(["mkv", "mp4", "mov", "avi", "webm", "m4v", "ts", "flv"]);
const SUBTITLE_EXTENSIONS = new Set(["srt", "ass", "ssa", "sup"]);

/** 按扩展名推断条目类型；上传与续传完成时使用。 */
function kindForName(name: string): MockKind {
  const extension = (name.split(".").pop() ?? "").toLowerCase();
  if (SUBTITLE_EXTENSIONS.has(extension)) return "subtitle";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  return "file";
}

const isPhoto = (entry: MockEntry) => entry.kind !== "folder" && PHOTO_EXTENSIONS.has(entry.extension.toLowerCase());
const isComic = (entry: MockEntry) => entry.kind !== "folder" && COMIC_EXTENSIONS.has(entry.extension.toLowerCase());

/** 漫画卷视图；coverPath 在真实链路是解压后生成的本地封面路径，这里用确定性演示封面替代。 */
type MockComicVolume = {
  fileId: string;
  pickCode: string;
  name: string;
  sizeBytes: number;
  coverPath: string;
};

/** 把压缩包条目按「书名 第N卷」聚合成系列；封面色调由书名散列决定，卷号按聚合顺序标注。 */
function groupComicSeries(volumes: MockEntry[]): Array<{
  title: string;
  volumeCount: number;
  totalBytes: number;
  volumes: MockComicVolume[];
}> {
  const series = new Map<string, MockComicVolume[]>();
  for (const volume of volumes) {
    const title = volume.name.replace(/\.(cbz|cbr|zip|rar|7z)$/i, "").split(/\s+第/)[0] || volume.name;
    const bucket = series.get(title) ?? [];
    bucket.push({
      fileId: volume.id,
      pickCode: pickCodeOf(volume.id),
      name: volume.name,
      sizeBytes: volume.sizeBytes,
      coverPath: comicCoverDataUri(title, bucket.length + 1),
    });
    series.set(title, bucket);
  }
  return [...series.entries()].map(([title, volumesInSeries]) => ({
    title,
    volumeCount: volumesInSeries.length,
    totalBytes: volumesInSeries.reduce((sum, current) => sum + current.sizeBytes, 0),
    volumes: volumesInSeries,
  }));
}

function childrenOf(parentId: string): MockEntry[] {
  return [...FS.values()].filter((entry) => entry.parentId === parentId);
}

function descendantsOf(id: string): MockEntry[] {
  const collected: MockEntry[] = [];
  const walk = (currentId: string) => {
    for (const child of childrenOf(currentId)) {
      collected.push(child);
      walk(child.id);
    }
  };
  walk(id);
  return collected;
}

function entryById(id: string, label = "文件"): MockEntry {
  const entry = FS.get(id);
  if (!entry) fail(`${label}不存在：${id}`);
  return entry;
}

function assertFolderId(folderId: string, label = "目标目录"): void {
  if (folderId !== ROOT_ID && !FS.has(folderId)) fail(`${label}不存在：${folderId}`);
  if (folderId !== ROOT_ID && FS.get(folderId)?.kind !== "folder") fail(`${label}不是目录：${folderId}`);
}

function assertNoNameConflict(parentId: string, name: string, ignoreId?: string): void {
  const conflict = childrenOf(parentId).find((entry) => entry.name === name && entry.id !== ignoreId);
  if (conflict) fail(`同名项已存在：“${name}”`);
}

function displayNameOf(folderId: string): string {
  return folderId === ROOT_ID ? "根目录" : FS.get(folderId)?.name ?? "根目录";
}

/** 从条目向上回溯出完整路径链（含根目录），供文件元数据展示。 */
function pathChainOf(entry: MockEntry): Array<{ id: string; name: string }> {
  const chain: Array<{ id: string; name: string }> = [];
  let cursor = entry.parentId;
  while (cursor !== ROOT_ID) {
    const parent = FS.get(cursor);
    if (!parent) break;
    chain.unshift({ id: parent.id, name: parent.name });
    cursor = parent.parentId;
  }
  chain.unshift({ id: ROOT_ID, name: "根目录" });
  return chain;
}

function toEntryView(entry: MockEntry) {
  return {
    id: entry.id,
    parentId: entry.parentId,
    name: entry.name,
    kind: entry.kind,
    extension: entry.extension,
    sizeBytes: entry.sizeBytes,
    modifiedAt: entry.modifiedAt,
    pickCode: pickCodeOf(entry.id),
    thumbUrl: entry.thumbUrl,
    children: entry.kind === "folder" ? childrenOf(entry.id).length : null,
  };
}

// ---------------------------------------------------------------------------
// 回收站（内存态）
// ---------------------------------------------------------------------------

interface RecycleRecord {
  item: {
    id: string;
    name: string;
    isFolder: boolean;
    sizeBytes: number;
    deletedAt: number;
    parentId: string;
    parentName: string;
  };
  /** 删除时摘下的整棵子树；还原时原样放回文件系统。 */
  subtree: MockEntry[];
}

const recycleBin: RecycleRecord[] = [];

function seedRecycleBin() {
  const entry: MockEntry = {
    id: "r1",
    parentId: ROOT_ID,
    name: "旧素材.mov",
    kind: "file",
    extension: "mov",
    sizeBytes: 48 * MiB,
    modifiedAt: now() - 3 * 86_400,
    starred: false,
    takenAt: null,
    durationSeconds: null,
    thumbUrl: null,
  };
  recycleBin.push({
    item: {
      id: entry.id,
      name: entry.name,
      isFolder: false,
      sizeBytes: entry.sizeBytes,
      deletedAt: now() - 7200,
      parentId: entry.parentId,
      parentName: displayNameOf(entry.parentId),
    },
    subtree: [entry],
  });
}

seedRecycleBin();

/** 把一批条目（含子树）移入回收站；parentName 必须在摘除前读取。 */
function moveEntriesToRecycle(entries: MockEntry[]): void {
  for (const entry of entries) {
    const subtree = [entry, ...descendantsOf(entry.id)];
    const record: RecycleRecord = {
      item: {
        id: entry.id,
        name: entry.name,
        isFolder: entry.kind === "folder",
        sizeBytes: subtree.reduce((sum, current) => sum + current.sizeBytes, 0),
        deletedAt: now(),
        parentId: entry.parentId,
        parentName: displayNameOf(entry.parentId),
      },
      subtree,
    };
    for (const current of subtree) FS.delete(current.id);
    recycleBin.unshift(record);
  }
}

function restoreFromRecycle(record: RecycleRecord): void {
  const parentId = record.item.parentId !== ROOT_ID && FS.has(record.item.parentId) ? record.item.parentId : ROOT_ID;
  record.subtree[0].parentId = parentId;
  for (const entry of record.subtree) FS.set(entry.id, entry);
}

// ---------------------------------------------------------------------------
// 事件模拟：复刻 Tauri v2 的回调投递路径
// ---------------------------------------------------------------------------

// 真实实现（tauri 2.x scripts/core.js + event 插件）：
// 1. `listen()` 先经 `__TAURI_INTERNALS__.transformCallback` 注册回调，拿到数字 id；
// 2. `plugin:event|listen` 返回监听 eventId，Rust 侧把 (target, handlerId) 存进监听表；
// 3. 后端 emit 时在页面里执行 `fn({event, payload}, [eventIds])`，
//    注入的 `fn` 再调用 `__TAURI_INTERNALS__.runCallback(handlerId, {event, id, payload})`。
// 浏览器 mock 按同样链路维护两张表，回调收到的对象与真实 Tauri 完全一致。
const eventCallbacks = new Map<number, (data: unknown) => void>();
const eventListeners = new Map<string, Map<number, { target: unknown; handlerId: number }>>();
let eventIdSeq = 0;

/** 与真实实现一致：用随机 u32 作为回调 id。 */
function nextCallbackId(): number {
  return window.crypto.getRandomValues(new Uint32Array(1))[0];
}

function registerCallback(callback: ((data: unknown) => void) | undefined, once: boolean): number {
  const id = nextCallbackId();
  eventCallbacks.set(id, (data) => {
    if (once) eventCallbacks.delete(id);
    if (callback) callback(data);
  });
  return id;
}

function unregisterCallback(id: number): void {
  eventCallbacks.delete(id);
}

/**
 * 向指定事件的全部监听者投递 payload；等价于 Rust 侧 emit。
 * 目标过滤从简：浏览器 mock 只有单一 webview，一律按 Any 目标投递。
 */
function emitMockEvent(event: string, payload: unknown): number {
  const listeners = eventListeners.get(event);
  if (!listeners || listeners.size === 0) return 0;
  let delivered = 0;
  for (const [eventId, listener] of listeners) {
    const callback = eventCallbacks.get(listener.handlerId);
    if (callback) {
      callback({ event, id: eventId, payload });
      delivered += 1;
    }
  }
  return delivered;
}

// ---------------------------------------------------------------------------
// 传输事件模拟（transfer://progress）
// ---------------------------------------------------------------------------

const TRANSFER_EVENT = "transfer://progress";
const UPLOAD_PART_SIZE = 20 * MiB;

type TransferStage = "preparing" | "transferring" | "finalizing" | "done" | "failed";

interface TransferEventPayload {
  transferId: string;
  kind: "upload" | "download";
  fileName: string;
  stage: TransferStage;
  completedParts?: number;
  totalParts?: number;
  transferredBytes?: number;
  totalBytes?: number;
  speedBytesPerSec?: number;
}

let transferSeq = 0;
const nextTransferId = () => `mock-${(transferSeq += 1)}`;

function emitTransfer(payload: TransferEventPayload): void {
  emitMockEvent(TRANSFER_EVENT, payload);
}

interface MockUploadSession {
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
}

let uploadSessionSeq = 0;
const uploadSessions: MockUploadSession[] = [];
const resumingSessionIds = new Set<string>();

/** 从文件名派生 2-5 个分片的演示体积，保证上传事件序列总时长约 2-4 秒。 */
function mockUploadFileSize(fileName: string): number {
  const parts = 2 + (hashOf(fileName) % 4);
  return parts * UPLOAD_PART_SIZE - 4 * MiB;
}

function makeUploadSession(fileName: string, localPath: string, targetId: string, fileSize: number, completedParts: number): MockUploadSession {
  const session: MockUploadSession = {
    id: `up-${(uploadSessionSeq += 1)}`,
    localPath,
    fileName,
    targetId,
    fileSize,
    fileSha1: `mock-sha1-${hashOf(fileName).toString(16)}`,
    preSha1: `mock-pres-${hashOf(localPath).toString(16)}`,
    pickCode: "",
    bucket: "mock-bucket",
    objectKey: `mock/${encodeURIComponent(fileName)}`,
    uploadId: `upload-${hashOf(fileName).toString(16)}`,
    callback: "",
    callbackVar: "",
    partSize: UPLOAD_PART_SIZE,
    completedParts: [],
    status: "uploading",
  };
  for (let part = 1; part <= completedParts; part += 1) {
    session.completedParts.push({ number: part, etag: `etag-${session.uploadId}-${part}` });
  }
  uploadSessions.push(session);
  return session;
}

function totalPartsOf(session: MockUploadSession): number {
  return Math.max(1, Math.ceil(session.fileSize / session.partSize));
}

function removeUploadSession(session: MockUploadSession): void {
  const index = uploadSessions.indexOf(session);
  if (index >= 0) uploadSessions.splice(index, 1);
}

/** 上传事件序列：preparing → transferring（逐 20MiB 分片）→ finalizing → done。 */
async function runUploadSequence(session: MockUploadSession): Promise<void> {
  const transferId = nextTransferId();
  const totalParts = totalPartsOf(session);
  const base = {
    transferId,
    kind: "upload" as const,
    fileName: session.fileName,
  };
  session.status = "uploading";
  emitTransfer({
    ...base,
    stage: "preparing",
    completedParts: session.completedParts.length,
    totalParts,
    transferredBytes: Math.min(session.fileSize, session.completedParts.length * session.partSize),
    totalBytes: session.fileSize,
  });
  await sleep(500);
  const previousBytes = Math.min(session.fileSize, session.completedParts.length * session.partSize);
  for (let part = session.completedParts.length + 1; part <= totalParts; part += 1) {
    await sleep(640);
    session.completedParts.push({ number: part, etag: `etag-${session.uploadId}-${part}` });
    const transferredBytes = Math.min(session.fileSize, part * session.partSize);
    emitTransfer({
      ...base,
      stage: "transferring",
      completedParts: part,
      totalParts,
      transferredBytes,
      totalBytes: session.fileSize,
      speedBytesPerSec: Math.round((transferredBytes - previousBytes) / 0.64),
    });
  }
  emitTransfer({
    ...base,
    stage: "finalizing",
    completedParts: totalParts,
    totalParts,
    transferredBytes: session.fileSize,
    totalBytes: session.fileSize,
  });
  await sleep(500);
  emitTransfer({
    ...base,
    stage: "done",
    completedParts: totalParts,
    totalParts,
    transferredBytes: session.fileSize,
    totalBytes: session.fileSize,
  });
}

/** 下载事件序列：preparing → transferring（字节递增带速度）→ done。 */
async function runDownloadSequence(fileName: string, totalBytes: number): Promise<void> {
  const transferId = nextTransferId();
  const base = { transferId, kind: "download" as const, fileName, totalBytes };
  const ticks = 8;
  emitTransfer({ ...base, stage: "preparing", transferredBytes: 0 });
  await sleep(500);
  let previous = 0;
  for (let tick = 1; tick <= ticks; tick += 1) {
    await sleep(420);
    const transferredBytes = Math.round((totalBytes * tick) / ticks);
    emitTransfer({
      ...base,
      stage: "transferring",
      transferredBytes,
      speedBytesPerSec: Math.round((transferredBytes - previous) / 0.42),
    });
    previous = transferredBytes;
  }
  emitTransfer({ ...base, stage: "done", transferredBytes: totalBytes });
}

// ---------------------------------------------------------------------------
// 播放会话（内存态，时间码随真实时钟推进）
// ---------------------------------------------------------------------------

interface MockPlayback {
  source: string;
  paused: boolean;
  /** 暂停或 seek 时冻结的位置基准。 */
  positionBase: number;
  /** 本段计时起点；positionBase + (now - anchorAt) 即当前进度。 */
  anchorAt: number;
  durationSeconds: number;
  /** 与 libmpv 一致，取值 0-100。 */
  volume: number;
}

let playback: MockPlayback | null = null;

const IDLE_SNAPSHOT = {
  initialized: false,
  source: null,
  paused: true,
  positionSeconds: null,
  durationSeconds: null,
  volume: 80,
  error: null,
};

function playbackPosition(playbackSession: MockPlayback): number {
  if (playbackSession.paused) return playbackSession.positionBase;
  const elapsed = (Date.now() - playbackSession.anchorAt) / 1000;
  return Math.min(playbackSession.durationSeconds, playbackSession.positionBase + elapsed);
}

function requirePlayback(): MockPlayback {
  if (!playback) fail("当前没有正在进行的播放会话");
  return playback;
}

function snapshotOf(playbackSession: MockPlayback) {
  return {
    initialized: true,
    source: playbackSession.source,
    paused: playbackSession.paused,
    positionSeconds: playbackPosition(playbackSession),
    durationSeconds: playbackSession.durationSeconds,
    volume: playbackSession.volume,
    error: null,
  };
}

function openPlayback(source: string) {
  const durationSeconds = 5400 + (hashOf(source) % 3600);
  playback = {
    source,
    paused: false,
    positionBase: 0,
    anchorAt: Date.now(),
    durationSeconds,
    volume: 80,
  };
  return snapshotOf(playback);
}

// ---------------------------------------------------------------------------
// 其余内存态：账号、设置、任务、播放进度、相册与漫画索引
// ---------------------------------------------------------------------------

// ?logged-out=1 让夹具从登录首屏启动，便于回归扫码授权与应用选择入口。
const startLoggedOut = new URLSearchParams(window.location.search).get("logged-out") === "1";
const accountState = startLoggedOut
  ? { connected: false, userName: "", userId: 0 }
  : { connected: true, userName: "冒烟测试员", userId: 42 };

let authPollCount = 0;

const aiSettings = { baseUrl: "https://api.deepseek.com", model: "deepseek-chat", keyStored: true };

const appSettingsState = {
  metadataLanguage: "zh-CN" as "zh-CN" | "en-US",
  autoScrape: true,
  playbackHistory: true,
};

interface MockLibraryTask {
  id: string;
  title: string;
  detail: string;
  status: "running" | "completed" | "attention";
  progress: number;
}

let libraryTaskSeq = 0;
const libraryTasks: MockLibraryTask[] = [];

const cloudPlaybackProgress = new Map<string, { positionSeconds: number; durationSeconds: number }>([
  ["f1", { positionSeconds: 3000, durationSeconds: 7163 }],
]);

const comicsReadProgress = new Map<string, { pageIndex: number; pageCount: number }>();

/** 相册索引状态：已收录的目录集合，相册总览由此派生。 */
const albumsIndexState = {
  folderIds: new Set<string>(["d3"]),
  lastScannedAt: formatStamp(now() - 86_400),
};

/** 漫画索引状态：已收录的目录集合，书架总览由此派生。 */
const comicsIndexState = {
  folderIds: new Set<string>(["d4"]),
  lastScannedAt: formatStamp(now() - 86_400),
};

// ---------------------------------------------------------------------------
// AI 整理演示数据（按目标目录实时生成）
// ---------------------------------------------------------------------------

const TITLE_DICT: Record<string, string> = {
  arrival: "降临",
  "perfect days": "完美的日子",
  dune: "沙丘",
  drive: "亡命驾驶",
  "high noon": "正午",
};

/** 为无中文的影视文件名生成规范化建议；已含中文或无法解析时返回 null。 */
function suggestRename(name: string): string | null {
  if (/[\u4e00-\u9fff]/.test(name)) return null;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const base = name.slice(0, dot);
  const extension = name.slice(dot + 1);
  const yearMatch = base.match(/(19|20)\d{2}/);
  const year = yearMatch ? yearMatch[0] : "";
  let title = base
    .replace(/[._]+/g, " ")
    .replace(new RegExp(`\\s*${year}\\s*$`), "")
    .trim();
  if (!title) return null;
  const translated = TITLE_DICT[title.toLowerCase()];
  if (translated) title = `${translated} ${title}`;
  return `${year ? `${title} ${year}` : title}.${extension}`;
}

function buildAiPlan(folderId: string) {
  const entries = childrenOf(folderId);
  const items = entries.map((entry) => {
    const suggested = entry.kind === "video" ? suggestRename(entry.name) : null;
    return suggested
      ? {
          fileId: entry.id,
          currentName: entry.name,
          action: "rename" as const,
          suggestedName: suggested,
          targetFolder: "",
          reason: "补充中文译名并规范化文件名，便于检索与刮削",
        }
      : {
          fileId: entry.id,
          currentName: entry.name,
          action: "keep" as const,
          suggestedName: "",
          targetFolder: "",
          reason: "命名已规范，保持现状",
        };
  });
  const pending = items.filter((item) => item.action === "rename").length;
  return {
    folderId,
    analyzedCount: entries.length,
    truncated: false,
    summary:
      pending > 0
        ? `检测到 ${pending} 个可规范化的文件名，建议重命名以统一检索。`
        : "当前目录命名规范，无需调整。",
    model: aiSettings.model,
    items,
  };
}

/** 按 targetFolder 名称解析目录；不存在时在父目录下创建并计数。 */
function resolveOrCreateFolder(name: string, preferredParentId: string, created: { count: number }): string {
  if (!name) return preferredParentId;
  const preferred = childrenOf(preferredParentId).find((entry) => entry.kind === "folder" && entry.name === name);
  if (preferred) return preferred.id;
  const anywhere = [...FS.values()].find((entry) => entry.kind === "folder" && entry.name === name);
  if (anywhere) return anywhere.id;
  assertNoNameConflict(preferredParentId, name);
  const folder = makeEntry(nextEntryId(), preferredParentId, name, "folder");
  created.count += 1;
  return folder.id;
}

// ---------------------------------------------------------------------------
// AI 对话演示数据（内存会话表 + ai://chat-token 流模拟）
// ---------------------------------------------------------------------------

const AI_CHAT_TOKEN_EVENT = "ai://chat-token";

interface MockChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  contextJson: string | null;
  createdAt: string;
}

interface MockChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: MockChatMessage[];
}

let chatSessionSeq = 0;
let chatMessageSeq = 0;
const chatSessions: MockChatSession[] = [];
/** 正在流式回复的会话；与 Rust 侧 ChatStreamRegistry 的并发互斥语义一致。 */
const activeChatSessions = new Set<string>();
/** 用户请求停止的会话；流循环在每个增量前检查。 */
const stoppedChatSessions = new Map<string, boolean>();

const nextChatMessageId = () => `chatmsg-${(chatMessageSeq += 1)}`;

function requireChatSession(sessionId: string): MockChatSession {
  const session = chatSessions.find((current) => current.id === sessionId);
  if (!session) fail(`会话不存在：${sessionId}`);
  return session;
}

function formatSizeShort(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** 与上下文相关的中文假回复：按意图分支，引用快照里的目录与选择。 */
function buildChatReply(content: string, context: Record<string, unknown> | null): string {
  const scope = str(context?.scope, "网盘");
  const detail = str(context?.detail);
  const place = detail ? `「${detail}」` : "";
  const folderId = str(context?.folderId) || ROOT_ID;
  const text = content.trim();

  if (text.includes("较大") || text.includes("大文件")) {
    const largest = childrenOf(folderId)
      .filter((entry) => entry.kind !== "folder")
      .sort((a, b) => b.sizeBytes - a.sizeBytes)
      .slice(0, 3);
    if (largest.length === 0) return `${scope}${place}里暂时没有找到较大的文件。`;
    return [
      `${scope}${place}中占用空间最大的文件是：`,
      ...largest.map((entry, index) => `${index + 1}. ${entry.name}（${formatSizeShort(entry.sizeBytes)}）`),
      "",
      "如果需要归档或清理，可以让我生成整理计划，执行前由你确认。",
    ].join("\n");
  }

  if (text.includes("解释") || text.includes("这个文件夹")) {
    const entries = childrenOf(folderId);
    if (entries.length === 0) return `${scope}${place}目前是空目录。`;
    const folders = entries.filter((entry) => entry.kind === "folder");
    const files = entries.filter((entry) => entry.kind !== "folder");
    const videos = files.filter((entry) => entry.kind === "video");
    const summaryParts = [
      folders.length > 0 ? `${folders.length} 个子文件夹` : null,
      videos.length > 0 ? `${videos.length} 个视频` : null,
      files.length - videos.length > 0 ? `${files.length - videos.length} 个其他文件` : null,
    ].filter((part): part is string => part !== null);
    return [
      `${scope}${place}共有 ${entries.length} 项：${summaryParts.join("、") || "暂无内容"}。`,
      files.length > 0
        ? `例如「${files[0].name}」，整体看${videos.length > 0 ? "是以影片为主的内容目录" : "以普通文件为主"}。`
        : "目录结构清晰，适合按类型继续细分。",
    ].join("\n");
  }

  if (text.includes("整理") && (text.includes("目录") || text.includes("文件夹"))) {
    return [
      `好的，我来协助整理${scope}${place}。建议的顺序是：`,
      "1. 先把命名不规范的视频统一成「中文名 年份.扩展名」；",
      "2. 再把字幕与同名影片配对，必要时按系列建立子文件夹。",
      "",
      "你可以点击「整理当前目录」生成计划卡，勾选要执行的建议后确认，所有修改都会先经你确认。",
    ].join("\n");
  }

  if (text.includes("命名")) {
    return [
      "影视文件推荐「中文名 原文名 年份.扩展名」的格式，例如「降临 Arrival 2016.mkv」：",
      "中文名便于检索与展示，年份避免同系列混淆，扩展名保持原始编码信息。",
      "需要时我可以对当前目录生成一份重命名计划，由你逐项勾选后执行。",
    ].join("\n");
  }

  return [
    `收到。当前页面是${scope}${place}，我可以帮你整理目录、解释文件夹内容或查找较大的文件。`,
    "涉及重命名、移动或删除的操作，我都会先生成计划，由你在界面中确认后才会执行。",
  ].join("\n");
}

/** 流式回复：10-20 个 2-4 字增量（80-150ms 间隔）后恰好一次终态；停止时保留已生成部分。 */
async function runChatTokenStream(
  session: MockChatSession,
  messageId: string,
  content: string,
  context: Record<string, unknown> | null,
): Promise<void> {
  const reply = buildChatReply(content, context);
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < reply.length) {
    const size = Math.min(reply.length - cursor, 2 + (hashOf(`${messageId}-${cursor}`) % 3));
    chunks.push(reply.slice(cursor, cursor + size));
    cursor += size;
  }
  await sleep(420);
  let accumulated = "";
  for (const chunk of chunks) {
    if (stoppedChatSessions.get(session.id)) break;
    accumulated += chunk;
    emitMockEvent(AI_CHAT_TOKEN_EVENT, { sessionId: session.id, messageId, delta: chunk, done: false });
    await sleep(80 + (hashOf(`${messageId}${accumulated.length}`) % 71));
  }
  const stopped = stoppedChatSessions.get(session.id) === true;
  stoppedChatSessions.delete(session.id);
  activeChatSessions.delete(session.id);
  if (accumulated) {
    session.messages.push({
      id: messageId,
      sessionId: session.id,
      role: "assistant",
      content: accumulated,
      contextJson: null,
      createdAt: formatStamp(now()),
    });
  }
  session.updatedAt = formatStamp(now());
  emitMockEvent(AI_CHAT_TOKEN_EVENT, {
    sessionId: session.id,
    messageId,
    delta: "",
    done: true,
    ...(stopped ? { error: "已停止" } : {}),
  });
}

/** 预置一段历史对话，便于验证历史渲染、会话切换与删除。 */
function seedChatSession() {
  const session: MockChatSession = {
    id: `chatsession-${(chatSessionSeq += 1)}`,
    title: "网盘整理咨询",
    createdAt: formatStamp(now() - 86_400),
    updatedAt: formatStamp(now() - 3_600),
    messages: [],
  };
  session.messages.push({
    id: nextChatMessageId(),
    sessionId: session.id,
    role: "user",
    content: "如何规范命名影视文件",
    contextJson: JSON.stringify({ page: "cloud-files", scope: "网盘文件", detail: "电影" }),
    createdAt: formatStamp(now() - 3_660),
  });
  session.messages.push({
    id: nextChatMessageId(),
    sessionId: session.id,
    role: "assistant",
    content: buildChatReply("如何规范命名影视文件", { page: "cloud-files", scope: "网盘文件", detail: "电影" }),
    contextJson: null,
    createdAt: formatStamp(now() - 3_600),
  });
  chatSessions.push(session);
}

seedChatSession();

// ---------------------------------------------------------------------------
// 本机媒体库演示数据（library_list / library_search）
// ---------------------------------------------------------------------------

const LIBRARY_ITEMS = [
  {
    id: "arrival",
    title: "降临",
    originalTitle: "Arrival",
    year: 2016,
    kind: "movie",
    rating: 7.9,
    runtimeMinutes: 116,
    genres: ["科幻", "剧情"],
    overview: "语言学家与外星生命首次接触，在破译语言的过程中重新丈量自己的一生。",
    director: "丹尼斯·维伦纽瓦",
    cast: ["艾米·亚当斯", "杰瑞米·雷纳", "福里斯特·惠特克"],
    posterTone: "#31415f",
    posterAccent: "#c9d8f2",
    progress: 0.42,
    sourceLabel: "115 网盘",
    sourceStatus: "ready",
  },
  {
    id: "perfect-days",
    title: "完美的日子",
    originalTitle: "Perfect Days",
    year: 2023,
    kind: "movie",
    rating: 8.1,
    runtimeMinutes: 123,
    genres: ["剧情"],
    overview: "东京公厕清洁工的日常生活：木漏与光，磁带与书，以及一次次的偶然后会。",
    director: "维姆·文德斯",
    cast: ["役所广司", "柄本时生"],
    posterTone: "#4c5c48",
    posterAccent: "#dfe9d2",
    progress: 0,
    sourceLabel: "115 网盘",
    sourceStatus: "ready",
  },
  {
    id: "severance",
    title: "人生切割术",
    originalTitle: "Severance",
    year: 2022,
    kind: "series",
    rating: 8.7,
    runtimeMinutes: 48,
    genres: ["科幻", "悬疑"],
    overview: "卢蒙工业的员工接受记忆分离手术，工作与生活的记忆永不互通。",
    director: "本·斯蒂勒",
    cast: ["亚当·斯科特", "布丽特·洛薇尔"],
    posterTone: "#274a52",
    posterAccent: "#bfe6ea",
    progress: 0.68,
    sourceLabel: "115 网盘",
    sourceStatus: "ready",
  },
  {
    id: "mock-dune",
    title: "沙丘",
    originalTitle: "Dune",
    year: 2021,
    kind: "movie",
    rating: 7.7,
    runtimeMinutes: 155,
    genres: ["科幻", "冒险"],
    overview: "厄拉科斯的香料、沙虫与预言，厄崔迪家族的命运在沙漠中展开。",
    director: "丹尼斯·维伦纽瓦",
    cast: ["提莫西·查拉梅", "丽贝卡·弗格森"],
    posterTone: "#5a4a33",
    posterAccent: "#ecd9b0",
    progress: 0,
    sourceLabel: "115 网盘",
    sourceStatus: "ready",
  },
  {
    id: "mock-drive",
    title: "亡命驾驶",
    originalTitle: "Drive",
    year: 2011,
    kind: "movie",
    rating: 7.8,
    runtimeMinutes: 100,
    genres: ["犯罪", "剧情"],
    overview: "白天是特技车手，夜晚是逃亡车手，一次劫案打破了沉寂。",
    director: "尼古拉斯·温丁·雷弗恩",
    cast: ["瑞恩·高斯林", "凯瑞·穆里根"],
    posterTone: "#5c3a5e",
    posterAccent: "#e8c8ec",
    progress: 0,
    sourceLabel: "115 网盘",
    sourceStatus: "ready",
  },
  {
    id: "mock-noon",
    title: "正午",
    originalTitle: "High Noon",
    year: 1952,
    kind: "movie",
    rating: 8.0,
    runtimeMinutes: 85,
    genres: ["西部"],
    overview: "警长在卸任前的 85 分钟里独自面对返乡的仇家。",
    director: "弗雷德·金尼曼",
    cast: ["加里·库珀", "格蕾丝·凯利"],
    posterTone: "#6b4a3a",
    posterAccent: "#f0dcc4",
    progress: 0,
    sourceLabel: "115 网盘",
    sourceStatus: "ready",
  },
];

// ---------------------------------------------------------------------------
// 命令处理器
// ---------------------------------------------------------------------------

const HANDLERS: Record<string, CmdHandler> = {
  // ----- 账号与认证 -----
  cloud115_account_status: () => ({ ...accountState }),
  cloud115_begin_auth: (args) => {
    const clientId = str(args.clientId, "mock-client");
    authPollCount = 0;
    return {
      qrDataUri: pseudoQrDataUri(clientId),
      expiresAt: now() + 300,
    };
  },
  cloud115_poll_auth: () => {
    authPollCount += 1;
    if (authPollCount >= 3) {
      accountState.connected = true;
      return {
        status: "authorized",
        message: "授权成功",
        account: { ...accountState },
      };
    }
    return authPollCount === 1
      ? { status: "waiting", message: "等待扫码", account: null }
      : { status: "scanned", message: "已扫码，等待在手机上确认", account: null };
  },
  cloud115_sign_out: () => {
    accountState.connected = false;
    authPollCount = 0;
    return null;
  },
  cloud115_client_apps: () => [
    { id: "100195125", name: "媒体播放器" },
    { id: "100195127", name: "蒙太奇播放器" },
  ],
  cloud115_user_profile: () => {
    if (!accountState.connected) fail("未连接 115 账号");
    return {
      userId: 42,
      userName: "冒烟测试员",
      avatarUrl: "",
      totalBytes: 1024 ** 4,
      usedBytes: 512 * 1024 ** 3,
      remainingBytes: 1024 ** 4 - 512 * 1024 ** 3,
      totalFormatted: "1 TB",
      usedFormatted: "512 GB",
      remainingFormatted: "512 GB",
      vipLevel: "platinum",
      vipExpiresAt: 0,
    };
  },

  // ----- 文件浏览与元数据 -----
  cloud115_list_files: (args) => {
    const parentId = str(args.parentId, ROOT_ID) || ROOT_ID;
    assertFolderId(parentId, "目录");
    const keyword = str(args.query).trim().toLowerCase();
    const matched = childrenOf(parentId)
      .filter((entry) => keyword === "" || entry.name.toLowerCase().includes(keyword))
      .sort((a, b) => {
        const folderBias = (entry: MockEntry) => (entry.kind === "folder" ? 0 : 1);
        return folderBias(a) - folderBias(b) || a.name.localeCompare(b.name, "zh-Hans-CN");
      });
    const offset = Math.max(0, Math.trunc(num(args.offset)));
    const limit = Math.trunc(num(args.limit, 100)) || 100;
    return {
      entries: matched.slice(offset, offset + limit).map(toEntryView),
      total: matched.length,
      offset,
      limit,
      hasMore: offset + limit < matched.length,
    };
  },
  cloud115_file_metadata: (args) => {
    const entry = entryById(str(args.fileId));
    return {
      id: entry.id,
      name: entry.name,
      parentId: entry.parentId,
      isFolder: entry.kind === "folder",
      // 沿用既有 mock 取值：文件为 "1"。
      fileType: entry.kind === "folder" ? "0" : "1",
      sizeBytes: entry.sizeBytes,
      modifiedAt: entry.modifiedAt,
      durationSeconds: entry.durationSeconds ?? 0,
      pickCode: pickCodeOf(entry.id),
      sha1: `mock-sha1-${entry.id}`,
      starred: entry.starred,
      path: pathChainOf(entry),
    };
  },

  // ----- 文件管理（有状态） -----
  cloud115_create_folder: (args) => {
    const parentId = str(args.parentId, ROOT_ID) || ROOT_ID;
    assertFolderId(parentId);
    const name = str(args.name).trim();
    if (!name) fail("目录名称不能为空");
    assertNoNameConflict(parentId, name);
    const folder = makeEntry(nextEntryId(), parentId, name, "folder");
    return { id: folder.id, name: folder.name };
  },
  cloud115_update_file: (args) => {
    const entry = entryById(str(args.fileId));
    const name = str(args.name);
    const starred = args.starred === null ? null : bool(args.starred);
    if (name) {
      assertNoNameConflict(entry.parentId, name, entry.id);
      entry.name = name;
      entry.modifiedAt = now();
    }
    if (starred !== null) {
      entry.starred = starred;
    }
    return null;
  },
  cloud115_move_files: (args) => {
    const fileIds = strArray(args.fileIds);
    if (fileIds.length === 0) fail("未选择要移动的文件");
    const targetId = str(args.targetId) || ROOT_ID;
    assertFolderId(targetId);
    const targetAncestors = new Set<string>([targetId]);
    let cursor = targetId === ROOT_ID ? null : FS.get(targetId)?.parentId ?? null;
    while (cursor !== null && cursor !== ROOT_ID) {
      targetAncestors.add(cursor);
      cursor = FS.get(cursor)?.parentId ?? null;
    }
    for (const fileId of fileIds) {
      const entry = entryById(fileId, "待移动文件");
      if (entry.id === targetId) fail("不能把目录移动到自身内部");
      if (entry.kind === "folder" && targetAncestors.has(entry.id)) fail("不能把目录移动到其子目录内");
      assertNoNameConflict(targetId, entry.name);
    }
    for (const fileId of fileIds) {
      const entry = FS.get(fileId);
      if (!entry) continue;
      entry.parentId = targetId;
      entry.modifiedAt = now();
    }
    return null;
  },
  cloud115_copy_files: (args) => {
    const fileIds = strArray(args.fileIds);
    if (fileIds.length === 0) fail("未选择要复制的文件");
    const targetId = str(args.targetId) || ROOT_ID;
    assertFolderId(targetId);
    const allowDuplicates = bool(args.allowDuplicates);
    for (const fileId of fileIds) {
      const entry = entryById(fileId, "待复制文件");
      const conflict = childrenOf(targetId).find((current) => current.name === entry.name);
      if (conflict && !allowDuplicates) fail(`目标目录已存在同名项：“${entry.name}”`);
    }
    const copyInto = (source: MockEntry, parentId: string): MockEntry => {
      const copy = makeEntry(nextEntryId(), parentId, source.name, source.kind, {
        sizeBytes: source.sizeBytes,
        modifiedAt: now(),
        takenAt: source.takenAt,
        durationSeconds: source.durationSeconds,
        thumbUrl: source.thumbUrl,
      });
      for (const child of childrenOf(source.id)) copyInto(child, copy.id);
      return copy;
    };
    for (const fileId of fileIds) {
      const entry = entryById(fileId, "待复制文件");
      const conflict = childrenOf(targetId).find((current) => current.name === entry.name);
      if (conflict) {
        // 允许同名时复制为“副本”，与 115 的重复名策略保持近似行为。
        const dot = entry.name.lastIndexOf(".");
        const copyName =
          dot > 0
            ? `${entry.name.slice(0, dot)} 副本${entry.name.slice(dot)}`
            : `${entry.name} 副本`;
        assertNoNameConflict(targetId, copyName);
        copyInto({ ...entry, name: copyName }, targetId);
      } else {
        copyInto(entry, targetId);
      }
    }
    return null;
  },
  cloud115_delete_files: (args) => {
    const fileIds = strArray(args.fileIds);
    if (fileIds.length === 0) fail("未选择要删除的文件");
    const targets = fileIds.map((fileId) => entryById(fileId, "待删除文件"));
    moveEntriesToRecycle(targets);
    return null;
  },

  // ----- 回收站（有状态） -----
  cloud115_list_recycle_bin: (args) => {
    const offset = Math.max(0, Math.trunc(num(args.offset)));
    const limit = Math.trunc(num(args.limit, 100)) || 100;
    const items = recycleBin.map((record) => ({ ...record.item }));
    return {
      entries: items.slice(offset, offset + limit),
      total: items.length,
      offset,
      limit,
      hasMore: offset + limit < items.length,
    };
  },
  cloud115_restore_recycle_items: (args) => {
    const itemIds = strArray(args.itemIds);
    if (itemIds.length === 0) fail("未选择要还原的项目");
    for (const itemId of itemIds) {
      const index = recycleBin.findIndex((record) => record.item.id === itemId);
      if (index < 0) fail(`回收站中不存在该项：${itemId}`);
      restoreFromRecycle(recycleBin[index]);
      recycleBin.splice(index, 1);
    }
    return null;
  },
  cloud115_delete_recycle_items: (args) => {
    const itemIds = strArray(args.itemIds);
    if (itemIds.length === 0) fail("未选择要彻底删除的项目");
    for (const itemId of itemIds) {
      const index = recycleBin.findIndex((record) => record.item.id === itemId);
      if (index < 0) fail(`回收站中不存在该项：${itemId}`);
      recycleBin.splice(index, 1);
    }
    return null;
  },

  // ----- 播放与下载源 -----
  cloud115_playback_source: (args) => {
    const entry = FS.get(str(args.pickCode).replace(/^pick-/, ""));
    if (!entry) fail(`未找到对应的 115 文件：${str(args.pickCode)}`);
    return {
      url: `https://mock-media.115.example/${entry.id}/playlist.m3u8`,
      userAgent: "Mozilla/5.0 (SiriusMock)",
    };
  },
  cloud115_video_subtitles: () => [],
  cloud115_download_source: (args) => {
    const entry = FS.get(str(args.pickCode).replace(/^pick-/, ""));
    if (!entry) fail(`未找到对应的 115 文件：${str(args.pickCode)}`);
    return {
      url: `https://mock-media.115.example/${entry.id}/download`,
      userAgent: "Mozilla/5.0 (SiriusMock)",
    };
  },

  // ----- 播放进度（本机 SQLite 的内存替身） -----
  cloud115_playback_progress: (args) => {
    return cloudPlaybackProgress.get(str(args.fileId)) ?? null;
  },
  cloud115_save_playback_progress: (args) => {
    const fileId = str(args.fileId);
    if (!fileId) fail("缺少文件 ID");
    cloudPlaybackProgress.set(fileId, {
      positionSeconds: Math.max(0, num(args.positionSeconds)),
      durationSeconds: Math.max(0, num(args.durationSeconds)),
    });
    return null;
  },

  // ----- 下载（带 transfer://progress 事件序列） -----
  cloud115_download_file: async (args) => {
    const pickCode = str(args.pickCode);
    const entry = FS.get(pickCode.replace(/^pick-/, ""));
    if (!entry) fail(`未找到对应的 115 文件：${pickCode}`);
    const targetDir = str(args.targetDir);
    if (!targetDir) fail("缺少下载保存目录");
    const fileName = str(args.fileName, entry.name);
    const totalBytes = entry.sizeBytes > 0 ? entry.sizeBytes : Math.max(num(args.expectedSizeBytes), MiB);
    await runDownloadSequence(fileName, totalBytes);
    return {
      fileName,
      savedPath: `${targetDir.replace(/\/+$/, "")}/${fileName}`,
      sizeBytes: totalBytes,
      resumedBytes: 0,
    };
  },

  // ----- 上传（带 transfer://progress 事件序列与可续传会话） -----
  cloud115_upload_file: async (args) => {
    const path = str(args.path);
    if (!path) fail("缺少要上传的本地文件路径");
    const targetId = str(args.targetId, ROOT_ID) || ROOT_ID;
    assertFolderId(targetId, "上传目标目录");
    const fileName = path.split("/").pop() ?? path;
    const existing = childrenOf(targetId).find((entry) => entry.name === fileName);
    if (existing) {
      // 冒烟环境以同名视为秒传，不发出传输事件。
      return { fileName, pickCode: pickCodeOf(existing.id), instant: true };
    }
    const fileSize = mockUploadFileSize(fileName);
    const session = makeUploadSession(fileName, path, targetId, fileSize, 0);
    await runUploadSequence(session);
    const entry = makeEntry(nextEntryId(), targetId, fileName, kindForName(fileName), {
      sizeBytes: fileSize,
      modifiedAt: now(),
      durationSeconds: kindForName(fileName) === "video" ? 5400 + (hashOf(fileName) % 3600) : null,
    });
    removeUploadSession(session);
    return { fileName, pickCode: pickCodeOf(entry.id), instant: false };
  },
  cloud115_upload_sessions: () => uploadSessions.map((session) => ({ ...session, completedParts: [...session.completedParts] })),
  cloud115_resume_upload: async (args) => {
    const sessionId = str(args.sessionId);
    const session = uploadSessions.find((current) => current.id === sessionId);
    if (!session) fail(`未找到可续传的上传会话：${sessionId}`);
    if (resumingSessionIds.has(sessionId)) fail("该会话正在上传中");
    assertFolderId(session.targetId, "上传目标目录");
    resumingSessionIds.add(sessionId);
    try {
      await runUploadSequence(session);
    } finally {
      resumingSessionIds.delete(sessionId);
    }
    const entry = makeEntry(nextEntryId(), session.targetId, session.fileName, kindForName(session.fileName), {
      sizeBytes: session.fileSize,
      modifiedAt: now(),
      durationSeconds: kindForName(session.fileName) === "video" ? 5400 + (hashOf(session.fileName) % 3600) : null,
    });
    removeUploadSession(session);
    return { fileName: session.fileName, pickCode: pickCodeOf(entry.id), instant: false };
  },

  // ----- AI 整理（按目录实时生成计划，执行真实变更内存状态） -----
  ai_provider_settings: () => ({ ...aiSettings }),
  ai_update_provider: (args) => {
    const settings = (args.settings ?? {}) as Record<string, unknown>;
    const baseUrl = str(settings.baseUrl, aiSettings.baseUrl).trim();
    const model = str(settings.model, aiSettings.model).trim();
    if (!baseUrl) fail("接口地址不能为空");
    if (!model) fail("模型名称不能为空");
    aiSettings.baseUrl = baseUrl;
    aiSettings.model = model;
    const apiKey = settings.apiKey;
    if (typeof apiKey === "string" && apiKey.trim() !== "") {
      aiSettings.keyStored = true;
    }
    return { ...aiSettings };
  },
  ai_analyze_folder: (args) => {
    const folderId = str(args.folderId, ROOT_ID) || ROOT_ID;
    assertFolderId(folderId, "待分析目录");
    return buildAiPlan(folderId);
  },
  ai_execute_plan: (args) => {
    const request = (args.request ?? {}) as Record<string, unknown>;
    if (!bool(request.confirmed)) fail("整理计划必须先经用户确认才能执行");
    const items = Array.isArray(request.items) ? (request.items as Array<Record<string, unknown>>) : [];
    const created = { count: 0 };
    const report = { executed: 0, skipped: 0, failed: 0, deletedToRecycleBin: 0, createdFolders: 0, details: [] as Array<Record<string, unknown>> };
    for (const item of items) {
      const fileId = str(item.fileId);
      const currentName = str(item.currentName);
      const action = str(item.action);
      const entry = FS.get(fileId);
      const base = { fileId, currentName, action };
      if (!entry) {
        report.failed += 1;
        report.details.push({ ...base, status: "failed", detail: "文件不存在或已被删除" });
        continue;
      }
      if (action === "rename") {
        const suggestedName = str(item.suggestedName);
        try {
          assertNoNameConflict(entry.parentId, suggestedName, entry.id);
          entry.name = suggestedName;
          entry.modifiedAt = now();
          report.executed += 1;
          report.details.push({ ...base, status: "done", detail: `已重命名为“${suggestedName}”` });
        } catch (reason) {
          report.failed += 1;
          report.details.push({ ...base, status: "failed", detail: reason instanceof Error ? reason.message : String(reason) });
        }
      } else if (action === "move") {
        const targetFolder = str(item.targetFolder);
        try {
          const resolvedId = resolveOrCreateFolder(targetFolder, entry.parentId, created);
          assertNoNameConflict(resolvedId, entry.name, entry.id);
          entry.parentId = resolvedId;
          entry.modifiedAt = now();
          report.executed += 1;
          report.details.push({ ...base, status: "done", detail: `已移动到“${displayNameOf(resolvedId)}”` });
        } catch (reason) {
          report.failed += 1;
          report.details.push({ ...base, status: "failed", detail: reason instanceof Error ? reason.message : String(reason) });
        }
      } else if (action === "delete") {
        moveEntriesToRecycle([entry]);
        report.deletedToRecycleBin += 1;
        report.details.push({ ...base, status: "done", detail: "已移入回收站" });
      } else {
        report.skipped += 1;
        report.details.push({ ...base, status: "skipped", detail: "保持现状，无需执行" });
      }
    }
    report.createdFolders = created.count;
    return report;
  },

  // ----- AI 对话（内存会话表 + ai://chat-token 流模拟） -----
  ai_chat_create: (args) => {
    const title = str(args.title).trim() || "新对话";
    const session: MockChatSession = {
      id: `chatsession-${(chatSessionSeq += 1)}`,
      title,
      createdAt: formatStamp(now()),
      updatedAt: formatStamp(now()),
      messages: [],
    };
    chatSessions.unshift(session);
    return { id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt };
  },
  ai_chat_sessions_list: () =>
    [...chatSessions]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((session) => ({ id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt })),
  ai_chat_history: (args) => {
    const session = requireChatSession(str(args.sessionId));
    return session.messages.map((message) => ({ ...message }));
  },
  ai_chat_send: (args) => {
    const session = requireChatSession(str(args.sessionId));
    if (activeChatSessions.has(session.id)) fail("同一会话正在回复中，请先停止当前回复");
    const content = str(args.content).trim();
    if (!content) fail("消息内容不能为空");
    const context = (args.context ?? null) as Record<string, unknown> | null;
    if (context && JSON.stringify(context).length > 32 * 1024) {
      fail("页面上下文超过 32KiB 上限");
    }
    const userMessageId = `chatmsg-${(chatMessageSeq += 1)}`;
    const messageId = `chatmsg-${(chatMessageSeq += 1)}`;
    session.messages.push({
      id: userMessageId,
      sessionId: session.id,
      role: "user",
      content,
      contextJson: context ? JSON.stringify(context) : null,
      createdAt: formatStamp(now()),
    });
    session.updatedAt = formatStamp(now());
    activeChatSessions.add(session.id);
    void runChatTokenStream(session, messageId, content, context);
    return { sessionId: session.id, messageId, userMessageId };
  },
  ai_chat_stop: (args) => {
    const sessionId = str(args.sessionId);
    if (!activeChatSessions.has(sessionId)) return false;
    stoppedChatSessions.set(sessionId, true);
    return true;
  },
  ai_chat_delete: (args) => {
    const sessionId = str(args.sessionId);
    if (activeChatSessions.has(sessionId)) fail("会话正在回复中，请先停止当前回复再删除");
    const index = chatSessions.findIndex((session) => session.id === sessionId);
    if (index < 0) fail(`会话不存在：${sessionId}`);
    chatSessions.splice(index, 1);
    return null;
  },

  // ----- 相册（索引状态可累积、可移除） -----
  albums_recognize: (args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const folderId = str(input.folderId, ROOT_ID) || ROOT_ID;
    assertFolderId(folderId, "待识别目录");
    const folderName = str(input.folderName) || displayNameOf(folderId);
    const entries = childrenOf(folderId);
    const photos = entries.filter(isPhoto);
    const months = new Map<string, Array<{ fileId: string; folderId: string; pickCode: string; name: string; sizeBytes: number; takenAt: number; thumbUrl: string | null }>>();
    for (const photo of photos) {
      const monthKey = monthKeyOf(photo.takenAt ?? photo.modifiedAt);
      const bucket = months.get(monthKey) ?? [];
      bucket.push({
        fileId: photo.id,
        folderId: photo.parentId,
        pickCode: pickCodeOf(photo.id),
        name: photo.name,
        sizeBytes: photo.sizeBytes,
        takenAt: photo.takenAt ?? photo.modifiedAt,
        thumbUrl: photo.thumbUrl,
      });
      months.set(monthKey, bucket);
    }
    return {
      folderId,
      folderName,
      scannedCount: entries.length,
      truncated: false,
      months: [...months.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([monthKey, photosInMonth]) => ({ monthKey, photoCount: photosInMonth.length, photos: photosInMonth })),
      skippedCount: entries.length - photos.length,
    };
  },
  albums_index: () => {
    const photos = [...FS.values()].filter((entry) => albumsIndexState.folderIds.has(entry.parentId) && isPhoto(entry));
    const months = new Map<string, Array<{ fileId: string; folderId: string; pickCode: string; name: string; sizeBytes: number; takenAt: number; thumbUrl: string | null }>>();
    for (const photo of photos) {
      const monthKey = monthKeyOf(photo.takenAt ?? photo.modifiedAt);
      const bucket = months.get(monthKey) ?? [];
      bucket.push({
        fileId: photo.id,
        folderId: photo.parentId,
        pickCode: pickCodeOf(photo.id),
        name: photo.name,
        sizeBytes: photo.sizeBytes,
        takenAt: photo.takenAt ?? photo.modifiedAt,
        thumbUrl: photo.thumbUrl,
      });
      months.set(monthKey, bucket);
    }
    const albums = [...albumsIndexState.folderIds]
      .map((folderId) => {
        const folderPhotos = photos.filter((photo) => photo.parentId === folderId);
        return {
          folderId,
          folderName: displayNameOf(folderId),
          photoCount: folderPhotos.length,
          coverUrl: folderPhotos[0]?.thumbUrl ?? null,
        };
      })
      .filter((album) => album.photoCount > 0);
    return {
      folderCount: albumsIndexState.folderIds.size,
      lastScannedAt: albumsIndexState.lastScannedAt,
      photoCount: photos.length,
      months: [...months.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([monthKey, photosInMonth]) => ({ monthKey, photoCount: photosInMonth.length, photos: photosInMonth })),
      albums,
    };
  },
  albums_index_folders: (args) => {
    const folders = Array.isArray(args.folders) ? (args.folders as Array<Record<string, unknown>>) : [];
    if (folders.length === 0) fail("未选择要索引的目录");
    const overviews = folders.map((folder) =>
      HANDLERS.albums_recognize({ input: { folderId: str(folder.folderId), folderName: str(folder.folderName) } }),
    );
    for (const folder of folders) {
      albumsIndexState.folderIds.add(str(folder.folderId));
    }
    albumsIndexState.lastScannedAt = formatStamp(now());
    return overviews;
  },
  albums_remove_index: (args) => {
    const folderId = str(args.folderId);
    if (!albumsIndexState.folderIds.delete(folderId)) fail(`该目录未建立相册索引：${folderId}`);
    albumsIndexState.lastScannedAt = formatStamp(now());
    return null;
  },

  // ----- 漫画（索引状态可累积，阅读进度可保存） -----
  comics_recognize: (args) => {
    const folderId = str(args.folderId, ROOT_ID) || ROOT_ID;
    assertFolderId(folderId, "待识别目录");
    const entries = childrenOf(folderId);
    const volumes = entries.filter(isComic);
    return {
      folderId,
      scannedCount: entries.length,
      truncated: false,
      series: groupComicSeries(volumes),
      looseImageCount: entries.filter((entry) => isPhoto(entry)).length,
      skippedCount: entries.length - volumes.length,
    };
  },
  comics_index: () => {
    const volumes: MockEntry[] = [];
    for (const folderId of comicsIndexState.folderIds) {
      volumes.push(...childrenOf(folderId).filter(isComic));
    }
    return {
      folderCount: comicsIndexState.folderIds.size,
      lastScannedAt: comicsIndexState.lastScannedAt,
      series: groupComicSeries(volumes),
    };
  },
  comics_index_folders: (args) => {
    const folderIds = strArray(args.folderIds);
    if (folderIds.length === 0) fail("未选择要索引的目录");
    if (folderIds.length > 20) fail("单次最多索引 20 个目录");
    const overviews = folderIds.map((folderId) => HANDLERS.comics_recognize({ folderId }));
    for (const folderId of folderIds) {
      comicsIndexState.folderIds.add(folderId);
    }
    comicsIndexState.lastScannedAt = formatStamp(now());
    return overviews;
  },
  comics_open_volume: (args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const fileId = str(input.fileId);
    const fileName = str(input.fileName, "漫画卷.cbz");
    // 与 Rust comics_open_volume 的能力口径一致：阅读器仅支持 CBZ/ZIP，
    // 其余格式显式失败而不是返回假页，保证前端「不可读」标记有真实依据。
    const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
    if (extension !== "cbz" && extension !== "zip") {
      fail(`阅读器目前支持 CBZ/ZIP，暂不支持「.${extension}」格式`);
    }
    const pageCount = 6 + (hashOf(fileId) % 3);
    const saved = comicsReadProgress.get(fileId);
    return {
      fileId,
      seriesTitle: str(input.seriesTitle, fileName),
      pages: Array.from({ length: pageCount }, (_, index) => comicPageDataUri(index, pageCount)),
      pageCount,
      resumePageIndex: saved ? Math.min(Math.max(0, saved.pageIndex), pageCount - 1) : 0,
    };
  },
  comics_save_progress: (args) => {
    const fileId = str(args.fileId);
    if (!fileId) fail("缺少文件 ID");
    comicsReadProgress.set(fileId, {
      pageIndex: Math.max(0, Math.trunc(num(args.pageIndex))),
      pageCount: Math.max(0, Math.trunc(num(args.pageCount))),
    });
    return null;
  },

  // ----- 媒体信息与本地扫描 -----
  media_scrape_115: (args) => {
    const entry = entryById(str(args.fileId));
    const isVideo = entry.kind === "video";
    return {
      provider: "cloud115",
      fileId: entry.id,
      durationSeconds: entry.durationSeconds,
      width: isVideo ? 1920 : 4032,
      height: isVideo ? 1080 : 3024,
      videoCodec: isVideo ? "h264" : null,
      audioCodec: isVideo ? "aac" : null,
    };
  },
  media_probe_local: (args) => {
    const path = str(args.path);
    if (!path) fail("缺少要探测的本地文件路径");
    return {
      provider: "local",
      fileId: path,
      durationSeconds: 5400 + (hashOf(path) % 3600),
      width: 1920,
      height: 1080,
      videoCodec: "h264",
      audioCodec: "aac",
    };
  },
  scan_local_directory: (args) => {
    const path = str(args.path);
    if (!path) fail("缺少要扫描的目录路径");
    const task: MockLibraryTask = {
      id: `task-${(libraryTaskSeq += 1)}`,
      title: "扫描本地媒体目录",
      detail: path,
      status: "running",
      progress: 0.1,
    };
    libraryTasks.unshift(task);
    if (libraryTasks.length > 12) libraryTasks.pop();
    setTimeout(() => {
      task.progress = 0.55;
    }, 700);
    setTimeout(() => {
      task.status = "completed";
      task.progress = 1;
    }, 1700);
    return { ...task };
  },

  // ----- 本机库与设置 -----
  library_list: () => HANDLERS.library_search({ query: "" }),
  library_search: (args) => {
    const keyword = str(args.query).trim().toLowerCase();
    const all = LIBRARY_ITEMS;
    if (!keyword) return all;
    return all.filter(
      (item) => item.title.toLowerCase().includes(keyword) || item.originalTitle.toLowerCase().includes(keyword),
    );
  },
  library_tasks: () => libraryTasks.map((task) => ({ ...task })),
  app_settings: () => ({ ...appSettingsState }),
  update_app_settings: (args) => {
    const settings = (args.settings ?? {}) as Record<string, unknown>;
    const language = str(settings.metadataLanguage, appSettingsState.metadataLanguage);
    if (language !== "zh-CN" && language !== "en-US") fail(`不支持的元数据语言：${language}`);
    appSettingsState.metadataLanguage = language;
    appSettingsState.autoScrape = bool(settings.autoScrape, appSettingsState.autoScrape);
    appSettingsState.playbackHistory = bool(settings.playbackHistory, appSettingsState.playbackHistory);
    return { ...appSettingsState };
  },

  // ----- 播放器（快照时间码随真实时钟推进） -----
  open_local_file: (args) => {
    const path = str(args.path);
    if (!path) fail("缺少本地文件路径");
    return openPlayback(path);
  },
  open_remote_url: (args) => {
    const url = str(args.url);
    if (!url) fail("缺少远程播放地址");
    return openPlayback(url);
  },
  playback_snapshot: () => (playback ? snapshotOf(playback) : { ...IDLE_SNAPSHOT }),
  toggle_pause: () => {
    const current = requirePlayback();
    current.positionBase = playbackPosition(current);
    current.anchorAt = Date.now();
    current.paused = !current.paused;
    return snapshotOf(current);
  },
  seek: (args) => {
    const current = requirePlayback();
    const seconds = num(args.seconds);
    current.positionBase = Math.min(current.durationSeconds, Math.max(0, seconds));
    current.anchorAt = Date.now();
    return snapshotOf(current);
  },
  set_volume: (args) => {
    const current = requirePlayback();
    // libmpv 音量为 0-100；超范围输入按夹具边界截断。
    current.volume = Math.min(100, Math.max(0, num(args.volume, current.volume)));
    return snapshotOf(current);
  },
  destroy_playback: () => {
    playback = null;
    return null;
  },

  // ----- Tauri 插件命令 -----
  "plugin:event|listen": (args) => {
    const event = str(args.event);
    const handlerId = num(args.handler);
    if (!event || !eventCallbacks.has(handlerId)) fail(`无效的事件监听注册：${event || "(未知名)"}`);
    const listeners = eventListeners.get(event) ?? new Map();
    const eventId = (eventIdSeq += 1);
    listeners.set(eventId, { target: args.target, handlerId });
    eventListeners.set(event, listeners);
    return eventId;
  },
  "plugin:event|unlisten": (args) => {
    eventListeners.get(str(args.event))?.delete(num(args.eventId));
    return null;
  },
  // v2 中前端 emit 同样会送达本 webview 的监听者；目标过滤与 listen 一致从简。
  "plugin:event|emit": (args) => {
    emitMockEvent(str(args.event), args.payload);
    return null;
  },
  "plugin:event|emit_to": (args) => {
    emitMockEvent(str(args.event), args.payload);
    return null;
  },
  "plugin:dialog|open": (args) => {
    const options = (args.options ?? {}) as Record<string, unknown>;
    if (bool(options.directory)) return "/Users/演示/下载";
    if (bool(options.multiple)) {
      return ["/Users/演示/下载/纪录片花絮.mp4", "/Users/演示/下载/工作室纪实.mov"];
    }
    return "/Users/演示/下载/演示影片.mkv";
  },
};

// 预置一个中断待续传的上传会话，便于验证上传会话面板与续传流程。
uploadSessions.push({
  id: `up-${(uploadSessionSeq += 1)}`,
  localPath: "/Users/演示/下载/纪录片花絮.mp4",
  fileName: "纪录片花絮.mp4",
  targetId: "d2",
  fileSize: 3 * UPLOAD_PART_SIZE,
  fileSha1: "mock-sha1-resume",
  preSha1: "mock-pres-resume",
  pickCode: "",
  bucket: "mock-bucket",
  objectKey: "mock/%E7%BA%AA%E5%BD%95%E7%89%87%E8%8A%B1%E7%B5%AE.mp4",
  uploadId: "upload-resume-seed",
  callback: "",
  callbackVar: "",
  partSize: UPLOAD_PART_SIZE,
  completedParts: [
    { number: 1, etag: "etag-resume-1" },
    { number: 2, etag: "etag-resume-2" },
  ],
  status: "uploading",
});

// ---------------------------------------------------------------------------
// 安装 IPC 拦截
// ---------------------------------------------------------------------------

window.__TAURI_INTERNALS__ = {
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    const handler = HANDLERS[cmd];
    if (!handler) {
      // 未覆盖的命令必须显式提示，避免下游工作包误以为返回值有效。
      console.warn(`[dev-mock] 未模拟的命令：${cmd}`);
      return Promise.resolve(null);
    }
    try {
      return Promise.resolve(handler(args ?? {}));
    } catch (reason) {
      // 与 Rust 命令的 Result<_, String> 对齐：错误以字符串形式 reject。
      return Promise.reject(reason instanceof Error ? reason.message : String(reason));
    }
  },
  convertFileSrc: (path: string) => path,
  transformCallback: (callback: ((data: unknown) => void) | undefined, once?: boolean) =>
    registerCallback(callback, Boolean(once)),
};

window.__TAURI_INTERNALS__.runCallback = (id: number, data: unknown) => {
  const callback = eventCallbacks.get(id);
  if (callback) {
    callback(data);
  } else {
    console.warn(`[dev-mock] 未找到回调 id ${id}，可能页面已重载。`);
  }
};
window.__TAURI_INTERNALS__.unregisterCallback = unregisterCallback;
// @tauri-apps/api/event 的 _unlisten 依赖该内部表；缺了它任何取消订阅都会抛错。
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: (event: string, eventId: number) => {
    eventListeners.get(event)?.delete(eventId);
  },
};
window.__SIRIUS_MOCK_EMIT__ = emitMockEvent;

export {};
