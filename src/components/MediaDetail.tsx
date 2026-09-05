import { useEffect } from "react";
import arrivalStill from "../assets/watch-stills/arrival-desert.jpg";
import perfectDaysStill from "../assets/watch-stills/perfect-days-street.jpg";
import severanceStill from "../assets/watch-stills/severance-office.jpg";
import type { MediaItem } from "../domain/media";
import { Icon } from "./Icon";

const DETAIL_STILLS = [severanceStill, perfectDaysStill, arrivalStill];
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

/** 独立影片详情页：作品信息、视频集合和演员信息按内容流组织。 */
export function MediaDetail({
  media,
  busy,
  onClose,
  onPlay,
}: MediaDetailProps) {
  // 已有演示媒体使用对应剧照；其他条目仍稳定复用素材库，避免出现空白主视觉。
  const heroStill = HERO_STILLS[media.id] ?? DETAIL_STILLS[0];

  useEffect(() => {
    // 独立详情页必须从顶部开始，不能继承媒体库页面的滚动位置。
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [media.id]);

  return (
    <article className="detail-page" aria-label={`${media.title}详情`}>
      <header className="detail-sticky-header">
        <button className="detail-back" onClick={onClose}>
          <span><Icon name="chevron" size={15} /></span>
          返回
        </button>
        <strong>{media.title}</strong>
      </header>

      <section
        className="detail-hero"
        style={
          {
            "--poster-tone": media.posterTone,
            "--poster-accent": media.posterAccent,
            "--detail-hero-image": `url(${heroStill})`,
          } as React.CSSProperties
        }
      >
        <div className="detail-summary">
          <h1>{media.title}</h1>
          <div className="detail-hero-content">
            <button className="primary-action" disabled={busy} onClick={() => onPlay(media)}>
              <Icon name="play" size={17} />
              {busy ? "正在准备…" : media.progress > 0 ? "继续播放" : "播放"}
            </button>
            <div className="detail-description">
              <div className="detail-kicker">
                <span>评分 {media.rating.toFixed(1)}</span>
                <span>{media.year}</span>
                <span>{media.runtimeMinutes} 分钟</span>
              </div>
              <p className="overview">{media.overview}</p>
            </div>
          </div>
        </div>
      </section>

      {media.kind === "series" && (
        <section className="detail-section media-collection" aria-label="剧集信息">
          <div className="detail-section-heading"><h2>剧集</h2></div>
          <div className="empty-state">
            <Icon name="library" size={22} />
            <h2>尚未生成季集信息</h2>
            <p>完成文件识别与剧集刮削后，这里会显示真实的季、集和播放进度。</p>
          </div>
        </section>
      )}

      <section className="detail-section cast-section" aria-label="演员信息">
        <div className="detail-section-heading">
          <h2>相关演员</h2>
        </div>
        <div className="cast-grid">
          {media.cast.map((person) => (
            <article className="cast-card" key={person}>
              <span className="cast-avatar"><Icon name="user" size={26} /></span>
              <div><strong>{person}</strong><small>饰 主要角色</small></div>
            </article>
          ))}
          <article className="cast-card">
            <span className="cast-avatar"><Icon name="user" size={26} /></span>
            <div><strong>{media.director}</strong><small>导演</small></div>
          </article>
        </div>
      </section>

      <footer className="file-metadata" aria-label="文件信息">
        <p>{media.originalTitle}</p>
        <p>{media.sourceLabel} / {media.kind === "movie" ? "电影" : "剧集"}</p>
        <p>{media.runtimeMinutes} 分钟 · 文件参数将在来源关联后显示</p>
      </footer>
    </article>
  );
}
