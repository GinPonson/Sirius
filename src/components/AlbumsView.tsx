import { useEffect, useState } from "react";
import {
  AlbumsService,
  type AlbumFolderInput,
  type AlbumsIndexSummary,
  type AlbumPhoto,
} from "../services/albumsServices";
import { Cloud115Service, type Cloud115FileEntry } from "../services/mediaServices";
import { Icon } from "./Icon";

const albumsService = new AlbumsService();
const cloud115 = new Cloud115Service();

const ROOT_ID = "0";

/** 将字节数格式化为紧凑容量；与网盘文件页保持一致的展示规则。 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

/** 将月份键（UTC YYYY-MM）渲染为本地年月标签。 */
function monthLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || !month) return monthKey;
  return `${year} 年 ${month} 月`;
}

type ReaderState = {
  photos: AlbumPhoto[];
  index: number;
  /** 短时效原图直链；加载失败时回退缩略图。 */
  fullUrl: string | null;
  fullFailed: boolean;
};

type DialogState =
  | { kind: "rename"; value: string }
  | { kind: "recycle" }
  | { kind: "remove" }
  | null;

/** 相册模式：照片索引 → 时间线/专辑 → 预览大图与专辑整理。整理操作全部走 115 回收站语义。 */
export function AlbumsView() {
  const [rootFolders, setRootFolders] = useState<Cloud115FileEntry[]>([]);
  const [folderId, setFolderId] = useState(ROOT_ID);
  const [recognizing, setRecognizing] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [shelf, setShelf] = useState<AlbumsIndexSummary | null>(null);
  const [tab, setTab] = useState<"timeline" | "albums">("timeline");
  const [albumFilter, setAlbumFilter] = useState<string | null>(null);
  const [reader, setReader] = useState<ReaderState | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busyOp, setBusyOp] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function loadIndex() {
    setShelf(await albumsService.index());
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
      await albumsService.recognize({ folderId, folderName });
      await loadIndex();
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
      await albumsService.indexFolders(folders);
      await loadIndex();
    } catch (reason) {
      setError(`批量索引失败：${String(reason)}`);
    } finally {
      setIndexing(false);
    }
  }

  const visibleMonths = (shelf?.months ?? []).filter(
    (month) => !albumFilter || month.photos.some((photo) => photo.folderId === albumFilter),
  );
  const visiblePhotos = visibleMonths.flatMap((month) => month.photos);
  const visibleAlbums = albumFilter
    ? (shelf?.albums ?? []).filter((album) => album.folderId === albumFilter)
    : shelf?.albums ?? [];
  const filteredAlbum = albumFilter
    ? (shelf?.albums ?? []).find((album) => album.folderId === albumFilter)
    : null;

  /** 打开预览：先显示缩略图，后台解析原图直链并在加载成功后切换。 */
  async function openPreview(photos: AlbumPhoto[], index: number) {
    const photo = photos[index];
    setReader({ photos, index, fullUrl: null, fullFailed: false });
    try {
      const source = await cloud115.downloadSource(photo.pickCode);
      setReader((current) =>
        current && current.photos[index]?.fileId === photo.fileId
          ? { ...current, fullUrl: source.url }
          : current,
      );
    } catch {
      // 直链解析失败时保留缩略图预览，不打断浏览。
      setReader((current) =>
        current && current.photos[index]?.fileId === photo.fileId
          ? { ...current, fullFailed: true }
          : current,
      );
    }
  }

  function changePhoto(delta: number) {
    setReader((current) => {
      if (!current) return current;
      const next = Math.min(Math.max(0, current.index + delta), current.photos.length - 1);
      if (next === current.index) return current;
      void openPreview(current.photos, next);
      return { ...current, index: next, fullUrl: null, fullFailed: false };
    });
  }

  function closePreview() {
    setReader(null);
  }

  useEffect(() => {
    if (!reader) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "ArrowRight") changePhoto(1);
      else if (event.key === "ArrowLeft") changePhoto(-1);
      else if (event.key === "Escape") closePreview();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [reader]);

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

      {error && <div className="cloud-inline-error" role="alert">{error}</div>}

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
            <span className="albums-stats">
              {shelf.folderCount} 个目录 · {shelf.photoCount} 张照片
              {albumFilter && filteredAlbum ? ` · ${filteredAlbum.folderName}` : ""}
            </span>
          </div>

          {filteredAlbum && filteredAlbum.folderId !== ROOT_ID && (
            <div className="albums-actions" role="toolbar" aria-label="专辑整理操作">
              <span>已选专辑：{filteredAlbum.folderName}</span>
              <div>
                <button disabled={busyOp} onClick={() => setDialog({ kind: "rename", value: filteredAlbum.folderName })}>重命名</button>
                <button className="danger" disabled={busyOp} onClick={() => setDialog({ kind: "recycle" })}>移入回收站</button>
                <button disabled={busyOp} onClick={() => setDialog({ kind: "remove" })}>仅移除本机索引</button>
                <button disabled={busyOp} onClick={() => setAlbumFilter(null)}>取消选择</button>
              </div>
            </div>
          )}

          {tab === "timeline" &&
            (visibleMonths.length === 0 ? (
              <div className="empty-state">
                <Icon name="images" size={24} />
                <h2>还没有照片索引</h2>
                <p>选择目录识别，或批量索引根目录；自动下探两层子目录（适配手机备份结构），时间线按文件时间分月展示。</p>
              </div>
            ) : (
              <div className="albums-timeline">
                {visibleMonths.map((month) => (
                  <section key={month.monthKey} className="albums-month" aria-label={monthLabel(month.monthKey)}>
                    <header className="albums-month-head">
                      <h3>{monthLabel(month.monthKey)}</h3>
                      <span>{month.photoCount} 张</span>
                    </header>
                    <ul className="albums-photo-list">
                      {month.photos.map((photo) => {
                        const photoIndex = visiblePhotos.findIndex(
                          (item) => item.fileId === photo.fileId,
                        );
                        return (
                          <li key={photo.fileId}>
                            <button
                              className="albums-photo-row"
                              onClick={() => void openPreview(visiblePhotos, photoIndex)}
                            >
                              {photo.thumbUrl ? (
                                <img
                                  className="albums-photo-thumb"
                                  src={photo.thumbUrl}
                                  alt=""
                                  referrerPolicy="no-referrer"
                                  loading="lazy"
                                />
                              ) : (
                                <span className="albums-photo-icon"><Icon name="images" size={15} /></span>
                              )}
                              <span className="albums-photo-name">{photo.name}</span>
                              <time>{new Date(photo.takenAt * 1000).toLocaleDateString("zh-CN")}</time>
                              <small>{formatBytes(photo.sizeBytes)}</small>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            ))}

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
                      if (next) setTab("timeline");
                    }}
                  >
                    {album.coverUrl ? (
                      <img
                        className="albums-cover"
                        src={album.coverUrl}
                        alt=""
                        referrerPolicy="no-referrer"
                        loading="lazy"
                      />
                    ) : (
                      <span className="albums-cover-fallback" aria-hidden="true">
                        <Icon name="images" size={20} />
                      </span>
                    )}
                    <strong>{album.folderName}</strong>
                    <small>{album.photoCount} 张照片</small>
                  </button>
                ))}
              </div>
            ))}
        </>
      )}

      {!shelf && !error && (
        <div className="empty-state albums-empty">
          <Icon name="images" size={24} />
          <h2>正在读取相册时间线</h2>
          <p>识别或批量索引后，这里会按月份展示照片时间线。</p>
        </div>
      )}

      {reader && currentPhoto && (
        <div className="albums-preview" role="dialog" aria-modal="true" aria-label="照片预览">
          <header className="comics-reader-bar">
            <strong>{currentPhoto.name}</strong>
            <span>
              {reader.index + 1} / {reader.photos.length}
            </span>
            <button onClick={closePreview}>
              <Icon name="close" size={15} />
              关闭
            </button>
          </header>
          <div className="comics-reader-stage">
            {reader.fullUrl && !reader.fullFailed ? (
              <img
                src={reader.fullUrl}
                alt={currentPhoto.name}
                referrerPolicy="no-referrer"
                onError={() => setReader((current) => current ? { ...current, fullFailed: true } : current)}
              />
            ) : (
              <img
                src={currentPhoto.thumbUrl ?? ""}
                alt={currentPhoto.name}
                referrerPolicy="no-referrer"
              />
            )}
            {reader.fullFailed && (
              <span className="albums-preview-note">原图直链加载失败，正在显示缩略图</span>
            )}
          </div>
          <div className="comics-reader-nav">
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
