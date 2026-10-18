import { useCallback, useEffect, useRef, useState } from "react";
import {
  Cloud115Service,
  type Cloud115AccountStatus,
  type Cloud115RecycleItem,
} from "../services/mediaServices";
import { Icon } from "./Icon";
import { FileThumbnail } from "./FileThumbnail";

/** 模块级单例服务：与服务层其它组件的用法一致，避免每次渲染重复构造。 */
const cloud115 = new Cloud115Service();

/** 单页条数：与文件页保持一致，无限滚动每次追加一页。 */
const PAGE_LIMIT = 100;

type RecycleBinViewProps = {
  account: Cloud115AccountStatus | null;
  onRequireLogin: () => void;
  /**
   * 还原成功后的回调：删除来源可能是文件页当前目录，调用方据此刷新列表。
   * 回收站自身不知道「当前目录」是什么，因此只上报事实，不猜测影响范围。
   */
  onRestored: (restored: Cloud115RecycleItem[]) => void;
};

/** 将字节数格式化为适合列表展示的紧凑容量。 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

/** 删除时间按本地时区展示；0 或非法值显示占位符，不编造时间。 */
function formatDeletedAt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 回收站页面：列出 115 已删除文件，支持还原到原位置与彻底删除。
 *
 * 数据源与文件页共用 `cloud115_list_recycle_bin` 命令族；独立成页后不再依赖
 * 文件页的目录上下文，因此还原目标位置完全由 115 侧决定，界面只如实展示。
 *
 * @param props.account 115 账号状态；未连接时展示登录引导
 * @param props.onRequireLogin 触发扫码登录
 * @param props.onRestored 还原成功回调，携带本次还原的条目
 */
export function RecycleBinView({ account, onRequireLogin, onRestored }: RecycleBinViewProps) {
  const [entries, setEntries] = useState<Cloud115RecycleItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [purgeTargets, setPurgeTargets] = useState<Cloud115RecycleItem[]>([]);
  const [busyAction, setBusyAction] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** 无限滚动哨兵：进入视口即预约下一页。 */
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  /** 最近一次翻页决策；供稳定的 IntersectionObserver 回调读取最新状态。 */
  const requestNextPageRef = useRef<() => void>(() => {});

  /**
   * 读取一页回收站条目。
   *
   * @param offset 偏移量；大于 0 表示追加下一页
   */
  const loadPage = useCallback(async (offset: number) => {
    const append = offset > 0;
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const page = await cloud115.listRecycleBin(offset, PAGE_LIMIT);
      setEntries((current) => (append ? [...current, ...page.entries] : page.entries));
      setTotal(page.total);
      setHasMore(page.hasMore);
    } catch (reason) {
      // 失败必须暴露：保留已有条目，但不伪装成「回收站为空」。
      setError(`读取回收站失败：${String(reason)}`);
    } finally {
      if (append) {
        setLoadingMore(false);
      } else {
        setLoading(false);
      }
    }
  }, []);

  // 进入页面即取第一页；账号未连接时不发请求，避免必然失败的调用。
  useEffect(() => {
    if (!account?.connected) {
      setLoading(false);
      return;
    }
    void loadPage(0);
  }, [account?.connected, loadPage]);

  requestNextPageRef.current = () => {
    if (hasMore && !loadingMore && !loading) void loadPage(entries.length);
  };

  useEffect(() => {
    const sentinel = sentinelRef.current;
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

  const allSelected = entries.length > 0 && entries.every((item) => selectedIds.has(item.id));

  function toggleSelected(itemId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  }

  function toggleAll() {
    setSelectedIds(() => (allSelected ? new Set() : new Set(entries.map((item) => item.id))));
  }

  /** 还原到删除前的原位置；结果由 115 决定，界面只上报事实。 */
  async function restore(itemIds: string[]) {
    if (itemIds.length === 0) return;
    setBusyAction(true);
    setError(null);
    try {
      await cloud115.restoreRecycleItems(itemIds);
      const restored = entries.filter((item) => itemIds.includes(item.id));
      setNotice(itemIds.length === 1
        ? `“${restored[0]?.name ?? "项目"}”已还原到原位置`
        : `${itemIds.length} 项已还原到原位置`);
      setSelectedIds(new Set());
      // 还原后列表已变化：重取第一页，保证分页偏移与总数一致。
      void loadPage(0);
      onRestored(restored);
    } catch (reason) {
      setError(`还原失败：${String(reason)}`);
    } finally {
      setBusyAction(false);
    }
  }

  /** 彻底删除不可恢复；必须先经二次确认对话框。 */
  async function purge() {
    if (purgeTargets.length === 0) return;
    setBusyAction(true);
    setError(null);
    try {
      await cloud115.deleteRecycleItems(purgeTargets.map((item) => item.id));
      const removed = new Set(purgeTargets.map((item) => item.id));
      setEntries((current) => current.filter((item) => !removed.has(item.id)));
      setTotal((current) => Math.max(0, current - purgeTargets.length));
      setNotice(purgeTargets.length === 1
        ? `“${purgeTargets[0].name}”已彻底删除`
        : `${purgeTargets.length} 项已彻底删除`);
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const id of removed) next.delete(id);
        return next;
      });
      setPurgeTargets([]);
    } catch (reason) {
      setError(`彻底删除失败：${String(reason)}`);
    } finally {
      setBusyAction(false);
    }
  }

  if (!account?.connected) {
    return (
      <section className="page-section cloud-auth-state">
        <Icon name="cloud" size={22} />
        <span>登录后查看 115 回收站</span>
        <button className="primary-action" onClick={onRequireLogin}>扫码登录</button>
      </section>
    );
  }

  return (
    <section className="page-section recycle-bin-view">
      <div className="recycle-bin-heading">
        <div>
          <span className="context-label">已删除文件</span>
          <h2>回收站</h2>
        </div>
        <span className="recycle-bin-count">
          {loading ? "正在读取…" : `已加载 ${entries.length} / ${total} 项`}
        </span>
      </div>

      <p className="recycle-bin-hint">
        还原会把文件放回删除前所在的目录；彻底删除不可恢复。
      </p>

      {error && <div className="cloud-inline-error" role="alert">{error}</div>}
      {notice && (
        <div className="cloud-action-notice" role="status">
          <Icon name="check" size={14} />
          {notice}
          <button aria-label="关闭提示" onClick={() => setNotice(null)}><Icon name="close" size={13} /></button>
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="file-batch-bar" role="toolbar" aria-label="回收站批量操作">
          <span>已选 {selectedIds.size} 项</span>
          <div>
            <button disabled={busyAction} onClick={() => void restore([...selectedIds])}>还原</button>
            <button
              className="danger"
              disabled={busyAction}
              onClick={() => {
                const targets = entries.filter((item) => selectedIds.has(item.id));
                if (targets.length > 0) setPurgeTargets(targets);
              }}
            >
              彻底删除
            </button>
            <button disabled={busyAction} onClick={() => setSelectedIds(new Set())}>取消选择</button>
          </div>
        </div>
      )}

      <div className="file-table recycle-table" role="table" aria-label="回收站">
        <div className="file-table-head" role="row">
          <input
            type="checkbox"
            className="file-check"
            aria-label="选择全部回收站项目"
            checked={allSelected}
            onChange={toggleAll}
          />
          <span role="columnheader">名称</span>
          <span role="columnheader">大小</span>
          <span role="columnheader">删除时间</span>
          <span role="columnheader">原位置</span>
          <span aria-hidden="true" />
        </div>
        {loading ? (
          <div className="file-empty" role="status"><span>正在读取回收站…</span></div>
        ) : entries.length > 0 ? (
          entries.map((item) => (
            <div className={`file-row${selectedIds.has(item.id) ? " selected" : ""}`} role="row" key={item.id}>
              <input
                type="checkbox"
                className="file-check"
                aria-label={`选择 ${item.name}`}
                checked={selectedIds.has(item.id)}
                onChange={() => toggleSelected(item.id)}
              />
              <span className="file-name">
                <FileThumbnail kind={item.isFolder ? "folder" : "file"} src={null} size={28} />
                <span><strong title={item.name}>{item.name}</strong></span>
              </span>
              <span className="file-size">{formatBytes(item.sizeBytes)}</span>
              <time>{formatDeletedAt(item.deletedAt)}</time>
              <span className="recycle-origin" title={item.parentName}>{item.parentName}</span>
              <div className="recycle-row-actions">
                <button disabled={busyAction} onClick={() => void restore([item.id])}>
                  <Icon name="history" size={13} />还原
                </button>
                <button className="danger" disabled={busyAction} onClick={() => setPurgeTargets([item])}>
                  <Icon name="trash" size={13} />彻底删除
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className="file-empty" role="status">
            <Icon name="history" size={22} />
            <strong>回收站为空</strong>
            <span>删除的文件会先进入回收站，可在这里还原或彻底删除。</span>
          </div>
        )}
      </div>

      {/* 哨兵：滚到这里即自动续页；仅在仍有下一页时挂载，避免无数据时常驻占位。 */}
      {hasMore && (
        <div className="cloud-load-sentinel" ref={sentinelRef}>
          {loadingMore && <span>正在加载…</span>}
        </div>
      )}

      {purgeTargets.length > 0 && (
        <div
          className="cloud-operation-backdrop"
          onPointerDown={(event) => event.target === event.currentTarget && !busyAction && setPurgeTargets([])}
        >
          <section className="cloud-operation-dialog">
            <strong>{purgeTargets.length === 1 ? "彻底删除 1 项？" : `彻底删除 ${purgeTargets.length} 项？`}</strong>
            <span>
              {purgeTargets.length === 1
                ? `“${purgeTargets[0].name}”`
                : `${purgeTargets.length} 个项目`}
              将从回收站永久移除，此操作不可恢复。
            </span>
            <div>
              <button className="secondary-action" disabled={busyAction} onClick={() => setPurgeTargets([])}>取消</button>
              <button className="danger-action" disabled={busyAction} onClick={() => void purge()}>
                {busyAction ? "正在删除" : "彻底删除"}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
