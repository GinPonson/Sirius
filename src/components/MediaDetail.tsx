import { useState } from "react";
import arrivalStill from "../assets/watch-stills/arrival-desert.jpg";
import perfectDaysStill from "../assets/watch-stills/perfect-days-street.jpg";
import severanceStill from "../assets/watch-stills/severance-office.jpg";
import posterFallback from "../assets/brand/poster-fallback.svg";
import type { MediaItem } from "../domain/media";
import { Icon } from "./Icon";

const HERO_STILLS: Record<string, string> = {
  arrival: arrivalStill,
  "perfect-days": perfectDaysStill,
  severance: severanceStill,
};

type MediaDetailProps = {
  media: MediaItem;
  busy: boolean;
  onClose: () => void;
  onPlay: (media: MediaItem) => void;
};

/** 右侧面板内的影片详情：紧凑横幅、元信息、播放主操作与可折叠简介。 */
export function MediaDetail({
  media,
  busy,
  onClose,
  onPlay,
}: MediaDetailProps) {
  // 仅在存在该作品的真实剧照时使用剧照，否则回退品牌备援影像，不借用其他作品的画面。
  const heroStill = HERO_STILLS[media.id] ?? posterFallback;
  const [overviewExpanded, setOverviewExpanded] = useState(false);

  return (
    <article className="detail-panel" aria-label={`${media.title}详情`}>
      <header className="detail-panel-head">
        <button className="detail-back" onClick={onClose} aria-label="返回列表">
          <Icon name="chevron" size={15} />
        </button>
        <strong>{media.title}</strong>
      </header>

      <div className="detail-panel-body">
        <section
          className="detail-banner"
          style={
            {
              "--poster-tone": media.posterTone,
              "--poster-accent": media.posterAccent,
              "--detail-hero-image": `url(${heroStill})`,
            } as React.CSSProperties
          }
        >
          <div className="detail-banner-shade" aria-hidden="true" />
          <div className="detail-banner-copy">
            <h1>{media.title}</h1>
            <p className="detail-original">{media.originalTitle}</p>
            <div className="detail-kicker">
              <span>评分 {media.rating.toFixed(1)}</span>
              <span>{media.year}</span>
              <span>{media.runtimeMinutes} 分钟</span>
              <span>{media.kind === "movie" ? "电影" : "剧集"}</span>
            </div>
            <button className="primary-action" disabled={busy} onClick={() => onPlay(media)}>
              <Icon name="play" size={17} />
              {busy ? "正在准备…" : media.progress > 0 ? "继续播放" : "播放"}
            </button>
          </div>
        </section>

        {media.progress > 0 && (
          <div className="detail-progress" aria-label="观看进度">
            <span style={{ width: `${Math.min(100, Math.max(0, media.progress * 100))}%` }} />
          </div>
        )}

        {media.genres.length > 0 && (
          <div className="detail-tags" aria-label="类型标签">
            {media.genres.map((genre) => (
              <span key={genre}>{genre}</span>
            ))}
          </div>
        )}

        {media.overview !== "" && (
          <section className="detail-overview" aria-label="简介">
            <p className={overviewExpanded ? "expanded" : ""}>{media.overview}</p>
            <button type="button" className="detail-overview-toggle" onClick={() => setOverviewExpanded((value) => !value)}>
              {overviewExpanded ? "收起简介" : "展开完整简介"}
            </button>
          </section>
        )}

        {media.kind === "series" && (
          <section className="detail-section" aria-label="剧集信息">
            <div className="detail-section-heading"><h2>剧集</h2></div>
            <div className="empty-state compact">
              <Icon name="library" size={20} />
              <p>尚未生成季集信息；完成文件识别与剧集刮削后会显示真实的季、集与播放进度。</p>
            </div>
          </section>
        )}

        <section className="detail-section" aria-label="演员信息">
          <div className="detail-section-heading"><h2>相关演员</h2></div>
          <div className="cast-list">
            {media.cast.map((person) => (
              <div className="cast-row" key={person}>
                <span className="cast-avatar"><Icon name="user" size={18} /></span>
                <div><strong>{person}</strong><small>演员</small></div>
              </div>
            ))}
            <div className="cast-row">
              <span className="cast-avatar"><Icon name="user" size={18} /></span>
              <div><strong>{media.director}</strong><small>导演</small></div>
            </div>
          </div>
        </section>

        <footer className="detail-panel-foot" aria-label="文件信息">
          <span>{media.sourceLabel}</span>
          <span>{media.kind === "movie" ? "电影" : "剧集"}</span>
        </footer>
      </div>
    </article>
  );
}
