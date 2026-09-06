import type { CSSProperties } from "react";
import posterFallback from "../assets/brand/poster-fallback.svg";
import type { MediaItem } from "../domain/media";
import { Icon } from "./Icon";

type PosterCardProps = {
  media: MediaItem;
  index: number;
  onOpen: (media: MediaItem) => void;
  onPlay: (media: MediaItem) => void;
};

/** 海报卡片；缺图时使用品牌备援视觉 + 逐片色调叠层，接入 scraper 后替换为真实 poster URL。 */
export function PosterCard({ media, index, onOpen, onPlay }: PosterCardProps) {
  const style = {
    "--poster-tone": media.posterTone,
    "--poster-accent": media.posterAccent,
    "--reveal-delay": `${Math.min(index, 10) * 36}ms`,
  } as CSSProperties;

  return (
    <article className="poster-card" style={style}>
      <button className="poster-art" onClick={() => onOpen(media)}>
        <img className="poster-fallback" src={posterFallback} alt="" />
        <span className="poster-tint" aria-hidden="true" />
        {media.kind === "series" && (
          <span className="collection-badge">剧集合集</span>
        )}
        <span className="poster-year">{media.year}</span>
        <span className="poster-title">{media.originalTitle}</span>
        {media.progress > 0 && (
          <span className="poster-progress">
            <span style={{ width: `${media.progress * 100}%` }} />
          </span>
        )}
      </button>
      <div className="poster-meta">
        <button className="poster-copy" onClick={() => onOpen(media)}>
          <strong>{media.title}</strong>
          <small>
            {media.year} · {media.kind === "movie" ? "电影" : "按季 / 集整理"}
          </small>
        </button>
        <button
          className="poster-play"
          aria-label={`播放《${media.title}》`}
          onClick={() => onPlay(media)}
        >
          <Icon name="play" size={16} />
        </button>
      </div>
    </article>
  );
}
