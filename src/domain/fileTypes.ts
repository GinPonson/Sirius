/** 文件展示类型；与 115 操作所用的 kind 分离，不推断额外的播放或编辑能力。 */
export type FileVisualKind =
  | "folder" | "video" | "image" | "audio" | "pdf" | "document"
  | "spreadsheet" | "presentation" | "archive" | "subtitle" | "text"
  | "code" | "ebook" | "file";

type FileDisplayInput = {
  name: string;
  extension?: string | null;
  kind?: "folder" | "video" | "subtitle" | "file";
};

const LABELS: Record<FileVisualKind, string> = {
  folder: "文件夹", video: "视频", image: "图片", audio: "音频", pdf: "PDF",
  document: "文档", spreadsheet: "表格", presentation: "演示文稿",
  archive: "压缩包", subtitle: "字幕", text: "文本", code: "代码",
  ebook: "电子书", file: "文件",
};

const EXTENSION_GROUPS: Partial<Record<FileVisualKind, string>> = {
  video: "mp4 mkv avi mov m4v webm flv wmv mpg mpeg m2ts mts ts rm rmvb vob",
  image: "jpg jpeg png gif webp avif heic heif bmp tif tiff svg ico dng raw cr2 nef arw",
  audio: "mp3 m4a aac flac wav ogg opus aiff aif alac ape wma",
  pdf: "pdf",
  document: "doc docx odt rtf pages",
  spreadsheet: "xls xlsx xlsm ods csv tsv numbers",
  presentation: "ppt pptx pptm odp key",
  archive: "zip rar 7z tar gz bz2 xz zst tgz tbz2 txz",
  subtitle: "srt ass ssa vtt sub sup idx lrc",
  text: "txt md markdown log nfo rst",
  code: "js mjs cjs ts tsx jsx vue svelte html htm css scss sass less json jsonc xml yaml yml toml ini conf env java kt kts py go rs c cc cpp h hpp cs rb php swift sh bash zsh sql proto ipynb",
  ebook: "epub mobi azw azw3 djvu cbz cbr cb7 cbt",
};

const EXTENSION_KINDS = new Map<string, FileVisualKind>();
for (const [kind, extensions] of Object.entries(EXTENSION_GROUPS)) {
  for (const extension of extensions.split(" ")) {
    EXTENSION_KINDS.set(extension, kind as FileVisualKind);
  }
}

/** 目录和服务端已识别的媒体类型优先；其余文件按大小写不敏感的后缀展示。 */
export function getFilePresentation(file: FileDisplayInput): { kind: FileVisualKind; label: string } {
  if (file.kind === "folder" || file.kind === "video" || file.kind === "subtitle") {
    return { kind: file.kind, label: LABELS[file.kind] };
  }

  const basename = file.name.split(/[\\/]/).pop() ?? file.name;
  const dot = basename.lastIndexOf(".");
  const nameExtension = dot > 0 ? basename.slice(dot + 1).toLowerCase() : "";
  const metadataExtension = file.extension?.trim().replace(/^\.+/, "").toLowerCase();
  const extension = metadataExtension || nameExtension;
  const resolvedExtension = EXTENSION_KINDS.has(extension) ? extension : nameExtension;
  const kind = EXTENSION_KINDS.get(resolvedExtension) ?? "file";
  const label = kind === "ebook" && ["cbz", "cbr", "cb7", "cbt"].includes(resolvedExtension)
    ? "漫画" : LABELS[kind];
  return { kind, label };
}
