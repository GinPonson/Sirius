import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  ComicsService,
  type ComicSession,
  type ComicsIndexSummary,
  type ComicsVolume,
} from "../services/comicsServices";
import { Cloud115Service, type Cloud115FileEntry } from "../services/mediaServices";
import { FileThumbnail } from "./FileThumbnail";
import { FileTypeIcon } from "./FileTypeIcon";
import { Icon } from "./Icon";

const comicsService = new ComicsService();
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

/** 阅读器当前支持的格式；与 Rust 侧 READER_EXTENSIONS 保持一致。 */
function isReaderSupported(name: string): boolean {
  const lowered = name.toLowerCase();
  return lowered.endsWith(".cbz") || lowered.endsWith(".zip");
}

type ReaderState = { session: ComicSession; pageIndex: number };

/** 漫画模式：识别 → 持久化索引 → 书架封面 → 阅读器；索引、封面与进度只存在于本机。 */
export function ComicsView() {
  const [rootFolders, setRootFolders] = useState<Cloud115FileEntry[]>([]);
  const [folderId, setFolderId] = useState(ROOT_ID);
  const [recognizing, setRecognizing] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [shelf, setShelf] = useState<ComicsIndexSummary | null>(null);
  const [openTitle, setOpenTitle] = useState<string | null>(null);
  const [openingVolume, setOpeningVolume] = useState<string | null>(null);
  const [reader, setReader] = useState<ReaderState | null>(null);
  const [readerError, setReaderError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  async function openReader(seriesTitle: string, volume: ComicsVolume) {
    setOpeningVolume(volume.fileId);
    setReaderError(null);
    try {
      const session = await comicsService.openVolume({
        fileId: volume.fileId,
        pickCode: volume.pickCode,
        fileName: volume.name,
        seriesTitle,
        sizeBytes: volume.sizeBytes,
      });
      setReader({ session, pageIndex: session.resumePageIndex });
    } catch (reason) {
      setError(`打开《${seriesTitle}》失败：${String(reason)}`);
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
      void comicsService
        .saveProgress(current.session.fileId, nextIndex, current.session.pageCount)
        .catch((reason) => setReaderError(`保存阅读进度失败：${String(reason)}`));
      return { ...current, pageIndex: nextIndex };
    });
  }

  function closeReader() {
    setReader((current) => {
      if (current) {
        void comicsService
          .saveProgress(current.session.fileId, current.pageIndex, current.session.pageCount)
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
          <button className="primary-action" disabled={recognizing || indexing} onClick={() => void recognize()}>
            <Icon name="book" size={15} />
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
          <p className="comics-stats">
            已索引 {shelf.folderCount} 个目录 · {shelf.series.length} 个系列
            {shelf.lastScannedAt ? ` · 最近扫描 ${shelf.lastScannedAt}` : ""}
          </p>
          {shelf.series.length === 0 ? (
            <div className="empty-state">
              <Icon name="book" size={24} />
              <h2>还没有漫画索引</h2>
              <p>选择目录识别，或批量索引根目录；支持 cbz / zip / cbr / rar / 7z 压缩包。</p>
            </div>
          ) : (
            <div className="comics-grid">
              {shelf.series.map((group) => {
                const cover = group.volumes.find((volume) => volume.coverPath)?.coverPath;
                return (
                  <article
                    key={group.title}
                    className={openTitle === group.title ? "comics-card open" : "comics-card"}
                  >
                    <button
                      className="comics-card-head"
                      aria-expanded={openTitle === group.title}
                      onClick={() => setOpenTitle(openTitle === group.title ? null : group.title)}
                    >
                      <FileThumbnail
                        src={cover ? convertFileSrc(cover) : null}
                        kind="ebook"
                        size={44}
                        iconSize={40}
                        className="comic-cover-thumbnail"
                      />
                      <div>
                        <strong>{group.title}</strong>
                        <small>
                          {group.volumeCount} 卷 · {formatBytes(group.totalBytes)}
                        </small>
                      </div>
                      <Icon name="chevron" size={15} />
                    </button>
                    {openTitle === group.title && (
                      <ul className="comics-volumes">
                        {group.volumes.map((volume) => (
                          <li key={volume.fileId}>
                            <span className="comics-volume-name">
                              <FileTypeIcon kind="ebook" size={24} />
                              <span>{volume.name}</span>
                            </span>
                            <div className="comics-volume-actions">
                              <small>{formatBytes(volume.sizeBytes)}</small>
                              {isReaderSupported(volume.name) && (
                                <button
                                  disabled={openingVolume === volume.fileId}
                                  onClick={() => void openReader(group.title, volume)}
                                >
                                  {openingVolume === volume.fileId ? "准备中…" : "阅读"}
                                </button>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </article>
                );
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
              src={convertFileSrc(reader.session.pages[reader.pageIndex])}
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
