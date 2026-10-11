# Sirius 进度表

按功能点记录实现与验证情况。每完成一个功能点并通过验证后追加一行。

验证命令约定：前端 `npm run build`；Rust `cargo check --manifest-path src-tauri/Cargo.toml`（改动 Rust 时追加 `cargo clippy` / `cargo test`）。UI 改动附手动验证说明。

## 已完成基线（2026-08-23 之前）

| 功能点 | 验证 | 说明 |
| --- | --- | --- |
| 115 认证（PKCE、扫码轮询、登出、账户状态、用户资料） | cargo test 23 项通过（2026-08-23） | `cloud115.rs`，StarVault 兼容身份 |
| 115 文件管理后端（列表/建目录/改名/移动/复制/删除进回收站/回收站还原与删除/小文件上传） | cargo test（2026-08-23） | `cloud115.rs`，前端尚无批量选择 UI |
| 播放源与字幕解析 | cargo test（2026-08-23） | `cloud115.rs` |
| libmpv 播放链路（专用 worker 线程、OpenGL 渲染） | cargo test 3 项（2026-08-23） | `playback.rs` |
| 本地媒体库（SQLite、扫描、任务、设置、进度） | cargo test 5 项（2026-08-23） | `library.rs` |
| 前端骨架（登录 Modal + 首页/媒体库/发现/网盘文件/媒体来源/整理任务/设置） | `npm run build` 通过（2026-09-01） | 旧信息架构，待重排 |

## 当前迭代：视觉改版（阶段 A）

| 功能点 | 状态 | 验证 | 日期 | 说明 |
| --- | --- | --- | --- | --- |
| Lucide 图标接入 | 已完成 | `npm run build` 通过（2026-09-01） | 2026-09-01 | `lucide-react` 1.39；Icon.tsx 改为统一包装层（1.7px 描边、尺寸与 aria 集中管理），删除全部手写 SVG；调用点 API 不变 |
| 排版与可访问性基线 | 已完成 | `npm run build` 通过（2026-09-01）；grep 确认全 CSS 无 <12px 字号 | 2026-09-01 | 字号 token 重定标（正文 14px、辅助 12px、区块 20px、展示 32px）；清除全部 8–11px 硬编码；常用点击目标提至 40px/34px/30px 三档；全局 `:focus-visible` 焦点环已存在，保留。登录区字号随专属首屏重做时保证基线 |
| 侧栏信息架构重排 | 已完成 | `npm run build` 通过（2026-09-01） | 2026-09-01 | 侧栏改为「工作区（网盘文件/媒体来源/整理任务）+ 内容（首页/媒体库/发现）」两组，文件置顶；App 启动首次确认账号状态后，已登录默认进入网盘文件分区，未登录留给登录首屏引导 |
| DESIGN.md 构图/材质/动效 token | 已完成 | 内容评审（本文档即 token 权威源） | 2026-09-01 | 新增 §11 原则 / §12 构图 / §13 材质 / §14 影像 / §15 动效 / §16 模式主题；描述行确立「表现力外壳 + 精确文件工作台」定位 |
| 登录专属首屏 | 已完成 | `npm run build` 通过；Vite 页面在浏览器实测渲染（截图）：双区构图/大字标/能力点/错误路径均正常 | 2026-09-01 | 新增 `LoginGate.tsx` 全屏非对称双区首屏（深色叙事舞台 + 浅色操作面板，26s/34s 缓慢漂移光斑，遵循 reduced-motion）；二维码授权流程自 Modal 迁入；`Cloud115AuthModal` 精简为已登录账号面板；未登录时整窗接管，不再覆盖虚化首页；`index.html` 标题改为 Sirius；附带修正：错误时状态文案不再停留在「正在生成」，加载指示器放大 |
| 占位资产替换 | 已完成 | `npm run build` 通过；备援海报 SVG 在浏览器实测渲染（截图）符合设计；卡片合成为绝对定位覆盖，登录后页面待下次应用内目检 | 2026-09-01 | 新增品牌备援海报 `assets/brand/poster-fallback.svg`（深色舞台+光场+影片符号，与登录首屏同母题）；PosterCard 删除字母 monogram/轨道圆圈/程序化渐变；发现页横幅改为固定深色舞台+备援影像；迷你播放条改用备援影像；演员首字母色块改为统一 user 图标（Icon 新增 `user` 名）。`posterTone/posterAccent` 字段保留，待 scraper 阶段改为 posterUrl |

## 阶段 C：AI 整理工作流

| 功能点 | 状态 | 验证 | 日期 | 说明 |
| --- | --- | --- | --- | --- |
| 只读分析链路（analyze → preview plan） | 已完成 | `cargo check/clippy(-D warnings)/fmt --check` 通过；`cargo test` 21 项离线测试通过（新增 3 项：计划绑定快照/围栏剥离/越权与非法项拒绝）；`npm run build` 通过；真实模型调用需登录 115 并配置服务商后人工验证 | 2026-09-02 | 新增 `ai.rs`：OpenAI 兼容 chat/completions 客户端（temperature 0 + JSON 输出），读取 115 目录快照（≤200 项）后生成整理计划；`parse_plan` 在 Rust 内逐项绑定快照并拒绝未知 fileId、重复引用、路径穿越名称与文件夹重命名/移动——模型输出只是建议数据，永不直接成为命令；API 密钥只存 macOS 钥匙串（开发构建 0600 临时文件），`ai_provider` 表新迁移幂等且不覆盖用户数据；前端新增「AI 整理」工作区入口：服务商配置（密钥留空保持现有值）、目录选择、计划预览表（保持/重命名/移动 + 理由），页面明确标注不执行任何修改 |
| 执行链路（confirm → deterministic execution → report） | 已完成 | `cargo check/clippy(-D warnings)/fmt --check` 通过；`cargo test` 23 项离线测试通过（新增 2 项：执行策略的作用域/名称/绑定校验、缺确认或空项在任何网络调用前拒绝）；`npm run build` 通过；真实执行需登录 115 后人工验证（建议先用测试目录） | 2026-09-02 | Rust 策略引擎 `execute_plan`：confirmed 不为 true 直接拒绝；执行前重新读取目录快照并逐项重新绑定（文件必须仍在原目录且文件名与分析计划一致）；重命名/移动/删除策略全部在 Rust 内强制执行（`policy_rename/policy_move_target/policy_delete`：仅文件、名称净化、目录内重名拒绝）；移动目标在快照内解析、缺失时创建并复用（本轮去重）；删除调用 115 删除接口走回收站语义；写操作间 400ms 间隔适配限速；生成结果报告（执行/跳过/失败/入回收站/新建文件夹计数 + 逐项明细）。分析 prompt 新增 delete 动作（仅限明显损坏/重复文件）。前端：计划项逐项勾选（重命名/移动默认勾选、删除默认不勾选）、执行前二次确认对话框、执行报告面板 |

## 阶段 D：漫画模式

| 功能点 | 状态 | 验证 | 日期 | 说明 |
| --- | --- | --- | --- | --- |
| 漫画识别与分组 | 已完成 | `cargo check/clippy(-D warnings)/fmt --check` 通过；`cargo test` 25 项离线测试通过（新增 2 项：卷号标记剥离、分类与分组）；`npm run build` 通过；真实识别需登录 115 后人工验证 | 2026-09-02 | 新增 `comics.rs`：`comics_recognize` 只读识别一个 115 目录（单次 ≤200 项，手动触发，不建自动索引）；cbz/zip/cbr/rar/7z 压缩包按系列名分组（解析器剥离尾部括号组与第N卷/话、Vol.N、纯数字/vN 标记，8 轮收敛，全剥空回退原名），顶层松散图片与其他文件只计数；BTreeMap 保证输出稳定；前端「漫画」内容模式入口（书脊卡片风格，点击展开卷列表），阅读器、阅读进度与缩略图缓存留待后续功能点 |
| 漫画阅读器与阅读进度 | 已完成 | `cargo check/clippy(-D warnings)/fmt --check` 通过；`cargo test` 27 项离线测试通过（新增 2 项：页图自然排序 page2 < page10、缓存预算按最近使用淘汰且保留当前卷）；`npm run build` 通过；真实阅读需登录 115 后人工验证（打开 cbz 卷 → 翻页 → 关闭重开验证续读） | 2026-09-02 | 阅读链路：`comics_open_volume` 断点续传下载压缩包到有界缓存（app cache/comics/<fileId>/，命中跳过下载）→ zip 解压（跳过 __MACOSX/隐藏文件，自然排序输出零填充页名，pages 目录命中直接复用）→ 返回页路径与续读页码；缓存预算 2 GiB，按 lastopen 标记从旧到新淘汰且永不淘汰当前卷；`comics_read_progress` 新迁移表（幂等），进度只存本机 SQLite；tauri.conf 启用 assetProtocol（scope $CACHE/**）并放行 asset: 图片 CSP；前端阅读器：全屏深色沉浸（页图 convertFileSrc 渲染、上一页/下一页/键盘方向键、Esc 关闭、页码指示），翻页与关闭时保存进度，保存失败显式提示不阻断阅读；仅 cbz/zip 卷提供「阅读」按钮，其他格式明确标注暂不支持 |
| 封面缩略图与批量索引 | 已完成 | `cargo check/clippy(-D warnings)/fmt --check` 通过；`cargo test` 28 项离线测试通过（新增 1 项：封面从 800×600 首页缩放到 ≤320 并幂等复用）；`npm run build` 通过；真实批量索引需登录 115 后人工验证 | 2026-09-02 | 封面：`open_volume` 解压后取第一页生成有界缩略图（image crate，最长边 320px JPEG，解码失败回退复制原图，幂等复用），封面与页图同住卷目录、同受 2 GiB 预算淘汰；索引：新迁移表 `comics_index`（folder_id 主键，payload 为识别结果 JSON，幂等覆盖），仓储层把索引裁剪到最近 50 个目录；`comics_recognize` 识别后即持久化并按本机缓存补齐封面路径；`comics_index_folders` 批量索引（单次上限 20 个目录、顺序执行 + 400ms 限速间隔，超限显式拒绝）；`comics_index` 把全部索引按系列名合并为统一书架（BTreeMap 稳定排序）；前端：书架从持久化索引加载（重启即恢复），系列卡片显示封面缩略图（无封面回退书脊渐变），新增「批量索引根目录」按钮 |

## 阶段 B：115 文件工作台收尾

| 功能点 | 状态 | 验证 | 日期 | 说明 |
| --- | --- | --- | --- | --- |
| 批量选择与批量操作栏 | 已完成 | `npm run build` 通过（2026-09-01）；远程移动/复制/删除流程需登录 115 后按以下步骤人工验证：多选 → 移动/复制到目标目录 → 列表刷新；删除进回收站后可在 115 回收站还原 | 2026-09-01 | 表格新增选择列 + 全选；选中后显示批量操作栏（移动/复制/删除/取消）；新增目标文件夹选择对话框（面包屑 + 逐级浏览）；删除对话框泛化为单项/批量共用；目录切换自动清空选择；非法目标与同名冲突由 Rust 策略校验 |
| 上传 UI 与断点恢复 | 已完成 | `npm run build` 通过（2026-09-01）；实际上传需登录后人工验证 | 2026-09-01 | Rust multipart 链路已存在（>20MiB 分片、会话持久化、SHA1 校验恢复）；本次补齐前端：工具栏上传按钮（顺序上传，规避 115 限速）、失败逐文件报错、未完成会话横幅（恢复/忽略）；上传大小上限由流式改造移除（见「流式分片上传」行） |
| Range 断点续传下载 | 已完成 | `cargo check/clippy(-D warnings)/fmt --check` 通过；`cargo test` 15 项离线测试通过（新增路径穿越校验测试）；`npm run build` 通过；真实下载需登录后人工验证 | 2026-09-01 | Rust 新增 `cloud115_download_file`：独立下载客户端（无总超时，分片 60s 停滞检测）、`.sirius-part` 临时文件按 Range 续传、401/403 重取直链一次、预期大小校验、磁盘满等显式错误、成功后原子 rename；远端文件名拒绝路径穿越；前端文件菜单新增「下载」（目录选择器 + 续传完成提示） |
| 流式分片上传（移除 64 MiB 上限） | 已完成 | `cargo check/clippy(-D warnings)/fmt --check` 通过；`cargo test` 18 项离线测试通过（新增 3 项：分块读取精确窗口与越界拒绝、流式 SHA1 与内存一致、空文件拒绝）；`npm run build` 通过；真实大文件上传需登录后人工验证 | 2026-09-01 | 上传链路改为磁盘流式：新增 `read_file_range`（按偏移精确读取分块）与 `compute_upload_digests`（单次扫描同时得整文件 SHA1 + 首 128KiB preid）；multipart 与恢复循环改为按偏移读 20MiB 分块，不再整读内存；统一入口 `upload_file_from_disk`（≤20MiB 单对象 PUT / 更大文件 multipart 并持久化会话，sign_check 校验区间按需读盘）；`resume_upload_session` 去内存化；命令更名 `cloud115_upload_file`、前端服务方法同步更名；两个在线 multipart 测试适配新签名（测试 1 改为 2×20MiB+1 强制 3 分片） |

## 阶段 E：相册模式

| 功能点 | 状态 | 验证 | 日期 | 说明 |
| --- | --- | --- | --- | --- |
| 只读照片索引与时间线分组 | 已完成 | `cargo check/clippy(-D warnings)/fmt --check` 通过；`cargo test` 31 项离线测试通过（新增 3 项：UTC 月份键换算含闰年/月边界、时间线分组与跳过计数、跨目录按 file_id 去重合并）；`npm run build` 通过；真实识别需登录 115 后人工验证 | 2026-09-05 | 新增 `albums.rs`：`albums_recognize` 只读识别一个 115 目录（单次 ≤200 项，手动触发，不建自动索引），图片按 UTC 月份聚合为时间线（civil_from_days 历法换算，月份从新到旧、月内按时间倒序），其他文件只计数；新迁移表 `albums_index`（幂等，50 目录上限）持久化识别快照；`albums_index_folders` 批量索引（单次上限 20 个目录 + 400ms 限速间隔）；`albums_index` 跨目录合并统一时间线并按 file_id 去重；前端「相册」内容模式入口：月份分组时间线列表（本地时区标签、日期、大小），预览图与专辑整理留待后续功能点 |
| 缩略图与专辑分组 | 已完成 | `cargo check/clippy(-D warnings)/fmt --check` 通过；`cargo test` 32 项离线测试通过（新增 2 项：115 条目缩略图字段解析、专辑封面选取与目录名回退）；`npm run build` 通过；真实缩略图展示需登录 115 后人工验证 | 2026-09-05 | 缩略图复用 provider 元数据：`Cloud115FileEntry` 新增 `thumb_url`（解析新旧列表与搜索响应的 thumb_url/thumb 字段，缺失为 None），照片索引透传到时间线行与专辑封面（img referrerPolicy no-referrer + lazy，CSP 已放行 https 图片）；专辑分组：`PhotosOverview` 携带目录名（前端目录列表提供，仅作展示元数据），`build_albums` 按目录聚合专辑、封面取最新一张有缩略图的照片、目录名缺失回退目录 ID；前端相册页新增「时间线 / 专辑」切换与专辑卡片网格，点选专辑过滤时间线 |
| 预览大图与专辑整理 | 已完成 | `cargo check/clippy(-D warnings)/fmt --check` 通过；`cargo test` 33 项离线测试通过（新增 1 项：相册索引持久化/幂等覆盖/按目录移除）；`npm run build` 通过；预览与整理需登录 115 后人工验证 | 2026-09-05 | 预览大图：点选时间线照片行打开全屏预览（上一张/下一张/方向键/Esc），先显示服务端缩略图、后台解析 download_source 原图直链并渐进切换，直链加载失败回退缩略图并显式提示；专辑整理（选中专辑后出现在操作栏）：重命名（115 目录改名 + 重新识别刷新索引）、移入回收站（115 回收站语义 + 本机索引移除，可还原）、仅移除本机索引（不动远程）；`delete_albums_index` 新仓储方法 + `albums_remove_index` 命令；顺带修复 comics/albums 索引 UPSERT 引用不存在列与 INSERT 值列数不匹配的 SQL 错误（新增索引持久化测试首次执行真实 SQL 时暴露） |
| 相册真实账号验证与 BFS 下探扫描 | 已完成 | 真实账号测试：根目录快照确认连接；「手机相册」单层扫描发现 0 张照片（照片嵌套在 手机相册/V2417A/{X,twitter01,twitter02,涩图}）——真实账号测试暴露真实缺口；实现 BFS 下探后同一目录识别出 **805 项 / 800 张真实照片 / 3 个月份分组**（全部带服务端缩略图），13.3s 完成；历史测试残留目录已移入回收站清理；`cargo check/clippy(-D warnings)/fmt --check` 通过、36 项离线测试通过、`npm run build` 通过 | 2026-09-06 | 相册识别从单层改为 BFS 带预算下探：总请求预算 12 次、每层最多 8 个文件夹、命中照片层即停（更深层视为应用私有结构）；与每层 200 项上限共同构成大目录性能边界；适配手机备份的「相册/设备/分类」多层结构；UI 文案同步说明下探行为；临时诊断测试（根目录快照/真实扫描/残留清理）用后即删，未留测试债务 |

## 阶段 F：媒体刮削与长播放加固

| 功能点 | 状态 | 验证 | 日期 | 说明 |
| --- | --- | --- | --- | --- |
| 媒体信息刮削与持久化链路 | 已完成 | `cargo check/clippy(-D warnings)/fmt --check` 通过；`cargo test` 35 项离线测试通过（新增 2 项：媒体信息持久化/覆盖/空标识拒绝、115 元数据到媒体信息的映射含无效时长）；`npm run build` 通过；115 真实刮削与本地探测需登录/本地文件后人工验证 | 2026-09-05 | 新迁移表 `media_info`（provider+file_id 主键，时长/分辨率/编码可空字段，幂等 UPSERT）；`media_info.rs` 两条链路：115 侧 `media_scrape_115` 读取 OpenAPI 文件元数据的时长并持久化（目录与无效时长显式排除），本地侧 `media_probe_local` 用无渲染 libmpv 实例（vo=null/ao=null，独立线程）加载文件并轮询 duration 就绪（15s 超时），读取时长/分辨率/视频编码/音频编码，不持久化；`media_info_get` 查询命令；纯映射函数带单测；前端网盘文件视频菜单新增「媒体信息」，格式化展示时长/分辨率/编码 |
| 远程播放 URL 过期自动恢复 | 已完成 | `cargo check/clippy(-D warnings)/fmt --check` 通过；`cargo test` 36 项离线测试通过（新增 1 项：恢复策略仅限远程会话且受重试上限约束）；`npm run build` 通过；真实过期恢复需登录 115 后人工验证（播放中等待 HLS 过期观察是否自动续播） | 2026-09-05 | 渲染线程轮询 libmpv 事件：远程会话收到 EndFile(Error)（URL 过期/流中断）时——记录最后已知 time-pos → 通过注入的恢复解析器（lib.rs 用 Cloud115Provider 构造，block_on 重解析 playback_source）重新下载签名 URL → loadfile 替换 + seek 回时间码；重试上限 3 次，超过或恢复失败把错误写入 PlaybackSnapshot.error 呈报前端，恢复成功即清除；本地文件不适用该策略；`open_remote_url` 强制要求 pick_code（不再接受不可恢复的远程会话）；前端快照轮询把播放器错误显示为横幅，且只清除播放器自己设置的那条 |
| Token 刷新审查与控制面限速 | 已完成 | 审查 + 补齐：`cargo check/clippy(-D warnings)/fmt --check` 通过；`cargo test` 36 项离线测试通过；`npm run build` 通过；限速行为需登录后通过批量操作人工观察 | 2026-09-05 | 审查结论：Token 刷新已满足 7 月审查要求——`refresh_lock` AsyncMutex + 过期前置检查与获锁后双重检查（防并发刷新风暴）、业务码 99/401* 与 HTTP 401 触发刷新、单次重试防递归（重试响应不再进入刷新逻辑）、HTTP 状态先于响应体解析（不消费原流）。补齐缺口：控制面限速——`pace_control_request` 在每次 OpenAPI 请求（含刷新后的重试）前持锁补足 1 秒间隔，把并发请求串行成匀速队列；下载与 OSS 上传数据流明确不受此限速约束（分桶原则）。多账号独立限速留待多账号支持时实施 |
| SBOM 与打包链路本地核验 | 已完成 | `node scripts/generate-sbom.mjs` 生成 docs/sbom.spdx.json（SPDX 2.3）与 docs/licenses.md：510 个依赖（Rust 499 + npm 11）全部有许可证记录，项目自身已按用户决策采用 **MIT**（LICENSE 文件 + Cargo.toml/package.json license 字段 + SBOM 重生成，0 个 NOASSERTION）；`npm run tauri build -- --debug` 打包成功（Sirius.app + dmg）；otool 扫描主二进制 + 48 个 dylib 无任何 /opt/homebrew 或 /usr/local 引用（PASS）；LC_RPATH 全部为 @executable_path/@loader_path 相对路径；dylib 为 adhoc 签名（debug 预期）；实际启动 .app 存活验证通过（PASS） | 2026-09-05 | SBOM：新增 `scripts/generate-sbom.mjs`（Cargo.lock + registry/crate 清单 + crates.io 回退 + node_modules），产物随仓库保留；打包核验：mpv/FFmpeg 全部 48 个 dylib 由 build.rs 重写后正确落入 Contents/Frameworks，主二进制经 @rpath 引用；许可分布以 MIT/Apache-2.0 双许可为主（兼容分发），MPL-2.0 为文件级 copyleft 同样可分发 |
| 签名与公证自动化 | 已完成（待凭据执行） | 脚本语法校验（bash -n / plutil lint）通过；以 ad-hoc 身份冒烟测试：48 个 dylib + 应用包完成签名，`codesign --verify --strict` 确认 satisfies Designated Requirement；公证分支在无凭据时按设计跳过 | 2026-09-05 | 新增 `scripts/sign-and-notarize.sh`（dylib 逐个签名 → 应用包 Hardened Runtime + entitlements 签名 → notarytool 提交并等待 → stapler 装订 → 校验）与 `src-tauri/entitlements.plist`（allow-jit 供 WKWebView、network.client）。用户已选择 App Store Connect API Key 路线；凭据只经环境变量注入（`APPLE_API_KEY_PATH`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER`），脚本不保存秘密。**执行方式**：release 包已预构建并核验，用户本机导出三个变量后直接运行 `./scripts/sign-and-notarize.sh src-tauri/target/release/bundle/macos/Sirius.app` |
| Release 包预构建与核验 | 已完成 | release 构建（Sirius.app + dmg）成功；otool 扫描 49 个二进制无 /opt/homebrew 或 /usr/local 引用（PASS）；LC_RPATH 全部相对路径；实际启动 release 应用存活验证通过（PASS） | 2026-09-05 | 为签名步骤预置已核验的 release 产物：`src-tauri/target/release/bundle/macos/Sirius.app` 与 `bundle/dmg/Sirius_0.1.0_aarch64.dmg`，用户签名时无需重新构建 |
| 第三方许可材料随包分发 | 已完成 | `generate-sbom.mjs` 扩展生成 `src-tauri/THIRD-PARTY-LICENSES.md`（16 种许可证全文 + 510 个依赖逐包对照，SPDX 官方文本源，缓存至 scripts/.spdx-texts.json）；tauri.conf 新增 bundle resources 后重建 release，确认文件落入 `Contents/Resources/`；重建后复验：无 Homebrew 引用（PASS）+ 启动存活（PASS） | 2026-09-05 | 满足 AGENTS.md 第 9 节 "third-party license materials" 分发要求：涉及许可证 0BSD/Apache-2.0/BSL-1.0/CC0-1.0/CDLA-Permissive-2.0/ISC/LGPL-2.1(-or-later)/MIT/MIT-0/MPL-2.0/Unicode-3.0/Unlicense/Zlib/LLVM-exception；解析器支持 OR/AND/WITH 及旧式斜杠表达式；不可分发风险项（GPL 系）未出现 |
| 编辑式壳层与微交互升级 | 已完成 | `npm run build` 通过；mock 模式（`?e2e-mock=1`）浏览器截图走查：网盘文件/漫画/相册/AI 四屏对比确认生效；emoji 扫描零命中（Lucide-only 规则持续满足） | 2026-09-06 | 纯 CSS 零逻辑变更：内容模式页头（品牌色短线 + clamp 26–34px 编辑式标题）；分区切换 view-enter 弹簧动效；对话框/操作条入场动效同源；文件行悬停左缘强调条生长（数据区零位移）；AI 计划行重命名/移动/删除语义色左缘条；品牌渐变芯片；侧栏活动指示条弹簧滑入；按钮按压回弹 + 主操作光影层次；漫画/相册卡片悬停浮起。新增 `src/dev-mock.ts` UI 冒烟测试基建（`?e2e-mock=1` 时模拟 Tauri IPC，打包不含真实数据）；修复登录身份选择菜单溢出 |

## 2026-10-11 界面优化第一批：先决修复

| 功能点 | 状态 | 验证 | 日期 | 说明 |
| --- | --- | --- | --- | --- |
| 文件页选择集口径修正 | 已完成 | `npm run build` 通过（2026-10-11）；人工验证见 manual-verification 第 1 组 | 2026-10-11 | 搜索词或类型筛选变化时同步清空选择（先于 250ms 防抖拉取）；批量移动/复制/删除统一以 entries ∩ selectedIds（selectedEntries memo）为口径，交集为空时禁用批量按钮 |
| AI 执行报告计数补齐 | 已完成 | `cargo fmt/clippy(-D warnings)/test` 通过（41 项离线测试，新增 5 项）；`npm run build` 通过 | 2026-10-11 | execute_plan 全部失败路径（策略拒绝/目标准备/provider 调用）累计 report.failed，循环后 debug_assert 保证明细与汇总一致；同批修复 created_folders 恒为 0；新增 ExecutionProvider trait seam 支持离线测试（公开命令签名不变） |
| 相册专辑筛选与大图竞态修复 | 已完成 | `npm run build` 通过（2026-10-11）；人工验证见 manual-verification 第 6 组 | 2026-10-11 | visibleMonths 按 albumFilter 逐张过滤（月份渲染/计数/预览源统一消费，空月份剔除）；原图请求改 requestSeqRef 序号守卫替换恒真的 fileId 比对，翻页同样推进序号 |
| 媒体假展示清理 | 已完成 | `npm run build` 通过（2026-10-11）；grep 确认 0.04/「第 3 集」/DETAIL_STILLS 于 src/ 零残留 | 2026-10-11 | 无真实观看记录不渲染「最近观看」；进度条用真实 progress 且 0 时不渲染；数据层无集数字段，副标题只展示作品名；详情 hero 缺图回退品牌备援 poster-fallback.svg（DESIGN.md §14） |

## 2026-10-11 界面优化第二批：基础设施

| 功能点 | 状态 | 验证 | 日期 | 说明 |
| --- | --- | --- | --- | --- |
| 传输进度事件通道 | 已完成 | `cargo fmt/clippy(-D warnings)/test` 通过（51 项离线测试，transfer 模块新增 9 项）；`npm run build` 通过；浏览器/真机验证见 manual-verification 第 2、3 组 | 2026-10-11 | 新增 `transfer.rs`：`transfer://progress` 事件（preparing/transferring/finalizing/done/failed，camelCase 契约）；上传分片级进度、末片后「正在确认文件」、下载 200ms/1MiB 限频带速度；前端 `events.ts` + `useTransferEvents` 单例 store，云盘视图按阶段展示 |
| 设计 token 与玻璃基座 | 已完成 | `npm run build` 通过；grep 确认 #858b94/95/858C9B 归零；浅色/暗色基准截图 `docs/screenshots/wave-f-checkpoint-*.png` | 2026-10-11 | Shell.css `:root` 唯一 token 区（颜色/间距/圆角/阴影/动效/玻璃），App.css/Workbench.css 全量消费；muted #666e7d（白底 5.13:1）；`.glass-panel` 玻璃只给顶栏/侧栏/对话框/批量栏/播放条五个固定层并带 reduced-transparency 回退；`:root[data-theme="dark"]` 暗色全量 token；`.cloud-file-pane` 容器查询基座（不能挂 .app-content：contain 会破坏 fixed 后代定位，已注释说明） |
| 浏览器冒烟夹具扩展 | 已完成 | `npm run build` 通过；Node 测试台 22 项断言通过；53/53 服务命令全覆盖 | 2026-10-11 | dev-mock 升级为有状态内存文件系统（移动/复制/删除/建目录/回收站真实变更列表）、复刻 Tauri v2 事件投递路径模拟 `transfer://progress`、上传预置中断会话、`?theme=dark` 暗色预览、未覆盖命令 console.warn |

## 后续阶段

产品定位为**仅个人使用**（用户 2026-09-05 决策）：Developer ID 签名与公证不再执行（第 9 组核对清单跳过）；adhoc 签名的本地 release 包可直接使用。剩余唯一待办：用授权 115 账号登录应用，按 `docs/manual-verification.md` 第 1–8 组核对清单执行远程流程验证并回填结果（凭据请勿经对话传递）。
