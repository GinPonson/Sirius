import { useId } from "react";
import type { FileVisualKind } from "../domain/fileTypes";
import "./FileTypeIcon.css";

export type { FileVisualKind } from "../domain/fileTypes";

type DocumentKind = Exclude<FileVisualKind, "folder">;
type FilePalette = {
  top: string;
  bottom: string;
  edge: string;
  fold: string;
  ink: string;
};

const PALETTES: Record<DocumentKind, FilePalette> = {
  video: { top: "#F3EEFF", bottom: "#DCCDF7", edge: "#C4B2E8", fold: "#C5ADEB", ink: "#8C70CF" },
  image: { top: "#EAF9F5", bottom: "#C5EDE1", edge: "#A7D6C8", fold: "#A6DBCA", ink: "#50A98F" },
  audio: { top: "#FFF0ED", bottom: "#F9D6CE", edge: "#E9BBB0", fold: "#F1BFB3", ink: "#D78572" },
  pdf: { top: "#FFF0F0", bottom: "#F6CDD1", edge: "#E8B0B7", fold: "#ECB2BC", ink: "#D36C7C" },
  document: { top: "#EEF5FF", bottom: "#CFDFF8", edge: "#B0C7E7", fold: "#B5CCF0", ink: "#658DCA" },
  spreadsheet: { top: "#ECF8EF", bottom: "#CBE7D1", edge: "#ADCFB5", fold: "#B2D9BF", ink: "#5B9D71" },
  presentation: { top: "#FFF5E9", bottom: "#F6DEC0", edge: "#E8C79F", fold: "#F0CCA3", ink: "#D79852" },
  archive: { top: "#F2EFF8", bottom: "#DBD4E9", edge: "#C2B8D6", fold: "#C8BCD9", ink: "#8F7FA9" },
  subtitle: { top: "#EBF7FC", bottom: "#C8E7F2", edge: "#ABD0DF", fold: "#AED9E8", ink: "#609FB9" },
  text: { top: "#F0F5F9", bottom: "#D9E4EE", edge: "#BCCCDC", fold: "#C4D6E5", ink: "#829AAD" },
  code: { top: "#EFF2F5", bottom: "#D7DEE5", edge: "#B8C2CC", fold: "#BDCAD5", ink: "#697A8E" },
  ebook: { top: "#FFF3E5", bottom: "#F4D9B7", edge: "#E2BF92", fold: "#EBC392", ink: "#C98F4B" },
  file: { top: "#F6F7F9", bottom: "#E2E6EC", edge: "#CCD2DD", fold: "#D4DBE5", ink: "#9BA7B7" },
};

/** 简洁的实体符号，在小尺寸下保持文件类型辨识度。 */
function FileGlyph({ kind, ink }: { kind: DocumentKind; ink: string }) {
  switch (kind) {
    case "video":
      return <>
        <circle cx="20" cy="23" r="8.3" fill={ink} stroke="none" />
        <path d="M18 18.8 24.1 22.3a.8.8 0 0 1 0 1.4L18 27.2a.8.8 0 0 1-1.2-.7v-7a.8.8 0 0 1 1.2-.7Z" fill="#FFFFFF" stroke="none" />
      </>;
    case "image":
      return <>
        <rect x="10.8" y="16" width="18.4" height="14.4" rx="2.8" fill={ink} stroke="none" />
        <circle cx="24.5" cy="20.2" r="1.8" fill="#FFFFFF" stroke="none" fillOpacity=".94" />
        <path d="m12.5 27.4 4.6-5.5 3.7 3.6 2.5-2.5 4.2 4.4v.9h-15Z" fill="#FFFFFF" stroke="none" fillOpacity=".94" />
      </>;
    case "audio":
      return <>
        <path d="M17 16.6 27 14v13.3h-2V18l-6 1.6V30h-2Z" fill={ink} stroke="none" />
        <ellipse cx="15" cy="29.6" rx="4" ry="2.9" transform="rotate(-15 15 29.6)" fill={ink} stroke="none" />
        <ellipse cx="23" cy="27" rx="4" ry="2.9" transform="rotate(-15 23 27)" fill={ink} stroke="none" />
      </>;
    case "pdf":
      return <>
        <rect x="9.8" y="17.7" width="20.4" height="12.1" rx="2.7" fill={ink} stroke="none" />
        <g fill="none" stroke="#FFFFFF" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12.8 26.2v-5h1.4a1.5 1.5 0 0 1 0 3h-1.4" />
          <path d="M18.6 26.2v-5h1a2.5 2.5 0 0 1 0 5Z" />
          <path d="M25 26.2v-5h2.3M25 23.6h1.9" />
        </g>
      </>;
    case "document":
      return <>
        <rect x="12" y="14.8" width="6.2" height="2.8" rx=".9" fill={ink} stroke="none" />
        <path d="M12.8 21.1h14.4M12.8 25.5h14.4M12.8 29.9h9.2" fill="none" stroke={ink} strokeWidth="1.8" strokeLinecap="round" />
      </>;
    case "spreadsheet":
      return <>
        <rect x="11" y="15.8" width="18" height="15.1" rx="2.4" fill={ink} stroke="none" />
        <path d="M12.7 20.7h14.6M12.7 25.5h14.6M17 20.7v8.5M23 20.7v8.5" fill="none" stroke="#FFFFFF" strokeWidth="1.3" strokeLinecap="round" strokeOpacity=".92" />
      </>;
    case "presentation":
      return <>
        <rect x="10.8" y="14.9" width="18.4" height="12.8" rx="2.2" fill={ink} stroke="none" />
        <path d="M20 27.5v4.4m0-1.8-4 2m4-2 4 2" fill="none" stroke={ink} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="14.1" y="21.1" width="2.2" height="3.6" rx=".5" fill="#FFFFFF" stroke="none" />
        <rect x="18.9" y="18.7" width="2.2" height="6" rx=".5" fill="#FFFFFF" stroke="none" />
        <rect x="23.7" y="20.1" width="2.2" height="4.6" rx=".5" fill="#FFFFFF" stroke="none" />
      </>;
    case "archive":
      return <>
        <path d="M17.1 7h2.9v3h-2.9Zm2.9 3h2.9v3H20Zm-2.9 3h2.9v3h-2.9Zm2.9 3h2.9v3H20Zm-2.9 3h2.9v3h-2.9Z" fill={ink} stroke="none" fillOpacity=".85" />
        <path d="M16.8 24.5a3.2 3.2 0 0 1 6.4 0v3.8a3.2 3.2 0 0 1-6.4 0Z" fill={ink} stroke="none" />
        <rect x="18.7" y="25.8" width="2.6" height="3.3" rx="1" fill="#F2EDF8" stroke="none" />
      </>;
    case "subtitle":
      return <>
        <path d="M13 16.7h14a2.8 2.8 0 0 1 2.8 2.8V26a2.8 2.8 0 0 1-2.8 2.8h-8.1l-4.1 3v-3H13a2.8 2.8 0 0 1-2.8-2.8v-6.5a2.8 2.8 0 0 1 2.8-2.8Z" fill={ink} stroke="none" />
        <path d="M14 21h8.1m2.9 0h1M14 24.7h2m3 0h7" fill="none" stroke="#FFFFFF" strokeWidth="1.7" strokeLinecap="round" />
      </>;
    case "text":
      return <>
        <path d="M15.5 16h9M20 16v9.7m-2.5 0h5" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12.9 30.5h14.2" fill="none" stroke={ink} strokeWidth="1.6" strokeLinecap="round" strokeOpacity=".8" />
      </>;
    case "code":
      return <g fill="none" stroke={ink} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m15 18.8-4.1 4.4 4.1 4.4m10-8.8 4.1 4.4-4.1 4.4m-3.2-10.4-3.6 12" />
      </g>;
    case "ebook":
      return <>
        <path d="M10.5 16.2c3.4-1.3 6.6-.9 9.5 1.1 2.9-2 6.1-2.4 9.5-1.1v14c-3.2-1.1-6.4-.6-9.5 1.3-3.1-1.9-6.3-2.4-9.5-1.3Z" fill={ink} stroke="none" />
        <path d="M20 18.9v9.6m-6.3-8.3c1.2-.1 2.2.2 3.2.7m-3.2 3c1.2-.1 2.2.2 3.2.7m6.2-3.7c1-.5 2-.8 3.2-.7m-3.2 4.4c1-.5 2-.8 3.2-.7" fill="none" stroke="#FFF6E8" strokeWidth="1.25" strokeLinecap="round" />
      </>;
    case "file":
      return <>
        <rect x="12" y="19" width="16" height="2" rx="1" fill={ink} stroke="none" fillOpacity=".65" />
        <rect x="12" y="24" width="11" height="2" rx="1" fill={ink} stroke="none" fillOpacity=".65" />
        <rect x="12" y="29" width="13.5" height="2" rx="1" fill={ink} stroke="none" fillOpacity=".65" />
      </>;
  }
}

/** 原创文件类型缩略图；内置全部 SVG 颜色，导出时无需附带样式表。 */
export function FileTypeIcon({
  kind,
  size = 32,
  className,
  label,
}: {
  kind: FileVisualKind;
  size?: number;
  className?: string;
  label?: string;
}) {
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const gradientId = `sirius-file-${instanceId}`;
  const palette = kind === "folder" ? null : PALETTES[kind];

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 40 40"
      width={size}
      height={size}
      fill="none"
      stroke="none"
      className={["file-type-icon", `file-type-icon--${kind}`, className].filter(Boolean).join(" ")}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
    >
      {kind === "folder" ? <>
        <defs>
          <linearGradient id={`${gradientId}-back`} x1="20" y1="7" x2="20" y2="32" gradientUnits="userSpaceOnUse">
            <stop stopColor="#9DCEF1" />
            <stop offset="1" stopColor="#75ADD9" />
          </linearGradient>
          <linearGradient id={`${gradientId}-front`} x1="20" y1="14.5" x2="20" y2="34.3" gradientUnits="userSpaceOnUse">
            <stop stopColor="#C6E8FD" />
            <stop offset="1" stopColor="#91C8EF" />
          </linearGradient>
        </defs>
        <path d="M4 10a3 3 0 0 1 3-3h7.6c1 0 1.7.3 2.3 1l2.3 2.7H33a3 3 0 0 1 3 3V30a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3Z" fill={`url(#${gradientId}-back)`} stroke="#80B5DD" strokeWidth=".75" strokeLinejoin="round" />
        <path d="M7 13h25.7a1.3 1.3 0 0 1 1.3 1.3v15.4H6V14a1 1 0 0 1 1-1Z" fill="#EAF7FF" stroke="none" />
        <path d="M5.8 15.5h28.4a2.3 2.3 0 0 1 2.3 2.6L34.8 32a2.6 2.6 0 0 1-2.6 2.3H7.8A2.6 2.6 0 0 1 5.2 32L3.5 18.1a2.3 2.3 0 0 1 2.3-2.6Z" fill={`url(#${gradientId}-front)`} stroke="#8BBCE0" strokeWidth=".75" strokeLinejoin="round" />
        <path d="M6.2 16.5h27.6" fill="none" stroke="#F2FBFF" strokeWidth="1" strokeLinecap="round" strokeOpacity=".9" />
        <path d="M7.8 33.2h24.4" fill="none" stroke="#7BB6E2" strokeWidth=".7" strokeLinecap="round" strokeOpacity=".45" />
      </> : palette && <>
        <defs>
          <linearGradient id={`${gradientId}-paper`} x1="20" y1="3.5" x2="20" y2="36.5" gradientUnits="userSpaceOnUse">
            <stop stopColor={palette.top} />
            <stop offset="1" stopColor={palette.bottom} />
          </linearGradient>
          <linearGradient id={`${gradientId}-fold`} x1="26" y1="4" x2="31" y2="12" gradientUnits="userSpaceOnUse">
            <stop stopColor={palette.fold} />
            <stop offset="1" stopColor={palette.bottom} />
          </linearGradient>
        </defs>
        <path d="M10 3.5h15.5l8 8V33a3.5 3.5 0 0 1-3.5 3.5H10A3.5 3.5 0 0 1 6.5 33V7A3.5 3.5 0 0 1 10 3.5Z" fill={`url(#${gradientId}-paper)`} stroke={palette.edge} strokeWidth=".75" strokeLinejoin="round" />
        <path d="M25.5 3.9v5.6a2 2 0 0 0 2 2h5.6Z" fill={`url(#${gradientId}-fold)`} stroke="none" />
        <path d="M25.5 4.4v5a2 2 0 0 0 2 2h5" fill="none" stroke={palette.ink} strokeWidth=".6" strokeOpacity=".14" strokeLinejoin="round" />
        <path d="M10 4.5h14.3M7.6 32.5V7.2a2.5 2.5 0 0 1 2.5-2.5" fill="none" stroke="#FFFFFF" strokeWidth=".7" strokeOpacity=".8" strokeLinecap="round" />
        <FileGlyph kind={kind} ink={palette.ink} />
      </>}
    </svg>
  );
}
