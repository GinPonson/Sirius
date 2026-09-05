import {
  BookOpen,
  Check,
  ChevronRight,
  Cloud,
  Compass,
  Download,
  Ellipsis,
  Folder,
  History,
  House,
  Images,
  LayoutGrid,
  ListChecks,
  Pencil,
  Play,
  Plus,
  Search,
  Settings,
  Sparkles,
  Star,
  Trash2,
  TriangleAlert,
  Upload,
  User,
  X,
  type LucideIcon,
} from "lucide-react";

export type IconName =
  | "home"
  | "library"
  | "discover"
  | "tasks"
  | "settings"
  | "search"
  | "play"
  | "close"
  | "cloud"
  | "check"
  | "alert"
  | "folder"
  | "history"
  | "plus"
  | "more"
  | "star"
  | "edit"
  | "trash"
  | "chevron"
  | "user"
  | "upload"
  | "download"
  | "sparkles"
  | "book"
  | "images";

const ICONS: Record<IconName, LucideIcon> = {
  home: House,
  library: LayoutGrid,
  discover: Compass,
  tasks: ListChecks,
  settings: Settings,
  search: Search,
  play: Play,
  close: X,
  cloud: Cloud,
  check: Check,
  alert: TriangleAlert,
  folder: Folder,
  history: History,
  plus: Plus,
  more: Ellipsis,
  star: Star,
  edit: Pencil,
  trash: Trash2,
  chevron: ChevronRight,
  user: User,
  upload: Upload,
  download: Download,
  sparkles: Sparkles,
  book: BookOpen,
  images: Images,
};

type IconProps = {
  name: IconName;
  size?: number;
  /** 图标本身不承载语义，默认 aria-hidden；按钮语义由外层控件提供。 */
  label?: string;
};

/** Lucide 图标统一出口：固定 1.7px 描边，尺寸与无障碍行为集中管理。 */
export function Icon({ name, size = 18, label }: IconProps) {
  const Lucide = ICONS[name];
  return (
    <Lucide
      aria-hidden={label ? undefined : true}
      aria-label={label}
      size={size}
      strokeWidth={1.7}
      absoluteStrokeWidth
    />
  );
}
