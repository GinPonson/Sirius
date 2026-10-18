use crate::library::{LibraryRepository, UploadPartState, UploadSession};
use crate::transfer::{
    speed_bytes_per_sec, DownloadProgressGate, ProgressCallback, TransferReporter, TransferStage,
    TransferUpdate,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use hmac::{Hmac, Mac};
use qrcode::{render::svg, QrCode};
use reqwest::{
    header::{
        HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, ORIGIN, RANGE, REFERER,
        USER_AGENT as HEADER_USER_AGENT,
    },
    Client, StatusCode, Url,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{fs::OpenOptions, io::AsyncWriteExt, sync::Mutex as AsyncMutex, time::timeout};

const AUTH_BASE_URL: &str = "https://qrcodeapi.115.com";
const PASSPORT_BASE_URL: &str = "https://passportapi.115.com";
const API_BASE_URL: &str = "https://proapi.115.com";
/// 115 文件列表单页上限（p115client 实测、StarVault `MAX_PAGE_SIZE` 同值）。
///
/// 需要一次读全目录的场景（全选取 ID、移动目标选择器）用这个值可省掉多次分页；
/// 每次分页在 1 r/s 限速下都是 1 秒，请求数直接决定等待时长。
const MAX_PAGE_LIMIT: u64 = 1150;

/// 控制面限速：两次 OpenAPI 请求之间至少间隔 1 秒（经验值 1 请求/秒且不允许 burst）。
const CONTROL_REQUEST_MIN_INTERVAL: Duration = Duration::from_secs(1);
const CODE_VERIFIER: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const CODE_CHALLENGE: &str = "YOBb0bGVry+UES+nGXpciCiQWIQM58bflpN1a8YlD1U=";
const USER_AGENT: &str =
    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36";
#[cfg(not(debug_assertions))]
const KEYCHAIN_SERVICE: &str = "com.sirius.desktop.cloud115";
#[cfg(not(debug_assertions))]
const KEYCHAIN_ACCOUNT: &str = "oauth-tokens";
#[cfg(debug_assertions)]
const DEV_TOKEN_FILE: &str = "sirius-desktop-cloud115-dev.json";
/// OSS multipart 分片大小；同时作为启用 multipart 的文件大小阈值。
const MULTIPART_PART_BYTES: u64 = 20 * 1024 * 1024;
/// 115 preid 固定取文件首 128 KiB 的 SHA-1。
const PRE_SHA1_SAMPLE_BYTES: usize = 128 * 1024;
/// 原画线路的画质名称；前端据此展示当前播放的是无损直链而非转码流。
const ORIGINAL_QUALITY: &str = "原画";

/// StarVault 已验证的 115 开放平台应用身份；授权页由用户主动选择。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cloud115ClientApp {
    pub id: &'static str,
    pub name: &'static str,
}

pub const CLIENT_APPS: &[Cloud115ClientApp] = &[
    Cloud115ClientApp {
        id: "100195125",
        name: "媒体播放器",
    },
    Cloud115ClientApp {
        id: "100195127",
        name: "蒙太奇播放器",
    },
    Cloud115ClientApp {
        id: "100195135",
        name: "网易爆米花",
    },
    Cloud115ClientApp {
        id: "100195137",
        name: "VidHub 播放器",
    },
    Cloud115ClientApp {
        id: "100195145",
        name: "Filebar",
    },
    Cloud115ClientApp {
        id: "100195181",
        name: "Infuse",
    },
    Cloud115ClientApp {
        id: "100195303",
        name: "OpenList",
    },
    Cloud115ClientApp {
        id: "100195313",
        name: "CloudDrive",
    },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cloud115AccountStatus {
    pub connected: bool,
    pub user_name: Option<String>,
    pub user_id: Option<u64>,
}

/// 115 当前用户的公开资料、容量概要与会员状态；不包含任何鉴权凭据。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cloud115UserProfile {
    pub user_id: u64,
    pub user_name: String,
    pub avatar_url: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub remaining_bytes: u64,
    pub total_formatted: String,
    pub used_formatted: String,
    pub remaining_formatted: String,
    pub vip_level: String,
    pub vip_expires_at: u64,
}

/// OSS 临时凭证只供 Rust 上传器使用，绝不通过 Tauri command 暴露给 WebView。
#[derive(Clone)]
struct Cloud115UploadCredentials {
    endpoint: String,
    access_key_id: String,
    access_key_secret: String,
    security_token: String,
}

/// `/open/upload/init` 的调度结果，供后续二次认证与 OSS 上传阶段消费。
struct Cloud115UploadInit {
    status: i64,
    sign_key: String,
    sign_check: String,
    bucket: String,
    object_key: String,
    callback: String,
    callback_var: String,
    pick_code: String,
}

struct UploadSessionSeed<'a> {
    id: String,
    local_path: &'a str,
    file_name: &'a str,
    target_id: &'a str,
    file_size: u64,
    file_sha1: &'a str,
    pre_sha1: &'a str,
}

/// 一次 OSS 请求的可变部分，避免签名函数出现难以审查的位置参数列表。
struct OssRequestOptions<'a> {
    method: reqwest::Method,
    query: Option<&'a str>,
    content_type: &'a str,
    include_callback: bool,
    body: Vec<u8>,
}

/// 上传完成结果；≤20 MiB 走单对象 PUT，更大文件走 multipart 并持久化断点会话。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cloud115UploadResult {
    pub file_name: String,
    pub pick_code: String,
    pub instant: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cloud115AuthChallenge {
    pub qr_data_uri: String,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cloud115AuthPoll {
    pub status: String,
    pub message: String,
    pub account: Option<Cloud115AccountStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cloud115FileEntry {
    pub id: String,
    pub parent_id: String,
    pub name: String,
    pub kind: String,
    pub extension: String,
    pub size_bytes: u64,
    pub modified_at: u64,
    pub pick_code: String,
    /// 文件 SHA-1；115 在文件条目上返回 `sha1`（部分响应为 `sha`），文件夹为空串。
    /// 原样返回服务端取值、不做大小写归一，归一交给依赖它的去重逻辑。
    pub sha1: String,
    /// 115 服务端缩略图地址；可能缺失，仅用于展示。
    pub thumb_url: Option<String>,
    pub children: Option<u64>,
}

/// 搜索范围：当前目录内，或全账号跨目录。
///
/// 115 协议用 `cid=0` 表达全账号搜索（并非「根目录内搜索」），因此两者在请求参数上
/// 的区别只是 cid 取值；单独建模是为了让前端意图显式可见，避免调用方传 0 靠猜。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Cloud115SearchScope {
    #[default]
    Current,
    Global,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cloud115FilePage {
    pub entries: Vec<Cloud115FileEntry>,
    pub total: u64,
    pub offset: u64,
    pub limit: u64,
    pub has_more: bool,
}

/// 视频播放源：默认走 downurl 原画直链，转码档位只作为后备线路。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cloud115PlaybackSource {
    /// 当前最佳播放地址；优先原画直链，原画不可用时才是转码 m3u8。
    pub url: String,
    pub user_agent: String,
    /// `url` 对应的画质名："原画" 或 115 返回的档位名（如 "1080P"）。
    pub quality: String,
    /// 可作为后备/切换的其它线路（不含 `url` 自身），按 115 返回顺序排列。
    /// 每条都带档位名，前端才能把「切换画质」渲染成有意义的选项而不是一串无名 URL。
    pub fallback_options: Vec<Cloud115PlaybackOptionView>,
}

/// 可切换的画质档位（对外暴露的视图结构）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cloud115PlaybackOptionView {
    /// 带签名的 m3u8 地址。
    pub url: String,
    /// 画质名；服务端未给名字时为空串，前端显示为「备用线路」而不编造档位。
    pub quality: String,
}

/// 115 转码档位：`/open/video/play` 返回的单条 HLS 线路。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Cloud115PlaybackOption {
    /// 带签名的 m3u8 地址。
    url: String,
    /// 画质名，来自 `desc` / `title` / `definition` 映射。
    name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cloud115SubtitleStream {
    pub id: String,
    pub name: String,
    pub language: String,
    pub format: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cloud115DownloadSource {
    pub url: String,
    pub user_agent: String,
}

/// 下载完成后返回的落盘信息；resumed_bytes 为本次从中断点续传的字节数。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cloud115DownloadResult {
    pub file_name: String,
    pub saved_path: String,
    pub size_bytes: u64,
    pub resumed_bytes: u64,
}

/// 校验远端文件名可安全落盘：拒绝空名、路径分隔符与父目录引用，防止路径穿越。
pub(crate) fn sanitize_remote_file_name(file_name: &str) -> Result<String, String> {
    let trimmed = file_name.trim();
    if trimmed.is_empty() {
        return Err("下载文件名不能为空".to_string());
    }
    if trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
    {
        return Err("下载文件名包含非法路径字符".to_string());
    }
    Ok(trimmed.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cloud115PathNode {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cloud115FileMetadata {
    pub id: String,
    pub name: String,
    pub parent_id: String,
    pub is_folder: bool,
    pub file_type: String,
    pub size_bytes: u64,
    pub modified_at: u64,
    pub duration_seconds: f64,
    pub pick_code: String,
    pub sha1: String,
    pub starred: bool,
    pub path: Vec<Cloud115PathNode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cloud115FolderResult {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cloud115RecycleItem {
    pub id: String,
    pub name: String,
    pub is_folder: bool,
    pub size_bytes: u64,
    pub deleted_at: u64,
    pub parent_id: String,
    pub parent_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cloud115RecyclePage {
    pub entries: Vec<Cloud115RecycleItem>,
    pub total: u64,
    pub offset: u64,
    pub limit: u64,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OAuthTokens {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    user_id: u64,
    user_name: String,
}

#[derive(Debug, Clone)]
struct AuthSession {
    uid: String,
    time: u64,
    sign: String,
    expires_at: u64,
}

/// 115 Provider：统一持有 HTTP 客户端、设备码会话和令牌刷新锁。
pub struct Cloud115Provider {
    client: Client,
    // 下载不能用主客户端：其 65 秒总超时会掐断大文件正文传输。
    download_client: Client,
    auth_session: Mutex<Option<AuthSession>>,
    refresh_lock: AsyncMutex<()>,
    // 控制面限速锚点：记录上一次 OpenAPI 请求的发起时刻。
    last_control_request: AsyncMutex<Option<Instant>>,
}

impl Cloud115Provider {
    pub fn new() -> Result<Self, String> {
        // 对齐 StarVault：115 的 downurl 与部分 OpenAPI 会校验浏览器来源头。
        let mut headers = HeaderMap::new();
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/json, text/plain, *"),
        );
        headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("zh-CN,zh;q=0.9"));
        headers.insert(REFERER, HeaderValue::from_static("https://115.com/"));
        headers.insert(ORIGIN, HeaderValue::from_static("https://115.com"));
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(65))
            .user_agent(USER_AGENT)
            .default_headers(headers)
            .build()
            .map_err(|error| format!("初始化 115 HTTP 客户端失败：{error}"))?;
        let download_client = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .user_agent(USER_AGENT)
            .build()
            .map_err(|error| format!("初始化 115 下载客户端失败：{error}"))?;
        Ok(Self {
            client,
            download_client,
            auth_session: Mutex::new(None),
            refresh_lock: AsyncMutex::new(()),
            last_control_request: AsyncMutex::new(None),
        })
    }

    pub fn client_apps(&self) -> Vec<Cloud115ClientApp> {
        CLIENT_APPS.to_vec()
    }

    pub fn account_status(&self) -> Result<Cloud115AccountStatus, String> {
        let tokens = load_tokens()?;
        Ok(Cloud115AccountStatus {
            connected: tokens.is_some(),
            user_name: tokens
                .as_ref()
                .map(|value| value.user_name.clone())
                .filter(|value| !value.is_empty()),
            user_id: tokens
                .as_ref()
                .map(|value| value.user_id)
                .filter(|value| *value > 0),
        })
    }

    /// 申请设备码，并在本地把 115 返回的扫码 URL 编码成 QR SVG。
    pub async fn begin_auth(&self, client_id: &str) -> Result<Cloud115AuthChallenge, String> {
        if !CLIENT_APPS.iter().any(|app| app.id == client_id) {
            return Err("请选择 Sirius 提供的 115 开放平台应用身份".to_string());
        }
        let response = self
            .client
            .post(format!("{AUTH_BASE_URL}/open/authDeviceCode"))
            .form(&[
                ("client_id", client_id),
                ("code_challenge", CODE_CHALLENGE),
                ("code_challenge_method", "sha256"),
            ])
            .send()
            .await
            .map_err(network_error)?;
        let payload = parse_json_response(response, "申请 115 设备码").await?;
        let data = envelope_data(&payload, "申请 115 设备码")?;
        let uid = required_string(data, "uid", "115 设备码响应")?;
        let sign = required_string(data, "sign", "115 设备码响应")?;
        let qr_url = required_string(data, "qrcode", "115 设备码响应")?;
        let server_time =
            value_u64(data.get("time")).ok_or_else(|| "115 设备码响应缺少 time".to_string())?;
        let expires_at =
            unix_now()?.saturating_add(value_u64(data.get("expires_in")).unwrap_or(300));
        let code = QrCode::new(qr_url.as_bytes())
            .map_err(|error| format!("生成 115 登录二维码失败：{error}"))?;
        let svg = code
            .render::<svg::Color>()
            .min_dimensions(512, 512)
            .quiet_zone(true)
            .build();
        let qr_data_uri = format!(
            "data:image/svg+xml;base64,{}",
            STANDARD.encode(svg.as_bytes())
        );
        *self
            .auth_session
            .lock()
            .map_err(|_| "115 授权会话锁已损坏".to_string())? = Some(AuthSession {
            uid,
            time: server_time,
            sign,
            expires_at,
        });
        Ok(Cloud115AuthChallenge {
            qr_data_uri,
            expires_at,
        })
    }

    /// 执行一次长轮询；前端按状态继续调用，确认后在 Keychain 中持久化令牌。
    pub async fn poll_auth(&self) -> Result<Cloud115AuthPoll, String> {
        let session = self
            .auth_session
            .lock()
            .map_err(|_| "115 授权会话锁已损坏".to_string())?
            .clone()
            .ok_or_else(|| "115 登录二维码尚未生成".to_string())?;
        if unix_now()? >= session.expires_at {
            return Ok(auth_poll("expired", "二维码已过期，请重新生成", None));
        }
        let response = self
            .client
            .get(format!("{AUTH_BASE_URL}/get/status/"))
            .query(&[
                ("uid", session.uid.as_str()),
                ("time", &session.time.to_string()),
                ("sign", session.sign.as_str()),
                ("_", &unix_millis()?.to_string()),
            ])
            .send()
            .await
            .map_err(network_error)?;
        let payload = parse_json_response(response, "查询 115 授权状态").await?;
        let data = envelope_data(&payload, "查询 115 授权状态")?;
        match value_i64(data.get("status")).unwrap_or(0) {
            0 => Ok(auth_poll("waiting", "等待使用 115 App 扫码", None)),
            1 => Ok(auth_poll(
                "scanned",
                "已扫码，请在 115 App 中确认登录",
                None,
            )),
            2 => {
                let tokens = self.exchange_token(&session.uid).await?;
                save_tokens(&tokens)?;
                *self
                    .auth_session
                    .lock()
                    .map_err(|_| "115 授权会话锁已损坏".to_string())? = None;
                let account = Cloud115AccountStatus {
                    connected: true,
                    user_name: Some(tokens.user_name).filter(|value| !value.is_empty()),
                    user_id: Some(tokens.user_id).filter(|value| *value > 0),
                };
                Ok(auth_poll("authorized", "115 网盘已连接", Some(account)))
            }
            -1 => Ok(auth_poll("expired", "二维码已过期，请重新生成", None)),
            -2 => Ok(auth_poll("denied", "已拒绝授权", None)),
            status => Err(format!("115 返回未知授权状态：{status}")),
        }
    }

    /// 115 当前未提供可用的 OpenAPI Token 吊销端点；退出时明确删除本地凭据。
    pub fn sign_out(&self) -> Result<(), String> {
        delete_tokens()
    }

    /// 读取当前登录用户资料；字段结构对齐 115 `/open/user/info` 的嵌套空间对象。
    pub async fn user_profile(&self) -> Result<Cloud115UserProfile, String> {
        let payload = self
            .authorized_json(
                reqwest::Method::GET,
                &format!("{API_BASE_URL}/open/user/info"),
                None,
                None,
            )
            .await?;
        let data = envelope_data(&payload, "读取 115 用户资料")?;
        let space = data.get("rt_space_info").unwrap_or(&Value::Null);
        let vip = data.get("vip_info").unwrap_or(&Value::Null);
        Ok(Cloud115UserProfile {
            user_id: value_u64(data.get("user_id"))
                .ok_or_else(|| "115 用户资料缺少 user_id".to_string())?,
            user_name: required_string(data, "user_name", "115 用户资料")?,
            // 头像尺寸优先级对齐 StarVault：列表头像只有 28~38px，中尺寸 m 足够清晰
            // 且比 l 更省流量；缺失时按 l → s 回退。
            avatar_url: value_string(
                data.get("user_face_m")
                    .or_else(|| data.get("user_face_l"))
                    .or_else(|| data.get("user_face_s")),
            )
            .unwrap_or_default(),
            total_bytes: nested_size(space, "all_total"),
            used_bytes: nested_size(space, "all_use"),
            remaining_bytes: nested_size(space, "all_remain"),
            total_formatted: nested_size_format(space, "all_total"),
            used_formatted: nested_size_format(space, "all_use"),
            remaining_formatted: nested_size_format(space, "all_remain"),
            vip_level: value_string(vip.get("level_name")).unwrap_or_default(),
            vip_expires_at: value_u64(vip.get("expire")).unwrap_or(0),
        })
    }

    /// 获取 Aliyun OSS STS 临时凭证；调用方必须仅在 Rust 进程内短时持有。
    async fn upload_credentials(&self) -> Result<Cloud115UploadCredentials, String> {
        let payload = self
            .authorized_json(
                reqwest::Method::GET,
                &format!("{API_BASE_URL}/open/upload/get_token"),
                None,
                None,
            )
            .await?;
        parse_upload_credentials(envelope_data(&payload, "获取 115 上传凭证")?)
    }

    /// 初始化上传调度；首次调用的 sign 参数为空，二次认证时按服务端区间 SHA1 重试。
    async fn initialize_upload(
        &self,
        file_name: &str,
        file_size: u64,
        target_id: &str,
        file_sha1: &str,
        pre_sha1: &str,
        sign: Option<(&str, &str, &str)>,
    ) -> Result<Cloud115UploadInit, String> {
        if file_name.trim().is_empty()
            || target_id.trim().is_empty()
            || file_sha1.len() != 40
            || pre_sha1.len() != 40
        {
            return Err("115 上传初始化参数无效".to_string());
        }
        let (pick_code, sign_key, sign_val) = sign.unwrap_or(("", "", ""));
        let form = [
            ("file_name", file_name.trim().to_string()),
            ("file_size", file_size.to_string()),
            ("target", format!("U_1_{}", target_id.trim())),
            ("fileid", file_sha1.to_ascii_uppercase()),
            ("preid", pre_sha1.to_ascii_uppercase()),
            ("pick_code", pick_code.to_string()),
            ("sign_key", sign_key.to_string()),
            ("sign_val", sign_val.to_ascii_uppercase()),
        ];
        let payload = self
            .authorized_json(
                reqwest::Method::POST,
                &format!("{API_BASE_URL}/open/upload/init"),
                None,
                Some(&form),
            )
            .await?;
        parse_upload_init(envelope_data(&payload, "初始化 115 上传")?)
    }

    /// 刷新断点续传所需的 OSS object 与 callback 元数据，不改变本地 UploadId/ETag 进度。
    async fn resume_upload_metadata(
        &self,
        session: &UploadSession,
    ) -> Result<Cloud115UploadInit, String> {
        let form = [
            ("file_size", session.file_size.to_string()),
            ("target", format!("U_1_{}", session.target_id)),
            ("fileid", session.file_sha1.clone()),
            ("pick_code", session.pick_code.clone()),
        ];
        let payload = self
            .authorized_json(
                reqwest::Method::POST,
                &format!("{API_BASE_URL}/open/upload/resume"),
                None,
                Some(&form),
            )
            .await?;
        let mut data = envelope_data(&payload, "恢复 115 上传")?.clone();
        data.as_object_mut()
            .ok_or_else(|| "115 断点续传响应 data 不是对象".to_string())?
            .insert("status".to_string(), Value::from(1));
        parse_upload_init(&data)
    }

    /// 执行单对象 OSS PUT；回调由 OSS 在成功后通知 115 完成文件入库。
    async fn put_oss_object(
        &self,
        credentials: &Cloud115UploadCredentials,
        init: &Cloud115UploadInit,
        bytes: Vec<u8>,
        progress: &TransferReporter,
    ) -> Result<(), String> {
        if init.status != 1
            || init.bucket.is_empty()
            || init.object_key.is_empty()
            || init.callback.is_empty()
        {
            return Err("115 上传初始化结果不支持 OSS PUT".to_string());
        }
        // 单对象 PUT 无法观测请求内进度，发射一次 transferring 让界面进入传输态。
        progress.report(
            TransferStage::Transferring,
            TransferUpdate {
                transferred_bytes: Some(0),
                total_bytes: Some(bytes.len() as u64),
                ..TransferUpdate::default()
            },
        );
        let response = self
            .oss_request(
                credentials,
                init,
                OssRequestOptions {
                    method: reqwest::Method::PUT,
                    query: None,
                    content_type: "application/octet-stream",
                    include_callback: true,
                    body: bytes,
                },
            )
            .await?;
        if !oss_status_ok(response.status()) {
            return Err(oss_response_error(response).await);
        }
        Ok(())
    }

    /// 对大于 20 MiB 的文件执行 OSS multipart：按偏移流式读取磁盘分块，生产失败时保留会话。
    async fn put_oss_multipart(
        &self,
        credentials: &Cloud115UploadCredentials,
        init: &Cloud115UploadInit,
        source: &Path,
        file_size: u64,
        persistence: Option<(&LibraryRepository, UploadSessionSeed<'_>)>,
        progress: &TransferReporter,
    ) -> Result<(), String> {
        if file_size == 0 {
            return Err("OSS multipart 文件大小必须大于零".to_string());
        }
        let initiate = self
            .oss_request(
                credentials,
                init,
                OssRequestOptions {
                    method: reqwest::Method::POST,
                    // 对齐 OpenList `oss.Sequential()`：115 multipart 要求顺序分片会话。
                    query: Some("sequential&uploads"),
                    content_type: "",
                    include_callback: false,
                    body: Vec::new(),
                },
            )
            .await?;
        if !oss_status_ok(initiate.status()) {
            return Err(oss_response_error(initiate).await);
        }
        let upload_id = xml_element(
            &initiate
                .text()
                .await
                .map_err(|error| format!("读取 OSS multipart 初始化响应失败：{error}"))?,
            "UploadId",
        )
        .ok_or_else(|| "OSS multipart 初始化响应缺少 UploadId".to_string())?;

        let mut stored_session = persistence.map(|(repository, seed)| {
            let session = UploadSession {
                id: seed.id,
                local_path: seed.local_path.to_string(),
                file_name: seed.file_name.to_string(),
                target_id: seed.target_id.to_string(),
                file_size: seed.file_size,
                file_sha1: seed.file_sha1.to_string(),
                pre_sha1: seed.pre_sha1.to_string(),
                pick_code: init.pick_code.clone(),
                bucket: init.bucket.clone(),
                object_key: init.object_key.clone(),
                upload_id: upload_id.clone(),
                callback: init.callback.clone(),
                callback_var: init.callback_var.clone(),
                part_size: MULTIPART_PART_BYTES,
                completed_parts: Vec::new(),
                status: "uploading".to_string(),
            };
            (repository, session)
        });
        if let Some((repository, session)) = &stored_session {
            repository.save_upload_session(session)?;
        }

        let total_parts = file_size.div_ceil(MULTIPART_PART_BYTES);
        // 传输开始先发一次 0 分片进度，让界面在首个 20 MiB 分片完成前就能进入传输态。
        progress.report(
            TransferStage::Transferring,
            TransferUpdate {
                completed_parts: Some(0),
                total_parts: Some(total_parts),
                transferred_bytes: Some(0),
                total_bytes: Some(file_size),
                speed_bytes_per_sec: None,
            },
        );
        let mut last_progress = Some((Instant::now(), 0_u64));

        let workflow = async {
            let mut parts = Vec::new();
            for part_number in 1..=total_parts {
                let offset = (part_number - 1) * MULTIPART_PART_BYTES;
                let length = std::cmp::min(MULTIPART_PART_BYTES, file_size - offset) as usize;
                let chunk_source = source.to_path_buf();
                let chunk = tokio::task::spawn_blocking(move || {
                    read_file_range(&chunk_source, offset, length)
                })
                .await
                .map_err(|error| format!("上传分块读取线程异常终止：{error}"))??;
                let query = oss_query(&[
                    ("partNumber", part_number.to_string()),
                    ("uploadId", upload_id.clone()),
                ]);
                let mut last_error = None;
                for attempt in 0..3 {
                    let response = self
                        .oss_request(
                            credentials,
                            init,
                            OssRequestOptions {
                                method: reqwest::Method::PUT,
                                query: Some(&query),
                                content_type: "application/octet-stream",
                                include_callback: false,
                                body: chunk.clone(),
                            },
                        )
                        .await?;
                    if oss_status_ok(response.status()) {
                        let etag = response
                            .headers()
                            .get("ETag")
                            .and_then(|value| value.to_str().ok())
                            .filter(|value| !value.is_empty())
                            .ok_or_else(|| "OSS 分片响应缺少 ETag".to_string())?
                            .to_string();
                        let stored_etag = etag.clone();
                        parts.push((part_number as usize, etag));
                        if let Some((repository, session)) = &mut stored_session {
                            session.completed_parts.push(UploadPartState {
                                number: part_number as u32,
                                etag: stored_etag,
                            });
                            repository.save_upload_session(session)?;
                        }
                        report_multipart_progress(
                            progress,
                            part_number,
                            total_parts,
                            file_size,
                            MULTIPART_PART_BYTES,
                            &mut last_progress,
                        );
                        last_error = None;
                        break;
                    }
                    last_error = Some(oss_response_error(response).await);
                    if attempt < 2 {
                        tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
                    }
                }
                if let Some(error) = last_error {
                    return Err(error);
                }
            }

            // 最后一个分片完成后、发起 CompleteMultipartUpload 前进入 finalizing；
            // 收到 115 回调成功（workflow 返回 Ok）后由命令层补发 done。
            progress.report(
                TransferStage::Finalizing,
                TransferUpdate {
                    completed_parts: Some(total_parts),
                    total_parts: Some(total_parts),
                    transferred_bytes: Some(file_size),
                    total_bytes: Some(file_size),
                    speed_bytes_per_sec: None,
                },
            );
            let complete_body = complete_multipart_xml(&parts).into_bytes();
            let query = oss_query(&[("uploadId", upload_id.clone())]);
            let complete = self
                .oss_request(
                    credentials,
                    init,
                    OssRequestOptions {
                        method: reqwest::Method::POST,
                        query: Some(&query),
                        content_type: "application/xml",
                        include_callback: true,
                        body: complete_body,
                    },
                )
                .await?;
            if !oss_status_ok(complete.status()) {
                return Err(oss_response_error(complete).await);
            }
            let callback_body = complete
                .text()
                .await
                .map_err(|error| format!("读取 OSS multipart 完成响应失败：{error}"))?;
            let callback_payload: Value = serde_json::from_str(&callback_body).map_err(|_| {
                "OSS multipart 已完成，但响应不是 115 callback JSON，文件尚未确认入库".to_string()
            })?;
            if !state_ok(callback_payload.get("state")) {
                return Err(api_business_error(
                    &callback_payload,
                    "确认 115 multipart 回调",
                ));
            }
            Ok::<(), String>(())
        }
        .await;

        if let Err(error) = workflow {
            if let Some((repository, session)) = &mut stored_session {
                session.status = "failed".to_string();
                repository.save_upload_session(session)?;
                return Err(error);
            }
            let query = oss_query(&[("uploadId", upload_id)]);
            let abort = self
                .oss_request(
                    credentials,
                    init,
                    OssRequestOptions {
                        method: reqwest::Method::DELETE,
                        query: Some(&query),
                        content_type: "",
                        include_callback: false,
                        body: Vec::new(),
                    },
                )
                .await;
            return match abort {
                Ok(response) if oss_status_ok(response.status()) => Err(error),
                Ok(response) => Err(format!(
                    "{error}；且 {}",
                    oss_response_error(response).await
                )),
                Err(abort_error) => {
                    Err(format!("{error}；且中止 OSS multipart 失败：{abort_error}"))
                }
            };
        }
        if let Some((repository, session)) = stored_session {
            repository.delete_upload_session(&session.id)?;
        }
        Ok(())
    }

    /// 构造并签名一条 OSS V1 请求；query 必须已经按名称排序并 URL 编码。
    async fn oss_request(
        &self,
        credentials: &Cloud115UploadCredentials,
        init: &Cloud115UploadInit,
        options: OssRequestOptions<'_>,
    ) -> Result<reqwest::Response, String> {
        let OssRequestOptions {
            method,
            query,
            content_type,
            include_callback,
            body,
        } = options;
        let mut url = oss_object_url(credentials, init)?;
        url.set_query(query);
        let date = httpdate::fmt_http_date(SystemTime::now());
        let callback = STANDARD.encode(init.callback.as_bytes());
        let callback_var = STANDARD.encode(init.callback_var.as_bytes());
        let mut canonical_headers = String::new();
        if include_callback {
            canonical_headers.push_str(&format!("x-oss-callback:{callback}\n"));
            canonical_headers.push_str(&format!("x-oss-callback-var:{callback_var}\n"));
        }
        canonical_headers.push_str(&format!(
            "x-oss-security-token:{}\n",
            credentials.security_token
        ));
        let canonical_resource = match query {
            Some(query) => format!("/{}/{}?{query}", init.bucket, init.object_key),
            None => format!("/{}/{}", init.bucket, init.object_key),
        };
        let string_to_sign = format!(
            "{}\n\n{}\n{}\n{}{}",
            method.as_str(),
            content_type,
            date,
            canonical_headers,
            canonical_resource
        );
        let authorization = oss_authorization(
            &credentials.access_key_id,
            &credentials.access_key_secret,
            string_to_sign.as_bytes(),
        )?;
        let mut request = self
            .client
            .request(method, url)
            .header("Date", date)
            .header("Authorization", authorization)
            .header("x-oss-security-token", &credentials.security_token);
        if !content_type.is_empty() {
            request = request.header("Content-Type", content_type);
        }
        if include_callback {
            request = request
                .header("x-oss-callback", callback)
                .header("x-oss-callback-var", callback_var);
        }
        request.body(body).send().await.map_err(network_error)
    }

    /// 从持久化 ETag 之后继续 OSS multipart；按偏移流式读取磁盘分块，失败时保留会话供下次重试。
    async fn resume_oss_multipart(
        &self,
        repository: &LibraryRepository,
        mut session: UploadSession,
        credentials: &Cloud115UploadCredentials,
        init: &Cloud115UploadInit,
        source: &Path,
        progress: &TransferReporter,
    ) -> Result<Cloud115UploadResult, String> {
        if init.bucket != session.bucket || init.object_key != session.object_key {
            return Err("115 resume 返回的 OSS 目标与持久化会话不一致".to_string());
        }
        session.callback = init.callback.clone();
        session.callback_var = init.callback_var.clone();
        session.pick_code = init.pick_code.clone();
        session.status = "uploading".to_string();
        repository.save_upload_session(&session)?;

        let part_size = usize::try_from(session.part_size)
            .map_err(|_| "持久化分片大小超出当前平台范围".to_string())?;
        let total_parts = session.file_size.div_ceil(part_size as u64);
        let resumed_parts = session.completed_parts.len() as u64;
        let resumed_bytes = std::cmp::min(resumed_parts * part_size as u64, session.file_size);
        // 恢复路径先上报已完成分片基数，让界面从真实进度开始展示。
        progress.report(
            TransferStage::Transferring,
            TransferUpdate {
                completed_parts: Some(resumed_parts),
                total_parts: Some(total_parts),
                transferred_bytes: Some(resumed_bytes),
                total_bytes: Some(session.file_size),
                speed_bytes_per_sec: None,
            },
        );
        let mut last_progress = Some((Instant::now(), resumed_bytes));

        let workflow = async {
            let mut parts = session
                .completed_parts
                .iter()
                .map(|part| (part.number as usize, part.etag.clone()))
                .collect::<Vec<_>>();
            for part_number in 1..=total_parts {
                let part_number_usize = part_number as usize;
                if parts.iter().any(|(number, _)| *number == part_number_usize) {
                    continue;
                }
                let offset = (part_number - 1) * part_size as u64;
                let length = std::cmp::min(part_size as u64, session.file_size - offset) as usize;
                let chunk_source = source.to_path_buf();
                let chunk = tokio::task::spawn_blocking(move || {
                    read_file_range(&chunk_source, offset, length)
                })
                .await
                .map_err(|error| format!("恢复分块读取线程异常终止：{error}"))??;
                let query = oss_query(&[
                    ("partNumber", part_number_usize.to_string()),
                    ("uploadId", session.upload_id.clone()),
                ]);
                let mut last_error = None;
                for attempt in 0..3 {
                    let response = self
                        .oss_request(
                            credentials,
                            init,
                            OssRequestOptions {
                                method: reqwest::Method::PUT,
                                query: Some(&query),
                                content_type: "application/octet-stream",
                                include_callback: false,
                                body: chunk.clone(),
                            },
                        )
                        .await?;
                    if oss_status_ok(response.status()) {
                        let etag = response
                            .headers()
                            .get("ETag")
                            .and_then(|value| value.to_str().ok())
                            .filter(|value| !value.is_empty())
                            .ok_or_else(|| "OSS 恢复分片响应缺少 ETag".to_string())?
                            .to_string();
                        parts.push((part_number_usize, etag.clone()));
                        parts.sort_by_key(|(number, _)| *number);
                        session.completed_parts = parts
                            .iter()
                            .map(|(number, etag)| UploadPartState {
                                number: *number as u32,
                                etag: etag.clone(),
                            })
                            .collect();
                        repository.save_upload_session(&session)?;
                        report_multipart_progress(
                            progress,
                            part_number,
                            total_parts,
                            session.file_size,
                            part_size as u64,
                            &mut last_progress,
                        );
                        last_error = None;
                        break;
                    }
                    last_error = Some(oss_response_error(response).await);
                    if attempt < 2 {
                        tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
                    }
                }
                if let Some(error) = last_error {
                    return Err(error);
                }
            }

            // 与全新上传一致：补齐剩余分片后进入 finalizing，由命令层在成功后补发 done。
            progress.report(
                TransferStage::Finalizing,
                TransferUpdate {
                    completed_parts: Some(total_parts),
                    total_parts: Some(total_parts),
                    transferred_bytes: Some(session.file_size),
                    total_bytes: Some(session.file_size),
                    speed_bytes_per_sec: None,
                },
            );
            let query = oss_query(&[("uploadId", session.upload_id.clone())]);
            let complete = self
                .oss_request(
                    credentials,
                    init,
                    OssRequestOptions {
                        method: reqwest::Method::POST,
                        query: Some(&query),
                        content_type: "application/xml",
                        include_callback: true,
                        body: complete_multipart_xml(&parts).into_bytes(),
                    },
                )
                .await?;
            if !oss_status_ok(complete.status()) {
                return Err(oss_response_error(complete).await);
            }
            let callback_body = complete
                .text()
                .await
                .map_err(|error| format!("读取 OSS 恢复完成响应失败：{error}"))?;
            let callback_payload: Value = serde_json::from_str(&callback_body)
                .map_err(|_| "OSS 恢复完成响应不是 115 callback JSON".to_string())?;
            if !state_ok(callback_payload.get("state")) {
                return Err(api_business_error(
                    &callback_payload,
                    "确认 115 恢复上传回调",
                ));
            }
            Ok::<(), String>(())
        }
        .await;

        if let Err(error) = workflow {
            session.status = "failed".to_string();
            repository.save_upload_session(&session)?;
            return Err(error);
        }
        repository.delete_upload_session(&session.id)?;
        Ok(Cloud115UploadResult {
            file_name: session.file_name,
            pick_code: init.pick_code.clone(),
            instant: false,
        })
    }

    /// 校验本地文件未变化后，从磁盘流式恢复持久化 multipart 会话；文件大小不再有 64 MiB 上限。
    /// 进度经 `on_progress` 回调上报，离线测试与不关心进度的调用方可传 `None`。
    pub async fn resume_upload_session(
        &self,
        repository: &LibraryRepository,
        session: UploadSession,
        on_progress: Option<ProgressCallback>,
    ) -> Result<Cloud115UploadResult, String> {
        let source = PathBuf::from(&session.local_path);
        let reporter = TransferReporter::upload(on_progress, &source);
        let result = self
            .resume_upload_with_progress(repository, session, &source, &reporter)
            .await;
        reporter.finish(result.is_ok());
        result
    }

    /// 恢复上传的具体流程；终态事件由外层 `resume_upload_session` 统一补发。
    async fn resume_upload_with_progress(
        &self,
        repository: &LibraryRepository,
        session: UploadSession,
        source: &Path,
        reporter: &TransferReporter,
    ) -> Result<Cloud115UploadResult, String> {
        reporter.report(TransferStage::Preparing, TransferUpdate::default());
        let (file_sha1, pre_sha1, file_size) = tokio::task::spawn_blocking({
            let source = source.to_path_buf();
            move || compute_upload_digests(&source)
        })
        .await
        .map_err(|error| format!("恢复文件校验线程异常终止：{error}"))??;
        if file_size != session.file_size {
            return Err("本地文件大小已变化，拒绝恢复上传".to_string());
        }
        if file_sha1 != session.file_sha1 || pre_sha1 != session.pre_sha1 {
            return Err("本地文件内容已变化，拒绝恢复上传".to_string());
        }
        let init = self.resume_upload_metadata(&session).await?;
        let credentials = self.upload_credentials().await?;
        self.resume_oss_multipart(repository, session, &credentials, &init, source, reporter)
            .await
    }

    /// 从磁盘流式上传本地文件：≤20 MiB 走单对象 PUT，更大的文件走 multipart 并持久化会话。
    /// SHA1 与分块均按需从磁盘读取，文件大小不再有 64 MiB 上限。
    /// 进度经 `on_progress` 回调上报，离线测试与不关心进度的调用方可传 `None`。
    pub async fn upload_file_from_disk(
        &self,
        repository: &LibraryRepository,
        local_path: &str,
        target_id: &str,
        on_progress: Option<ProgressCallback>,
    ) -> Result<Cloud115UploadResult, String> {
        let source = PathBuf::from(local_path);
        if !source.is_absolute() {
            return Err("上传源文件必须使用绝对路径".to_string());
        }
        let reporter = TransferReporter::upload(on_progress, &source);
        let result = self
            .upload_with_progress(repository, local_path, &source, target_id, &reporter)
            .await;
        reporter.finish(result.is_ok());
        result
    }

    /// 上传的具体流程；终态事件由外层 `upload_file_from_disk` 统一补发。
    async fn upload_with_progress(
        &self,
        repository: &LibraryRepository,
        local_path: &str,
        source: &Path,
        target_id: &str,
        reporter: &TransferReporter,
    ) -> Result<Cloud115UploadResult, String> {
        // preparing：上传启动即上报，覆盖摘要计算与 115 预传调度阶段。
        reporter.report(TransferStage::Preparing, TransferUpdate::default());
        let (file_name, file_sha1, pre_sha1, file_size) = {
            let digest_source = source.to_path_buf();
            tokio::task::spawn_blocking(move || {
                let file_name = digest_source
                    .file_name()
                    .and_then(|value| value.to_str())
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "上传源文件名称无效".to_string())?
                    .to_string();
                let (file_sha1, pre_sha1, file_size) = compute_upload_digests(&digest_source)?;
                Ok::<_, String>((file_name, file_sha1, pre_sha1, file_size))
            })
            .await
            .map_err(|error| format!("上传文件校验线程异常终止：{error}"))??
        };

        let mut init = self
            .initialize_upload(
                &file_name, file_size, target_id, &file_sha1, &pre_sha1, None,
            )
            .await?;
        if matches!(init.status, 6..=8) {
            let (start, end) = parse_sign_check_range(&init.sign_check, file_size as usize)?;
            let sign_val = {
                let range_source = source.to_path_buf();
                let range = tokio::task::spawn_blocking(move || {
                    read_file_range(&range_source, start as u64, end - start + 1)
                })
                .await
                .map_err(|error| format!("上传校验读取线程异常终止：{error}"))??;
                sha1_upper(&range)
            };
            if init.sign_key.is_empty() {
                return Err("115 上传二次校验响应缺少 sign_key".to_string());
            }
            init = self
                .initialize_upload(
                    &file_name,
                    file_size,
                    target_id,
                    &file_sha1,
                    &pre_sha1,
                    Some((&init.pick_code, &init.sign_key, &sign_val)),
                )
                .await?;
            if matches!(init.status, 6..=8) {
                return Err("115 上传二次校验后仍要求重复校验，已停止以避免请求循环".to_string());
            }
        }
        match init.status {
            1 => {
                let credentials = self.upload_credentials().await?;
                if file_size > MULTIPART_PART_BYTES {
                    let seed = UploadSessionSeed {
                        id: format!("cloud115-upload-{}", unix_millis()?),
                        local_path,
                        file_name: &file_name,
                        target_id,
                        file_size,
                        file_sha1: &file_sha1,
                        pre_sha1: &pre_sha1,
                    };
                    self.put_oss_multipart(
                        &credentials,
                        &init,
                        source,
                        file_size,
                        Some((repository, seed)),
                        reporter,
                    )
                    .await?;
                } else {
                    let range_source = source.to_path_buf();
                    let bytes = tokio::task::spawn_blocking(move || {
                        read_file_range(&range_source, 0, file_size as usize)
                    })
                    .await
                    .map_err(|error| format!("上传文件读取线程异常终止：{error}"))??;
                    self.put_oss_object(&credentials, &init, bytes, reporter)
                        .await?;
                }
                Ok(Cloud115UploadResult {
                    file_name,
                    pick_code: init.pick_code,
                    instant: false,
                })
            }
            2 => Ok(Cloud115UploadResult {
                file_name,
                pick_code: init.pick_code,
                instant: true,
            }),
            status => Err(format!("115 返回未知上传初始化状态：{status}")),
        }
    }

    /// 列出目录内容；`query` 非空时走当前目录内搜索。
    ///
    /// 全账号搜索用 [`Self::search_files`]；这里保持「目录内」语义，避免调用方
    /// 靠传 0 表达跨目录意图。
    pub async fn list_files(
        &self,
        parent_id: &str,
        offset: u64,
        limit: u64,
        query: &str,
    ) -> Result<Cloud115FilePage, String> {
        self.list_files_scoped(
            parent_id,
            offset,
            limit,
            query,
            Cloud115SearchScope::Current,
        )
        .await
    }

    /// 全账号搜索（跨目录 substring 匹配）。
    ///
    /// 对齐 StarVault `FilesRepository.searchFiles` 默认行为：`cid=0` 在 115 协议里表示
    /// 「不限目录」，而不是「根目录内搜索」。当前目录内搜索请直接用 [`Self::list_files`]。
    pub async fn search_files(
        &self,
        offset: u64,
        limit: u64,
        query: &str,
    ) -> Result<Cloud115FilePage, String> {
        if query.trim().is_empty() {
            return Err("全账号搜索关键词不能为空".to_string());
        }
        self.list_files_scoped("0", offset, limit, query, Cloud115SearchScope::Global)
            .await
    }

    /// 列出目录内容并按 `search_scope` 决定搜索范围。
    async fn list_files_scoped(
        &self,
        parent_id: &str,
        offset: u64,
        limit: u64,
        query: &str,
        search_scope: Cloud115SearchScope,
    ) -> Result<Cloud115FilePage, String> {
        if parent_id.is_empty() || limit == 0 || limit > MAX_PAGE_LIMIT {
            return Err(format!(
                "115 目录 ID 或分页参数无效（limit 需在 1..={MAX_PAGE_LIMIT} 之间）"
            ));
        }
        if !query.trim().is_empty() {
            let search_cid = match search_scope {
                Cloud115SearchScope::Current => parent_id,
                // 全账号搜索：115 协议用 cid=0 表示跨目录匹配（不是"根目录内搜索"）。
                Cloud115SearchScope::Global => "0",
            };
            let params = search_query_params(search_cid, offset, limit, query.trim());
            let payload = self
                .authorized_json(
                    reqwest::Method::GET,
                    &format!("{API_BASE_URL}/open/ufile/search"),
                    Some(&params),
                    None,
                )
                .await?;
            return parse_file_page(&payload, search_cid, offset, limit);
        }

        // 单次请求取混合列表：show_dir=1 + fc_mix=1 时 115 会一次返回目录与文件，
        // 由 parse_file_entry 按 fc/fid 判别类型。这与 p115client 及 StarVault 的
        // 既有做法一致，避免每个目录都发两次请求（限速下会被拉长到 2 倍间隔）。
        let params = list_query_params(parent_id, offset, limit, Some(1));
        let payload = self
            .authorized_json(
                reqwest::Method::GET,
                &format!("{API_BASE_URL}/open/ufile/files"),
                Some(&params),
                None,
            )
            .await?;
        parse_file_page(&payload, parent_id, offset, limit)
    }

    /// 列出全账号星标文件与文件夹。
    ///
    /// 对齐 StarVault `FilesRepository.listStarred`：`cid=0` + `star=1` + `cur=0` 是
    /// 115 开放接口遍历收藏项的固定组合。`cur=0` 表示允许从根目录向下遍历，
    /// 与目录列表的 `cur=1`（仅当前目录）语义相反，不能复用默认参数。
    pub async fn list_starred_files(
        &self,
        offset: u64,
        limit: u64,
    ) -> Result<Cloud115FilePage, String> {
        if limit == 0 || limit > MAX_PAGE_LIMIT {
            return Err(format!(
                "115 收藏列表分页参数无效（limit 需在 1..={MAX_PAGE_LIMIT} 之间）"
            ));
        }
        let params = starred_query_params(offset, limit);
        let payload = self
            .authorized_json(
                reqwest::Method::GET,
                &format!("{API_BASE_URL}/open/ufile/files"),
                Some(&params),
                None,
            )
            .await?;
        parse_file_page(&payload, "0", offset, limit)
    }

    /// 解析视频播放源：优先 downurl 原画直链，转码档位只作后备。
    ///
    /// 对齐 StarVault `PreviewVideoViewModel`（已验证实现）：原画直链无转码排队、画质无损，
    /// 是默认播放线路；`/open/video/play` 的 m3u8 仅在原画解析失败时承担首播，成功时作为
    /// 可降级/切换的备选档位一并返回。
    ///
    /// 两路请求并发发起（而非串行等待）：控制面限速本身已把它们隔开约 1 秒，串行执行会让
    /// 起播额外多等一个完整网络往返；并发时总耗时约等于较慢的那一路。
    pub async fn playback_source(&self, pick_code: &str) -> Result<Cloud115PlaybackSource, String> {
        if pick_code.trim().is_empty() {
            return Err("115 视频缺少 pick_code，无法解析播放地址".to_string());
        }
        let (original, transcoded) = tokio::join!(
            self.resolve_downurl(pick_code, "解析 115 视频原画地址"),
            self.playback_options(pick_code),
        );
        compose_playback_source(original, transcoded)
    }

    /// 拉取 `/open/video/play` 的转码档位列表，只负责网络与解析，不做兜底决策。
    async fn playback_options(
        &self,
        pick_code: &str,
    ) -> Result<Vec<Cloud115PlaybackOption>, String> {
        let query = [("pick_code", pick_code.trim().to_string())];
        let payload = self
            .authorized_json(
                reqwest::Method::GET,
                &format!("{API_BASE_URL}/open/video/play"),
                Some(&query),
                None,
            )
            .await?;
        parse_playback_options(&payload)
    }

    /// 返回 115 已提取的外挂字幕；autoload 的对象/数组两种合法形态均兼容。
    pub async fn video_subtitles(
        &self,
        pick_code: &str,
    ) -> Result<Vec<Cloud115SubtitleStream>, String> {
        if pick_code.trim().is_empty() {
            return Err("115 视频缺少 pick_code，无法读取字幕".to_string());
        }
        let query = [("pick_code", pick_code.trim().to_string())];
        let payload = self
            .authorized_json(
                reqwest::Method::GET,
                &format!("{API_BASE_URL}/open/video/subtitle"),
                Some(&query),
                None,
            )
            .await?;
        if !state_ok(payload.get("state")) {
            return Err(api_business_error(&payload, "读取 115 视频字幕"));
        }
        let data = payload
            .get("data")
            .and_then(Value::as_object)
            .ok_or_else(|| "115 视频字幕响应缺少 data 对象".to_string())?;
        let mut items = Vec::new();
        if let Some(autoload) = data.get("autoload") {
            match autoload {
                Value::Object(_) => items.push(autoload),
                Value::Array(values) => items.extend(values.iter()),
                Value::Null => {}
                _ => return Err("115 视频字幕 autoload 结构无效".to_string()),
            }
        }
        if let Some(list) = data.get("list").and_then(Value::as_array) {
            items.extend(list.iter());
        }
        let mut streams = Vec::new();
        for item in items {
            let Some(object) = item.as_object() else {
                continue;
            };
            let Some(url) = value_string(object.get("url"))
                .filter(|value| value.starts_with("https://") || value.starts_with("http://"))
            else {
                continue;
            };
            if streams
                .iter()
                .any(|stream: &Cloud115SubtitleStream| stream.url == url)
            {
                continue;
            }
            streams.push(Cloud115SubtitleStream {
                id: value_string(object.get("sid").or_else(|| object.get("file_id")))
                    .unwrap_or_default(),
                name: value_string(object.get("title").or_else(|| object.get("file_name")))
                    .unwrap_or_else(|| "字幕".to_string()),
                language: value_string(object.get("language")).unwrap_or_default(),
                format: value_string(object.get("type")).unwrap_or_default(),
                url,
            });
        }
        Ok(streams)
    }

    /// 将普通文件 pick_code 换成短时效下载地址；兼容 Map 与数组两种 data 形态。
    pub async fn download_source(&self, pick_code: &str) -> Result<Cloud115DownloadSource, String> {
        if pick_code.trim().is_empty() {
            return Err("115 文件缺少 pick_code，无法获取下载地址".to_string());
        }
        let url = self
            .resolve_downurl(pick_code, "解析 115 文件下载地址")
            .await?;
        Ok(Cloud115DownloadSource {
            url,
            user_agent: USER_AGENT.to_string(),
        })
    }

    /// 调用 `POST /open/ufile/downurl` 取文件的短时效签名直链。
    ///
    /// 下载与视频播放共用这一条链路（StarVault 同样以 downurl 作为原画/原图来源），因此
    /// 请求、状态校验与 data 形态兼容都收敛在此，避免两处重复实现而漂移。
    ///
    /// - `pick_code`：115 文件下载码，调用方负责保证非空。
    /// - `action`：出错时拼进业务错误信息，用于区分「下载地址」与「视频原画地址」两条调用路径。
    async fn resolve_downurl(&self, pick_code: &str, action: &str) -> Result<String, String> {
        let form = [("pick_code", pick_code.trim().to_string())];
        let payload = self
            .authorized_json(
                reqwest::Method::POST,
                &format!("{API_BASE_URL}/open/ufile/downurl"),
                None,
                Some(&form),
            )
            .await?;
        parse_downurl_payload(&payload, action)
    }

    /// 将文件下载到本地目录。存在 `.sirius-part` 临时文件时按 Range 续传；
    /// 401/403 时重新解析一次下载地址；成功后原子重命名，失败保留临时文件供重试。
    /// 进度经 `on_progress` 回调限频上报，离线测试与不关心进度的调用方可传 `None`。
    pub async fn download_file(
        &self,
        pick_code: &str,
        target_dir: &str,
        file_name: &str,
        expected_size_bytes: u64,
        on_progress: Option<ProgressCallback>,
    ) -> Result<Cloud115DownloadResult, String> {
        if pick_code.trim().is_empty() {
            return Err("115 文件缺少 pick_code，无法下载".to_string());
        }
        let safe_name = sanitize_remote_file_name(file_name)?;
        let dir = PathBuf::from(target_dir);
        if !dir.is_absolute() {
            return Err("下载目标目录必须使用绝对路径".to_string());
        }
        let reporter = TransferReporter::download(on_progress, &safe_name);
        let result = self
            .download_with_progress(pick_code, &dir, &safe_name, expected_size_bytes, &reporter)
            .await;
        reporter.finish(result.is_ok());
        result
    }

    /// 下载的具体流程；终态事件由外层 `download_file` 统一补发。
    async fn download_with_progress(
        &self,
        pick_code: &str,
        dir: &Path,
        safe_name: &str,
        expected_size_bytes: u64,
        reporter: &TransferReporter,
    ) -> Result<Cloud115DownloadResult, String> {
        let final_path = dir.join(safe_name);
        let temp_path = dir.join(format!("{safe_name}.sirius-part"));
        match tokio::fs::metadata(&final_path).await {
            Ok(_) => return Err(format!("目标位置已存在同名文件：{}", final_path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("检查下载目标失败：{error}")),
        }
        let mut offset = match tokio::fs::metadata(&temp_path).await {
            Ok(metadata) if metadata.is_file() => metadata.len(),
            Ok(_) => return Err("下载临时文件位置被非普通文件占用".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(error) => return Err(format!("检查下载临时文件失败：{error}")),
        };
        if expected_size_bytes > 0 && offset > expected_size_bytes {
            return Err("本地下载临时文件大于远端文件大小，已停止以避免数据损坏".to_string());
        }
        // preparing：本地检查完成后上报；续传时携带已有的字节基数。
        reporter.report(
            TransferStage::Preparing,
            download_progress_update(offset, expected_size_bytes),
        );
        let mut gate = DownloadProgressGate::new();
        let mut refreshed = false;
        loop {
            if expected_size_bytes > 0 && offset == expected_size_bytes {
                // 临时文件已完整：补发一次终态前进度再落盘。
                reporter.report(
                    TransferStage::Transferring,
                    download_progress_update(offset, expected_size_bytes),
                );
                Self::finalize_download(&temp_path, &final_path).await?;
                return Ok(Cloud115DownloadResult {
                    file_name: safe_name.to_string(),
                    saved_path: final_path.to_string_lossy().into_owned(),
                    size_bytes: offset,
                    resumed_bytes: 0,
                });
            }

            let source = self.download_source(pick_code).await?;
            let mut request = self
                .download_client
                .get(&source.url)
                .header(HEADER_USER_AGENT, source.user_agent);
            if offset > 0 {
                request = request.header(RANGE, format!("bytes={offset}-"));
            }
            let mut response = request
                .send()
                .await
                .map_err(|error| format!("发起下载请求失败：{error}"))?;
            let status = response.status();
            if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
                if refreshed {
                    return Err("下载地址再次被服务端拒绝（401/403），请稍后重试".to_string());
                }
                // 签名地址可能刚好过期：重新解析一次后继续，不重置本地进度。
                refreshed = true;
                continue;
            }
            if !status.is_success() {
                return Err(format!("下载请求失败：HTTP {status}"));
            }

            let mut sink = if status == StatusCode::PARTIAL_CONTENT && offset > 0 {
                OpenOptions::new()
                    .append(true)
                    .open(&temp_path)
                    .await
                    .map_err(|error| format!("打开下载临时文件失败：{error}"))?
            } else {
                // 服务端忽略 Range 时必须从头重下，避免拼接出损坏的数据。
                offset = 0;
                tokio::fs::File::create(&temp_path)
                    .await
                    .map_err(|error| format!("创建下载临时文件失败：{error}"))?
            };

            let mut received = offset;
            loop {
                let chunk = match timeout(Duration::from_secs(60), response.chunk()).await {
                    Ok(Ok(Some(bytes))) => bytes,
                    Ok(Ok(None)) => break,
                    Ok(Err(error)) => {
                        return Err(format!(
                            "下载中断：{error}；进度已保留，重新下载将从断点继续"
                        ))
                    }
                    Err(_) => {
                        return Err("下载停滞超过 60 秒，已停止；重新下载将从断点继续".to_string())
                    }
                };
                if let Err(error) = sink.write_all(&chunk).await {
                    if error.kind() == std::io::ErrorKind::StorageFull {
                        return Err("磁盘空间不足，下载进度已保留".to_string());
                    }
                    return Err(format!("写入本地文件失败：{error}"));
                }
                received += chunk.len() as u64;
                // 限频上报：每 200ms 或每 1 MiB 至多一次，速度按上次发射以来的差值估算。
                if let Some(emission) = gate.admit(Instant::now(), received, false) {
                    reporter.report(
                        TransferStage::Transferring,
                        download_progress_update(emission.transferred_bytes, expected_size_bytes)
                            .with_speed(emission.speed_bytes_per_sec),
                    );
                }
            }
            sink.flush()
                .await
                .map_err(|error| format!("写入本地文件失败：{error}"))?;
            drop(sink);

            if expected_size_bytes > 0 && received != expected_size_bytes {
                return Err(format!(
                    "下载数据不完整（{received}/{expected_size_bytes} 字节）；进度已保留，重新下载将从断点继续"
                ));
            }
            // 传输结束必发一次最终进度，避免限频吞掉最后一段字节。
            if let Some(emission) = gate.admit(Instant::now(), received, true) {
                reporter.report(
                    TransferStage::Transferring,
                    download_progress_update(emission.transferred_bytes, expected_size_bytes)
                        .with_speed(emission.speed_bytes_per_sec),
                );
            }
            Self::finalize_download(&temp_path, &final_path).await?;
            return Ok(Cloud115DownloadResult {
                file_name: safe_name.to_string(),
                saved_path: final_path.to_string_lossy().into_owned(),
                size_bytes: received,
                resumed_bytes: offset,
            });
        }
    }

    async fn finalize_download(temp_path: &Path, final_path: &Path) -> Result<(), String> {
        tokio::fs::rename(temp_path, final_path)
            .await
            .map_err(|error| format!("下载文件落盘失败：{error}"))
    }

    /// 读取单个文件或文件夹详情，用于详情页、预览和后续文件操作。
    pub async fn file_metadata(&self, file_id: &str) -> Result<Cloud115FileMetadata, String> {
        if file_id.trim().is_empty() {
            return Err("115 文件 ID 不能为空".to_string());
        }
        let query = [("file_id", file_id.trim().to_string())];
        let payload = self
            .authorized_json(
                reqwest::Method::GET,
                &format!("{API_BASE_URL}/open/folder/get_info"),
                Some(&query),
                None,
            )
            .await?;
        if !state_ok(payload.get("state")) {
            return Err(api_business_error(&payload, "读取 115 文件详情"));
        }
        let data = payload
            .get("data")
            .and_then(Value::as_object)
            .ok_or_else(|| "115 文件详情响应缺少 data 对象".to_string())?;
        let id = value_string(data.get("file_id"))
            .ok_or_else(|| "115 文件详情缺少 file_id".to_string())?;
        let name = value_string(data.get("file_name"))
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "115 文件详情缺少 file_name".to_string())?;
        let path = data
            .get("paths")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let object = item.as_object()?;
                        Some(Cloud115PathNode {
                            id: value_string(object.get("file_id"))?,
                            name: value_string(object.get("file_name")).unwrap_or_default(),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let parent_id = path
            .last()
            .map(|item| item.id.clone())
            .unwrap_or_else(|| "0".to_string());
        Ok(Cloud115FileMetadata {
            id,
            name,
            parent_id,
            is_folder: value_i64(data.get("file_category")) == Some(0),
            file_type: value_string(data.get("file_type"))
                .unwrap_or_default()
                .to_lowercase(),
            size_bytes: value_u64(data.get("size_byte").or_else(|| data.get("file_size")))
                .unwrap_or(0),
            modified_at: value_u64(data.get("utime")).unwrap_or(0),
            duration_seconds: value_f64(data.get("play_long")).unwrap_or(0.0).max(0.0),
            pick_code: value_string(data.get("pick_code")).unwrap_or_default(),
            sha1: value_string(data.get("sha1")).unwrap_or_default(),
            starred: value_i64(data.get("is_mark")) == Some(1),
            path,
        })
    }

    /// 在指定父目录创建空文件夹。
    pub async fn create_folder(
        &self,
        parent_id: &str,
        name: &str,
    ) -> Result<Cloud115FolderResult, String> {
        if parent_id.trim().is_empty() || name.trim().is_empty() {
            return Err("115 父目录 ID 和文件夹名称不能为空".to_string());
        }
        let form = [
            ("pid", parent_id.trim().to_string()),
            ("file_name", name.trim().to_string()),
        ];
        let payload = self
            .authorized_json(
                reqwest::Method::POST,
                &format!("{API_BASE_URL}/open/folder/add"),
                None,
                Some(&form),
            )
            .await?;
        if !state_ok(payload.get("state")) {
            return Err(api_business_error(&payload, "创建 115 文件夹"));
        }
        let data = payload
            .get("data")
            .and_then(Value::as_object)
            .ok_or_else(|| "115 新建文件夹响应缺少 data 对象".to_string())?;
        Ok(Cloud115FolderResult {
            id: value_string(data.get("file_id"))
                .ok_or_else(|| "115 新建文件夹响应缺少 file_id".to_string())?,
            name: value_string(data.get("file_name")).unwrap_or_else(|| name.trim().to_string()),
        })
    }

    /// 更新单个文件或文件夹名称/星标；至少需要提供一项更新内容。
    pub async fn update_file(
        &self,
        file_id: &str,
        name: Option<&str>,
        starred: Option<bool>,
    ) -> Result<(), String> {
        if file_id.trim().is_empty() || (name.is_none() && starred.is_none()) {
            return Err("115 文件 ID 不能为空，且至少需要一项更新内容".to_string());
        }
        let mut form = vec![("file_id", file_id.trim().to_string())];
        if let Some(name) = name {
            if name.trim().is_empty() {
                return Err("115 文件名称不能为空".to_string());
            }
            form.push(("file_name", name.trim().to_string()));
        }
        if let Some(starred) = starred {
            form.push(("star", if starred { "1" } else { "0" }.to_string()));
        }
        self.mutate_files("open/ufile/update", &form, "更新 115 文件")
            .await
    }

    /// 批量移动文件；调用方负责排除移动到自身或子目录的非法目标。
    pub async fn move_files(&self, file_ids: &[String], target_id: &str) -> Result<(), String> {
        let ids = validate_file_ids(file_ids)?;
        if target_id.trim().is_empty() {
            return Err("115 目标目录 ID 不能为空".to_string());
        }
        let form = [("file_ids", ids), ("to_cid", target_id.trim().to_string())];
        self.mutate_files("open/ufile/move", &form, "移动 115 文件")
            .await
    }

    /// 批量复制文件或文件夹；`allow_duplicates=false` 时由 115 拒绝目标目录中的重名项。
    pub async fn copy_files(
        &self,
        file_ids: &[String],
        target_id: &str,
        allow_duplicates: bool,
    ) -> Result<(), String> {
        let ids = validate_file_ids(file_ids)?;
        if target_id.trim().is_empty() {
            return Err("115 目标目录 ID 不能为空".to_string());
        }
        let form = [
            ("pid", target_id.trim().to_string()),
            ("file_id", ids),
            (
                "no_dupli",
                if allow_duplicates { "0" } else { "1" }.to_string(),
            ),
        ];
        self.mutate_files("open/ufile/copy", &form, "复制 115 文件")
            .await
    }

    /// 批量删除文件到 115 回收站。
    pub async fn delete_files(&self, file_ids: &[String]) -> Result<(), String> {
        let form = [("file_ids", validate_file_ids(file_ids)?)];
        self.mutate_files("open/ufile/delete", &form, "删除 115 文件")
            .await
    }

    async fn mutate_files(
        &self,
        path: &str,
        form: &[(&str, String)],
        action: &str,
    ) -> Result<(), String> {
        let payload = self
            .authorized_json(
                reqwest::Method::POST,
                &format!("{API_BASE_URL}/{path}"),
                None,
                Some(form),
            )
            .await?;
        if !state_ok(payload.get("state")) {
            return Err(api_business_error(&payload, action));
        }
        Ok(())
    }

    /// 分页读取 115 回收站；data 中的保留分页字段不会被误解析为条目。
    pub async fn list_recycle_bin(
        &self,
        offset: u64,
        limit: u64,
    ) -> Result<Cloud115RecyclePage, String> {
        if limit == 0 || limit > 200 {
            return Err("115 回收站分页参数无效".to_string());
        }
        let query = [("offset", offset.to_string()), ("limit", limit.to_string())];
        let payload = self
            .authorized_json(
                reqwest::Method::GET,
                &format!("{API_BASE_URL}/open/rb/list"),
                Some(&query),
                None,
            )
            .await?;
        if !state_ok(payload.get("state")) {
            return Err(api_business_error(&payload, "读取 115 回收站"));
        }
        let data = payload
            .get("data")
            .and_then(Value::as_object)
            .ok_or_else(|| "115 回收站响应缺少 data 对象".to_string())?;
        let total = value_u64(data.get("count")).unwrap_or(0);
        let mut entries = Vec::new();
        for (dynamic_id, value) in data {
            if matches!(
                dynamic_id.as_str(),
                "offset" | "limit" | "count" | "rb_pass"
            ) {
                continue;
            }
            let object = value
                .as_object()
                .ok_or_else(|| format!("115 回收站条目 {dynamic_id} 不是对象"))?;
            entries.push(Cloud115RecycleItem {
                id: value_string(object.get("id")).unwrap_or_else(|| dynamic_id.clone()),
                name: value_string(object.get("file_name"))
                    .ok_or_else(|| format!("115 回收站条目 {dynamic_id} 缺少名称"))?,
                is_folder: value_string(object.get("type"))
                    .is_some_and(|value| value == "0" || value == "folder"),
                size_bytes: value_u64(object.get("file_size")).unwrap_or(0),
                deleted_at: value_u64(object.get("dtime")).unwrap_or(0),
                parent_id: value_string(object.get("cid")).unwrap_or_else(|| "0".to_string()),
                parent_name: value_string(object.get("parent_name")).unwrap_or_default(),
            });
        }
        Ok(Cloud115RecyclePage {
            has_more: offset.saturating_add(entries.len() as u64) < total,
            entries,
            total,
            offset,
            limit,
        })
    }

    pub async fn restore_recycle_items(&self, item_ids: &[String]) -> Result<(), String> {
        let form = [("tid", validate_file_ids(item_ids)?)];
        self.mutate_files("open/rb/revert", &form, "恢复 115 回收站条目")
            .await
    }

    pub async fn delete_recycle_items(&self, item_ids: &[String]) -> Result<(), String> {
        let form = [("tid", validate_file_ids(item_ids)?)];
        self.mutate_files("open/rb/del", &form, "彻底删除 115 回收站条目")
            .await
    }

    async fn exchange_token(&self, uid: &str) -> Result<OAuthTokens, String> {
        let response = self
            .client
            .post(format!("{AUTH_BASE_URL}/open/deviceCodeToToken"))
            .form(&[("uid", uid), ("code_verifier", CODE_VERIFIER)])
            .send()
            .await
            .map_err(network_error)?;
        let payload = parse_json_response(response, "换取 115 Token").await?;
        parse_tokens(envelope_data(&payload, "换取 115 Token")?, None)
    }

    async fn access_token(&self) -> Result<String, String> {
        let tokens = load_tokens()?.ok_or_else(|| "115 网盘尚未登录".to_string())?;
        if tokens.expires_at > unix_now()?.saturating_add(300) {
            return Ok(tokens.access_token);
        }
        let _guard = self.refresh_lock.lock().await;
        let current = load_tokens()?.ok_or_else(|| "115 网盘尚未登录".to_string())?;
        if current.expires_at > unix_now()?.saturating_add(300) {
            return Ok(current.access_token);
        }
        let response = self
            .client
            .post(format!("{PASSPORT_BASE_URL}/open/refreshToken"))
            .bearer_auth(&current.access_token)
            .form(&[("refresh_token", current.refresh_token.as_str())])
            .send()
            .await
            .map_err(network_error)?;
        let payload = parse_json_response(response, "刷新 115 Token").await?;
        let refreshed = parse_tokens(envelope_data(&payload, "刷新 115 Token")?, Some(&current))?;
        save_tokens(&refreshed)?;
        Ok(refreshed.access_token)
    }

    /// 控制面限速：在锁内**预约**一个发起时间槽，随即释放锁再执行网络请求。
    ///
    /// 锁只覆盖时间槽预约，不覆盖网络往返：否则一个慢请求会把所有共享限速器的调用
    /// 完全串行化，并发读取（如目录首屏的文件夹 + 文件两路）会被拉长到 2 倍间隔。
    /// 预约制下相邻请求的发起间隔仍 ≥ [`CONTROL_REQUEST_MIN_INTERVAL`]，不产生 burst。
    /// 下载与 OSS 上传的数据流不走此限速，只约束会互相触发的控制 API。
    async fn pace_control_request(&self) {
        {
            let mut last = self.last_control_request.lock().await;
            if let Some(last_instant) = *last {
                let elapsed = last_instant.elapsed();
                if elapsed < CONTROL_REQUEST_MIN_INTERVAL {
                    tokio::time::sleep(CONTROL_REQUEST_MIN_INTERVAL - elapsed).await;
                }
            }
            *last = Some(Instant::now());
            // 锁在此处释放；后续网络请求不再持锁。
        }
    }

    async fn authorized_json(
        &self,
        method: reqwest::Method,
        url: &str,
        query: Option<&[(&str, String)]>,
        form: Option<&[(&str, String)]>,
    ) -> Result<Value, String> {
        self.pace_control_request().await;
        let token = self.access_token().await?;
        let mut request = self.client.request(method.clone(), url).bearer_auth(&token);
        if let Some(query) = query {
            request = request.query(query);
        }
        if let Some(form) = form {
            request = request.form(form);
        }
        let response = request.send().await.map_err(network_error)?;
        let http_unauthorized = response.status() == StatusCode::UNAUTHORIZED;
        let payload = if http_unauthorized {
            None
        } else {
            Some(parse_json_response(response, "调用 115 OpenAPI").await?)
        };
        if !http_unauthorized && !payload.as_ref().is_some_and(payload_requires_refresh) {
            return payload.ok_or_else(|| "115 OpenAPI 响应意外为空".to_string());
        }

        // 对齐 StarVault：HTTP 401、业务码 401* 和 99 都只刷新并重试一次，防止递归风暴。
        let current = load_tokens()?.ok_or_else(|| "115 登录已失效".to_string())?;
        save_tokens(&OAuthTokens {
            expires_at: 0,
            ..current
        })?;
        let refreshed = self.access_token().await?;
        // 重试同样是控制面请求，遵守同一限速间隔。
        self.pace_control_request().await;
        let mut retry = self.client.request(method, url).bearer_auth(refreshed);
        if let Some(query) = query {
            retry = retry.query(query);
        }
        if let Some(form) = form {
            retry = retry.form(form);
        }
        parse_json_response(
            retry.send().await.map_err(network_error)?,
            "重试 115 OpenAPI",
        )
        .await
    }
}

/// 115 常把 Token 失效包装成 HTTP 200 的业务错误，需要在 JSON 层识别。
fn payload_requires_refresh(payload: &Value) -> bool {
    let code = value_i64(
        payload
            .get("code")
            .or_else(|| payload.get("errno"))
            .or_else(|| payload.get("errNo")),
    );
    code.is_some_and(|value| value == 99 || value.to_string().starts_with("401"))
}

fn validate_file_ids(file_ids: &[String]) -> Result<String, String> {
    if file_ids.is_empty()
        || file_ids
            .iter()
            .any(|id| id.trim().is_empty() || id.contains(','))
    {
        return Err("115 文件 ID 列表不能为空且不能包含逗号".to_string());
    }
    Ok(file_ids
        .iter()
        .map(|id| id.trim())
        .collect::<Vec<_>>()
        .join(","))
}

fn auth_poll(
    status: &str,
    message: &str,
    account: Option<Cloud115AccountStatus>,
) -> Cloud115AuthPoll {
    Cloud115AuthPoll {
        status: status.to_string(),
        message: message.to_string(),
        account,
    }
}

/// 生成文件列表公共参数；show_dir 为 Some 时限制为当前目录的文件夹或文件。
///
/// 参数语义对齐 StarVault `OpenFileApiService.listFiles`（已验证实现）：
/// - `custom_order=1` 让 `o` / `asc` 真正生效且文件夹置顶；**缺省该参数时 115 会用
///   账号记忆排序并静默忽略 `o` / `asc`**，分页顺序与前端排序不一致会出现重复或漏项。
/// - `show_dir=1` + `fc_mix=1` + `cur=1` 由服务端返回当前目录的目录与文件混合列表。
/// - `count_folders=1` 让响应 `count` 计入目录，保证混合列表总数口径正确。
fn list_query_params(
    parent_id: &str,
    offset: u64,
    limit: u64,
    show_dir: Option<u8>,
) -> Vec<(&'static str, String)> {
    let mut params = vec![
        ("aid", "1".to_string()),
        ("cid", parent_id.to_string()),
        ("o", "user_utime".to_string()),
        ("asc", "0".to_string()),
        ("custom_order", "1".to_string()),
        ("offset", offset.to_string()),
        ("limit", limit.to_string()),
        ("fc_mix", "1".to_string()),
        ("count_folders", "1".to_string()),
    ];
    if let Some(value) = show_dir {
        params.push(("show_dir", value.to_string()));
        params.push(("cur", "1".to_string()));
    }
    params
}

/// 生成搜索请求参数。
///
/// 搜索端点只接受 `show_dir=1`（对齐 StarVault `OpenFileApiService.searchFiles` 显式传
/// `showDir=1` / `fcMix=1`），**不发送 `cur`**：`cur` 只定义在列表端点的契约里
/// （`1` 仅当前目录 / `0` 允许从根向下遍历），搜索端点的参数表不含它。此前复用
/// [`list_query_params`] 会连带注入 `cur=1`，在全账号搜索（`cid=0`）下可能把范围收窄成
/// 根目录一层。
fn search_query_params(
    cid: &str,
    offset: u64,
    limit: u64,
    query: &str,
) -> Vec<(&'static str, String)> {
    let mut params = list_query_params(cid, offset, limit, None);
    params.push(("show_dir", "1".to_string()));
    params.push(("search_value", query.to_string()));
    params
}

/// 生成全账号收藏列表参数。
///
/// 对齐 StarVault `FilesRepository.listStarred`：`cid=0` + `star=1` + `cur=0` 是 115
/// 开放接口遍历收藏项的固定组合。`cur=1` 由 [`list_query_params`] 带入，这里显式改写为
/// `0`——沿用默认值会让收藏查询退化成「根目录第一层」。
fn starred_query_params(offset: u64, limit: u64) -> Vec<(&'static str, String)> {
    let mut params = list_query_params("0", offset, limit, Some(1));
    for param in params.iter_mut() {
        if param.0 == "cur" {
            param.1 = "0".to_string();
        }
    }
    params.push(("star", "1".to_string()));
    params
}

fn response_count(payload: &Value) -> Result<u64, String> {
    if !state_ok(payload.get("state")) {
        return Err(api_business_error(payload, "读取 115 文件列表"));
    }
    Ok(value_u64(payload.get("count")).unwrap_or(0))
}

fn parse_entries(payload: &Value, parent_id: &str) -> Result<Vec<Cloud115FileEntry>, String> {
    if !state_ok(payload.get("state")) {
        return Err(api_business_error(payload, "读取 115 文件列表"));
    }
    let data = payload
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "115 文件列表响应缺少 data 数组".to_string())?;
    data.iter()
        .enumerate()
        .map(|(index, value)| {
            parse_file_entry(value, parent_id).map_err(|error| {
                let keys = value
                    .as_object()
                    .map(|object| {
                        object
                            .keys()
                            .map(String::as_str)
                            .collect::<Vec<_>>()
                            .join(",")
                    })
                    .unwrap_or_else(|| "<non-object>".to_string());
                format!("115 文件列表第 {index} 项解析失败：{error}；字段：{keys}")
            })
        })
        .collect()
}

/// 解析一页文件列表。
///
/// `has_more` 判定对齐 StarVault `FileListResponse.hasMore()`，顺序为：
/// 1) 本页原始条目数 < limit → 服务端已返回短页，必定到底（不受 count 是否可靠影响）
/// 2) count > 0 时按 `offset + 本页条数 ≥ count` 判定到底
/// 3) 其余保守认为可能还有下一页
///
/// 先看短页再看 count：115 的 `count` 在部分筛选组合下不可靠，只依赖算术语会
/// 在“count 偏大但已返回空页”时让前端无限续页；反过来若 count 偏小则会提前截断。
/// 短页优先可同时规避这两种异常。
fn parse_file_page(
    payload: &Value,
    parent_id: &str,
    offset: u64,
    limit: u64,
) -> Result<Cloud115FilePage, String> {
    let total = response_count(payload)?;
    let entries = parse_entries(payload, parent_id)?;
    // 原始条目数取响应 data 长度，而不是解析成功条数：解析失败项不应让分页提前结束。
    let raw_count = payload
        .get("data")
        .and_then(Value::as_array)
        .map(|items| items.len() as u64)
        .unwrap_or(entries.len() as u64);
    let has_more = if raw_count < limit {
        false
    } else if total > 0 {
        offset.saturating_add(raw_count) < total
    } else {
        true
    };
    Ok(Cloud115FilePage {
        has_more,
        entries,
        total,
        offset,
        limit,
    })
}

fn parse_file_entry(value: &Value, requested_parent_id: &str) -> Result<Cloud115FileEntry, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "115 文件条目不是对象".to_string())?;
    let is_new_list = object.contains_key("fn");
    let is_search = object.contains_key("file_name");
    let name = value_string(
        object
            .get("file_name")
            .or_else(|| object.get("fn"))
            .or_else(|| object.get("n")),
    )
    .filter(|value| !value.is_empty())
    .ok_or_else(|| "115 文件条目缺少名称".to_string())?;
    let inferred_extension = name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_lowercase())
        .unwrap_or_default();
    let is_folder = if is_new_list {
        value_i64(object.get("fc")) == Some(0)
    } else if is_search {
        // search 的 file_category=0 同样会用于普通视频，不能直接当作文件夹。
        value_i64(object.get("file_category")) == Some(0) && inferred_extension.is_empty()
    } else {
        !object.contains_key("fid")
    };
    let id = value_string(
        object
            .get("file_id")
            .or_else(|| object.get("fid"))
            .or_else(|| object.get("cid")),
    )
    .ok_or_else(|| "115 文件条目缺少文件 ID".to_string())?;
    let parent_id = if is_folder {
        value_string(object.get("parent_id").or_else(|| object.get("pid")))
            .unwrap_or_else(|| requested_parent_id.to_string())
    } else {
        value_string(
            object
                .get("parent_id")
                .or_else(|| object.get("pid"))
                .or_else(|| object.get("cid")),
        )
        .unwrap_or_else(|| requested_parent_id.to_string())
    };
    let extension = value_string(object.get("ico"))
        .filter(|value| !value.is_empty())
        .unwrap_or(inferred_extension)
        .to_lowercase();
    // 分类顺序固定为 folder → video → subtitle → image → file：视频与字幕优先于图片，
    // 避免同后缀歧义（如 `ts` 既是视频也是 TypeScript）把已有能力改判成新类型。
    let kind = if is_folder {
        "folder"
    } else if is_video_extension(&extension) {
        "video"
    } else if is_subtitle_extension(&extension) {
        "subtitle"
    } else if is_image_extension(&extension) {
        "image"
    } else {
        "file"
    };
    Ok(Cloud115FileEntry {
        id,
        parent_id,
        name,
        kind: kind.to_string(),
        extension,
        size_bytes: value_u64(object.get("fs").or_else(|| object.get("s"))).unwrap_or(0),
        modified_at: value_u64(
            object
                .get("user_utime")
                .or_else(|| object.get("upt"))
                .or_else(|| object.get("te"))
                .or_else(|| object.get("tp")),
        )
        .unwrap_or(0),
        pick_code: value_string(object.get("pick_code").or_else(|| object.get("pc")))
            .unwrap_or_default(),
        // SHA-1：115 列表在文件上返回 `sha1`，部分响应形态用 `sha`；文件夹两者都没有，
        // 因此落空即空串（不是 None，前端契约按 string 使用）。取值原样保留、不做大小写
        // 归一——归一策略属于去重逻辑，放在解析层会丢掉服务端原始信息。
        sha1: if is_folder {
            String::new()
        } else {
            value_string(object.get("sha1").or_else(|| object.get("sha"))).unwrap_or_default()
        },
        // 缩略图地址：对齐 StarVault，列表响应为 `thumb`，部分响应形态用 `u`；
        // 两种都可能是带签名的 115 CDN 直链。非 http 前缀（如空串/占位）按 None 处理。
        thumb_url: value_string(
            object
                .get("thumb_url")
                .or_else(|| object.get("thumb"))
                .or_else(|| object.get("u")),
        )
        .filter(|value| value.starts_with("http")),
        // fl 是文件标签数组，不是子项列表；OpenAPI 列表响应没有可靠的子项计数。
        children: None,
    })
}

fn parse_tokens(data: &Value, previous: Option<&OAuthTokens>) -> Result<OAuthTokens, String> {
    let access_token = required_string(data, "access_token", "115 Token 响应")?;
    let refresh_token = required_string(data, "refresh_token", "115 Token 响应")?;
    let expires_in = value_u64(data.get("expires_in")).unwrap_or(7200);
    if expires_in == 0 {
        return Err("115 Token 响应的 expires_in 无效".to_string());
    }
    Ok(OAuthTokens {
        access_token,
        refresh_token,
        expires_at: unix_now()?.saturating_add(expires_in),
        user_id: value_u64(data.get("user_id"))
            .or_else(|| previous.map(|value| value.user_id))
            .unwrap_or(0),
        user_name: value_string(data.get("user_name"))
            .or_else(|| previous.map(|value| value.user_name.clone()))
            .unwrap_or_default(),
    })
}

async fn parse_json_response(response: reqwest::Response, action: &str) -> Result<Value, String> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("{action}读取响应失败：{error}"))?;
    if !status.is_success() {
        return Err(format!(
            "{action} HTTP {}：{}",
            status.as_u16(),
            text.chars().take(160).collect::<String>()
        ));
    }
    serde_json::from_str(&text).map_err(|error| format!("{action}响应 JSON 无效：{error}"))
}

fn envelope_data<'a>(payload: &'a Value, action: &str) -> Result<&'a Value, String> {
    if !state_ok(payload.get("state")) {
        return Err(api_business_error(payload, action));
    }
    payload
        .get("data")
        .ok_or_else(|| format!("{action}响应缺少 data"))
}

/// 从 downurl 响应中取出签名直链，兼容 Map 与数组两种 data 形态。
///
/// 115 的 `data` 既可能是 `{file_id: {...}}` 映射，也可能是数组；两种形态下 url 又可能是
/// `{url: "..."}` 嵌套对象或裸字符串，因此逐层兼容。
///
/// - `payload`：downurl 的完整 JSON 响应。
/// - `action`：失败信息前缀，用于区分下载与视频原画两条调用路径。
fn parse_downurl_payload(payload: &Value, action: &str) -> Result<String, String> {
    if !state_ok(payload.get("state")) {
        return Err(api_business_error(payload, action));
    }
    let items: Vec<&Value> = match payload.get("data") {
        Some(Value::Object(values)) => values.values().collect(),
        Some(Value::Array(values)) => values.iter().collect(),
        _ => return Err(format!("{action}响应的 data 结构无效")),
    };
    items
        .into_iter()
        .find_map(|item| {
            item.get("url").and_then(|value| {
                value
                    .get("url")
                    .and_then(Value::as_str)
                    .or_else(|| value.as_str())
            })
        })
        .filter(|value| is_http_url(value))
        .map(str::to_string)
        .ok_or_else(|| format!("{action}响应缺少 HTTP(S) 地址"))
}

/// 解析 `/open/video/play` 的转码档位列表；按画质名去重并保持服务端顺序。
///
/// 115 可能为同一清晰度下发多个签名 URL，重复展示没有意义（StarVault
/// `distinctPlaybackQualities` 同策略），所以在此收敛。画质名优先取 `desc`，其次 `title`，
/// 都缺失时按 `definition` 映射（1 标清 / 2 高清 / 3 超清 / 4 1080P / 5 4K / 100 原画）。
fn parse_playback_options(payload: &Value) -> Result<Vec<Cloud115PlaybackOption>, String> {
    if !state_ok(payload.get("state")) {
        return Err(api_business_error(payload, "解析 115 播放地址"));
    }
    let items = payload
        .get("data")
        .and_then(Value::as_object)
        .and_then(|data| data.get("video_url"))
        .and_then(Value::as_array)
        .ok_or_else(|| "115 视频播放响应缺少 video_url 数组".to_string())?;
    let mut options: Vec<Cloud115PlaybackOption> = Vec::new();
    for item in items {
        let Some(url) = value_string(item.get("url")).filter(|value| is_http_url(value)) else {
            continue;
        };
        let name = value_string(item.get("desc").or_else(|| item.get("title")))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                value_i64(item.get("definition"))
                    .and_then(definition_label)
                    .map(str::to_string)
            })
            .unwrap_or_default();
        // 同档位去重：无名字时退回按 URL 区分，避免把两条无法确认相同的线路合并。
        let duplicated = options.iter().any(|existing| {
            if name.is_empty() || existing.name.is_empty() {
                existing.url == url
            } else {
                existing.name == name
            }
        });
        if !duplicated {
            options.push(Cloud115PlaybackOption { url, name });
        }
    }
    if options.is_empty() {
        return Err("115 视频播放响应缺少 HTTP(S) 地址".to_string());
    }
    Ok(options)
}

/// 115 清晰度编号到展示名称的映射；未知编号返回 None。
fn definition_label(definition: i64) -> Option<&'static str> {
    match definition {
        1 => Some("标清"),
        2 => Some("高清"),
        3 => Some("超清"),
        4 => Some("1080P"),
        5 => Some("4K"),
        100 => Some("原画"),
        _ => None,
    }
}

fn is_http_url(value: &str) -> bool {
    value.starts_with("https://") || value.starts_with("http://")
}

/// 合并两路解析结果，决定播放主线路与后备档位。
///
/// 决策顺序对齐 StarVault：原画成功即为主线路，转码档位降级为后备（不改变首播源）；
/// 原画失败时让第一档转码承担首播，并如实标注画质名；两者都失败才报错，且错误信息
/// 同时保留两条失败原因，便于定位是签名失效还是转码服务不可用。
///
/// - `original`：downurl 原画直链解析结果。
/// - `transcoded`：`/open/video/play` 档位解析结果。
fn compose_playback_source(
    original: Result<String, String>,
    transcoded: Result<Vec<Cloud115PlaybackOption>, String>,
) -> Result<Cloud115PlaybackSource, String> {
    match (original, transcoded) {
        (Ok(url), Ok(options)) => {
            let mut fallback_options: Vec<Cloud115PlaybackOptionView> = Vec::new();
            for option in options {
                // 原画档位若与主线路同址，不应重复出现在后备里；同址只保留首次出现。
                if option.url == url || fallback_options.iter().any(|kept| kept.url == option.url) {
                    continue;
                }
                fallback_options.push(Cloud115PlaybackOptionView {
                    url: option.url,
                    quality: option.name,
                });
            }
            Ok(Cloud115PlaybackSource {
                url,
                user_agent: USER_AGENT.to_string(),
                quality: ORIGINAL_QUALITY.to_string(),
                fallback_options,
            })
        }
        // 原画失败但转码可用：首播交给第一档，不能把画质标成"原画"。
        (Err(original_error), Ok(options)) => {
            // 本项目暂无日志框架，用 eprintln 直接落 stderr，保证降级原因不被吞掉。
            eprintln!("115 原画直链解析失败，降级到转码线路：{original_error}");
            let primary = options
                .first()
                .ok_or_else(|| "115 播放档位为空".to_string())?;
            Ok(Cloud115PlaybackSource {
                url: primary.url.clone(),
                user_agent: USER_AGENT.to_string(),
                quality: if primary.name.is_empty() {
                    // 服务端未给档位名时，明确表达"转码档位"而不是冒充原画。
                    "转码".to_string()
                } else {
                    primary.name.clone()
                },
                fallback_options: options
                    .iter()
                    .skip(1)
                    .map(|option| Cloud115PlaybackOptionView {
                        url: option.url.clone(),
                        quality: option.name.clone(),
                    })
                    .collect(),
            })
        }
        // 原画可用就足够播放，转码档位只是"锦上添花"的后备：此处不得因为后备失效
        // 而拒绝可用的原画线路。降级信息同样要留痕，不能静默。
        (Ok(url), Err(transcoded_error)) => {
            eprintln!("115 转码档位解析失败，仅提供原画线路：{transcoded_error}");
            Ok(Cloud115PlaybackSource {
                url,
                user_agent: USER_AGENT.to_string(),
                quality: ORIGINAL_QUALITY.to_string(),
                fallback_options: Vec::new(),
            })
        }
        (Err(original_error), Err(transcoded_error)) => Err(format!(
            "115 视频播放地址解析失败：原画直链不可用（{original_error}）；转码档位不可用（{transcoded_error}）"
        )),
    }
}

fn api_business_error(payload: &Value, action: &str) -> String {
    let message = value_string(payload.get("message").or_else(|| payload.get("error")))
        .unwrap_or_else(|| "未知业务错误".to_string());
    let code = value_i64(
        payload
            .get("code")
            .or_else(|| payload.get("errno"))
            .or_else(|| payload.get("errNo")),
    )
    .unwrap_or(0);
    format!("{action}失败（{code}）：{message}")
}

fn state_ok(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true))) || value_i64(value) == Some(1)
}

fn required_string(value: &Value, key: &str, context: &str) -> Result<String, String> {
    value_string(value.get(key))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{context}缺少 {key}"))
}

fn value_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn value_u64(value: Option<&Value>) -> Option<u64> {
    value_string(value).and_then(|value| value.parse().ok())
}
fn value_i64(value: Option<&Value>) -> Option<i64> {
    value_string(value).and_then(|value| value.parse().ok())
}
fn value_f64(value: Option<&Value>) -> Option<f64> {
    value_string(value).and_then(|value| value.parse().ok())
}

/// 从 rt_space_info 的指定容量节点读取原始字节数；缺失的可选容量信息按零返回。
fn nested_size(space: &Value, key: &str) -> u64 {
    value_u64(space.get(key).and_then(|item| item.get("size"))).unwrap_or(0)
}

/// 从 rt_space_info 的指定容量节点读取 115 提供的格式化文本。
fn nested_size_format(space: &Value, key: &str) -> String {
    value_string(space.get(key).and_then(|item| item.get("size_format"))).unwrap_or_default()
}

/// 严格解析 STS 凭证，避免缺字段时把无效密钥传给后续 OSS 请求。
fn parse_upload_credentials(data: &Value) -> Result<Cloud115UploadCredentials, String> {
    let endpoint = required_string(data, "endpoint", "115 上传凭证")?;
    if !endpoint.starts_with("https://") && !endpoint.starts_with("http://") {
        return Err("115 上传凭证 endpoint 不是受支持的 HTTP(S) 地址".to_string());
    }
    let _expiration = required_string(data, "Expiration", "115 上传凭证")?;
    Ok(Cloud115UploadCredentials {
        endpoint,
        access_key_id: required_string(data, "AccessKeyId", "115 上传凭证")?,
        access_key_secret: required_string(data, "AccessKeySecret", "115 上传凭证")?,
        security_token: required_string(data, "SecurityToken", "115 上传凭证")?,
    })
}

/// 解析上传调度结果，并兼容 callback 的对象或数组形态。
fn parse_upload_init(data: &Value) -> Result<Cloud115UploadInit, String> {
    let status =
        value_i64(data.get("status")).ok_or_else(|| "115 上传初始化响应缺少 status".to_string())?;
    let callback = match data.get("callback") {
        Some(Value::Array(items)) => items.first().unwrap_or(&Value::Null),
        Some(value) => value,
        None => &Value::Null,
    };
    Ok(Cloud115UploadInit {
        status,
        sign_key: value_string(data.get("sign_key")).unwrap_or_default(),
        sign_check: value_string(data.get("sign_check")).unwrap_or_default(),
        bucket: value_string(data.get("bucket")).unwrap_or_default(),
        object_key: value_string(data.get("object")).unwrap_or_default(),
        callback: value_string(callback.get("callback")).unwrap_or_default(),
        callback_var: value_string(callback.get("callback_var")).unwrap_or_default(),
        pick_code: value_string(data.get("pick_code")).unwrap_or_default(),
    })
}

/// 返回字节内容的大写 SHA-1，用于 115 的 fileid/preid/sign_val 协议字段。
fn sha1_upper(bytes: &[u8]) -> String {
    format!("{:X}", Sha1::digest(bytes))
}

/// 解析 115 `start-end` 闭区间并验证其完全落在当前文件内。
fn parse_sign_check_range(value: &str, file_len: usize) -> Result<(usize, usize), String> {
    let (start, end) = value
        .split_once('-')
        .ok_or_else(|| "115 sign_check 不是 start-end 格式".to_string())?;
    let start = start
        .parse::<usize>()
        .map_err(|_| "115 sign_check 起点无效".to_string())?;
    let end = end
        .parse::<usize>()
        .map_err(|_| "115 sign_check 终点无效".to_string())?;
    if file_len == 0 || start > end || end >= file_len {
        return Err("115 sign_check 超出文件范围".to_string());
    }
    Ok((start, end))
}

/// 从磁盘指定偏移读取精确长度的字节；短读视为文件被并发修改。
fn read_file_range(path: &Path, offset: u64, length: usize) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|error| format!("打开上传文件失败：{error}"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("定位上传文件偏移失败：{error}"))?;
    let mut buffer = vec![0u8; length];
    file.read_exact(&mut buffer)
        .map_err(|error| format!("读取上传文件分块失败：{error}"))?;
    Ok(buffer)
}

/// 单次流式扫描同时得到整文件 SHA-1、首 128 KiB preid SHA-1 与文件大小，避免大文件读两遍磁盘。
fn compute_upload_digests(path: &Path) -> Result<(String, String, u64), String> {
    let metadata =
        std::fs::metadata(path).map_err(|error| format!("读取上传文件信息失败：{error}"))?;
    if !metadata.is_file() {
        return Err("上传源路径不是普通文件".to_string());
    }
    if metadata.len() == 0 {
        return Err("不能上传空文件".to_string());
    }
    let mut file = File::open(path).map_err(|error| format!("打开上传文件失败：{error}"))?;
    let mut full_hasher = Sha1::new();
    let mut pre_hasher = Sha1::new();
    let mut remaining_pre = PRE_SHA1_SAMPLE_BYTES;
    let mut buffer = vec![0u8; 512 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("读取上传文件失败：{error}"))?;
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        full_hasher.update(chunk);
        if remaining_pre > 0 {
            let take = read.min(remaining_pre);
            pre_hasher.update(&chunk[..take]);
            remaining_pre -= take;
        }
    }
    Ok((
        format!("{:X}", full_hasher.finalize()),
        format!("{:X}", pre_hasher.finalize()),
        metadata.len(),
    ))
}

/// 生成 virtual-hosted-style OSS 对象 URL，并逐段编码 object key。
fn oss_object_url(
    credentials: &Cloud115UploadCredentials,
    init: &Cloud115UploadInit,
) -> Result<Url, String> {
    let mut url = Url::parse(credentials.endpoint.trim_end_matches('/'))
        .map_err(|error| format!("115 OSS endpoint 无效：{error}"))?;
    let host = url
        .host_str()
        .ok_or_else(|| "115 OSS endpoint 缺少主机名".to_string())?;
    url.set_host(Some(&format!("{}.{}", init.bucket, host)))
        .map_err(|_| "115 OSS bucket 主机名无效".to_string())?;
    url.path_segments_mut()
        .map_err(|_| "115 OSS endpoint 不能作为分层 URL".to_string())?
        .extend(init.object_key.split('/'));
    Ok(url)
}

/// 使用 URL 编码生成 OSS 子资源查询串；调用方按参数名排序传入。
fn oss_query(pairs: &[(&str, String)]) -> String {
    let mut url = Url::parse("https://oss.invalid/").expect("static OSS query URL should parse");
    url.query_pairs_mut()
        .clear()
        .extend_pairs(pairs.iter().map(|(key, value)| (*key, value.as_str())));
    url.query().unwrap_or_default().to_string()
}

/// 从简单 OSS XML 响应中读取单个元素；multipart UploadId 不允许空值。
fn xml_element(xml: &str, name: &str) -> Option<String> {
    let start_tag = format!("<{name}>");
    let end_tag = format!("</{name}>");
    let start = xml.find(&start_tag)? + start_tag.len();
    let end = xml[start..].find(&end_tag)? + start;
    let value = xml[start..end].trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// 生成 CompleteMultipartUpload XML；ETag 取自 OSS 响应头并执行 XML 转义。
fn complete_multipart_xml(parts: &[(usize, String)]) -> String {
    let mut xml = String::from("<CompleteMultipartUpload>");
    for (number, etag) in parts {
        xml.push_str("<Part><PartNumber>");
        xml.push_str(&number.to_string());
        xml.push_str("</PartNumber><ETag>");
        xml.push_str(&xml_escape(etag));
        xml.push_str("</ETag></Part>");
    }
    xml.push_str("</CompleteMultipartUpload>");
    xml
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// 按 Aliyun OSS V1 协议生成 Authorization，不记录参与签名的敏感数据。
fn oss_authorization(
    access_key_id: &str,
    access_key_secret: &str,
    string_to_sign: &[u8],
) -> Result<String, String> {
    let mut mac = Hmac::<Sha1>::new_from_slice(access_key_secret.as_bytes())
        .map_err(|_| "115 OSS AccessKeySecret 无效".to_string())?;
    mac.update(string_to_sign);
    Ok(format!(
        "OSS {access_key_id}:{}",
        STANDARD.encode(mac.finalize().into_bytes())
    ))
}

/// 限制 OSS 错误正文长度，既保留诊断信息，也避免把完整服务响应写入界面。
async fn oss_response_error(response: reqwest::Response) -> String {
    let status = response.status();
    match response.text().await {
        Ok(text) => format!(
            "115 OSS 上传 HTTP {}：{}",
            status.as_u16(),
            text.chars().take(240).collect::<String>()
        ),
        Err(error) => format!(
            "115 OSS 上传 HTTP {}，读取错误响应失败：{error}",
            status.as_u16()
        ),
    }
}

/// OSS 使用 203 表示 callback 失败，不能沿用 HTTP 通用的 2xx 成功判定。
fn oss_status_ok(status: StatusCode) -> bool {
    status == StatusCode::OK || status == StatusCode::NO_CONTENT
}
fn unix_now() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .map_err(|error| format!("系统时间无效：{error}"))
}
fn unix_millis() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .map_err(|error| format!("系统时间无效：{error}"))
}
fn network_error(error: reqwest::Error) -> String {
    format!("连接 115 服务失败：{error}")
}
fn is_video_extension(extension: &str) -> bool {
    matches!(
        extension,
        "mkv" | "mp4" | "mov" | "avi" | "webm" | "m4v" | "ts" | "m2ts"
    )
}
fn is_subtitle_extension(extension: &str) -> bool {
    matches!(extension, "srt" | "ass" | "ssa" | "vtt" | "sub")
}

/// 判断扩展名是否为图片；`extension` 必须已小写（`parse_file_entry` 已归一）。
///
/// 覆盖 115 网盘常见位图格式与 WebView 可直接渲染的 svg：
/// - 位图：jpg/jpeg/png/gif/bmp/webp/heic/heif/tiff/tif
/// - 矢量：svg
///
/// 注意：heic/heif/tiff 依赖系统解码能力，WebKit 可能拒绝渲染；调用方必须按
/// 「原图加载失败 → 回退缩略图」处理，不能假定这里声明的类型一定可显示。
///
/// @param extension 小写扩展名（不含点），空串返回 false
/// @return 是图片返回 true
fn is_image_extension(extension: &str) -> bool {
    matches!(
        extension,
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "heic" | "heif" | "tiff" | "tif" | "svg"
    )
}

/// 组装下载进度数值；远端大小未知时省略 total_bytes。
fn download_progress_update(transferred_bytes: u64, expected_size_bytes: u64) -> TransferUpdate {
    TransferUpdate {
        transferred_bytes: Some(transferred_bytes),
        total_bytes: (expected_size_bytes > 0).then_some(expected_size_bytes),
        ..TransferUpdate::default()
    }
}

/// 在一个 multipart 分片完成后上报 transferring；速度按上次上报以来的字节差与耗时估算。
fn report_multipart_progress(
    progress: &TransferReporter,
    completed_parts: u64,
    total_parts: u64,
    file_size: u64,
    part_size: u64,
    last_progress: &mut Option<(Instant, u64)>,
) {
    let transferred = std::cmp::min(completed_parts * part_size, file_size);
    let speed = match last_progress.replace((Instant::now(), transferred)) {
        Some((last_at, last_bytes)) => {
            speed_bytes_per_sec(transferred.saturating_sub(last_bytes), last_at.elapsed())
        }
        None => None,
    };
    progress.report(
        TransferStage::Transferring,
        TransferUpdate {
            completed_parts: Some(completed_parts),
            total_parts: Some(total_parts),
            transferred_bytes: Some(transferred),
            total_bytes: Some(file_size),
            speed_bytes_per_sec: speed,
        },
    );
}

/// 开发构建会频繁改变二进制签名，使用权限为 0600 的用户临时文件避免钥匙串反复询问。
#[cfg(debug_assertions)]
fn load_tokens() -> Result<Option<OAuthTokens>, String> {
    let path = std::env::temp_dir().join(DEV_TOKEN_FILE);
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("开发模式 115 Token 无效：{error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取开发模式 115 Token 失败：{error}")),
    }
}

#[cfg(debug_assertions)]
fn save_tokens(tokens: &OAuthTokens) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let path = std::env::temp_dir().join(DEV_TOKEN_FILE);
    let temporary_path = path.with_extension(format!("tmp-{}", std::process::id()));
    let bytes =
        serde_json::to_vec(tokens).map_err(|error| format!("序列化 115 Token 失败：{error}"))?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&temporary_path)
        .map_err(|error| format!("创建开发模式 115 Token 文件失败：{error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("写入开发模式 115 Token 失败：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("同步开发模式 115 Token 失败：{error}"))?;
    std::fs::rename(&temporary_path, &path)
        .map_err(|error| format!("保存开发模式 115 Token 失败：{error}"))
}

#[cfg(debug_assertions)]
fn delete_tokens() -> Result<(), String> {
    let path = std::env::temp_dir().join(DEV_TOKEN_FILE);
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除开发模式 115 Token 失败：{error}")),
    }
}

#[cfg(all(not(debug_assertions), target_os = "macos"))]
fn load_tokens() -> Result<Option<OAuthTokens>, String> {
    match security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("钥匙串中的 115 Token 无效：{error}")),
        Err(error) if error.code() == -25300 => Ok(None),
        Err(error) => Err(format!("读取 macOS 钥匙串失败：{error}")),
    }
}

#[cfg(all(not(debug_assertions), target_os = "macos"))]
fn save_tokens(tokens: &OAuthTokens) -> Result<(), String> {
    let bytes =
        serde_json::to_vec(tokens).map_err(|error| format!("序列化 115 Token 失败：{error}"))?;
    security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, &bytes)
        .map_err(|error| format!("保存 115 Token 到 macOS 钥匙串失败：{error}"))
}

#[cfg(all(not(debug_assertions), target_os = "macos"))]
fn delete_tokens() -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    {
        Ok(()) => Ok(()),
        Err(error) if error.code() == -25300 => Ok(()),
        Err(error) => Err(format!("从 macOS 钥匙串删除 115 Token 失败：{error}")),
    }
}

#[cfg(not(target_os = "macos"))]
compile_error!("Cloud115Provider 当前只允许在已接入系统密钥环的 macOS 构建");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_remote_file_name_rejects_path_traversal() {
        assert_eq!(sanitize_remote_file_name("movie.mkv").unwrap(), "movie.mkv");
        assert!(sanitize_remote_file_name("../evil.mkv").is_err());
        assert!(sanitize_remote_file_name("a/b.mkv").is_err());
        assert!(sanitize_remote_file_name("a\\b.mkv").is_err());
        assert!(sanitize_remote_file_name("..").is_err());
        assert!(sanitize_remote_file_name("   ").is_err());
    }

    /// 在系统临时目录生成确定内容的测试文件；调用方负责删除。
    fn write_temp_fixture(name: &str, bytes: &[u8]) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("sirius-cloud115-{}-{name}", std::process::id()));
        std::fs::write(&path, bytes).expect("写入上传测试文件");
        path
    }

    #[test]
    fn read_file_range_reads_exact_window_and_rejects_overread() {
        let bytes: Vec<u8> = (0..=255u8).cycle().take(256_000).collect();
        let path = write_temp_fixture("range", &bytes);
        assert_eq!(read_file_range(&path, 3, 5).unwrap(), bytes[3..8]);
        assert_eq!(
            read_file_range(&path, 255_995, 5).unwrap(),
            bytes[255_995..]
        );
        assert_eq!(read_file_range(&path, 0, bytes.len()).unwrap(), bytes);
        // 超出文件长度的读取必须失败，防止把截断文件当成完整数据上传。
        assert!(read_file_range(&path, 255_000, 2_000).is_err());
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn compute_upload_digests_matches_in_memory_sha1() {
        // 400 KiB 覆盖 preid 128 KiB 截断边界与 512 KiB 缓冲内的多次读取。
        let mut bytes: Vec<u8> = Vec::with_capacity(400_000);
        let mut value = 7u8;
        for _ in 0..400_000 {
            bytes.push(value);
            value = value.wrapping_mul(31).wrapping_add(17);
        }
        let path = write_temp_fixture("digest", &bytes);
        let (file_sha1, pre_sha1, file_size) = compute_upload_digests(&path).unwrap();
        assert_eq!(file_sha1, sha1_upper(&bytes));
        assert_eq!(pre_sha1, sha1_upper(&bytes[..PRE_SHA1_SAMPLE_BYTES]));
        assert_eq!(file_size, bytes.len() as u64);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn compute_upload_digests_rejects_empty_file() {
        let path = write_temp_fixture("empty", &[]);
        assert!(compute_upload_digests(&path).is_err());
        std::fs::remove_file(&path).unwrap();
    }

    /// 从服务端指定分类中选择一个真实文件，供各 OpenAPI 集成测试复用。
    async fn live_search_entry(
        provider: &Cloud115Provider,
        search_value: &str,
        file_type: u8,
    ) -> Cloud115FileEntry {
        let mut params = list_query_params("0", 0, 20, None);
        params.push(("search_value", search_value.to_string()));
        params.push(("type", file_type.to_string()));
        let payload = provider
            .authorized_json(
                reqwest::Method::GET,
                &format!("{API_BASE_URL}/open/ufile/search"),
                Some(&params),
                None,
            )
            .await
            .expect("categorized search should succeed");
        parse_entries(&payload, "0")
            .expect("categorized search should parse")
            .into_iter()
            .find(|entry| !entry.pick_code.is_empty())
            .expect("search should return a file with pick_code")
    }

    async fn live_pick_code(
        provider: &Cloud115Provider,
        search_value: &str,
        file_type: u8,
    ) -> String {
        live_search_entry(provider, search_value, file_type)
            .await
            .pick_code
    }

    async fn live_video_pick_code(provider: &Cloud115Provider) -> String {
        live_pick_code(provider, ".mp4", 4).await
    }

    /// 回收站写入存在短暂最终一致性，有限轮询避免把正常同步延迟误判为接口失败。
    async fn wait_for_recycle_item(provider: &Cloud115Provider, name: &str) -> Cloud115RecycleItem {
        for _ in 0..10 {
            let page = provider
                .list_recycle_bin(0, 200)
                .await
                .expect("recycle list should succeed");
            if let Some(item) = page.entries.into_iter().find(|item| item.name == name) {
                return item;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        panic!("recycled test folder should become visible");
    }

    /// 115 恢复成功后可能短暂返回 990019；仅测试清理阶段有限重试该明确的同步状态。
    async fn wait_until_test_folder_can_delete(provider: &Cloud115Provider, file_id: &str) {
        for _ in 0..10 {
            match provider.delete_files(&[file_id.to_string()]).await {
                Ok(()) => return,
                Err(error) if error.contains("990019") => {
                    std::thread::sleep(Duration::from_millis(500))
                }
                Err(error) => panic!("restored test folder delete failed: {error}"),
            }
        }
        panic!("restored test folder remained busy after bounded retries");
    }

    #[test]
    fn parses_folder_and_video_entries() {
        let folder = serde_json::json!({"cid":"42","pid":"0","n":"电影","fl":["1","2"]});
        let video = serde_json::json!({"fid":"8","cid":"42","n":"Arrival.mkv","ico":"mkv","s":"1024","te":"1700000000","pc":"pick","thumb":"https://thumb.example/8.jpg"});
        let folder = parse_file_entry(&folder, "0").expect("folder should parse");
        let video = parse_file_entry(&video, "42").expect("video should parse");
        assert_eq!(folder.kind, "folder");
        assert_eq!(folder.parent_id, "0");
        assert_eq!(folder.children, None);
        assert_eq!(video.kind, "video");
        assert_eq!(video.parent_id, "42");
        assert_eq!(video.size_bytes, 1024);
        assert_eq!(video.pick_code, "pick");
        // 缩略图地址原样保留；无缩略图的条目为 None。
        assert_eq!(
            video.thumb_url.as_deref(),
            Some("https://thumb.example/8.jpg")
        );
        assert_eq!(folder.thumb_url, None);
    }

    /// 图片分类：新列表（`fn`/`ico`）、旧列表（`n`/后缀推断）两条路径都要归为 image。
    #[test]
    fn classifies_image_entries() {
        let payload = serde_json::json!({
            "state": true,
            "code": 0,
            "count": 3,
            "data": [
                {"fn": "IMG_0001.jpg", "fc": 1, "fid": "21", "cid": "0", "ico": "jpg"},
                {"fn": "截图.png", "fc": 1, "fid": "22", "cid": "0", "ico": "png"},
                {"fn": "矢量.svg", "fc": 1, "fid": "23", "cid": "0", "ico": "svg"}
            ]
        });
        let page = parse_file_page(&payload, "0", 0, 100).expect("image page should parse");
        assert_eq!(page.entries.len(), 3);
        for entry in &page.entries {
            assert_eq!(entry.kind, "image", "{} 应归为图片", entry.name);
        }

        // 旧列表形态没有 `ico`：必须从文件名后缀推断，同样归为 image。
        let legacy = serde_json::json!({"n": "旅行.JPEG", "fid": "24", "cid": "0"});
        let legacy = parse_file_entry(&legacy, "0").expect("legacy image should parse");
        assert_eq!(legacy.kind, "image");
        assert_eq!(legacy.extension, "jpeg");
    }

    /// 大小写不敏感：115 的 `ico` 与文件名后缀都可能是大写，分类结果不受影响。
    #[test]
    fn classifies_image_extension_case_insensitively() {
        let payload = serde_json::json!({
            "state": true,
            "code": 0,
            "count": 3,
            "data": [
                {"fn": "A.WEBP", "fc": 1, "fid": "31", "cid": "0", "ico": "WEBP"},
                {"fn": "B.HEIC", "fc": 1, "fid": "32", "cid": "0"},
                {"fn": "无扩展名", "fc": 1, "fid": "33", "cid": "0", "ico": "TIFF"}
            ]
        });
        let page = parse_file_page(&payload, "0", 0, 100).expect("image page should parse");
        assert_eq!(page.entries[0].kind, "image");
        assert_eq!(page.entries[0].extension, "webp");
        assert_eq!(page.entries[1].kind, "image");
        assert_eq!(page.entries[1].extension, "heic");
        // `ico` 优先于文件名：即使文件名没有后缀也按服务端类型分类。
        assert_eq!(page.entries[2].kind, "image");
    }

    /// 非图片回落 file：文本、压缩包、无后缀文件都不能被误判为 image。
    #[test]
    fn non_image_entries_stay_file() {
        let payload = serde_json::json!({
            "state": true,
            "code": 0,
            "count": 4,
            "data": [
                {"fn": "笔记.txt", "fc": 1, "fid": "41", "cid": "0"},
                {"fn": "打包.zip", "fc": 1, "fid": "42", "cid": "0"},
                {"fn": "无后缀", "fc": 1, "fid": "43", "cid": "0", "ico": ""},
                {"fn": "readme", "fc": 1, "fid": "44", "cid": "0"}
            ]
        });
        let page = parse_file_page(&payload, "0", 0, 100).expect("plain page should parse");
        for entry in &page.entries {
            assert_eq!(entry.kind, "file", "{} 不应归为图片", entry.name);
        }
    }

    /// 分类顺序约束：视频/字幕优先于图片，`ts` 作为视频不能被图片规则抢走；
    /// `srt` 仍是字幕而不是图片。
    #[test]
    fn video_and_subtitle_win_over_image_classification() {
        let payload = serde_json::json!({
            "state": true,
            "code": 0,
            "count": 2,
            "data": [
                {"fn": "clip.ts", "fc": 1, "fid": "51", "cid": "0", "ico": "ts"},
                {"fn": "Arrival.chs.srt", "fc": 1, "fid": "52", "cid": "0", "ico": "srt"}
            ]
        });
        let page = parse_file_page(&payload, "0", 0, 100).expect("media page should parse");
        assert_eq!(page.entries[0].kind, "video");
        assert_eq!(page.entries[1].kind, "subtitle");
    }

    /// 单次 show_dir=1 + fc_mix=1 请求返回目录与文件混合列表：
    /// 必须按 fc/fid 正确区分两类条目，且总数取 115 返回的 count。
    #[test]
    fn parses_mixed_folder_and_file_listing() {
        let payload = serde_json::json!({
            "state": true,
            "code": 0,
            "count": 2,
            "data": [
                {"fn": "电影", "fc": 0, "cid": "42", "pid": "0"},
                {"fn": "Arrival.mkv", "fc": 1, "fid": "8", "cid": "42", "s": "1024", "ico": "mkv"}
            ]
        });
        let page = parse_file_page(&payload, "0", 0, 100).expect("mixed page should parse");
        assert_eq!(page.total, 2);
        assert_eq!(page.entries.len(), 2);
        assert_eq!(page.entries[0].kind, "folder");
        assert_eq!(page.entries[0].name, "电影");
        assert_eq!(page.entries[1].kind, "video");
        assert_eq!(page.entries[1].name, "Arrival.mkv");
        assert!(!page.has_more);
    }

    // -----------------------------------------------------------------------
    // 文件 SHA-1：解析口径与大小写策略
    // -----------------------------------------------------------------------

    /// `sha1` 字段优先，且必须原样保留大小写（大小写归一是去重逻辑的职责）。
    #[test]
    fn parses_sha1_preserving_server_case() {
        let payload = serde_json::json!({
            "state": true, "code": 0, "count": 1,
            "data": [{
                "fn": "movie.mkv", "fc": 1, "fid": "9", "cid": "0",
                "sha1": "A1B2C3d4E5f60718293a4b5c6d7e8f9012345678"
            }]
        });
        let page = parse_file_page(&payload, "0", 0, 100).unwrap();
        assert_eq!(
            page.entries[0].sha1,
            "A1B2C3d4E5f60718293a4b5c6d7e8f9012345678"
        );
    }

    /// 部分响应形态只给 `sha`，必须回退解析，否则去重会整目录失效。
    #[test]
    fn parses_sha1_falling_back_to_sha_field() {
        let payload = serde_json::json!({
            "state": true, "code": 0, "count": 1,
            "data": [{"fn": "clip.mp4", "fc": 1, "fid": "10", "cid": "0", "sha": "deadBEEF"}]
        });
        let page = parse_file_page(&payload, "0", 0, 100).unwrap();
        assert_eq!(page.entries[0].sha1, "deadBEEF");
    }

    /// 文件夹没有内容摘要：契约上必须是空串（不是 None），前端类型按 string 使用。
    #[test]
    fn folder_entries_have_empty_sha1() {
        let payload = serde_json::json!({
            "state": true, "code": 0, "count": 2,
            "data": [
                {"fn": "电影", "fc": 0, "cid": "42", "pid": "0", "sha1": "should-be-ignored"},
                {"fn": "plain.txt", "fc": 1, "fid": "11", "cid": "42"}
            ]
        });
        let page = parse_file_page(&payload, "0", 0, 100).unwrap();
        assert_eq!(page.entries[0].kind, "folder");
        assert_eq!(page.entries[0].sha1, "");
        // 完全没有 sha1 / sha 的文件同样落空串。
        assert_eq!(page.entries[1].sha1, "");
    }

    /// 收藏列表参数：`star=1` + `cur=0` + `cid=0` 是 115 遍历全账号收藏的固定组合。
    ///
    /// `cur` 必须被改写为 0：目录列表用 `cur=1`（仅当前目录），收藏遍历要求 `cur=0`
    /// （允许从根向下），沿用默认值会让收藏查询退化成"根目录第一层"。
    /// 断言直接针对 [`starred_query_params`]——与 `list_starred_files` 共用同一份装配，
    /// 避免测试复刻实现导致改写逻辑被删除后仍然通过。
    #[test]
    fn starred_params_use_star_and_traverse_from_root() {
        let params = starred_query_params(0, 100);
        let find = |key: &str| {
            params
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(find("cid"), Some("0"));
        assert_eq!(find("star"), Some("1"));
        assert_eq!(find("cur"), Some("0"));
        assert_eq!(find("show_dir"), Some("1"));
        assert_eq!(find("limit"), Some("100"));
    }

    /// 搜索参数：必须带 `show_dir=1` 与 `search_value`，且**不得带 `cur`**。
    ///
    /// 对齐 StarVault `OpenFileApiService.searchFiles`：`cur` 只属于列表端点契约
    /// （1=仅当前目录 / 0=允许从根遍历），搜索端点参数表不含它。此前复用
    /// `list_query_params(.., Some(1))` 会连带注入 `cur=1`，在 `cid=0` 的全账号搜索下
    /// 可能把范围收窄成根目录一层。
    #[test]
    fn search_params_omit_cur_and_keep_show_dir() {
        let params = search_query_params("0", 0, 50, "needle");
        let find = |key: &str| {
            params
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(find("cid"), Some("0"));
        assert_eq!(find("show_dir"), Some("1"));
        assert_eq!(find("search_value"), Some("needle"));
        assert_eq!(find("custom_order"), Some("1"));
        assert_eq!(find("fc_mix"), Some("1"));
        assert!(
            !params.iter().any(|(name, _)| *name == "cur"),
            "搜索请求不得携带 cur，实际参数：{params:?}"
        );
    }

    /// 全账号搜索的空关键词必须拒绝：115 对空 search_value 返回空列表，
    /// 静默返回空结果会被误读成"没有匹配文件"。
    #[tokio::test]
    async fn global_search_rejects_empty_query() {
        let provider = Cloud115Provider::new().expect("构造测试用 provider");
        let error = provider.search_files(0, 50, "   ").await.unwrap_err();
        assert!(error.contains("不能为空"), "实际错误：{error}");
    }

    /// 列表请求参数必须对齐 StarVault 已验证实现：
    /// `custom_order=1` 是让 `o` / `asc` 生效的前提，缺省时 115 会用账号记忆排序
    /// 并静默忽略排序参数，导致分页顺序与前端排序不一致。
    #[test]
    fn list_params_align_with_starvault() {
        let params = list_query_params("42", 0, 100, Some(1));
        let find = |key: &str| {
            params
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(find("aid"), Some("1"));
        assert_eq!(find("cid"), Some("42"));
        assert_eq!(find("custom_order"), Some("1"));
        assert_eq!(find("fc_mix"), Some("1"));
        assert_eq!(find("count_folders"), Some("1"));
        assert_eq!(find("show_dir"), Some("1"));
        assert_eq!(find("cur"), Some("1"));
        assert_eq!(find("o"), Some("user_utime"));
        assert_eq!(find("asc"), Some("0"));
    }

    /// 分页到底判定：短页（本页条数 < limit）必须优先于 count 算术，
    /// 否则 count 不可靠时会重复请求同一页或无限续页。
    #[test]
    fn page_has_more_prioritises_short_page() {
        // 短页 + count 偏大（声称还有 999 条）→ 仍然到底。
        let short_page = serde_json::json!({
            "state": true,
            "code": 0,
            "count": 999,
            "data": [{"fn": "a.txt", "fc": 1, "fid": "1", "cid": "0", "s": "1"}]
        });
        let page = parse_file_page(&short_page, "0", 0, 100).expect("short page should parse");
        assert!(!page.has_more, "短页必须判定为到底，不受 count 影响");

        // 满页 + count 大于已取数目 → 还有下一页。
        let full_data: Vec<Value> = (0..100)
            .map(|index| {
                serde_json::json!({"fn": format!("f{index}.txt"), "fc": 1, "fid": index.to_string(), "cid": "0", "s": "1"})
            })
            .collect();
        let full_page = serde_json::json!({
            "state": true, "code": 0, "count": 250, "data": full_data
        });
        let page = parse_file_page(&full_page, "0", 0, 100).expect("full page should parse");
        assert!(page.has_more);
        assert_eq!(page.total, 250);

        // 满页且已取满 count → 到底。
        let last_page = serde_json::json!({
            "state": true, "code": 0, "count": 150,
            "data": (0..100).map(|index| {
                serde_json::json!({"fn": format!("f{index}.txt"), "fc": 1, "fid": index.to_string(), "cid": "0", "s": "1"})
            }).collect::<Vec<Value>>()
        });
        let page = parse_file_page(&last_page, "0", 100, 100).expect("last page should parse");
        assert!(!page.has_more, "offset+本页条数 已达 count 时应到底");
    }

    /// 缩略图字段：`thumb` 优先，回退 `u`；非 http 前缀按缺失处理。
    #[test]
    fn parses_thumbnail_from_thumb_and_u_fields() {
        let thumb_payload = serde_json::json!({
            "state": true, "code": 0, "count": 1,
            "data": [{"fn": "a.jpg", "fc": 1, "fid": "1", "cid": "0", "thumb": "https://thumb.115.com/a_100"}]
        });
        let page = parse_file_page(&thumb_payload, "0", 0, 100).unwrap();
        assert_eq!(
            page.entries[0].thumb_url.as_deref(),
            Some("https://thumb.115.com/a_100")
        );

        let u_payload = serde_json::json!({
            "state": true, "code": 0, "count": 1,
            "data": [{"fn": "b.jpg", "fc": 1, "fid": "2", "cid": "0", "u": "https://thumb.115.com/b_100"}]
        });
        let page = parse_file_page(&u_payload, "0", 0, 100).unwrap();
        assert_eq!(
            page.entries[0].thumb_url.as_deref(),
            Some("https://thumb.115.com/b_100")
        );

        // 占位值不是 http 直链，必须忽略而不是原样透出给前端。
        let placeholder_payload = serde_json::json!({
            "state": true, "code": 0, "count": 1,
            "data": [{"fn": "c.jpg", "fc": 1, "fid": "3", "cid": "0", "thumb": ""}]
        });
        let page = parse_file_page(&placeholder_payload, "0", 0, 100).unwrap();
        assert_eq!(page.entries[0].thumb_url, None);
    }

    // -----------------------------------------------------------------------
    // 视频播放源：原画优先 + 转码档位兜底
    // -----------------------------------------------------------------------

    /// 原画直链与转码档位都可用时：主线路必须是原画，转码档位按服务端顺序进入 fallback。
    #[test]
    fn playback_source_prefers_original_and_keeps_transcoded_fallbacks() {
        let original = Ok("https://cdn.115.com/original.mkv".to_string());
        let transcoded = Ok(vec![
            Cloud115PlaybackOption {
                url: "https://cdn.115.com/1080p.m3u8".to_string(),
                name: "1080P".to_string(),
            },
            Cloud115PlaybackOption {
                url: "https://cdn.115.com/720p.m3u8".to_string(),
                name: "720P".to_string(),
            },
        ]);
        let source = compose_playback_source(original, transcoded).unwrap();
        assert_eq!(source.url, "https://cdn.115.com/original.mkv");
        assert_eq!(source.quality, "原画");
        // 后备线路必须带档位名，前端才能渲染「切换画质」选项。
        assert_eq!(
            source
                .fallback_options
                .iter()
                .map(|option| (option.quality.as_str(), option.url.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("1080P", "https://cdn.115.com/1080p.m3u8"),
                ("720P", "https://cdn.115.com/720p.m3u8"),
            ]
        );
        assert_eq!(source.user_agent, USER_AGENT);
    }

    /// 原画失败、转码可用：首播改用第一档，且画质名必须是真实档位名而不是"原画"。
    #[test]
    fn playback_source_falls_back_to_transcoded_when_original_fails() {
        let original = Err("解析 115 视频原画地址失败（990001）：签名获取失败".to_string());
        let transcoded = Ok(vec![
            Cloud115PlaybackOption {
                url: "https://cdn.115.com/1080p.m3u8".to_string(),
                name: "1080P".to_string(),
            },
            Cloud115PlaybackOption {
                url: "https://cdn.115.com/720p.m3u8".to_string(),
                name: "720P".to_string(),
            },
        ]);
        let source = compose_playback_source(original, transcoded).unwrap();
        assert_eq!(source.url, "https://cdn.115.com/1080p.m3u8");
        assert_eq!(source.quality, "1080P");
        assert_eq!(
            source
                .fallback_options
                .iter()
                .map(|option| (option.quality.as_str(), option.url.as_str()))
                .collect::<Vec<_>>(),
            vec![("720P", "https://cdn.115.com/720p.m3u8")]
        );
    }

    /// 原画与转码两路都失败：错误信息必须同时包含两条失败原因，便于定位问题侧。
    #[test]
    fn playback_source_reports_both_failures_when_nothing_resolves() {
        let original = Err("原画签名过期".to_string());
        let transcoded = Err("转码服务不可用".to_string());
        let error = compose_playback_source(original, transcoded).unwrap_err();
        assert!(error.contains("原画签名过期"), "实际错误：{error}");
        assert!(error.contains("转码服务不可用"), "实际错误：{error}");
    }

    /// 原画可用而转码档位失败：不得因为后备缺失就拒绝可用的原画线路。
    #[test]
    fn playback_source_keeps_original_when_only_transcoded_fails() {
        let original = Ok("https://cdn.115.com/original.mkv".to_string());
        let transcoded = Err("115 视频播放响应缺少 video_url 数组".to_string());
        let source = compose_playback_source(original, transcoded).unwrap();
        assert_eq!(source.url, "https://cdn.115.com/original.mkv");
        assert_eq!(source.quality, "原画");
        assert!(source.fallback_options.is_empty());
    }

    /// 档位去重：同画质名只保留服务端第一条；与原画同址的线路不重复进入 fallback。
    #[test]
    fn playback_options_deduplicate_same_quality_and_skip_original_duplicate() {
        let payload = serde_json::json!({
            "state": true,
            "code": 0,
            "data": {
                "video_url": [
                    {"url": "https://cdn.115.com/a-1080p.m3u8", "desc": "1080P", "definition": 4},
                    {"url": "https://cdn.115.com/b-1080p.m3u8", "desc": "1080P", "definition": 4},
                    {"url": "https://cdn.115.com/720p.m3u8", "definition": 2},
                    {"url": "https://cdn.115.com/original.mkv", "desc": "原画", "definition": 100},
                    {"url": "", "desc": "空地址"},
                    {"url": "ftp://cdn.115.com/ignored", "desc": "非 HTTP"}
                ]
            }
        });
        let options = parse_playback_options(&payload).unwrap();
        assert_eq!(options.len(), 3);
        assert_eq!(options[0].url, "https://cdn.115.com/a-1080p.m3u8");
        assert_eq!(options[0].name, "1080P");
        // 无 desc/title 时按 definition 映射出可读档位名。
        assert_eq!(options[1].name, "高清");
        assert_eq!(options[2].name, "原画");

        // 原画地址与 downurl 主线路相同时，不应在 fallback 里重复出现。
        let source = compose_playback_source(
            Ok("https://cdn.115.com/original.mkv".to_string()),
            Ok(options),
        )
        .unwrap();
        assert_eq!(source.quality, "原画");
        assert!(!source
            .fallback_options
            .iter()
            .any(|option| option.url == source.url));
        assert_eq!(source.fallback_options.len(), 2);
    }

    /// 限速预约制：并发请求各自预约时间槽后立即释放锁，
    /// 因此两路并发读取的等待时间应接近一个间隔，而不是两个间隔。
    #[tokio::test]
    async fn pacing_reserves_slots_without_serializing_network() {
        let provider = Cloud115Provider::new().expect("构造测试用 provider");
        let started = Instant::now();
        tokio::join!(
            provider.pace_control_request(),
            provider.pace_control_request(),
        );
        let elapsed = started.elapsed();
        // 首个请求无需等待；第二个补足一个间隔。若锁覆盖网络往返，
        // 这里会接近 2 个间隔。
        assert!(
            elapsed >= CONTROL_REQUEST_MIN_INTERVAL,
            "第二个请求应补足间隔，实际 {elapsed:?}"
        );
        assert!(
            elapsed < CONTROL_REQUEST_MIN_INTERVAL * 2,
            "并发预约不应串行成两个完整间隔，实际 {elapsed:?}"
        );
    }

    #[test]
    fn recognizes_115_token_expiry_business_codes() {
        assert!(payload_requires_refresh(
            &serde_json::json!({"state": false, "code": 40140123})
        ));
        assert!(payload_requires_refresh(
            &serde_json::json!({"state": false, "code": "40100000"})
        ));
        assert!(payload_requires_refresh(
            &serde_json::json!({"state": false, "code": 99})
        ));
        assert!(!payload_requires_refresh(
            &serde_json::json!({"state": false, "code": 20022})
        ));
        assert!(!payload_requires_refresh(
            &serde_json::json!({"state": true, "code": 0})
        ));
    }

    #[test]
    fn validates_batch_file_ids() {
        assert_eq!(
            validate_file_ids(&["12".to_string(), "34".to_string()]).unwrap(),
            "12,34"
        );
        assert!(validate_file_ids(&[]).is_err());
        assert!(validate_file_ids(&["12,34".to_string()]).is_err());
    }

    #[test]
    fn parses_nested_space_values() {
        let space = serde_json::json!({
            "all_total": {"size": 1024, "size_format": "1 KB"},
            "all_use": {"size": "512", "size_format": "512 B"}
        });
        assert_eq!(nested_size(&space, "all_total"), 1024);
        assert_eq!(nested_size(&space, "all_use"), 512);
        assert_eq!(nested_size(&space, "all_remain"), 0);
        assert_eq!(nested_size_format(&space, "all_total"), "1 KB");
    }

    #[test]
    fn validates_upload_credentials_shape() {
        let credentials = parse_upload_credentials(&serde_json::json!({
            "endpoint": "https://oss.example.com",
            "AccessKeyId": "id",
            "AccessKeySecret": "secret",
            "SecurityToken": "token",
            "Expiration": "2026-08-02T12:00:00Z"
        }))
        .expect("valid credentials should parse");
        assert_eq!(credentials.endpoint, "https://oss.example.com");
        assert!(!credentials.access_key_secret.is_empty());
        assert!(parse_upload_credentials(&serde_json::json!({
            "endpoint": "file:///tmp/upload",
            "AccessKeyId": "id",
            "AccessKeySecret": "secret",
            "SecurityToken": "token",
            "Expiration": "soon"
        }))
        .is_err());
    }

    #[test]
    fn parses_upload_init_callback_shapes_and_sha1() {
        let result = parse_upload_init(&serde_json::json!({
            "status": 1,
            "bucket": "bucket",
            "object": "object/key",
            "callback": [{"callback": "encoded", "callback_var": "vars"}],
            "pick_code": "pick"
        }))
        .expect("upload init should parse");
        assert_eq!(result.status, 1);
        assert_eq!(result.callback, "encoded");
        assert_eq!(result.callback_var, "vars");
        assert_eq!(
            sha1_upper(b"abc"),
            "A9993E364706816ABA3E25717850C26C9CD0D89D"
        );
        let authorization = oss_authorization("key", "secret", b"string-to-sign")
            .expect("OSS authorization should build");
        assert!(authorization.starts_with("OSS key:"));
        assert_eq!(parse_sign_check_range("2-4", 5).unwrap(), (2, 4));
        assert!(parse_sign_check_range("4-2", 5).is_err());
        assert!(parse_sign_check_range("0-5", 5).is_err());
        assert!(parse_sign_check_range("invalid", 5).is_err());
        assert_eq!(
            oss_query(&[
                ("partNumber", "1".to_string()),
                ("uploadId", "a+b/c=".to_string())
            ]),
            "partNumber=1&uploadId=a%2Bb%2Fc%3D"
        );
        assert_eq!(
            xml_element("<Root><UploadId>abc</UploadId></Root>", "UploadId").as_deref(),
            Some("abc")
        );
        assert!(complete_multipart_xml(&[(1, "\"etag\"".to_string())])
            .contains("<ETag>&quot;etag&quot;</ETag>"));
        assert!(oss_status_ok(StatusCode::OK));
        assert!(oss_status_ok(StatusCode::NO_CONTENT));
        assert!(!oss_status_ok(StatusCode::NON_AUTHORITATIVE_INFORMATION));
    }

    /// 真实 OpenAPI 集成测试默认忽略，仅在本机已有开发登录态时显式执行。
    #[test]
    #[ignore = "requires a local 115 development login"]
    fn live_lists_root_child_and_search() {
        tauri::async_runtime::block_on(async {
            let provider = Cloud115Provider::new().expect("provider should initialize");
            let root = provider
                .list_files("0", 0, 100, "")
                .await
                .expect("root list should succeed");
            assert!(
                !root.entries.is_empty(),
                "root should contain at least one entry"
            );
            assert!(root.entries.iter().all(|entry| entry.parent_id == "0"));

            let folder = root
                .entries
                .iter()
                .find(|entry| entry.kind == "folder")
                .expect("root should contain a folder");
            let child = provider
                .list_files(&folder.id, 0, 100, "")
                .await
                .expect("child list should succeed");
            assert!(child
                .entries
                .iter()
                .all(|entry| entry.parent_id == folder.id));

            let search = provider
                .list_files("0", 0, 20, ".mp4")
                .await
                .expect("search should succeed");
            assert!(
                !search.entries.is_empty(),
                "mp4 search should return entries"
            );
            assert!(search
                .entries
                .iter()
                .all(|entry| !entry.id.is_empty() && !entry.name.is_empty()));
        });
    }

    /// 使用真实视频 pick_code 校验下载/播放直链响应，不打印短时效 URL。
    #[test]
    #[ignore = "requires a local 115 development login"]
    fn live_resolves_video_playback_url() {
        tauri::async_runtime::block_on(async {
            let provider = Cloud115Provider::new().expect("provider should initialize");
            let pick_code = live_video_pick_code(&provider).await;
            let source = provider
                .playback_source(&pick_code)
                .await
                .expect("video play should succeed");
            assert!(source.url.starts_with("https://") || source.url.starts_with("http://"));
            assert!(!source.user_agent.is_empty());
            // 原画优先：真实账号下 downurl 通常可用，主线路应标注为原画；若原画不可用
            // 则会降级到转码并带上真实档位名，绝不能空着冒充原画。
            assert!(!source.quality.is_empty());
            // 后备线路不得与主线路同址，否则前端降级重试会命中同一个失败地址。
            assert!(source
                .fallback_options
                .iter()
                .all(|option| option.url != source.url));
        });
    }

    /// 字幕为空是合法结果；若存在字幕，则每条必须具备受支持的远程 URL。
    #[test]
    #[ignore = "requires a local 115 development login"]
    fn live_lists_video_subtitles() {
        tauri::async_runtime::block_on(async {
            let provider = Cloud115Provider::new().expect("provider should initialize");
            let pick_code = live_video_pick_code(&provider).await;
            let subtitles = provider
                .video_subtitles(&pick_code)
                .await
                .expect("subtitle API should succeed");
            assert!(subtitles
                .iter()
                .all(|item| item.url.starts_with("https://") || item.url.starts_with("http://")));
        });
    }

    /// 使用真实图片文件验证 downurl Map/数组兼容解析，不打印短时效地址。
    #[test]
    #[ignore = "requires a local 115 development login"]
    fn live_resolves_regular_file_download_url() {
        tauri::async_runtime::block_on(async {
            let provider = Cloud115Provider::new().expect("provider should initialize");
            let pick_code = live_pick_code(&provider, ".jpg", 2).await;
            let source = provider
                .download_source(&pick_code)
                .await
                .expect("downurl should succeed");
            assert!(source.url.starts_with("https://") || source.url.starts_with("http://"));
            assert!(!source.user_agent.is_empty());
        });
    }

    /// 使用真实文件 ID 校验 get_info 的关键字段与路径结构。
    #[test]
    #[ignore = "requires a local 115 development login"]
    fn live_reads_file_metadata() {
        tauri::async_runtime::block_on(async {
            let provider = Cloud115Provider::new().expect("provider should initialize");
            let entry = live_search_entry(&provider, ".jpg", 2).await;
            let metadata = provider
                .file_metadata(&entry.id)
                .await
                .expect("get_info should succeed");
            assert_eq!(metadata.id, entry.id);
            assert!(!metadata.name.is_empty());
            assert!(!metadata.is_folder);
            assert!(!metadata.pick_code.is_empty());
        });
    }

    /// 使用当前开发登录态校验用户资料、空间概要和头像字段，不输出个人信息。
    #[test]
    #[ignore = "requires a local 115 development login"]
    fn live_reads_user_profile() {
        tauri::async_runtime::block_on(async {
            let provider = Cloud115Provider::new().expect("provider should initialize");
            let profile = provider
                .user_profile()
                .await
                .expect("user profile should load");
            assert!(profile.user_id > 0);
            assert!(!profile.user_name.is_empty());
            assert!(profile.total_bytes >= profile.used_bytes);
            assert!(profile.total_bytes >= profile.remaining_bytes);
            assert!(
                profile.avatar_url.is_empty()
                    || profile.avatar_url.starts_with("https://")
                    || profile.avatar_url.starts_with("http://")
            );
        });
    }

    /// 校验真实 STS 凭证结构与 endpoint，不输出任何临时密钥内容。
    #[test]
    #[ignore = "requires a local 115 development login"]
    fn live_gets_upload_credentials() {
        tauri::async_runtime::block_on(async {
            let provider = Cloud115Provider::new().expect("provider should initialize");
            let credentials = provider
                .upload_credentials()
                .await
                .expect("upload credentials should load");
            assert!(credentials.endpoint.starts_with("http"));
            assert!(!credentials.access_key_id.is_empty());
            assert!(!credentials.access_key_secret.is_empty());
            assert!(!credentials.security_token.is_empty());
        });
    }

    /// 使用唯一虚拟内容校验上传初始化调度，不执行 OSS PUT，也不创建远端文件。
    #[test]
    #[ignore = "requires a local 115 development login"]
    fn live_initializes_upload() {
        tauri::async_runtime::block_on(async {
            let provider = Cloud115Provider::new().expect("provider should initialize");
            let content = format!(
                "Sirius upload init probe {}",
                unix_millis().expect("clock should work")
            );
            let sha1 = sha1_upper(content.as_bytes());
            let result = provider
                .initialize_upload(
                    "Sirius-Upload-Probe.bin",
                    content.len() as u64,
                    "0",
                    &sha1,
                    &sha1,
                    None,
                )
                .await
                .expect("upload init should succeed");
            assert!(matches!(result.status, 1 | 2 | 6 | 7 | 8));
            if result.status == 1 {
                assert!(!result.bucket.is_empty());
                assert!(!result.object_key.is_empty());
                assert!(!result.callback.is_empty());
                assert!(!result.pick_code.is_empty());
            }
            if matches!(result.status, 6..=8) {
                assert!(!result.sign_key.is_empty());
                assert!(!result.sign_check.is_empty());
            }
        });
    }

    /// 上传唯一的小型测试文件，确认 115 回调入库后永久清理专属临时目录。
    #[test]
    #[ignore = "uploads and permanently deletes one tiny temporary 115 file"]
    fn live_uploads_tiny_file() {
        tauri::async_runtime::block_on(async {
            let provider = Cloud115Provider::new().expect("provider should initialize");
            let suffix = unix_millis().expect("clock should work");
            let folder_name = format!("Sirius-API-Test-Upload-{suffix}");
            let file_name = format!("Sirius-Upload-{suffix}.txt");
            let folder = provider
                .create_folder("0", &folder_name)
                .await
                .expect("upload test folder should create");
            let bytes = format!("Sirius upload integration probe {suffix}").into_bytes();
            let sha1 = sha1_upper(&bytes);

            let workflow = async {
                let init = provider
                    .initialize_upload(
                        &file_name,
                        bytes.len() as u64,
                        &folder.id,
                        &sha1,
                        &sha1,
                        None,
                    )
                    .await?;
                if init.status != 1 {
                    return Err(format!(
                        "115 小文件上传初始化返回未支持状态：{}",
                        init.status
                    ));
                }
                let credentials = provider.upload_credentials().await?;
                provider
                    .put_oss_object(
                        &credentials,
                        &init,
                        bytes.clone(),
                        &TransferReporter::upload(None, Path::new(&file_name)),
                    )
                    .await?;
                for _ in 0..12 {
                    let page = provider.list_files(&folder.id, 0, 100, "").await?;
                    if page.entries.iter().any(|entry| entry.name == file_name) {
                        return Ok::<(), String>(());
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                Err("上传完成后文件在限定时间内未入库".to_string())
            }
            .await;

            provider
                .delete_files(std::slice::from_ref(&folder.id))
                .await
                .expect("upload test folder should enter recycle bin");
            let recycled = wait_for_recycle_item(&provider, &folder_name).await;
            provider
                .delete_recycle_items(std::slice::from_ref(&recycled.id))
                .await
                .expect("upload test folder should permanently delete");
            workflow.expect("tiny file upload should succeed");
        });
    }

    /// 上传 2×20 MiB+1 字节文件强制 3 个分片，验证分片上传、完成回调与永久清理。
    #[test]
    #[ignore = "uploads and permanently deletes one forced-multipart test file (3 parts)"]
    fn live_uploads_multipart_file() {
        tauri::async_runtime::block_on(async {
            let provider = Cloud115Provider::new().expect("provider should initialize");
            let suffix = unix_millis().expect("clock should work");
            let folder_name = format!("Sirius-API-Test-Multipart-{suffix}");
            let file_name = format!("Sirius-Multipart-{suffix}.bin");
            let folder = provider
                .create_folder("0", &folder_name)
                .await
                .expect("multipart test folder should create");
            let mut bytes = vec![0x5A; 2 * MULTIPART_PART_BYTES as usize + 1];
            bytes[..16].copy_from_slice(&suffix.to_le_bytes());
            let local_path = std::env::temp_dir().join(&file_name);
            std::fs::write(&local_path, &bytes).expect("multipart test file should write");

            let workflow = async {
                let sha1 = sha1_upper(&bytes);
                let init = provider
                    .initialize_upload(
                        &file_name,
                        bytes.len() as u64,
                        &folder.id,
                        &sha1,
                        &sha1_upper(&bytes[..128 * 1024]),
                        None,
                    )
                    .await?;
                if init.status != 1 {
                    return Err(format!(
                        "115 multipart 测试初始化返回未支持状态：{}",
                        init.status
                    ));
                }
                let credentials = provider.upload_credentials().await?;
                provider
                    .put_oss_multipart(
                        &credentials,
                        &init,
                        &local_path,
                        bytes.len() as u64,
                        None,
                        &TransferReporter::upload(None, &local_path),
                    )
                    .await?;
                for _ in 0..60 {
                    let page = provider.list_files(&folder.id, 0, 100, "").await?;
                    if page.entries.iter().any(|entry| entry.name == file_name) {
                        return Ok::<(), String>(());
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                Err("multipart 完成后文件在限定时间内未入库".to_string())
            }
            .await;

            match std::fs::remove_file(&local_path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => panic!("multipart test local cleanup failed: {error}"),
            }
            provider
                .delete_files(std::slice::from_ref(&folder.id))
                .await
                .expect("upload test folder should enter recycle bin");
            let recycled = wait_for_recycle_item(&provider, &folder_name).await;
            provider
                .delete_recycle_items(std::slice::from_ref(&recycled.id))
                .await
                .expect("multipart test folder should permanently delete");
            workflow.expect("multipart upload should succeed");
        });
    }

    /// 只上传首片并持久化，随后经 `/open/upload/resume` 补齐剩余分片并清理。
    #[test]
    #[ignore = "creates, resumes, and permanently deletes one multipart test upload"]
    fn live_resumes_interrupted_multipart_upload() {
        tauri::async_runtime::block_on(async {
            let provider = Cloud115Provider::new().expect("provider should initialize");
            let repository = LibraryRepository::open(std::path::Path::new(":memory:"))
                .expect("upload session repository should initialize");
            let suffix = unix_millis().expect("clock should work");
            let folder_name = format!("Sirius-API-Test-Resume-{suffix}");
            let file_name = format!("Sirius-Resume-{suffix}.bin");
            let local_path = std::env::temp_dir().join(&file_name);
            let folder = provider
                .create_folder("0", &folder_name)
                .await
                .expect("resume test folder should create");
            let mut bytes = vec![0x3C; 2 * 1024 * 1024 + 1];
            bytes[..16].copy_from_slice(&suffix.to_le_bytes());
            std::fs::write(&local_path, &bytes).expect("resume test file should write");
            let file_sha1 = sha1_upper(&bytes);
            let pre_sha1 = sha1_upper(&bytes[..128 * 1024]);

            let workflow = async {
                let init = provider
                    .initialize_upload(
                        &file_name,
                        bytes.len() as u64,
                        &folder.id,
                        &file_sha1,
                        &pre_sha1,
                        None,
                    )
                    .await?;
                if init.status != 1 {
                    return Err(format!("115 resume 测试初始化状态异常：{}", init.status));
                }
                let credentials = provider.upload_credentials().await?;
                let initiate = provider
                    .oss_request(
                        &credentials,
                        &init,
                        OssRequestOptions {
                            method: reqwest::Method::POST,
                            query: Some("sequential&uploads"),
                            content_type: "",
                            include_callback: false,
                            body: Vec::new(),
                        },
                    )
                    .await?;
                if !oss_status_ok(initiate.status()) {
                    return Err(oss_response_error(initiate).await);
                }
                let upload_id = xml_element(
                    &initiate
                        .text()
                        .await
                        .map_err(|error| format!("读取 resume 测试 UploadId 失败：{error}"))?,
                    "UploadId",
                )
                .ok_or_else(|| "resume 测试缺少 UploadId".to_string())?;
                let first_query = oss_query(&[
                    ("partNumber", "1".to_string()),
                    ("uploadId", upload_id.clone()),
                ]);
                let first = provider
                    .oss_request(
                        &credentials,
                        &init,
                        OssRequestOptions {
                            method: reqwest::Method::PUT,
                            query: Some(&first_query),
                            content_type: "application/octet-stream",
                            include_callback: false,
                            body: bytes[..1024 * 1024].to_vec(),
                        },
                    )
                    .await?;
                if !oss_status_ok(first.status()) {
                    return Err(oss_response_error(first).await);
                }
                let etag = first
                    .headers()
                    .get("ETag")
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| "resume 测试首片缺少 ETag".to_string())?
                    .to_string();
                let session = UploadSession {
                    id: format!("resume-test-{suffix}"),
                    local_path: local_path.to_string_lossy().into_owned(),
                    file_name: file_name.clone(),
                    target_id: folder.id.clone(),
                    file_size: bytes.len() as u64,
                    file_sha1: file_sha1.clone(),
                    pre_sha1: pre_sha1.clone(),
                    pick_code: init.pick_code.clone(),
                    bucket: init.bucket.clone(),
                    object_key: init.object_key.clone(),
                    upload_id,
                    callback: init.callback,
                    callback_var: init.callback_var,
                    part_size: 1024 * 1024,
                    completed_parts: vec![UploadPartState { number: 1, etag }],
                    status: "paused".to_string(),
                };
                repository.save_upload_session(&session)?;
                provider
                    .resume_upload_session(&repository, session, None)
                    .await?;
                for _ in 0..40 {
                    let page = provider.list_files(&folder.id, 0, 100, "").await?;
                    if page.entries.iter().any(|entry| entry.name == file_name) {
                        return Ok::<(), String>(());
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                Err("resume 完成后文件在限定时间内未入库".to_string())
            }
            .await;

            match std::fs::remove_file(&local_path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => panic!("resume test local cleanup failed: {error}"),
            }
            provider
                .delete_files(std::slice::from_ref(&folder.id))
                .await
                .expect("resume test folder should enter recycle bin");
            let recycled = wait_for_recycle_item(&provider, &folder_name).await;
            provider
                .delete_recycle_items(std::slice::from_ref(&recycled.id))
                .await
                .expect("resume test folder should permanently delete");
            workflow.expect("interrupted multipart upload should resume");
        });
    }

    /// 仅清理最近一小时内由 multipart 集成测试创建的唯一残留目录；目标不唯一时拒绝操作。
    #[test]
    #[ignore = "cleans one recent orphaned multipart integration-test folder"]
    fn live_cleans_recent_multipart_test_folder() {
        tauri::async_runtime::block_on(async {
            let provider = Cloud115Provider::new().expect("provider should initialize");
            let page = provider
                .list_files("0", 0, 200, "Sirius-API-Test-Multipart-")
                .await
                .expect("multipart test folder search should succeed");
            let cutoff = unix_now().expect("clock should work").saturating_sub(3600);
            let matches = page
                .entries
                .into_iter()
                .filter(|entry| {
                    entry.kind == "folder"
                        && entry.name.starts_with("Sirius-API-Test-Multipart-")
                        && entry.modified_at >= cutoff
                })
                .collect::<Vec<_>>();
            if matches.is_empty() {
                return;
            }
            assert_eq!(
                matches.len(),
                1,
                "refusing to clean a non-unique recent multipart test target"
            );
            let folder = &matches[0];
            provider
                .delete_files(std::slice::from_ref(&folder.id))
                .await
                .expect("orphaned multipart test folder should enter recycle bin");
            let recycled = wait_for_recycle_item(&provider, &folder.name).await;
            provider
                .delete_recycle_items(std::slice::from_ref(&recycled.id))
                .await
                .expect("orphaned multipart test folder should permanently delete");
        });
    }

    /// 只操作本测试创建的空目录，验证创建、重命名、移动和回收站删除闭环。
    #[test]
    #[ignore = "creates and recycles temporary 115 folders"]
    fn live_runs_temporary_folder_crud() {
        tauri::async_runtime::block_on(async {
            let provider = Cloud115Provider::new().expect("provider should initialize");
            let suffix = unix_millis().expect("clock should work");
            let parent = provider
                .create_folder("0", &format!("Sirius-API-Test-{suffix}"))
                .await
                .expect("parent folder should create");
            let child = match provider
                .create_folder("0", &format!("Sirius-API-Test-Child-{suffix}"))
                .await
            {
                Ok(folder) => folder,
                Err(error) => {
                    provider
                        .delete_files(std::slice::from_ref(&parent.id))
                        .await
                        .expect("parent cleanup should succeed");
                    panic!("child folder should create: {error}");
                }
            };

            let renamed = format!("Sirius-API-Test-Renamed-{suffix}");
            let workflow = async {
                provider
                    .update_file(&child.id, Some(&renamed), None)
                    .await?;
                provider
                    .move_files(std::slice::from_ref(&child.id), &parent.id)
                    .await?;
                let metadata = provider.file_metadata(&child.id).await?;
                if metadata.name != renamed || metadata.parent_id != parent.id {
                    return Err("115 临时目录重命名或移动结果不一致".to_string());
                }
                Ok::<(), String>(())
            }
            .await;

            let child_cleanup = provider.delete_files(std::slice::from_ref(&child.id)).await;
            let parent_cleanup = provider
                .delete_files(std::slice::from_ref(&parent.id))
                .await;
            child_cleanup.expect("child cleanup should succeed");
            parent_cleanup.expect("parent cleanup should succeed");
            workflow.expect("temporary folder CRUD should succeed");
        });
    }

    /// 复制一个现有图片到唯一临时目录，验证列表可见后彻底清理该测试目录。
    #[test]
    #[ignore = "copies one existing file into a temporary 115 folder"]
    fn live_copies_file_into_temporary_folder() {
        tauri::async_runtime::block_on(async {
            let provider = Cloud115Provider::new().expect("provider should initialize");
            let source = live_search_entry(&provider, ".jpg", 2).await;
            let name = format!(
                "Sirius-API-Test-Copy-{}",
                unix_millis().expect("clock should work")
            );
            let folder = provider
                .create_folder("0", &name)
                .await
                .expect("copy test folder should create");

            let workflow = async {
                provider
                    .copy_files(std::slice::from_ref(&source.id), &folder.id, false)
                    .await?;
                for _ in 0..10 {
                    let page = provider.list_files(&folder.id, 0, 100, "").await?;
                    if page.entries.iter().any(|entry| entry.name == source.name) {
                        return Ok::<(), String>(());
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                Err("复制后的 115 文件在限定时间内不可见".to_string())
            }
            .await;

            provider
                .delete_files(std::slice::from_ref(&folder.id))
                .await
                .expect("copy test folder should enter recycle bin");
            let recycled = wait_for_recycle_item(&provider, &name).await;
            provider
                .delete_recycle_items(std::slice::from_ref(&recycled.id))
                .await
                .expect("copy test folder should permanently delete");
            workflow.expect("copy workflow should succeed");
        });
    }

    /// 创建唯一空目录，验证回收站列表、恢复和彻底删除，仅影响测试自身条目。
    #[test]
    #[ignore = "creates, restores, and permanently deletes one temporary folder"]
    fn live_runs_recycle_bin_cycle() {
        tauri::async_runtime::block_on(async {
            let provider = Cloud115Provider::new().expect("provider should initialize");
            let name = format!(
                "Sirius-API-Test-Recycle-{}",
                unix_millis().expect("clock should work")
            );
            let folder = provider
                .create_folder("0", &name)
                .await
                .expect("test folder should create");
            provider
                .delete_files(std::slice::from_ref(&folder.id))
                .await
                .expect("test folder should enter recycle bin");

            let recycled = wait_for_recycle_item(&provider, &name).await;
            provider
                .restore_recycle_items(std::slice::from_ref(&recycled.id))
                .await
                .expect("test folder should restore");
            provider
                .file_metadata(&folder.id)
                .await
                .expect("restored test folder should exist");

            wait_until_test_folder_can_delete(&provider, &folder.id).await;
            let recycled = wait_for_recycle_item(&provider, &name).await;
            provider
                .delete_recycle_items(std::slice::from_ref(&recycled.id))
                .await
                .expect("test folder should permanently delete");
            let page = provider
                .list_recycle_bin(0, 200)
                .await
                .expect("recycle list should verify cleanup");
            assert!(page.entries.iter().all(|item| item.name != name));
        });
    }

    /// 人为把本地过期时间置零，验证 refreshToken 与后续 OpenAPI 请求的完整链路。
    #[test]
    #[ignore = "rotates the local 115 development token"]
    fn live_refreshes_expired_access_token() {
        tauri::async_runtime::block_on(async {
            let original = load_tokens()
                .expect("token store should be readable")
                .expect("development login should exist");
            save_tokens(&OAuthTokens {
                expires_at: 0,
                ..original.clone()
            })
            .expect("expired marker should save");
            let provider = Cloud115Provider::new().expect("provider should initialize");
            if let Err(error) = provider.list_files("0", 0, 20, "").await {
                // 刷新失败时恢复仍可能有效的原始凭据，避免测试破坏当前开发登录态。
                save_tokens(&original).expect("original token should restore");
                panic!("refresh flow should succeed: {error}");
            }
            let refreshed = load_tokens()
                .expect("token store should be readable")
                .expect("refreshed login should exist");
            assert!(
                refreshed.expires_at > unix_now().expect("clock should work").saturating_add(300)
            );
        });
    }

    /// 最终退出验收专用：清除当前本地 Token，并确认登录态已经删除。
    #[test]
    #[ignore = "clears the current 115 login and requires scanning again"]
    fn live_clears_current_login() {
        let provider = Cloud115Provider::new().expect("provider should initialize");
        assert!(
            load_tokens()
                .expect("token store should be readable")
                .is_some(),
            "development login should exist"
        );
        provider.sign_out().expect("local sign out should succeed");
        assert!(
            load_tokens()
                .expect("token store should remain readable")
                .is_none(),
            "local login should be removed after sign out"
        );
    }
}
