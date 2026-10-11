import { useEffect, useMemo, useRef, useState } from "react";
import {
  Cloud115Service,
  MediaInfoService,
  type Cloud115AccountStatus,
  type Cloud115FileEntry,
  type Cloud115UploadSession,
} from "../services/mediaServices";
import { Icon } from "./Icon";

type CloudFileFilter = "all" | "folder" | "video" | "subtitle";
type FolderPick = { id: string; name: string };
type FolderPicker = {
  mode: "move" | "copy";
  path: FolderPick[];
  entries: Cloud115FileEntry[];
  loading: boolean;
};

type CloudFilesViewProps = {
  account: Cloud115AccountStatus | null;
  onRequireLogin: () => void;
  onPlay: (entry: Cloud115FileEntry) => Promise<void>;
};

const ROOT_ID = "0";
const PAGE_LIMIT = 100;
const cloud115 = new Cloud115Service();
const mediaInfoService = new MediaInfoService();

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

/** 将文件类型转换为用户可读标签。 */
function fileKindLabel(kind: Cloud115FileEntry["kind"]): string {
  return { folder: "文件夹", video: "视频", subtitle: "字幕", file: "文件" }[kind];
}

/** 批量对话框中的人读清单：最多展示两个名称，其余折叠为数量。 */
function describeTargets(targets: Cloud115FileEntry[]): string {
  if (targets.length <= 2) {
    return targets.map((entry) => `“${entry.name}”`).join("、");
  }
  return `“${targets[0].name}”、“${targets[1].name}”等 ${targets.length} 项`;
}

/** 115 网盘真实文件浏览页；批量移动/复制的目标策略由 Rust 侧统一校验。 */
export function CloudFilesView({ account, onRequireLogin, onPlay }: CloudFilesViewProps) {
  const [path, setPath] = useState<FolderPick[]>([{ id: ROOT_ID, name: "115 网盘" }]);
  const [entries, setEntries] = useState<Cloud115FileEntry[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CloudFileFilter>("all");
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [actionEntry, setActionEntry] = useState<Cloud115FileEntry | null>(null);
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
  // 批量操作完成后手动触发列表重载；常规浏览仍走目录/搜索依赖。
  const [reloadNonce, setReloadNonce] = useState(0);
  const currentFolderId = path[path.length - 1].id;
  const requestKey = `${currentFolderId}\u0000${query.trim()}`;
  const requestKeyRef = useRef(requestKey);
  requestKeyRef.current = requestKey;

  useEffect(() => {
    if (!account?.connected) return;
    let active = true;
    setLoading(true);
    setLoadingMore(false);
    const timeout = window.setTimeout(() => {
      cloud115.listFiles(currentFolderId, query.trim(), 0, PAGE_LIMIT)
        .then((page) => {
          if (!active) return;
          setEntries(page.entries);
          setTotal(page.total);
          setHasMore(page.hasMore);
        })
        .catch((reason) => active && setError(`读取 115 文件失败：${String(reason)}`))
        .finally(() => active && setLoading(false));
    }, query.trim() ? 250 : 0);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [account?.connected, currentFolderId, query, reloadNonce]);

  const visibleEntries = useMemo(
    () => entries.filter((entry) => filter === "all" || entry.kind === filter),
    [entries, filter],
  );

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

  /** 目标目录变化意味着选择上下文失效，立即清空避免误操作不可见文件。 */
  function clearSelection() {
    setSelectedIds(new Set());
  }

  function openFolder(entry: Cloud115FileEntry) {
    if (entry.kind !== "folder") return;
    setPath((current) => [...current, { id: entry.id, name: entry.name }]);
    setQuery("");
    setFilter("all");
    clearSelection();
  }

  function navigateToPath(index: number) {
    setPath((current) => current.slice(0, index + 1));
    setQuery("");
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
      setActionEntry(null);
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
      setActionEntry(null);
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
      setActionEntry(null);
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

  /** 打开目标文件夹选择器，从根目录开始浏览。 */
  function openPicker(mode: "move" | "copy") {
    if (selectedIds.size === 0) return;
    const initial: FolderPicker = { mode, path: [{ id: ROOT_ID, name: "115 网盘" }], entries: [], loading: true };
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
    const ids = [...selectedIds];
    const target = picker.path[picker.path.length - 1];
    setBusyAction(true);
    setError(null);
    try {
      if (picker.mode === "move") {
        await cloud115.moveFiles(ids, target.id);
      } else {
        await cloud115.copyFiles(ids, target.id, false);
      }
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

  if (!account?.connected) {
    return (
      <section className="page-section cloud-auth-state">
        <Icon name="cloud" size={22} />
        <span>登录后查看 115 网盘文件</span>
        <button className="primary-action" onClick={onRequireLogin}>扫码登录</button>
      </section>
    );
  }

  return (
    <section className="page-section cloud-files-view">
      {error && <div className="cloud-inline-error" role="alert">{error}</div>}
      {notice && <div className="cloud-action-notice" role="status"><Icon name="check" size={14} />{notice}<button aria-label="关闭提示" onClick={() => setNotice(null)}><Icon name="close" size={13} /></button></div>}

      <div className="cloud-file-pane">
          <div className="cloud-files-toolbar">
            <button
              className="primary-action cloud-upload-action"
              disabled={uploading !== null}
              title={uploading ? `正在上传 ${uploading.name}` : "上传文件到当前目录"}
              onClick={() => void startUpload()}
            >
              <Icon name="upload" size={16} />
              {uploading ? `正在上传 ${uploading.index}/${uploading.total}` : "上传文件"}
            </button>
            <div className="cloud-files-actions">
              <label className="file-search">
                <Icon name="search" size={15} />
                <input aria-label="搜索当前目录" value={query} placeholder="搜索当前目录" onChange={(event) => setQuery(event.currentTarget.value)} />
              </label>
            </div>
          </div>

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

          <div className="file-filter-row">
            <nav className="file-breadcrumbs" aria-label="当前网盘路径">
              {path.map((item, index) => (
                <span key={item.id}>
                  {index > 0 && <Icon name="chevron" size={13} />}
                  <button className={index === path.length - 1 ? "active" : ""} onClick={() => navigateToPath(index)}>{item.name}</button>
                </span>
              ))}
            </nav>
            <div className="cloud-filter-options">
              <div className="segmented-control" aria-label="文件类型筛选">
                {([ ["all", "全部"], ["folder", "文件夹"], ["video", "视频"], ["subtitle", "字幕"] ] as const).map(([value, label]) => (
                  <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>
                ))}
              </div>
              <span>{visibleEntries.length} / {total} 个项目</span>
            </div>
          </div>

          {selectedIds.size > 0 && (
            <div className="file-batch-bar" role="toolbar" aria-label="批量操作">
              <span>已选 {selectedIds.size} 项</span>
              <div>
                <button disabled={busyAction} onClick={() => openPicker("move")}>移动</button>
                <button disabled={busyAction} onClick={() => openPicker("copy")}>复制</button>
                <button className="danger" disabled={busyAction} onClick={() => {
                  const targets = entries.filter((entry) => selectedIds.has(entry.id));
                  if (targets.length > 0) setDeleteTargets(targets);
                }}>删除</button>
                <button disabled={busyAction} onClick={clearSelection}>取消选择</button>
              </div>
            </div>
          )}

          <div className="file-table" role="table" aria-label="网盘文件">
            <div className="file-table-head" role="row">
              <input
                type="checkbox"
                className="file-check"
                aria-label="选择全部可见文件"
                checked={allVisibleSelected}
                onChange={toggleAllVisible}
              />
              <span role="columnheader">名称</span><span role="columnheader">类型</span><span role="columnheader">大小</span><span role="columnheader">修改时间</span><span aria-hidden="true" />
            </div>
            {loading ? <FileRowsSkeleton /> : visibleEntries.length > 0 ? visibleEntries.map((entry) => (
              <div className={`file-row${selectedIds.has(entry.id) ? " selected" : ""}`} role="row" key={entry.id}>
                <input
                  type="checkbox"
                  className="file-check"
                  aria-label={`选择 ${entry.name}`}
                  checked={selectedIds.has(entry.id)}
                  onChange={() => toggleSelected(entry.id)}
                />
                <button className="file-name" onClick={() => openFolder(entry)} aria-disabled={entry.kind !== "folder"}>
                  <span className={`file-kind-icon ${entry.kind}`}><Icon name={entry.kind === "folder" ? "folder" : entry.kind === "video" ? "play" : "history"} size={17} /></span>
                  <span><strong title={entry.name}>{entry.name}</strong>{entry.children !== null && <small>{entry.children} 个项目</small>}</span>
                </button>
                <span className="file-kind-label">{fileKindLabel(entry.kind)}</span>
                <span className="file-size">{formatBytes(entry.sizeBytes)}</span>
                <time>{formatModifiedAt(entry.modifiedAt)}</time>
                <div className="file-row-actions">
                  {entry.kind === "video" && <button className="file-play" disabled={playingId === entry.id} onClick={() => void playEntry(entry)}><Icon name="play" size={14} />{playingId === entry.id ? "解析中" : "播放"}</button>}
                  {entry.kind === "folder" && <button className="file-open" onClick={() => openFolder(entry)} aria-label={`打开${entry.name}`}><Icon name="chevron" size={16} /></button>}
                  <button className="file-more" aria-label={`${entry.name}的更多操作`} aria-expanded={actionEntry?.id === entry.id} onClick={() => setActionEntry((current) => current?.id === entry.id ? null : entry)}><Icon name="more" size={16} /></button>
                  {actionEntry?.id === entry.id && (
                    <div className="file-action-menu">
                      <button disabled={busyAction} onClick={() => void favoriteEntry(entry)}><Icon name="star" size={14} />收藏</button>
                      {entry.kind === "video" && <button disabled={busyAction} onClick={() => void scrapeMediaInfo(entry)}><Icon name="play" size={14} />媒体信息</button>}
                      <button disabled={busyAction} onClick={() => { setRenameEntry(entry); setRenameValue(entry.name); setActionEntry(null); }}><Icon name="edit" size={14} />重命名</button>
                      {entry.kind !== "folder" && <button disabled={busyAction} onClick={() => void downloadEntry(entry)}><Icon name="download" size={14} />下载</button>}
                      <button className="danger" disabled={busyAction} onClick={() => { setDeleteTargets([entry]); setActionEntry(null); }}><Icon name="trash" size={14} />删除</button>
                    </div>
                  )}
                </div>
              </div>
            )) : (
              <div className="file-empty"><Icon name="search" size={22} /><strong>当前目录没有匹配文件</strong><span>清除搜索词或切换文件类型后再试。</span></div>
            )}
          </div>
          {hasMore && <button className="cloud-load-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "正在加载…" : "加载更多"}</button>}
        
      </div>

      <div className="cloud-status-strip">
        <span><i />{account.userName ? `${account.userName} · 已连接` : "115 已连接"}</span>
        <span>{total} 个项目</span>
        <button onClick={onRequireLogin}>管理账号</button>
      </div>

      {renameEntry && <div className="cloud-operation-backdrop" onPointerDown={(event) => event.target === event.currentTarget && !busyAction && setRenameEntry(null)}><form className="cloud-operation-dialog" onSubmit={(event) => { event.preventDefault(); void submitRename(); }}><strong>重命名</strong><span>为“{renameEntry.name}”输入新名称</span><input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.currentTarget.value)} /><div><button type="button" className="secondary-action" disabled={busyAction} onClick={() => setRenameEntry(null)}>取消</button><button type="submit" className="primary-action" disabled={busyAction || !renameValue.trim()}>保存</button></div></form></div>}
      {deleteTargets.length > 0 && <div className="cloud-operation-backdrop" onPointerDown={(event) => event.target === event.currentTarget && !busyAction && setDeleteTargets([])}><section className="cloud-operation-dialog"><strong>{deleteTargets.length === 1 ? "移入回收站？" : `移入回收站 ${deleteTargets.length} 项？`}</strong><span>{describeTargets(deleteTargets)}将从当前目录移除，可稍后在回收站恢复。</span><div><button className="secondary-action" disabled={busyAction} onClick={() => setDeleteTargets([])}>取消</button><button className="danger-action" disabled={busyAction} onClick={() => void confirmDelete()}>{busyAction ? "正在删除" : "删除"}</button></div></section></div>}
      {picker && (
        <div className="cloud-operation-backdrop" onPointerDown={(event) => event.target === event.currentTarget && !busyAction && setPicker(null)}>
          <section className="cloud-operation-dialog picker-dialog">
            <strong>{picker.mode === "move" ? "移动到…" : "复制到…"}</strong>
            <span>已选 {selectedIds.size} 项；目标文件夹由 115 校验同名冲突。</span>
            <nav className="file-breadcrumbs picker-breadcrumbs" aria-label="目标路径">
              {picker.path.map((item, index) => (
                <span key={item.id}>
                  {index > 0 && <Icon name="chevron" size={13} />}
                  <button className={index === picker.path.length - 1 ? "active" : ""} onClick={() => navigatePicker(index)}>{item.name}</button>
                </span>
              ))}
            </nav>
            <div className="picker-folder-list">
              {picker.loading ? <div className="picker-empty">正在读取文件夹…</div> : picker.entries.length === 0 ? <div className="picker-empty">此目录没有子文件夹</div> : picker.entries.map((entry) => (
                <button key={entry.id} onClick={() => enterPickerFolder(entry)}>
                  <Icon name="folder" size={16} />
                  <span>{entry.name}</span>
                  <Icon name="chevron" size={14} />
                </button>
              ))}
            </div>
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

/** 与真实列表行同尺寸的骨架，避免目录切换时页面跳动。 */
function FileRowsSkeleton() {
  return <div className="cloud-file-skeleton" aria-label="正在读取文件">{Array.from({ length: 5 }, (_, index) => <span key={index} />)}</div>;
}
