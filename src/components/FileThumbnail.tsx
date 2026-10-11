import { useState, type CSSProperties } from "react";
import { FileTypeIcon } from "./FileTypeIcon";
import type { FileVisualKind } from "../domain/fileTypes";
import "./FileThumbnail.css";

type FileThumbnailProps = {
  src?: string | null;
  kind: FileVisualKind;
  size?: number;
  iconSize?: number;
  className?: string;
  label?: string;
};

/** 服务端/本地真实缩略图优先，缺失或加载失败时使用同一套文件类型图标。 */
export function FileThumbnail({ src, kind, size = 32, iconSize = size, className, label }: FileThumbnailProps) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const source = src?.trim();
  const showImage = Boolean(source && source !== failedSource);
  return (
    <span
      className={`file-thumbnail${showImage ? " has-image" : ""}${className ? ` ${className}` : ""}`}
      style={{ "--thumbnail-size": `${size}px` } as CSSProperties}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {showImage ? (
        <img
          src={source}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedSource(source ?? null)}
        />
      ) : <FileTypeIcon kind={kind} size={iconSize} />}
    </span>
  );
}
