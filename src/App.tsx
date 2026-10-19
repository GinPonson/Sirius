import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// 界面版本取自构建清单，避免覆盖安装后仍展示旧的手写版本号。
import { version as appVersion } from "../package.json";
import "./App.css";
import "./Shell.css";
import "./Workbench.css";
import posterFallback from "./assets/brand/poster-fallback.svg";
import arrivalStill from "./assets/watch-stills/arrival-desert.jpg";
import perfectDaysStill from "./assets/watch-stills/perfect-days-street.jpg";
import severanceStill from "./assets/watch-stills/severance-office.jpg";
import { Icon } from "./components/Icon";
import { AlbumsView } from "./components/AlbumsView";
import { AiChatPanel } from "./components/AiChatPanel";
import { BrandMark } from "./components/BrandMark";
import { TaskDrawer } from "./components/TaskDrawer";
import { CloudFilesView } from "./components/CloudFilesView";
import { RecycleBinView } from "./components/RecycleBinView";
import { TransfersView } from "./components/TransfersView";
import { BackupView } from "./components/BackupView";
import { ComicsView } from "./components/ComicsView";
import {
  AiOrganizationService,
  type AiProviderSettingsView,
} from "./services/aiServices";
import { SettingsModal } from "./components/SettingsModal";
import { AudioPlayerBar, isAudioFile, toAudioTrack, type AudioTrack } from "./components/AudioPlayerBar";
import { LoginGate } from "./components/LoginGate";
import { MediaDetail } from "./components/MediaDetail";
import { PosterCard } from "./components/PosterCard";
import { Sidebar, type SidebarNavId } from "./components/Sidebar";
import { showToast, ToastHost } from "./components/Toast";
import { PlayerWindowService } from "./services/playerWindowService";
import type { PlayerActionRequest, PlayerWindowClosed, PlayerWindowState } from "./domain/playerWindow";
import { TopBar, type TopBarSearch, type TopBarSearchScope } from "./components/TopBar";
import type {
  AppSection,
  LibraryTask,
  MediaItem,
  PlaybackSnapshot,
} from "./domain/media";
import { registerAppPageContext, notifyPageContextChanged } from "./domain/pageContext";
import {
  AppSettingsService,
  Cloud115Service,
  LocalSourceResolver,
  LibraryTaskService,
  PlaybackService,
  TauriMediaRepository,
  type AppSettings,
  type Cloud115AccountStatus,
  type Cloud115FileEntry,
  type Cloud115SubtitleStream,
  type Cloud115UserProfile,
} from "./services/mediaServices";

const IDLE_SNAPSHOT: PlaybackSnapshot = {
  initialized: false,
  source: null,
  paused: true,
  positionSeconds: null,
  durationSeconds: null,
  volume: 80,
  error: null,
  warning: null,
};

/** 侧栏展开态持久化键；值 "0" 表示收起，缺省视为展开。 */
const SIDEBAR_EXPANDED_KEY = "sirius-sidebar-expanded";

/** 影视单入口的三个内部视图；沿用原首页/媒体库/发现的 section 与数据逻辑。 */
const VIDEO_MODES: Array<{ id: AppSection; label: string }> = [
  { id: "home", label: "继续观看" },
  { id: "library", label: "我的媒体" },
  { id: "discover", label: "发现" },
];

/** 影视入口的三个内部视图共用一段切换 UI 与侧栏高亮。 */
function isVideoSection(section: AppSection): section is "home" | "library" | "discover" {
  return section === "home" || section === "library" || section === "discover";
}

/** 轻量导航历史条目：主视图 + 媒体详情两级；详情按 id 回放时重新解析。 */

const repository = new TauriMediaRepository();
const sourceResolver = new LocalSourceResolver();
const playbackService = new PlaybackService();
const libraryTaskService = new LibraryTaskService();
const cloud115Service = new Cloud115Service();
const appSettingsService = new AppSettingsService();
const playerWindowService = new PlayerWindowService();

/** 演示阶段的播放截图；真实链路接入后由播放记录返回截图 URL。 */
const WATCH_STILLS: Record<string, string> = {
  arrival: arrivalStill,
  "perfect-days": perfectDaysStill,
  severance: severanceStill,
};

/** 将秒数格式化为播放器时间码。 */
function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "--:--";
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

/** Sirius 115 第三方客户端应用壳；播放是其中一个内容模式。 */
function App() {
  const [section, setSection] = useState<AppSection>("home");
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [tasks, setTasks] = useState<LibraryTask[]>([]);
  const [selectedMedia, setSelectedMedia] = useState<MediaItem | null>(null);
  const [playingMedia, setPlayingMedia] = useState<MediaItem | null>(null);
  // 音频轨道：与 playingMedia 互斥（libmpv 只有一个会话），null 表示没有音频播放。
  const [audioTrack, setAudioTrack] = useState<AudioTrack | null>(null);
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot>(IDLE_SNAPSHOT);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "movie" | "series">("all");
  const [loading, setLoading] = useState(true);
  const [busyMediaId, setBusyMediaId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  // 错误统一走 toast：setError(null) 为兼容旧调用点的清空操作（toast 自行过期）；
  // 写入文本立即弹出轻提示，不再占据内容区顶部的常驻横幅。
  const errorRef = useRef<string | null>(null);
  const setError = useCallback((next: string | null | ((current: string | null) => string | null)) => {
    const value = typeof next === "function" ? next(errorRef.current) : next;
    errorRef.current = value;
    if (value) showToast(value, "error");
  }, []);
  const [cloudAccount, setCloudAccount] = useState<Cloud115AccountStatus | null>(null);
  const [cloudAccountError, setCloudAccountError] = useState<string | null>(null);
  const [cloudProfile, setCloudProfile] = useState<Cloud115UserProfile | null>(null);
  // 设置弹窗开合：从侧栏账号菜单进入，承载通用设置。
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [forceGate, setForceGate] = useState(false);
  const [playingCloudFileId, setPlayingCloudFileId] = useState<string | null>(null);
  // 当前播放的可切换画质档位（含正在播放的那一路）与生效档位名；空数组表示无法切换。
  const [qualityOptions, setQualityOptions] = useState<Array<{ url: string; quality: string }>>([]);
  const [activeQuality, setActiveQuality] = useState<string>("");
  // 当前远程播放源的 UA；切换画质重开同一媒体时必须沿用，否则 115 CDN 会拒绝签发。
  const [activeUserAgent, setActiveUserAgent] = useState<string>("");
  // 当前 115 视频的外挂字幕；切换画质会重新 loadfile，必须一并重挂，否则字幕轨静默消失。
  const [activeSubtitles, setActiveSubtitles] = useState<Cloud115SubtitleStream[]>([]);
  // 当前 115 视频的 pickCode；画质切换前用它重新解析短时效直链。
  const [activePickCode, setActivePickCode] = useState<string>("");
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  // 侧栏双态：收起为 80px 图标轨道，展开为图标配文字；用户选择持久化。
  const [sidebarExpanded, setSidebarExpanded] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_EXPANDED_KEY) !== "0";
    } catch {
      // 存储不可用（隐私模式等）时退回内存态默认展开，不影响本次会话。
      return true;
    }
  });
  // AI 对话面板：开合与停靠/覆盖形态由应用壳持有；消息、当前会话与「详情/AI」标签由常驻面板自身保留。
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiPanelOverlay, setAiPanelOverlay] = useState(false);
  const lastProgressSaveAt = useRef(0);
  const lastVolumeRef = useRef(60);
  const playerActionBusy = useRef(false);
  const stoppingFromMain = useRef(false);
  const playbackRevision = useRef(0);
  // 顶栏文件搜索：查询词由应用壳持有并下发到网盘文件页，防抖仍留在该页。
  const [fileQuery, setFileQuery] = useState("");
  // 文件页是否处于收藏视图；收藏不参与关键词检索，顶栏搜索框据此隐藏。
  const [cloudStarredView, setCloudStarredView] = useState(false);
  /**
   * 文件页外部刷新序号：回收站还原文件后递增，让文件页重新读取当前目录。
   * 还原目标目录只有 115 知道，文件页无法自行判断是否需要刷新，因此统一重载一次。
   */
  const [cloudFilesRefreshNonce, setCloudFilesRefreshNonce] = useState(0);
  // 轻量历史栈：覆盖主视图切换与媒体详情进出，不追求完整浏览器式历史。
  // 首次确认账号状态时决定默认分区；用户一旦手动导航便不再自动跳转。
  const defaultSectionResolved = useRef(false);
  // 记录最近一次由播放快照设置的错误，恢复成功后只清除该条，不误伤其他错误横幅。
  const lastPlaybackError = useRef<string | null>(null);

  // 顶栏搜索范围：影视页检索媒体库，网盘文件页检索当前目录；
  // 漫画/相册等尚无搜索能力的页面返回 null，顶栏不渲染搜索框。
  // 收藏视图是全账号列表、不支持关键词检索，由文件页上报后一并隐藏搜索框。
  const searchScope: TopBarSearchScope | null = isVideoSection(section)
    ? "media"
    : section === "cloud-files" && !cloudStarredView
      ? "files"
      : null;
  const topBarSearch: TopBarSearch | null =
    searchScope === null || (searchScope === "media" && selectedMedia !== null)
      ? null
      : searchScope === "media"
        ? { scope: "media", value: query, placeholder: "搜索影视库", onChange: setQuery }
        : { scope: "files", value: fileQuery, placeholder: "搜索当前目录", onChange: setFileQuery };

  useEffect(() => {
    // 展开态变化即回写 localStorage；失败只影响下次启动的初始值。
    try {
      window.localStorage.setItem(SIDEBAR_EXPANDED_KEY, sidebarExpanded ? "1" : "0");
    } catch {
      // 存储不可用时保持内存态即可。
    }
  }, [sidebarExpanded]);

  // 应用层兜底页面上下文：视图未注册更细上下文时（影视/漫画/相册等），
  // AI 面板仍能取到当前页面与页内作用域；文件页由 CloudFilesView 覆盖。
  useEffect(() => {
    registerAppPageContext(() => {
      if (isVideoSection(section)) {
        return selectedMedia
          ? { page: section, scope: "影视", detail: selectedMedia.title }
          : { page: section, scope: "影视", detail: VIDEO_MODES.find((mode) => mode.id === section)?.label };
      }
      if (section === "cloud-files") {
        return { page: "cloud-files", scope: "网盘文件" };
      }
      const scopes: Partial<Record<AppSection, string>> = {
        comics: "漫画",
        albums: "相册",
        tasks: "整理任务",
      };
      const scope = scopes[section];
      return scope ? { page: section, scope } : null;
    });
    // 分区切换会换掉兜底上下文；通知面板刷新当前上下文标签。
    notifyPageContextChanged();
    return () => {
      registerAppPageContext(null);
      notifyPageContextChanged();
    };
  }, [section, selectedMedia]);

  useEffect(() => {
    let active = true;
    appSettingsService
      .get()
      .then((settings) => {
        if (active) setAppSettings(settings);
      })
      .catch((reason) => {
        if (active) setError(`读取应用设置失败：${String(reason)}`);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    cloud115Service.accountStatus()
      .then((status) => {
        if (!active) return;
        setCloudAccount(status);
        setCloudAccountError(null);
      })
      .catch((reason) => {
        if (!active) return;
        // 读取失败不是未登录；保留 null 并让登录首屏展示真实错误和恢复指引。
        const message = `读取 115 登录状态失败：${String(reason)}`;
        setCloudAccountError(
          message.includes("重新打开应用")
            ? message
            : `${message}。如系统提示钥匙串访问授权，请允许 Sirius 访问此凭据后重新打开应用`,
        );
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (cloudAccount?.connected !== true) {
      setCloudProfile(null);
      return;
    }

    let active = true;
    cloud115Service.userProfile()
      .then((profile) => {
        if (active) setCloudProfile(profile);
      })
      .catch((reason) => {
        if (active) setError(`读取 115 用户资料失败：${String(reason)}`);
      });
    return () => { active = false; };
  }, [cloudAccount?.connected, cloudAccount?.userId]);

  useEffect(() => {
    if (cloudAccount === null || defaultSectionResolved.current) return;
    defaultSectionResolved.current = true;
    // 文件优先：确认已连接后默认进入 115 文件工作区；未登录留给登录首屏引导。
    if (cloudAccount.connected) {
      setSection("cloud-files");
    }
  }, [cloudAccount]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    // 轻量防抖避免每次输入都跨进程执行 SQLite 查询。
    const timeout = window.setTimeout(() => {
      const operation = query.trim() ? repository.search(query) : repository.list();
      operation
        .then((items) => {
          if (active) setMedia(items);
        })
        .catch((reason) => {
          if (active) setError(`读取媒体库失败：${String(reason)}`);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, query.trim() ? 180 : 0);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [query]);

  useEffect(() => {
    let active = true;
    libraryTaskService
      .tasks()
      .then((items) => {
        if (active) setTasks(items);
      })
      .catch((reason) => {
        if (active) setError(`读取整理任务失败：${String(reason)}`);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!snapshot.initialized) return;
    let active = true;
    let pending = false;
    const interval = window.setInterval(() => {
      if (pending || playerActionBusy.current) return;
      pending = true;
      const revision = playbackRevision.current;
      playbackService
        .snapshot()
        .then((next) => {
          // 已关闭的会话或控制命令之前发出的旧快照不能重新覆盖权威结果。
          if (!active || revision !== playbackRevision.current) return;
          setSnapshot(next);
          // 轮询 500ms 一次，播放器错误会持续非空：只在内容变化时弹一次提示，
          // 否则同一条「远程播放中断」会反复刷屏。错误消失只清记录，不批量撤回 toast。
          if (next.error) {
            if (lastPlaybackError.current !== next.error) {
              lastPlaybackError.current = next.error;
              setError(next.error);
            }
          } else {
            lastPlaybackError.current = null;
          }
        })
        .catch((reason) => {
          if (active && revision === playbackRevision.current) setError(`读取播放状态失败：${String(reason)}`);
        })
        .finally(() => { pending = false; });
    }, 500);
    return () => { active = false; window.clearInterval(interval); };
  }, [snapshot.initialized, setError]);

  useEffect(() => {
    if (
      appSettings?.playbackHistory !== true ||
      !playingCloudFileId ||
      snapshot.positionSeconds === null ||
      snapshot.durationSeconds === null
    ) return;
    const now = Date.now();
    if (now - lastProgressSaveAt.current < 5000) return;
    lastProgressSaveAt.current = now;
    cloud115Service
      .savePlaybackProgress(playingCloudFileId, snapshot.positionSeconds, snapshot.durationSeconds)
      .catch((reason) => setError(`保存播放进度失败：${String(reason)}`));
  }, [appSettings?.playbackHistory, playingCloudFileId, snapshot.durationSeconds, snapshot.positionSeconds]);

  const visibleMedia = useMemo(() => {
    return media.filter((item) => filter === "all" || item.kind === filter);
  }, [filter, media]);

  /** 完整播放链：媒体实体 → 来源解析 → PlaybackSource → Rust 播放器。 */
  async function playMedia(item: MediaItem) {
    setBusyMediaId(item.id);
    setError(null);
    // 视频开播会占用同一个 libmpv 会话，音频播放条必须先让位，否则 UI 与实际会话不一致。
    setAudioTrack(null);
    try {
      const source = await sourceResolver.resolve(item);
      const next = await playbackService.open(source);
      setPlayingMedia(item);
      setPlayingCloudFileId(null);
      // 本地影视没有 115 画质档位与远程字幕，清空避免沿用上一部 115 视频的状态。
      setQualityOptions([]);
      setActiveQuality("");
      setActiveSubtitles([]);
      setActivePickCode("");
      setSnapshot(next);
      setSelectedMedia(null);
    } catch (reason) {
      const message = String(reason);
      // 用户取消是正常交互，其他错误必须显式展示。
      if (!message.includes("已取消选择视频")) {
        setError(`无法播放《${item.title}》：${message}`);
      }
    } finally {
      setBusyMediaId(null);
    }
  }

  /** 将 115 文件的 pick_code 解析为短时效直链，再交给现有唯一播放器会话。 */
  async function playCloudFile(entry: Cloud115FileEntry) {
    if (!appSettings) {
      throw new Error("应用设置尚未加载完成");
    }
    // 音频与视频共用 libmpv 的单一播放会话，但交互形态不同：
    // 音频不弹独立播放窗口，改用底部常驻播放条，因此在这里分流。
    if (isAudioFile(entry)) {
      // 先把可能正在播放的视频会话释放掉，避免两个播放器抢同一会话。
      if (playingMedia) {
        try {
          await playbackService.destroy();
        } catch (reason) {
          // 会话可能已随渲染线程退出而消失；此时 destroy 会报「尚未初始化」。
          // 这类失败不该阻断音频播放——目标状态（没有视频会话）已经达成。
          // 真正的释放失败必须上报，但同样不阻止音频接管。
          const message = String(reason);
          if (!message.includes("尚未初始化") && !message.includes("已提前退出")) {
            setError(`释放视频播放会话失败：${message}`);
          }
        }
        setPlayingMedia(null);
        setPlayingCloudFileId(null);
        // 视频的画质档位与字幕随会话一并失效，清空避免音频播放条误用。
        setQualityOptions([]);
        setActiveQuality("");
        setActiveSubtitles([]);
        setActivePickCode("");
      }
      setAudioTrack(toAudioTrack(entry));
      return;
    }
    setAudioTrack(null);
    setBusyMediaId(entry.id);
    setError(null);
    try {
      // 播放地址和字幕彼此独立，同时请求可缩短进入播放窗口前的等待时间。
      const [source, subtitles, savedProgress] = await Promise.all([
        cloud115Service.playbackSource(entry.pickCode),
        cloud115Service.videoSubtitles(entry.pickCode),
        appSettings.playbackHistory
          ? cloud115Service.playbackProgress(entry.id)
          : Promise.resolve(null),
      ]);
      let next: PlaybackSnapshot;
      const resumeAt = savedProgress && savedProgress.positionSeconds >= 5 &&
        savedProgress.positionSeconds < savedProgress.durationSeconds - 30
        ? savedProgress.positionSeconds : null;
      // 本次实际生效的画质名。必须用局部变量而不是 activeQuality：setActiveQuality 不会
      // 回写当前闭包，读 state 会拿到上一部视频的档位，导致菜单把转码线路标成「原画」。
      let effectiveQuality = source.quality;
      try {
        next = await playbackService.openRemote(source, subtitles, entry.pickCode, false, resumeAt);
      } catch (primaryError) {
        // 原画直链可能因签名失效或源站异常无法起播；此时降级到第一档转码线路重试一次。
        // 只重试一次，且必须把降级事实告知用户——不能静默替换播放源。
        const fallback = source.fallbackOptions[0];
        if (!fallback) {
          throw primaryError;
        }
        next = await playbackService.openRemote(
          { ...source, url: fallback.url },
          subtitles,
          entry.pickCode,
          false,
          resumeAt,
        );
        effectiveQuality = fallback.quality || "备用线路";
        const degradeNotice = `《${entry.name}》以${source.quality}起播失败，已降级到${effectiveQuality}播放：${String(primaryError)}`;
        setError(degradeNotice);
      }
      setActiveQuality(effectiveQuality);
      setPlayingMedia({
        id: `cloud115-${entry.id}`,
        title: entry.name,
        originalTitle: entry.name,
        year: new Date().getFullYear(),
        kind: "movie",
        rating: 0,
        runtimeMinutes: 0,
        genres: [],
        overview: "",
        director: "",
        cast: [],
        posterTone: "#35415a",
        posterAccent: "#dce5f7",
        progress: 0,
        sourceLabel: "115 网盘",
        sourceStatus: "ready",
      });
      setSnapshot(next);
      setPlayingCloudFileId(entry.id);
      // 画质菜单数据：当前生效档位 + 其余可切换档位（无则空数组，UI 不渲染菜单）。
      // 降级时生效线路本身也在 fallbackOptions 里，必须按 URL 去重——否则菜单会出现
      // 两条指向同一流的项，且 React 的 key={url} 会重复。
      const primaryUrl = next.source ?? source.url;
      const seenUrls = new Set<string>();
      setQualityOptions(
        [{ url: primaryUrl, quality: effectiveQuality }, ...source.fallbackOptions].filter((option) => {
          if (seenUrls.has(option.url)) return false;
          seenUrls.add(option.url);
          return true;
        }),
      );
      setActiveUserAgent(source.userAgent);
      // 切换画质会重新 loadfile，字幕必须一并重挂；这里保存本次会话的字幕清单。
      setActiveSubtitles(subtitles);
      setActivePickCode(entry.pickCode);
      lastProgressSaveAt.current = Date.now();
    } catch (reason) {
      setError(`无法播放《${entry.name}》：${String(reason)}`);
      throw reason;
    } finally {
      setBusyMediaId(null);
    }
  }

  /**
   * 切换播放画质：把选定档位的 URL 交给同一播放会话重开，并尽量保留当前进度。
   *
   * 画质切换本质是换媒体源，进度通过 loadfile 的 start 选项随新媒体一起生效，
   * 避免异步加载尚未完成时直接 seek 返回 PropertyUnavailable 并丢失位置。
   * 115 直链是短时效签名地址，切档前先按 pickCode 重新解析一次，避免使用初次播放时
   * 签发、可能已过期的地址；重解析失败时明确报错并保留原会话，不静默换档。
   */
  async function switchQuality(option: { url: string; quality: string }) {
    if (!playingMedia || !playingCloudFileId) return;
    const resumeAt = snapshot.positionSeconds;
    const targetQuality = option.quality || "备用线路";
    setError(null);
    try {
      let targetUrl = option.url;
      if (activePickCode) {
        const fresh = await cloud115Service.playbackSource(activePickCode);
        const candidates = [{ url: fresh.url, quality: fresh.quality }, ...fresh.fallbackOptions];
        const matched = candidates.find(
          (candidate) => (candidate.quality || "备用线路") === targetQuality,
        );
        // 档位可能已被服务端下架：此时沿用原地址继续尝试，失败会在下面如实上报。
        if (matched) targetUrl = matched.url;
      }
      const next = await playbackService.openRemote(
        { url: targetUrl, userAgent: activeUserAgent },
        // 重新 loadfile 会丢弃字幕轨，必须把本次会话的字幕一并重挂。
        activeSubtitles,
        activePickCode,
        false,
        resumeAt,
      );
      setSnapshot(next);
      setActiveQuality(targetQuality);
    } catch (reason) {
      throw new Error(`切换到${targetQuality}失败：${String(reason)}`);
    }
  }

  async function togglePause() {
    try {
      setSnapshot(await playbackService.togglePause());
    } catch (reason) {
      throw new Error(`播放控制失败：${String(reason)}`);
    }
  }

  async function seek(seconds: number) {
    try {
      setSnapshot(await playbackService.seek(seconds));
    } catch (reason) {
      throw new Error(`播放跳转失败：${String(reason)}`);
    }
  }

  /** 音量（0-100）与静音：静音即音量归零，恢复时回到最近一次非零音量。 */
  async function changeVolume(volume: number) {
    try {
      const clamped = Math.min(100, Math.max(0, volume));
      if (clamped > 0) lastVolumeRef.current = clamped;
      setSnapshot(await playbackService.setVolume(clamped));
    } catch (reason) {
      throw new Error(`音量调整失败：${String(reason)}`);
    }
  }

  /** 静音前记住播放器实际音量；取消静音时恢复该值，包含首次尚未拖动音量滑杆的场景。 */
  async function toggleMute() {
    const current = snapshot.volume;
    // libmpv 初始音量可能与前端默认值不同，不能只在用户拖动滑杆时记录音量。
    if (current > 0) lastVolumeRef.current = current;
    await changeVolume(current > 0 ? 0 : (lastVolumeRef.current > 0 ? lastVolumeRef.current : 60));
  }

  /** 清理视频展示状态；原生资源必须先由 Rust 完成释放。 */
  function clearVideoState() {
    playbackRevision.current += 1;
    setSnapshot(IDLE_SNAPSHOT);
    setPlayingMedia(null);
    setPlayingCloudFileId(null);
    setQualityOptions([]);
    setActiveQuality("");
    setActiveSubtitles([]);
    setActivePickCode("");
  }

  /** 保存已知进度后关闭唯一播放会话；保存失败不阻止资源释放。 */
  async function stopPlayback() {
    stoppingFromMain.current = true;
    let progressError: string | null = null;
    if (
      appSettings?.playbackHistory === true &&
      playingCloudFileId &&
      snapshot.positionSeconds !== null &&
      snapshot.durationSeconds !== null
    ) {
      try {
        await cloud115Service.savePlaybackProgress(playingCloudFileId, snapshot.positionSeconds, snapshot.durationSeconds);
      } catch (reason) {
        // 保存失败不能阻止原生播放资源释放，错误会在销毁完成后继续展示。
        progressError = `保存播放进度失败：${String(reason)}`;
      }
    }

    try {
      await playbackService.destroy();
      clearVideoState();
    } catch (reason) {
      const destroyError = `关闭播放会话失败：${String(reason)}`;
      throw new Error(progressError ? `${progressError}；${destroyError}` : destroyError);
    } finally {
      stoppingFromMain.current = false;
    }
    if (progressError) throw new Error(progressError);
  }

  const playerWindowState: PlayerWindowState = useMemo(() => ({
    title: playingMedia?.title ?? "正在准备播放",
    initialized: audioTrack === null && snapshot.initialized && playingMedia !== null,
    paused: snapshot.paused,
    positionSeconds: snapshot.positionSeconds,
    durationSeconds: snapshot.durationSeconds,
    volume: snapshot.volume,
    error: snapshot.error,
    warning: snapshot.warning,
    qualities: qualityOptions.map((option) => option.quality || "备用线路"),
    activeQuality,
  }), [activeQuality, audioTrack, playingMedia, qualityOptions, snapshot]);

  // 监听只注册一次，通过 ref 读取当前会话，避免 500ms 状态更新反复注销监听产生空档。
  const playerRequestHandler = useRef<(request: PlayerActionRequest) => Promise<void>>(async () => {});
  const playerClosedHandler = useRef<(result: PlayerWindowClosed) => void>(() => {});
  const playerCloseErrorHandler = useRef<(result: PlayerWindowClosed) => void>(() => {});
  playerRequestHandler.current = async ({ id, action }) => {
    let error: string | null = null;
    let ownsAction = false;
    try {
      if (action.type === "ready") {
        await playerWindowService.publishState(playerWindowState);
      } else {
        if (!playerWindowState.initialized) throw new Error("视频会话尚未准备好");
        if (playerActionBusy.current) throw new Error("上一项播放操作尚未完成，请稍后重试");
        playerActionBusy.current = true;
        playbackRevision.current += 1;
        ownsAction = true;
        switch (action.type) {
          case "pause": await togglePause(); break;
          case "seek": await seek(action.seconds); break;
          case "volume": await changeVolume(action.volume); break;
          case "mute": await toggleMute(); break;
          case "stop": await stopPlayback(); break;
          case "quality": {
            const option = qualityOptions.find((candidate) => (candidate.quality || "备用线路") === action.quality);
            if (!option) throw new Error("该画质已不可用，请重新选择");
            await switchQuality(option);
            break;
          }
        }
      }
    } catch (reason) {
      error = String(reason);
      // 结束播放可能已经销毁接收结果的控件页，相关错误仍需在工作区可见。
      if (action.type === "stop") setError(error);
    } finally {
      if (ownsAction) {
        playbackRevision.current += 1;
        playerActionBusy.current = false;
      }
    }
    await playerWindowService.reply({ id, error });
  };
  playerClosedHandler.current = ({ error }) => {
    // 用户点击原生关闭按钮时，Rust 已先释放 CGL/mpv，再通知主界面保存最后一次快照。
    // 主界面主动结束已经保存过进度，不能再用同一关闭事件重复提交。
    if (!stoppingFromMain.current && appSettings?.playbackHistory && playingCloudFileId &&
        snapshot.positionSeconds !== null && snapshot.durationSeconds !== null) {
      void cloud115Service.savePlaybackProgress(playingCloudFileId, snapshot.positionSeconds, snapshot.durationSeconds)
        .catch((reason) => setError(`保存播放进度失败：${String(reason)}`));
    }
    clearVideoState();
    if (error) setError(error);
  };
  playerCloseErrorHandler.current = ({ error }) => {
    if (!error) return;
    setError(error);
    void playerWindowService.publishState({ ...playerWindowState, error })
      .catch((reason) => setError(`同步播放器关闭错误失败：${String(reason)}`));
  };

  useEffect(() => {
    let disposed = false;
    const removers: Array<() => void> = [];
    void Promise.allSettled([
      playerWindowService.listenActions((request) => {
        void playerRequestHandler.current(request).catch((reason) => setError(`播放器通信失败：${String(reason)}`));
      }),
      playerWindowService.listenClosed((result) => playerClosedHandler.current(result)),
      playerWindowService.listenCloseError((result) => playerCloseErrorHandler.current(result)),
    ]).then((results) => {
      for (const result of results) {
        if (result.status === "fulfilled") {
          if (disposed) result.value();
          else removers.push(result.value);
        } else if (!disposed) setError(`注册播放器监听失败：${String(result.reason)}`);
      }
    });
    return () => {
      disposed = true;
      removers.forEach((remove) => remove());
    };
  }, [setError]);

  useEffect(() => {
    if (audioTrack !== null || playingMedia === null) return;
    void playerWindowService.publishState(playerWindowState)
      .catch((reason) => setError(`同步播放器状态失败：${String(reason)}`));
  }, [audioTrack, playingMedia, playerWindowState, setError]);

  /** 原子保存设置；失败时保留上一次已确认的内存状态。 */
  async function updateAppSettings(next: AppSettings) {
    setSavingSettings(true);
    setError(null);
    try {
      setAppSettings(await appSettingsService.update(next));
    } catch (reason) {
      setError(`保存应用设置失败：${String(reason)}`);
    } finally {
      setSavingSettings(false);
    }
  }

  /** 选择本地目录，执行 Rust 递归扫描，并用数据库结果刷新任务页。 */
  async function scanDirectory() {
    setScanning(true);
    setError(null);
    try {
      await libraryTaskService.scanLocalDirectory();
      setTasks(await libraryTaskService.tasks());
    } catch (reason) {
      const message = String(reason);
      if (!message.includes("已取消选择目录")) {
        setError(`扫描媒体目录失败：${message}`);
        // 扫描失败同样会写入 attention 任务，因此仍要刷新任务列表。
        setTasks(await libraryTaskService.tasks());
      }
    } finally {
      setScanning(false);
    }
  }

  const attentionTaskCount = tasks.filter(
    (task) => task.status === "attention",
  ).length;
  // 登录首屏在未登录或会话失效时接管整窗；启动确认期间展示启动画面。
  const gateVisible = cloudAccount?.connected === false || forceGate;

  /** 主视图切换（侧栏/影视内切换/查看全部等）；离开网盘文件时清空目录搜索词。 */
  function navigate(next: AppSection) {
    if (next === section && selectedMedia === null) return;
    setSection(next);
    setSelectedMedia(null);
    if (next !== "cloud-files") setFileQuery("");
  }

  /**
   * 回收站还原文件后的处理。
   *
   * 还原目标目录由 115 决定，文件页无法自行判断当前目录是否受影响，
   * 因此统一递增刷新序号：下次回到文件页会重新读取当前目录。
   */
  function handleRecycleRestored() {
    setCloudFilesRefreshNonce((nonce) => nonce + 1);
  }

  /** 打开媒体详情：记录历史并展开右侧面板（详情标签由面板在 detailKey 变化时自动切换）。 */
  function openMedia(item: MediaItem) {
    setSelectedMedia(item);
    setAiPanelOpen(true);
  }

  /** 登录成功后进入文件工作区；退出或失效时回到登录首屏。 */
  function updateCloudAccount(nextAccount: Cloud115AccountStatus) {
    setCloudAccount(nextAccount);
    setCloudAccountError(null);
    setSettingsOpen(false);
    setForceGate(false);
    if (nextAccount.connected) {
      setSection("cloud-files");
      setSelectedMedia(null);
    }
  }

  if (cloudAccount === null && cloudAccountError === null) {
    return (
      <div className="boot-splash" role="status" aria-label="正在启动 Sirius">
        <span className="brand-mark"><BrandMark size={22} /></span>
      </div>
    );
  }

  if (cloudAccount === null || gateVisible) {
    return <LoginGate onAccountChange={updateCloudAccount} initialError={cloudAccountError} />;
  }

  return (
    <div
      className="app-frame"
      data-sidebar-expanded={sidebarExpanded ? "true" : "false"}
      data-ai-panel={aiPanelOpen ? "open" : "closed"}
      data-ai-overlay={aiPanelOverlay ? "true" : "false"}
    >
      <Sidebar
        active={activeNavId(section)}
        taskCount={attentionTaskCount}
        account={cloudAccount}
        profile={cloudProfile}
        onAccountChange={updateCloudAccount}
        onOpenSettings={() => setSettingsOpen(true)}
        onNavigate={(id) => navigate(id === "video" ? "home" : id)}
      />

      <main className="app-content">
        <TopBar
          title={selectedMedia ? selectedMedia.title : sectionTitle(section)}
          sidebarExpanded={sidebarExpanded}
          onToggleSidebar={() => setSidebarExpanded((value) => !value)}
          search={topBarSearch}
          taskDrawer={
            <TaskDrawer
              tasks={tasks}
              scanning={scanning}
              onScan={scanDirectory}
              onOpenFullPage={() => navigate("tasks")}
            />
          }
        />

        {isVideoSection(section) ? (
          <>
            <div className="video-mode-tabs" role="group" aria-label="影视视图切换">
              {VIDEO_MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  aria-current={section === mode.id ? "true" : undefined}
                  className={section === mode.id ? "active" : ""}
                  onClick={() => navigate(mode.id)}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            {section === "home" ? (
              <HomeView
                media={visibleMedia}
                onNavigate={navigate}
                onOpen={openMedia}
                onPlay={playMedia}
              />
            ) : section === "library" ? (
              <LibraryView
                loading={loading}
                media={visibleMedia}
                filter={filter}
                query={query}
                onFilter={setFilter}
                onOpen={openMedia}
                onPlay={playMedia}
              />
            ) : (
              <DiscoverView media={visibleMedia} onOpen={openMedia} onPlay={playMedia} />
            )}
          </>
        ) : section === "comics" ? (
          <ComicsView />
        ) : section === "albums" ? (
          <AlbumsView />
        ) : section === "tasks" ? (
          <TasksView tasks={tasks} scanning={scanning} onScan={scanDirectory} />
        ) : section === "recycle-bin" ? (
          <RecycleBinView
            account={cloudAccount}
            onRequireLogin={() => setForceGate(true)}
            onRestored={handleRecycleRestored}
          />
        ) : section === "transfers" ? (
          <TransfersView account={cloudAccount} onRequireLogin={() => setForceGate(true)} />
        ) : section === "backup" ? (
          <BackupView account={cloudAccount} onRequireLogin={() => setForceGate(true)} />
        ) : (
          <CloudFilesView
            account={cloudAccount}
            query={fileQuery}
            onQueryChange={setFileQuery}
            onStarredViewChange={setCloudStarredView}
            refreshNonce={cloudFilesRefreshNonce}
            onRequireLogin={() => setForceGate(true)}
            onPlay={playCloudFile}
          />
        )}
      </main>

      <AiChatPanel
        open={aiPanelOpen}
        onToggle={() => setAiPanelOpen((value) => !value)}
        onOverlayChange={setAiPanelOverlay}
        playing={snapshot.initialized && playingMedia !== null}
        detailKey={selectedMedia?.id ?? null}
        detail={
          selectedMedia ? (
            <MediaDetail
              media={selectedMedia}
              busy={busyMediaId === selectedMedia.id}
              onClose={() => {
                setSelectedMedia(null);
              }}
              onPlay={playMedia}
            />
          ) : null
        }
      />

      {/* 音频播放条与视频播放面板都固定贴在底部，二者互斥挂载避免重叠。 */}
      {audioTrack && (
        <AudioPlayerBar
          track={audioTrack}
          onStop={() => setAudioTrack(null)}
          onError={setError}
        />
      )}

      {audioTrack === null && snapshot.initialized && playingMedia && (
        <aside className="now-playing now-playing-summary" aria-label="当前视频播放">
          <div className="now-playing-art"><img src={posterFallback} alt="" /></div>
          <div className="now-playing-copy">
            <small>{snapshot.paused ? "已暂停" : "视频正在独立窗口播放"}</small>
            <strong title={playingMedia.title}>{playingMedia.title}</strong>
          </div>
          <span className="now-playing-time">{formatTime(snapshot.positionSeconds)} / {formatTime(snapshot.durationSeconds)}</span>
          <button className="player-return-button" onClick={() => {
            void playerWindowService.show().catch((reason) => setError(`打开播放器失败：${String(reason)}`));
          }}><Icon name="play" size={16} />返回播放器</button>
          <button className="stop-control" onClick={() => {
            void stopPlayback().catch((reason) => setError(String(reason)));
          }}>结束播放</button>
        </aside>
      )}

      {cloudAccount.connected && settingsOpen && (
        <SettingsModal onClose={() => setSettingsOpen(false)}>
          <SettingsView
            settings={appSettings}
            saving={savingSettings}
            onChange={updateAppSettings}
            onManageCloud={() => {
              setSettingsOpen(false);
              navigate("cloud-files");
            }}
            onScanLocal={scanDirectory}
            scanning={scanning}
          />
        </SettingsModal>
      )}

      {/* 应用级轻提示：错误与降级通知统一经 setError 汇入此处，不打断当前操作。 */}
      <ToastHost />
    </div>
  );
}

/** 侧栏高亮归并：影视三个内部视图共用同一「影视」入口。 */
function activeNavId(section: AppSection): SidebarNavId {
  if (isVideoSection(section)) return "video";
  return section;
}

function sectionTitle(section: AppSection): string {
  return {
    home: "影视",
    library: "影视",
    discover: "影视",
    comics: "漫画",
    albums: "相册",
    "cloud-files": "网盘文件",
    "recycle-bin": "回收站",
    transfers: "传输",
    backup: "备份",
    tasks: "整理任务",
  }[section];
}

function HomeView({
  media,
  onNavigate,
  onOpen,
  onPlay,
}: MediaViewProps & {
  onNavigate: (section: AppSection) => void;
}) {
  const continueWatching = media.filter((item) => item.progress > 0);

  return (
    <section className="page-section home-view">
      {/* 无真实观看记录时不渲染该区块，不使用其他影片回填。 */}
      {continueWatching.length > 0 && (
        <ContinueWatchingShelf
          media={continueWatching}
          onPlay={onPlay}
          onMore={() => onNavigate("library")}
        />
      )}
      <MediaShelf
        title="最近入库"
        media={media.slice(0, 6)}
        onOpen={onOpen}
        onPlay={onPlay}
        onMore={() => onNavigate("library")}
      />
    </section>
  );
}

function ContinueWatchingShelf({
  media,
  onPlay,
  onMore,
}: Pick<MediaViewProps, "media" | "onPlay"> & { onMore: () => void }) {
  return (
    <section className="continue-shelf">
      <div className="continue-heading">
        <h2>最近观看</h2>
        <button className="continue-more" aria-label="查看全部最近观看" onClick={onMore}>
          {media.length}
          <Icon name="chevron" size={19} />
        </button>
      </div>
      <div className="continue-grid">
        {media.slice(0, 3).map((item) => (
          <button className="continue-card" key={item.id} onClick={() => onPlay(item)}>
            <span className="continue-frame">
              <img src={WATCH_STILLS[item.id] ?? posterFallback} alt={`《${item.title}》播放画面`} />
              <span className="continue-play"><Icon name="play" size={20} /></span>
              {item.progress > 0 && (
                <span className="continue-progress">
                  <span style={{ width: `${item.progress * 100}%` }} />
                </span>
              )}
            </span>
            <span className="continue-title">
              {/* 数据层尚无真实集数信息，副标题只展示作品名。 */}
              {item.title}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function MediaShelf({
  title,
  media,
  onOpen,
  onPlay,
  onMore,
}: MediaViewProps & {
  title: string;
  onMore: () => void;
}) {
  return (
    <section className="media-shelf">
      <div className="section-heading">
        <div>
          <h2>{title}</h2>
        </div>
        <button className="text-action" onClick={onMore}>
          查看全部 <Icon name="chevron" size={14} />
        </button>
      </div>
      <div className="poster-grid shelf-grid">
        {media.map((item, index) => (
          <PosterCard key={item.id} media={item} index={index} onOpen={onOpen} onPlay={onPlay} />
        ))}
      </div>
    </section>
  );
}

type MediaViewProps = {
  media: MediaItem[];
  onOpen: (media: MediaItem) => void;
  onPlay: (media: MediaItem) => void;
};

function LibraryView({
  loading,
  media,
  filter,
  query,
  onFilter,
  onOpen,
  onPlay,
}: MediaViewProps & {
  loading: boolean;
  filter: "all" | "movie" | "series";
  query: string;
  onFilter: (filter: "all" | "movie" | "series") => void;
}) {
  return (
    <section className="page-section">
      <div className="section-toolbar">
        <div className="segmented-control">
          {[
            ["all", "全部"],
            ["movie", "电影"],
            ["series", "剧集"],
          ].map(([value, label]) => (
            <button
              key={value}
              className={filter === value ? "active" : ""}
              onClick={() => onFilter(value as typeof filter)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="result-count">{media.length} 个条目</span>
      </div>

      {loading ? (
        <div className="poster-grid" aria-label="正在载入媒体库">
          {Array.from({ length: 8 }, (_, index) => (
            <div className="poster-skeleton" key={index}>
              <span />
              <i />
            </div>
          ))}
        </div>
      ) : media.length > 0 ? (
        <div className="poster-grid">
          {media.map((item, index) => (
            <PosterCard
              key={item.id}
              media={item}
              index={index}
              onOpen={onOpen}
              onPlay={onPlay}
            />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <Icon name="search" size={24} />
          <h2>没有找到匹配影片</h2>
          <p>“{query}”未匹配片名或类型，请调整搜索条件。</p>
        </div>
      )}
    </section>
  );
}

function DiscoverView({ media, onOpen, onPlay }: MediaViewProps) {
  const featured = media[1] ?? media[0];
  return (
    <section className="page-section">
      {featured && (
        <div className="featured">
          <div>
            <span className="context-label">本周精选</span>
            <h2>{featured.title}</h2>
            <p>{featured.overview}</p>
            <button className="primary-action" onClick={() => onPlay(featured)}>
              <Icon name="play" size={17} />
              播放
            </button>
          </div>
          <button className="featured-art" onClick={() => onOpen(featured)}>
            <img src={posterFallback} alt="" />
            <span>{featured.originalTitle}</span>
          </button>
        </div>
      )}
      <div className="section-heading">
        <div>
          <span className="context-label">基于媒体库</span>
          <h2>还没看过的好电影</h2>
        </div>
      </div>
      <div className="poster-grid compact-grid">
        {media
          .filter((item) => item.progress === 0)
          .map((item, index) => (
            <PosterCard
              key={item.id}
              media={item}
              index={index}
              onOpen={onOpen}
              onPlay={onPlay}
            />
          ))}
      </div>
    </section>
  );
}

function TasksView({
  tasks,
  scanning,
  onScan,
}: {
  tasks: LibraryTask[];
  scanning: boolean;
  onScan: () => void;
}) {
  return (
    <section className="page-section narrow-section">
      <div className="section-heading">
        <div>
          <span className="context-label">扫描与刮削</span>
          <h2>媒体整理进度</h2>
        </div>
        <button className="secondary-action" disabled={scanning} onClick={onScan}>
          {scanning ? "正在扫描…" : "扫描媒体目录"}
        </button>
      </div>
      {tasks.length === 0 ? (
        <div className="empty-state task-empty">
          <Icon name="folder" size={24} />
          <h2>还没有扫描任务</h2>
          <p>选择一个本地媒体目录，验证文件识别和待刮削任务链。</p>
        </div>
      ) : (
        <div className="task-list">
          {tasks.map((task) => (
          <article key={task.id} className="task-row">
            <span className={`task-status ${task.status}`}>
              <Icon
                name={
                  task.status === "attention"
                    ? "alert"
                    : task.status === "completed"
                      ? "check"
                      : "tasks"
                }
                size={17}
              />
            </span>
            <div>
              <strong>{task.title}</strong>
              <p>{task.detail}</p>
              <span className="task-progress">
                <span style={{ width: `${task.progress * 100}%` }} />
              </span>
            </div>
            <small>
              {task.status === "running"
                ? `${Math.round(task.progress * 100)}%`
                : task.status === "attention"
                  ? "需要确认"
                  : "已完成"}
            </small>
          </article>
          ))}
        </div>
      )}
    </section>
  );
}

const aiOrganizationService = new AiOrganizationService();

/** 设置页内的 AI 模型服务配置；API 密钥只写入 macOS 钥匙串，保存后不再显示。 */
function AiProviderGroup() {
  const [view, setView] = useState<AiProviderSettingsView | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    aiOrganizationService
      .settings()
      .then((value) => {
        if (!active) return;
        setView(value);
        setBaseUrl(value.baseUrl);
        setModel(value.model);
      })
      .catch((reason) => active && setError(`读取 AI 配置失败：${String(reason)}`));
    return () => {
      active = false;
    };
  }, []);

  async function saveProvider() {
    setSaving(true);
    setError(null);
    try {
      const next = await aiOrganizationService.updateProvider({
        baseUrl,
        model,
        apiKey: apiKey.trim() ? apiKey.trim() : null,
      });
      setView(next);
      setApiKey("");
      setNotice("AI 配置已保存");
    } catch (reason) {
      setError(`保存 AI 配置失败：${String(reason)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-group">
      <h2>AI 模型服务</h2>
      {error && <div className="cloud-inline-error" role="alert">{error}</div>}
      {notice && <div className="cloud-action-notice" role="status"><Icon name="check" size={14} />{notice}<button aria-label="关闭提示" onClick={() => setNotice(null)}><Icon name="close" size={13} /></button></div>}
      <div className="setting-row">
        <div>
          <strong>服务商地址</strong>
          <p>OpenAI 兼容接口，例如 https://api.deepseek.com</p>
        </div>
        <input
          className="ai-text-input"
          value={baseUrl}
          placeholder="https://api.deepseek.com"
          onChange={(event) => setBaseUrl(event.currentTarget.value)}
        />
      </div>
      <div className="setting-row">
        <div>
          <strong>模型</strong>
          <p>用于 AI 整理的文件名分析</p>
        </div>
        <input
          className="ai-text-input"
          value={model}
          placeholder="deepseek-chat"
          onChange={(event) => setModel(event.currentTarget.value)}
        />
      </div>
      <div className="setting-row">
        <div>
          <strong>API 密钥</strong>
          <p>{view?.keyStored ? "已保存在 macOS 钥匙串" : "尚未保存密钥"}</p>
        </div>
        <input
          className="ai-text-input"
          type="password"
          value={apiKey}
          placeholder={view?.keyStored ? "留空保持现有密钥" : "sk-…"}
          onChange={(event) => setApiKey(event.currentTarget.value)}
        />
      </div>
      <div className="setting-row">
        <div>
          <strong>保存配置</strong>
          <p>供「AI 整理」工作台使用</p>
        </div>
        <button className="primary-action" disabled={saving} onClick={() => void saveProvider()}>
          {saving ? "正在保存…" : "保存"}
        </button>
      </div>
    </div>
  );
}

function SettingsView({
  settings,
  saving,
  onChange,
  onManageCloud,
  onScanLocal,
  scanning,
}: {
  settings: AppSettings | null;
  saving: boolean;
  onChange: (settings: AppSettings) => Promise<void>;
  onManageCloud: () => void;
  onScanLocal: () => void;
  scanning: boolean;
}) {
  /** 只在设置完成加载后提交，避免用前端默认值覆盖 SQLite 中的真实状态。 */
  function updateSetting(patch: Partial<AppSettings>) {
    if (!settings || saving) return;
    void onChange({ ...settings, ...patch });
  }

  return (
    <>
      <div className="settings-group">
        <h2>媒体来源</h2>
        <div className="setting-row">
          <span className="source-icon">
            <Icon name="cloud" size={17} />
          </span>
          <div>
            <strong>115 网盘</strong>
            <p>登录 115 网盘；登录凭据保存在 macOS 钥匙串，不会离开本机</p>
          </div>
          <button className="secondary-action" onClick={onManageCloud}>管理目录</button>
        </div>
        <div className="setting-row">
          <span className="source-icon local">
            <Icon name="folder" size={17} />
          </span>
          <div>
            <strong>本地目录</strong>
            <p>扫描 Mac 上的视频并创建媒体整理任务</p>
          </div>
          <button className="secondary-action" disabled={scanning} onClick={onScanLocal}>
            {scanning ? "正在扫描…" : "扫描目录"}
          </button>
        </div>
      </div>
      <AiProviderGroup />
      <div className="settings-group">
        <h2>刮削服务</h2>
        <div className="setting-row">
          <div>
            <strong>元数据语言</strong>
            <p>优先简体中文，缺失时保留原始语言</p>
          </div>
          <select
            value={settings?.metadataLanguage ?? ""}
            disabled={!settings || saving}
            aria-label="元数据语言"
            onChange={(event) => updateSetting({ metadataLanguage: event.currentTarget.value as AppSettings["metadataLanguage"] })}
          >
            {!settings && <option value="">正在读取…</option>}
            <option value="zh-CN">简体中文</option>
            <option value="en-US">English</option>
          </select>
        </div>
        <div className="setting-row">
          <div>
            <strong>自动刮削</strong>
            <p>发现新视频文件后创建匹配任务</p>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings?.autoScrape ?? false}
              disabled={!settings || saving}
              aria-label="启用自动刮削"
              onChange={(event) => updateSetting({ autoScrape: event.currentTarget.checked })}
            />
            <span />
          </label>
        </div>
      </div>
      <div className="settings-group">
        <h2>播放</h2>
        <div className="setting-row">
          <div>
            <strong>默认播放器</strong>
            <p>使用 Sirius 内置播放窗口</p>
          </div>
          <span className="setting-value">内置播放器</span>
        </div>
        <div className="setting-row">
          <div>
            <strong>播放记录</strong>
            <p>记录进度并在首页提供继续观看入口</p>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings?.playbackHistory ?? false}
              disabled={!settings || saving}
              aria-label="记录播放进度"
              onChange={(event) => updateSetting({ playbackHistory: event.currentTarget.checked })}
            />
            <span />
          </label>
        </div>
      </div>
      <div className="settings-group">
        <h2>应用</h2>
        <div className="setting-row">
          <div>
            <strong>Sirius Desktop</strong>
            <p>115 第三方客户端桌面端</p>
          </div>
          <span className="setting-value">{appVersion}</span>
        </div>
      </div>
    </>
  );
}

export default App;
