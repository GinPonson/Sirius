import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  Cloud115Service,
  MediaInfoService,
  type Cloud115AccountStatus,
  type Cloud115FileEntry,
  type Cloud115SearchScope,
  type Cloud115UploadSession,
} from "../services/mediaServices";
import { isTransferActive } from "../services/events";
import { useTransferEvents, type TransferState } from "../hooks/useTransferEvents";
import { registerViewPageContext, notifyPageContextChanged, type AiPageContext } from "../domain/pageContext";
import { Icon } from "./Icon";
import { FileTypeIcon } from "./FileTypeIcon";
import { FileThumbnail } from "./FileThumbnail";
import { FileContextMenu, type FileMenuItem } from "./FileContextMenu";
import { getFilePresentation } from "../domain/fileTypes";
import { isAudioFile } from "./AudioPlayerBar";
import { ImageLightbox, type ImageLightboxItem } from "./ImageLightbox";
import {
  DUPLICATE_DELETE_BATCH_SIZE,
  DUPLICATE_SCAN_MAX_ENTRIES,
  DUPLICATE_SCAN_PAGE_LIMIT,
  defaultDuplicateSelectionIds,
  defaultRetainedEntry,
  findDuplicateGroups,
  groupsFullySelected,
  hasCopyMarker,
  removeDeletedEntriesFromGroups,
  type DuplicateGroup,
  type DuplicateReason,
} from "../domain/duplicates";

/** 类型筛选：与 Rust 侧 kind 一一对应，用户可按目录/视频/图片/音频/字幕/其它文件收窄列表。 */
type CloudFileFilter = "all" | "folder" | "video" | "image" | "audio" | "subtitle" | "file";

/** 筛选标签与顺序：目录排最前后依次是媒体类型，最后是未分类文件。 */
const FILE_FILTERS: Array<{ id: CloudFileFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "folder", label: "文件夹" },
  { id: "video", label: "视频" },
  { id: "image", label: "图片" },
  { id: "audio", label: "音频" },
  { id: "subtitle", label: "字幕" },
  { id: "file", label: "其它" },
];
type FolderPick = { id: string; name: string };
type FolderPicker = {
  mode: "move" | "copy";
  path: FolderPick[];
  entries: Cloud115FileEntry[];
  loading: boolean;
  /** 本次移动/复制的目标条目；批量栏来自选择集，单条菜单来自该行。 */
  ids: string[];
};

type CloudFilesViewProps = {
  account: Cloud115AccountStatus | null;
  /** 顶栏下发的当前目录搜索词；防抖与取数仍由本组件负责。 */
  query: string;
  onQueryChange: (value: string) => void;
  /**
   * 通知应用壳当前是否处于收藏视图。
   *
   * 收藏是全账号列表、不支持关键词检索，顶栏搜索框必须随之隐藏——否则用户输入的关键词
   * 不会作用在列表上，却仍会触发重新请求并影响空态文案。
   */
  onStarredViewChange: (starred: boolean) => void;
  /**
   * 外部要求刷新列表的序号。
   *
   * 回收站是独立页面：在其中还原文件后，本页当前目录的内容可能已变化，
   * 由应用壳递增此值触发一次重载。序号而非布尔量，保证连续多次还原都能触发。
   */
  refreshNonce: number;
  onRequireLogin: () => void;
  onPlay: (entry: Cloud115FileEntry) => Promise<void>;
};

/** 文件页视图模式：列表 / 网格；选择持久化 localStorage。 */
type ViewMode = "list" | "grid";
/** 显示密度：舒适（行高 50px）/ 紧凑（行高 38px），列表与网格共用。 */
type Density = "comfortable" | "compact";
/** 排序字段与方向；只作用于已加载项（分页语义）。 */
type SortField = "name" | "size" | "modifiedAt";
type SortOrder = "asc" | "desc";
type SortState = { field: SortField; order: SortOrder };

/** 统一浮层菜单的打开状态：entry 为空表示页级菜单（视图/排序/更多），否则是单条目菜单。 */
type PaneMenu = {
  entry: Cloud115FileEntry | null;
  /** 页级菜单种类：视图设置（含排序）或仅排序。单条目菜单忽略此字段。 */
  pageMenu?: "view" | "sort";
  x: number;
  y: number;
  /** 关闭后焦点送回触发位置：行元素、更多按钮或视图/排序按钮。 */
  restoreTo: HTMLElement | null;
};

/** 目录级 UI 记忆：返回该目录时恢复滚动位置与排序；视图模式是全局持久化，天然恢复。 */
type DirUiMemory = { scrollTop: number; sort: SortState };

/** 目标选择器「最近使用」条目：记录完整路径便于一键直达与展示。 */
type RecentTarget = { id: string; name: string; path: FolderPick[] };

const ROOT_ID = "0";
const PAGE_LIMIT = 100;
const cloud115 = new Cloud115Service();
const mediaInfoService = new MediaInfoService();

const VIEW_MODE_KEY = "sirius-files-view";
const DENSITY_KEY = "sirius-files-density";
const RECENT_TARGETS_KEY = "sirius-files-recent-targets";
const DEFAULT_SORT: SortState = { field: "name", order: "asc" };
const SORT_FIELD_LABELS: Record<SortField, string> = { name: "文件名", size: "大小", modifiedAt: "修改时间" };
/** 重复原因的人读标签：与 domain/duplicates 的 reason 一一对应，不发明额外含义。 */
const DUPLICATE_REASON_LABELS: Record<DuplicateReason, string> = {
  name: "同名",
  content: "内容相同",
  both: "同名且内容相同",
};

function readStoredViewMode(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_MODE_KEY) === "grid" ? "grid" : "list";
  } catch {
    // 存储不可用（隐私模式等）时退回内存默认，不影响本次会话。
    return "list";
  }
}

function readStoredDensity(): Density {
  try {
    return window.localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

/** 读取最近使用的移动/复制目标；结构不合法时忽略，不发明数据。 */
function readRecentTargets(): RecentTarget[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_TARGETS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is RecentTarget => {
        if (typeof item !== "object" || item === null) return false;
        const candidate = item as Partial<RecentTarget>;
        return typeof candidate.id === "string" && typeof candidate.name === "string" && Array.isArray(candidate.path);
      })
      .slice(0, 5);
  } catch {
    return [];
  }
}


/**
 * 已加载项的客户端排序：目录始终在前；同值回退文件名，保证顺序稳定。
 *
 * 注意与分页的关系：115 按 `o`/`asc`（当前 user_utime 降序）在服务端切片，
 * 这里的重排只影响已加载项，因此排序切换到「大小/修改时间」时，后续页会按
 * 服务端顺序追加而非全局有序。UI 已在排序菜单与计数标签上标注「只作用于
 * 已加载项」，不隐藏该限制。
 */
function compareEntries(a: Cloud115FileEntry, b: Cloud115FileEntry, sort: SortState): number {
  const folderBias = (entry: Cloud115FileEntry) => (entry.kind === "folder" ? 0 : 1);
  const byFolder = folderBias(a) - folderBias(b);
  if (byFolder !== 0) return byFolder;
  const byName = a.name.localeCompare(b.name, "zh-Hans-CN");
  if (sort.field === "size") {
    const bySize = a.sizeBytes - b.sizeBytes;
    return bySize !== 0 ? bySize * (sort.order === "asc" ? 1 : -1) : byName;
  }
  if (sort.field === "modifiedAt") {
    const byTime = a.modifiedAt - b.modifiedAt;
    return byTime !== 0 ? byTime * (sort.order === "asc" ? 1 : -1) : byName;
  }
  return byName * (sort.order === "asc" ? 1 : -1);
}

/** 超长文件名拆为「中段可省略 + 固定扩展名」两段；目录名与短名不拆。 */
function splitLongName(name: string): { head: string; tail: string } | null {
  if (name.length <= 26) return null;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { head: name, tail: "" };
  return { head: name.slice(0, dot), tail: name.slice(dot) };
}

/** 空状态分类：读取中 / 目录为空 / 搜索或筛选无结果 / 读取失败 / 回收站为空。 */
type FileEmptyKind = "directory-empty" | "starred-empty" | "no-results" | "load-error";

/** 将秒数格式化为 h:mm:ss 的紧凑时长。 */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const two = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${two(minutes)}:${two(secs)}` : `${minutes}:${two(secs)}`;
}

/** 将字节数格式化为适合文件列表的紧凑容量。 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

/** 将 115 秒级时间戳格式化为本地日期；缺失值保持明确的占位。 */
function formatModifiedAt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(seconds * 1000));
}

/** 批量对话框中的人读清单：最多展示两个名称，其余折叠为数量。 */
function describeTargets(targets: Cloud115FileEntry[]): string {
  if (targets.length <= 2) {
    return targets.map((entry) => `“${entry.name}”`).join("、");
  }
  return `“${targets[0].name}”、“${targets[1].name}”等 ${targets.length} 项`;
}

/** 上传按钮的阶段文案：传输中带分片序号，收尾阶段提示正在确认文件。 */
function uploadStageLabel(uploading: { index: number; total: number }, transfer: TransferState | undefined): string {
  const base = `正在上传 ${uploading.index}/${uploading.total}`;
  if (!transfer) return base;
  if (transfer.stage === "preparing") return `${base} · 准备中`;
  if (transfer.stage === "finalizing") return `${base} · 正在确认文件`;
  if (transfer.stage === "transferring" && transfer.totalParts) {
    const currentPart = Math.min((transfer.completedParts ?? 0) + 1, transfer.totalParts);
    return `${base} · 第 ${currentPart}/${transfer.totalParts} 片`;
  }
  return base;
}

/** 传输进度专用的字节格式化；0 显示为 0 B 而不是占位符。 */
function formatTransferBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  return formatBytes(bytes);
}

/** 115 网盘真实文件浏览页；批量移动/复制的目标策略由 Rust 侧统一校验。 */
export function CloudFilesView({ account, query, onQueryChange, onStarredViewChange, refreshNonce, onRequireLogin, onPlay }: CloudFilesViewProps) {
  const [path, setPath] = useState<FolderPick[]>([{ id: ROOT_ID, name: "115 网盘" }]);
  const [entries, setEntries] = useState<Cloud115FileEntry[]>([]);
  const [filter, setFilter] = useState<CloudFileFilter>("all");
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  /** 同目录刷新（重命名/上传/回收站操作后）：保留旧列表并叠加刷新指示，避免清空闪烁。 */
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [renameEntry, setRenameEntry] = useState<Cloud115FileEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTargets, setDeleteTargets] = useState<Cloud115FileEntry[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [picker, setPicker] = useState<FolderPicker | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<{ name: string; index: number; total: number } | null>(null);
  const [uploadSessions, setUploadSessions] = useState<Cloud115UploadSession[]>([]);
  const [dismissedSessions, setDismissedSessions] = useState<Set<string>>(new Set());
  const [resumingId, setResumingId] = useState<string | null>(null);
  /** 拖拽态：文件被拖到窗口上方时为 true，用于显示上传提示层。 */
  const [dragActive, setDragActive] = useState(false);
  /** 文件区容器的引用：拖放事件给的是窗口坐标，需要换算后判断是否落在区域内。 */
  const dropZoneRef = useRef<HTMLElement | null>(null);
  /** 最近一次上传/拖拽的目标目录：拖放事件是异步回调，不能依赖闭包里的旧值。 */
  const dropContextRef = useRef({ targetId: "", enabled: false });
  // 视图状态机：视图模式与密度全局持久化；排序随目录记忆（内存态）。
  const [viewMode, setViewMode] = useState<ViewMode>(readStoredViewMode);
  const [density, setDensity] = useState<Density>(readStoredDensity);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  // 统一浮层菜单（右键 / 行尾更多 / 排序）。
  const [paneMenu, setPaneMenu] = useState<PaneMenu | null>(null);
  /**
   * 图片查看器状态：items 是打开瞬间的可视图片清单快照，index 为当前项。
   * 快照而非实时联动，避免查看期间列表刷新（重命名/删除）让下标漂移。
   */
  const [lightbox, setLightbox] = useState<{ items: ImageLightboxItem[]; index: number } | null>(null);
  // 新建文件夹：行内对话框命名，成功后刷新当前目录。
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  // 目标选择器「最近使用」：最近 5 个目标目录，持久化 localStorage。
  const [recentTargets, setRecentTargets] = useState<RecentTarget[]>(readRecentTargets);
  // 查重面板：只扫当前目录（不含子目录）与当前目录的「目录 ID」，切换目录即作废。
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  /** 扫描态：progress 为已读取条目数，占位期间不伪造结果。 */
  const [duplicateScanning, setDuplicateScanning] = useState(false);
  const [duplicateScanProgress, setDuplicateScanProgress] = useState<{ loaded: number; total: number } | null>(null);
  /** 扫描结果：null 表示还没结果（未扫或扫描中），空数组才是「未发现重复文件」。 */
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[] | null>(null);
  const [duplicateScannedCount, setDuplicateScannedCount] = useState(0);
  /** 扫描结果所属目录 ID：目录变化后旧结果不再是当前上下文，不允许直接删除。 */
  const [duplicateFolderId, setDuplicateFolderId] = useState<string | null>(null);
  const [duplicateSelected, setDuplicateSelected] = useState<Set<string>>(new Set());
  const [duplicateConfirmOpen, setDuplicateConfirmOpen] = useState(false);
  /** 分批删除进度：completed/total 为本次确认待删项，失败时保留真实已完成数量。 */
  const [duplicateDeleting, setDuplicateDeleting] = useState<{ completed: number; total: number } | null>(null);
  /**
   * 面板级错误/校验提示：扫描与删除失败、以及「每组至少保留 1 项」这类拒绝都要显示在
   * 对话框内——页面级 error 横幅会被遮罩挡住，而且会被空目录逻辑误判成列表读取失败。
   */
  const [duplicatePanelError, setDuplicatePanelError] = useState<string | null>(null);
  /** 扫描取消与竞态：cancelRequested 由「取消」置位，requestSeq 丢弃迟到的分页响应。 */
  const duplicateScanCancelRef = useRef(false);
  const duplicateScanSeqRef = useRef(0);
  /** 查重对话框容器：打开时承接焦点，Esc 与 Tab 才会落在对话框内。 */
  const duplicateDialogRef = useRef<HTMLElement | null>(null);
  /** 删除确认框容器：焦点必须从面板移进来，否则 Esc 会关掉背后的整个面板。 */
  const duplicateConfirmRef = useRef<HTMLElement | null>(null);
  // 键盘选择矩阵：Shift 连选锚点 + 当前行焦点（行内 roving tabindex）。
  const anchorIdRef = useRef<string | null>(null);
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  // 批量操作完成后手动触发列表重载；常规浏览仍走目录/搜索依赖。
  const [reloadNonce, setReloadNonce] = useState(0);
  // 传输进度事件由全局单例 store 推送；此处仅做最小阶段展示。
  const transfers = useTransferEvents();
  /** 当前进行中的上传；上传按顺序逐个提交，同一时刻至多一个。 */
  const activeUpload = transfers.find(
    (transfer) => transfer.kind === "upload" && isTransferActive(transfer.stage),
  );
  /** 当前进行中的下载；下载动作由 busyAction 串行化，同一时刻至多一个。 */
  const activeDownload = transfers.find(
    (transfer) => transfer.kind === "download" && isTransferActive(transfer.stage),
  );
  const currentFolderId = path[path.length - 1].id;
  // 搜索范围：缺省当前目录；切到全账号后 115 用 cid=0 做跨目录匹配。
  // 它参与 requestKey，范围变化必须重新取第一页，不能复用目录内结果。
  const [searchScope, setSearchScope] = useState<Cloud115SearchScope>("current");
  // 收藏视图：与目录浏览互斥，进入后列表只显示全账号星标项，不跟随目录切换。
  const [starredView, setStarredView] = useState(false);
  // 收藏视图不参与关键词检索：顶栏搜索框由应用壳据此隐藏，避免输入无效关键词。
  useEffect(() => {
    onStarredViewChange(starredView);
  }, [starredView, onStarredViewChange]);
  // 离开文件页时复位，避免顶栏搜索框在其它页面被误隐藏。
  useEffect(() => () => onStarredViewChange(false), [onStarredViewChange]);
  const requestKey = `${currentFolderId}\u0000${query.trim()}\u0000${searchScope}\u0000${starredView ? "starred" : "dir"}`;
  const requestKeyRef = useRef(requestKey);
  requestKeyRef.current = requestKey;

  /** 视图切换后的滚动恢复：网格与列表高度不同，切换后按原滚动量回位。 */
  const pendingViewScrollRef = useRef<number | null>(null);
  /** 返回目录时的滚动恢复目标。 */
  const pendingDirScrollRef = useRef<number | null>(null);
  /** 目录级排序与滚动记忆；跨目录往返保留，不持久化历史栈。 */
  const dirUiMemoryRef = useRef(new Map<string, DirUiMemory>());

  /** 上一次成功加载的「目录 + 查询」键；相同键的重新加载视为刷新而非切换。 */
  const loadedKeyRef = useRef<string | null>(null);

  /** 无限滚动哨兵：进入视口即预约下一页，取代底部「加载更多」按钮。 */
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  /** 最近一次渲染的翻页决策；供稳定的 IntersectionObserver 回调读取最新状态。 */
  const requestNextPageRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!account?.connected) return;
    let active = true;
    // 同目录/同查询的重新加载（操作后刷新）保留旧列表，仅叠加刷新指示；
    // 目录或搜索条件变化才清空并显示骨架，避免内容错位与页面跳动。
    const isRefresh = loadedKeyRef.current === requestKey && entries.length > 0;
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
      setEntries([]);
      setTotal(0);
    }
    setLoadingMore(false);
    const timeout = window.setTimeout(() => {
      // 收藏视图不跟随目录：115 的 star=1 + cur=0 本身就是全账号遍历。
      const request = starredView
        ? cloud115.listStarredFiles(0, PAGE_LIMIT)
        : cloud115.listFiles(currentFolderId, query.trim(), 0, PAGE_LIMIT, searchScope);
      request
        .then((page) => {
          if (!active) return;
          setEntries(page.entries);
          setTotal(page.total);
          setHasMore(page.hasMore);
          loadedKeyRef.current = requestKey;
        })
        .catch((reason) => {
          if (!active) return;
          setEntries([]);
          // 失败时清空总数，避免沿用上一个目录的分母造成误导。
          setTotal(0);
          loadedKeyRef.current = null;
          setError(`读取 115 文件失败：${String(reason)}`);
        })
        .finally(() => {
          if (!active) return;
          setLoading(false);
          setRefreshing(false);
        });
    }, query.trim() ? 250 : 0);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
    // entries.length 仅用于判断首次加载后的刷新场景，不作为触发条件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.connected, currentFolderId, query, searchScope, starredView, reloadNonce, refreshNonce]);

  // 搜索词由顶栏下发：口径变化立即清空选择，避免批量操作作用于即将不可见的文件。
  useEffect(() => {
    setSelectedIds(new Set());
  }, [query]);

  // 目录变化时作废查重扫描：结果与「当前目录」强绑定，混用会让删除落到别的目录。
  // 面板遮罩本身会挡住导航，这里只作防御性兜底（如外部触发目录重置）。
  useEffect(() => {
    if (!duplicateOpen) return;
    if (duplicateFolderId === null || duplicateFolderId === currentFolderId) return;
    cancelDuplicateScan();
    setDuplicateGroups(null);
    setDuplicateFolderId(null);
    setDuplicateSelected(new Set());
    setDuplicatePanelError("目录已变化，请重新扫描后再删除。");
    // 仅响应目录切换；其余状态不参与触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFolderId]);

  // 视图与密度选择即时回写 localStorage；失败只影响下次启动的初始值。
  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_MODE_KEY, viewMode);
    } catch {
      // 存储不可用时保持内存态即可。
    }
  }, [viewMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem(DENSITY_KEY, density);
    } catch {
      // 同上。
    }
  }, [density]);

  useLayoutEffect(() => {
    if (pendingViewScrollRef.current === null) return;
    window.scrollTo({ top: pendingViewScrollRef.current });
    pendingViewScrollRef.current = null;
  }, [viewMode, loading]);

  // 返回目录：数据落地后恢复离开时的滚动位置（超出的部分由浏览器收敛）。
  useLayoutEffect(() => {
    if (loading || pendingDirScrollRef.current === null) return;
    window.scrollTo({ top: pendingDirScrollRef.current });
    pendingDirScrollRef.current = null;
  }, [loading, entries]);

  /**
   * 类型筛选。
   *
   * 音频没有独立的 `kind`（Rust 侧 `kind` 只区分 folder/video/subtitle/image/file），
   * 因此「音频」按扩展名判定，与双击播放用的 `isAudioFile` 保持同一口径；
   * 「其它」则排除所有已单独成项的媒体类型，避免音频同时出现在两个筛选里。
   */
  const matchesFilter = useCallback(
    (entry: Cloud115FileEntry) => {
      if (filter === "all") return true;
      if (filter === "audio") return entry.kind !== "folder" && isAudioFile(entry);
      if (filter === "file") {
        return entry.kind === "file" && !isAudioFile(entry);
      }
      return entry.kind === filter;
    },
    [filter],
  );

  const visibleEntries = useMemo(
    () => entries.filter(matchesFilter).sort((a, b) => compareEntries(a, b, sort)),
    [entries, matchesFilter, sort],
  );

  /** 批量操作的统一取数口径：选择集与当前列表的交集，防止误操作不可见文件。 */
  const selectedEntries = useMemo(
    () => entries.filter((entry) => selectedIds.has(entry.id)),
    [entries, selectedIds],
  );

  // AI 对话面板的页面上下文：目录、选择与加载进度随渲染更新；注册一次，读取引用取最新值。
  const pageContextRef = useRef<AiPageContext | null>(null);
  pageContextRef.current = !account?.connected ? null : {
    page: "cloud-files",
    scope: "网盘文件",
    detail: path.length > 1 ? path.slice(1).map((item) => item.name).join(" / ") : undefined,
    selection: selectedEntries.slice(0, 8).map((entry) => entry.name),
    selectedCount: selectedIds.size,
    query: query.trim() || undefined,
    loaded: `${entries.length} / ${total}`,
    folderId: currentFolderId,
    folderName: path[path.length - 1].name,
  };

  useEffect(() => {
    registerViewPageContext(() => pageContextRef.current);
    return () => registerViewPageContext(null);
  }, []);

  // 上下文随渲染更新（目录、选择、加载进度）；通知 AI 面板刷新当前上下文标签。
  useEffect(() => {
    notifyPageContextChanged();
  });

  /** 查询 SQLite 中未完成的 multipart 会话；仅在登录状态下有意义。 */
  function refreshUploadSessions() {
    if (!account?.connected) return;
    cloud115.uploadSessions()
      .then((items) => setUploadSessions(items))
      .catch((reason) => setError(`读取上传会话失败：${String(reason)}`));
  }

  useEffect(() => {
    refreshUploadSessions();
  }, [account?.connected]);

  const pendingSessions = uploadSessions.filter((session) => !dismissedSessions.has(session.id));

  /**
   * 顺序上传一批本地路径；115 对控制请求限速，逐个提交比并发更稳。
   *
   * 文件与目录走不同命令：目录由 Rust 递归展开并在云端重建结构，
   * 前端不逐层调用，避免深层目录产生大量 IPC 往返。
   *
   * @param paths 本地绝对路径（文件或目录）
   * @param targetId 云端目标目录；拖放事件异步到达，必须显式传入而不是读闭包
   */
  async function uploadPaths(paths: string[], targetId: string = currentFolderId) {
    if (paths.length === 0) return;
    setError(null);
    const failures: string[] = [];
    let uploaded = 0;
    for (const [index, path] of paths.entries()) {
      const name = path.split("/").pop() ?? path;
      setUploading({ name, index: index + 1, total: paths.length });
      try {
        const result = await cloud115.uploadDirectory(path, targetId);
        uploaded += result.uploaded;
        for (const failure of result.failed) {
          failures.push(`${name}/${failure.relativePath}：${failure.reason}`);
        }
      } catch (reason) {
        // 目录上传失败（路径不存在、权限不足等）与单文件失败同等对待：
        // 记录原因并继续处理后续路径，不因一项失败放弃整批。
        failures.push(`${name}：${String(reason)}`);
        if (failures.length === paths.length && uploaded === 0) {
          // 全部失败时不必逐条罗列，直接给出首个真实原因。
          setUploading(null);
          setError(`上传失败：${String(reason)}`);
          return;
        }
      }
    }
    setUploading(null);
    if (failures.length > 0) {
      setError(`上传完成，但 ${failures.length} 项失败：${failures.join("；")}`);
    } else {
      setNotice(`已上传 ${uploaded} 个文件到当前目录`);
    }
    setReloadNonce((nonce) => nonce + 1);
    refreshUploadSessions();
  }

  /** 点击上传按钮：系统选择器选出多文件后交给统一上传入口。 */
  async function startUpload() {
    const filePaths = await cloud115.pickUploadFiles();
    await uploadPaths(filePaths);
  }

  // 拖拽上下文：目标目录与可用性随渲染更新；事件回调只读 ref，避免拿到旧闭包。
  dropContextRef.current = {
    // 收藏是跨目录视图，没有可作用的父目录——与上传按钮的禁用条件保持一致。
    targetId: currentFolderId,
    enabled: account?.connected === true && !starredView && uploading === null,
  };

  /**
   * 接管系统拖放：Tauri 的 drag-drop 事件能拿到真实本地路径，
   * 浏览器的 HTML5 drop 在 WebView 里拿不到（安全限制）。
   *
   * 只在指针落在文件区时接受投放：拖到侧栏或顶栏不应该触发上传。
   */
  useEffect(() => {
    if (!account?.connected) return;
    // 拖放是 Tauri 原生能力：纯浏览器（dev-mock 冒烟）没有 Webview API，
    // 订阅失败只记录不阻断按钮上传。
    let disposed = false;
    let unlisten: (() => void) | null = null;

    /** 窗口坐标（物理像素）是否落在文件区内。 */
    function isInsideDropZone(x: number, y: number): boolean {
      const zone = dropZoneRef.current;
      if (!zone) return false;
      const ratio = window.devicePixelRatio || 1;
      const rect = zone.getBoundingClientRect();
      const localX = x / ratio;
      const localY = y / ratio;
      return localX >= rect.left && localX <= rect.right && localY >= rect.top && localY <= rect.bottom;
    }

    // 浏览器里没有 Webview API：getCurrentWebview() 返回 undefined，
    // 同步调用它的方法会抛 TypeError，因此整体包在 try 里。
    try {
      const webview = getCurrentWebview();
      if (!webview || typeof webview.onDragDropEvent !== "function") return;
      webview
        .onDragDropEvent((event) => {
          if (disposed) return;
          const payload = event.payload;
          if (payload.type === "enter" || payload.type === "over") {
            const inside = isInsideDropZone(payload.position.x, payload.position.y);
            setDragActive(inside && dropContextRef.current.enabled);
            return;
          }
          if (payload.type === "leave") {
            setDragActive(false);
            return;
          }
          // drop
          setDragActive(false);
          const { enabled, targetId } = dropContextRef.current;
          if (!enabled) return;
          if (!isInsideDropZone(payload.position.x, payload.position.y)) return;
          if (payload.paths.length === 0) return;
          void uploadPaths(payload.paths, targetId);
        })
        .then((stop) => {
          if (disposed) {
            stop();
            return;
          }
          unlisten = stop;
        })
        .catch(() => {
          // 浏览器无 IPC 通道：拖拽不可用是预期行为，不提示、不阻断按钮上传。
        });
    } catch {
      // 非 Tauri 运行时（dev-mock 冒烟）：静默跳过拖放注册。
    }

    return () => {
      disposed = true;
      unlisten?.();
      setDragActive(false);
    };
    // uploadPaths 内部读取的目录与状态都来自 ref，因此依赖只需账号与视图种类。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.connected, starredView]);

  /** 从本地文件继续未完成的 multipart 会话；内容变化会被 Rust 校验拒绝。 */
  async function resumeUploadSession(session: Cloud115UploadSession) {
    setResumingId(session.id);
    setError(null);
    try {
      const result = await cloud115.resumeUpload(session.id);
      setNotice(`“${result.fileName}”已恢复上传${result.instant ? "（秒传）" : ""}`);
      setUploadSessions((current) => current.filter((item) => item.id !== session.id));
      setReloadNonce((nonce) => nonce + 1);
    } catch (reason) {
      setError(`恢复“${session.fileName}”上传失败：${String(reason)}`);
    } finally {
      setResumingId(null);
    }
  }

  const allVisibleSelected = visibleEntries.length > 0 && visibleEntries.every((entry) => selectedIds.has(entry.id));

  function toggleSelected(entryId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(entryId)) {
        next.delete(entryId);
      } else {
        next.add(entryId);
      }
      return next;
    });
  }

  function toggleAllVisible() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const entry of visibleEntries) next.delete(entry.id);
      } else {
        for (const entry of visibleEntries) next.add(entry.id);
      }
      return next;
    });
  }

  /** 目录、搜索词或类型筛选变化意味着选择上下文失效，立即清空避免误操作不可见文件。 */
  function clearSelection() {
    setSelectedIds(new Set());
    anchorIdRef.current = null;
    setActiveRowId(null);
  }

  /** 单选一行并记录 Shift 连选锚点。 */
  function selectOnly(entry: Cloud115FileEntry) {
    setSelectedIds(new Set([entry.id]));
    anchorIdRef.current = entry.id;
    setActiveRowId(entry.id);
  }

  /** ⌘/Ctrl 单击：增选或取消；锚点跟随最近点击项。 */
  function toggleSelectWithAnchor(entry: Cloud115FileEntry) {
    toggleSelected(entry.id);
    anchorIdRef.current = entry.id;
    setActiveRowId(entry.id);
  }

  /** Shift 连选：以最近点击项为锚，在当前展示顺序内扩展区间选择。 */
  function selectRangeTo(entry: Cloud115FileEntry) {
    const ids = visibleEntries.map((item) => item.id);
    const anchorId = anchorIdRef.current;
    const startIndex = anchorId !== null ? ids.indexOf(anchorId) : -1;
    const endIndex = ids.indexOf(entry.id);
    if (startIndex < 0 || endIndex < 0) {
      selectOnly(entry);
      return;
    }
    const [lo, hi] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
    setSelectedIds(new Set(ids.slice(lo, hi + 1)));
    setActiveRowId(entry.id);
  }

  /** 切换视图：保留选中、排序与滚动位置；选择持久化由 viewMode 的 effect 完成。 */
  function switchViewMode(next: ViewMode) {
    if (next === viewMode) return;
    pendingViewScrollRef.current = window.scrollY;
    setViewMode(next);
  }

  /** 行的主打开动作：文件夹进入、视频/音频播放、图片查看；其余类型交给更多菜单。 */
  function openEntryPrimary(entry: Cloud115FileEntry, rowElement?: HTMLElement | null) {
    if (entry.kind === "folder") {
      void openFolder(entry);
      return;
    }
    if (entry.kind === "video") {
      void playEntry(entry);
      return;
    }
    // 音频同样走播放链路（应用壳在内部分流到底部播放条），双击即播而不是弹菜单。
    if (isAudioFile(entry)) {
      void playEntry(entry);
      return;
    }
    if (entry.kind === "image") {
      openImagePreview(entry);
      return;
    }
    if (rowElement) {
      const rect = rowElement.getBoundingClientRect();
      openPaneMenu(entry, rect.left + rect.width / 2, rect.bottom + 4, rowElement);
    }
  }

  /**
   * 打开图片查看器。
   *
   * 切换清单沿用当前「已加载 + 已筛选 + 已排序」的可视顺序，因此查看器内的
   * 左右翻页与列表所见一致；未加载的分页不会被拉取，避免查看器触发额外请求。
   *
   * @param entry 要查看的图片条目；必须出现在当前可视清单中（否则忽略）
   */
  function openImagePreview(entry: Cloud115FileEntry) {
    const items: ImageLightboxItem[] = visibleEntries
      .filter((item) => item.kind === "image")
      .map((item) => ({ id: item.id, name: item.name, pickCode: item.pickCode, thumbUrl: item.thumbUrl }));
    const index = items.findIndex((item) => item.id === entry.id);
    if (index < 0) return;
    // 菜单可能正开着：先收起，避免浮层盖在查看器之上。
    closePaneMenu();
    setLightbox({ items, index });
  }

  /** 离开目录前记录该目录的滚动与排序，供返回时恢复。 */
  function rememberCurrentDirUi(folderId: string) {
    dirUiMemoryRef.current.set(folderId, { scrollTop: window.scrollY, sort });
  }

  /**
   * 进入文件夹。
   *
   * 收藏是跨目录视图，其中的目录与「进入收藏前所在目录」没有父子关系，不能把目标目录
   * 追加到当前 path 后面——否则面包屑会显示一条不存在的层级，点上级还会落到无关目录。
   * 收藏态下改用文件详情里的真实路径（根 → 直接父目录）重建面包屑。
   */
  async function openFolder(entry: Cloud115FileEntry) {
    if (entry.kind !== "folder") return;
    const fromStarredView = starredView;
    rememberCurrentDirUi(currentFolderId);
    if (fromStarredView) {
      setLoading(true);
      setError(null);
      try {
        const metadata = await cloud115.fileMetadata(entry.id);
        // paths 按「根目录 → 直接父目录」排列，不含目标目录自身；面包屑末尾补目标目录。
        const ancestors = metadata.path.filter((node) => node.id !== "");
        const basePath: FolderPick[] = ancestors[0]?.id === ROOT_ID
          ? ancestors.map((node) => ({ id: node.id, name: node.name || "未命名目录" }))
          : [{ id: ROOT_ID, name: "115 网盘" }, ...ancestors.map((node) => ({ id: node.id, name: node.name || "未命名目录" }))];
        setPath([...basePath, { id: entry.id, name: entry.name }]);
      } catch (reason) {
        // 拿不到真实路径时不能退回「拼到当前目录后面」的旧行为——那正是本函数要修的错误。
        setLoading(false);
        setError(`无法确定“${entry.name}”所在位置，暂不能打开：${String(reason)}`);
        return;
      }
      // 收藏态已退出：目标目录的真实位置已经写入 path。
      setStarredView(false);
    } else {
      setPath((current) => [...current, { id: entry.id, name: entry.name }]);
    }
    const memory = dirUiMemoryRef.current.get(entry.id) ?? null;
    pendingDirScrollRef.current = memory ? memory.scrollTop : 0;
    setSort(memory?.sort ?? DEFAULT_SORT);
    // 目录搜索范围限定当前目录：进入下级时同步清空顶栏搜索框。
    onQueryChange("");
    setFilter("all");
    clearSelection();
  }

  function navigateToPath(index: number) {
    if (index === path.length - 1) return;
    rememberCurrentDirUi(currentFolderId);
    const target = path[index];
    const memory = dirUiMemoryRef.current.get(target.id) ?? null;
    pendingDirScrollRef.current = memory ? memory.scrollTop : 0;
    setSort(memory?.sort ?? DEFAULT_SORT);
    setPath((current) => current.slice(0, index + 1));
    onQueryChange("");
    setFilter("all");
    clearSelection();
  }

  async function loadMore() {
    const activeRequestKey = requestKey;
    const offset = entries.length;
    setLoadingMore(true);
    setError(null);
    try {
      const page = starredView
        ? await cloud115.listStarredFiles(offset, PAGE_LIMIT)
        : await cloud115.listFiles(currentFolderId, query.trim(), offset, PAGE_LIMIT, searchScope);
      // 目录或搜索词变化后丢弃旧页，防止把上一目录的数据追加到新列表。
      if (requestKeyRef.current !== activeRequestKey) return;
      setEntries((current) => [...current, ...page.entries]);
      setHasMore(page.hasMore);
    } catch (reason) {
      if (requestKeyRef.current === activeRequestKey) {
        setError(`加载更多 115 文件失败：${String(reason)}`);
      }
    } finally {
      if (requestKeyRef.current === activeRequestKey) {
        setLoadingMore(false);
      }
    }
  }

  /**
   * 无限滚动：底部哨兵进入视口即加载下一页，取代「加载更多」按钮。
   * 哨兵仅在仍有下一页时挂载，因此依赖里的 hasMore 变化会重建观察器；
   * 已加载条数变化同样重建，使短内容在数据落地后继续预取，直到填满一屏。
   * 进行中的请求由 loadingMore 拦截。
   */
  requestNextPageRef.current = () => {
    if (hasMore && !loadingMore && !loading && !refreshing) void loadMore();
  };

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) requestNextPageRef.current();
      },
      // 提前约一屏预取，滚动到接近底部时无缝续接下一页。
      { rootMargin: "0px 0px 480px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, entries.length]);

  async function playEntry(entry: Cloud115FileEntry) {
    setPlayingId(entry.id);
    try {
      // onPlay（应用壳 playCloudFile）已把失败统一送到 toast；此处不重复包装，
      // 否则同一次播放失败会同时出现应用 toast 与本视图 inline 错误两条。
      await onPlay(entry);
    } finally {
      setPlayingId(null);
    }
  }

  /**
   * 设置当前文件的收藏状态。
   *
   * 收藏视图下取消收藏会让该条不再属于当前列表，因此取消后立即重载，
   * 避免用户看到一条实际已取消收藏的记录。
   */
  async function favoriteEntry(entry: Cloud115FileEntry, starred: boolean) {
    setBusyAction(true);
    setError(null);
    try {
      await cloud115.updateFile(entry.id, { starred });
      setNotice(starred ? `已收藏“${entry.name}”` : `已取消收藏“${entry.name}”`);
      // 收藏视图按星标过滤：取消后当前条目已不属于该列表，必须重载而不是留着旧行。
      if (starredView && !starred) setReloadNonce((nonce) => nonce + 1);
    } catch (reason) {
      setError(`${starred ? "收藏" : "取消收藏"}“${entry.name}”失败：${String(reason)}`);
    } finally {
      setBusyAction(false);
    }
  }

  /** 提交重命名，并原位更新列表，避免额外的整页加载闪烁。 */
  async function submitRename() {
    if (!renameEntry) return;
    const nextName = renameValue.trim();
    if (!nextName) {
      setError("文件名不能为空");
      return;
    }
    setBusyAction(true);
    setError(null);
    try {
      await cloud115.updateFile(renameEntry.id, { name: nextName });
      setEntries((current) => current.map((entry) => entry.id === renameEntry.id ? { ...entry, name: nextName } : entry));
      setNotice(`已重命名为“${nextName}”`);
      setRenameEntry(null);
    } catch (reason) {
      setError(`重命名失败：${String(reason)}`);
    } finally {
      setBusyAction(false);
    }
  }

  /** 刮削视频的媒体信息（时长等）并给出格式化摘要；结果同时持久化到本机 SQLite。 */
  async function scrapeMediaInfo(entry: Cloud115FileEntry) {
    setBusyAction(true);
    setError(null);
    try {
      const info = await mediaInfoService.scrape115(entry.id);
      const parts = [
        info.durationSeconds !== null ? `时长 ${formatDuration(info.durationSeconds)}` : null,
        info.width !== null && info.height !== null ? `${info.width}×${info.height}` : null,
        info.videoCodec ?? null,
        info.audioCodec !== null ? `音频 ${info.audioCodec}` : null,
      ].filter((value) => value !== null);
      setNotice(`“${entry.name}”：${parts.length > 0 ? parts.join(" · ") : "暂无可用的媒体信息"}`);
    } catch (reason) {
      setError(`读取“${entry.name}”媒体信息失败：${String(reason)}`);
    } finally {
      setBusyAction(false);
    }
  }

  /** 下载单个文件到用户选择的目录；断点续传与落盘校验由 Rust 负责。 */
  async function downloadEntry(entry: Cloud115FileEntry) {
    const targetDir = await cloud115.pickDownloadDirectory();
    if (targetDir === null) return;
    setBusyAction(true);
    setError(null);
    try {
      const result = await cloud115.downloadFile(entry.pickCode, targetDir, entry.name, entry.sizeBytes);
      setNotice(result.resumedBytes > 0
        ? `“${result.fileName}”已续传完成，保存到 ${result.savedPath}`
        : `“${result.fileName}”已下载到 ${result.savedPath}`);
    } catch (reason) {
      setError(`下载“${entry.name}”失败：${String(reason)}`);
    } finally {
      setBusyAction(false);
    }
  }

  /** 删除前必须经二次确认；115 会将普通删除项目移入回收站。 */
  async function confirmDelete() {
    if (deleteTargets.length === 0) return;
    setBusyAction(true);
    setError(null);
    try {
      await cloud115.deleteFiles(deleteTargets.map((entry) => entry.id));
      const removed = new Set(deleteTargets.map((entry) => entry.id));
      setEntries((current) => current.filter((entry) => !removed.has(entry.id)));
      setTotal((current) => Math.max(0, current - deleteTargets.length));
      setNotice(deleteTargets.length === 1
        ? `“${deleteTargets[0].name}”已移入回收站`
        : `${deleteTargets.length} 项已移入回收站`);
      setSelectedIds(new Set());
      setDeleteTargets([]);
    } catch (reason) {
      setError(`删除失败：${String(reason)}`);
    } finally {
      setBusyAction(false);
    }
  }

  // ---------------------------------------------------------------------------
  // 查重面板：扫描当前目录 → 并查集分组 → 默认勾选待删项 → 分批移入回收站。
  // 算法全部在 src/domain/duplicates.ts（纯函数）；这里只负责取数、状态与提交。
  // ---------------------------------------------------------------------------

  /**
   * 循环分页拉取当前目录的全部条目，直到 hasMore 为 false。
   *
   * 与浏览用的分页加载相互独立：查重必须看到完整目录，否则漏掉的大文件不会被发现。
   * 同一 requestSeq 参与竞态守卫，目录切换或用户取消后迟到的分页会被丢弃。
   *
   * @param folderId 目标目录 ID。
   * @param seq 本次扫描的序号；与 duplicateScanSeqRef 不一致即视为过期。
   * @returns 完整条目列表；被取消或过期时返回 null。
   * @throws 分页请求失败时向上抛错（不静默降级为部分结果）。
   */
  async function fetchAllEntriesForDuplicateScan(
    folderId: string,
    seq: number,
  ): Promise<Cloud115FileEntry[] | null> {
    const collected = new Map<string, Cloud115FileEntry>();
    let offset = 0;
    let hasMore = true;
    let total = 0;
    while (hasMore) {
      const page = await cloud115.listFiles(folderId, "", offset, DUPLICATE_SCAN_PAGE_LIMIT);
      // 迟到的分页不再属于当前扫描：直接放弃，避免把旧目录数据混进新结果。
      if (duplicateScanSeqRef.current !== seq || duplicateScanCancelRef.current) return null;
      total = page.total;
      for (const entry of page.entries) {
        // 同一文件可能被服务端在翻页边界重复返回（目录变动时），按 ID 去重。
        collected.set(entry.id, entry);
      }
      setDuplicateScanProgress({ loaded: collected.size, total });
      // 服务端给出的上限说明：超过上限立即中止，不做无界扫描。
      if (total > DUPLICATE_SCAN_MAX_ENTRIES) {
        throw new Error(
          `当前目录共 ${total} 项，超过查重上限 ${DUPLICATE_SCAN_MAX_ENTRIES} 项；请进入更小的子目录后再查重`,
        );
      }
      if (collected.size > DUPLICATE_SCAN_MAX_ENTRIES) {
        throw new Error(
          `已读取超过查重上限 ${DUPLICATE_SCAN_MAX_ENTRIES} 项，已停止扫描；请进入更小的子目录后再查重`,
        );
      }
      // 服务端声明还有下一页却返回空页：继续翻会得到同一空页。这类分页异常不能当成
      // 「目录到头」静默接受，否则查重会在不完整的数据上给出结论。
      if (page.hasMore && page.entries.length === 0) {
        throw new Error(`读取目录时服务端返回空页但声明仍有更多（偏移 ${offset}），扫描已中止，请重试`);
      }
      hasMore = page.hasMore;
      offset = page.offset + page.entries.length;
    }
    return [...collected.values()];
  }

  /**
   * 扫描当前目录并计算重复分组。
   *
   * 结果只在扫描序号仍然有效时落地；取消或切换目录后不写入任何状态。
   * 失败时写入面板级 error 并保持「无结果」，绝不伪造「未发现重复文件」。
   *
   * @param folderId 目标目录；默认取当前目录。
   */
  async function scanDuplicates(folderId: string = currentFolderId) {
    const seq = duplicateScanSeqRef.current + 1;
    duplicateScanSeqRef.current = seq;
    duplicateScanCancelRef.current = false;
    setDuplicateScanning(true);
    setDuplicateScanProgress(null);
    setDuplicateGroups(null);
    setDuplicateSelected(new Set());
    setDuplicatePanelError(null);
    setError(null);
    try {
      const allEntries = await fetchAllEntriesForDuplicateScan(folderId, seq);
      if (allEntries === null || duplicateScanSeqRef.current !== seq) return;
      const groups = findDuplicateGroups(allEntries);
      setDuplicateGroups(groups);
      setDuplicateScannedCount(allEntries.filter((entry) => entry.kind !== "folder").length);
      setDuplicateFolderId(folderId);
      setDuplicateSelected(defaultDuplicateSelectionIds(groups));
    } catch (reason) {
      if (duplicateScanSeqRef.current !== seq) return;
      // 扫描失败必须暴露：面板保持「无结果」而不是显示空结果。
      // 不写页面级 error——那个通道会把空目录的 emptyKind 误判成「文件列表读取失败」。
      setDuplicateGroups(null);
      setDuplicatePanelError(`查重扫描失败：${String(reason)}`);
    } finally {
      if (duplicateScanSeqRef.current === seq) {
        setDuplicateScanning(false);
        setDuplicateScanProgress(null);
      }
    }
  }

  /** 打开查重面板并立即开始扫描。 */
  function openDuplicatePanel() {
    setDuplicateOpen(true);
    setDuplicatePanelError(null);
    void scanDuplicates();
  }

  // 面板 / 确认框打开后把焦点交给对应的对话框：Esc 关闭与键盘操作都依赖焦点在对话框内。
  // 确认框优先：它打开时焦点从面板移入，避免 Escape 落到背后的面板上。
  useEffect(() => {
    if (duplicateConfirmOpen) {
      duplicateConfirmRef.current?.focus();
      return;
    }
    if (!duplicateOpen) return;
    duplicateDialogRef.current?.focus();
  }, [duplicateOpen, duplicateConfirmOpen]);

  /**
   * 取消扫描：作废序号让在途分页的响应被丢弃，并关闭面板。
   *
   * 面板关闭即放弃本次结果；不做「后台继续扫」的隐藏行为。
   */
  function cancelDuplicateScan() {
    duplicateScanCancelRef.current = true;
    duplicateScanSeqRef.current += 1;
    setDuplicateScanning(false);
    setDuplicateScanProgress(null);
  }

  /** 关闭查重面板：扫描中先取消，避免关闭后仍有分页回调写状态。 */
  function closeDuplicatePanel() {
    if (duplicateScanning) cancelDuplicateScan();
    setDuplicateOpen(false);
    setDuplicateGroups(null);
    setDuplicateScannedCount(0);
    setDuplicateFolderId(null);
    setDuplicateSelected(new Set());
    setDuplicatePanelError(null);
    setDuplicateConfirmOpen(false);
  }

  /**
   * 切换单项勾选；命中「整组会被删光」时拒绝并提示，保证每组至少保留 1 项。
   *
   * @param group 该条目所属的重复组。
   * @param entryId 被点击的文件 ID。
   */
  function toggleDuplicateSelected(group: DuplicateGroup, entryId: string) {
    const next = new Set(duplicateSelected);
    if (next.has(entryId)) {
      next.delete(entryId);
    } else {
      next.add(entryId);
      if (group.entries.every((entry) => next.has(entry.id))) {
        // 保持原选择不变，并明确说明原因（不静默忽略点击）。
        setDuplicatePanelError("不能把一组重复文件全部删除，每组至少需要保留 1 项。");
        return;
      }
    }
    setDuplicatePanelError(null);
    setDuplicateSelected(next);
  }

  /** 恢复默认勾选建议（干净名字优先、否则最早 mtime）。 */
  function resetDuplicateSelection() {
    if (duplicateGroups === null) return;
    setDuplicateSelected(defaultDuplicateSelectionIds(duplicateGroups));
    setDuplicatePanelError(null);
  }

  /** 打开删除确认对话框；勾选为空或会删光整组时拒绝，并说明原因。 */
  function requestDuplicateDelete() {
    if (duplicateGroups === null) return;
    if (duplicateSelected.size === 0) {
      setDuplicatePanelError("请先勾选要移入回收站的重复文件。");
      return;
    }
    const emptied = groupsFullySelected(duplicateGroups, duplicateSelected);
    if (emptied.length > 0) {
      setDuplicatePanelError(`有 ${emptied.length} 组会被全部删除，每组至少需要保留 1 项。`);
      return;
    }
    setDuplicatePanelError(null);
    setDuplicateConfirmOpen(true);
  }

  /**
   * 分批把勾选项移入回收站：100 项一批，首个失败批次即停，并如实上报已完成数量。
   *
   * 失败后仍把已确认成功的批次从分组中移除并重新计算剩余重复关系，让面板回到
   * 可继续操作的状态；用户既可以再点「移入回收站」，也可以点「重新扫描」取最新目录。
   * 失败原因与已确认成功数量一并写入面板错误提示，不做静默降级。
   */
  async function confirmDuplicateDelete() {
    if (duplicateGroups === null || duplicateSelected.size === 0) return;
    const ids = [...duplicateSelected];
    setDuplicateConfirmOpen(false);
    setDuplicateDeleting({ completed: 0, total: ids.length });
    setDuplicatePanelError(null);
    setError(null);

    const confirmedIds = new Set<string>();
    let failure: string | null = null;
    for (let index = 0; index < ids.length; index += DUPLICATE_DELETE_BATCH_SIZE) {
      const batch = ids.slice(index, index + DUPLICATE_DELETE_BATCH_SIZE);
      try {
        await cloud115.deleteFiles(batch);
      } catch (reason) {
        failure = String(reason);
        break;
      }
      for (const id of batch) confirmedIds.add(id);
      setDuplicateDeleting({ completed: confirmedIds.size, total: ids.length });
    }

    // 无论成功与否都同步本地视图：已确认删除的条目确实已不在当前目录。
    if (confirmedIds.size > 0) {
      setEntries((current) => current.filter((entry) => !confirmedIds.has(entry.id)));
      setTotal((current) => Math.max(0, current - confirmedIds.size));
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const id of confirmedIds) next.delete(id);
        return next;
      });
    }

    if (failure === null) {
      // 全部成功：关闭面板并用页面级提示收尾，避免停在「未发现重复文件」的空结果上误导用户。
      setDuplicateOpen(false);
      setDuplicateGroups(null);
      setDuplicateScannedCount(0);
      setDuplicateFolderId(null);
      setDuplicateSelected(new Set());
      setDuplicatePanelError(null);
      setNotice(`已将 ${confirmedIds.size} 个重复文件移入回收站，可在回收站还原`);
    } else {
      // 失败批次之后的条目状态未确认：保留它们，只剔除已确认成功的部分。
      const remainingGroups = removeDeletedEntriesFromGroups(duplicateGroups, confirmedIds);
      // 分组重算后可能整组消失（只剩 1 项就不再是重复组）。勾选集必须同步收敛到
      // 「仍在某个重复组里」的条目，否则重试会把已不再重复的文件当成重复项删掉。
      const liveIds = new Set(remainingGroups.flatMap((group) => group.entries.map((entry) => entry.id)));
      setDuplicateGroups(remainingGroups);
      // 参与比对的件数同步扣减，避免计数包含已被确认删除的项。
      setDuplicateScannedCount((current) => Math.max(0, current - confirmedIds.size));
      setDuplicateSelected((current) => new Set([...current].filter((id) => liveIds.has(id))));
      setDuplicatePanelError(
        confirmedIds.size > 0
          ? `已成功移入回收站 ${confirmedIds.size} / ${ids.length} 项；后续批次失败：${failure}`
          : `删除失败，未确认任何项目被移入回收站：${failure}`,
      );
    }
    setDuplicateDeleting(null);
  }

  /** 打开目标文件夹选择器；条目来自批量选择集或菜单单条，目标冲突由 Rust 校验。 */
  function openPicker(mode: "move" | "copy", entryIds?: string[]) {
    const ids = entryIds ?? selectedEntries.map((entry) => entry.id);
    if (ids.length === 0) return;
    const initial: FolderPicker = { mode, path: [{ id: ROOT_ID, name: "115 网盘" }], entries: [], loading: true, ids };
    setPicker(initial);
    void loadPickerFolders(initial.path[0].id);
  }

  async function loadPickerFolders(folderId: string) {
    setError(null);
    try {
      const page = await cloud115.listFiles(folderId, "", 0, PAGE_LIMIT);
      setPicker((current) => current ? { ...current, entries: page.entries.filter((entry) => entry.kind === "folder"), loading: false } : current);
    } catch (reason) {
      setPicker((current) => current ? { ...current, entries: [], loading: false } : current);
      setError(`读取目标文件夹失败：${String(reason)}`);
    }
  }

  function enterPickerFolder(entry: Cloud115FileEntry) {
    if (!picker || entry.kind !== "folder") return;
    const nextPath = [...picker.path, { id: entry.id, name: entry.name }];
    setPicker({ ...picker, path: nextPath, entries: [], loading: true });
    void loadPickerFolders(entry.id);
  }

  function navigatePicker(index: number) {
    if (!picker) return;
    const nextPath = picker.path.slice(0, index + 1);
    setPicker({ ...picker, path: nextPath, entries: [], loading: true });
    void loadPickerFolders(nextPath[nextPath.length - 1].id);
  }

  /** 提交批量移动或复制；同名冲突与非法目标由 Rust 策略拒绝。 */
  async function confirmPicker() {
    if (!picker) return;
    // 与批量删除同源口径：只提交打开选择器时确认存在的条目。
    const ids = picker.ids;
    if (ids.length === 0) return;
    const target = picker.path[picker.path.length - 1];
    setBusyAction(true);
    setError(null);
    try {
      if (picker.mode === "move") {
        await cloud115.moveFiles(ids, target.id);
      } else {
        await cloud115.copyFiles(ids, target.id, false);
      }
      rememberRecentTarget(picker.path);
      setNotice(picker.mode === "move"
        ? `已移动 ${ids.length} 项到“${target.name}”`
        : `已复制 ${ids.length} 项到“${target.name}”`);
      setSelectedIds(new Set());
      setPicker(null);
      setReloadNonce((nonce) => nonce + 1);
    } catch (reason) {
      setError(`${picker.mode === "move" ? "移动" : "复制"}失败：${String(reason)}`);
    } finally {
      setBusyAction(false);
    }
  }

  /** 记录最近使用的目标目录：去重后保留最近 5 个，含完整路径供直达与展示。 */
  function rememberRecentTarget(targetPath: FolderPick[]) {
    const target = targetPath[targetPath.length - 1];
    setRecentTargets((current) => {
      const next = [
        { id: target.id, name: target.name, path: targetPath },
        ...current.filter((item) => item.id !== target.id),
      ].slice(0, 5);
      try {
        window.localStorage.setItem(RECENT_TARGETS_KEY, JSON.stringify(next));
      } catch {
        // 存储不可用时仅本次会话生效。
      }
      return next;
    });
  }

  /** 从「最近使用」直达目标目录；目录已不存在时由列表加载如实报错。 */
  function jumpToRecentTarget(recent: RecentTarget) {
    if (!picker) return;
    setPicker({ ...picker, path: recent.path, entries: [], loading: true });
    void loadPickerFolders(recent.id);
  }

  /** 新建文件夹：115 校验同名冲突，成功后刷新当前目录。 */
  async function submitNewFolder() {
    const name = newFolderName.trim();
    if (!name) {
      setError("文件夹名称不能为空");
      return;
    }
    setBusyAction(true);
    setError(null);
    try {
      const folder = await cloud115.createFolder(currentFolderId, name);
      setNotice(`已创建文件夹“${folder.name}”`);
      setNewFolderOpen(false);
      setNewFolderName("");
      setReloadNonce((nonce) => nonce + 1);
    } catch (reason) {
      setError(`新建文件夹失败：${String(reason)}`);
    } finally {
      setBusyAction(false);
    }
  }

  // ---------------------------------------------------------------------------
  // 统一浮层菜单：右键、行尾更多、排序共用；关闭时把焦点送回触发位置。
  // ---------------------------------------------------------------------------

  function openPaneMenu(
    entry: Cloud115FileEntry | null,
    x: number,
    y: number,
    restoreTo: HTMLElement | null,
    pageMenu: "view" | "sort" = "sort",
  ) {
    setPaneMenu({ entry, pageMenu, x, y, restoreTo });
  }

  function closePaneMenu() {
    const restoreTo = paneMenu?.restoreTo ?? null;
    setPaneMenu(null);
    if (restoreTo) {
      window.requestAnimationFrame(() => {
        // 重命名等对话框承接焦点时不抢占；仅在菜单直接关闭时送回触发位置。
        if (document.activeElement === document.body && document.contains(restoreTo)) {
          restoreTo.focus({ preventScroll: true });
        }
      });
    }
  }

  /** 单条目菜单：按类型显隐；说明与行为一一对应，不发明能力。 */
  function buildFileMenuItems(entry: Cloud115FileEntry): FileMenuItem[] {
    const close = () => closePaneMenu();
    const items: FileMenuItem[] = [];
    if (entry.kind === "folder") {
      items.push({ id: "open", label: "打开", icon: "chevron", hint: "进入此文件夹", onSelect: () => { close(); void openFolder(entry); } });
    } else if (entry.kind === "video") {
      items.push({ id: "play", label: "播放", icon: "play", hint: "用内置播放器播放", onSelect: () => { close(); void playEntry(entry); } });
    } else if (entry.kind === "image") {
      // 图片的「查看」直接复用双击行为：同一份清单、同一套竞态与回退逻辑。
      // 不在这里调 close()：openImagePreview 内部会先收起菜单，避免两次关闭互相覆盖焦点。
      items.push({ id: "preview", label: "查看", icon: "images", hint: "打开大图预览", onSelect: () => openImagePreview(entry) });
    }
    if (entry.kind !== "folder") {
      items.push({ id: "download", label: "下载", icon: "download", onSelect: () => { close(); void downloadEntry(entry); } });
    }
    if (entry.kind === "video") {
      items.push({ id: "media-info", label: "媒体信息", icon: "play", hint: "读取时长与编码信息", onSelect: () => { close(); void scrapeMediaInfo(entry); } });
    }
    items.push(
      { kind: "separator", id: "sep-organize" },
      // 收藏视图里的条目必然已收藏，此时菜单只能是「取消收藏」，不提供重复收藏。
      starredView
        ? { id: "unfavorite", label: "取消收藏", icon: "star", disabled: busyAction, onSelect: () => { close(); void favoriteEntry(entry, false); } }
        : { id: "favorite", label: "收藏", icon: "star", disabled: busyAction, onSelect: () => { close(); void favoriteEntry(entry, true); } },
      { id: "rename", label: "重命名", icon: "edit", disabled: busyAction, onSelect: () => { close(); setRenameEntry(entry); setRenameValue(entry.name); } },
      { id: "move", label: "移动…", icon: "chevron", disabled: busyAction, hint: "移动到其他文件夹", onSelect: () => { close(); openPicker("move", [entry.id]); } },
      { id: "copy", label: "复制…", icon: "more", disabled: busyAction, hint: "复制到其他文件夹", onSelect: () => { close(); openPicker("copy", [entry.id]); } },
      { kind: "separator", id: "sep-danger" },
      { id: "delete", label: "删除", icon: "trash", danger: true, disabled: busyAction, hint: "移入回收站，可还原", onSelect: () => { close(); setDeleteTargets([entry]); } },
    );
    return items;
  }

  /** 排序菜单：与列头共用同一状态；口径注明只作用于已加载项。 */
  function buildSortMenuItems(): FileMenuItem[] {
    const close = () => closePaneMenu();
    return [
      ...(Object.keys(SORT_FIELD_LABELS) as SortField[]).map((field): FileMenuItem => ({
        id: `sort-field-${field}`,
        label: SORT_FIELD_LABELS[field],
        checked: sort.field === field,
        onSelect: () => { close(); setSort((current) => ({ ...current, field })); },
      })),
      { kind: "separator", id: "sort-order-sep" },
      { id: "sort-order-asc", label: "升序", checked: sort.order === "asc", onSelect: () => { close(); setSort((current) => ({ ...current, order: "asc" })); } },
      { id: "sort-order-desc", label: "降序", checked: sort.order === "desc", onSelect: () => { close(); setSort((current) => ({ ...current, order: "desc" })); } },
    ];
  }

  /**
   * 视图菜单：把视图模式、显示密度与排序合并到一个入口。
   *
   * 文件页工具栏原本是两行（路径/筛选 + 操作按钮），视图、密度、排序三个控件占了
   * 第一行近一半宽度。合并成单个菜单后，第一行只保留面包屑、类型筛选与操作按钮。
   */
  function buildViewMenuItems(): FileMenuItem[] {
    const close = () => closePaneMenu();
    return [
      { id: "view-list", label: "列表视图", checked: viewMode === "list", onSelect: () => { close(); switchViewMode("list"); } },
      { id: "view-grid", label: "网格视图", checked: viewMode === "grid", onSelect: () => { close(); switchViewMode("grid"); } },
      { kind: "separator", id: "view-density-sep" },
      { id: "density-comfortable", label: "舒适密度", checked: density === "comfortable", onSelect: () => { close(); setDensity("comfortable"); } },
      { id: "density-compact", label: "紧凑密度", checked: density === "compact", onSelect: () => { close(); setDensity("compact"); } },
      { kind: "separator", id: "view-sort-sep" },
      ...buildSortMenuItems().filter((item) => item.kind !== "separator"),
    ];
  }

  /** 切换排序字段：同字段再点翻转方向，新字段默认升序；作用范围是已加载项。 */
  function toggleSortField(field: SortField) {
    setSort((current) => current.field === field
      ? { ...current, order: current.order === "asc" ? "desc" : "asc" }
      : { field, order: "asc" });
  }

  // ---------------------------------------------------------------------------
  // 行级选择与键盘：列表行与网格卡片共用同一套处理器。
  // ---------------------------------------------------------------------------

  /** 行单击选择：⌘/Ctrl 增选取消、Shift 连选、普通单击单选；行内控件不参与。 */
  function handleRowPointerSelect(entry: Cloud115FileEntry, event: React.MouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("input,button")) return;
    if (event.metaKey || event.ctrlKey) {
      toggleSelectWithAnchor(entry);
    } else if (event.shiftKey) {
      selectRangeTo(entry);
    } else {
      selectOnly(entry);
    }
  }

  /** 点击行与卡片之外的空白处：取消选择。 */
  function handleContainerBlankClick(event: React.MouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("[data-entry-id]") || target.closest(".file-table-head")) return;
    clearSelection();
  }

  /**
   * 行级键盘矩阵（列表行与网格卡片共用）：
   * 方向键/Home/End 移动焦点与选择（Shift 扩展连选），Enter/空格执行主打开动作，
   * Esc 清理临时选择，⌘/Ctrl+A 全选可见项，菜单键/Shift+F10 打开右键菜单。
   */
  function handleRowKeyDown(entry: Cloud115FileEntry, event: React.KeyboardEvent<HTMLElement>) {
    const row = event.currentTarget;
    const container = row.parentElement;
    if (!container) return;
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-entry-id]"));
    const index = rows.indexOf(row);
    const focusAndSelect = (nextIndex: number, extend: boolean) => {
      const nextRow = rows[nextIndex];
      const nextId = nextRow?.dataset.entryId;
      const nextEntry = nextId ? entries.find((item) => item.id === nextId) : undefined;
      if (!nextRow || !nextEntry) return;
      nextRow.focus();
      if (extend) {
        selectRangeTo(nextEntry);
      } else {
        selectOnly(nextEntry);
      }
    };
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const nextIndex = event.key === "ArrowDown" ? Math.min(index + 1, rows.length - 1)
        : event.key === "ArrowUp" ? Math.max(index - 1, 0)
          : event.key === "Home" ? 0 : rows.length - 1;
      focusAndSelect(nextIndex, event.shiftKey);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && event.target === row) {
      event.preventDefault();
      openEntryPrimary(entry, row);
      return;
    }
    if (event.key === "Escape") {
      event.stopPropagation();
      clearSelection();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelectedIds(new Set(visibleEntries.map((item) => item.id)));
      return;
    }
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      openPaneMenu(entry, rect.left + rect.width / 2, rect.bottom + 4, row);
    }
  }

  /** 更多操作按钮：与右键共用同一菜单组件。 */
  function toggleRowMenu(entry: Cloud115FileEntry, button: HTMLElement) {
    if (paneMenu?.entry?.id === entry.id) {
      closePaneMenu();
      return;
    }
    const rect = button.getBoundingClientRect();
    openPaneMenu(entry, rect.right, rect.bottom + 4, button);
  }

  /** 面板级 Escape：清理临时选择状态；菜单与行内的 Esc 由各自处理器收容。 */
  function handlePaneKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") return;
    const target = event.target as HTMLElement;
    // 输入框内不劫持 Esc；行级清理由行键盘处理器完成（那里会 stopPropagation）。
    if (target.closest("input, textarea")) return;
    if (selectedIds.size > 0) {
      event.stopPropagation();
      clearSelection();
    }
  }

  /** 空状态分类：按「读取失败 → 搜索 → 筛选 → 真空目录/空收藏」的优先级归类，文案不发明数据。 */
  const emptyKind: FileEmptyKind | null = loading || visibleEntries.length > 0 ? null
    : entries.length === 0 && error ? "load-error"
      : query.trim() || filter !== "all" ? "no-results"
        : starredView ? "starred-empty"
          : "directory-empty";

  /**
   * 空态里的「新建文件夹」入口。
   *
   * 收藏是跨目录视图，没有可作用的父目录：这里不提供入口，否则会以进入收藏前的目录
   * 为目标创建，用户在当前视图看不到任何结果。
   */
  const emptyStateNewFolder = starredView
    ? undefined
    : () => {
      setNewFolderName("");
      setNewFolderOpen(true);
    };

  /** 计数口径说明：明确「已加载」边界，排序与批量操作都不作用于未加载分页。 */
  const loadedCountLabel = loading
    ? "正在读取…"
    : refreshing
      ? "正在刷新…"
      : filter === "all"
        ? `已加载 ${entries.length} / ${total} 项`
        : `已加载 ${entries.length} / ${total} 项 · 筛选命中 ${visibleEntries.length} 项`;

  if (!account?.connected) {
    return (
      <section className="page-section cloud-auth-state">
        <Icon name="cloud" size={22} />
        <span>登录后查看 115 网盘文件</span>
        <button className="primary-action" onClick={onRequireLogin}>扫码登录</button>
      </section>
    );
  }

  const thumbSize = density === "compact" ? 26 : 32;
  const gridThumbSize = density === "compact" ? 52 : 64;

  return (
    <section className="page-section cloud-files-view" ref={dropZoneRef} data-drag-active={dragActive ? "true" : "false"}>
      {dragActive && (
        <div className="cloud-drop-overlay" role="status" aria-live="polite">
          <div className="cloud-drop-card">
            <Icon name="upload" size={26} />
            <strong>松开即可上传</strong>
            <span>文件与文件夹都会上传到“{path[path.length - 1].name}”，目录结构保持不变。</span>
          </div>
        </div>
      )}
      {error && <div className="cloud-inline-error" role="alert">{error}</div>}
      {notice && <div className="cloud-action-notice" role="status"><Icon name="check" size={14} />{notice}<button aria-label="关闭提示" onClick={() => setNotice(null)}><Icon name="close" size={13} /></button></div>}

      <div className="cloud-file-pane" data-density={density} data-view={viewMode} onKeyDown={handlePaneKeyDown}>
          {activeDownload && (
            <div
              className="cloud-transfer-progress"
              role="status"
              aria-label="下载进度"
              style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, opacity: 0.75, padding: "0 4px" }}
            >
              <Icon name="download" size={14} />
              <strong title={activeDownload.fileName} style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 280 }}>
                {activeDownload.fileName}
              </strong>
              <span style={{ whiteSpace: "nowrap" }}>
                {formatTransferBytes(activeDownload.transferredBytes ?? 0)}
                {activeDownload.totalBytes ? ` / ${formatTransferBytes(activeDownload.totalBytes)}` : ""}
                {activeDownload.speedBytesPerSec ? ` · ${formatTransferBytes(activeDownload.speedBytesPerSec)}/s` : ""}
              </span>
            </div>
          )}

          {pendingSessions.length > 0 && (
            <div className="upload-resume-bar" role="status">
              <Icon name="history" size={16} />
              <span>未完成的上传（{pendingSessions.length}）</span>
              <div>
                {pendingSessions.map((session) => (
                  <span className="upload-resume-item" key={session.id}>
                    <strong title={session.localPath}>{session.fileName}</strong>
                    <small>{formatBytes(session.fileSize)} · 已传 {session.completedParts.length} 片</small>
                    <button disabled={resumingId !== null || uploading !== null} onClick={() => void resumeUploadSession(session)}>
                      {resumingId === session.id ? "恢复中" : "恢复"}
                    </button>
                    <button aria-label={`忽略${session.fileName}`} onClick={() => setDismissedSessions((current) => new Set(current).add(session.id))}>
                      <Icon name="close" size={12} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 搜索已上移顶栏；工具区保持「路径/筛选行 → 列头 → 内容」稳定节奏。 */}
          <div className="file-filter-row">
            <nav className="file-breadcrumbs" aria-label="当前网盘路径">
              {starredView ? (
                // 收藏是全账号视图，展示真实路径会误导成「在某个目录内」，只标注范围。
                <span><button className="active" onClick={() => setStarredView(false)}>全账号收藏</button></span>
              ) : path.map((item, index) => (
                <span key={item.id}>
                  {index > 0 && <Icon name="chevron" size={13} />}
                  <button className={index === path.length - 1 ? "active" : ""} onClick={() => navigateToPath(index)}>{item.name}</button>
                </span>
              ))}
            </nav>
                {/* 账号与加载进度属于路径上下文：放在面包屑一侧，避免挤占筛选与操作的空间。 */}
                <span className="cloud-path-meta">
                  <span className="cloud-account-badge" title={`115 账号：${account.userName ?? "已连接"}`}>
                    <i aria-hidden="true" />
                    {account.userName ?? "115 已连接"}
                  </span>
                  <span className="cloud-loaded-count">{loadedCountLabel}</span>
                </span>
                <div className="cloud-filter-options">
                  {/* 搜索范围：仅在目录内搜索激活时出现。当前目录 / 全账号是 115 的两种真实
                      语义，不把「全账号」伪装成筛选。收藏视图不参与关键词搜索，故不渲染。 */}
                  {query.trim() !== "" && !starredView && (
                    <div className="segmented-control cloud-scope-toggle" role="group" aria-label="搜索范围">
                      <button
                        className={searchScope === "current" ? "active" : ""}
                        aria-pressed={searchScope === "current"}
                        onClick={() => setSearchScope("current")}
                      >
                        当前目录
                      </button>
                      <button
                        className={searchScope === "global" ? "active" : ""}
                        aria-pressed={searchScope === "global"}
                        onClick={() => setSearchScope("global")}
                      >
                        全账号
                      </button>
                    </div>
                  )}
                  {/* 类型筛选：只作用于已加载项，与排序/查重同一口径，不触发重新请求。 */}
                  <div className="segmented-control cloud-type-filter" role="group" aria-label="按类型筛选">
                    {FILE_FILTERS.map((option) => (
                      <button
                        key={option.id}
                        className={filter === option.id ? "active" : ""}
                        aria-pressed={filter === option.id}
                        onClick={() => setFilter(option.id)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  {/* 视图/密度/排序合并为单入口：工具栏只占一行，把宽度让给面包屑与操作按钮。
                      当前值直接写在按钮上，收起后仍能看出状态，不需要展开菜单确认。 */}
                  <div className="cloud-view-menu-control">
                    <button
                      className="cloud-view-menu-button"
                      aria-haspopup="menu"
                      aria-expanded={paneMenu !== null && paneMenu.entry === null && paneMenu.pageMenu === "view"}
                      title={`视图：${viewMode === "list" ? "列表" : "网格"} · ${density === "compact" ? "紧凑" : "舒适"} · 排序：${SORT_FIELD_LABELS[sort.field]} ${sort.order === "asc" ? "升序" : "降序"}（仅作用于已加载的 ${entries.length} 项）`}
                      onClick={(event) => {
                        const button = event.currentTarget;
                        if (paneMenu !== null && paneMenu.entry === null && paneMenu.pageMenu === "view") {
                          closePaneMenu();
                          return;
                        }
                        const rect = button.getBoundingClientRect();
                        openPaneMenu(null, rect.right, rect.bottom + 4, button, "view");
                      }}
                    >
                      <Icon name={viewMode === "list" ? "tasks" : "library"} size={15} />
                      <span className="cloud-view-menu-label">
                        {SORT_FIELD_LABELS[sort.field]} {sort.order === "asc" ? "升序" : "降序"}
                      </span>
                      <span className="cloud-view-menu-caret" aria-hidden="true"><Icon name="chevron" size={12} /></span>
                    </button>
                  </div>
                </div>
                <div className="cloud-toolbar-actions">
                  <button
                    className="secondary-action cloud-dedupe-action"
                    title={starredView ? "查重只在单个目录内生效，请先返回目录" : "扫描当前目录，找出同名或内容相同的文件"}
                    disabled={starredView}
                    onClick={openDuplicatePanel}
                  >
                    <Icon name="tasks" size={15} />
                    查重
                  </button>
                  <button
                    className="secondary-action cloud-newfolder-action"
                    title={starredView ? "收藏是跨目录视图，请先返回目录再新建文件夹" : "在当前目录新建文件夹"}
                    disabled={starredView}
                    onClick={() => {
                      setNewFolderName("");
                      setNewFolderOpen(true);
                    }}
                  >
                    <Icon name="plus" size={15} />
                    新建文件夹
                  </button>
                  <button
                    className="primary-action cloud-upload-action"
                    disabled={uploading !== null || starredView}
                    title={uploading ? uploadStageLabel(uploading, activeUpload) : "上传文件到当前目录"}
                    onClick={() => void startUpload()}
                  >
                    <Icon name="upload" size={16} />
                    {uploading ? uploadStageLabel(uploading, activeUpload) : "上传文件"}
                  </button>
                  <button
                    className="cloud-starred-button"
                    title={starredView ? "返回当前目录" : "查看全账号收藏"}
                    aria-label={starredView ? "返回当前目录" : "查看收藏"}
                    aria-pressed={starredView}
                    onClick={() => {
                      setStarredView((current) => {
                        const next = !current;
                        // 搜索只作用于目录内结果；进出收藏时清空关键词，避免留下一个
                        // 对当前视图无效、却仍在驱动请求与空态文案的搜索词。
                        if (next) onQueryChange("");
                        return next;
                      });
                      clearSelection();
                    }}
                  >
                    <Icon name="star" size={15} />
                    {starredView ? "返回目录" : "收藏"}
                  </button>
                </div>
          </div>

          {selectedIds.size > 0 && (
            <div className="file-batch-bar" role="toolbar" aria-label="批量操作">
              <span>已选 {selectedIds.size} 项</span>
              <div>
                <button disabled={busyAction || selectedEntries.length === 0} onClick={() => openPicker("move")}>移动</button>
                <button disabled={busyAction || selectedEntries.length === 0} onClick={() => openPicker("copy")}>复制</button>
                <button className="danger" disabled={busyAction || selectedEntries.length === 0} onClick={() => {
                  if (selectedEntries.length > 0) setDeleteTargets(selectedEntries);
                }}>删除</button>
                <button disabled={busyAction} onClick={clearSelection}>取消选择</button>
              </div>
            </div>
          )}

          {viewMode === "list" ? (
            <div
              className="file-table"
              role="table"
              aria-label="网盘文件"
              data-refreshing={refreshing ? "true" : "false"}
              aria-busy={refreshing}
              onClick={handleContainerBlankClick}
            >
              {refreshing && <div className="file-refresh-bar" role="status" aria-label="正在刷新文件列表" />}
              <div className="file-table-head" role="row">
                <input
                  type="checkbox"
                  className="file-check"
                  aria-label="选择全部可见文件"
                  checked={allVisibleSelected}
                  onChange={toggleAllVisible}
                />
                <button
                  role="columnheader"
                  className={`file-sort-header${sort.field === "name" ? " active" : ""}`}
                  aria-sort={sort.field === "name" ? (sort.order === "asc" ? "ascending" : "descending") : "none"}
                  onClick={() => toggleSortField("name")}
                >
                  名称{sort.field === "name" && <span className="file-sort-arrow" data-order={sort.order} aria-hidden="true"><Icon name="chevron" size={12} /></span>}
                </button>
                <span role="columnheader">类型</span>
                <button
                  role="columnheader"
                  className={`file-sort-header${sort.field === "size" ? " active" : ""}`}
                  aria-sort={sort.field === "size" ? (sort.order === "asc" ? "ascending" : "descending") : "none"}
                  onClick={() => toggleSortField("size")}
                >
                  大小{sort.field === "size" && <span className="file-sort-arrow" data-order={sort.order} aria-hidden="true"><Icon name="chevron" size={12} /></span>}
                </button>
                <button
                  role="columnheader"
                  className={`file-sort-header${sort.field === "modifiedAt" ? " active" : ""}`}
                  aria-sort={sort.field === "modifiedAt" ? (sort.order === "asc" ? "ascending" : "descending") : "none"}
                  onClick={() => toggleSortField("modifiedAt")}
                >
                  修改时间{sort.field === "modifiedAt" && <span className="file-sort-arrow" data-order={sort.order} aria-hidden="true"><Icon name="chevron" size={12} /></span>}
                </button>
                <span aria-hidden="true" />
              </div>
              {loading ? <FileLoadingLabel /> : visibleEntries.length > 0 ? visibleEntries.map((entry, index) => {
                const presentation = getFilePresentation(entry);
                const longName = entry.kind === "folder" ? null : splitLongName(entry.name);
                const selected = selectedIds.has(entry.id);
                return (
                  <div
                    className={`file-row${selected ? " selected" : ""}`}
                    role="row"
                    aria-selected={selected}
                    key={entry.id}
                    data-entry-id={entry.id}
                    tabIndex={activeRowId === entry.id || (activeRowId === null && index === 0) ? 0 : -1}
                    onClick={(event) => handleRowPointerSelect(entry, event)}
                    onDoubleClick={(event) => openEntryPrimary(entry, event.currentTarget)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      openPaneMenu(entry, event.clientX, event.clientY, event.currentTarget);
                    }}
                    onKeyDown={(event) => handleRowKeyDown(entry, event)}
                    onFocus={(event) => {
                      if (event.target === event.currentTarget) setActiveRowId(entry.id);
                    }}
                  >
                    <input
                      type="checkbox"
                      className="file-check"
                      aria-label={`选择 ${entry.name}`}
                      checked={selected}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => toggleSelectWithAnchor(entry)}
                    />
                    <button
                      className="file-name"
                      aria-disabled={entry.kind !== "folder" && entry.kind !== "video" && entry.kind !== "image"}
                      title={entry.kind === "folder" ? "打开文件夹" : entry.kind === "video" ? "播放视频" : entry.kind === "image" ? "查看大图" : undefined}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (entry.kind !== "folder" && entry.kind !== "video" && entry.kind !== "image") return;
                        selectOnly(entry);
                        const row = event.currentTarget.closest<HTMLElement>("[data-entry-id]");
                        openEntryPrimary(entry, row);
                      }}
                    >
                      <FileThumbnail
                        kind={presentation.kind}
                        src={entry.kind === "folder" ? null : entry.thumbUrl}
                        size={thumbSize}
                      />
                      <span>
                        {longName ? (
                          <strong className="file-name-split" title={entry.name}>
                            <span className="file-name-head">{longName.head}</span>
                            {longName.tail && <span className="file-name-tail">{longName.tail}</span>}
                          </strong>
                        ) : (
                          <strong title={entry.name}>{entry.name}</strong>
                        )}
                        {entry.children !== null && <small>{entry.children} 个项目</small>}
                      </span>
                    </button>
                    <span className="file-kind-label">{presentation.label}</span>
                    <span className="file-size">{formatBytes(entry.sizeBytes)}</span>
                    <time>{formatModifiedAt(entry.modifiedAt)}</time>
                    <div className="file-row-actions">
                      {entry.kind === "video" && <button className="file-play" disabled={playingId === entry.id} onClick={(event) => { event.stopPropagation(); void playEntry(entry); }}><Icon name="play" size={14} />{playingId === entry.id ? "解析中" : "播放"}</button>}
                      {entry.kind === "folder" && <button className="file-open" onClick={(event) => { event.stopPropagation(); void openFolder(entry); }} aria-label={`打开${entry.name}`}><Icon name="chevron" size={16} /></button>}
                      <button
                        className="file-more"
                        aria-label={`${entry.name}的更多操作`}
                        aria-haspopup="menu"
                        aria-expanded={paneMenu?.entry?.id === entry.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleRowMenu(entry, event.currentTarget);
                        }}
                      >
                        <Icon name="more" size={16} />
                      </button>
                    </div>
                  </div>
                );
              }) : emptyKind && (
                <FileEmptyState
                  kind={emptyKind}
                  errorText={error}
                  hasQuery={query.trim() !== ""}
                  hasFilter={filter !== "all"}
                  onClearQuery={() => onQueryChange("")}
                  onClearFilter={() => setFilter("all")}
                  onRetry={() => {
                    setError(null);
                    setReloadNonce((nonce) => nonce + 1);
                  }}
                  onNewFolder={emptyStateNewFolder}
                />
              )}
            </div>
          ) : (
            <div
              className="file-grid"
              role="listbox"
              aria-multiselectable="true"
              aria-label="网盘文件网格"
              data-refreshing={refreshing ? "true" : "false"}
              aria-busy={refreshing}
              onClick={handleContainerBlankClick}
            >
              {refreshing && <div className="file-refresh-bar" role="status" aria-label="正在刷新文件列表" />}
              {loading ? <FileLoadingLabel compact /> : visibleEntries.length > 0 ? visibleEntries.map((entry, index) => {
                const presentation = getFilePresentation(entry);
                const selected = selectedIds.has(entry.id);
                return (
                  <div
                    key={entry.id}
                    role="option"
                    aria-selected={selected}
                    className={`file-grid-card${selected ? " selected" : ""}`}
                    data-entry-id={entry.id}
                    tabIndex={activeRowId === entry.id || (activeRowId === null && index === 0) ? 0 : -1}
                    onClick={(event) => handleRowPointerSelect(entry, event)}
                    onDoubleClick={(event) => openEntryPrimary(entry, event.currentTarget)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      openPaneMenu(entry, event.clientX, event.clientY, event.currentTarget);
                    }}
                    onKeyDown={(event) => handleRowKeyDown(entry, event)}
                    onFocus={(event) => {
                      if (event.target === event.currentTarget) setActiveRowId(entry.id);
                    }}
                  >
                    <span className="file-grid-thumb">
                      <FileThumbnail
                        kind={presentation.kind}
                        src={entry.kind === "folder" ? null : entry.thumbUrl}
                        size={gridThumbSize}
                      />
                      {entry.kind === "video" && <span className="file-grid-badge" aria-hidden="true"><Icon name="play" size={12} /></span>}
                    </span>
                    <input
                      type="checkbox"
                      className="file-check file-grid-check"
                      aria-label={`选择 ${entry.name}`}
                      checked={selected}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => toggleSelectWithAnchor(entry)}
                    />
                    <span className="file-grid-name" title={entry.name}>{entry.name}</span>
                    <span className="file-grid-meta">
                      {entry.kind === "folder"
                        ? `${presentation.label}${entry.children !== null ? ` · ${entry.children} 个项目` : ""}`
                        : `${presentation.label} · ${formatBytes(entry.sizeBytes)}`}
                    </span>
                    <div className="file-grid-actions">
                      <button
                        className="file-more"
                        aria-label={`${entry.name}的更多操作`}
                        aria-haspopup="menu"
                        aria-expanded={paneMenu?.entry?.id === entry.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleRowMenu(entry, event.currentTarget);
                        }}
                      >
                        <Icon name="more" size={15} />
                      </button>
                    </div>
                  </div>
                );
              }) : emptyKind && (
                <FileEmptyState
                  kind={emptyKind}
                  errorText={error}
                  hasQuery={query.trim() !== ""}
                  hasFilter={filter !== "all"}
                  onClearQuery={() => onQueryChange("")}
                  onClearFilter={() => setFilter("all")}
                  onRetry={() => {
                    setError(null);
                    setReloadNonce((nonce) => nonce + 1);
                  }}
                  onNewFolder={emptyStateNewFolder}
                />
              )}
            </div>
          )}
          {/* 哨兵：滚到这里即自动续页；仅在仍有下一页时挂载，避免无数据时常驻占位。 */}
          {hasMore && (
            <div className="cloud-load-sentinel" ref={loadMoreSentinelRef}>
              {loadingMore && <span>正在加载…</span>}
            </div>
          )}

      </div>

      {lightbox && (
        <ImageLightbox
          items={lightbox.items}
          initialIndex={lightbox.index}
          onClose={() => setLightbox(null)}
        />
      )}

      {paneMenu && (
        <FileContextMenu
          x={paneMenu.x}
          y={paneMenu.y}
          items={
            paneMenu.entry
              ? buildFileMenuItems(paneMenu.entry)
              : paneMenu.pageMenu === "view"
                ? buildViewMenuItems()
                : buildSortMenuItems()
          }
          note={paneMenu.entry ? undefined : `排序仅对已加载的 ${entries.length} 项生效`}
          label={
            paneMenu.entry
              ? `${paneMenu.entry.name}的操作菜单`
              : paneMenu.pageMenu === "view"
                ? "视图与排序"
                : "排序方式"
          }
          onClose={closePaneMenu}
        />
      )}

      {renameEntry && <div className="cloud-operation-backdrop" onPointerDown={(event) => event.target === event.currentTarget && !busyAction && setRenameEntry(null)}><form className="cloud-operation-dialog" onSubmit={(event) => { event.preventDefault(); void submitRename(); }}><strong>重命名</strong><span>为“{renameEntry.name}”输入新名称</span><input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.currentTarget.value)} /><div><button type="button" className="secondary-action" disabled={busyAction} onClick={() => setRenameEntry(null)}>取消</button><button type="submit" className="primary-action" disabled={busyAction || !renameValue.trim()}>保存</button></div></form></div>}
      {newFolderOpen && <div className="cloud-operation-backdrop" onPointerDown={(event) => event.target === event.currentTarget && !busyAction && setNewFolderOpen(false)}><form className="cloud-operation-dialog" onSubmit={(event) => { event.preventDefault(); void submitNewFolder(); }}><strong>新建文件夹</strong><span>在“{path[path.length - 1].name}”中创建；同名冲突由 115 校验。</span><input autoFocus placeholder="文件夹名称" value={newFolderName} onChange={(event) => setNewFolderName(event.currentTarget.value)} /><div><button type="button" className="secondary-action" disabled={busyAction} onClick={() => setNewFolderOpen(false)}>取消</button><button type="submit" className="primary-action" disabled={busyAction || !newFolderName.trim()}>创建</button></div></form></div>}
      {deleteTargets.length > 0 && <div className="cloud-operation-backdrop" onPointerDown={(event) => event.target === event.currentTarget && !busyAction && setDeleteTargets([])}><section className="cloud-operation-dialog"><strong>{deleteTargets.length === 1 ? "移入回收站？" : `移入回收站 ${deleteTargets.length} 项？`}</strong><span>{describeTargets(deleteTargets)}将从当前目录移除，可稍后在回收站恢复。</span><div><button className="secondary-action" disabled={busyAction} onClick={() => setDeleteTargets([])}>取消</button><button className="danger-action" disabled={busyAction} onClick={() => void confirmDelete()}>{busyAction ? "正在删除" : "删除"}</button></div></section></div>}
      {duplicateOpen && (
        <div className="cloud-operation-backdrop" onPointerDown={(event) => {
          // 删除进行中不允许点击遮罩关闭，避免中途丢失进度反馈。
          if (event.target === event.currentTarget && duplicateDeleting === null) closeDuplicatePanel();
        }}>
          <section
            ref={duplicateDialogRef}
            tabIndex={-1}
            className="cloud-operation-dialog dedupe-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="查找重复文件"
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              // 删除进行中不响应 Escape：中途关闭会丢失「已删除 N / M」的进度反馈。
              if (duplicateDeleting !== null) return;
              event.stopPropagation();
              closeDuplicatePanel();
            }}
          >
            <strong>查找重复文件</strong>
            <span className="dedupe-subtitle">
              扫描“{path[path.length - 1].name}”当前目录（不含子目录，忽略搜索与类型筛选）：文件名完全相同，
              或 SHA1 与文件大小完全相同，都会被归为重复。
            </span>

            <div className="dedupe-toolbar">
              {duplicateScanning ? (
                <>
                  <span role="status">
                    正在扫描…
                    {duplicateScanProgress
                      ? ` 已读取 ${duplicateScanProgress.loaded}${duplicateScanProgress.total > 0 ? ` / ${duplicateScanProgress.total}` : ""} 项`
                      : ""}
                  </span>
                  <button className="secondary-action" onClick={cancelDuplicateScan}>取消扫描</button>
                </>
              ) : (
                <>
                  <span role="status">
                    {duplicateGroups === null
                      ? "尚未完成扫描"
                      : duplicateGroups.length === 0
                        ? "未发现重复文件"
                        : `发现 ${duplicateGroups.length} 组重复，共 ${duplicateGroups.reduce((sum, group) => sum + group.entries.length, 0)} 项；参与比对 ${duplicateScannedCount} 个文件`}
                  </span>
                  <div className="dedupe-toolbar-actions">
                    <button className="secondary-action" onClick={() => void scanDuplicates()}>重新扫描</button>
                    {duplicateGroups !== null && duplicateGroups.length > 0 && (
                      <button className="secondary-action" onClick={resetDuplicateSelection}>恢复默认勾选</button>
                    )}
                  </div>
                </>
              )}
            </div>

            {duplicateDeleting !== null && (
              <div className="dedupe-progress" role="status">
                正在删除 {duplicateDeleting.completed} / {duplicateDeleting.total} 项…
              </div>
            )}
            {duplicatePanelError !== null && (
              <div className="dedupe-error" role="alert">{duplicatePanelError}</div>
            )}

            <div className="dedupe-groups">
              {duplicateScanning ? (
                <div className="dedupe-empty" role="status">正在读取完整目录，请稍候…</div>
              ) : duplicateGroups === null ? (
                <div className="dedupe-empty" role="status">扫描没有完成，暂时没有可判断的结果；可点击“重新扫描”重试。</div>
              ) : duplicateGroups.length === 0 ? (
                <div className="dedupe-empty" role="status">
                  <Icon name="check" size={20} />
                  <strong>未发现重复文件</strong>
                  <span>当前目录中没有文件名相同或内容相同的文件。</span>
                </div>
              ) : duplicateGroups.map((group) => {
                const retained = defaultRetainedEntry(group);
                return (
                  <section className="dedupe-group" key={group.id} aria-label={`重复组，${group.entries.length} 项`}>
                    <header>
                      <strong>{group.entries.length} 项重复</strong>
                      <span className="dedupe-reason" data-reason={group.reason}>
                        {DUPLICATE_REASON_LABELS[group.reason]}
                      </span>
                      {retained && <small>建议保留：{retained.name}{hasCopyMarker(retained.name) ? "" : "（干净名字）"}</small>}
                    </header>
                    <ul>
                      {group.entries.map((entry) => {
                        const checked = duplicateSelected.has(entry.id);
                        const isRetained = retained?.id === entry.id;
                        return (
                          <li key={entry.id} className={checked ? "checked" : ""}>
                            <label>
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={duplicateDeleting !== null}
                                onChange={() => toggleDuplicateSelected(group, entry.id)}
                              />
                              <FileThumbnail
                                // 只按名称/后缀取视觉类型：不依赖 entry.kind 的联合类型，
                                // 避免 provider 新增 kind（如图片/音频）时此处出现类型耦合。
                                kind={getFilePresentation({ name: entry.name, extension: entry.extension }).kind}
                                src={entry.thumbUrl}
                                size={24}
                              />
                              <span className="dedupe-entry-name" title={entry.name}>{entry.name}</span>
                              <span className="dedupe-entry-meta">
                                {formatBytes(entry.sizeBytes)} · {formatModifiedAt(entry.modifiedAt)}
                                {entry.sha1.trim() !== "" ? ` · SHA1 ${entry.sha1.slice(0, 8).toUpperCase()}` : " · 无 SHA1"}
                              </span>
                              {isRetained && <span className="dedupe-retained">建议保留</span>}
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
            </div>

            <div className="dedupe-footer">
              <span>
                {duplicateGroups !== null && duplicateGroups.length > 0
                  ? `已勾选 ${duplicateSelected.size} 项移入回收站`
                  : ""}
              </span>
              <div>
                <button className="secondary-action" disabled={duplicateDeleting !== null} onClick={closeDuplicatePanel}>
                  {duplicateScanning ? "关闭" : "完成"}
                </button>
                <button
                  className="danger-action"
                  disabled={duplicateDeleting !== null || duplicateGroups === null || duplicateGroups.length === 0 || duplicateSelected.size === 0}
                  onClick={requestDuplicateDelete}
                >
                  移入回收站
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
      {duplicateConfirmOpen && (
        <div
          className="cloud-operation-backdrop"
          onPointerDown={(event) => event.target === event.currentTarget && setDuplicateConfirmOpen(false)}
        >
          <section
            ref={duplicateConfirmRef}
            tabIndex={-1}
            className="cloud-operation-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-label="确认移入回收站"
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              setDuplicateConfirmOpen(false);
            }}
          >
            <strong>移入回收站 {duplicateSelected.size} 项？</strong>
            <span>这些文件将从“{path[path.length - 1].name}”移除并进入 115 回收站，可在此后从回收站还原；每组至少保留 1 项。</span>
            <div>
              <button className="secondary-action" onClick={() => setDuplicateConfirmOpen(false)}>取消</button>
              <button className="danger-action" onClick={() => void confirmDuplicateDelete()}>删除</button>
            </div>
          </section>
        </div>
      )}
      {picker && (
        <div className="cloud-operation-backdrop" onPointerDown={(event) => event.target === event.currentTarget && !busyAction && setPicker(null)}>
          <section className="cloud-operation-dialog picker-dialog">
            <strong>{picker.mode === "move" ? "移动到…" : "复制到…"}</strong>
            <span>已选 {picker.ids.length} 项；目标文件夹由 115 校验同名冲突。</span>
            <nav className="file-breadcrumbs picker-breadcrumbs" aria-label="目标路径">
              {picker.path.map((item, index) => (
                <span key={item.id}>
                  {index > 0 && <Icon name="chevron" size={13} />}
                  <button className={index === picker.path.length - 1 ? "active" : ""} onClick={() => navigatePicker(index)}>{item.name}</button>
                </span>
              ))}
            </nav>
            {recentTargets.length > 0 && (
              <div className="picker-recent">
                <span className="picker-recent-label">最近使用</span>
                <div className="picker-recent-list">
                  {recentTargets.map((recent) => (
                    <button
                      key={recent.id}
                      type="button"
                      title={recent.path.map((item) => item.name).join(" / ")}
                      onClick={() => jumpToRecentTarget(recent)}
                    >
                      <span className="picker-folder-icon"><FileTypeIcon kind="folder" size={18} /></span>
                      <span>{recent.name}</span>
                      <small>{recent.path.length > 1 ? recent.path.slice(1).map((item) => item.name).join(" / ") : "根目录"}</small>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="picker-folder-list">
              {picker.loading ? <div className="picker-empty">正在读取文件夹…</div> : picker.entries.length === 0 ? <div className="picker-empty">此目录没有子文件夹</div> : picker.entries.map((entry) => (
                <button key={entry.id} onClick={() => enterPickerFolder(entry)}>
                  <span className="picker-folder-icon"><FileTypeIcon kind="folder" size={24} /></span>
                  <span>{entry.name}</span>
                  <Icon name="chevron" size={14} />
                </button>
              ))}
            </div>
            <p className="picker-target-line">
              {picker.mode === "move" ? "移动到" : "复制到"}：<strong>{picker.path[picker.path.length - 1].name}</strong>
              <span>（{picker.path.map((item) => item.name).join(" / ")}）</span>
            </p>
            <div>
              <button className="secondary-action" disabled={busyAction} onClick={() => setPicker(null)}>取消</button>
              <button className="primary-action" disabled={busyAction} onClick={() => void confirmPicker()}>{busyAction ? "正在提交" : picker.mode === "move" ? "移动到这里" : "复制到这里"}</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

/** 读取中的极简状态：单行文字，不做动画。目录读取已足够快，不需要加载表演。 */
function FileLoadingLabel({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`file-loading-label${compact ? " compact" : ""}`} role="status">
      正在读取文件…
    </div>
  );
}

/** 文件区空状态：读取失败 / 搜索或筛选无结果 / 目录为空 / 回收站为空，各配下一步动作。 */
function FileEmptyState({
  kind,
  errorText,
  hasQuery,
  hasFilter,
  onClearQuery,
  onClearFilter,
  onRetry,
  onNewFolder,
}: {
  kind: FileEmptyKind;
  errorText: string | null;
  hasQuery: boolean;
  hasFilter: boolean;
  onClearQuery: () => void;
  onClearFilter: () => void;
  onRetry: () => void;
  onNewFolder?: () => void;
}) {

  if (kind === "load-error") {
    return (
      <div className="file-empty" role="status">
        <Icon name="alert" size={22} />
        <strong>文件列表读取失败</strong>
        <span>{errorText ? `刚才的尝试没有成功：${errorText}` : "刚才的尝试没有成功，可以重试。"}</span>
        <button className="secondary-action file-empty-action" onClick={onRetry}>重试</button>
      </div>
    );
  }
  if (kind === "no-results") {
    return (
      <div className="file-empty" role="status">
        <Icon name="search" size={22} />
        <strong>没有匹配的项目</strong>
        <span>{hasQuery ? "当前目录中没有与搜索词匹配的文件" : "当前类型筛选下没有可显示的文件"}；排序只作用于已加载的条目。</span>
        <div className="file-empty-actions">
          {hasQuery && <button className="secondary-action file-empty-action" onClick={onClearQuery}>清除搜索</button>}
          {hasFilter && <button className="secondary-action file-empty-action" onClick={onClearFilter}>清除类型筛选</button>}
        </div>
      </div>
    );
  }
  if (kind === "starred-empty") {
    return (
      <div className="file-empty" role="status">
        <Icon name="star" size={22} />
        <strong>还没有收藏项</strong>
        <span>在文件上右键选择「收藏」，就会出现在这里；收藏是跨目录的全账号列表。</span>
      </div>
    );
  }
  return (
    <div className="file-empty" role="status">
      <Icon name="folder" size={22} />
      <strong>此目录为空</strong>
      <span>当前文件夹还没有加载到任何文件；可以用上传或新建文件夹充实它。</span>
      {onNewFolder && (
        <button className="secondary-action file-empty-action" onClick={onNewFolder}>
          <Icon name="plus" size={14} />
          新建文件夹
        </button>
      )}
    </div>
  );
}
