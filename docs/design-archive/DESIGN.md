# Sirius 桌面端产品调查与设计

## 0. 修订说明（2026-07-23）

本次修订针对以下用户决策：

- **目标平台调整为 macOS 优先**（Tier 1），Windows / Linux 退为后续预留。
- **AI 改为供应商提供模型**，默认使用 **Anthropic Claude（messages API + Tool Use + 流式 SSE）**，通过官方 SDK 调用；其他 OpenAI-compatible 供应商按需支持。
- **本地不放、不训练、不自部署大模型**；ASR（如后续引入）也走供应商或独立二进制，不与 Claude 推理流程耦合。

修订影响范围：

- §1 文档概述：加入技术栈与 AI 供应策略。
- §3.3 目标用户和 §4.1 信息架构：按 macOS 习惯调整（菜单栏、⌘K、⌘→、Command Center 友好快捷键、Finder 集成）。
- §6 AI 与安全：明确 Claude API 调用方式、上下文与引用协议、出站控制。
- §9 技术架构：默认 macOS 优先实施路径，技术栈给出 macOS 首选与跨平台备用两套。
- §12 路线图：M0 调整为 macOS 优先验证，Windows / Linux 与 MCP / Agent 写操作明确延后。

> 字段级参考：本文对 Claude API 字段（messages、tool_use、stream event、beta header 等）的描述基于通用 SDK 文档；实际实现前必须**以 Anthropic 当前平台文档为准**（`https://docs.anthropic.com/` 或对应 SDK 版本源码）。地区不可达时，请参考最新镜像与官方 changelog。

## 1. 文档概述

本文定义 Sirius 桌面端应用的产品方向与技术方案。Sirius 继承 StarVault 的 115 网盘、文件管理、传输、预览与账号能力，但将桌面端的核心体验调整为视频媒体中心，并新增上下文感知的 AI 对话能力。

调查基线：

- Tsukimi：Linux 原生 Jellyfin/Emby 客户端，重点研究桌面导航、媒体详情、MPV 播放和服务端能力。
- StarVault：115 网盘 Android 客户端，重点复用认证、文件管理、传输、回收站、搜索、缩略图和错误处理逻辑。
- Plezy、Fladder、Soia、IINA、Jellyfin Desktop：重点比较首页、播放器、字幕、HDR、多窗口、快捷键及多数据源设计。
- Spacedrive、AnythingLLM、PrivateGPT、Jellyfin：分别作为桌面文件系统、本地 RAG、AI 工具权限和媒体元数据参考。
- Anthropic Claude API / SDK：作为 Sirius 默认 AI 提供方，参考其 messages、Tool Use、streaming 行为与 SDK 文档。

本文不把 Sirius 定义为 Tsukimi 的复刻，也不把它定义为 StarVault 的桌面移植。Sirius 是一个以视频为主入口、文件为底层事实源、Claude 驱动的 AI 为操作与理解界面的桌面应用。

---

## 2. 调查结论

### 2.1 Tsukimi

Tsukimi 是使用 Rust、GTK4、Libadwaita 构建的 Linux Jellyfin 客户端，视频播放通过 MPV 与 Mutsumi 嵌入实现，音乐播放使用 GStreamer。它支持 Jellyfin 基础功能、部分 Emby 能力和较多服务端管理功能。

值得复用的设计：

1. 原生桌面导航：侧边栏、内容区、详情页和内嵌播放器形成稳定的信息层级。
2. 首页模块化：继续观看、下一集、媒体库等横向内容条可按服务端能力装配。
3. 播放回退：Direct Play、Direct Stream、Transcode 按能力逐级回退。
4. 播放器控制侧栏：音轨、字幕、视频参数、字幕样式和缓冲信息集中在独立面板。
5. 桌面集成：窗口状态、快捷键、全屏、MPRIS、主题和系统媒体键。
6. 客户端能力声明：通过媒体 Profile 告诉服务端可直接解码的编码、封装和字幕格式。
7. 数据缓存：首页数据支持缓存优先、后台刷新和差异更新。

需要避免的限制：

1. 平台只面向 Linux，无法直接满足 Windows 和 macOS。
2. 数据模型紧耦合 Jellyfin，不能自然表达 115 文件、本地文件和网络目录。
3. 文件管理只是媒体库附属能力，不适合承担完整网盘管理。
4. AI、语义索引和多模态理解不在项目范围内。
5. MPV 嵌入依赖 Linux/Wayland 特定实现，跨平台需要独立抽象。

### 2.2 StarVault

StarVault 是 Kotlin 与 Jetpack Compose 构建的 115 网盘 Android 客户端，已经具备扫码授权、令牌刷新、文件列表、搜索、预览、批量移动和删除、回收站、上传下载、相册及壁纸等能力。

Sirius 应继承的业务能力：

- 115 开放平台设备码授权。
- Access Token 自动刷新和单次重试。
- 文件列表、搜索、详情、重命名、移动、删除和回收站。
- 视频播放地址、字幕列表、文件下载地址和签名 URL 生命周期管理。
- Aliyun OSS 上传流程与后台传输任务。
- 1 请求/秒的服务限速策略。
- 按账号隔离的本地筛选器、最近记录和设置。
- 明确暴露错误，不用默认值或静默降级掩盖失败。

不能直接复用的部分：

- Android 的 Compose UI、WorkManager、MediaStore、WallpaperService 和 Activity 导航。
- 移动端底部导航和单列页面结构。
- Media3 播放器实现。
- Android DataStore 和系统权限模型。

重要事实：StarVault 当前没有 AI 对话、LLM、RAG、向量索引或 Agent 工具系统。Sirius 的 AI 能力必须作为新模块设计，而不是从 StarVault 迁移。

### 2.3 同类桌面产品

| 产品 | 优点 | 对 Sirius 的启示 |
|---|---|---|
| Plezy | Plex/Jellyfin 双后端、播放器分层、字幕、HDR、快捷键、多服务器 | 借鉴后端能力抽象和播放会话模型 |
| Fladder | 首页模块化、跨平台、一致的信息架构 | 借鉴可排序首页模块和响应式桌面布局 |
| Soia | 本地、WebDAV、SMB、DLNA；HDR、双字幕 | 借鉴文件源模式与网络目录直播 |
| IINA | macOS 原生、快捷键、播放列表、迷你播放器、插件 | 借鉴桌面交互、多窗口和高级用户能力 |
| Jellyfin Desktop | 成熟的 Jellyfin 播放链路 | 仅作为兼容基线，不采用归档项目架构 |
| Spacedrive | 本地索引、跨设备文件抽象 | 借鉴统一 Item、索引和文件操作事务 |
| AnythingLLM | 工作区 RAG、Agent、MCP | 借鉴上下文、工具注册和任务审计 |

---

## 3. 产品定义

### 3.1 产品愿景

Sirius 是面向 Windows、macOS 和 Linux 的视频优先桌面工作台。用户可以在一个应用中管理 115 网盘和本地视频文件、建立媒体库、播放和整理内容，并通过 AI 对视频、字幕、文件和媒体库进行检索、理解与受控操作。

### 3.2 核心价值

1. 视频即首页：打开应用首先看到继续观看、最近添加、媒体库和收藏，而不是传统文件树。
2. 文件即事实源：所有视频最终可追溯到实际文件、目录、账号和存储位置。
3. AI 即上下文界面：用户可以对当前视频、时间段、文件夹或整个媒体库提问。
4. 本地优先：索引、字幕、对话记录和审计日志默认保存在本机。
5. 操作可控：AI 默认只读；写入、移动、重命名、删除和联网必须经过权限策略。
6. 跨平台一致、系统体验原生：统一业务层，同时保留各平台窗口、菜单、快捷键和媒体键习惯。

### 3.3 目标用户

- 使用 115 网盘维护影视资源的个人 macOS 用户（首选）。
- 使用本地磁盘或 NAS 管理大量视频的家庭媒体用户。
- 需要搜索课程、会议、录屏和访谈内容的知识工作者。
- 需要字幕、镜头检索和素材整理的视频创作者。

### 3.3.1 平台等级

| 等级 | 平台 | 首版要求 |
|---|---|---|
| Tier 1 | macOS 13+（Apple Silicon + Intel） | 首发完整支持，最低质量基线 |
| Tier 2（预览） | Windows 10/11 | 后续发布，技术预览标记 |
| Tier 2（预览） | Linux（X11/Wayland） | 后续评估，社区预览 |

macOS 优先的原因：

- 原生 SwiftUI/AppKit 提供更紧凑 UI 与系统集成。
- MPC-HC/IINA/mpv 等成熟桌面参考实现集中在 macOS 与跨平台实践。
- AVFoundation、CATransaction、SFSymbols 可减少自定义绘图。
- macOS 提供稳定开发者签名与公证链路，便于首次发布。

风险与缓解：

- 仅 macOS 会限制用户基础；通过 Tier 2 缓解。
- 部分媒体编码（如 WMA、Real）在 macOS 上需配合 libavformat。
- AI 调用走云端，受供应商地区/计费影响。

### 3.4 非目标

首个版本不承担以下目标：

- 不建设完整 Jellyfin、Plex 或 Emby 服务端。
- 不绕过 DRM 或存储服务权限。
- 不默认把视频、字幕或文件内容上传到云模型。
- 不允许 AI 在无确认时批量修改或删除文件。
- 不在首版实现多人协作、社交社区和在线视频聚合。

---

## 4. 信息架构

### 4.1 主窗口

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ 后退/前进  全局搜索 ⌘K             播放设备  任务中心  AI  账号/设置 │
├──────────┬──────────────────────────────────────────────┬───────────────┤
│ 首页     │                                              │ AI 对话       │
│ 媒体库   │            主内容区                          │ 当前上下文    │
│ 文件     │ 首页 / 详情 / 文件 / 搜索 / 播放器           │ 引用与工具调用│
│ 收藏     │                                              │               │
│ 传输     │                                              │               │
│ 回收站   │                                              │               │
│          │                                              │               │
│ 数据源   │                                              │               │
│  115     │                                              │               │
│  本地   │                                              │               │
│  WebDAV │                                              │               │
├──────────┴──────────────────────────────────────────────┴───────────────┤
│ 正在播放 / 后台任务 / 索引状态 / 网络与隐私状态                         │
└─────────────────────────────────────────────────────────────────────────┘
```

布局规则：

- 左侧导航默认 220dp，可折叠成 56dp 图标栏。
- AI 面板默认关闭，可固定、调整宽度或分离成独立窗口。
- 播放器既可占据主内容区，也可进入全屏、画中画或独立窗口。
- 底部播放条只在离开播放器后出现，保持当前播放会话。
- 主窗口最小宽度建议 1024px；窄窗口隐藏 AI 面板并收起侧栏。
- **不使用**明显的彩边、阴影或填色区分侧栏按钮；用文字色 + 图标色调传达层级。

### 4.1.1 视觉原则（克装饰、统一层级）

- **无装饰边框**：侧栏按钮、Tab、列表项均不使用描边；状态通过 `background`、`color`、内嵌图标表达。
- **焦点环统一**：仅键盘聚焦时显示 2px 圆角焦点环（accent 50% 透明度），鼠标悬停不显示焦点环。
- **层级靠空间与字号**：通过 8/12/16/24px 间距、字号（13/14/16/20）、颜色灰阶区分，而不是色块或分隔线。
- **悬浮态最低限度**：背景轻微变深（surface → surface-hover），不变 accent 色，不发光。
- **选中态单一信号**：左缘 2px accent 色短竖条 + 文字变 accent，背景仍保持中性。
- **主操作按钮柔和**：主按钮背景填 accent 前景白；无投影、无渐变；圆角 8dp；hover 仅亮度 -4%。
- **次要按钮幽灵化**：文字按钮或边框颜色 0 的 fill 按钮，hover 才出现 `surface-hover`。
- **危险按钮文字化**：删除、永久删除等只显示文字 + 警示图标，不显示红色填充按钮。
- **禁止使用**：双层圆角、彩色描边、阴影投影（仅一个 `0/1/0/0` 的 1dp hairline 可选）、emoji 当图标、动画过渡超过 120ms。

### 4.2 导航结构

1. 首页
   - 继续观看
   - 下一集
   - 最近添加
   - 收藏
   - 最近访问文件夹
   - 自定义媒体库
2. 媒体库
   - 电影
   - 剧集
   - 视频
   - 课程/录屏
   - 自定义集合
3. 文件
   - 115 网盘
   - 本地目录
   - WebDAV/SMB（后续）
4. 收藏
5. 传输
6. 回收站
7. AI 会话
8. 设置

### 4.3 全局搜索

全局搜索通过 `Ctrl/Cmd + K` 打开，支持：

- 按文件名、标题、演员、标签、字幕文本搜索。
- 按文件类型、来源、分辨率、HDR、字幕语言和修改时间过滤。
- 跨 115、本地媒体库和 AI 索引搜索。
- 搜索结果分为媒体、文件、文件夹、字幕片段和 AI 会话。
- 字幕结果点击后直接跳转到对应时间码。

---

## 5. 核心功能设计

### 5.1 视频首页

首页采用可配置模块，而非固定瀑布流：

- Hero：当前最适合继续观看的内容，提供继续播放、详情和更多操作。
- 继续观看：按最后播放时间排序。
- 下一集：剧集播放后的自然续播候选。
- 最近添加：按数据源与媒体库筛选。
- 收藏：用户手动收藏的文件或媒体。
- 最近目录：为保留 StarVault 文件管理效率提供快捷入口。
- AI 推荐：仅基于本地观看历史、标签和字幕索引，默认不调用云服务。

用户可隐藏模块、调整顺序和设置每行卡片密度。

### 5.2 媒体详情

详情页采用背景图、海报、核心元数据和播放主按钮：

- 标题、年份、时长、简介、评分、类型、演员。
- 继续播放或从头播放。
- 文件来源、文件路径、大小、编码、分辨率、HDR 类型。
- 音轨、字幕轨和媒体版本。
- 剧集的季、单集、下一集和特别篇。
- 章节、片头片尾和关联内容。
- AI 快捷入口：总结、提取人物、询问当前视频、生成章节。
- 文件操作：打开所在目录、重命名、移动、下载、收藏和删除。

媒体元数据与物理文件必须分离。一个媒体条目可以关联多个版本或多个存储位置。

### 5.3 播放器

首版播放器能力：

- MPV/libmpv 播放核心。
- 本地文件、HTTP 直链和 115 签名 URL。
- 断点续播、自动保存进度和播放历史。
- 音轨、内嵌字幕、外挂字幕与字幕延迟。
- ASS/SSA、SRT、VTT。
- 章节、上一集和下一集。
- 播放速度、画面比例、缩放、旋转和硬件解码。
- 播放信息：封装、视频编码、音频编码、码率、HDR、解码器和掉帧。
- 全屏、画中画、独立窗口和迷你播放器。
- 系统媒体键与平台媒体会话。
- 可配置快捷键。

第二阶段能力：

- 双字幕。
- 在线字幕搜索。
- 字幕字体和样式管理。
- HDR 色调映射和显示匹配。
- Shader 与 Anime4K。
- 外部播放器。
- 播放队列和跨文件夹连续播放。

播放失败不能静默切换为低质量源。每次回退都应显示原因，例如“原始 HEVC 解码失败，是否尝试转码版本”。

### 5.4 文件管理

文件页保留 StarVault 的业务完整性，并针对桌面增加效率：

- 列表、网格和媒体墙三种视图。
- 面包屑、可固定目录和多标签页。
- 多选、框选、拖放、批量移动和批量删除。
- 新建文件夹、重命名、收藏、复制路径和打开所在目录。
- 排序、筛选、标签和保存的筛选条件。
- 回收站恢复与彻底删除。
- 115 上传、下载和任务队列。
- 本地文件与 115 文件之间的复制任务。
- 冲突处理：覆盖、保留两者、跳过或逐项确认。
- 文件操作历史和可撤销事务。

桌面增强：

- `Ctrl/Cmd + L` 定位路径。
- `Space` 快速预览。
- `F2/Return` 重命名，`Delete/Cmd+Backspace` 移入回收站。
- 拖文件到播放器直接播放，拖到 AI 面板加入上下文。
- 右键菜单根据数据源能力动态显示。

### 5.5 传输中心

传输中心统一显示：

- 115 上传和下载。
- 本地复制和移动。
- 缩略图、字幕、转写、索引等后台任务。
- 当前速度、剩余时间、已传字节和错误原因。
- 暂停、恢复、取消、重试和清除完成任务。
- 并发数与带宽限制。

所有任务必须持久化，应用崩溃或重启后可恢复。签名 URL 失效时必须重新获取，不能把 403 当作普通网络失败无限重试。

---

## 6. AI 对话设计（Claude 供应商模型）

> 本节贯穿以下约定：Sirius **仅消费供应商提供的 Claude 模型**，不训练、不部署、不自托管大模型；模型选择遵循 Anthropic 平台公布的官方 ID。

### 6.1 AI 面板定位

AI 不是独立聊天软件，而是对当前内容和媒体库的上下文操作层。每个回答必须说明上下文范围，并尽可能提供可点击引用。

上下文类型：

- 当前视频。
- 当前时间段。
- 当前字幕轨。
- 当前文件或文件夹。
- 当前媒体库。
- 用户手动添加的一组文件。
- 全局索引。

### 6.2 核心场景

首版仅提供只读场景；写场景在后续产品门通过后开启：

1. “总结当前视频，并列出每个章节的时间码。”
2. “这个人物第一次出现在哪里？”
3. “搜索所有提到‘向量数据库’的视频片段。”
4. “找出重复视频，按清晰度和码率推荐保留版本。”
5. “下载当前季未缓存的所有视频。”

写场景（首版禁用，后续产品门通过后开放）：

6. 为没有字幕的视频生成中文字幕。
7. 把这个文件夹按剧名、季和集整理，并预览。
8. 将这些课程视频生成 Markdown 学习笔记。

### 6.3 Claude API 集成约定

Sirius 通过 **Anthropic Claude messages API**（官方 SDK）调用模型；具体请求字段以官方平台文档为准。

#### 6.3.1 鉴权

- API Key 通过 `keyring` / macOS Keychain 存储，标识 `sirius:anthropic`。
- 请求头：`x-api-key` 或 SDK 等价封装。
- 客户端必须**永不**把 API Key 写入日志、UI、URL、IPC payload 或文件。
- 撤销/轮换：Keychain 条目可单独覆盖；旧 Key 仅用于解密未来短期缓存，不用于新请求。

#### 6.3.2 模型 ID

| 任务 | 默认 Claude 模型 | 备选 |
|---|---|---|
| 长视频摘要、章节列表 | 当前一代 Sonnet | opus（牺牲成本换质量） |
| 文件夹检索、改写 | 当前一代 Sonnet | haiku（成本与延迟敏感） |
| 工具调用（Tool Use） | 当前一代 Sonnet | haiku |

M0 仅固定 Sonnet 一个 ID；后续按平台公告支持新模型。

#### 6.3.3 请求结构（要点）

每次请求必须包含：

- `model`：sirius 配置的 ID（默认 Sonnet）。
- `max_tokens`：按任务预算分别设置；超过限制时延后分页。
- `system`：包含 Sirius 系统提示（角色、能力、上下文规则、安全不变量）。
- `messages`：当前会话消息数组，遵循 Anthropic 角色与 content blocks 约定。
- `tools`：使用 Anthropic 工具定义格式声明可调用工具。
- `stream`：默认开启，使用 SSE 增量推送；UI 使用 streaming block 渲染。
- `metadata`：可附 `user_id`（匿名 hash）、`session_id`，便于 AUP 审计。
- 额外头（按平台约定）：如下游功能需要 beta 能力，使用官方平台文档公布的 beta header。

Sirius 抽象 `ClaudeRequest { model, system, messages, tools, stream, metadata, beta_headers }`，屏蔽 SDK 版本差异。

#### 6.3.4 流式响应

- SDK 解析 SSE 后分发的 block：`text`、`tool_use`、`input_json` 等。
- UI 必须等待每个增量更新，避免一次渲染整段。
- 中断：用户可中止请求；前端调用 SDK 的 `messages.abort()`。
- 重试：网络错误/5xx 自动重试一次；4xx 不重试，必须显式提示原因。
- Rate limit（HTTP 429）：读取 `Retry-After` 头并指数退避，连续 3 次失败转人工确认。

#### 6.3.5 Tool Use 流程

1. 工具以 Anthropic 工具 schema 注册到 Sirius（含名称、描述、JSON 输入 schema）。
2. 模型返回 `tool_use` block 时，CLI/Web/Desktop 都**不直接执行**。
3. 应用层路由到 `ToolRegistry`，由策略引擎鉴权（参考 §7）。
4. 执行结果以 `tool_result` block 形式回传，继续对话。
5. 工具结果版本化（结合 §6.4 的 chunk 引用），UI 显示来源与时间。

#### 6.3.6 出站控制（Claude 网关）

所有 Claude 调用必须经过 `AnthropicEgressClient`：

- 只允许 `https://api.anthropic.com`（或企业版端点，按官方平台公布）。
- 强制 HTTPS 与证书校验。
- 阻断 DNS rebinding、loopback 与非 vendor 域名。
- 请求级别记录：endpoint、model、msg 长度、tool 列表（名称）、`request_id`，**不**记录正文与 system 全文（仅哈希指纹）。
- 用户中止请求立即关闭 socket，丢弃未使用增量。

#### 6.3.7 失败与降级

| 场景 | 行为 |
|---|---|
| 401/403 | Keychain 中 key 失效，转人工重新输入；禁用 AI |
| 429 + `Retry-After` | 指数退避，最多 3 次 |
| Anthropic 服务异常（5xx） | 退避一次，UI 提示，可能回退到只读检索模式 |
| 流式中断 | 关闭连接 + 标记 session 状态 `partial`，提供"重新生成" |
| 超时（默认 30s/请求） | 取消 + Toast |
| 用户配额异常 | 显示官方账单/限额入口建议 |

### 6.4 对话消息结构

每条 AI 回答由应用层（不是模型）组装为：

- 回答正文。
- 引用列表：文件、字幕时间段、元数据字段或任务记录。
- 使用的上下文范围。
- 使用的模型与 SDK 版本。
- 工具调用记录（名称、参数摘要、结果摘要）。
- 可能的后续操作。

引用链接示例（应用层拼装，非 Claude 直接产出）：

```text
sirius://video/{itemId}?t=132.5
sirius://file/{fileId}
sirius://folder/{folderId}
sirius://task/{taskId}
```

### 6.5 RAG 与视频索引

索引分三层：

1. **元数据索引**：文件名、路径、标签、媒体信息、演员、年份和来源。
2. **全文索引**：字幕、文档、简介、OCR 和用户笔记。运行在 SQLite FTS5 或 Tantivy。
3. **向量索引**：字幕语义块、章节摘要和关键帧描述，**通过 Claude Embeddings API 或同类供应商嵌入模型生成**；不下载本地向量模型。

视频处理流水线：

```text
发现文件
→ 提取媒体信息
→ 读取内嵌/外挂字幕
→ 写入 SQLite/索引
→ 嵌入模型（按目录启用）
→ 提取关键帧（可选）与章节
→ 写入可追溯引用
```

推荐默认策略：

- 字幕优先，不重复转写已有字幕。
- 向量嵌入按目录/库显式启用，不默认对全库跑。
- 索引内容改变后进行增量重建。
- ASR 后续接入，供应商/本地可换；与嵌入、Claude 推理解耦。

### 6.6 模型与嵌入策略

- **Claude 主对话模型**：Sonnet（默认）。
- **嵌入模型**：供应商嵌入（Claude Embeddings API 或后续替代）。Keychain 单独条目 `sirius:embedding_provider`。
- **ASR**：首版不做；未来可选供应商 ASR 或独立二进制。
- **不使用本地大模型**，避免依赖 GPU、模型升级与分发；可显著减少安装包与冷启动时间。
- 单次请求成本展示：UI 显示本次估算 token 与用户配额告警。

### 6.7 AI 工具（首版）

首版只注册只读工具；任何写工具默认不存在，需在产品门通过后显式启用：

- `search_items` —— 跨库/字幕/文件名搜索。
- `read_item_metadata` —— 媒体详情。
- `read_subtitle_range` —— 按时间段读取字幕。
- `list_folder` —— 文件/文件夹列表。
- `get_playback_state` —— 当前播放进度。
- `get_transfer_status` —— 任务状态。

写工具延迟引入，并按 §7 权限维度确认。

---

## 7. AI 权限与安全（与 Claude API 协同）

### 7.1 权限维度

每个工具声明四个维度：

| 维度 | 取值 |
|---|---|
| 能力 | read、write、delete、execute、network |
| 范围 | currentItem、selectedItems、currentFolder、library、workspace、system |
| 确认 | silent、notify、confirmFirst、confirmEvery |
| 可逆性 | reversible、snapshotRequired、irreversible |

默认策略：

- 当前项读取：静默允许并记录。
- 文件夹或媒体库读取：通知或首次确认。
- 写操作：展示变更预览后确认（首版禁用写工具）。
- 删除、联网发送内容和执行命令：逐次确认（首版禁用）。
- 跨账号或跨数据源操作：逐次确认。

### 7.2 Claude 推理安全边界

确定性策略引擎是唯一授权来源，模型输出不能产生副作用：

1. 工具调用必经策略层（deny-by-default ABAC）鉴权后执行。
2. 资源 ID 解析后再鉴权，避免模型控制原始路径/命令。
3. 写操作的确认 UI 必须用应用层生成的真实差异，禁止模型生成摘要。
4. Claude 调用统一经过 `AnthropicEgressClient`，日志仅记录 endpoint、模型与指纹。
5. 切断用户 API Key 与模型对话的联系 — Keychain 中的 Key 不下发到前端。
6. MCP、插件、`execute_process` 首版均不启用。
7. 临时、动态 Beta 头需在策略层登记后才允许启用。

### 7.3 文件变更预览（首版禁用、未来启用）

AI 进行整理时必须先生成操作计划：

```text
将执行 18 项操作：
- 新建 2 个文件夹
- 重命名 8 个文件
- 移动 8 个文件
- 删除 0 个文件
```

用户可查看逐项差异、取消单项或全部操作。执行后生成事务记录，支持撤销可逆操作。

### 7.4 Prompt Injection 防护

- 文件和字幕内容永远作为引用数据，不作为系统指令。
- 检测内容中的工具调用诱导、密钥请求和越权指令。
- 工具执行前重新进行策略验证，不能只依赖模型首次选择。
- MCP 或插件（首版禁用）必须声明权限、版本和来源。
- 新安装工具默认处于只读影子模式。

### 7.5 隐私

- 默认零遥测。
- 对话、索引、字幕和关键帧默认仅本地保存。
- 调用 Claude 前显示发送的数据范围与 Claude 提供方。
- 支持为文件夹标记"禁止发送至云端"。
- 支持清除某个视频、媒体库或工作区的全部 AI 派生数据。
- 日志中的 Token、API Key、签名 URL 和 Cookie 必须脱敏。
- Anthropic 政策以官方公开的 AUP/数据策略为准；不假设任何超出官方文档之外的训练/保留承诺。

---

## 8. 数据模型

### 8.1 核心对象

```text
Account
  id, provider, displayName, authState, capabilities

DataSource
  id, accountId, type, root, capabilities

Item
  id, sourceId, remoteId, parentId, kind, name, path
  size, createdAt, modifiedAt, hash, favorite, labels

MediaEntity
  id, type, title, originalTitle, year, summary
  poster, backdrop, genres, people, rating

MediaVersion
  id, mediaEntityId, itemId, container, duration
  videoStreams, audioStreams, subtitleStreams, hdrType

PlaybackState
  mediaVersionId, position, duration, completed, updatedAt

Transcript
  id, mediaVersionId, language, source, status, segments

IndexChunk
  id, itemId, transcriptId, startTime, endTime
  text, embeddingId, sourceRevision

Conversation
  id, workspaceId, title, modelProvider, createdAt

Message
  id, conversationId, role, content, citations, toolCalls

Job
  id, type, state, priority, progress, checkpoint, error

FileTransaction
  id, actor, operations, state, reversible, createdAt
```

### 8.2 数据源能力

每个数据源必须声明 `capabilities`，避免 UI 假设所有来源都支持相同操作：

- list
- search
- stream
- download
- upload
- rename
- move
- trash
- restore
- permanentDelete
- thumbnail
- subtitle
- share

115、本地文件和 WebDAV 分别实现能力集合。UI 和 AI 工具根据能力动态启用。

---

## 9. 技术架构

### 9.1 推荐技术栈（macOS Tier 1）

主路径（macOS 首发）：

- **桌面壳**：Tauri 2.0+（Rust 后端 + WKWebView）。
- **前端**：React 19 + TypeScript，TanStack Router/Query + Zustand。
- **核心层**：Rust workspace，使用 Tokio 异步运行时。
- **播放器**：`libmpv` 通过 `mpv-rs` 或自定义 FFI 绑定；视频帧投递到原生 `CAMetalLayer` 或 `CALayer` 子层（macOS），实现全屏、画中画和独立窗口。
- **数据库**：SQLite（WAL）+ SQLite FTS5（字幕与文件名全文索引）。
- **向量索引**：LanceDB（可选），仅在用户启用向量检索并填写嵌入 Provider 后下载/连接。
- **AI 接入**：Anthropic Claude 官方 SDK（Rust crate 或 HTTP），仅通过 `AnthropicEgressClient` 出站。
- **密钥**：macOS Keychain（`security-framework` FFI）保存 115 Token、Claude API Key、嵌入 API Key。
- **后台任务**：Rust worker + SQLite 持久化队列，应用关闭后通过 launchd（macOS）拉起。
- **媒体分析**：`ffmpeg/ffprobe` 作为子进程/Sidecar，libavformat 解封装。
- **自动更新**：Tauri Updater + macOS 公证（DMG 与 PKG）。
- **打包公证**：Apple Developer ID、notarytool、`hardened-runtime`、公证票据。

Tier 2 后续平台差异：

- Windows：Tauri MSIX + signtool + SmartScreen；Keychain 换为 `windows-rs` Credential Manager；播放器换 DX11/Vulkan 子窗口。
- Linux：`webkit2gtk-4.1` + GTK/X11/Wayland；Keychain 换 Secret Service；播放器用 X11/Wayland 子窗口。

为什么选 Tauri：

1. 单一 Rust 工作区复用 StarVault 已验证的 115 协议逻辑。
2. Web 前端适合复杂三栏布局、虚拟列表、AI 流式消息。
3. 跨平台抽象后可在 Windows / Linux 复用业务层。
4. 相比 Electron 包体积与内存更低，原生模块扩展能力同样灵活。

### 9.2 模块划分

```text
apps/
  desktop/                 Tauri 与 React 桌面应用

crates/
  sirius-domain/           核心实体、能力、错误类型
  sirius-auth/             账号、Token 与系统密钥（macOS Keychain）
  sirius-provider-115/     115 开放平台实现
  sirius-provider-local/   本地文件系统实现
  sirius-provider-webdav/  WebDAV 实现（后续）
  sirius-media/            ffprobe、媒体版本与字幕
  sirius-player/           libmpv 播放会话（含 macOS Metal 子窗口）
  sirius-library/          媒体库、元数据和观看状态
  sirius-transfer/         上传、下载和复制任务
  sirius-index/            FTS、向量和增量索引
  sirius-ai/               Claude Provider、会话、引用、上下文快照
  sirius-tools/            AI 工具与权限策略
  sirius-jobs/             持久化任务调度
  sirius-storage/          SQLite migration 与 repository
  sirius-platform/         Keychain、媒体键、通知、窗口、原生菜单
```

### 9.3 分层原则

```text
UI（Tauri + React）
→ Application Use Cases（Rust）
→ Domain
→ Provider / Storage / Player / AI Infrastructure
```

约束：

- UI 不能直接调用 115 HTTP API 或 Claude API。
- AI 工具不能绕过 Application Use Case 直接修改数据库或文件。
- 所有文件写操作必须经过 `FileTransactionService`。
- 所有 Claude API 请求必须经过 `AnthropicEgressClient`。
- 播放器状态由单一 `PlaybackSession` 管理，多窗口仅订阅状态。
- 后台任务不能依赖 UI 进程中的临时状态。

### 9.4 115 Provider

115 Provider 应迁移 StarVault 已验证的协议行为：

- 独立的设备码、刷新和业务 API Client。
- Bearer Token 注入。
- 401 单次刷新与重试，使用 Mutex 防止并发刷新风暴。
- 业务请求限速。
- 签名下载 URL 的 TTL 缓存。
- 视频播放与字幕接口。
- 文件 CRUD、回收站和传输接口。
- 账号退出时撤销令牌并清除本地敏感数据。

不能把业务失败统一转成空列表。HTTP、业务码、解码错误和权限错误必须保留类型并向上暴露。

### 9.5 Claude Provider 与 AI 网关

```text
UI 工具调用（Sirius Tool Schema）
  ↓
ToolRegistry
  ├─ ABAC 策略引擎
  └─ 资源解析与鉴权
       ↓
AnthropicEgressClient
  ├─ 端点白名单
  ├─ Keychain 读取 API Key
  └─ Anthropic SDK / HTTP 调用
       ↓
官方平台
```

约束：

- 仅用官方 SDK 或直接 HTTPS POST，避免中间代理造成 key 泄漏。
- `AnthropicEgressClient` 是唯一可与 `api.anthropic.com` 通信的模块。
- 流式响应通过 `Tauri event` 推送 UI，不经 IPC payload 传整段正文。
- Beta 头与端点扩展需在策略层登记才能下发到 SDK。

### 9.6 播放架构

```text
PlaybackCoordinator
├─ SourceResolver
│  ├─ LocalSourceResolver
│  ├─ Cloud115SourceResolver
│  └─ WebDavSourceResolver
├─ CapabilityMatcher
├─ MpvSession（macOS 优先；Windows/Linux 后续）
├─ SubtitleManager
├─ PlaybackStateRepository
└─ PlatformMediaSession（macOS NowPlaying / MPRIS）
```

`SourceResolver` 返回带过期时间的播放源。播放中发生 401/403 时，仅在确认 URL 已过期后刷新播放源，并尽可能恢复到原时间码。

macOS 玩家具体能力：

- 通过 `wkwebview` overlay + 私有 Metal 子窗口嵌入 mpv 输出。
- 集成 macOS NowPlaying（`MPNowPlayingInfoCenter`），支持 Touch Bar 与系统媒体键。
- 全屏经 `NSWindow` 的 `setCollectionBehavior(.fullScreenPrimary)`。
- 多窗口：每个播放窗口订阅同一 `PlaybackSession`，owner 关闭时其余窗口自动暂停。

### 9.7 后台任务

任务状态：

```text
Queued → Running → Paused → Completed
                 ↘ Failed
                 ↘ Cancelled
```

任务必须保存：

- 输入参数。
- 当前 checkpoint。
- 已完成字节或索引分块。
- 重试次数。
- 错误类型和原始错误信息。
- 创建者：用户、系统或 AI。

错误策略：

- 网络超时可指数退避重试。
- 权限、磁盘满、文件锁定必须立即失败并通知。
- 取消任务必须终止子进程并清理临时文件。
- 不允许显示成功但实际只完成部分步骤。
- macOS 后台持久化通过 launchd agent 注册轻量保活；不允许使用浏览器标签页充当后台。

## 9.8 按钮与组件规范（克装饰 / 无彩边）

> 核心原则：**层级靠空间、字号、灰阶，不靠色块与边框**。强调色（accent）只在主操作、选中态指示、关键状态三处使用；其余全部使用中性 surface。

### 9.8.1 设计 token

颜色（深色 + 浅色双套，按 macOS 系统外观自动切换）：

| Token | Light | Dark | 用途 |
|---|---|---|---|
| `bg` | `#FAFAFA` | `#0E0E10` | 应用底色 |
| `surface` | `#FFFFFF` | `#161618` | 卡片、输入框、面板 |
| `surface-hover` | `#F2F2F4` | `#1E1E21` | 鼠标悬停 |
| `surface-active` | `#E8E8EC` | `#26262B` | 按下 / 选中 |
| `fg` | `#111114` | `#F2F2F4` | 主文字 |
| `fg-muted` | `#6B6B70` | `#9C9CA1` | 次要文字、标签 |
| `fg-disabled` | `#A8A8AD` | `#5A5A5E` | 禁用文字 |
| `border` | `#E5E5E8` | `#26262B` | 唯一允许的 1dp hairline；按需使用 |
| `accent` | `#2F6FEB` | `#7AA2F7` | 主操作、选中态、焦点环 |
| `accent-fg` | `#FFFFFF` | `#0B0B0F` | 主操作按钮前景 |
| `danger` | `#C5302A` | `#F08585` | 危险文字 / 图标 |
| `success` | `#16A34A` | `#65D184` | 成功状态 |
| `warn` | `#B58800` | `#E0B13A` | 警告 |

间距（Apple 8 阶梯，以 4dp 为底但保留 17dp signature 中阶）：

| Token | 值 | 用途 |
|---|---|---|
| `space-1` | 4dp | 图标与文字 |
| `space-2` | 8dp | 行内间距、按钮 padding-y |
| `space-3` | 12dp | 控件内边距、侧栏 gutter |
| `space-4` | **17dp** | **卡片间距、列表项垂直 padding** — Apple signature mid-step，借鉴 `voltagent/awesome-design-md · apple/DESIGN.md`；非 4dp 严格网格值，体现 macOS 节奏。 |
| `space-5` | 24dp | 侧栏 padding、面板内边距、group grid gap |
| `space-6` | 32dp | 区段分隔、顶栏水平 padding |
| `space-7` | 48dp | section 垂直 padding、文件组间距 |
| `space-8` | 80dp | hero / section bottom padding — Apple signature section 值 |

> **决策记录（2026-07-24）**：原 4dp 严格网格 `4/8/12/16/24` 升级为 Apple 8 阶梯，**新增 `space-4=17dp` 中阶 + `space-5/7/8` 三档**。17dp 是 Apple DESIGN.md 文档明确强调的"非网格 signature 节奏"，对桌面端紧凑工作台视觉收益高于网格严谨性。详见 §9.8.12。

圆角：

| Token | 值 | 用途 |
|---|---|---|
| `radius-sm` | 6dp | 输入框、小标签 |
| `radius-md` | 8dp | 按钮、卡片 |
| `radius-lg` | 12dp | 弹窗、底部抽屉 |
| `radius-pill` | 999dp | 状态徽章 |

字号（Vercel-inspired 13-step hierarchy，2026-07-24 迭代）：

| Token | Size | Weight | Line-height | Letter-spacing | 用途 |
|---|---|---|---|---|---|
| `text-display-xl` | 48px | 600 | 1.0 | -2.4px | Hero 标题（未来用） |
| `text-display-lg` | 32px | 600 | 1.25 | -1.28px | 二级 hero / section opener |
| `text-display-md` | 24px | 600 | 1.33 | -0.96px | 卡片簇标题 / pricing tier 名称 |
| `text-display-sm` | 20px | 600 | 1.4 | -0.6px | inline display micro |
| `text-body-lg` | 18px | 400 | 1.55 | 0 | section lead 段落 |
| `text-body-md` | 16px | 400 | 1.5 | 0 | 默认 body |
| `text-body-md-strong` | 16px | 500 | 1.5 | 0 | 强调 body |
| `text-body-sm` | 14px | 400 | 1.43 | -0.28px | 二级 body / nav 链接 |
| `text-body-sm-strong` | 14px | 500 | 1.43 | -0.28px | nav CTA / table emphasis |
| `text-caption` | 12px | 400 | 1.33 | 0 | footer / 角标 / meta |
| `text-caption-mono` | 12px | 400 | 1.33 | 0 | mono 眉标 / technical label |
| `text-code` | 13px | 400 | 1.55 | 0 | inline code / terminal / 时间码 |
| `text-button-md` | 14px | 500 | 1.43 | 0 | 小尺度按钮 |
| `text-button-lg` | 16px | 500 | 1.5 | 0 | marketing pill 按钮 |

**Typography discipline（Vercel-inspired，2026-07-24 迭代）**：

- **Display ceiling：600**。`font-weight` 不超过 600；需要更强烈请使用更大 size 或 accent 色。700+ 只在 display-mega（未来 64px+ hero）需要时例外使用。
- **Negative tracking on display**：48px 以 -2.4px 起递进，越大越负。
- **Sentence-case + period-terminated**（英文文案）：hero 与 section 标题以句点结尾（"Build and deploy on the AI Cloud."）作为品牌声音的一部分。中文标题不使用此习惯。
- **Mono for technical layer only**：`text-caption-mono` + `text-code` 仅用于技术性场景（时间码、版本号、文件大小、快捷键 caption mono label）。body 段落永远不用 mono。
- **Font weight ladder**：`--font-regular: 400` `--font-medium: 500` `--font-semibold: 600`。700 与 800 明确不适用。

**字体替换规范（Vercel 范本）**：

- Display/Body sans：`DM Sans, -apple-system, BlinkMacSystemFont, sans-serif`。在 macOS 上 DM Sans 与 SF Pro 视觉收敛（见 §9.8.12）。
- Monospace（未来需要时）：`ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", monospace`。Sirius 当前不用 mono。Cursor 与 Claude 使用 JetBrains Mono 是可选替代。

### 9.8.2 按钮变体

| 变体 | 背景 | 文字 | 边框 | 用途 |
|---|---|---|---|---|
| `primary` | `accent` | `accent-fg` | 无 | 主操作：保存、确认、播放、登录 |
| `secondary` | `surface` | `fg` | 无 | 次操作：取消、返回、稍后 |
| `ghost` | 透明 | `fg-muted` | 无 | 工具栏、轻量操作：复制、刷新 |
| `danger` | 透明 | `danger` | 无 | 删除、永久删除（**不**用红填） |
| `link` | 透明 | `accent` | 无 | 引用、跳转 |

按钮结构约束：

- 高度 32dp（小）、36dp（默认）、44dp（主操作）。
- padding-x 16dp；padding-y 8dp。
- 圆角 `radius-md`。
- 仅含图标时为 32×32dp 正方按钮。
- **不使用**渐变、阴影、彩色描边。
- 文字按钮（`ghost` / `link`）hover 仅变 `fg` 主色。

状态：

| 状态 | primary | secondary / ghost | danger |
|---|---|---|---|
| 默认 | `accent` 背景 | `surface` 或透明 | 透明 + danger 文字 |
| hover | `accent` brightness -4% | `surface-hover` | `surface-hover` |
| focus | 2dp accent 50% 焦点环 | 同左 | 同左 |
| active | `accent` brightness -8% | `surface-active` | `surface-active` |
| disabled | `fg-disabled` 背景、fg-muted 文字 | fg-disabled 文字 | fg-disabled 文字 |

### 9.8.3 侧栏按钮（左侧导航）

设计要点（macOS System Settings 风格，2026-07-24 迭代）：

> **修订说明**：原 "无背景、无描边、2dp accent 短竖条" 方案在视觉上产生三重蓝色叠加（accent 竖条 + accent 文字 + accent-soft 填充），气味偏“AI 生成”。修订为 macOS 系统设置风格：选中态 = 实色 accent 胶囊 + 白字 + 无任何边框 / 竖条。

- 默认：透明背景、文字 `fg-muted`、字重 500、`radius-md` 8px 圆角（保留轻圆角作为侧栏项的形状提示，但不作为“边框”）。
- hover：背景 `surface-hover`，文字升至 `fg`。
- active：背景 `accent` 实色填充，文字 `accent-on`（白），字重 600；**不**添加 border、**不**添加 box-shadow、**不**添加 `::before` 竖条。
- 折叠图标栏模式（56dp）：仅图标 + 同一选中规则；选中态仍为实色 accent 胶囊，不下沉到下划线。
- 侧栏品牌标记（`brand-mark`）：**不使用 border**；以 `accent-soft`（accent 10% alpha）填充作为方块背景，上叠 accent 色字母。避“AI 生成” logo 方块边框的味道。
- 侧栏角标（如传输计数）：默认中性灰背景 `#eef0f3` + `fg-muted` 文字；随激活项变为半透明白背景 + 白字。不使用 accent 色作为静态角标背景。
- 过渡：`background-color 80ms cubic-bezier(0.2, 0, 0, 1)`（与 §9.8.10 一致）。
- 组与组之间仅靠 12dp 间距区分，不使用水平分隔线。

### 9.8.4 Tab / 段控件

- Tab 文字下划线式：选中 Tab 文字变 `fg`，底部 2dp `accent`；未选中文字 `fg-muted`，无下划线。
- hover Tab：背景 `surface-hover`，文字仍 `fg-muted`。
- 段控件（Segmented Control）：单选胶囊；选中段填 `surface-active`，未选中透明；不使用彩边。

### 9.8.5 列表项 / 文件行

- 高度 44dp；左右 padding-x 16dp。
- 无边框、无卡片投影；hover 时整行 `surface-hover`。
- 多选态：行首出现 18dp 圆形 checkbox；选中后勾选图标 `accent`，行背景保持 `surface`。
- 副标题/元信息用 `text-meta` 与 `fg-muted`；不与主标题抢色。

### 9.8.6 主操作与表单

- 主按钮永远出现在表单底部右侧；**不**用占满整行的“块按钮”。
- 输入框：1dp `border` hairline（仅在此处允许），focus 时变 `accent`；无填充、无圆角夸张。
- 危险操作（删除、永久删除）只以文字 + 图标呈现，**不**填充红色背景。

### 9.8.7 顶部工具栏

- 顶栏 48dp 高，背景 `bg`，无底边线；分隔靠子元素间距。
- 工具按钮 32×32dp；hover `surface-hover`，按下 `surface-active`；图标使用 `fg-muted`，激活时 `fg`。
- ⌘K 全局搜索入口：以幽灵输入框呈现，无填色边框，仅 `border` hairline；focus 时变 `accent`。

### 9.8.8 角标 / 状态徽章

- 仅用文字 + 8dp padding-x；圆角 `radius-pill`；不显示彩色背景，仅 `fg-muted` 文字 + 1dp `border`。
- 重要状态（错误、未完成）：文字 `danger`；成功：`success`；警告：`warn`；其余 `fg-muted`。

### 9.8.9 焦点 / 键盘可达

- 全局焦点环 2dp，`accent` 50% 透明度，4dp 偏移。
- 焦点环对 mouse 永远不显示，仅键盘聚焦。
- 焦点环统一在 `Button` / `Input` / `ListItem` / `Tab` / `SidebarItem` / `Checkbox` / `Radio` 等组件根元素实现。

### 9.8.10 动效

- 颜色过渡 ≤ 80ms。
- hover / focus / press 使用 `cubic-bezier(0.2, 0, 0, 1)`。
- 不允许弹跳、缩放、模糊或视差动效。
- 全局尊重系统"减少动态效果"开关（macOS Reduce Motion）。

### 9.8.11 组件代码片段（参考实现，React + CSS 变量）

```tsx
// 统一按钮：变体通过 variant 决定，状态由 className 表达
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';

const buttonBase = css`
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 36px;
  padding: 0 var(--space-4);
  border: 0;
  border-radius: var(--radius-md);
  font-size: var(--text-body);
  font-weight: 500;
  transition: background-color 80ms cubic-bezier(0.2, 0, 0, 1);
  &:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent) 50%, transparent);
    outline-offset: 2px;
  }
`;

const buttonVariants: Record<ButtonVariant, CSSObject> = {
  primary:   css`background: var(--accent); color: var(--accent-fg); &:hover { filter: brightness(0.96); } &:active { filter: brightness(0.92); }`,
  secondary: css`background: var(--surface); color: var(--fg); &:hover { background: var(--surface-hover); } &:active { background: var(--surface-active); }`,
  ghost:     css`background: transparent; color: var(--fg-muted); &:hover { background: var(--surface-hover); color: var(--fg); } &:active { background: var(--surface-active); }`,
  danger:    css`background: transparent; color: var(--danger); &:hover { background: var(--surface-hover); } &:active { background: var(--surface-active); }`,
  link:      css`background: transparent; color: var(--accent); padding: 0; height: auto; &:hover { text-decoration: underline; }`,
};
```

```tsx
// 侧栏按钮：macOS System Settings 风格。无 border、无竖条。选中态 = 实色 accent 胶囊 + 白字。
const SidebarItem = ({ active, icon, label, badge }: SidebarItemProps) => (
  <button
    type="button"
    className={active ? 'sb-item sb-item--active' : 'sb-item'}
  >
    <span className="sb-item__icon">{icon}</span>
    <span className="sb-item__label">{label}</span>
    {badge != null && <span className="sb-item__badge">{badge}</span>}
    <style>{`
      .sb-item {
        display: flex; align-items: center; gap: var(--space-2);
        width: 100%; height: 36px;
        padding: 0 var(--space-3);
        border: 0; border-radius: var(--radius-md); background: transparent;
        color: var(--fg-muted); font-size: var(--text-body); font-weight: 500;
        transition: background-color 80ms cubic-bezier(0.2, 0, 0, 1), color 80ms cubic-bezier(0.2, 0, 0, 1);
      }
      .sb-item:hover { background: var(--surface-hover); color: var(--fg); }
      .sb-item--active { background: var(--accent); color: var(--accent-on); font-weight: 600; }
      .sb-item__badge { margin-left: auto; padding: 1px 7px; border-radius: 999px; background: #eef0f3; color: var(--fg-muted); font-size: 11px; font-weight: 500; }
      .sb-item--active .sb-item__badge { background: rgba(255,255,255,0.18); color: var(--accent-on); }
    `}</style>
  </button>
);
```

```tsx
// Tab：下划线式选中，无填色
const Tab = ({ active, label }: TabProps) => (
  <button type="button" className={active ? 'tab tab--active' : 'tab'}>{label}</button>
);
// .tab { color: var(--fg-muted); border-bottom: 2px solid transparent; }
// .tab:hover { color: var(--fg); background: var(--surface-hover); }
// .tab--active { color: var(--fg); border-bottom-color: var(--accent); }
```

### 9.8.12 Prototype 当前实现状态（2026-07-24 迭代）

本次迭代将 `voltagent/awesome-design-md` 的三份 DESIGN.md 引入 Sirius prototype。详细参考方法论见 `docs/design-review/awesome-design-md-comparison.md`（如未生成则参考 commit message 与对话记录）。

**采纳的 token 与规则**

1. **间距**：从 4dp 严格网格升级为 Apple 8 阶梯（见 §9.8.1 上方更新）。
2. **阴影哲学**（来自 `apple/DESIGN.md`）：**单一 shadow 留给产品媒体卡**。Floating panels（AI drawer、command palette）用 frosted surface，不用大阴影。已落实 `--shadow-product` / `--shadow-product-hover` / `--shadow-floating` 三档。
3. **Frosted surface**（来自 `apple/DESIGN.md`）：`backdrop-filter: saturate(180%) blur(20px)` + `rgba(255,255,255,0.82)`。AI drawer 与 command palette 已统一采用。`backdrop-filter` 必须配 `-webkit-backdrop-filter` 以覆盖 Safari ≤ 17。
4. **布局骨架**（来自 `linear.app/DESIGN.md`）：sidebar + content + 右侧抽屉 = 桌面生产力工具的范本。Sirius prototype 现有 sidebar（190px）+ content（minmax 760px, 1fr）+ AI 抽屉（350px, frosted fixed）与 Linear 范式一致。
5. **媒体卡几何**（参考 `spotify/DESIGN.md`）：采用 Spotify 6-8px 专辑封面风格作为参照，Sirius 落在 9px（介于 Apple 18 与 Spotify 6-8 之间，作为 Sirius 自己的签名值）。**不采用** Spotify 深色画布（与 Sirius 浅色基调冲突）。
6. **Command palette（来自 `raycast/DESIGN.md`）**：Sirius ⌘K 搜索面板按 Raycast command-palette 范本重制：
   - **Command-palette-row 布局**：`icon | label | keycap` 三段式，右侧 keycap 永远右对齐。
   - **Keycap 物理键感**：4px 圆角 + 1px hairline + 垂直 gradient (`--key-bg-start` `#fdfdfd` → `--key-bg-end` `#eef0f3`) + `inset 0 -1px 0 rgba(0,0,0,0.04)` 微阴影，height 20px。Raycast 是原产地。
   - **分组标签**：uppercase + 0.04em letter-spacing + `fg-muted`，为未来多组（Quick actions / Recent files / Search results）预留。
   - **Surface ladder 升阶**：`--surface-elevated: #ffffff` 是 Raycast 4 阶 surface ladder 中的一档，专门用于搜索输入框背景、keycap 背景。Hover tint 改为 `--accent-tint: rgba(36,88,215,0.06)` 而非纯蓝 fill（更克制）。
   - **不采用** Raycast 深色画布与单 white CTA（与 Sirius 浅色 + 蓝色 accent 不符）。
7. **响应式断点**：当前仅 1 处 `@media (max-width: 1250px)`（严重不足）。计划按 Linear 模式补全 440/640/834/1024/1068/1280/1440/1920 八档。
8. **可访问性**：`@media (prefers-reduced-motion: reduce)` 已加入 styles.css，屏蔽媒体卡 hover transform。
9. **AI panel 深化**（2026-07-24 迭代，来自 `cursor/DESIGN.md` + `claude/DESIGN.md`）：
   - **AI timeline pills**：Cursor 的 5 色（thinking/grep/read/edit/done）agent 阶段视觉体系。Sirius 简化为 4 阶段：思考 → 检索字幕 → 定位时间点 → 已引用 N 处。Timeline 颜色使用柔和透明背景（`rgba(...,0.18-0.20)`）加深色 ink，保克制、不饱和。
   - **Status indicator**：Claude 范本——在 AI panel 顶部加「AI 就绪 · Claude Sonnet」状态行 + 绿色点 + 3px glow halo。明确告诉用户当前 AI 后端是 Anthropic Claude（DESIGN.md §6 已选定供应商）。
   - **Source chip 升级**：从 `radius-sm` 7px 方块 → pill 风格 `radius-pill` 9999px + accent 软色背景，与 timeline pills 同一视觉语言。
   - **不采用**：Cursor 的暖橙 `#f54e00`（与 Sirius 蓝色冲突）；Claude 的珊瑚色 `#cc785c`（同上）；Claude 的 serif display（与 Sirius DM Sans 几何 sans 冲突）；Cursor 的 cream canvas（与 Sirius 冷调冲突）。

10. **Card 家族与 pastel tint 体系**（2026-07-24 迭代，来自 `notion/DESIGN.md`）：
    - **Card family**：补齐「base / feature / mockup / promo-banner」类。`card-base` = 白底 + 12px radius + 1px hairline + 24px padding；`card-feature` = base + 32px padding；`mockup-card` = base + `0 24px 48px -8px rgba(15,15,15,0.20)` 深阴影（未来嵌入产品 UI 截图）。Notion 同构原则：**8px 矩形按钮 + 12px 卡片圆角**，与 Sirius 现状一致。
    - **Pastel tint palette**：8 色 tint tokens（peach/rose/mint/lavender/sky/yellow/yellow-bold/cream/gray）已沉淀为 `--tint-*` + 9 个 `.card-tint-*` 类。**当前未渲染**——仅为未来媒体库详情页、设置页分组、AI panel deep mode 预留。Sirius 采用色系纪律：**最多同时使用 2-3 种 tint**，避免成为「AI 生成 pastel 派对」。
    - **不采用**：Notion Purple `#5645d4` 主色（与 Sirius 蓝色冲突）；Notion 8 色 pastel 全套（仅采用体系不用全套）；Notion Brand Navy `#0a1530` 深色 hero（与 Sirius 浅色调性冲突，除非未来 dark mode）；Notion-Sans 字体（已用 DM Sans）。

11. **Typography token 化**（2026-07-24 迭代，来自 `vercel/DESIGN.md`）：
    - **§9.8.1 字号 token 表升级**：从原来的 6-step（11/12/13/14/16/20）升级为 Vercel-inspired 13-step hierarchy（display-xl 48 → caption 12），含 size / weight / line-height / letter-spacing 四维。
    - **CSS 自定义属性沉淀**：`styles.css :root` 新增 `--text-display-xl` ... `--text-caption`（11 个 size token）、`--leading-*`（8 个 line-height ratio token）、`--tracking-display-*`（5 个 letter-spacing token）、`--font-regular/medium/semibold`（3 档 weight token，display ceiling 600）、`--font-sans` + `--font-mono`（font family token）。
    - **Typography discipline 原则**：display ceiling 600 / negative tracking on display / sentence-case + period-terminated（英文标题）/ mono 仅用于技术层 / font-weight 不超过 600。
    - **不采用**：Vercel 的 Black ink `#171717` 主色（与 Sirius 蓝色冲突）；Vercel 的 Mesh gradient hero 装饰（与 Sirius "克装饰" 哲学冲突）；Vercel 的 100px pill CTA（与 macOS system settings 8px 矩形风格冲突）；Vercel 的 Stacked shadow 体系（与 Apple "single shadow reserved for product imagery" 冲突）；Geist 字体（已用 DM Sans）。

12. **Cohere 浅色范式沉淀**（2026-07-24 迭代，来自 `cohere/DESIGN.md`，**聚焦浅色部分，dark mode 暂缓**）：
    - **Rule-separated list 范式**：沉淀 `.rule-list` / `.rule-list-item` / `.rule-list-title` / `.rule-list-meta` 四件套。**研究型列表 = 没有卡片边框，只有上下 hairline 分割**。适用于未来「媒体引用列表 / 传输任务列表 / 搜索结果」。这与当前 `.key-moments button` 的"卡片化"形成对比选择 —— 哪个更克制哪个就更好。
    - **Chip-large 范式**：沉淀 `.chip-large` + `.chip-large--active`。Cohere `blog-filter-chip` 范本 —— 14px-32px 中等字号 + 1.5px coral border + 14px 圆角 + active 状态 solid fill。Sirius `.pill-tab`（Superhuman 借鉴）仍作为默认 chip 范式；`chip-large` 是**专门用于 taxonomy hero 区**的更大版本（如未来「媒体库 / 全部 / 电影 / 剧集 / 动漫」分类筛选）。
    - **Button-link 范式**：沉淀 `.button-link` —— underline-only secondary button。配本规范实现「primary pill + secondary text-link」二元化按钮体系（当前 Sirius 只有 button-primary / pill-tab，缺 secondary link）。
    - **Surface-stone 暖中性 token**：新增 `--surface-stone: #eeece7`。介于 canvas（白）与 surface-hover（浅灰）之间的暖中性色，未来产品介绍 / 模型对比 / editorial sections 可用。
    - **Display weight 400 only 备选**：Cohere 全 display + body 都用 weight 400（vs Vercel ceiling 600）。Sirius 保留 Vercel 范式作为默认；Cohere 范式记录为「极致克制编辑性」备选，用于未来「媒体详情页 editorial hero」等场景。
    - **三字体分裂范本强化**：Cohere 的 CohereText（display）/ Unica77（body）/ CohereMono（technical）三分裂范本，与 Vercel 的 Geist + Geist Mono 一致。Sirius 当前 `--font-sans` + `--font-mono` 体系已对齐。
    - **不采用**：Cohere Black `#000000` / Near-black `#17171c` 主色（与 Sirius 蓝色冲突）；Deep green `#003c33` / Dark navy `#071829` **深色 band**（dark mode 范畴暂缓）；Coral `#ff7759` 作为主 CTA（仅作 taxonomy chip accent）；22px media card radius（与 Sirius 9px 签名值不同，但范式可借鉴）；CohereText / Unica77 / CohereMono 三种字体（已用 DM Sans）。

**借鉴来源分配规则**

| 维度 | 优先借鉴 |
|---|---|
| 视觉 / spacing / frosted / single shadow | `apple/DESIGN.md` |
| 布局骨架 / 多窗格 / surface ladder | `linear.app/DESIGN.md` |
| 媒体卡几何 / pill / 重 shadow（仅 dark mode） | `spotify/DESIGN.md` |
| ⌘K 命令面板 / keycap 物理键感 / command-palette-row | `raycast/DESIGN.md` |
| AI timeline pills / AI 工具类视觉 / 状态指示 | `cursor/DESIGN.md` |
| AI panel warm editorial / status indicator / callout | `claude/DESIGN.md` |
| pill-tab 过滤芯片 / ⌘⇧? cheatsheet 范本 | `superhuman/DESIGN.md` |
| card family / pastel tint palette / sober-editorial 调性 | `notion/DESIGN.md` |
| typography token 化 / font-weight ladder / mono for technical voice | `vercel/DESIGN.md` |
| **rule-separated list / chip-large / button-link / surface-stone** | **`cohere/DESIGN.md`** |
| 工作流（持久化设计决策、mock 即真理源） | `prototype/AGENTS.md` |

**禁止借鉴**

- Spotify / Linear / Raycast 的深色画布，除非 Sirius 显式上线 dark mode。
- Spotify 的全 pill 按钮（与桌面工作台定位不符）。
- Raycast 的「全页面白色 CTA」范本（Sirius 保持蓝色 accent）。
- Cursor 的暖橙 / Claude 的珊瑚 / Notion Purple / **Vercel 的 Black ink `#171717`** 作为 accent 色彩。
- Cursor 的 cream canvas（`#f7f7f4` 暖调）/ Claude 的 cream canvas（`#faf9f5` 暖调）—— Sirius 保持中性偏冷画布。
- Cursor / Claude 的 serif display（Copernicus/Tiempos）—— Sirius 保持 DM Sans 几何 sans。
- Superhuman 的 indigo navy `#1b1938` 主色 + deep teal `#0e3030` closing band（与 Sirius 浅色 + 蓝色调性冲突）。
- Superhuman 的「portrait 半身 hero」资产（这是 Superhuman marketing 专属资产，不适用于工具型 desktop app）。
- Superhuman 的 sub-default 字重（460/540/600）—— DM Sans 只提供 400/500/700 三档，实际不可能严格复现，仅借鉴其「warmth over bombast」理念。
- Notion 8 色 pastel 全套（仅采纳体系，不用全套；Sirius 色系纪律：同屏最多 2-3 种 tint）。
- Notion Brand Navy 深色 hero（与 Sirius 浅色调性冲突）。
- Vercel 的 Mesh gradient 装饰（multi-color atmospheric backdrop，与 Sirius 浅色 + 蓝色调性冲突）。
- Vercel 的 100px pill marketing CTA（与 macOS system settings 8px 矩形风格不符）。
- Vercel 的 Stacked shadow 体系（与 Apple "single shadow reserved for product imagery" 冲突；Sirius 阴影哲学：单一 shadow 留给产品媒体卡）。
- **Cohere 的 Near-black `#17171c` / Black `#000000` 主色**（与 Sirius 蓝色冲突）。
- **Cohere 的 Deep green `#003c33` / Dark navy `#071829` 深色 product band**（**dark mode 范畴，用户已明确暂缓**）。
- Cohere 的 Coral `#ff7759` 作为主 CTA 色（仅作 `.chip-large` taxonomy accent）。
- Cohere 的 22px media card radius（与 Sirius 9px 签名值不符，但 `.card-feature` 12px 可作更大媒体卡范本）。
- CohereText / Unica77 / CohereMono 字体（已用 DM Sans）。
- Cohere 的「display weight 400 only」作为主范式（仅作「极致克制编辑性」备选，主范式仍是 Vercel ceiling 600）。
- 任何饱和度高的第二色（accent 仅蓝色一档）。

**当前 prototype 文件清单**

- `prototype/src/styles.css`：已 token 化（间距、半径、阴影、frosted），AI panel 与 search modal 补全内部样式。
- `prototype/AGENTS.md`：增补 "Design tokens & decisions" 章节，记录 token 表与借鉴来源。
- `prototype/src/App.jsx`：本次未改动。

---

## 10. 桌面交互规范（macOS 优先）

### 10.1 快捷键

按功能分组。下表是 Sirius 完整快捷键谱；其中播放器与 AI 部分是未来主战场，prototype 当前仅覆盖「全局」与「AI」二组。

#### 全局（prototype 已实现）

| 操作 | macOS | 说明 |
|---|---|---|
| 全局搜索 | ⌘K | 打开命令面板（`search-overlay`） |
| AI 笔记面板 | ⌘⇧A | 切换右侧 AI 抽屉（`ai-panel`） |
| 退出命令面板 | Esc | 同 `onKeyDown` 监听 |
| 偏好设置 | ⌘, | 未来设置面板入口 |
| 退出应用 | ⌘Q | |

#### 导航（未来）

| 操作 | macOS | 说明 |
|---|---|---|
| 侧边栏首页 | ⌘1 | 与侧边栏顺序一致 |
| 侧边栏媒体库 | ⌘2 | |
| 侧边栏文件 | ⌘3 | |
| 侧边栏收藏 | ⌘4 | |
| 侧边栏传输 | ⌘5 | |
| 侧边栏回收站 | ⌘6 | |
| 后退 / 前进 | ⌘[ / ⌘] | |

#### 列表焦点（未来）

| 操作 | macOS | 说明 |
|---|---|---|
| 快速预览 | Space | 仅在列表焦点时 |
| 重命名 | Return | |
| 删除到回收站 | ⌘⌫ | |
| 永久删除 | ⌥⌘⌫ | |
| 多选 | ⇧↑ / ⇧↓ | |
| 打开选中 | ⏎ | |

#### 播放器（未来）

| 操作 | macOS | 说明 |
|---|---|---|
| 播放/暂停 | Space | 仅在播放器焦点时 |
| 快退/快进 | ← / → | |
| 进度 -1m / +1m | ⇧← / ⇧→ | |
| 音量 | ↑ / ↓ | |
| 全屏 | F | 退出走 Esc 或 ⌘. |
| 静音 | M | |
| 字幕 | S | |
| 音轨 | A | |
| 画中画 | P | `AVPictureInPictureController`，无边框、置顶、最小控制 |
| 播放信息 | I | |

#### AI 面板（未来）

| 操作 | macOS | 说明 |
|---|---|---|
| 发送问题 | ⌘⏎ | `ask-form` 输入框中 |
| 关闭 AI 面板 | Esc / ⌘⇧A | |
| 切换时间码引用 | T | 在 AI 回答中 |

文本输入获得焦点时，播放器单键快捷键必须停用，避免误操作；通过 `react-hotkeys-hook` 或自定义 focus router 实现统一路由。

macOS 设计要点：

- `commands / menus` 通过 `tauri::Menu` 在 Window 上挂载菜单项，绑定等价快捷键。
- 系统菜单（Apple/Sirius/文件/编辑/视图/窗口/帮助）按 Cocoa HIG 顺序排列。
- 速度调节（音/轨/字幕）走 macOS 偏好设置而非 Settings 路由，方便远程键控制。
- 视频全屏避免阻塞主菜单栏；退出全屏走 Esc 或 ⌘.。

### 10.4 快捷键提示 UI 规范（2026-07-24 迭代，Superhuman 借鉴）

macOS 桌面应用的键盘优先哲学要求 UI 中**可见地提示快捷键**，让用户建立"这个动作可以这样按"的肌肉记忆。参考 `design-md/superhuman/DESIGN.md` 的「快速预览提示」范式与 `design-md/raycast/DESIGN.md` 的 `keycap` 组件，三种显示位置：

1. **按钮 label 后 keycap**：如「重命名 <kbd>Return</kbd>」。Sirius prototype 已实现 `.keycap` class（4px radius + vertical gradient + inset shadow），见 §9.8.11 代码片段。
2. **命令面板三段式**：`.search-row` = `icon | label | keycap`，已落地在 prototype 的 `search-modal`。快捷键永远右对齐。
3. **面板 / 抽屉 footer 提示**：如 AI panel footer 加一行小字「⌘⇧? 查看全部快捷键」（未来 `cheatsheet` 面板的入口提示）。

keycap 视觉规范（与 §9.8.11 一致）：

| 属性 | 值 |
|---|---|
| radius | 4px（`--radius-xs`） |
| height | 20px |
| padding | 0 6px |
| font | 11px / 500 / DM Sans |
| background | `linear-gradient(180deg, #fdfdfd, #eef0f3)` |
| border | 1px solid `--key-border` |
| inset shadow | `inset 0 -1px 0 rgba(0,0,0,0.04)` |

复用规范：所有出现 macOS 快捷键的地方**必须**使用 `.keycap`，不得用纯文本（如 `Return`、`⌘ K` 字符）。

### 10.5 ⌘⇧? Cheatsheet 范本（2026-07-24，Superhuman 借鉴）

未来 `⌘⇧?` 唤出的快捷键参考面板范式（不在 prototype scope，作为规划）：

- 触发：`⌘⇧?` 全局快捷键，从任何界面唤出。
- 形式：frosted floating modal，与 `search-modal` 同源视觉（避免"另一个组件库"）。
- 内容：按 §10.1 分组渲染（全局 / 导航 / 列表 / 播放器 / AI），每行 = `action | keycap`。
- 可搜索：顶部 search input，键入时实时过滤快捷键。
- 可关闭：Esc 或点击背景。
- 复用：与 search-modal 共用 `.keycap` 样式，避免重复定义。

Prototype 当前占位：search-modal footer 已加 `Press ⌘⇧? for keyboard shortcuts` 提示行（用 `.keycap`），作为未来 cheatsheet 的“预告”。

### 10.2 多窗口

- 主窗口：浏览、文件和 AI。
- 播放窗口：可从主窗口分离。
- 画中画：`AVPictureInPictureController`，无边框、置顶、最小控制。
- AI 窗口：可分离，但上下文仍显示来源窗口。
- 任务中心：首版使用面板，后续可独立窗口。

窗口几何、显示器、全屏状态和侧栏宽度按工作区持久化，使用 `tauri::Window` 的状态接口写入 `~/Library/Application Support/Sirius/workspace.json`。

### 10.3 拖放

- 本地文件拖入媒体库：询问仅索引或复制到库目录。
- 文件拖入播放器：立即播放或加入队列。
- 文件拖入 AI：加入上下文，不自动上传内容。
- 115 文件拖到本地目录：创建下载任务。
- 本地文件拖到 115 目录：创建上传任务。
- 与 Finder 互拖：拖出生成 Finder 可识别的临时预览（视频截图或元数据 JSON）。

---

## 11. 错误与可观测性

### 11.1 错误分类

- AuthenticationError
- AuthorizationError
- RateLimitError
- NetworkError
- RemoteBusinessError
- DecodeError
- FileSystemError
- DiskFullError
- PlayerError
- ModelError
- PolicyDeniedError
- JobCancelledError

UI 必须显示可行动的信息：发生了什么、影响哪些项目、是否可重试、在哪里查看详情。

### 11.2 日志

- 结构化日志，支持按模块、任务和会话过滤。
- 默认本地保存，用户主动导出。
- Token、API Key、Cookie、签名 URL 和个人路径支持脱敏。
- AI 工具调用写入独立审计日志。
- 文件事务记录操作前后状态。

---

## 12. 分阶段路线图（macOS 优先）

### M0：macOS 技术验证（Tier 1）

- macOS 平台：Tauri + libmpv 嵌入（MPRIS/NowPlaying 集成验证）。
- macOS Keychain 接入 115 Token 与 Claude API Key。
- 115 扫码授权、文件列表、视频列表与签名 URL 连续播放。
- SQLite 持久化任务原型。
- Tauri 自动更新与 macOS 公证流水线（notarytool + DMG/PKG）。

退出标准：

- macOS 14+ 双架构（Apple Silicon + Intel）安装包可分发。
- 115 端到端：登录 → 浏览 → 播放 4K 视频 2 小时无 P0/P1 崩溃。
- Claude 流式问答跑通端到端：发送提示词，渲染 SSE 流式回复。
- 自动更新在测试环境通过回滚。

### M1：macOS 视频优先骨架

- macOS 主窗口、菜单栏、⌘K 全局搜索。
- 主页（继续观看、最近添加、收藏）。
- 媒体库与详情页。
- 播放器：音轨、字幕、章节、续播、全屏、PIP、NowPlaying。
- 文件列表、面包屑、空间键搜索、Finder 集成。
- 系统设置（Keychain 列表、文件源、播放、AI 模型切换）。

退出标准：

- 连续 7 天日活下登录至首次播放成功率 ≥ 99%。
- 视频续播误差 ≤ 5 秒。
- 关键键盘路径可无鼠标完成。
- 关闭应用后下载任务在 launchd 拉起后能恢复。

### M2：macOS 文件管理与传输

- 新建、重命名、移动、删除、回收站（115 + macOS Trash 兼容）。
- 下载：Range、原子写入、签名 URL 过期自动续。
- 上传：流式 SHA1、STS 续签、多账号 quota。
- 多选、拖拽、冲突处理、文件事务与撤销。
- 本地目录数据源。

退出标准：

- 10GB+ 文件断点续传链路可用。
- 删除 / 移动具备可审计的事务，撤销覆盖简单写场景。
- 与 Finder 互拖（拖入、拖出）通过 Gatekeeper。

### M3：macOS Claude 问答

- 集成 Claude 官方 SDK；写入 `AnthropicEgressClient` 与出站策略。
- 现有字幕 FTS 检索。
- 上下文快照、引用绑定 chunk/字幕版本/时间码。
- 只读工具集：search_items / read_item_metadata / read_subtitle_range / list_folder / get_playback_state / get_transfer_status。
- AI 面板 + 会话历史。

退出标准：

- 事实性回答具有引用或显式拒答。
- 引用跳转播放器时间码误差 ≤ 0.5s。
- Claude API Key 完全不进入日志/IPC/前端。
- 工具调用 ABAC 通过红队测试。

### M4：Claude AI 写操作与嵌入检索

- 嵌入 Provider（默认 Claude Embeddings API 或官方同类 API）。
- 向量索引（按库/目录显式启用）。
- 写工具：rename、move、create folder、favorite、enqueue_download。
- 变更预览、策略引擎、事务与撤销。

退出标准：

- 越权请求 100% 阻断并生成审计。
- 撤销覆盖全部已注册写工具。
- 嵌入与索引增量更新不阻塞 UI（>10k 文件场景下测试通过）。

### M5：跨平台与生态

- Windows Tier 2 预览（CodePath：MSIX、Credential Manager）。
- Linux Tier 2（按社区需求启动 X11/Wayland 验证）。
- WebDAV/SMB、双字幕、在线字幕、HDR 显示匹配、Shader。
- MCP 插件系统（首版不开放 `execute_process`）。
- 外部播放器、Watch Together 或局域网投屏（按用户反馈决定）。

---

## 13. 测试策略

### 13.1 单元测试

- 115 Token 刷新并发与单次重试。
- 限速器和签名 URL TTL。
- 数据源能力匹配。
- 文件事务与撤销。
- 播放进度合并。
- 字幕分块和引用时间码。
- AI 权限决策与工具参数校验。
- 敏感信息脱敏。

### 13.2 集成测试

- Mock 115 API 的登录、列表、播放、移动和回收站。
- libmpv 本地播放、HTTP 播放和 URL 过期恢复。
- 上传下载中断后的恢复。
- SQLite migration。
- 本地 ASR 与索引任务取消。
- 云模型出站策略阻断。

### 13.3 UI 与端到端测试

- 三个平台关键页面截图基线。
- 键盘导航和无鼠标操作。
- 大列表虚拟滚动。
- 多窗口与画中画。
- 文件拖放。
- AI 引用跳转播放器时间码。
- AI 文件变更预览、确认和撤销。

### 13.4 性能基线

- 10 万文件索引下启动时间和搜索延迟。
- 1 万媒体卡片的滚动性能。
- 4K HDR 播放时 UI 线程占用。
- ASR 与播放并发时的 CPU/GPU 限制。
- 任务恢复和数据库写入吞吐。

---

## 14. 风险清单

| 风险 | 等级 | 缓解措施 |
|---|---|---|
| 仅 macOS 受众局限 | 中 | 未来引入 Windows / Linux 预览 |
| Claude API 政策 / 可用地区变动 | 高 | `AnthropicEgressClient` 抽象、可切换 OpenAI-compatible 供应商 |
| Claude 模型 quota 与单价变动 | 中 | 任务分级（Haiku 处理简单任务）、UI 估算 token |
| macOS 公证失败 | 中 | `notarytool` 自动化流水线、监控未公证启动 |
| 115 API 频率限制与协议变化 | 高 | Provider 隔离、能力探测、限速、契约测试 |
| Keychain 损坏 / 权限丢失 | 中 | 重新输入提示、迁移到 DPAPI/Credential Manager |
| AI 批量误操作 | 高 | 默认只读、预览确认、事务与撤销 |
| Prompt Injection | 高 | 内容与指令隔离，工具执行前再次鉴权 |
| 云模型泄露私人内容 | 高 | 出站预览、目录级禁止策略、Keychain only |
| 嵌入 / 索引任务抢占播放 | 中 | 任务优先级、播放时降速、用户配额上限 |
| 文件跨源移动失败造成不一致 | 高 | Copy-verify-delete 事务，不进行假原子移动 |
| 签名 URL 过期中断播放 | 中 | 保存过期时间、刷新并恢复时间码 |
| 多窗口状态不一致 | 中 | 单一 PlaybackSession，窗口只订阅状态 |
| 插件供应链攻击（未来 MCP） | 高 | 签名、权限声明、版本锁定、默认影子模式 |

---

## 15. 关键产品决策（macOS + Claude 版）

1. macOS Tier 1 首发；Windows / Linux 后续预览。
2. AI 全部由供应商提供模型，**默认 Anthropic Claude**；不部署、不训练大模型。
3. 115 是首个远程数据源，本地目录是首个离线数据源。
4. 首版不依赖 Jellyfin 服务端；媒体库和观看状态由 Sirius 本地维护。
5. 播放器采用 libmpv，macOS 走 Metal 子窗口集成；播放会话与窗口解耦。
6. AI 首版只做当前视频 / 文件夹问答与只读工具；写工具在产品门通过后开放。
7. 所有 AI 回答必须提供文件或时间码引用。
8. AI API Key 仅入 Keychain，不进入 UI / IPC / 日志。
9. Tauri + Rust + React 是推荐实现；后续 Windows / Linux 通过统一抽象层增量引入。
10. 任何失败都必须显式暴露，禁止用空列表、默认值或假成功掩盖错误。

---

## 16. 调研来源

GitHub 项目：

- `tsukinaha/tsukimi`
- `jellyfin-archive/jellyfin-desktop-qt`
- `DonutWare/Fladder`
- `edde746/plezy`
- `FengZeng/soia`
- `iina/iina`
- `spacedriveapp/spacedrive`
- `Mintplex-Labs/anything-llm`
- `zylon-ai/private-gpt`
- `jellyfin/jellyfin`

官方文档：

- Anthropic Claude Platform / API / SDK（`https://docs.anthropic.com/`、`https://platform.claude.com/docs`，字段以当前平台版本为准）。

本地项目：

- `/Users/Gin/Workspace/StarVault`

调查时间：2026-07-23。
