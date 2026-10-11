import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ComicSession } from "../services/comicsServices";
import { Icon } from "./Icon";

export type ComicsFitMode = "width" | "page";
export type ComicsDirection = "rtl" | "ltr";

/** 适应方式与阅读方向的持久化键；与播放器记忆同类，只存展示偏好。 */
const FIT_KEY = "sirius-comics-fit";
const DIRECTION_KEY = "sirius-comics-direction";

/** 进度条连续小步（键盘）提交限频：拖动纪律与播放器一致——拖动只预览，松手/限频提交。 */
const SEEK_COMMIT_THROTTLE_MS = 250;

function loadStoredValue<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const stored = window.localStorage.getItem(key);
    return stored && (allowed as readonly string[]).includes(stored) ? (stored as T) : fallback;
  } catch {
    return fallback;
  }
}

/** 页图地址解析：data-URI 等自包含地址原样使用，本机缓存页图路径走 Tauri asset 协议。 */
function resolvePageSrc(path: string): string {
  return /^(data|blob|https?):/.test(path) ? path : convertFileSrc(path);
}

type ComicsReaderProps = {
  session: ComicSession;
  /** 当前卷文件名；仅用于页眉标识，不参与跳转。 */
  volumeName: string;
  /** 当前卷在系列内的序号标签（如「第 2 卷」）。 */
  volumeNumberLabel: string;
  /** 系列总卷数。 */
  volumeCount: number;
  hasNextVolume: boolean;
  /** 下一卷的序号标签；无下一卷时为 null。 */
  nextVolumeLabel: string | null;
  loadingNextVolume: boolean;
  /** 进度保存失败等非阻断提示；由父组件在翻页回写时设置。 */
  progressError: string | null;
  pageIndex: number;
  /** 提交跳转到指定页（0 基）；拖动松手、键盘翻页与页码输入都经由此回调回写进度。 */
  onNavigate: (pageIndex: number) => void;
  onLoadNextVolume: () => void;
  onClose: () => void;
};

/**
 * 漫画阅读器：深色沉浸舞台上的页图、进度条与阅读序列控制。
 * 适应方式与阅读方向持久化在本机；翻页进度经父组件 comics_save_progress 持久化。
 */
export function ComicsReader({
  session,
  volumeName,
  volumeNumberLabel,
  volumeCount,
  hasNextVolume,
  nextVolumeLabel,
  loadingNextVolume,
  progressError,
  pageIndex,
  onNavigate,
  onLoadNextVolume,
  onClose,
}: ComicsReaderProps) {
  const [fit, setFit] = useState<ComicsFitMode>(() => loadStoredValue(FIT_KEY, ["width", "page"], "width"));
  const [direction, setDirection] = useState<ComicsDirection>(() =>
    loadStoredValue(DIRECTION_KEY, ["rtl", "ltr"], "ltr"),
  );
  /** 进度条拖动中的预览页（0 基）；null 表示当前没有拖动预览。 */
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [pageInputValue, setPageInputValue] = useState(String(pageIndex + 1));
  const [pageImageError, setPageImageError] = useState(false);

  const pointerActiveRef = useRef(false);
  const lastCommitRef = useRef(0);
  const trailingCommitRef = useRef<{ timer: number | null; index: number | null }>({
    timer: null,
    index: null,
  });

  const pageCount = session.pageCount;
  const displayIndex = previewIndex ?? pageIndex;
  const atFirstPage = pageIndex <= 0;
  const atLastPage = pageIndex >= pageCount - 1;

  useEffect(() => {
    try {
      window.localStorage.setItem(FIT_KEY, fit);
    } catch {
      // 存储不可用时仅当前会话生效。
    }
  }, [fit]);

  useEffect(() => {
    try {
      window.localStorage.setItem(DIRECTION_KEY, direction);
    } catch {
      // 存储不可用时仅当前会话生效。
    }
  }, [direction]);

  useEffect(() => {
    setPageInputValue(String(pageIndex + 1));
    setPageImageError(false);
  }, [pageIndex, session.fileId]);

  useEffect(() => {
    const trailing = trailingCommitRef.current;
    return () => {
      if (trailing.timer !== null) window.clearTimeout(trailing.timer);
    };
  }, []);

  /** 立即提交跳转（松手、页码输入、单次按钮翻页）。 */
  function commitNavigation(index: number) {
    lastCommitRef.current = Date.now();
    onNavigate(Math.min(Math.max(0, index), pageCount - 1));
  }

  /** 键盘小步翻页：限频提交并把尾随步合并成一次回写。 */
  function commitThrottled(index: number) {
    const now = Date.now();
    const elapsed = now - lastCommitRef.current;
    if (elapsed >= SEEK_COMMIT_THROTTLE_MS) {
      commitNavigation(index);
      return;
    }
    trailingCommitRef.current.index = index;
    if (trailingCommitRef.current.timer === null) {
      trailingCommitRef.current.timer = window.setTimeout(
        () => {
          trailingCommitRef.current.timer = null;
          const pending = trailingCommitRef.current.index;
          trailingCommitRef.current.index = null;
          if (pending !== null) commitNavigation(pending);
        },
        SEEK_COMMIT_THROTTLE_MS - elapsed,
      );
    }
  }

  /** 步进翻页；末页再前进时进入下一卷，首页再后退为边界。 */
  function step(delta: number) {
    const next = pageIndex + delta;
    if (next < 0 || next > pageCount - 1) {
      if (delta > 0 && hasNextVolume) onLoadNextVolume();
      return;
    }
    commitNavigation(next);
  }

  function handleSeekChange(value: number) {
    const index = value - 1;
    setPreviewIndex(index);
    if (!pointerActiveRef.current) commitThrottled(index);
  }

  function handleSeekPointerDown() {
    pointerActiveRef.current = true;
  }

  /** 松手提交：拖动期间的预览页正式生效并回写进度。 */
  function handleSeekPointerUp() {
    if (!pointerActiveRef.current) return;
    pointerActiveRef.current = false;
    if (previewIndex !== null) commitNavigation(previewIndex);
    setPreviewIndex(null);
  }

  function handleSeekPointerCancel() {
    pointerActiveRef.current = false;
    setPreviewIndex(null);
  }

  function handleSeekBlur() {
    if (previewIndex !== null) {
      commitNavigation(previewIndex);
      setPreviewIndex(null);
    }
  }

  /** 页码输入框提交：越界回退到当前页，不产生无效跳转。 */
  function commitPageInput() {
    const parsed = Number(pageInputValue);
    if (!Number.isFinite(parsed) || pageInputValue.trim() === "") {
      setPageInputValue(String(pageIndex + 1));
      return;
    }
    const next = Math.min(Math.max(1, Math.round(parsed)), pageCount) - 1;
    if (next === pageIndex) {
      setPageInputValue(String(pageIndex + 1));
      return;
    }
    commitNavigation(next);
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      if (event.key === "Escape") {
        onClose();
        return;
      }
      // 漫画日式（从右到左）：向左即向下一页；普通方向与书写顺序一致。
      if (event.key === "ArrowLeft") step(direction === "rtl" ? 1 : -1);
      else if (event.key === "ArrowRight") step(direction === "rtl" ? -1 : 1);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  });

  const nextPageSrc = session.pages[Math.min(displayIndex + 1, pageCount - 1)];

  return (
    <div className="comics-reader" role="dialog" aria-modal="true" aria-label="漫画阅读器">
      <header className="comics-reader-bar">
        <strong title={session.seriesTitle}>{session.seriesTitle}</strong>
        <span className="comics-reader-volume" title={volumeName}>
          {volumeNumberLabel} · {volumeName}
        </span>
        <div className="comics-reader-tools">
          <div className="comics-reader-fit" role="group" aria-label="页面适应方式">
            <button aria-pressed={fit === "width"} onClick={() => setFit("width")}>
              适应宽度
            </button>
            <button aria-pressed={fit === "page"} onClick={() => setFit("page")}>
              适应页面
            </button>
          </div>
          <button
            className="comics-reader-direction"
            aria-pressed={direction === "rtl"}
            title="切换阅读方向；日式漫画从右到左翻页"
            onClick={() => setDirection(direction === "rtl" ? "ltr" : "rtl")}
          >
            方向：{direction === "rtl" ? "日式（从右到左）" : "普通（从左到右）"}
          </button>
          <button className="comics-reader-close" onClick={onClose}>
            <Icon name="close" size={15} />
            关闭
          </button>
        </div>
      </header>

      <div className="comics-reader-stage" data-fit={fit} data-direction={direction}>
        <div className="comics-reader-scroll">
          <img
            src={resolvePageSrc(session.pages[displayIndex])}
            alt={previewIndex !== null ? `预览 第 ${displayIndex + 1} 页` : `第 ${displayIndex + 1} 页`}
            decoding="async"
            onError={() => setPageImageError(true)}
          />
          <img className="comics-reader-preload" src={resolvePageSrc(nextPageSrc)} alt="" aria-hidden="true" />
        </div>
        {pageImageError && (
          <div className="comics-reader-page-error" role="alert">
            <Icon name="alert" size={15} />
            页图加载失败，可关闭后重新打开该卷重试
          </div>
        )}
        <button
          className="comics-reader-zone prev"
          aria-label="上一页"
          disabled={atFirstPage}
          onClick={() => step(-1)}
        >
          <Icon name="chevron" size={22} />
        </button>
        <button
          className="comics-reader-zone next"
          aria-label={atLastPage && hasNextVolume ? "下一卷" : "下一页"}
          disabled={atLastPage && !hasNextVolume}
          onClick={() => step(1)}
        >
          <Icon name="chevron" size={22} />
        </button>
      </div>

      <footer className="comics-reader-controls">
        <div className={`comics-reader-seek${direction === "rtl" ? " rtl" : ""}`}>
          <input
            type="range"
            min={1}
            max={Math.max(pageCount, 1)}
            step={1}
            value={displayIndex + 1}
            aria-label="阅读进度"
            aria-valuetext={`第 ${displayIndex + 1} 页，共 ${pageCount} 页`}
            onChange={(event) => handleSeekChange(Number(event.currentTarget.value))}
            onPointerDown={handleSeekPointerDown}
            onPointerUp={handleSeekPointerUp}
            onPointerCancel={handleSeekPointerCancel}
            onBlur={handleSeekBlur}
          />
          <input
            className="comics-reader-page-input"
            type="number"
            min={1}
            max={pageCount}
            value={pageInputValue}
            aria-label="页码，输入后回车跳转"
            onChange={(event) => setPageInputValue(event.currentTarget.value)}
            onBlur={commitPageInput}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitPageInput();
                event.currentTarget.blur();
              }
            }}
          />
          <span className="comics-reader-page-total">/ {pageCount} 页</span>
          {previewIndex !== null && (
            <span className="comics-reader-seek-preview" aria-hidden="true">
              预览 第 {displayIndex + 1} 页
            </span>
          )}
        </div>
        <div className="comics-reader-nav">
          <button disabled={atFirstPage} onClick={() => step(-1)}>
            上一页
          </button>
          <button
            disabled={atLastPage && !hasNextVolume}
            onClick={() => step(1)}
          >
            {atLastPage && hasNextVolume ? "下一卷" : "下一页"}
          </button>
          {hasNextVolume && (
            <button
              className="comics-reader-next-volume"
              disabled={loadingNextVolume}
              onClick={onLoadNextVolume}
              title="加载系列内的下一卷；当前阅读进度已在本卷保存"
            >
              {loadingNextVolume ? "正在载入下一卷…" : `下一卷：${nextVolumeLabel ?? ""}`}
            </button>
          )}
        </div>
        <p className="comics-reader-meta">
          {volumeNumberLabel}，系列共 {volumeCount} 卷 · 方向：{direction === "rtl" ? "日式（从右到左）" : "普通（从左到右）"}
        </p>
        {progressError && (
          <p className="comics-reader-error" role="alert">
            {progressError}
          </p>
        )}
      </footer>
    </div>
  );
}
