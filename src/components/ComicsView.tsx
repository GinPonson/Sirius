import { useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  ComicsService,
  type ComicSession,
  type ComicsIndexSummary,
  type ComicsSeriesGroup,
  type ComicsVolume,
} from "../services/comicsServices";
import { Cloud115Service, type Cloud115FileEntry } from "../services/mediaServices";
import { FileThumbnail } from "./FileThumbnail";
import { FileTypeIcon } from "./FileTypeIcon";
import { Icon } from "./Icon";

const comicsService = new ComicsService();
const cloud115 = new Cloud115Service();

const ROOT_ID = "0";

/** 阅读器当前支持的格式；与 Rust 侧 READER_EXTENSIONS 保持一致，仅识别不可读的卷不提供假按钮。 */
const READER_EXTENSIONS = new Set(["cbz", "zip"]);

function isReaderSupported(name: string): boolean {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return READER_EXTENSIONS.has(extension);
}

/** 将字节数格式化为紧凑容量；与网盘文件页保持一致的展示规则。 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

/** 自然排序：数字段按数值比较，保证 第2卷 排在 第10卷 之前。 */
function naturalCompare(a: string, b: string): number {
  const aParts = a.split(/(\d+)/);
  const bParts = b.split(/(\d+)/);
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const left = aParts[index];
    const right = bParts[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (index % 2 === 1) {
      const delta = Number(left) - Number(right);
      if (delta !== 0) return delta;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

/** 卷号展示：优先取文件名中的「第N卷」，否则按系列内顺序编号。 */
function volumeLabel(name: string, position: number): string {
  const match = name.match(/第\s*(\d+)\s*[卷话話回]/);
  return match ? `第 ${Number(match[1])} 卷` : `第 ${position + 1} 卷`;
}

/** 页图/封面地址解析：data-URI 等自包含地址原样使用，本机缓存路径走 Tauri asset 协议。 */
function resolveMediaSrc(path: string): string {
  return /^(data|blob|https?):/.test(path) ? path : convertFileSrc(path);
}

// ---------------------------------------------------------------------------
// 在读进度镜像：Rust 侧 comics_save_progress 是续读的唯一事实源；
// 这里保存一份本机显示缓存（读写进度成功时同步写入），供书架卡片展示在读卷与页码。
// ---------------------------------------------------------------------------

type VolumeProgress = {
  pageIndex: number;
  pageCount: number;
  volumeName: string;
  updatedAt: number;
};

const PROGRESS_KEY = "sirius-comics-progress";
/** 有界显示缓存：只保留最近 60 卷的进度记录。 */
const PROGRESS_LIMIT = 60;

function loadProgressMap(): Record<string, VolumeProgress> {
  try {
    const raw = window.localStorage.getItem(PROGRESS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const map: Record<string, VolumeProgress> = {};
    for (const [fileId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = value as Partial<VolumeProgress> | null;
      if (
        record &&
        typeof record.pageIndex === "number" &&
        typeof record.pageCount === "number" &&
        typeof record.volumeName === "string" &&
        record.pageCount > 0
      ) {
        map[fileId] = {
          pageIndex: Math.max(0, Math.min(record.pageIndex, record.pageCount - 1)),
          pageCount: record.pageCount,
          volumeName: record.volumeName,
          updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
        };
      }
    }
    return map;
  } catch {
    // 存储不可用或数据损坏时按空缓存处理；续读仍以 Rust 侧记录为准。
    return {};
  }
}

function persistProgressMap(map: Record<string, VolumeProgress>): void {
  try {
    const entries = Object.entries(map)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, PROGRESS_LIMIT);
    window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // 存储不可用时保持内存态即可。
  }
}

type ReaderState = { session: ComicSession; volumeIndex: number; volumeName: string; pageIndex: number };
type OpenFailure = { groupTitle: string; volume: ComicsVolume; volumeIndex: number; message: string };

/** 漫画模式：识别 → 持久化索引 → 书架封面 → 阅读器；索引、封面与进度只存在于本机。 */
export function ComicsView() {
  const [rootFolders, setRootFolders] = useState<Cloud115FileEntry[]>([]);
  const [folderId, setFolderId] = useState(ROOT_ID);
  const [recognizing, setRecognizing] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [shelf, setShelf] = useState<ComicsIndexSummary | null>(null);
  const [openTitle, setOpenTitle] = useState<string | null>(null);
  const [openingVolume, setOpeningVolume] = useState<string | null>(null);
  const [openFailure, setOpenFailure] = useState<OpenFailure | null>(null);
  const [reader, setReader] = useState<ReaderState | null>(null);
  const [readerError, setReaderError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progressMap, setProgressMap] = useState<Record<string, VolumeProgress>>(loadProgressMap);

  useEffect(() => {
    let active = true;
    cloud115.listFiles(ROOT_ID, "", 0, 100)
      .then((page) => {
        if (active) setRootFolders(page.entries.filter((entry) => entry.kind === "folder"));
      })
      .catch((reason) => active && setError(`读取网盘目录失败：${String(reason)}`));
    comicsService.index()
      .then((summary) => active && setShelf(summary))
      .catch((reason) => active && setError(`读取漫画书架失败：${String(reason)}`));
    return () => {
      active = false;
    };
  }, []);

  // 卷序按自然排序稳定展示；下一卷判定与展示共用同一顺序。
  const sortedSeries = useMemo<ComicsSeriesGroup[]>(
    () =>
      (shelf?.series ?? []).map((group) => ({
        ...group,
        volumes: [...group.volumes].sort((a, b) => naturalCompare(a.name, b.name)),
      })),
    [shelf],
  );

  async function loadIndex() {
    setShelf(await comicsService.index());
  }

  async function recognize() {
    setRecognizing(true);
    setError(null);
    try {
      await comicsService.recognize(folderId);
      await loadIndex();
      setOpenTitle(null);
    } catch (reason) {
      setError(`漫画识别失败：${String(reason)}`);
    } finally {
      setRecognizing(false);
    }
  }

  /** 批量索引全部根目录；Rust 侧单次上限 20 个目录并顺序限速。 */
  async function indexAllRoots() {
    const folderIds = rootFolders.map((folder) => folder.id);
    if (folderIds.length === 0) {
      setError("网盘根目录下没有可索引的文件夹");
      return;
    }
    setIndexing(true);
    setError(null);
    try {
      await comicsService.indexFolders(folderIds);
      await loadIndex();
      setOpenTitle(null);
    } catch (reason) {
      setError(`批量索引失败：${String(reason)}`);
    } finally {
      setIndexing(false);
    }
  }

  /** 保存进度并同步书架显示缓存；续读事实源始终是 Rust 侧记录。 */
  function recordProgress(session: ComicSession, pageIndex: number, volumeName: string) {
    setProgressMap((current) => {
      const next = {
        ...current,
        [session.fileId]: {
          pageIndex,
          pageCount: session.pageCount,
          volumeName,
          updatedAt: Date.now(),
        },
      };
      persistProgressMap(next);
      return next;
    });
  }

  async function openReader(groupTitle: string, volume: ComicsVolume, volumeIndex: number) {
    setOpeningVolume(volume.fileId);
    setError(null);
    try {
      const session = await comicsService.openVolume({
        fileId: volume.fileId,
        pickCode: volume.pickCode,
        fileName: volume.name,
        seriesTitle: groupTitle,
        sizeBytes: volume.sizeBytes,
      });
      setReader({ session, volumeIndex, volumeName: volume.name, pageIndex: session.resumePageIndex });
      setReaderError(null);
      // 打开成功后刷新书架：首次阅读会生成本机封面缓存，索引据此补齐封面路径。
      void comicsService.index().then((summary) => setShelf(summary)).catch(() => undefined);
    } catch (reason) {
      setOpenFailure({
        groupTitle,
        volume,
        volumeIndex,
        message: String(reason),
      });
    } finally {
      setOpeningVolume(null);
    }
  }

  /** 翻页并保存进度；保存失败只提示，不阻断阅读。 */
  function changePage(delta: number) {
    setReader((current) => {
      if (!current) return current;
      const nextIndex = Math.min(
        Math.max(0, current.pageIndex + delta),
        current.session.pageCount - 1,
      );
      if (nextIndex === current.pageIndex) return current;
      comicsService
        .saveProgress(current.session.fileId, nextIndex, current.session.pageCount)
        .then(() => recordProgress(current.session, nextIndex, current.volumeName))
        .catch((reason) => setReaderError(`保存阅读进度失败：${String(reason)}`));
      return { ...current, pageIndex: nextIndex };
    });
  }

  function closeReader() {
    setReader((current) => {
      if (current) {
        comicsService
          .saveProgress(current.session.fileId, current.pageIndex, current.session.pageCount)
          .then(() => recordProgress(current.session, current.pageIndex, current.volumeName))
          .catch((reason) => setError(`保存阅读进度失败：${String(reason)}`));
      }
      return null;
    });
    setReaderError(null);
  }

  useEffect(() => {
    if (!reader) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "ArrowRight") changePage(1);
      else if (event.key === "ArrowLeft") changePage(-1);
      else if (event.key === "Escape") closeReader();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [reader]);

  /** 系列内最新在读的卷；用于书架卡片上的进度角标。 */
  function latestSeriesProgress(group: ComicsSeriesGroup) {
    let best: { volume: ComicsVolume; volumeIndex: number; progress: VolumeProgress } | null = null;
    for (let volumeIndex = 0; volumeIndex < group.volumes.length; volumeIndex += 1) {
      const volume = group.volumes[volumeIndex];
      const progress = progressMap[volume.fileId];
      if (progress && (!best || progress.updatedAt > best.progress.updatedAt)) {
        best = { volume, volumeIndex, progress };
      }
    }
    return best;
  }

  const busy = recognizing || indexing;

  return (
    <section className="page-section comics-view">
      <div className="section-heading">
        <div>
          <span className="context-label">识别与索引</span>
          <h2>漫画</h2>
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
          <button className="primary-action" disabled={busy} onClick={() => void recognize()}>
            <Icon name="book" size={15} />
            {recognizing ? "正在识别…" : "识别目录"}
          </button>
          <button
            className="secondary-action"
            disabled={busy}
            title="依次索引网盘根目录下的全部文件夹（单次上限 20 个）"
            onClick={() => void indexAllRoots()}
          >
            {indexing ? "正在批量索引…" : "批量索引根目录"}
          </button>
        </div>
      </div>

      {error && <div className="cloud-inline-error" role="alert">{error}</div>}

      {shelf && (
        <>
          <p className="comics-stats">
            {busy
              ? recognizing
                ? "正在识别所选目录…"
                : "正在批量索引根目录…"
              : `已索引 ${shelf.folderCount} 个目录 · ${sortedSeries.length} 个系列${shelf.lastScannedAt ? ` · 最近扫描 ${shelf.lastScannedAt}` : ""}`}
          </p>
          {sortedSeries.length === 0 ? (
            shelf.folderCount === 0 ? (
              <div className="empty-state comics-empty">
                <Icon name="book" size={24} />
                <h2>还没有识别过任何目录</h2>
                <p>在上方选择目录点击「识别目录」，或直接「批量索引根目录」；识别支持 cbz / zip / cbr / rar / 7z 压缩包。</p>
              </div>
            ) : (
              <div className="empty-state comics-empty">
                <Icon name="folder" size={24} />
                <h2>已索引 {shelf.folderCount} 个目录，但没有找到压缩包漫画</h2>
                <p>这些目录里没有 cbz / zip / cbr / rar / 7z 压缩包；请把漫画压缩包放入目录后重新识别。</p>
              </div>
            )
          ) : (
            <div className="comics-grid">
              {sortedSeries.flatMap((group) => {
                const expanded = openTitle === group.title;
                const cover = group.volumes.find((volume) => volume.coverPath)?.coverPath ?? null;
                const reading = latestSeriesProgress(group);
                return [
                  <article
                    key={group.title}
                    className={expanded ? "comics-card open" : "comics-card"}
                  >
                    <button
                      className="comics-card-head"
                      aria-expanded={expanded}
                      onClick={() => {
                        setOpenTitle(expanded ? null : group.title);
                        setOpenFailure(null);
                      }}
                    >
                      <span className="comics-card-cover">
                        <FileThumbnail
                          src={cover ? resolveMediaSrc(cover) : null}
                          kind="ebook"
                          size={220}
                          iconSize={56}
                        />
                        {reading && (
                          <span className="comics-card-progress">
                            在读 {volumeLabel(reading.volume.name, reading.volumeIndex)} ·{" "}
                            {reading.progress.pageIndex + 1}/{reading.progress.pageCount}
                          </span>
                        )}
                      </span>
                      <span className="comics-card-body">
                        <strong className="comics-card-title">{group.title}</strong>
                        <small className="comics-card-meta">
                          {group.volumeCount} 卷 · {formatBytes(group.totalBytes)}
                        </small>
                      </span>
                      <span className="comics-card-chevron" aria-hidden="true">
                        <Icon name="chevron" size={14} />
                      </span>
                    </button>
                  </article>,
                  expanded && (
                    <section key={`${group.title}-panel`} className="comics-series-panel" aria-label={`《${group.title}》卷列表`}>
                      {openFailure && openFailure.groupTitle === group.title && (
                        <div className="comics-open-failure" role="alert">
                          <Icon name="alert" size={16} />
                          <div>
                            <strong>打开《{openFailure.volume.name}》失败</strong>
                            <p>{openFailure.message}</p>
                          </div>
                          <button
                            className="comics-retry"
                            disabled={openingVolume === openFailure.volume.fileId}
                            onClick={() =>
                              void openReader(openFailure.groupTitle, openFailure.volume, openFailure.volumeIndex)
                            }
                          >
                            {openingVolume === openFailure.volume.fileId ? "正在重试…" : "重试"}
                          </button>
                        </div>
                      )}
                      <ul className="comics-volumes">
                        {group.volumes.map((volume, volumeIndex) => {
                          const supported = isReaderSupported(volume.name);
                          const progress = progressMap[volume.fileId];
                          return (
                            <li key={volume.fileId} className={supported ? "" : "unsupported"}>
                              <span className="comics-volume-name">
                                <FileTypeIcon kind="ebook" size={24} />
                                <span className="comics-volume-title">{volume.name}</span>
                                {progress && (
                                  <span className="comics-volume-progress">
                                    在读 {progress.pageIndex + 1}/{progress.pageCount}
                                  </span>
                                )}
                              </span>
                              <div className="comics-volume-actions">
                                <small>{formatBytes(volume.sizeBytes)}</small>
                                {supported ? (
                                  <button
                                    disabled={openingVolume === volume.fileId}
                                    onClick={() => void openReader(group.title, volume, volumeIndex)}
                                  >
                                    {openingVolume === volume.fileId ? "准备中…" : "阅读"}
                                  </button>
                                ) : (
                                  <span className="comics-format-unsupported" title="阅读器目前支持 CBZ/ZIP，其余格式仅完成识别，暂不支持在线阅读">
                                    暂不支持在线阅读
                                  </span>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ),
                ];
              })}
            </div>
          )}
        </>
      )}

      {!shelf && !error && (
        <div className="empty-state comics-empty">
          <Icon name="book" size={24} />
          <h2>正在读取漫画书架</h2>
          <p>识别或批量索引后，这里会显示按系列分组的漫画书架。</p>
        </div>
      )}

      {reader && (
        <div className="comics-reader" role="dialog" aria-modal="true" aria-label="漫画阅读器">
          <header className="comics-reader-bar">
            <strong>{reader.session.seriesTitle}</strong>
            <span>
              {reader.pageIndex + 1} / {reader.session.pageCount}
            </span>
            {readerError && <span className="comics-reader-error">{readerError}</span>}
            <button onClick={closeReader}>
              <Icon name="close" size={15} />
              关闭
            </button>
          </header>
          <div className="comics-reader-stage">
            <img
              src={resolveMediaSrc(reader.session.pages[reader.pageIndex])}
              alt={`第 ${reader.pageIndex + 1} 页`}
            />
          </div>
          <div className="comics-reader-nav">
            <button disabled={reader.pageIndex === 0} onClick={() => changePage(-1)}>
              上一页
            </button>
            <button
              disabled={reader.pageIndex >= reader.session.pageCount - 1}
              onClick={() => changePage(1)}
            >
              下一页
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
