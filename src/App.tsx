import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import posterFallback from "./assets/brand/poster-fallback.svg";
import arrivalStill from "./assets/watch-stills/arrival-desert.jpg";
import perfectDaysStill from "./assets/watch-stills/perfect-days-street.jpg";
import severanceStill from "./assets/watch-stills/severance-office.jpg";
import { Icon } from "./components/Icon";
import { AlbumsView } from "./components/AlbumsView";
import { AiOrganizeView } from "./components/AiOrganizeView";
import { CloudFilesView } from "./components/CloudFilesView";
import { ComicsView } from "./components/ComicsView";
import {
  AiOrganizationService,
  type AiProviderSettingsView,
} from "./services/aiServices";
import { Cloud115AuthModal } from "./components/Cloud115AuthModal";
import { LoginGate } from "./components/LoginGate";
import { MediaDetail } from "./components/MediaDetail";
import { PosterCard } from "./components/PosterCard";
import { Sidebar } from "./components/Sidebar";
import type {
  AppSection,
  LibraryTask,
  MediaItem,
  PlaybackSnapshot,
} from "./domain/media";
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
};

const repository = new TauriMediaRepository();
const sourceResolver = new LocalSourceResolver();
const playbackService = new PlaybackService();
const libraryTaskService = new LibraryTaskService();
const cloud115Service = new Cloud115Service();
const appSettingsService = new AppSettingsService();

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
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot>(IDLE_SNAPSHOT);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "movie" | "series">("all");
  const [loading, setLoading] = useState(true);
  const [busyMediaId, setBusyMediaId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloudAccount, setCloudAccount] = useState<Cloud115AccountStatus | null>(null);
  const [cloudProfile, setCloudProfile] = useState<Cloud115UserProfile | null>(null);
  const [showCloudAccount, setShowCloudAccount] = useState(false);
  const [forceGate, setForceGate] = useState(false);
  const [playingCloudFileId, setPlayingCloudFileId] = useState<string | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const lastProgressSaveAt = useRef(0);
  // 首次确认账号状态时决定默认分区；用户一旦手动导航便不再自动跳转。
  const defaultSectionResolved = useRef(false);
  // 记录最近一次由播放快照设置的错误，恢复成功后只清除该条，不误伤其他错误横幅。
  const lastPlaybackError = useRef<string | null>(null);

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
      .then((status) => active && setCloudAccount(status))
      .catch((reason) => {
        if (!active) return;
        // 钥匙串拒绝或旧开发签名无法读取时按未登录处理，引导用户重新完成授权。
        setCloudAccount({ connected: false, userName: null, userId: null });
        setError(`读取 115 登录状态失败：${String(reason)}`);
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
    const interval = window.setInterval(() => {
      playbackService
        .snapshot()
        .then((next) => {
          setSnapshot(next);
          // 远程播放恢复失败时把播放器错误呈现在横幅；恢复成功后只清除该条。
          if (next.error) {
            lastPlaybackError.current = next.error;
            setError((current) => (current === next.error ? current : next.error));
          } else if (lastPlaybackError.current) {
            const cleared = lastPlaybackError.current;
            lastPlaybackError.current = null;
            setError((current) => (current === cleared ? null : current));
          }
        })
        .catch((reason) => setError(`读取播放状态失败：${String(reason)}`));
    }, 500);
    return () => window.clearInterval(interval);
  }, [snapshot.initialized]);

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

  const progressPercent = useMemo(() => {
    if (
      snapshot.positionSeconds === null ||
      snapshot.durationSeconds === null ||
      snapshot.durationSeconds <= 0
    ) {
      return 0;
    }
    return Math.min(
      100,
      Math.max(0, (snapshot.positionSeconds / snapshot.durationSeconds) * 100),
    );
  }, [snapshot.durationSeconds, snapshot.positionSeconds]);

  /** 完整播放链：媒体实体 → 来源解析 → PlaybackSource → Rust 播放器。 */
  async function playMedia(item: MediaItem) {
    setBusyMediaId(item.id);
    setError(null);
    try {
      const source = await sourceResolver.resolve(item);
      const next = await playbackService.open(source);
      setPlayingMedia(item);
      setPlayingCloudFileId(null);
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
      let next = await playbackService.openRemote(source, subtitles, entry.pickCode);
      if (savedProgress && savedProgress.positionSeconds >= 5 && savedProgress.positionSeconds < savedProgress.durationSeconds - 30) {
        try {
          next = await playbackService.seek(savedProgress.positionSeconds);
        } catch (reason) {
          // 媒体已成功打开时，续播失败必须保留可控播放会话并显式提示。
          setError(`视频已开始播放，但恢复上次进度失败：${String(reason)}`);
        }
      }
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
      lastProgressSaveAt.current = Date.now();
    } catch (reason) {
      setError(`无法播放《${entry.name}》：${String(reason)}`);
      throw reason;
    } finally {
      setBusyMediaId(null);
    }
  }

  async function togglePause() {
    try {
      setSnapshot(await playbackService.togglePause());
    } catch (reason) {
      setError(`播放控制失败：${String(reason)}`);
    }
  }

  async function seek(seconds: number) {
    try {
      setSnapshot(await playbackService.seek(seconds));
    } catch (reason) {
      setError(`播放跳转失败：${String(reason)}`);
    }
  }

  async function stopPlayback() {
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
      setSnapshot(IDLE_SNAPSHOT);
      setPlayingMedia(null);
      setPlayingCloudFileId(null);
      if (progressError) setError(progressError);
    } catch (reason) {
      const destroyError = `关闭播放会话失败：${String(reason)}`;
      setError(progressError ? `${progressError}；${destroyError}` : destroyError);
    }
  }

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

  function navigateFromSidebar(next: AppSection) {
    setSection(next);
    setSelectedMedia(null);
  }

  /** 登录成功后进入文件工作区；退出或失效时回到登录首屏。 */
  function updateCloudAccount(nextAccount: Cloud115AccountStatus) {
    setCloudAccount(nextAccount);
    setShowCloudAccount(false);
    setForceGate(false);
    if (nextAccount.connected) {
      setSection("cloud-files");
      setSelectedMedia(null);
    }
  }

  if (cloudAccount === null) {
    return (
      <div className="boot-splash" role="status" aria-label="正在启动 Sirius">
        <span className="brand-mark">S</span>
      </div>
    );
  }

  if (gateVisible) {
    return <LoginGate onAccountChange={updateCloudAccount} />;
  }

  return (
    <div className="app-frame">
      <Sidebar
        active={section}
        taskCount={attentionTaskCount}
        query={query}
        onQueryChange={setQuery}
        cloudAccount={cloudAccount}
        cloudProfile={cloudProfile}
        onAccountClick={() => setShowCloudAccount(true)}
        onNavigate={navigateFromSidebar}
      />

      <main className="app-content">
        {!selectedMedia && <header className="topbar">
          <h1>{sectionTitle(section)}</h1>
        </header>}

        {error && (
          <aside className="error-banner" role="alert">
            <Icon name="alert" size={18} />
            <span>{error}</span>
            <button aria-label="关闭错误" onClick={() => setError(null)}>
              <Icon name="close" size={16} />
            </button>
          </aside>
        )}

        {selectedMedia ? (
          <MediaDetail
            media={selectedMedia}
            busy={busyMediaId === selectedMedia.id}
            onClose={() => setSelectedMedia(null)}
            onPlay={playMedia}
          />
        ) : section === "home" ? (
          <HomeView
            media={visibleMedia}
            onNavigate={setSection}
            onOpen={setSelectedMedia}
            onPlay={playMedia}
          />
        ) : section === "library" ? (
          <LibraryView
            loading={loading}
            media={visibleMedia}
            filter={filter}
            query={query}
            onFilter={setFilter}
            onOpen={setSelectedMedia}
            onPlay={playMedia}
          />
        ) : section === "discover" ? (
          <DiscoverView media={visibleMedia} onOpen={setSelectedMedia} onPlay={playMedia} />
        ) : section === "comics" ? (
          <ComicsView />
        ) : section === "albums" ? (
          <AlbumsView />
        ) : section === "tasks" ? (
          <TasksView tasks={tasks} scanning={scanning} onScan={scanDirectory} />
        ) : section === "ai-organize" ? (
          <AiOrganizeView />
        ) : section === "cloud-files" ? (
          <CloudFilesView account={cloudAccount} onRequireLogin={() => setForceGate(true)} onPlay={playCloudFile} />
        ) : (
          <SettingsView
            settings={appSettings}
            saving={savingSettings}
            onChange={updateAppSettings}
            onManageCloud={() => navigateFromSidebar("cloud-files")}
            onScanLocal={scanDirectory}
            scanning={scanning}
          />
        )}
      </main>

      {snapshot.initialized && playingMedia && (
        <aside className="now-playing" aria-label="当前播放">
          <div className="now-playing-art">
            <img src={posterFallback} alt="" />
          </div>
          <div className="now-playing-copy">
            <small>正在播放</small>
            <strong>{playingMedia.title}</strong>
          </div>
          <button className="round-control" onClick={togglePause}>
            {snapshot.paused ? <Icon name="play" /> : <span className="pause-icon" />}
          </button>
          <div className="mini-progress">
            <input
              aria-label="播放进度"
              type="range"
              min="0"
              max={snapshot.durationSeconds ?? 1}
              step="0.1"
              value={snapshot.positionSeconds ?? 0}
              onChange={(event) => seek(Number(event.currentTarget.value))}
              style={{ "--progress": `${progressPercent}%` } as React.CSSProperties}
            />
            <span>
              {formatTime(snapshot.positionSeconds)} / {formatTime(snapshot.durationSeconds)}
            </span>
          </div>
          <button className="stop-control" onClick={stopPlayback}>
            结束播放
          </button>
        </aside>
      )}

      {cloudAccount.connected && showCloudAccount && (
        <Cloud115AuthModal
          account={cloudAccount}
          profile={cloudProfile}
          onAccountChange={updateCloudAccount}
          onClose={() => setShowCloudAccount(false)}
        />
      )}
    </div>
  );
}

function sectionTitle(section: AppSection): string {
  return {
    home: "首页",
    library: "媒体库",
    discover: "发现",
    comics: "漫画",
    albums: "相册",
    "cloud-files": "网盘文件",
    tasks: "整理任务",
    "ai-organize": "AI 整理",
    settings: "设置",
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
      <ContinueWatchingShelf
        media={continueWatching.length > 0 ? continueWatching : media.slice(0, 4)}
        onPlay={onPlay}
        onMore={() => onNavigate("library")}
      />
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
              <span className="continue-progress">
                <span style={{ width: `${Math.max(item.progress, 0.04) * 100}%` }} />
              </span>
            </span>
            <span className="continue-title">
              {item.kind === "series" ? `${item.title} · 第 3 集` : item.title}
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
    <section className="page-section narrow-section">
      <div className="settings-group">
        <h2>媒体来源</h2>
        <div className="setting-row">
          <span className="source-icon">
            <Icon name="cloud" size={17} />
          </span>
          <div>
            <strong>115 网盘</strong>
            <p>使用开放平台设备码授权，Token 保存于 macOS 钥匙串</p>
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
            <p>使用 Sirius 内置 libmpv 播放窗口</p>
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
          <span className="setting-value">0.1.0</span>
        </div>
      </div>
    </section>
  );
}

export default App;
