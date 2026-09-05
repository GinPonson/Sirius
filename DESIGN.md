---
version: alpha
name: Sirius
description: |
  macOS 优先的 115 第三方客户端。115 文件管理是核心，视频播放、AI 文件整理、漫画和相册是建立在同一文件模型上的内容模式。
  本文件仅保存 machine-readable 视觉 token，遵循 Google Stitch DESIGN.md 规范（alpha, 2026-04）；产品、工程与安全规则统一以根目录 AGENTS.md 为准。
  视觉定位：表现力外壳 + 精确文件工作台。品牌首屏、模式入口与内容详情允许编辑式排版、空间层次与连续动效；文件表格、批量选择与危险操作保持稳定、可预测、零装饰。

# ============================================================================
# §2 COLORS — single-accent philosophy (Apple)
# Token naming uses Google Stitch conventions:
# - primary / on-primary / fg / muted / hairline / etc.
# - Tint variants prefixed with `tint-` (e.g. tint-peach)
# - Status colors prefixed with `status-` (e.g. status-ready)
# - AI timeline stage colors prefixed with `stage-` (e.g. stage-thinking-bg)
# ============================================================================
colors:
  # --- Brand & primary (single accent philosophy) ---
  primary: "#2458d7"
  on-primary: "#ffffff"
  accent-fg: "#ffffff"
  primary-soft: "#eaf0ff"
  primary-tint: "rgba(36, 88, 215, 0.06)"

  # --- Foreground / text ---
  fg: "#111114"
  muted: "#6b6b70"
  fg-disabled: "#a8a8ad"

  # --- Surface ---
  bg: "#fafafa"
  surface: "#ffffff"
  surface-hover: "#f2f2f4"
  surface-active: "#e8e8ec"
  surface-elevated: "#ffffff"
  surface-stone: "#eeece7"

  # --- Borders / hairlines ---
  hairline: "#edf0f4"
  hairline-strong: "#a1a1a1"

  # --- Frosted surface (Apple-inspired, for floating panels only) ---
  frosted-bg: "rgba(255, 255, 255, 0.82)"

  # --- Keycap gradient (Raycast-inspired physical-key) ---
  key-bg-start: "#fdfdfd"
  key-bg-end: "#eef0f3"
  key-border: "#e0e4ea"

  # --- Status indicators (AI panel + status dots) ---
  status-ready: "#59d499"
  status-ready-glow: "rgba(89, 212, 153, 0.18)"

  # --- AI timeline stage colors (Cursor-inspired, soft-color discipline) ---
  stage-thinking-bg: "rgba(223, 168, 143, 0.18)"
  stage-thinking-ink: "#b86c4a"
  stage-searching-bg: "rgba(159, 201, 162, 0.20)"
  stage-searching-ink: "#4a8054"
  stage-reading-bg: "rgba(159, 187, 224, 0.20)"
  stage-reading-ink: "#3d6ba8"
  stage-editing-bg: "rgba(192, 168, 221, 0.20)"
  stage-editing-ink: "#6f4e9c"

  # --- Pastel tint palette (Notion-inspired, reserved for future use) ---
  tint-peach: "#ffe8d4"
  tint-rose: "#fde0ec"
  tint-mint: "#d9f3e1"
  tint-lavender: "#e6e0f5"
  tint-sky: "#dcecfa"
  tint-yellow: "#fef7d6"
  tint-yellow-bold: "#f9e79f"
  tint-cream: "#f8f5e8"
  tint-gray: "#f0eeec"

  # --- Semantic (DESIGN.md §9.8.1) ---
  danger: "#c5302a"
  success: "#16a34a"
  warn: "#b58800"

# ============================================================================
# §4 LAYOUT — Apple 8-step spacing ladder (with 17px signature mid-step)
# ============================================================================
spacing:
  space-1: "4px"
  space-2: "8px"
  space-3: "12px"
  space-4: "17px"
  space-5: "24px"
  space-6: "32px"
  space-7: "48px"
  space-8: "80px"

# ============================================================================
# §6 SHAPES — Border radius scale
# ============================================================================
rounded:
  xs: "4px"
  sm: "7px"
  md: "9px"
  lg: "12px"
  xl: "14px"
  pill: "9999px"

# ============================================================================
# §5 ELEVATION & DEPTH — Single shadow reserved for product imagery (Apple)
# ============================================================================
shadow:
  product: "0 4px 14px rgba(34, 54, 82, 0.12)"
  product-hover: "0 10px 22px rgba(34, 54, 82, 0.20)"
  floating: "0 8px 32px rgba(48, 70, 108, 0.08)"

# ============================================================================
# §3 TYPOGRAPHY — Vercel-inspired 13-step hierarchy
# Token naming: text-display-{xl|lg|md|sm} / text-body-{lg|md|sm} / etc.
# ============================================================================
typography:
  text-display-xl:
    fontFamily: "DM Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "48px"
    fontWeight: 600
    lineHeight: 1.0
    letterSpacing: "-2.4px"
  text-display-lg:
    fontFamily: "DM Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "32px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-1.28px"
  text-display-md:
    fontFamily: "DM Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: "-0.96px"
  text-display-sm:
    fontFamily: "DM Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.6px"
  text-body-lg:
    fontFamily: "DM Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 0
  text-body-md:
    fontFamily: "DM Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  text-body-md-strong:
    fontFamily: "DM Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: 0
  text-body-sm:
    fontFamily: "DM Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: "-0.28px"
  text-body-sm-strong:
    fontFamily: "DM Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.43
    letterSpacing: "-0.28px"
  text-caption:
    fontFamily: "DM Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.33
    letterSpacing: 0
  text-caption-mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.33
    letterSpacing: 0
  text-code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 0
  text-button-md:
    fontFamily: "DM Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.43
    letterSpacing: 0
  text-button-lg:
    fontFamily: "DM Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: 0

# ============================================================================
# §7 COMPONENTS — minimal core set
# Sub-keys must use Stitch conventions: backgroundColor / textColor / typography /
# rounded / padding / size / height / width
# ============================================================================
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    typography: "{typography.text-button-md}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.text-button-md}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    typography: "{typography.text-button-md}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-link:
    backgroundColor: "transparent"
    textColor: "{colors.primary}"
    typography: "{typography.text-button-md}"
    padding: "0"
    height: "auto"

  # ============================================================================
  # §9.8.3 Sidebar button (macOS System Settings pattern)
  # ============================================================================
  brand-mark:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary}"
    rounded: "{rounded.md}"
    size: "26px"
  sidebar-item:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.text-body-sm}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  sidebar-item-active:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  sidebar-item-badge:
    backgroundColor: "#eef0f3"
    textColor: "{colors.muted}"
    typography: "{typography.text-caption}"
    rounded: "{rounded.pill}"
    padding: "1px 7px"
  sidebar-item-badge-active:
    backgroundColor: "rgba(255, 255, 255, 0.18)"
    textColor: "{colors.on-primary}"

  # ============================================================================
  # §9.8.4 Tab / segmented control
  # ============================================================================
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.text-body-sm}"
    padding: "0 14px"
    height: "36px"
  tab-active:
    backgroundColor: "transparent"
    textColor: "{colors.fg}"
    padding: "0 14px"
    height: "36px"
  segmented-control-item:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.text-body-sm}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  segmented-control-item-active:
    backgroundColor: "{colors.surface-active}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    padding: "8px 14px"

  # ============================================================================
  # §9.8.5 List item / file row
  # ============================================================================
  list-item:
    backgroundColor: "transparent"
    textColor: "{colors.fg}"
    typography: "{typography.text-body-md}"
    padding: "0 16px"
    height: "44px"
  list-item-checkbox:
    backgroundColor: "transparent"
    textColor: "{colors.primary}"
    rounded: "{rounded.pill}"
    size: "18px"

  # ============================================================================
  # §9.8.6 Form input
  # ============================================================================
  form-input:
    backgroundColor: "{colors.surface-elevated}"
    textColor: "{colors.fg}"
    typography: "{typography.text-body-md}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  form-input-focused:
    backgroundColor: "{colors.surface-elevated}"
    textColor: "{colors.primary}"
    typography: "{typography.text-body-md}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"

  # ============================================================================
  # §9.8.7 Topbar & toolbar buttons
  # ============================================================================
  topbar:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    padding: "0 32px"
    height: "48px"
  toolbar-button:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    size: "32px"
  toolbar-button-active:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    size: "32px"

  # ============================================================================
  # §9.8.8 Badges & status pills
  # ============================================================================
  badge-pill:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.text-caption}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
  badge-success:
    backgroundColor: "transparent"
    textColor: "{colors.success}"
    typography: "{typography.text-caption}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
  badge-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    typography: "{typography.text-caption}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
  badge-warn:
    backgroundColor: "transparent"
    textColor: "{colors.warn}"
    typography: "{typography.text-caption}"
    rounded: "{rounded.pill}"
    padding: "0 8px"

  # ============================================================================
  # §10 Desktop interaction — command palette + cheatsheet (§10.4 / §10.5)
  # ============================================================================
  cheatsheet-modal:
    backgroundColor: "{colors.frosted-bg}"
    rounded: "{rounded.lg}"
    width: "560px"
    maxHeight: "70vh"
  command-palette-row:
    backgroundColor: "transparent"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
  command-palette-row-active:
    backgroundColor: "{colors.surface-card}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"

  # ============================================================================
  # §9.8.12 Reference pattern attribution (10 DESIGN.md sources)
  # ============================================================================
  reference-patterns:
    description: "Sirius prototype borrows pattern discipline from these 10 DESIGN.md files in voltagent/awesome-design-md"
    sources:
      - id: apple
        path: "design-md/apple/DESIGN.md"
        contributions:
          - "spacing 8-step ladder with 17px signature"
          - "frosted surface (saturate(180%) blur(20px))"
          - "single shadow reserved for product imagery"
          - "single accent philosophy"
      - id: linear-app
        path: "design-md/linear.app/DESIGN.md"
        contributions:
          - "sidebar+content+drawer workbench layout"
          - "4-step surface ladder (reserved for future dark mode)"
          - "responsive breakpoint pattern"
      - id: spotify
        path: "design-md/spotify/DESIGN.md"
        contributions:
          - "media-tile geometry reference (NOT dark canvas)"
      - id: raycast
        path: "design-md/raycast/DESIGN.md"
        contributions:
          - "command-palette-row pattern (icon | label | keycap)"
          - "keycap physical-key feel (vertical gradient + inset shadow)"
      - id: cursor
        path: "design-md/cursor/DESIGN.md"
        contributions:
          - "AI timeline pills (4-stage simplification)"
          - "soft-color discipline (rgba 0.18-0.20 alpha)"
      - id: claude
        path: "design-md/claude/DESIGN.md"
        contributions:
          - "status indicator (status-ready dot + glow)"
          - "source chip pill upgrade"
          - "AI panel editorial voice"
      - id: superhuman
        path: "design-md/superhuman/DESIGN.md"
        contributions:
          - "pill-tab filter chip pattern"
          - "⌘⇧ cheatsheet pattern (future)"
          - "keyboard-first discipline"
      - id: notion
        path: "design-md/notion/DESIGN.md"
        contributions:
          - "card family (card-base / card-feature / card-tint-*)"
          - "9-color pastel tint palette (restraint discipline)"
          - "sober-editorial tone"
      - id: vercel
        path: "design-md/vercel/DESIGN.md"
        contributions:
          - "13-step typography tokenization"
          - "font-weight ladder with display ceiling 600"
          - "negative tracking discipline"
          - "mono-for-technical-only voice"
      - id: cohere
        path: "design-md/cohere/DESIGN.md"
        contributions:
          - "rule-separated list (publication-style, no card chrome)"
          - "chip-large for taxonomy hero zones"
          - "button-link underline-only secondary action"
          - "surface-stone warm-neutral"

# ============================================================================
# §11 PRINCIPLES — Sirius 自己的视觉母题（audit 2026-08-23 P0）
# ============================================================================
principles:
  positioning: "表现力外壳 + 精确文件工作台"
  invariants:
    - "所有模式共享同一导航、字体、间距与运动物理，不做四套应用"
    - "文件数据区（表格/批量操作/危险操作）禁用装饰动效与变形"
    - "prefers-reduced-motion 下取消位移与漂移，但保留完整状态反馈"
    - "真实素材优先；缺图时使用品牌化影像，不使用字母海报或 CSS 假图"

# ============================================================================
# §12 COMPOSITION — 布局构图
# ============================================================================
composition:
  shell: "固定侧栏（224px）+ 全幅内容画布；文件工作台占满默认视口"
  entry-screen:
    composition: "非对称双区：品牌叙事舞台占 55–62%，任务操作面板占 38–45%"
    hierarchy: ["品牌标识与叙事", "主任务（扫码授权）", "状态与安全说明"]
    stage: "允许深色舞台与影像出血；操作面板保持浅色稳定区"
  rhythm: "区块间距 space-7（48px），组间距 space-6（32px），数据行高 44–52px"

# ============================================================================
# §13 MATERIAL — 材质
# ============================================================================
material:
  canvas: "bg 单色画布承载文件工作台；沉浸区允许深色舞台（rgba(8,12,18,*)）"
  frosted-panel: "frosted-bg + blur(20px)，仅用于浮层、顶栏与播放条"
  hairline: "1px hairline 分隔文件数据区，禁用卡片阴影堆叠"
  deep-stage: "登录/模式首屏允许层叠径向光斑 + 缓慢漂移（blur >= 90px, opacity <= 0.5）"

# ============================================================================
# §14 IMAGERY — 影像
# ============================================================================
imagery:
  rule: "真实 115 缩略图与剧照优先；无图时使用品牌化影像系统，不使用字母 monogram 或渐变假封面"
  overlay: "影像上叠加文字必须加自下而上的遮罩（transparent → rgba(8,12,18,0.72)）"
  aspect: ["poster 2/3", "still 16/9", "page-cover 21/9"]

# ============================================================================
# §15 MOTION — 动效
# ============================================================================
motion:
  physics: "cubic-bezier(0.16, 1, 0.3, 1) 为主弹簧；进入 0.28–0.48s，悬停 0.16–0.32s"
  ambient: "登录/模式首屏允许 20s+ 缓慢空间漂移；文件表格与数据行禁止环境动效"
  shared-element: "卡片 → 详情/播放器使用共享元素过渡"
  reduced-motion: "位移与漂移取消，保留透明度与颜色反馈"

# ============================================================================
# §16 MODE THEMES — 模式主题（同源可辨识；未实施模式仅记录方向，不加导航占位）
# ============================================================================
modes:
  files: "精确工作台：单色画布、hairline 分隔、稳定表格、零装饰"
  video: "影院尺度：真实剧照、深色舞台、共享元素进入播放器"
  comics: "书脊与阅读序列：封面竖排、页码与进度形成连续空间（未实施）"
  albums: "时间线沉浸：真实缩略图墙与颜色提取（未实施）"
  ai: "可审查整理：文件差异、整理计划与执行时间线为视觉核心（未实施）"

---



## Related documents

- `AGENTS.md` — 当前产品方向、工程架构、构建测试、安全边界和实施顺序的唯一规则来源
- `docs/design-archive/DESIGN.md` — 完整中文设计文档（§0-§16 调查 / 产品定义 / 信息架构 / 核心功能 / AI 对话 / 权限 / 数据模型 / 技术架构 / 桌面交互 / 错误 / 路线图 / 测试 / 风险 / 决策 / 调研来源）
