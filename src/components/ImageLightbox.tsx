import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
import { Cloud115Service } from "../services/mediaServices";
import { FileThumbnail } from "./FileThumbnail";
import { FileTypeIcon } from "./FileTypeIcon";
import { Icon } from "./Icon";

/** 模块级单例服务：与其它组件一致，避免每次渲染重复构造。 */
const cloud115 = new Cloud115Service();

/**
 * 图片查看器需要的最小条目形状。
 * 只取查看链路真正用到的字段，不耦合 `Cloud115FileEntry` 的持续演进；
 * `Cloud115FileEntry` 在结构上可直接满足该类型。
 */
export type ImageLightboxItem = {
  /** 115 文件 id；用于区分「换图」与「同一张重新解析」，并作为 React key。 */
  id: string;
  /** 展示用文件名（含扩展名）。 */
  name: string;
  /** 115 提取码；解析原图直链的唯一入参。 */
  pickCode: string;
  /** 服务端缩略图；原图解析或渲染失败时作为回退画面。 */
  thumbUrl?: string | null;
};

/** 缩放档位："fit" 适应窗口；数字为相对原图自然尺寸的倍率（1 即 100%）。 */
type ZoomMode = "fit" | 1 | 2;

/** 原图链路失败原因：直链没拿到 / 拿到了但图片渲染失败，两者提示文案不同。 */
type FullSourceFailure = "resolve" | "load" | null;

const ZOOM_LEVELS: ZoomMode[] = ["fit", 1, 2];

const ZOOM_LABELS: Record<string, string> = {
  fit: "适应",
  "1": "100%",
  "2": "200%",
};

/**
 * 按档位走一步缩放：`direction` 为 1 放大、-1 缩小，到头后保持原档。
 *
 * @param current 当前档位
 * @param direction 1 放大 / -1 缩小
 * @return 相邻档位；已在端点时返回当前档位
 */
function stepZoom(current: ZoomMode, direction: 1 | -1): ZoomMode {
  const index = ZOOM_LEVELS.indexOf(current);
  const nextIndex = Math.min(Math.max(index + direction, 0), ZOOM_LEVELS.length - 1);
  return ZOOM_LEVELS[nextIndex] ?? current;
}

/** 读取系统的「减少动态效果」偏好；条状缩略图滚动据此去掉平滑动画。 */
function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 对话框内可聚焦元素选择器：Tab 焦点陷阱与首焦点定位共用同一口径。 */
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export type ImageLightboxProps = {
  /** 可切换的图片列表（调用方只传已加载项，查看器不会自行翻页取数）。 */
  items: ImageLightboxItem[];
  /** 打开时定位到列表中的哪一项；越界会被收敛到合法区间。 */
  initialIndex: number;
  /** 关闭回调；Esc、关闭按钮、点击遮罩都会走这里。 */
  onClose: () => void;
};

/**
 * 网盘文件页的全屏图片查看器。
 *
 * 复用相册页已验证的交互：`requestSeq` 竞态守卫（迟到的原图直链响应直接丢弃）、
 * 缩放/平移、缩略图条与「原图失败回退缩略图并明确提示」。
 * 图片清单由调用方给定，切换只在清单内进行，不会越界触发分页加载。
 *
 * @param props.items 已加载的图片清单，顺序即左右切换顺序
 * @param props.initialIndex 初始展示下标
 * @param props.onClose 关闭回调
 */
export function ImageLightbox({ items, initialIndex, onClose }: ImageLightboxProps) {
  const [index, setIndex] = useState(() => Math.min(Math.max(0, initialIndex), Math.max(0, items.length - 1)));
  const [fullUrl, setFullUrl] = useState<string | null>(null);
  const [fullLoading, setFullLoading] = useState(true);
  const [fullFailure, setFullFailure] = useState<FullSourceFailure>(null);
  const [zoom, setZoom] = useState<ZoomMode>("fit");
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  /** 原图请求序号：换图、重试都会自增，迟到的旧响应因序号不匹配被丢弃。 */
  const requestSeqRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const activeStripItemRef = useRef<HTMLButtonElement | null>(null);
  const panStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

  const current = items[index] ?? null;

  /**
   * 后台解析原图直链；响应到达时序号已推进则整体丢弃，避免旧图覆盖新图。
   *
   * @param seq 本次请求序号，必须与 `requestSeqRef.current` 相等才落地
   * @param item 要解析的图片条目
   */
  async function resolveFullSource(seq: number, item: ImageLightboxItem) {
    try {
      const source = await cloud115.downloadSource(item.pickCode);
      if (requestSeqRef.current !== seq) return;
      setFullUrl(source.url);
      setFullFailure(null);
      setFullLoading(false);
    } catch {
      // 直链解析失败不打断浏览：保留缩略图并明确告知，同时提供重试入口。
      if (requestSeqRef.current !== seq) return;
      setFullUrl(null);
      setFullFailure("resolve");
      setFullLoading(false);
    }
  }

  // 打开与左右切换共用同一条链路：复位缩放/平移状态后重新解析原图。
  useEffect(() => {
    const item = items[index];
    if (!item) return;
    const seq = ++requestSeqRef.current;
    setFullUrl(null);
    setFullLoading(true);
    setFullFailure(null);
    setZoom("fit");
    setNaturalSize(null);
    void resolveFullSource(seq, item);
    // 仅依赖展示项变化：items 由调用方以稳定引用传入，避免重复解析。
  }, [index, items]);

  /** 在清单内切换到下一张/上一张；越界直接忽略，不拉取未加载分页。 */
  function changeImage(delta: 1 | -1) {
    setIndex((current) => Math.min(Math.max(0, current + delta), items.length - 1));
  }
  /** 重试原图直链：推进序号并重新进入加载态，成功后自动替换画面。 */
  function retryFullSource() {
    const item = items[index];
    if (!item) return;
    const seq = ++requestSeqRef.current;
    setFullUrl(null);
    setFullLoading(true);
    setFullFailure(null);
    void resolveFullSource(seq, item);
  }

  // 键盘：Esc 关闭、左右切换、+/-/0 缩放；Tab 限制在对话框内（模态焦点陷阱）。
  // 刻意不写依赖数组：处理器闭包要始终引用最新的 items.length 与 onClose，
  // 查看器只在打开期间挂载，重绑监听的开销可忽略。
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        changeImage(event.key === "ArrowRight" ? 1 : -1);
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoom((current) => stepZoom(current, 1));
        return;
      }
      if (event.key === "-") {
        event.preventDefault();
        setZoom((current) => stepZoom(current, -1));
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        setZoom("fit");
        return;
      }
      if (event.key === "Tab") {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
        if (focusable.length === 0) {
          event.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !dialog.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  });

  // 焦点管理：打开时把焦点移进对话框，关闭后送回打开前的元素。
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      if (previousFocus && document.contains(previousFocus)) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  // 换图后复位舞台滚动位置，并把当前缩略图滚到可视范围中央。
  useEffect(() => {
    stageRef.current?.scrollTo({ left: 0, top: 0 });
    activeStripItemRef.current?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [index]);

  // 滚轮缩放需 non-passive 监听才能阻止页面滚动；React 合成 onWheel 是被动监听。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    function handleWheel(event: WheelEvent) {
      if (event.deltaY === 0) return;
      event.preventDefault();
      setZoom((current) => stepZoom(current, event.deltaY < 0 ? 1 : -1));
    }
    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, []);

  /** 平移开始：记录指针起点与舞台滚动位置，并用指针捕获保证移出舞台仍能拖动。 */
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

  /** 原图渲染完成：记录自然尺寸，倍率档位据此换算成像素宽，平移才有意义。 */
  function handleImageLoad(event: SyntheticEvent<HTMLImageElement>) {
    const image = event.currentTarget;
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
    }
  }

  /** 原图渲染失败：退回缩略图并保留明确提示，不把缩略图伪装成原图。 */
  function handleImageError() {
    if (!fullUrl) return;
    setFullUrl(null);
    setFullFailure("load");
    setFullLoading(false);
  }

  if (!current) return null;

  // 原图可用时显示原图；解析中或失败时先显示缩略图，避免空白舞台。
  const displayUrl = fullUrl ?? (current.thumbUrl?.trim() ? current.thumbUrl : "");
  const zoomLabel = ZOOM_LABELS[String(zoom)] ?? "适合";

  // portal 到 body：.cloud-file-pane 声明了 container-type，会使 fixed 后代以它而非
  // 视口为包含块，直接渲染会让全屏查看器只覆盖文件区（与 FileContextMenu 同理）。
  return createPortal(
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`图片查看：${current.name}`}
      tabIndex={-1}
      ref={dialogRef}
    >
      <header className="image-lightbox-bar">
        <strong title={current.name}>{current.name}</strong>
        <span className="image-lightbox-count">
          {index + 1} / {items.length}
        </span>
        <div className="image-lightbox-tools" role="group" aria-label="缩放控制">
          {ZOOM_LEVELS.map((level) => (
            <button
              key={String(level)}
              className={zoom === level ? "active" : ""}
              aria-pressed={zoom === level}
              onClick={() => setZoom(level)}
            >
              {ZOOM_LABELS[String(level)]}
            </button>
          ))}
        </div>
        <button className="image-lightbox-close" onClick={onClose} aria-label="关闭图片查看">
          <Icon name="close" size={15} />
          关闭
        </button>
      </header>

      <div className="image-lightbox-stage-wrap">
        <div
          className={`image-lightbox-stage${zoom !== "fit" ? " zoomed" : ""}${dragging ? " dragging" : ""}`}
          ref={stageRef}
          onPointerDown={handleStagePointerDown}
          onPointerMove={handleStagePointerMove}
          onPointerUp={handleStagePointerEnd}
          onPointerCancel={handleStagePointerEnd}
        >
          {displayUrl ? (
            <img
              className={zoom === "fit" ? "" : "zoomed"}
              src={displayUrl}
              alt={current.name}
              referrerPolicy="no-referrer"
              draggable={false}
              onLoad={handleImageLoad}
              onError={handleImageError}
              style={
                zoom !== "fit" && naturalSize
                  ? { width: `${Math.round(naturalSize.width * zoom)}px` }
                  : undefined
              }
            />
          ) : (
            <div className="image-lightbox-fallback" role="img" aria-label={`${current.name} 无可用画面`}>
              <FileTypeIcon kind="image" size={72} />
            </div>
          )}
        </div>

        {fullLoading && <span className="image-lightbox-note">正在加载原图…</span>}
        {fullFailure === "resolve" && (
          <span className="image-lightbox-note image-lightbox-note-failed" role="status">
            原图直链解析失败，当前为缩略图
            <button onClick={retryFullSource}>
              <Icon name="refresh" size={12} />
              重试
            </button>
          </span>
        )}
        {fullFailure === "load" && (
          <span className="image-lightbox-note image-lightbox-note-failed" role="status">
            原图加载失败，当前为缩略图
            <button onClick={retryFullSource}>
              <Icon name="refresh" size={12} />
              重试
            </button>
          </span>
        )}
      </div>

      <div className="image-lightbox-strip" role="group" aria-label="图片缩略图条">
        {items.map((item, itemIndex) => (
          <button
            key={item.id}
            ref={itemIndex === index ? activeStripItemRef : undefined}
            className={itemIndex === index ? "active" : ""}
            aria-label={`查看 ${item.name}`}
            aria-current={itemIndex === index ? "true" : undefined}
            title={item.name}
            onClick={() => setIndex(itemIndex)}
          >
            <FileThumbnail src={item.thumbUrl} kind="image" size={44} iconSize={26} />
          </button>
        ))}
      </div>

      <div className="image-lightbox-nav">
        <button disabled={index === 0} onClick={() => changeImage(-1)}>上一张</button>
        <button disabled={index >= items.length - 1} onClick={() => changeImage(1)}>下一张</button>
        <span className="image-lightbox-hint" aria-hidden="true">
          缩放 {zoomLabel} · ←/→ 切换 · Esc 关闭
        </span>
      </div>
    </div>,
    document.body,
  );
}
