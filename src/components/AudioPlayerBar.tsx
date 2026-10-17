import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaybackSnapshot } from "../domain/media";
import { getFilePresentation } from "../domain/fileTypes";
import { Cloud115Service, PlaybackService } from "../services/mediaServices";
import { FileTypeIcon } from "./FileTypeIcon";
import { Icon } from "./Icon";

/** 与 App.tsx 一致的播放快照轮询间隔；Rust 侧没有播放推送事件，只能低频轮询。 */
const SNAPSHOT_POLL_INTERVAL_MS = 500;

/** 模块级单例服务：与服务层其它组件的用法一致，避免每次渲染重复构造。 */
const cloud115Service = new Cloud115Service();
const playbackService = new PlaybackService();

/** 播放条收起或尚未打开任何媒体时的空状态快照，语义与 App.tsx 的 IDLE_SNAPSHOT 相同。 */
const IDLE_SNAPSHOT: PlaybackSnapshot = {
  initialized: false,
  source: null,
  paused: true,
  positionSeconds: null,
  durationSeconds: null,
  volume: 80,
  error: null,
};

/**
 * 播放条需要的最小音频文件信息。
 * 只取播放链路真正用到的字段，避免组件耦合 Cloud115FileEntry 这类会持续演进的模型。
 */
export type AudioTrack = {
  /** 115 文件 id；用于区分「换歌」与「同一首重新打开」。 */
  fileId: string;
  /** 展示用文件名（含扩展名）。 */
  name: string;
  /** 115 的文件提取码；换直链、过期自动恢复都依赖它。 */
  pickCode: string;
};

export type AudioPlayerBarProps = {
  /** 当前音频轨道；null 表示没有音频在播放，组件不渲染任何 DOM。 */
  track: AudioTrack | null;
  /**
   * 播放条被用户结束（点击「结束播放」或播放失败后收起）时回调。
   * 应用壳在此清空 track；组件不自行决定上层状态。
   */
  onStop: () => void;
  /**
   * 失败上报回调，交给应用壳统一错误横幅展示。
   * 不传时组件在播放条内部展示错误文本，不会静默丢失。
   */
  onError?: (message: string) => void;
};

/**
 * 判断一个文件是否音频。
 *
 * 复用 `domain/fileTypes.ts` 既有的 `EXTENSION_GROUPS.audio`（含 mp3/flac/wav/m4a/aac/
 * ogg/opus/ape/wma 等），不在此重复维护扩展名清单。
 * 只接受 name/extension 而不接受 `kind`：`Cloud115FileEntry.kind` 由 Rust 侧持续演进，
 * 组件不应耦合该联合类型。
 *
 * @param file 至少包含文件名；`extension` 优先于文件名后缀（与服务端元数据口径一致）
 * @returns 是音频返回 true
 */
export function isAudioFile(file: { name: string; extension?: string | null }): boolean {
  return getFilePresentation({ name: file.name, extension: file.extension }).kind === "audio";
}

/**
 * 结构化转换：把 115 文件条目裁剪成播放条所需的 `AudioTrack`。
 *
 * 单独暴露是为了让接线处（文件页/应用壳）不必关心播放条内部字段，
 * 也不会把整个 `Cloud115FileEntry` 透传进组件。
 *
 * @param entry 至少包含 id / name / pickCode 的 115 文件条目
 * @returns 可直接传给 `AudioPlayerBar` 的 track
 */
export function toAudioTrack(entry: { id: string; name: string; pickCode: string }): AudioTrack {
  return { fileId: entry.id, name: entry.name, pickCode: entry.pickCode };
}

/**
 * 将秒数格式化为播放器时间码。
 * 说明：App.tsx 内的同名逻辑是私有的 formatTime，这里按最小改动复刻一份；
 * 若后续提取公共工具，应两处一起替换。
 * @param seconds 秒数，允许为 null（未知时长）
 * @returns `m:ss` 或 `h:mm:ss`；未知时返回 `--:--`
 */
function formatClock(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "--:--";
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

/**
 * 115 网盘音频常驻播放条。
 *
 * 播放链与视频完全一致：pickCode → downloadSource（downurl 直链）→ PlaybackService.openRemote
 * → Rust PlaybackManager（libmpv 原生支持音频）。libmpv 是唯一播放会话，因此同一时刻
 * 只应有一条音频在播；换歌直接复用同一会话。
 *
 * 播放快照沿用 App.tsx 的现有做法：初始化后每 500ms 轮询 playbackService.snapshot()，
 * 不额外发明事件推送机制。
 *
 * @param props.track 当前音频轨道
 * @param props.onStop 结束播放回调（由应用壳清空轨道）
 * @param props.onError 失败上报回调
 */
export function AudioPlayerBar({ track, onStop, onError }: AudioPlayerBarProps) {
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot>(IDLE_SNAPSHOT);
  /** 直链解析 + 打开播放器期间的忙态；此阶段进度/暂停不可用，避免对未初始化会话发命令。 */
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 进度条拖动中的本地预览值；非拖动时为 null，显示真实播放位置。 */
  const [seekPreview, setSeekPreview] = useState<number | null>(null);

  const seekCommitTimer = useRef<number | null>(null);
  /** 最近一次非零音量，用于取消静音时恢复。 */
  const lastVolumeRef = useRef(60);
  /** 本组件是否成功打开过播放会话；收起播放条时只释放自己持有的会话。 */
  const ownsSessionRef = useRef(false);
  /**
   * 本组件打开成功时播放器返回的 source（即直链 URL）。
   * libmpv 是全局唯一会话，视频开始播放会直接顶掉音频；靠它判断会话是否还属于本组件，
   * 避免「结束播放」误杀别人刚打开的会话。
   */
  const ownedSourceRef = useRef<string | null>(null);
  /** 最近一次轮询到的播放器 source；供 destroy 前的归属校验使用（不参与渲染）。 */
  const latestSourceRef = useRef<string | null>(null);
  /** 已上报过的播放器错误，避免每 500ms 轮询重复刷同一条错误。 */
  const lastPlaybackErrorRef = useRef<string | null>(null);
  /**
   * 打开请求串行链：libmpv 只有一个播放会话，若先后两次 openRemote 并行，
   * 后发请求可能先返回、随后被先发请求覆盖。串行化保证「最后点击的轨道」最终占住会话。
   */
  const openChainRef = useRef<Promise<void>>(Promise.resolve());

  // 上层的 onError 可能每次渲染都是新函数；用 ref 持有最新引用，避免订阅被反复重建。
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // onStop 同理：轮询 effect 只在初始化状态变化时重建，不能因上层新函数引用而重启定时器。
  const onStopRef = useRef(onStop);
  onStopRef.current = onStop;

  // track 对象可能每次渲染都是新引用，用 ref 取最新值；effect 只按 fileId+pickCode 组合键重跑，
  // 否则父组件任何一次重渲染都会重新解析直链并打断正在播放的音频。
  const trackRef = useRef(track);
  trackRef.current = track;
  const trackKey = track ? `${track.fileId}::${track.pickCode}` : "";

  /** 统一错误出口：条内可见 + 上抛给应用壳；绝不静默吞掉异常。 */
  const reportError = useCallback((message: string) => {
    setError(message);
    onErrorRef.current?.(message);
  }, []);

  /**
   * 释放本组件持有的播放会话。
   *
   * libmpv 是全应用唯一会话，因此销毁前必须确认它仍属于本组件：用户开始播放视频时，
   * 视频会直接顶掉音频占用同一个会话，此时销毁会误杀视频。轮询有 500ms 间隔，
   * 所以这里重新取一次实时快照再判定，把误杀窗口压到最小。
   *
   * @returns 成功（或无需销毁）返回 null；销毁失败返回错误文本
   */
  const releaseOwnedSession = useCallback(async (): Promise<string | null> => {
    if (!ownsSessionRef.current) return null;
    const ownedSource = ownedSourceRef.current;
    // 放弃归属：无论后续是否真的发 destroy，本组件都不应再对会话负责。
    ownsSessionRef.current = false;
    ownedSourceRef.current = null;
    let currentSource = latestSourceRef.current;
    try {
      // 以播放器实时状态为准，避免用最多 500ms 前的轮询结果做决定。
      currentSource = (await playbackService.snapshot()).source;
      latestSourceRef.current = currentSource;
    } catch (reason) {
      // 读不到快照时退回最近一次已知状态；这不影响释放流程，但要显式记录。
      console.error("释放音频会话前读取播放快照失败，使用最近一次已知状态", reason);
    }
    // 会话已消失（source 为 null）或已被其它播放源接管：两种情况都不该再 destroy。
    if (currentSource === null) return null;
    if (ownedSource !== null && currentSource !== ownedSource) return null;
    try {
      await playbackService.destroy();
      return null;
    } catch (reason) {
      return String(reason);
    }
  }, []);

  // 换歌（fileId/pickCode 变化）时重新解析直链并交给唯一播放会话。
  // 两个关键保护：
  // 1) 串行化：libmpv 只有一条播放会话，两次 openRemote 并行时后发请求可能先返回、
  //    再被先发请求覆盖；串行链保证「最后点击的轨道」最终占住会话。
  // 2) active 标记：换歌或卸载后，旧链上的结果直接丢弃，不写状态。
  useEffect(() => {
    // trackKey 为空串表示没有音频轨道：无需解析，也不应把会话重置为空。
    if (trackKey === "") return;
    let active = true;
    setLoading(true);
    setError(null);
    setSeekPreview(null);
    setSnapshot(IDLE_SNAPSHOT);

    const open = openChainRef.current.then(async () => {
      const current = trackRef.current;
      // 排队期间可能已换歌；此时旧轨道不应再占用唯一的播放会话。
      if (!active || !current) return;
      // 下载直链与播放直链同源（POST /open/ufile/downurl），短时效，必须即时使用。
      const source = await cloud115Service.downloadSource(current.pickCode);
      if (!active) return;
      // 音频不需要字幕轨；pickCode 交给 Rust 在流错误时自动恢复直链。
      // audioOnly 让 Rust 只初始化播放会话、不显示播放器窗口：音频没有画面，弹窗是错误交互。
      const next = await playbackService.openRemote(source, [], current.pickCode, true);
      // 会话此时已真实存在，先登记归属，保证任何退出路径都能释放它。
      ownsSessionRef.current = true;
      // 记录本组件打开时的 source，用于判断会话是否已被视频等其它播放源接管。
      ownedSourceRef.current = next.source;
      latestSourceRef.current = next.source;
      // 用户在直链解析期间已点「结束播放」：这条会话没有任何控制入口，
      // 必须立刻销毁，否则会变成无法停止的隐藏音频。
      if (!active && trackRef.current === null) {
        const message = await releaseOwnedSession();
        if (message) console.error("结束音频播放时关闭迟到会话失败", message);
        return;
      }
      if (!active) return;
      setSnapshot(next);
    });
    // 链上只传递完成信号；错误在本 effect 内单独处理，避免一次失败中断后续换歌。
    openChainRef.current = open.catch(() => undefined);

    open
      .catch(async (reason: unknown) => {
        if (!active) return;
        // 打开失败时，串行链上可能刚由本组件打开过上一条轨道，会话里仍有音频在响。
        // 必须连同失败信息一起收尾，不能让界面显示 A 的错误却在放 B 的声音。
        const releaseError = await releaseOwnedSession();
        setSnapshot(IDLE_SNAPSHOT);
        const suffix = releaseError ? `；释放残留播放会话失败：${releaseError}` : "";
        reportError(`无法播放《${trackRef.current?.name ?? "音频文件"}》：${String(reason)}${suffix}`);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [trackKey, reportError, releaseOwnedSession]);

  // 应用壳把 track 置空（收起播放条）时释放本组件持有的会话，避免隐藏音频继续播放。
  useEffect(() => {
    if (trackKey !== "") return;
    const dispose = async () => {
      const message = await releaseOwnedSession();
      if (message) reportError(`关闭播放会话失败：${message}`);
    };
    void dispose();
  }, [trackKey, reportError, releaseOwnedSession]);

  // 组件整体卸载（例如离开承载播放条的工作台）时同样要释放会话，
  // 否则 libmpv 会在没有任何控制入口的情况下继续出声。
  useEffect(() => {
    return () => {
      const dispose = async () => {
        const message = await releaseOwnedSession();
        if (message) console.error("卸载音频播放条时关闭播放会话失败", message);
      };
      void dispose();
    };
  }, [releaseOwnedSession]);

  // 播放快照轮询：照抄 App.tsx 的既有模式，仅在会话初始化后启动。
  useEffect(() => {
    if (!snapshot.initialized) return;
    const interval = window.setInterval(() => {
      playbackService
        .snapshot()
        .then((next) => {
          latestSourceRef.current = next.source;
          setSnapshot(next);
          // 会话归属已被抢走或会话已被外部销毁：音频事实上已经不在播放。
          // 此时若继续留着播放条，暂停/进度按钮会去控制别人的媒体，因此主动收起并明确告知。
          const takenOver =
            ownsSessionRef.current &&
            ownedSourceRef.current !== null &&
            (next.source === null || next.source !== ownedSourceRef.current);
          if (!takenOver) {
            // 远程直链过期恢复失败会写入 error；只在错误内容变化时上报一次。
            if (next.error) {
              if (lastPlaybackErrorRef.current !== next.error) {
                lastPlaybackErrorRef.current = next.error;
                reportError(`音频播放中断：${next.error}`);
              }
            } else {
              lastPlaybackErrorRef.current = null;
            }
            return;
          }
          // 放弃归属：后续不得再 destroy，否则会误杀接管者（例如正在播放的视频）。
          ownsSessionRef.current = false;
          ownedSourceRef.current = null;
          setSnapshot(IDLE_SNAPSHOT);
          reportError(
            next.source === null
              ? "音频播放会话已被关闭，如需继续收听请重新打开该音频文件"
              : "音频播放已被其它媒体接替；如需继续收听请重新打开该音频文件",
          );
          onStopRef.current();
        })
        .catch((reason: unknown) => reportError(`读取播放状态失败：${String(reason)}`));
    }, SNAPSHOT_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [snapshot.initialized, reportError]);

  // 播放条消失时清掉拖动防抖定时器，防止卸载后仍触发 seek。
  useEffect(() => {
    return () => {
      if (seekCommitTimer.current !== null) window.clearTimeout(seekCommitTimer.current);
    };
  }, []);

  /** 暂停/继续；命令失败时上抛错误，不做静默重试。 */
  async function togglePause() {
    try {
      setSnapshot(await playbackService.togglePause());
    } catch (reason) {
      reportError(`音频播放控制失败：${String(reason)}`);
    }
  }

  /** 跳转到绝对播放位置（秒）；拖动结束或停顿后才会调用。 */
  async function seek(seconds: number) {
    try {
      setSnapshot(await playbackService.seek(seconds));
    } catch (reason) {
      reportError(`音频跳转失败：${String(reason)}`);
    }
  }

  /** 设置 0–100 音量，并记住最近一次非零值用于取消静音。 */
  async function changeVolume(volume: number) {
    try {
      const clamped = Math.min(100, Math.max(0, volume));
      if (clamped > 0) lastVolumeRef.current = clamped;
      setSnapshot(await playbackService.setVolume(clamped));
    } catch (reason) {
      reportError(`音频音量调整失败：${String(reason)}`);
    }
  }

  /** 静音即音量归零；再次点击回到最近一次非零音量。 */
  function toggleMute() {
    void changeVolume(snapshot.volume > 0 ? 0 : lastVolumeRef.current > 0 ? lastVolumeRef.current : 60);
  }

  /**
   * 结束音频播放：先释放本组件持有的 libmpv 会话，再通知应用壳收起播放条。
   * Rust 侧在没有会话时 destroy 会明确报错，所以只释放确实属于本组件的会话；
   * 会话已被视频等其它播放源接管时只收起播放条，不销毁别人的会话。
   */
  async function stopPlayback() {
    const message = await releaseOwnedSession();
    if (message) reportError(`关闭音频播放会话失败：${message}`);
    setSnapshot(IDLE_SNAPSHOT);
    onStop();
  }

  if (!track) return null;

  const position = seekPreview ?? snapshot.positionSeconds;
  const duration = snapshot.durationSeconds;
  const progressPercent =
    duration !== null && duration > 0 && position !== null
      ? Math.min(100, Math.max(0, (position / duration) * 100))
      : 0;
  const muted = snapshot.volume <= 0;
  // 会话尚未初始化（直链解析中）时按暂停态渲染播放图标。
  const paused = snapshot.paused || !snapshot.initialized;
  const statusLabel = loading
    ? "正在解析音频"
    : snapshot.initialized
      ? snapshot.paused
        ? "已暂停"
        : "正在播放音频"
      : "音频播放";

  return (
    <aside className="audio-player" aria-label="音频播放" aria-busy={loading}>
      <div className="audio-player-art" aria-hidden="true">
        <FileTypeIcon kind="audio" size={34} />
      </div>
      <div className="audio-player-copy">
        <small>{statusLabel}</small>
        <strong title={track.name}>{track.name}</strong>
      </div>
      <button
        type="button"
        className="round-control"
        onClick={() => void togglePause()}
        disabled={loading || !snapshot.initialized}
        aria-label={paused ? "继续播放音频" : "暂停音频"}
        title={paused ? "继续播放" : "暂停"}
      >
        {paused ? <Icon name="play" /> : <span className="pause-icon" />}
      </button>
      <div className="mini-progress">
        <input
          aria-label="音频播放进度"
          type="range"
          min="0"
          max={duration ?? 1}
          step="0.1"
          value={position ?? 0}
          disabled={loading || !snapshot.initialized}
          onChange={(event) => {
            // 拖动中只更新本地预览，不提交跳转。
            const value = Number(event.currentTarget.value);
            setSeekPreview(value);
            if (seekCommitTimer.current !== null) window.clearTimeout(seekCommitTimer.current);
            // 停顿 300ms 视为停止拖动，提交一次跳转（与 App.tsx 播放条一致）。
            seekCommitTimer.current = window.setTimeout(() => {
              setSeekPreview(null);
              void seek(value);
            }, 300);
          }}
          onPointerUp={(event) => {
            // 松手立即提交，并取消停顿定时器。
            if (seekCommitTimer.current !== null) window.clearTimeout(seekCommitTimer.current);
            const value = Number((event.currentTarget as HTMLInputElement).value);
            setSeekPreview(null);
            void seek(value);
          }}
          style={{ "--progress": `${progressPercent}%` } as React.CSSProperties}
        />
        <span>
          {formatClock(position)} / {formatClock(duration)}
        </span>
      </div>
      <div className="volume-control">
        <button
          type="button"
          className="round-control"
          onClick={toggleMute}
          disabled={loading || !snapshot.initialized}
          aria-label={muted ? "取消静音" : "静音"}
          title={muted ? "取消静音" : "静音"}
        >
          <Icon name={muted ? "volumeOff" : "volume"} size={17} />
        </button>
        <input
          aria-label="音频音量"
          type="range"
          min="0"
          max="100"
          step="1"
          value={snapshot.volume}
          disabled={loading || !snapshot.initialized}
          onChange={(event) => void changeVolume(Number(event.currentTarget.value))}
          style={{ "--progress": `${snapshot.volume}%` } as React.CSSProperties}
        />
      </div>
      <button type="button" className="stop-control" onClick={() => void stopPlayback()}>
        结束播放
      </button>
      {error && (
        <p className="audio-player-error" role="alert">
          {error}
        </p>
      )}
    </aside>
  );
}
