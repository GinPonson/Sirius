import { useCallback, useEffect, useState } from "react";
import {
  Cloud115Service,
  type BackupPair,
  type BackupScanResult,
  type Cloud115AccountStatus,
  type Cloud115FileEntry,
} from "../services/mediaServices";
import { Icon } from "./Icon";

/** 模块级单例服务：与服务层其它组件一致，避免每次渲染重复构造。 */
const cloud115 = new Cloud115Service();

/** 115 根目录 ID；云端目标选择器从这里开始浏览。 */
const ROOT_ID = "0";

/** 单页条数：目录选择器只需要目录项，与文件页保持同一分页口径。 */
const PAGE_LIMIT = 200;

type BackupViewProps = {
  account: Cloud115AccountStatus | null;
  onRequireLogin: () => void;
};

/** 云端目标目录选择器的状态。 */
type FolderPicker = {
  path: Array<{ id: string; name: string }>;
  entries: Cloud115FileEntry[];
  loading: boolean;
};

/**
 * 备份页：把本地目录单向同步到 115 指定目录。
 *
 * 语义边界（界面与实现一致，不做超出能力的承诺）：
 * - 只做「本地 → 云端」上传，不删除、不反向拉取；
 * - 通过「大小 + 修改时间」判断文件是否变化，未变化的文件跳过；
 * - 单个文件失败不影响其它文件，失败项在结果里如实列出。
 *
 * @param props.account 115 账号状态；未连接时禁止新增与执行备份
 * @param props.onRequireLogin 触发扫码登录
 */
export function BackupView({ account, onRequireLogin }: BackupViewProps) {
  const [pairs, setPairs] = useState<BackupPair[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyPairId, setBusyPairId] = useState<string | null>(null);
  /** 每个配对最近一次的扫描结果；只保留本次会话，不持久化。 */
  const [scans, setScans] = useState<Record<string, BackupScanResult>>({});
  /** 新增备份的本地目录（已选、待确认云端目标）。 */
  const [pendingLocalPath, setPendingLocalPath] = useState<string | null>(null);
  const [picker, setPicker] = useState<FolderPicker | null>(null);

  const loadPairs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPairs(await cloud115.listBackupPairs());
    } catch (reason) {
      setError(`读取备份列表失败：${String(reason)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPairs();
  }, [loadPairs]);

  /** 选择本地目录后立即打开云端目标选择器。 */
  async function chooseLocalFolder() {
    setError(null);
    try {
      const selected = await cloud115.pickBackupDirectory();
      if (selected === null) return;
      setPendingLocalPath(selected);
      setPicker({ path: [{ id: ROOT_ID, name: "115 网盘" }], entries: [], loading: true });
      void loadPickerFolder(ROOT_ID);
    } catch (reason) {
      setError(`选择本地目录失败：${String(reason)}`);
    }
  }

  async function loadPickerFolder(folderId: string) {
    try {
      const page = await cloud115.listFiles(folderId, "", 0, PAGE_LIMIT);
      setPicker((current) => current
        ? { ...current, entries: page.entries.filter((entry) => entry.kind === "folder"), loading: false }
        : current);
    } catch (reason) {
      setPicker((current) => current ? { ...current, entries: [], loading: false } : current);
      setError(`读取云端目录失败：${String(reason)}`);
    }
  }

  function enterPickerFolder(entry: Cloud115FileEntry) {
    if (!picker || entry.kind !== "folder") return;
    const nextPath = [...picker.path, { id: entry.id, name: entry.name }];
    setPicker({ ...picker, path: nextPath, entries: [], loading: true });
    void loadPickerFolder(entry.id);
  }

  function navigatePicker(index: number) {
    if (!picker) return;
    const nextPath = picker.path.slice(0, index + 1);
    setPicker({ ...picker, path: nextPath, entries: [], loading: true });
    void loadPickerFolder(nextPath[nextPath.length - 1].id);
  }

  function cancelPicker() {
    setPicker(null);
    setPendingLocalPath(null);
  }

  /** 确认云端目标，写入备份配对。 */
  async function confirmPair() {
    if (!picker || pendingLocalPath === null) return;
    const target = picker.path[picker.path.length - 1];
    setError(null);
    try {
      await cloud115.addBackupPair(pendingLocalPath, target.id, target.name);
      setNotice(`已添加备份：“${pendingLocalPath.split("/").pop() ?? pendingLocalPath}” → “${target.name}”`);
      cancelPicker();
      await loadPairs();
    } catch (reason) {
      setError(`添加备份失败：${String(reason)}`);
    }
  }

  /** 扫描：只读本地目录并对比历史指纹，不发网络请求。 */
  async function scan(pair: BackupPair) {
    setBusyPairId(pair.id);
    setError(null);
    try {
      const result = await cloud115.scanBackupPair(pair.id);
      setScans((current) => ({ ...current, [pair.id]: result }));
      setNotice(
        result.pendingFiles === 0
          ? `“${pair.localPath.split("/").pop() ?? pair.localPath}”已是最新，无需上传`
          : `扫描完成：${result.pendingFiles} 个文件待上传，${result.unchangedFiles} 个已同步`,
      );
    } catch (reason) {
      setError(`扫描失败：${String(reason)}`);
    } finally {
      setBusyPairId(null);
    }
  }

  /** 执行备份：逐文件上传，失败项如实上报。 */
  async function run(pair: BackupPair) {
    setBusyPairId(pair.id);
    setError(null);
    try {
      const result = await cloud115.runBackupPair(pair.id);
      if (result.failed.length === 0) {
        setNotice(`备份完成：已上传 ${result.uploaded} 个文件`);
      } else {
        const first = result.failed[0];
        setError(
          `已上传 ${result.uploaded} 个，${result.failed.length} 个失败；首个失败：${first.relativePath}（${first.reason}）`,
        );
      }
      // 上传后指纹已变化，清掉本次扫描结果，避免界面继续显示旧的待传数。
      setScans((current) => {
        const next = { ...current };
        delete next[pair.id];
        return next;
      });
      await loadPairs();
    } catch (reason) {
      setError(`执行备份失败：${String(reason)}`);
    } finally {
      setBusyPairId(null);
    }
  }

  /** 删除配对；只清理本地记录，云端文件不受影响。 */
  async function removePair(pair: BackupPair) {
    setBusyPairId(pair.id);
    setError(null);
    try {
      await cloud115.deleteBackupPair(pair.id);
      setNotice(`已移除备份：“${pair.localPath.split("/").pop() ?? pair.localPath}”`);
      await loadPairs();
    } catch (reason) {
      setError(`移除备份失败：${String(reason)}`);
    } finally {
      setBusyPairId(null);
    }
  }

  if (!account?.connected) {
    return (
      <section className="page-section cloud-auth-state">
        <Icon name="cloud" size={22} />
        <span>登录后设置文件夹备份</span>
        <button className="primary-action" onClick={onRequireLogin}>扫码登录</button>
      </section>
    );
  }

  return (
    <section className="page-section backup-view">
      <div className="backup-heading">
        <div>
          <span className="context-label">本地目录 → 115 网盘</span>
          <h2>备份</h2>
        </div>
        <button className="primary-action" onClick={() => void chooseLocalFolder()}>
          <Icon name="plus" size={15} />
          添加文件夹
        </button>
      </div>

      <p className="backup-hint">
        单向上传：只把本地文件同步到云端，不会删除或改动云端已有文件；已同步且未修改的文件会被跳过。
      </p>

      {error && <div className="cloud-inline-error" role="alert">{error}</div>}
      {notice && (
        <div className="cloud-action-notice" role="status">
          <Icon name="check" size={14} />
          {notice}
          <button aria-label="关闭提示" onClick={() => setNotice(null)}><Icon name="close" size={13} /></button>
        </div>
      )}

      {loading ? (
        <div className="backup-empty" role="status">正在读取备份列表…</div>
      ) : pairs.length === 0 ? (
        <div className="backup-empty" role="status">
          <Icon name="folder" size={22} />
          <strong>还没有备份任务</strong>
          <span>选择一个本地文件夹并指定云端目录，之后可以随时扫描差异并上传变更。</span>
          <button className="secondary-action" onClick={() => void chooseLocalFolder()}>
            <Icon name="plus" size={14} />
            添加文件夹
          </button>
        </div>
      ) : (
        <div className="backup-list" role="list" aria-label="备份任务">
          {pairs.map((pair) => {
            const scanResult = scans[pair.id];
            const busy = busyPairId === pair.id;
            return (
              <article className="backup-card" role="listitem" key={pair.id}>
                <div className="backup-card-main">
                  <span className="backup-card-icon"><Icon name="folder" size={18} /></span>
                  <div className="backup-card-copy">
                    <strong title={pair.localPath}>{pair.localPath.split("/").pop() ?? pair.localPath}</strong>
                    <small title={pair.localPath}>{pair.localPath}</small>
                    <small className="backup-card-target">
                      备份到：{pair.remoteFolderName}
                      {pair.syncedFiles > 0 && ` · 已同步 ${pair.syncedFiles} 个文件`}
                      {pair.lastSyncedAt && ` · 最近 ${pair.lastSyncedAt}`}
                    </small>
                    {scanResult && (
                      <small className="backup-card-scan">
                        {scanResult.pendingFiles === 0
                          ? `已是最新（共 ${scanResult.totalFiles} 个文件）`
                          : `待上传 ${scanResult.pendingFiles} 个，已同步 ${scanResult.unchangedFiles} 个`}
                      </small>
                    )}
                  </div>
                </div>
                <div className="backup-card-actions">
                  <button className="secondary-action" disabled={busy} onClick={() => void scan(pair)}>
                    {busy ? "处理中…" : "扫描差异"}
                  </button>
                  <button className="primary-action" disabled={busy} onClick={() => void run(pair)}>
                    {busy ? "处理中…" : "开始备份"}
                  </button>
                  <button
                    className="secondary-action backup-remove"
                    disabled={busy}
                    title="只移除本地备份记录，云端文件不受影响"
                    onClick={() => void removePair(pair)}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {picker && (
        <div
          className="cloud-operation-backdrop"
          onPointerDown={(event) => event.target === event.currentTarget && cancelPicker()}
        >
          <section className="cloud-operation-dialog picker-dialog" role="dialog" aria-modal="true" aria-label="选择云端备份目录">
            <strong>选择云端备份目录</strong>
            <span className="backup-picker-local">本地：{pendingLocalPath}</span>
            <nav className="picker-breadcrumbs" aria-label="云端路径">
              {picker.path.map((node, index) => (
                <span key={node.id}>
                  {index > 0 && <Icon name="chevron" size={12} />}
                  <button className={index === picker.path.length - 1 ? "active" : ""} onClick={() => navigatePicker(index)}>
                    {node.name}
                  </button>
                </span>
              ))}
            </nav>
            <div className="picker-folder-list">
              {picker.loading ? (
                <span className="backup-picker-loading">正在读取目录…</span>
              ) : picker.entries.length === 0 ? (
                <span className="backup-picker-loading">该目录下没有子文件夹，可直接备份到这里。</span>
              ) : (
                picker.entries.map((entry) => (
                  <button key={entry.id} onClick={() => enterPickerFolder(entry)}>
                    <span className="picker-folder-icon"><Icon name="folder" size={15} /></span>
                    <span>{entry.name}</span>
                    <Icon name="chevron" size={13} />
                  </button>
                ))
              )}
            </div>
            <div>
              <button className="secondary-action" onClick={cancelPicker}>取消</button>
              <button className="primary-action" onClick={() => void confirmPair()}>
                备份到“{picker.path[picker.path.length - 1].name}”
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
