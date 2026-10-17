import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Cloud115Service,
  MediaInfoService,
  type Cloud115AccountStatus,
  type Cloud115FileEntry,
  type Cloud115RecycleItem,
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

type CloudFileFilter = "all" | "folder" | "video" | "subtitle";
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

/** 统一浮层菜单的打开状态：entry 为空表示页级菜单（排序），否则是单条目菜单。 */
type PaneMenu = {
  entry: Cloud115FileEntry | null;
  x: number;
  y: number;
  /** 关闭后焦点送回触发位置：行元素、更多按钮或排序按钮。 */
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

/** 回收站确认对话框中的人读清单；与批量删除同节奏。 */
function describeRecycleTargets(targets: Cloud115RecycleItem[]): string {
  if (targets.length <= 2) {
    return targets.map((item) => `“${item.name}”`).join("、");
  }
  return `“${targets[0].name}”、“${targets[1].name}”等 ${targets.length} 项`;
}

/** 已加载项的客户端排序：目录始终在前；同值回退文件名，保证顺序稳定。 */
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
type FileEmptyKind = "directory-empty" | "no-results" | "load-error" | "recycle-empty";

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
export function CloudFilesView({ account, query, onQueryChange, onRequireLogin, onPlay }: CloudFilesViewProps) {
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
  // 视图状态机：视图模式与密度全局持久化；排序随目录记忆（内存态）。
  const [viewMode, setViewMode] = useState<ViewMode>(readStoredViewMode);
  const [density, setDensity] = useState<Density>(readStoredDensity);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  // 统一浮层菜单（右键 / 行尾更多 / 排序）。
  const [paneMenu, setPaneMenu] = useState<PaneMenu | null>(null);
  // 新建文件夹：行内对话框命名，成功后刷新当前目录。
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  // 回收站面板：文件区顶部入口切换到回收站列表（还原 / 彻底删除）。
  const [recycleView, setRecycleView] = useState(false);
  const [recycleEntries, setRecycleEntries] = useState<Cloud115RecycleItem[]>([]);
  const [recycleTotal, setRecycleTotal] = useState(0);
  const [recycleLoading, setRecycleLoading] = useState(false);
  const [recycleLoadingMore, setRecycleLoadingMore] = useState(false);
  const [recycleHasMore, setRecycleHasMore] = useState(false);
  const [recycleSelected, setRecycleSelected] = useState<Set<string>>(new Set());
  const [recyclePurgeTargets, setRecyclePurgeTargets] = useState<Cloud115RecycleItem[]>([]);
  // 目标选择器「最近使用」：最近 5 个目标目录，持久化 localStorage。
  const [recentTargets, setRecentTargets] = useState<RecentTarget[]>(readRecentTargets);
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
  const requestKey = `${currentFolderId}\u0000${query.trim()}`;
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
      cloud115.listFiles(currentFolderId, query.trim(), 0, PAGE_LIMIT)
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
  }, [account?.connected, currentFolderId, query, reloadNonce]);

  // 搜索词由顶栏下发：口径变化立即清空选择，避免批量操作作用于即将不可见的文件。
  useEffect(() => {
    setSelectedIds(new Set());
  }, [query]);

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

  const visibleEntries = useMemo(
    () => entries
      .filter((entry) => filter === "all" || entry.kind === filter)
      .sort((a, b) => compareEntries(a, b, sort)),
    [entries, filter, sort],
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

  /** 顺序上传所选文件；115 对控制请求限速，逐个提交比并发更稳。 */
  async function startUpload() {
    const filePaths = await cloud115.pickUploadFiles();
    if (filePaths.length === 0) return;
    setError(null);
    const failures: string[] = [];
    for (const [index, filePath] of filePaths.entries()) {
      const name = filePath.split("/").pop() ?? filePath;
      setUploading({ name, index: index + 1, total: filePaths.length });
      try {
        await cloud115.uploadFile(filePath, currentFolderId);
      } catch (reason) {
        failures.push(`${name}：${String(reason)}`);
      }
    }
    setUploading(null);
    if (failures.length > 0) {
      setError(`上传完成，但 ${failures.length} 个文件失败：${failures.join("；")}`);
    } else {
      setNotice(`已上传 ${filePaths.length} 个文件到当前目录`);
    }
    setReloadNonce((nonce) => nonce + 1);
    refreshUploadSessions();
  }

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

  /** 行的主打开动作：文件夹进入、视频播放；其余类型没有内置查看器，不做假预览，交给更多菜单。 */
  function openEntryPrimary(entry: Cloud115FileEntry, rowElement?: HTMLElement | null) {
    if (entry.kind === "folder") {
      openFolder(entry);
      return;
    }
    if (entry.kind === "video") {
      void playEntry(entry);
      return;
    }
    if (rowElement) {
      const rect = rowElement.getBoundingClientRect();
      openPaneMenu(entry, rect.left + rect.width / 2, rect.bottom + 4, rowElement);
    }
  }

  /** 离开目录前记录该目录的滚动与排序，供返回时恢复。 */
  function rememberCurrentDirUi(folderId: string) {
    dirUiMemoryRef.current.set(folderId, { scrollTop: window.scrollY, sort });
  }

  function openFolder(entry: Cloud115FileEntry) {
    if (entry.kind !== "folder") return;
    rememberCurrentDirUi(currentFolderId);
    const memory = dirUiMemoryRef.current.get(entry.id) ?? null;
    pendingDirScrollRef.current = memory ? memory.scrollTop : 0;
    setSort(memory?.sort ?? DEFAULT_SORT);
    setPath((current) => [...current, { id: entry.id, name: entry.name }]);
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
      const page = await cloud115.listFiles(currentFolderId, query.trim(), offset, PAGE_LIMIT);
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

  async function playEntry(entry: Cloud115FileEntry) {
    setPlayingId(entry.id);
    setError(null);
    try {
      await onPlay(entry);
    } catch (reason) {
      setError(`播放《${entry.name}》失败：${String(reason)}`);
    } finally {
      setPlayingId(null);
    }
  }

  /** 收藏当前文件；成功后保留在当前目录，并给出明确反馈。 */
  async function favoriteEntry(entry: Cloud115FileEntry) {
    setBusyAction(true);
    setError(null);
    try {
      await cloud115.updateFile(entry.id, { starred: true });
      setNotice(`已收藏“${entry.name}”`);
    } catch (reason) {
      setError(`收藏“${entry.name}”失败：${String(reason)}`);
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
  // 回收站面板：还原 / 彻底删除，走既有 cloud115_list_recycle_bin 命令族。
  // ---------------------------------------------------------------------------

  async function loadRecyclePage(offset: number) {
    const append = offset > 0;
    if (append) {
      setRecycleLoadingMore(true);
    } else {
      setRecycleLoading(true);
    }
    setError(null);
    try {
      const page = await cloud115.listRecycleBin(offset, PAGE_LIMIT);
      setRecycleEntries((current) => append ? [...current, ...page.entries] : page.entries);
      setRecycleTotal(page.total);
      setRecycleHasMore(page.hasMore);
    } catch (reason) {
      setError(`读取回收站失败：${String(reason)}`);
    } finally {
      if (append) {
        setRecycleLoadingMore(false);
      } else {
        setRecycleLoading(false);
      }
    }
  }

  /**
   * 无限滚动：底部哨兵进入视口即加载下一页，取代「加载更多」按钮。
   * 哨兵仅在仍有下一页时挂载，因此依赖里的 hasMore / recycleHasMore 变化
   * 会重建观察器；已加载条数变化同样重建，使短内容在数据落地后继续预取，
   * 直到填满一屏或没有更多。进行中的请求由 loadingMore / recycleLoadingMore 拦截。
   */
  requestNextPageRef.current = () => {
    if (recycleView) {
      if (recycleHasMore && !recycleLoadingMore && !recycleLoading) void loadRecyclePage(recycleEntries.length);
      return;
    }
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
  }, [recycleView, hasMore, recycleHasMore, entries.length, recycleEntries.length]);

  function openRecycleView() {
    setRecycleView(true);
    setRecycleSelected(new Set());
    void loadRecyclePage(0);
  }

  function closeRecycleView() {
    setRecycleView(false);
    setRecycleSelected(new Set());
    setRecyclePurgeTargets([]);
  }

  function toggleRecycleSelected(itemId: string) {
    setRecycleSelected((current) => {
      const next = new Set(current);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  }

  const allRecycleSelected = recycleEntries.length > 0 && recycleEntries.every((item) => recycleSelected.has(item.id));

  function toggleAllRecycle() {
    setRecycleSelected(() => {
      if (allRecycleSelected) return new Set();
      return new Set(recycleEntries.map((item) => item.id));
    });
  }

  /** 还原到删除前的原位置；原位置正是当前目录时同步刷新文件列表。 */
  async function confirmRecycleRestore(itemIds: string[]) {
    if (itemIds.length === 0) return;
    setBusyAction(true);
    setError(null);
    try {
      await cloud115.restoreRecycleItems(itemIds);
      const restored = recycleEntries.filter((item) => itemIds.includes(item.id));
      setNotice(itemIds.length === 1
        ? `“${restored[0]?.name ?? "项目"}”已还原到原位置`
        : `${itemIds.length} 项已还原到原位置`);
      setRecycleSelected(new Set());
      void loadRecyclePage(0);
      if (restored.some((item) => item.parentId === currentFolderId)) {
        setReloadNonce((nonce) => nonce + 1);
      }
    } catch (reason) {
      setError(`还原失败：${String(reason)}`);
    } finally {
      setBusyAction(false);
    }
  }

  /** 彻底删除不可恢复；必须先经二次确认对话框。 */
  async function confirmRecyclePurge() {
    if (recyclePurgeTargets.length === 0) return;
    setBusyAction(true);
    setError(null);
    try {
      await cloud115.deleteRecycleItems(recyclePurgeTargets.map((item) => item.id));
      const removed = new Set(recyclePurgeTargets.map((item) => item.id));
      setRecycleEntries((current) => current.filter((item) => !removed.has(item.id)));
      setRecycleTotal((current) => Math.max(0, current - recyclePurgeTargets.length));
      setNotice(recyclePurgeTargets.length === 1
        ? `“${recyclePurgeTargets[0].name}”已彻底删除`
        : `${recyclePurgeTargets.length} 项已彻底删除`);
      setRecycleSelected((current) => {
        const next = new Set(current);
        for (const id of removed) next.delete(id);
        return next;
      });
      setRecyclePurgeTargets([]);
    } catch (reason) {
      setError(`彻底删除失败：${String(reason)}`);
    } finally {
      setBusyAction(false);
    }
  }

  // ---------------------------------------------------------------------------
  // 统一浮层菜单：右键、行尾更多、排序共用；关闭时把焦点送回触发位置。
  // ---------------------------------------------------------------------------

  function openPaneMenu(entry: Cloud115FileEntry | null, x: number, y: number, restoreTo: HTMLElement | null) {
    setPaneMenu({ entry, x, y, restoreTo });
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
      items.push({ id: "open", label: "打开", icon: "chevron", hint: "进入此文件夹", onSelect: () => { close(); openFolder(entry); } });
    } else if (entry.kind === "video") {
      items.push({ id: "play", label: "播放", icon: "play", hint: "用内置播放器播放", onSelect: () => { close(); void playEntry(entry); } });
    }
    if (entry.kind !== "folder") {
      items.push({ id: "download", label: "下载", icon: "download", onSelect: () => { close(); void downloadEntry(entry); } });
    }
    if (entry.kind === "video") {
      items.push({ id: "media-info", label: "媒体信息", icon: "play", hint: "读取时长与编码信息", onSelect: () => { close(); void scrapeMediaInfo(entry); } });
    }
    items.push(
      { kind: "separator", id: "sep-organize" },
      { id: "favorite", label: "收藏", icon: "star", disabled: busyAction, onSelect: () => { close(); void favoriteEntry(entry); } },
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
    if (recycleView) {
      if (recycleSelected.size > 0) {
        event.stopPropagation();
        setRecycleSelected(new Set());
      }
      return;
    }
    if (selectedIds.size > 0) {
      event.stopPropagation();
      clearSelection();
    }
  }

  /** 空状态分类：按「读取失败 → 搜索 → 筛选 → 真空目录」的优先级归类，文案不发明数据。 */
  const emptyKind: FileEmptyKind | null = loading || visibleEntries.length > 0 ? null
    : entries.length === 0 && error ? "load-error"
      : query.trim() || filter !== "all" ? "no-results"
        : "directory-empty";

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
    <section className="page-section cloud-files-view">
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
            {recycleView ? (
              <div className="recycle-header">
                <button className="secondary-action" onClick={closeRecycleView}>返回文件列表</button>
                <strong>回收站</strong>
                <span>已加载 {recycleEntries.length} / {recycleTotal} 项</span>
              </div>
            ) : (
              <>
                <nav className="file-breadcrumbs" aria-label="当前网盘路径">
                  {path.map((item, index) => (
                    <span key={item.id}>
                      {index > 0 && <Icon name="chevron" size={13} />}
                      <button className={index === path.length - 1 ? "active" : ""} onClick={() => navigateToPath(index)}>{item.name}</button>
                    </span>
                  ))}
                </nav>
                <div className="cloud-filter-options">
                  <div className="segmented-control cloud-view-toggle" role="group" aria-label="视图切换">
                    <button
                      className={viewMode === "list" ? "active" : ""}
                      aria-pressed={viewMode === "list"}
                      title="列表视图"
                      aria-label="列表视图"
                      onClick={() => switchViewMode("list")}
                    >
                      <Icon name="tasks" size={15} />
                    </button>
                    <button
                      className={viewMode === "grid" ? "active" : ""}
                      aria-pressed={viewMode === "grid"}
                      title="网格视图"
                      aria-label="网格视图"
                      onClick={() => switchViewMode("grid")}
                    >
                      <Icon name="library" size={15} />
                    </button>
                  </div>
                  <div className="segmented-control cloud-density-toggle" role="group" aria-label="显示密度">
                    <button className={density === "comfortable" ? "active" : ""} aria-pressed={density === "comfortable"} onClick={() => setDensity("comfortable")}>舒适</button>
                    <button className={density === "compact" ? "active" : ""} aria-pressed={density === "compact"} onClick={() => setDensity("compact")}>紧凑</button>
                  </div>
                  <div className="cloud-sort-control">
                    <button
                      className="cloud-sort-button"
                      aria-haspopup="menu"
                      aria-expanded={paneMenu !== null && paneMenu.entry === null}
                      title={`按已加载的 ${entries.length} 项排序`}
                      onClick={(event) => {
                        const button = event.currentTarget;
                        if (paneMenu !== null && paneMenu.entry === null) {
                          closePaneMenu();
                          return;
                        }
                        const rect = button.getBoundingClientRect();
                        openPaneMenu(null, rect.right, rect.bottom + 4, button);
                      }}
                    >
                      排序：{SORT_FIELD_LABELS[sort.field]} {sort.order === "asc" ? "升序" : "降序"}
                      <span className="cloud-sort-caret" aria-hidden="true"><Icon name="chevron" size={12} /></span>
                    </button>
                  </div>
                  <span className="cloud-account-badge" title={`115 账号：${account.userName ?? "已连接"}`}>
                    <i aria-hidden="true" />
                    {account.userName ?? "115 已连接"}
                  </span>
                  <span>{loadedCountLabel}</span>
                </div>
                <div className="cloud-toolbar-actions">
                  <button
                    className="secondary-action cloud-newfolder-action"
                    title="在当前目录新建文件夹"
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
                    disabled={uploading !== null}
                    title={uploading ? uploadStageLabel(uploading, activeUpload) : "上传文件到当前目录"}
                    onClick={() => void startUpload()}
                  >
                    <Icon name="upload" size={16} />
                    {uploading ? uploadStageLabel(uploading, activeUpload) : "上传文件"}
                  </button>
                  <button
                    className="cloud-recycle-button"
                    title="查看回收站，可还原或彻底删除"
                    aria-label="回收站"
                    onClick={openRecycleView}
                  >
                    <Icon name="trash" size={15} />
                    回收站
                  </button>
                </div>
              </>
            )}
          </div>

          {recycleView && recycleSelected.size > 0 && (
            <div className="file-batch-bar" role="toolbar" aria-label="回收站批量操作">
              <span>已选 {recycleSelected.size} 项</span>
              <div>
                <button disabled={busyAction} onClick={() => void confirmRecycleRestore([...recycleSelected])}>还原</button>
                <button className="danger" disabled={busyAction} onClick={() => {
                  const targets = recycleEntries.filter((item) => recycleSelected.has(item.id));
                  if (targets.length > 0) setRecyclePurgeTargets(targets);
                }}>彻底删除</button>
                <button disabled={busyAction} onClick={() => setRecycleSelected(new Set())}>取消选择</button>
              </div>
            </div>
          )}

          {!recycleView && selectedIds.size > 0 && (
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

          {recycleView ? (
            <div className="file-table recycle-table" role="table" aria-label="回收站">
              <div className="file-table-head" role="row">
                <input
                  type="checkbox"
                  className="file-check"
                  aria-label="选择全部回收站项目"
                  checked={allRecycleSelected}
                  onChange={toggleAllRecycle}
                />
                <span role="columnheader">名称</span>
                <span role="columnheader">大小</span>
                <span role="columnheader">删除时间</span>
                <span role="columnheader">原位置</span>
                <span aria-hidden="true" />
              </div>
              {recycleLoading ? <FileLoadingLabel /> : recycleEntries.length > 0 ? recycleEntries.map((item) => (
                <div className={`file-row${recycleSelected.has(item.id) ? " selected" : ""}`} role="row" key={item.id}>
                  <input
                    type="checkbox"
                    className="file-check"
                    aria-label={`选择 ${item.name}`}
                    checked={recycleSelected.has(item.id)}
                    onChange={() => toggleRecycleSelected(item.id)}
                  />
                  <span className="file-name">
                    <FileThumbnail kind={item.isFolder ? "folder" : "file"} src={null} size={28} />
                    <span><strong title={item.name}>{item.name}</strong></span>
                  </span>
                  <span className="file-size">{formatBytes(item.sizeBytes)}</span>
                  <time>{formatModifiedAt(item.deletedAt)}</time>
                  <span className="recycle-origin" title={item.parentName}>{item.parentName}</span>
                  <div className="recycle-row-actions">
                    <button disabled={busyAction} onClick={() => void confirmRecycleRestore([item.id])}><Icon name="history" size={13} />还原</button>
                    <button className="danger" disabled={busyAction} onClick={() => setRecyclePurgeTargets([item])}><Icon name="trash" size={13} />彻底删除</button>
                  </div>
                </div>
              )) : (
                <FileEmptyState kind="recycle-empty" errorText={null} hasQuery={false} hasFilter={false} onClearQuery={() => {}} onClearFilter={() => {}} onRetry={() => {}} />
              )}
            </div>
          ) : viewMode === "list" ? (
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
                      aria-disabled={entry.kind !== "folder" && entry.kind !== "video"}
                      title={entry.kind === "folder" ? "打开文件夹" : entry.kind === "video" ? "播放视频" : undefined}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (entry.kind !== "folder" && entry.kind !== "video") return;
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
                      {entry.kind === "folder" && <button className="file-open" onClick={(event) => { event.stopPropagation(); openFolder(entry); }} aria-label={`打开${entry.name}`}><Icon name="chevron" size={16} /></button>}
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
                  onNewFolder={() => {
                    setNewFolderName("");
                    setNewFolderOpen(true);
                  }}
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
                  onNewFolder={() => {
                    setNewFolderName("");
                    setNewFolderOpen(true);
                  }}
                />
              )}
            </div>
          )}
          {/* 哨兵：滚到这里即自动续页；仅在仍有下一页时挂载，避免无数据时常驻占位。 */}
          {(hasMore || recycleHasMore) && (
            <div className="cloud-load-sentinel" ref={loadMoreSentinelRef}>
              {(loadingMore || recycleLoadingMore) && <span>正在加载…</span>}
            </div>
          )}

      </div>

      {paneMenu && (
        <FileContextMenu
          x={paneMenu.x}
          y={paneMenu.y}
          items={paneMenu.entry ? buildFileMenuItems(paneMenu.entry) : buildSortMenuItems()}
          note={paneMenu.entry ? undefined : `仅对已加载的 ${entries.length} 项生效`}
          label={paneMenu.entry ? `${paneMenu.entry.name}的操作菜单` : "排序方式"}
          onClose={closePaneMenu}
        />
      )}

      {renameEntry && <div className="cloud-operation-backdrop" onPointerDown={(event) => event.target === event.currentTarget && !busyAction && setRenameEntry(null)}><form className="cloud-operation-dialog" onSubmit={(event) => { event.preventDefault(); void submitRename(); }}><strong>重命名</strong><span>为“{renameEntry.name}”输入新名称</span><input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.currentTarget.value)} /><div><button type="button" className="secondary-action" disabled={busyAction} onClick={() => setRenameEntry(null)}>取消</button><button type="submit" className="primary-action" disabled={busyAction || !renameValue.trim()}>保存</button></div></form></div>}
      {newFolderOpen && <div className="cloud-operation-backdrop" onPointerDown={(event) => event.target === event.currentTarget && !busyAction && setNewFolderOpen(false)}><form className="cloud-operation-dialog" onSubmit={(event) => { event.preventDefault(); void submitNewFolder(); }}><strong>新建文件夹</strong><span>在“{path[path.length - 1].name}”中创建；同名冲突由 115 校验。</span><input autoFocus placeholder="文件夹名称" value={newFolderName} onChange={(event) => setNewFolderName(event.currentTarget.value)} /><div><button type="button" className="secondary-action" disabled={busyAction} onClick={() => setNewFolderOpen(false)}>取消</button><button type="submit" className="primary-action" disabled={busyAction || !newFolderName.trim()}>创建</button></div></form></div>}
      {recyclePurgeTargets.length > 0 && <div className="cloud-operation-backdrop" onPointerDown={(event) => event.target === event.currentTarget && !busyAction && setRecyclePurgeTargets([])}><section className="cloud-operation-dialog"><strong>{recyclePurgeTargets.length === 1 ? "彻底删除 1 项？" : `彻底删除 ${recyclePurgeTargets.length} 项？`}</strong><span>{describeRecycleTargets(recyclePurgeTargets)}将从回收站永久移除，此操作不可恢复。</span><div><button className="secondary-action" disabled={busyAction} onClick={() => setRecyclePurgeTargets([])}>取消</button><button className="danger-action" disabled={busyAction} onClick={() => void confirmRecyclePurge()}>{busyAction ? "正在删除" : "彻底删除"}</button></div></section></div>}
      {deleteTargets.length > 0 && <div className="cloud-operation-backdrop" onPointerDown={(event) => event.target === event.currentTarget && !busyAction && setDeleteTargets([])}><section className="cloud-operation-dialog"><strong>{deleteTargets.length === 1 ? "移入回收站？" : `移入回收站 ${deleteTargets.length} 项？`}</strong><span>{describeTargets(deleteTargets)}将从当前目录移除，可稍后在回收站恢复。</span><div><button className="secondary-action" disabled={busyAction} onClick={() => setDeleteTargets([])}>取消</button><button className="danger-action" disabled={busyAction} onClick={() => void confirmDelete()}>{busyAction ? "正在删除" : "删除"}</button></div></section></div>}
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
  if (kind === "recycle-empty") {
    return (
      <div className="file-empty" role="status">
        <Icon name="history" size={22} />
        <strong>回收站为空</strong>
        <span>删除的文件会先进入回收站，可在这里还原或彻底删除。</span>
      </div>
    );
  }
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
