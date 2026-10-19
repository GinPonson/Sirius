import { useCallback, useEffect, useRef, useState } from "react";
import type { PlayerWindowAction, PlayerWindowState } from "../domain/playerWindow";
import { PlayerWindowService } from "../services/playerWindowService";
import { Icon } from "./Icon";
import "../PlayerControls.css";

const playerWindowService = new PlayerWindowService();
const CANVAS_CLICK_DELAY_MS = 500;
const CONTROLS_HIDE_DELAY_MS = 3000;

type SliderKind = "seek" | "volume";
type SliderGesture = "pointer" | "keyboard" | null;

/** 将播放时间格式化为含小时、分钟和秒的时间码。 */
function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "--:--:--";
  const wholeSeconds = Math.floor(seconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainder = wholeSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

/** 将数值限制在范围内，供时间轴和音量预览复用。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 将服务异常转成当前播放器窗口可读的错误文本。 */
function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** 独立视频窗口控件页；仅展示主窗口确认过的状态，并等待每个操作的实际结果。 */
export function PlayerControls() {
  const [state, setState] = useState<PlayerWindowState | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const [volumePreview, setVolumePreview] = useState<number | null>(null);
  const mountedRef = useRef(false);
  const stateRef = useRef<PlayerWindowState | null>(null);
  const actionFlightRef = useRef<Promise<boolean> | null>(null);
  const canvasClickTimerRef = useRef<number | null>(null);
  const controlsHideTimerRef = useRef<number | null>(null);
  const dockRef = useRef<HTMLElement | null>(null);
  const controlsVisibleRef = useRef(true);
  const dockHoveredRef = useRef(false);
  const dockFocusedRef = useRef(false);
  const autoHideEligibleRef = useRef(false);
  const sliderGestureRef = useRef<Record<SliderKind, SliderGesture>>({ seek: null, volume: null });
  const sliderPointerRef = useRef<Record<SliderKind, number | null>>({ seek: null, volume: null });
  const sliderInputRef = useRef<Record<SliderKind, HTMLInputElement | null>>({ seek: null, volume: null });

  // 事件处理器读取同步引用，避免每次权威状态更新时重新订阅快捷键和 IPC 监听器。
  stateRef.current = state;

  /** 清除唯一的 dock 自动隐藏计时器。
   * @returns {void} 清理定时器引用。
   */
  const clearControlsHideTimer = useCallback(() => {
    if (controlsHideTimerRef.current !== null) {
      window.clearTimeout(controlsHideTimerRef.current);
      controlsHideTimerRef.current = null;
    }
  }, []);

  /** 同步 React 状态与事件回调读取的 dock 可见标记。
   * @param {boolean} visible 目标可见状态。
   * @returns {void} 仅更新本地显示状态。
   */
  const setDockVisible = useCallback((visible: boolean) => {
    if (controlsVisibleRef.current === visible) return;
    controlsVisibleRef.current = visible;
    setControlsVisible(visible);
  }, []);

  /** 立即显示 dock 并取消待执行的隐藏计时。
   * @returns {void} 只影响控件可见性。
   */
  const showDock = useCallback(() => {
    clearControlsHideTimer();
    setDockVisible(true);
  }, [clearControlsHideTimer, setDockVisible]);

  /** 正常播放且 dock 未悬停或聚焦时，安排一次三秒后的隐藏。
   * @returns {void} 不会创建重复的周期计时器。
   */
  const scheduleDockHide = useCallback(() => {
    clearControlsHideTimer();
    setDockVisible(true);
    if (!autoHideEligibleRef.current || dockHoveredRef.current || dockFocusedRef.current) return;

    controlsHideTimerRef.current = window.setTimeout(() => {
      controlsHideTimerRef.current = null;
      if (autoHideEligibleRef.current && !dockHoveredRef.current && !dockFocusedRef.current) {
        setDockVisible(false);
      }
    }, CONTROLS_HIDE_DELAY_MS);
  }, [clearControlsHideTimer, setDockVisible]);

  /** 响应窗口级指针移动并判断 dock 悬停状态；触摸指针不锁定悬停。
   * @param {PointerEvent} event 提供视口坐标的窗口指针事件。
   * @returns {void} 显示控件，并按悬停区域安排隐藏。
   */
  const updateDockPointer = useCallback((event: PointerEvent) => {
    const bounds = dockRef.current?.getBoundingClientRect();
    dockHoveredRef.current = event.pointerType !== "touch" && bounds !== undefined
      && event.clientX >= bounds.left && event.clientX <= bounds.right
      && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    showDock();
    if (!dockHoveredRef.current) scheduleDockHide();
  }, [scheduleDockHide, showDock]);

  /** 串行执行媒体命令；未初始化时仅允许显式放行的 ready 操作。
   * @param {() => Promise<unknown>} operation 需要等待实际结果的服务调用。
   * @param {boolean} allowUninitialized 是否允许在初始化前执行该操作。
   * @returns {Promise<boolean>} 操作成功为 true；锁占用、未初始化或失败时为 false。
   */
  const runExclusive = useCallback((operation: () => Promise<unknown>, allowUninitialized = false) => {
    if (actionFlightRef.current !== null) return Promise.resolve(false);
    if (!allowUninitialized && !stateRef.current?.initialized) return Promise.resolve(false);

    showDock();
    setBusy(true);
    setActionError(null);
    const flight = (async () => {
      try {
        await operation();
        return true;
      } catch (reason) {
        if (mountedRef.current) setActionError(errorMessage(reason));
        return false;
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    })();
    let trackedFlight: Promise<boolean>;
    trackedFlight = flight.finally(() => {
      if (actionFlightRef.current === trackedFlight) actionFlightRef.current = null;
    });
    actionFlightRef.current = trackedFlight;
    return trackedFlight;
  }, [showDock]);

  /** 将已校验的播放动作交给唯一媒体命令锁执行。
   * @param {PlayerWindowAction} action 要交给播放服务的动作。
   * @param {boolean} allowUninitialized 仅 ready 初始化操作可设置为 true。
   * @returns {Promise<boolean>} 媒体动作是否成功完成。
   */
  const performAction = useCallback(
    (action: PlayerWindowAction, allowUninitialized = false) =>
      runExclusive(() => playerWindowService.perform(action), allowUninitialized),
    [runExclusive],
  );

  /** 切换全屏；按钮始终描述切换动作，不缓存可能过期的窗口全屏状态。
   * @returns {Promise<boolean>} 原生切换是否成功；未初始化时为 false。
   */
  const toggleFullscreen = useCallback(() => {
    if (!stateRef.current?.initialized) return Promise.resolve(false);
    return runExclusive(() => playerWindowService.toggleFullscreen());
  }, [runExclusive]);

  /** 无需媒体命令锁地请求退出全屏；失败信息保留在播放器窗口显示。
   * @returns {Promise<void>} 等待原生退出命令完成；失败时更新窗口错误提示。
   */
  const exitFullscreen = useCallback(async () => {
    // Escape 必须能打断等待中的媒体操作；原生退出命令可重复调用。
    showDock();
    setActionError(null);
    try {
      await playerWindowService.exitFullscreen();
    } catch (reason) {
      if (mountedRef.current) setActionError(errorMessage(reason));
    }
  }, [showDock]);

  /** 按秒数偏移播放位置，并限制目标位置不超出有效时长。
   * @param {number} offsetSeconds 相对当前位置的秒数偏移。
   * @returns {Promise<boolean>} seek 动作是否成功完成。
   */
  const seekBy = useCallback((offsetSeconds: number) => {
    const current = stateRef.current;
    if (!current?.initialized) return Promise.resolve(false);
    const max = current.durationSeconds === null ? Number.MAX_SAFE_INTEGER : Math.max(0, current.durationSeconds);
    const next = clamp((current.positionSeconds ?? 0) + offsetSeconds, 0, max);
    return performAction({ type: "seek", seconds: next });
  }, [performAction]);

  /** 按百分点偏移音量，并将目标值限制在 0 到 100。
   * @param {number} offset 相对当前音量的百分点偏移。
   * @returns {Promise<boolean>} 音量动作是否成功完成。
   */
  const changeVolumeBy = useCallback((offset: number) => {
    const current = stateRef.current;
    if (!current?.initialized) return Promise.resolve(false);
    return performAction({ type: "volume", volume: clamp(current.volume + offset, 0, 100) });
  }, [performAction]);

  useEffect(() => {
    mountedRef.current = true;
    const documentNodes = [document.documentElement, document.body, document.getElementById("root")]
      .filter((node): node is HTMLElement => node instanceof HTMLElement);
    documentNodes.forEach((node) => node.classList.add("sirius-player-window-document"));

    return () => {
      mountedRef.current = false;
      documentNodes.forEach((node) => node.classList.remove("sirius-player-window-document"));
    };
  }, []);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const removeListener = await playerWindowService.listenState((nextState) => {
          if (!active) return;
          stateRef.current = nextState;
          setState(nextState);
          setSubscriptionError(null);
        });
        if (!active) {
          removeListener();
          return;
        }
        unlisten = removeListener;

        // StrictMode 会先清理模拟挂载；等待旧 ready 完成后再由新订阅发送一次 ready。
        const earlierAction = actionFlightRef.current;
        if (earlierAction !== null) await earlierAction;
        if (!active) return;
        await performAction({ type: "ready" }, true);
      } catch (reason) {
        if (active && mountedRef.current) setSubscriptionError(errorMessage(reason));
      }
    })();

    return () => {
      active = false;
      unlisten?.();
    };
  }, [performAction]);

  useEffect(() => {
    /** 优先处理 Escape，其余快捷键仅在非编辑控件上作用于播放器。
     * @param {KeyboardEvent} event 全局按键事件。
     * @returns {void} 分派快捷键动作，不等待媒体操作完成。
     */
    const onKeyDown = (event: KeyboardEvent) => {
      showDock();
      scheduleDockHide();
      // 原生绿色窗口按钮也会切换全屏，本地标记可能过时；退出命令本身是幂等的。
      if (event.key === "Escape") {
        event.preventDefault();
        void exitFullscreen();
        return;
      }
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof Element) {
        if (target.closest("[contenteditable='true'], input, select, textarea")) return;
        // 按钮上的空格保留浏览器原生 click，避免全局暂停与按钮操作触发两次。
        if ((event.code === "Space" || event.key === " ") && target.closest("button")) return;
      }

      if (event.code === "Space" || event.key === " ") {
        event.preventDefault();
        void performAction({ type: "pause" });
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        void seekBy(-10);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        void seekBy(10);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        void changeVolumeBy(5);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        void changeVolumeBy(-5);
      } else if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        void performAction({ type: "mute" });
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        void toggleFullscreen();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointermove", updateDockPointer);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointermove", updateDockPointer);
    };
  }, [changeVolumeBy, exitFullscreen, performAction, scheduleDockHide, seekBy, showDock, toggleFullscreen, updateDockPointer]);

  useEffect(() => () => {
    if (canvasClickTimerRef.current !== null) window.clearTimeout(canvasClickTimerRef.current);
    clearControlsHideTimer();
  }, [clearControlsHideTimer]);

  const initialized = state?.initialized === true;
  const controlsDisabled = !initialized || busy;
  const duration = state?.durationSeconds ?? null;
  const position = seekPreview ?? state?.positionSeconds ?? null;
  const displayedVolume = volumePreview ?? state?.volume ?? 0;
  const seekMaximum = Math.max(1, duration ?? 1);
  const seekPercent = duration && duration > 0 ? clamp((position ?? 0) / duration * 100, 0, 100) : 0;
  const volumePercent = clamp(displayedVolume, 0, 100);
  const visibleError = actionError || state?.error || subscriptionError;
  const autoHideEligible = initialized && state?.paused === false && !visibleError && !busy;
  autoHideEligibleRef.current = autoHideEligible;

  useEffect(() => {
    if (autoHideEligible) scheduleDockHide();
    else {
      clearControlsHideTimer();
      setDockVisible(true);
    }
  }, [autoHideEligible, clearControlsHideTimer, scheduleDockHide, setDockVisible]);

  /** 标记时间轴或音量滑杆当前由指针还是键盘驱动。
   * @param {SliderKind} kind 需要追踪的时间轴或音量滑杆。
   * @param {Exclude<SliderGesture, null>} gesture 仅接受指针或键盘手势。
   * @returns {void} 后续预览和提交处理据此识别手势来源。
   */
  function startSliderGesture(kind: SliderKind, gesture: Exclude<SliderGesture, null>) {
    sliderGestureRef.current[kind] = gesture;
  }

  /** 记录原生 range 的指针手势，不接管 WebKit 的内建拖动。
   * @param {SliderKind} kind 当前操作的滑杆。
   * @param {React.PointerEvent<HTMLInputElement>} event 该滑杆收到的 pointerdown 事件。
   * @returns {void} 保存 pointer id，供输入与 window 释放事件匹配。
   */
  function beginSliderPointer(kind: SliderKind, event: React.PointerEvent<HTMLInputElement>) {
    startSliderGesture(kind, "pointer");
    sliderPointerRef.current[kind] = event.pointerId;
  }

  /** 更新拖动或按键期间的本地预览；预览只在手势结束时提交。
   * @param {SliderKind} kind 预览对应的时间轴或音量滑杆。
   * @param {number} value range 当前值；最终提交前会再次限制到有效范围。
   * @returns {void} 只更新本地预览，不发送播放命令。
   */
  function updateSliderPreview(kind: SliderKind, value: number) {
    if (sliderGestureRef.current[kind] === null) sliderGestureRef.current[kind] = "keyboard";
    if (kind === "seek") setSeekPreview(clamp(value, 0, seekMaximum));
    else setVolumePreview(clamp(value, 0, 100));
  }

  /** 提交一次已完成的滑杆手势，并将约束后的目标值发送给播放器。
   * @param {SliderKind} kind 需要提交的时间轴或音量滑杆。
   * @param {number} value 手势结束时的 range 值，每个手势仅提交一次。
   * @returns {void} 清除预览并分派一次 seek 或音量动作。
   */
  const commitSlider = useCallback((kind: SliderKind, value: number) => {
    sliderGestureRef.current[kind] = null;
    if (kind === "seek") {
      setSeekPreview(null);
      const currentDuration = stateRef.current?.durationSeconds ?? 1;
      void performAction({ type: "seek", seconds: clamp(value, 0, Math.max(1, currentDuration)) });
    } else {
      setVolumePreview(null);
      void performAction({ type: "volume", volume: clamp(value, 0, 100) });
    }
  }, [performAction]);

  /** 取消未提交的指针或键盘手势，并恢复权威状态对应的滑杆值。
   * @param {SliderKind} kind 需要放弃预览的时间轴或音量滑杆。
   * @returns {void} 清除预览，不发送播放命令。
   */
  const cancelSlider = useCallback((kind: SliderKind) => {
    sliderGestureRef.current[kind] = null;
    if (kind === "seek") setSeekPreview(null);
    else setVolumePreview(null);
  }, []);

  /** 提交匹配的指针释放；清空 pointer id 后，输入与 window 回调天然只会执行一次。
   * @param {SliderKind} kind 当前操作的 range 输入。
   * @param {number} pointerId 必须匹配 pointerdown 的原生指针编号。
   * @returns {void} 使用输入当前值提交；缺少输入时放弃预览。
   */
  const finishSliderPointer = useCallback((kind: SliderKind, pointerId: number) => {
    if (sliderPointerRef.current[kind] !== pointerId) return;
    sliderPointerRef.current[kind] = null;
    const input = sliderInputRef.current[kind];
    if (!input) {
      cancelSlider(kind);
      return;
    }
    commitSlider(kind, Number(input.value));
  }, [cancelSlider, commitSlider]);

  /** 仅取消 pointerdown 对应的指针手势，不提交可能未确认的值。
   * @param {SliderKind} kind 当前操作的 range 输入。
   * @param {number} pointerId 必须匹配已记录的指针编号。
   * @returns {void} 清除本地预览，不发送播放命令。
   */
  const cancelSliderPointer = useCallback((kind: SliderKind, pointerId: number) => {
    if (sliderPointerRef.current[kind] !== pointerId) return;
    sliderPointerRef.current[kind] = null;
    cancelSlider(kind);
  }, [cancelSlider]);

  /** 窗口失焦或转入后台时放弃所有未提交预览，避免恢复后产生意外跳转。
   * @returns {void} 清除指针和键盘手势，不发送播放命令。
   */
  const cancelActiveSliderGestures = useCallback(() => {
    (["seek", "volume"] as const).forEach((kind) => {
      sliderPointerRef.current[kind] = null;
      cancelSlider(kind);
    });
  }, [cancelSlider]);

  useEffect(() => {
    /** window 级释放事件可在原生 range 以外结束拖动。 */
    const handlePointerUp = (event: PointerEvent) => {
      (["seek", "volume"] as const).forEach((kind) => finishSliderPointer(kind, event.pointerId));
    };
    /** 取消事件只撤销对应 pointer id 的预览。 */
    const handlePointerCancel = (event: PointerEvent) => {
      (["seek", "volume"] as const).forEach((kind) => cancelSliderPointer(kind, event.pointerId));
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") cancelActiveSliderGestures();
    };

    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    window.addEventListener("blur", cancelActiveSliderGestures);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("blur", cancelActiveSliderGestures);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [cancelActiveSliderGestures, cancelSliderPointer, finishSliderPointer]);

  /** 记录可调整 range 值的键盘手势，直到对应 keyup 才提交。
   * @param {SliderKind} kind 当前操作的滑杆。
   * @param {React.KeyboardEvent<HTMLInputElement>} event 仅识别会改变 range 值的方向、端点和分页按键。
   * @returns {void} 记录手势，实际提交延迟到 keyup。
   */
  function onSliderKeyDown(kind: SliderKind, event: React.KeyboardEvent<HTMLInputElement>) {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
      startSliderGesture(kind, "keyboard");
    }
  }

  /** 只在有效 range 按键释放时提交一次键盘预览。
   * @param {SliderKind} kind 当前操作的滑杆。
   * @param {React.KeyboardEvent<HTMLInputElement>} event 对应 keydown 的 keyup 事件。
   * @returns {void} 提交一次键盘手势，忽略无效或未开始的释放事件。
   */
  function onSliderKeyUp(kind: SliderKind, event: React.KeyboardEvent<HTMLInputElement>) {
    if (sliderGestureRef.current[kind] !== "keyboard") return;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
      commitSlider(kind, Number(event.currentTarget.value));
    }
  }

  /** 延迟单击暂停以区分双击；第二次单击取消暂停并改为切换全屏。
   * @returns {void} 单击在窗口期后提交暂停，双击只提交全屏切换。
   */
  function handleCanvasClick() {
    scheduleDockHide();
    // 等待单击窗口期，第二次单击则只执行全屏，避免先暂停再全屏。
    if (canvasClickTimerRef.current !== null) {
      window.clearTimeout(canvasClickTimerRef.current);
      canvasClickTimerRef.current = null;
      void toggleFullscreen();
      return;
    }
    canvasClickTimerRef.current = window.setTimeout(() => {
      canvasClickTimerRef.current = null;
      void performAction({ type: "pause" });
    }, CANVAS_CLICK_DELAY_MS);
  }

  /** 指针离开播放器窗口后解除悬停锁定，并按播放状态安排 dock 隐藏。
   * @returns {void} 不修改播放状态。
   */
  function handleWindowPointerLeave() {
    dockHoveredRef.current = false;
    scheduleDockHide();
  }

  /** 控件获得焦点时锁定 dock 可见，避免键盘用户的焦点落入隐藏区域。
   * @returns {void} 聚焦期间暂停自动隐藏。
   */
  function handleDockFocus() {
    dockFocusedRef.current = true;
    showDock();
  }

  /** 焦点离开整个 dock 后解除可见锁；dock 内部移动焦点不触发自动隐藏。
   * @param {React.FocusEvent<HTMLElement>} event 用 relatedTarget 判断焦点是否仍留在 dock 内。
   * @returns {void} 离开整个 dock 后解除焦点锁并恢复隐藏计时。
   */
  function handleDockBlur(event: React.FocusEvent<HTMLElement>) {
    const nextFocus = event.relatedTarget;
    if (nextFocus instanceof Node && event.currentTarget.contains(nextFocus)) return;
    dockFocusedRef.current = false;
    scheduleDockHide();
  }

  return (
    <main className="player-window" aria-label="Sirius 视频播放器" onPointerLeave={handleWindowPointerLeave}>
      <div
        className="player-stage"
        role="region"
        aria-label="视频画面，单击暂停或继续，双击切换全屏；Space 暂停，方向键控制进度和音量，F 切换全屏"
        onClick={handleCanvasClick}
      />

      <section
        ref={dockRef}
        className="player-dock"
        data-visible={controlsVisible}
        aria-label="播放控制"
        aria-hidden={!controlsVisible}
        inert={!controlsVisible}
        onFocusCapture={handleDockFocus}
        onBlurCapture={handleDockBlur}
      >
        <div className="player-dock-heading">
          <div className="player-track-copy">
            <span>{initialized ? (state?.paused ? "已暂停" : "正在播放") : "播放器"}</span>
            <strong>{state?.title || (initialized ? "视频" : "正在连接播放器…")}</strong>
          </div>
          {state && state.qualities.length > 0 && (
            <label className="player-quality">
              <span>画质</span>
              <select
                aria-label="画质"
                value={state.activeQuality}
                disabled={controlsDisabled || state.qualities.length < 2}
                onChange={(event) => void performAction({ type: "quality", quality: event.currentTarget.value })}
              >
                {state.qualities.map((quality) => <option key={quality} value={quality}>{quality}</option>)}
              </select>
            </label>
          )}
        </div>

        {visibleError && <div className="player-error" role="alert">{visibleError}</div>}
        {state?.warning && (
          <div className="player-warning" role="status">
            <span>字幕未能加载，视频仍可播放；重新打开窗口可重试。</span>
            <details>
              <summary>查看原因</summary>
              <span>{state.warning}</span>
            </details>
          </div>
        )}

        <div className="player-timeline">
          <input
            ref={(input) => { sliderInputRef.current.seek = input; }}
            aria-label="视频播放进度"
            title="方向键调整进度；主画面方向键可快退或快进 10 秒"
            type="range"
            min="0"
            max={seekMaximum}
            step="0.1"
            value={position ?? 0}
            disabled={controlsDisabled || duration === null || duration <= 0}
            style={{ "--player-range-progress": `${seekPercent}%` } as React.CSSProperties}
            onPointerDown={(event) => beginSliderPointer("seek", event)}
            onChange={(event) => updateSliderPreview("seek", Number(event.currentTarget.value))}
            onPointerUp={(event) => finishSliderPointer("seek", event.pointerId)}
            onPointerCancel={(event) => cancelSliderPointer("seek", event.pointerId)}
            onKeyDown={(event) => onSliderKeyDown("seek", event)}
            onKeyUp={(event) => onSliderKeyUp("seek", event)}
            onBlur={() => {
              if (sliderGestureRef.current.seek === "keyboard") cancelSlider("seek");
            }}
          />
          <div className="player-timecode" aria-live="off">
            <span>{formatTime(position)}</span>
            <span aria-hidden="true">/</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        <div className="player-dock-controls">
          <div className="player-control-group" aria-label="播放和跳转">
            <button
              type="button"
              className="player-button player-button-primary"
              aria-label={state?.paused ? "继续播放" : "暂停"}
              aria-pressed={initialized ? !state?.paused : undefined}
              title={state?.paused ? "继续播放（Space）" : "暂停（Space）"}
              disabled={controlsDisabled}
              onClick={() => void performAction({ type: "pause" })}
            >
              <Icon name={state?.paused ? "play" : "pause"} size={19} />
            </button>
            <button
              type="button"
              className="player-button"
              aria-label="后退 10 秒"
              title="后退 10 秒（←）"
              disabled={controlsDisabled}
              onClick={() => void seekBy(-10)}
            >
              <Icon name="back10" size={18} />
            </button>
            <button
              type="button"
              className="player-button"
              aria-label="前进 10 秒"
              title="前进 10 秒（→）"
              disabled={controlsDisabled}
              onClick={() => void seekBy(10)}
            >
              <Icon name="forward10" size={18} />
            </button>
          </div>

          <div className="player-volume-group" aria-label="音量控制">
            <button
              type="button"
              className="player-button"
              aria-label={displayedVolume > 0 ? "静音" : "取消静音"}
              aria-pressed={displayedVolume === 0}
              title={displayedVolume > 0 ? "静音（M）" : "取消静音（M）"}
              disabled={controlsDisabled}
              onClick={() => void performAction({ type: "mute" })}
            >
              <Icon name={displayedVolume > 0 ? "volume" : "volumeOff"} size={18} />
            </button>
            <input
              ref={(input) => { sliderInputRef.current.volume = input; }}
              aria-label="音量"
              title="滑杆方向键微调；主画面 ↑ / ↓ 调整音量 5"
              type="range"
              min="0"
              max="100"
              step="1"
              value={displayedVolume}
              disabled={controlsDisabled}
              style={{ "--player-range-progress": `${volumePercent}%` } as React.CSSProperties}
              onPointerDown={(event) => beginSliderPointer("volume", event)}
              onChange={(event) => updateSliderPreview("volume", Number(event.currentTarget.value))}
              onPointerUp={(event) => finishSliderPointer("volume", event.pointerId)}
              onPointerCancel={(event) => cancelSliderPointer("volume", event.pointerId)}
              onKeyDown={(event) => onSliderKeyDown("volume", event)}
              onKeyUp={(event) => onSliderKeyUp("volume", event)}
              onBlur={() => {
                if (sliderGestureRef.current.volume === "keyboard") cancelSlider("volume");
              }}
            />
          </div>

          <div className="player-dock-spacer" />

          <button
            type="button"
            className="player-button"
            aria-label="切换全屏"
            title="切换全屏（F）"
            disabled={controlsDisabled}
            onClick={() => void toggleFullscreen()}
          >
            <Icon name="fullscreen" size={18} />
          </button>
          <button
            type="button"
            className="player-stop-button"
            disabled={controlsDisabled}
            onClick={() => void performAction({ type: "stop" })}
          >
            结束播放
          </button>
        </div>
      </section>
    </main>
  );
}
