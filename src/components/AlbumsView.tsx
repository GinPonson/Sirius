import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from "react";
import {
  AlbumsService,
  type AlbumFolderInput,
  type AlbumsIndexSummary,
  type AlbumPhoto,
} from "../services/albumsServices";
import { Cloud115Service, type Cloud115FileEntry } from "../services/mediaServices";
import { registerViewPageContext, notifyPageContextChanged, type AiPageContext } from "../domain/pageContext";
import { FileThumbnail } from "./FileThumbnail";
import { FileTypeIcon } from "./FileTypeIcon";
import { Icon } from "./Icon";
import { AlbumMonthNav, monthLabel } from "./AlbumMonthNav";

const albumsService = new AlbumsService();
const cloud115 = new Cloud115Service();

const ROOT_ID = "0";

/** 照片网格密度档位与持久化键；三档仅改变网格列宽与间距，不改变数据口径。 */
type AlbumsDensity = "comfort" | "standard" | "compact";
const DENSITY_STORAGE_KEY = "sirius-albums-density";
const DENSITY_ORDER: AlbumsDensity[] = ["comfort", "standard", "compact"];
const DENSITY_LABELS: Record<AlbumsDensity, string> = { comfort: "舒适", standard: "标准", compact: "紧凑" };

function readStoredDensity(): AlbumsDensity {
  try {
    const stored = window.localStorage.getItem(DENSITY_STORAGE_KEY);
    if (stored && DENSITY_ORDER.includes(stored as AlbumsDensity)) return stored as AlbumsDensity;
  } catch {
    // localStorage 不可用时使用默认密度即可。
  }
  return "standard";
}

/** 缩放档位："fit" 为适应窗口，数字为相对原图的倍率（1 即 100%）。 */
type ZoomMode = "fit" | number;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.25;

function stepZoom(current: ZoomMode, direction: 1 | -1): ZoomMode {
  if (direction > 0) {
    return current === "fit" ? 1 : Math.min(MAX_ZOOM, Math.round((current + ZOOM_STEP) * 100) / 100);
  }
  return current === "fit" ? "fit" : Math.max(MIN_ZOOM, Math.round((current - ZOOM_STEP) * 100) / 100);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 将字节数格式化为紧凑容量；与网盘文件页保持一致的展示规则。 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

type ReaderState = {
  photos: AlbumPhoto[];
  index: number;
  /** 短时效原图直链；加载失败时回退缩略图。 */
  fullUrl: string | null;
  /** 原图直链解析或加载进行中。 */
  fullLoading: boolean;
  fullFailed: boolean;
};

type DialogState =
  | { kind: "rename"; value: string }
  | { kind: "recycle" }
  | { kind: "remove" }
  | null;

/** 相册模式：照片索引 → 时间线缩略图墙/专辑 → 预览大图与专辑整理。整理操作全部走 115 回收站语义。 */
export function AlbumsView() {
  const [rootFolders, setRootFolders] = useState<Cloud115FileEntry[]>([]);
  const [folderId, setFolderId] = useState(ROOT_ID);
  const [recognizing, setRecognizing] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [shelf, setShelf] = useState<AlbumsIndexSummary | null>(null);
  const [tab, setTab] = useState<"timeline" | "albums">("timeline");
  const [albumFilter, setAlbumFilter] = useState<string | null>(null);
  const [density, setDensityState] = useState<AlbumsDensity>(readStoredDensity);
  const [albumMenuOpen, setAlbumMenuOpen] = useState(false);
  const [reader, setReader] = useState<ReaderState | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busyOp, setBusyOp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 大图请求序号：每次发起新请求或翻页都会自增，用于丢弃迟到到达的旧响应。 */
  const requestSeqRef = useRef(0);

  useEffect(() => {
    let active = true;
    cloud115.listFiles(ROOT_ID, "", 0, 100)
      .then((page) => {
        if (active) setRootFolders(page.entries.filter((entry) => entry.kind === "folder"));
      })
      .catch((reason) => active && setError(`读取网盘目录失败：${String(reason)}`));
    albumsService.index()
      .then((summary) => active && setShelf(summary))
      .catch((reason) => active && setError(`读取相册时间线失败：${String(reason)}`));
    return () => {
      active = false;
    };
  }, []);

  /** 首次读取失败后的重试入口；不重置整页状态，仅重新拉取索引。 */
  function retryLoadIndex() {
    setError(null);
    albumsService.index()
      .then((summary) => setShelf(summary))
      .catch((reason) => setError(`读取相册时间线失败：${String(reason)}`));
  }

  async function loadIndex() {
    setShelf(await albumsService.index());
  }

  /** 切换密度档位并持久化；存储失败时仅保留本次会话的选择。 */
  function setDensity(next: AlbumsDensity) {
    setDensityState(next);
    try {
      window.localStorage.setItem(DENSITY_STORAGE_KEY, next);
    } catch {
      // 存储不可用时保持内存态即可。
    }
  }

  /** 识别选中目录；目录名由前端目录列表提供，仅作专辑展示元数据。 */
  async function recognize() {
    setRecognizing(true);
    setError(null);
    try {
      const folderName =
        folderId === ROOT_ID
          ? "网盘根目录"
          : rootFolders.find((folder) => folder.id === folderId)?.name ?? "";
      const overview = await albumsService.recognize({ folderId, folderName });
      await loadIndex();
      if (overview.truncated) {
        const name = overview.folderName || "所选目录";
        setError(
          `${name}扫描不完整：已扫描 ${overview.scannedCount} 条。当前扫描最多读取每目录 200 条、总计 12 次请求、每层 8 个子目录，并在命中照片层后停止深入；本次未保存结果，已有完整索引已保留。`,
        );
      }
    } catch (reason) {
      setError(`照片识别失败：${String(reason)}`);
    } finally {
      setRecognizing(false);
    }
  }

  /** 批量索引全部根目录；Rust 侧单次上限 20 个目录并顺序限速。 */
  async function indexAllRoots() {
    const folders: AlbumFolderInput[] = rootFolders.map((folder) => ({
      folderId: folder.id,
      folderName: folder.name,
    }));
    if (folders.length === 0) {
      setError("网盘根目录下没有可索引的文件夹");
      return;
    }
    setIndexing(true);
    setError(null);
    try {
      const overviews = await albumsService.indexFolders(folders);
      await loadIndex();
      const truncated = overviews.filter((overview) => overview.truncated);
      if (truncated.length > 0) {
        setError(
          `${truncated.length} 个目录扫描不完整：当前扫描最多读取每目录 200 条、总计 12 次请求、每层 8 个子目录，并在命中照片层后停止深入。未保存这些不完整结果，对应已有完整索引已保留。`,
        );
      }
    } catch (reason) {
      setError(`批量索引失败：${String(reason)}`);
    } finally {
      setIndexing(false);
    }
  }

  /** 按当前专辑逐张过滤后的时间线视图；未选专辑时直接复用原索引数组，选中的月份才保留。 */
  const visibleMonths = useMemo(() => {
    const months = shelf?.months ?? [];
    if (!albumFilter) return months;
    return months
      .map((month) => {
        const photos = month.photos.filter((photo) => photo.folderId === albumFilter);
        return { ...month, photoCount: photos.length, photos };
      })
      .filter((month) => month.photos.length > 0);
  }, [shelf, albumFilter]);
  const visiblePhotos = useMemo(() => visibleMonths.flatMap((month) => month.photos), [visibleMonths]);
  const photoIndexById = useMemo(
    () => new Map(visiblePhotos.map((photo, index) => [photo.fileId, index])),
    [visiblePhotos],
  );
  const visibleAlbums = albumFilter
    ? (shelf?.albums ?? []).filter((album) => album.folderId === albumFilter)
    : shelf?.albums ?? [];
  const filteredAlbum = albumFilter
    ? (shelf?.albums ?? []).find((album) => album.folderId === albumFilter)
    : null;

  // —— 月份吸顶与年月导航的滚动联动 ——
  const monthRefs = useRef(new Map<string, HTMLElement>());
  const scrollFrameRef = useRef(0);
  const [activeMonthKey, setActiveMonthKey] = useState<string | null>(null);

  // 「更多」菜单外点关闭：不用 fixed 垫层（.albums-actions 的 backdrop-filter 会成为
  // fixed 后代的包含块，垫层无法铺满视口），改为文档级 pointerdown 判定。
  const moreWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!albumMenuOpen) return;
    function handleDocumentPointerDown(event: PointerEvent) {
      if (moreWrapRef.current && event.target instanceof Node && moreWrapRef.current.contains(event.target)) return;
      setAlbumMenuOpen(false);
    }
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    return () => document.removeEventListener("pointerdown", handleDocumentPointerDown);
  }, [albumMenuOpen]);

  function setMonthRef(monthKey: string) {
    return (element: HTMLElement | null) => {
      if (element) monthRefs.current.set(monthKey, element);
      else monthRefs.current.delete(monthKey);
    };
  }

  useEffect(() => {
    if (tab !== "timeline" || visibleMonths.length === 0) {
      setActiveMonthKey(null);
      return;
    }
    // 吸顶头部贴住的位置：顶栏 64px + 吸顶月份条自身高度 + 一点余量。
    const stickyTop = 104;
    function updateActiveMonth() {
      scrollFrameRef.current = 0;
      let current: string | null = null;
      for (const month of visibleMonths) {
        const element = monthRefs.current.get(month.monthKey);
        if (!element) continue;
        if (element.getBoundingClientRect().top <= stickyTop) current = month.monthKey;
      }
      // 滚动到底部时强制落在最后（最旧）月份，避免末月柱无法点亮。
      const scrollBottom = window.scrollY + window.innerHeight;
      if (document.documentElement.scrollHeight - scrollBottom <= 2) {
        current = visibleMonths[visibleMonths.length - 1]?.monthKey ?? current;
      }
      setActiveMonthKey((previous) => (previous === current ? previous : current));
    }
    function handleScroll() {
      if (!scrollFrameRef.current) {
        scrollFrameRef.current = window.requestAnimationFrame(updateActiveMonth);
      }
    }
    updateActiveMonth();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (scrollFrameRef.current) window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = 0;
    };
  }, [tab, visibleMonths]);

  /** 柱图点击：滚动定位到对应月份；scroll-margin-top 吸收顶栏与吸头条的遮挡。 */
  function navigateToMonth(monthKey: string) {
    monthRefs.current.get(monthKey)?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
  }

  // —— 大图预览：requestSeq 竞态守卫 + 缩放/平移/缩略图条 ——
  const [zoom, setZoom] = useState<ZoomMode>("fit");
  const [fullNatural, setFullNatural] = useState<{ width: number; height: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const activeStripItemRef = useRef<HTMLButtonElement | null>(null);
  const panStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

  /** 后台解析原图直链；到达时序号已推进则丢弃，翻页与重试共用。 */
  async function resolveFullSource(seq: number, photo: AlbumPhoto) {
    try {
      const source = await cloud115.downloadSource(photo.pickCode);
      setReader((current) =>
        current && requestSeqRef.current === seq
          ? { ...current, fullUrl: source.url, fullFailed: false, fullLoading: false }
          : current,
      );
    } catch {
      // 直链解析失败时保留缩略图预览，不打断浏览；明确提供重试入口。
      setReader((current) =>
        current && requestSeqRef.current === seq
          ? { ...current, fullUrl: null, fullFailed: true, fullLoading: false }
          : current,
      );
    }
  }

  /** 打开预览：先显示缩略图，后台解析原图直链并在加载成功后切换。 */
  async function openPreview(photos: AlbumPhoto[], index: number) {
    const photo = photos[Math.min(Math.max(0, index), photos.length - 1)];
    if (!photo) return;
    const seq = ++requestSeqRef.current;
    setReader({ photos, index: photos.indexOf(photo), fullUrl: null, fullLoading: true, fullFailed: false });
    setZoom("fit");
    setFullNatural(null);
    void resolveFullSource(seq, photo);
  }

  function changePhoto(delta: number) {
    if (!reader) return;
    const next = reader.index + delta;
    if (next < 0 || next > reader.photos.length - 1) return;
    // openPreview 内部会推进序号：旧照片仍在途的原图响应到达后会因序号变化被丢弃。
    void openPreview(reader.photos, next);
  }

  function retryFullSource() {
    if (!reader) return;
    const photo = reader.photos[reader.index];
    if (!photo) return;
    const seq = ++requestSeqRef.current;
    setReader((current) => (current ? { ...current, fullLoading: true, fullFailed: false } : current));
    void resolveFullSource(seq, photo);
  }

  function closePreview() {
    setReader(null);
  }

  useEffect(() => {
    if (!reader) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        changePhoto(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        changePhoto(-1);
      } else if (event.key === "Escape") {
        closePreview();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [reader]);

  // 翻页后复位舞台滚动位置；缩略图条把当前项滚到可视范围中央。
  useEffect(() => {
    stageRef.current?.scrollTo({ left: 0, top: 0 });
    activeStripItemRef.current?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [reader?.index, reader === null]);

  // 滚轮缩放需 non-passive 监听才能阻止页面滚动；React 合成 onWheel 为被动监听。
  useEffect(() => {
    const stage = stageRef.current;
    if (!reader || !stage) return;
    function handleWheel(event: WheelEvent) {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const direction = event.deltaY < 0 ? 1 : -1;
      setZoom((current) => stepZoom(current, direction));
    }
    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, [reader]);

  function handleStagePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const stage = stageRef.current;
    if (!stage) return;
    panStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: stage.scrollLeft,
      scrollTop: stage.scrollTop,
    };
    setDragging(true);
    stage.setPointerCapture(event.pointerId);
  }

  function handleStagePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const pan = panStateRef.current;
    const stage = stageRef.current;
    if (!pan || !stage || pan.pointerId !== event.pointerId) return;
    stage.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX);
    stage.scrollTop = pan.scrollTop - (event.clientY - pan.startY);
  }

  function handleStagePointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    if (panStateRef.current?.pointerId !== event.pointerId) return;
    panStateRef.current = null;
    setDragging(false);
    stageRef.current?.releasePointerCapture(event.pointerId);
  }

  function handleStageImgLoad(event: SyntheticEvent<HTMLImageElement>) {
    const image = event.currentTarget;
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      setFullNatural({ width: image.naturalWidth, height: image.naturalHeight });
    }
  }

  /** 重命名专辑目录；远端改名后重新识别该目录以刷新本机索引。 */
  async function renameAlbum() {
    if (dialog?.kind !== "rename" || !albumFilter) return;
    const nextName = dialog.value.trim();
    if (!nextName) {
      setError("专辑名称不能为空");
      return;
    }
    setBusyOp(true);
    setError(null);
    try {
      await cloud115.updateFile(albumFilter, { name: nextName });
      await albumsService.recognize({ folderId: albumFilter, folderName: nextName });
      await loadIndex();
      setDialog(null);
    } catch (reason) {
      setError(`重命名专辑失败：${String(reason)}`);
    } finally {
      setBusyOp(false);
    }
  }

  /** 移入回收站：115 会把目录放入回收站，可随时还原。 */
  async function recycleAlbum() {
    if (!albumFilter) return;
    setBusyOp(true);
    setError(null);
    try {
      await cloud115.deleteFiles([albumFilter]);
      await albumsService.removeIndex(albumFilter);
      await loadIndex();
      setAlbumFilter(null);
      setDialog(null);
    } catch (reason) {
      setError(`移入回收站失败：${String(reason)}`);
    } finally {
      setBusyOp(false);
    }
  }

  /** 仅移除本机索引，不动远程文件。 */
  async function removeAlbumIndex() {
    if (!albumFilter) return;
    setBusyOp(true);
    setError(null);
    try {
      await albumsService.removeIndex(albumFilter);
      await loadIndex();
      setAlbumFilter(null);
      setDialog(null);
    } catch (reason) {
      setError(`移除索引失败：${String(reason)}`);
    } finally {
      setBusyOp(false);
    }
  }

  const currentPhoto = reader ? reader.photos[reader.index] : null;
  const previewUrl = reader
    ? (reader.fullUrl && !reader.fullFailed ? reader.fullUrl : currentPhoto?.thumbUrl ?? "")
    : "";

  // AI 对话面板的页面上下文：视图/专辑/月份/预览照片随渲染更新；注册一次，读取引用取最新值。
  const pageContextRef = useRef<AiPageContext | null>(null);
  pageContextRef.current = {
    page: "albums",
    scope: "相册",
    detail: [
      tab === "timeline" ? "时间线" : "专辑",
      filteredAlbum?.folderName,
      activeMonthKey ? monthLabel(activeMonthKey) : null,
    ]
      .filter(Boolean)
      .join(" · ") || undefined,
    loaded: shelf ? `${visiblePhotos.length} / ${shelf.photoCount}` : undefined,
    viewMode: tab,
    albumName: filteredAlbum?.folderName,
    currentMonth: activeMonthKey ? monthLabel(activeMonthKey) : undefined,
    photoName: currentPhoto?.name,
    photoPosition: reader ? `${reader.index + 1} / ${reader.photos.length}` : undefined,
  };

  useEffect(() => {
    registerViewPageContext(() => pageContextRef.current);
    return () => registerViewPageContext(null);
  }, []);

  // 上下文随渲染更新（切视图、选专辑、滚动跨月、预览翻张）；通知 AI 面板刷新标签。
  useEffect(() => {
    notifyPageContextChanged();
  });

  const timelineEmpty =
    shelf !== null && tab === "timeline" && visibleMonths.length === 0;
  const notIndexed = timelineEmpty && !albumFilter && (shelf?.folderCount ?? 0) === 0;

  return (
    <section className="page-section albums-view">
      <div className="section-heading">
        <div>
          <span className="context-label">照片索引</span>
          <h2>相册</h2>
        </div>
        <div className="comics-toolbar">
          <select
            value={folderId}
            aria-label="选择识别目录"
            onChange={(event) => setFolderId(event.currentTarget.value)}
          >
            <option value={ROOT_ID}>网盘根目录</option>
            {rootFolders.map((folder) => (
              <option key={folder.id} value={folder.id}>{folder.name}</option>
            ))}
          </select>
          <button className="primary-action" disabled={recognizing || indexing} onClick={() => void recognize()}>
            <Icon name="images" size={15} />
            {recognizing ? "正在识别…" : "识别目录"}
          </button>
          <button
            className="secondary-action"
            disabled={recognizing || indexing}
            title="依次索引网盘根目录下的全部文件夹（单次上限 20 个）"
            onClick={() => void indexAllRoots()}
          >
            {indexing ? "正在批量索引…" : "批量索引根目录"}
          </button>
        </div>
      </div>

      {error && shelf && <div className="cloud-inline-error" role="alert">{error}</div>}

      {shelf && (
        <>
          <div className="albums-toolbar">
            <div className="segmented-control" aria-label="相册视图切换">
              <button className={tab === "timeline" ? "active" : ""} onClick={() => setTab("timeline")}>
                时间线
              </button>
              <button className={tab === "albums" ? "active" : ""} onClick={() => setTab("albums")}>
                专辑
              </button>
            </div>
            <div className="albums-toolbar-side">
              <span className="albums-stats">
                {shelf.folderCount} 个目录 · {shelf.photoCount} 张照片
                {albumFilter && filteredAlbum ? ` · ${filteredAlbum.folderName}` : ""}
              </span>
              <div className="segmented-control albums-density" role="group" aria-label="照片网格密度">
                {DENSITY_ORDER.map((option) => (
                  <button
                    key={option}
                    className={density === option ? "active" : ""}
                    aria-pressed={density === option}
                    title={`照片网格密度：${DENSITY_LABELS[option]}`}
                    onClick={() => setDensity(option)}
                  >
                    {DENSITY_LABELS[option]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {filteredAlbum && filteredAlbum.folderId !== ROOT_ID && (
            <div className="albums-actions" role="toolbar" aria-label="专辑整理操作">
              <span>已选专辑：{filteredAlbum.folderName}</span>
              <div className="albums-actions-tools">
                <div className="albums-more-wrap" ref={moreWrapRef}>
                  <button
                    className="albums-more"
                    aria-label={`专辑「${filteredAlbum.folderName}」的更多操作`}
                    aria-expanded={albumMenuOpen}
                    onClick={() => setAlbumMenuOpen((current) => !current)}
                  >
                    <Icon name="more" size={15} />
                    更多
                  </button>
                  {albumMenuOpen && (
                    <div className="albums-more-menu" role="menu" aria-label="专辑整理操作">
                      <button
                        role="menuitem"
                        disabled={busyOp}
                        onClick={() => {
                          setDialog({ kind: "rename", value: filteredAlbum.folderName });
                          setAlbumMenuOpen(false);
                        }}
                      >
                        <Icon name="edit" size={14} />
                        重命名
                      </button>
                      <button
                        role="menuitem"
                        className="danger"
                        disabled={busyOp}
                        onClick={() => {
                          setDialog({ kind: "recycle" });
                          setAlbumMenuOpen(false);
                        }}
                      >
                        <Icon name="trash" size={14} />
                        移入回收站
                      </button>
                      <button
                        role="menuitem"
                        disabled={busyOp}
                        onClick={() => {
                          setDialog({ kind: "remove" });
                          setAlbumMenuOpen(false);
                        }}
                      >
                        <Icon name="folder" size={14} />
                        仅移除本机索引
                      </button>
                    </div>
                  )}
                </div>
                <button disabled={busyOp} onClick={() => setAlbumFilter(null)}>取消选择</button>
              </div>
            </div>
          )}

          {tab === "timeline" && (
            timelineEmpty ? (
              notIndexed ? (
                <div className="empty-state">
                  <Icon name="images" size={24} />
                  <h2>还没有照片索引</h2>
                  <p>选择目录识别，或批量索引根目录；自动下探两层子目录（适配手机备份结构），时间线按文件时间分月展示。</p>
                </div>
              ) : albumFilter ? (
                <div className="empty-state">
                  <Icon name="images" size={24} />
                  <h2>该专辑在当前索引中没有照片</h2>
                  <p>专辑“{filteredAlbum?.folderName}”按当前索引快照没有可展示的照片；可重新识别该目录，或返回全部时间线。</p>
                  <div className="albums-empty-actions">
                    <button className="secondary-action" onClick={() => setAlbumFilter(null)}>取消筛选</button>
                  </div>
                </div>
              ) : (
                <div className="empty-state">
                  <Icon name="images" size={24} />
                  <h2>已索引的目录中没有照片</h2>
                  <p>已索引目录的快照中未发现图片文件；可换一个目录重新识别。</p>
                </div>
              )
            ) : (
              <div className="albums-body" data-density={density}>
                <div className="albums-timeline-layout">
                  <div className="albums-timeline">
                    {visibleMonths.map((month) => (
                      <section
                        key={month.monthKey}
                        className="albums-month"
                        aria-label={monthLabel(month.monthKey)}
                        ref={setMonthRef(month.monthKey)}
                      >
                        <header className="albums-month-head">
                          <h3>{monthLabel(month.monthKey)}</h3>
                          <span>{month.photoCount} 张</span>
                        </header>
                        <div className="albums-photo-grid">
                          {month.photos.map((photo) => (
                            <button
                              key={photo.fileId}
                              className="albums-photo-tile"
                              aria-label={`预览 ${photo.name}`}
                              title={`${photo.name} · ${new Date(photo.takenAt * 1000).toLocaleDateString("zh-CN")} · ${formatBytes(photo.sizeBytes)}`}
                              onClick={() => void openPreview(visiblePhotos, photoIndexById.get(photo.fileId) ?? 0)}
                            >
                              <FileThumbnail
                                src={photo.thumbUrl}
                                kind="image"
                                size={120}
                                iconSize={32}
                                className="albums-tile-thumb"
                              />
                              <span className="albums-tile-meta" aria-hidden="true">
                                <span className="albums-tile-name">{photo.name}</span>
                                <time>{new Date(photo.takenAt * 1000).toLocaleDateString("zh-CN")}</time>
                              </span>
                            </button>
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                  <AlbumMonthNav
                    months={visibleMonths.map((month) => ({ monthKey: month.monthKey, photoCount: month.photoCount }))}
                    activeMonthKey={activeMonthKey}
                    onNavigate={navigateToMonth}
                  />
                </div>
              </div>
            )
          )}

          {tab === "albums" &&
            (visibleAlbums.length === 0 ? (
              <div className="empty-state">
                <Icon name="images" size={24} />
                <h2>还没有专辑</h2>
                <p>每个已索引的目录会自动成为一个专辑。</p>
              </div>
            ) : (
              <div className="albums-grid">
                {visibleAlbums.map((album) => (
                  <button
                    key={album.folderId}
                    className={albumFilter === album.folderId ? "albums-card selected" : "albums-card"}
                    onClick={() => {
                      const next = albumFilter === album.folderId ? null : album.folderId;
                      setAlbumFilter(next);
                      setAlbumMenuOpen(false);
                      if (next) setTab("timeline");
                    }}
                  >
                    <FileThumbnail
                      src={album.coverUrl}
                      kind="image"
                      iconSize={64}
                      className="album-cover-thumbnail"
                    />
                    <strong>{album.folderName}</strong>
                    <small>{album.photoCount} 张照片</small>
                  </button>
                ))}
              </div>
            ))}
        </>
      )}

      {!shelf && !error && (
        <div className="empty-state albums-empty" aria-live="polite">
          <Icon name="images" size={24} />
          <h2>正在读取相册时间线</h2>
          <p>识别或批量索引后，这里会按月份展示照片缩略图墙。</p>
        </div>
      )}

      {!shelf && error && (
        <div className="empty-state albums-empty">
          <Icon name="alert" size={24} />
          <h2>相册索引读取失败</h2>
          <p>{error}</p>
          <div className="albums-empty-actions">
            <button className="secondary-action" onClick={retryLoadIndex}>
              <Icon name="refresh" size={14} />
              重试
            </button>
          </div>
        </div>
      )}

      {reader && currentPhoto && (
        <div className="albums-preview" role="dialog" aria-modal="true" aria-label={`照片预览：${currentPhoto.name}`}>
          <header className="albums-preview-bar">
            <strong title={currentPhoto.name}>{currentPhoto.name}</strong>
            <span className="albums-preview-count">
              {reader.index + 1} / {reader.photos.length}
            </span>
            <div className="albums-preview-tools" role="group" aria-label="缩放控制">
              <button className={zoom === "fit" ? "active" : ""} onClick={() => setZoom("fit")}>适应窗口</button>
              <button
                aria-label="缩小"
                disabled={zoom === "fit" || zoom <= MIN_ZOOM}
                onClick={() => setZoom((current) => stepZoom(current, -1))}
              >
                −
              </button>
              <button
                className="albums-preview-zoom-label"
                title="点击恢复 100%"
                onClick={() => setZoom(1)}
              >
                {zoom === "fit" ? "适应" : `${Math.round(zoom * 100)}%`}
              </button>
              <button
                aria-label="放大"
                disabled={zoom !== "fit" && zoom >= MAX_ZOOM}
                onClick={() => setZoom((current) => stepZoom(current, 1))}
              >
                +
              </button>
            </div>
            <button className="albums-preview-close" onClick={closePreview}>
              <Icon name="close" size={15} />
              关闭
            </button>
          </header>
          <div className="albums-preview-stage-wrap">
            <div
              className={`albums-preview-stage${zoom !== "fit" ? " zoomed" : ""}${dragging ? " dragging" : ""}`}
              ref={stageRef}
              onPointerDown={handleStagePointerDown}
              onPointerMove={handleStagePointerMove}
              onPointerUp={handleStagePointerEnd}
              onPointerCancel={handleStagePointerEnd}
            >
              {previewUrl ? (
                <img
                  className={zoom === "fit" ? "" : "zoomed"}
                  src={previewUrl}
                  alt={currentPhoto.name}
                  referrerPolicy="no-referrer"
                  draggable={false}
                  onLoad={handleStageImgLoad}
                  onError={() =>
                    setReader((current) =>
                      current && current.fullUrl && !current.fullFailed
                        ? { ...current, fullUrl: null, fullFailed: true, fullLoading: false }
                        : current,
                    )
                  }
                  style={zoom !== "fit" && fullNatural ? { width: `${Math.round(fullNatural.width * zoom)}px` } : undefined}
                />
              ) : (
                <div className="albums-preview-fallback">
                  <FileTypeIcon kind="image" size={72} />
                </div>
              )}
            </div>
            {reader.fullLoading && <span className="albums-preview-note">正在加载原图…</span>}
            {reader.fullFailed && (
              <span className="albums-preview-note albums-preview-note-failed">
                原图直链加载失败，正在显示缩略图
                <button onClick={() => void retryFullSource()}>
                  <Icon name="refresh" size={12} />
                  重试
                </button>
              </span>
            )}
          </div>
          <div className="albums-preview-strip" aria-label="照片缩略图条">
            {reader.photos.map((photo, index) => (
              <button
                key={photo.fileId}
                ref={index === reader.index ? activeStripItemRef : undefined}
                className={index === reader.index ? "active" : ""}
                aria-label={`查看 ${photo.name}`}
                aria-current={index === reader.index ? "true" : undefined}
                title={photo.name}
                onClick={() => void openPreview(reader.photos, index)}
              >
                <FileThumbnail src={photo.thumbUrl} kind="image" size={44} iconSize={26} />
              </button>
            ))}
          </div>
          <div className="albums-preview-nav">
            <button disabled={reader.index === 0} onClick={() => changePhoto(-1)}>上一张</button>
            <button
              disabled={reader.index >= reader.photos.length - 1}
              onClick={() => changePhoto(1)}
            >
              下一张
            </button>
          </div>
        </div>
      )}

      {dialog?.kind === "rename" && (
        <div className="cloud-operation-backdrop" onPointerDown={(event) => event.target === event.currentTarget && !busyOp && setDialog(null)}>
          <form
            className="cloud-operation-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void renameAlbum();
            }}
          >
            <strong>重命名专辑</strong>
            <span>将同时重命名 115 网盘中的目录并刷新本机索引。</span>
            <input
              autoFocus
              value={dialog.value}
              onChange={(event) => setDialog({ kind: "rename", value: event.currentTarget.value })}
            />
            <div>
              <button type="button" className="secondary-action" disabled={busyOp} onClick={() => setDialog(null)}>取消</button>
              <button type="submit" className="primary-action" disabled={busyOp || !dialog.value.trim()}>保存</button>
            </div>
          </form>
        </div>
      )}
      {dialog?.kind === "recycle" && (
        <div className="cloud-operation-backdrop" onPointerDown={(event) => event.target === event.currentTarget && !busyOp && setDialog(null)}>
          <section className="cloud-operation-dialog">
            <strong>移入回收站？</strong>
            <span>专辑目录“{filteredAlbum?.folderName}”及其内照片将从 115 网盘移入回收站，可随时还原；本机索引会一并移除。</span>
            <div>
              <button className="secondary-action" disabled={busyOp} onClick={() => setDialog(null)}>取消</button>
              <button className="danger-action" disabled={busyOp} onClick={() => void recycleAlbum()}>{busyOp ? "正在处理" : "移入回收站"}</button>
            </div>
          </section>
        </div>
      )}
      {dialog?.kind === "remove" && (
        <div className="cloud-operation-backdrop" onPointerDown={(event) => event.target === event.currentTarget && !busyOp && setDialog(null)}>
          <section className="cloud-operation-dialog">
            <strong>仅移除本机索引？</strong>
            <span>“{filteredAlbum?.folderName}”将从相册时间线中消失，115 网盘中的照片不受影响；重新识别即可恢复。</span>
            <div>
              <button className="secondary-action" disabled={busyOp} onClick={() => setDialog(null)}>取消</button>
              <button className="primary-action" disabled={busyOp} onClick={() => void removeAlbumIndex()}>移除索引</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
