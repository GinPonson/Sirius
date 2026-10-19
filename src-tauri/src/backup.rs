use crate::cloud115::{Cloud115Provider, Cloud115UploadResult};
use crate::library::{BackupFingerprint, LibraryRepository};
use crate::transfer::ProgressCallback;
use serde::Serialize;
use std::{collections::HashMap, future::Future, path::Path, sync::Arc};

/// 备份结果；uploaded 只计入上传且同步指纹已可靠保存的文件。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRunResult {
    pub uploaded: u64,
    pub failed: Vec<BackupFailure>,
    pub completed: bool,
}

/// 单个文件或同步记录的失败；远端已上传但本地未登记也必须如实报告。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFailure {
    pub relative_path: String,
    pub reason: String,
}

/// 备份对云端的实际依赖；与 AI 执行器一样，通过离线实现验证失败和文件变化。
trait BackupProvider: Sync {
    fn account_id(&self) -> Result<u64, String>;
    fn ensure_parent(
        &self,
        root_id: &str,
        relative_parent: &str,
        cache: &mut HashMap<String, String>,
    ) -> impl Future<Output = Result<String, String>> + Send;
    fn upload(
        &self,
        repository: &LibraryRepository,
        path: &str,
        target_id: &str,
        progress: Option<ProgressCallback>,
    ) -> impl Future<Output = Result<Cloud115UploadResult, String>> + Send;
}

impl BackupProvider for Cloud115Provider {
    fn account_id(&self) -> Result<u64, String> {
        Cloud115Provider::account_id(self)
    }

    async fn ensure_parent(
        &self,
        root_id: &str,
        relative_parent: &str,
        cache: &mut HashMap<String, String>,
    ) -> Result<String, String> {
        self.ensure_upload_parent(root_id, relative_parent, cache, &mut 0)
            .await
    }

    fn upload(
        &self,
        repository: &LibraryRepository,
        path: &str,
        target_id: &str,
        progress: Option<ProgressCallback>,
    ) -> impl Future<Output = Result<Cloud115UploadResult, String>> + Send {
        self.upload_file_from_disk(repository, path, target_id, progress)
    }
}

/// 顺序备份指定账号的配对，保留目录结构；磁盘与 SQLite 工作在阻塞线程执行。
/// 上传期间文件变化、账号切换或同步记录失败时，该文件不标记为已同步。
pub async fn run_backup(
    provider: &Cloud115Provider,
    repository: Arc<LibraryRepository>,
    account_id: u64,
    pair_id: String,
    progress: Option<ProgressCallback>,
) -> Result<BackupRunResult, String> {
    run_with_provider(provider, repository, account_id, pair_id, progress).await
}

/// 与生产共享执行流程；测试仅替换远端操作，不替换指纹比较和持久化规则。
async fn run_with_provider<P: BackupProvider>(
    provider: &P,
    repository: Arc<LibraryRepository>,
    account_id: u64,
    pair_id: String,
    progress: Option<ProgressCallback>,
) -> Result<BackupRunResult, String> {
    let query_repository = Arc::clone(&repository);
    let query_pair_id = pair_id.clone();
    let (pair, scan) = tauri::async_runtime::spawn_blocking(move || {
        Ok::<_, String>((
            query_repository.backup_pair(account_id, &query_pair_id)?,
            query_repository.scan_backup_pair(account_id, &query_pair_id)?,
        ))
    })
    .await
    .map_err(|error| format!("备份扫描线程异常终止：{error}"))??;

    let mut uploaded = 0;
    let mut failed = Vec::new();
    let mut remote_dirs = HashMap::new();
    for relative_path in scan.pending_paths {
        let absolute = Path::new(&pair.local_path).join(&relative_path);
        let result = async {
            if provider.account_id()? != account_id {
                return Err("115 账号已切换，备份已停止".to_string());
            }
            let relative_parent = relative_path
                .rsplit_once('/')
                .map_or("", |(parent, _)| parent);
            let target_id = provider
                .ensure_parent(&pair.remote_folder_id, relative_parent, &mut remote_dirs)
                .await?;
            let source = absolute.clone();
            let before =
                tauri::async_runtime::spawn_blocking(move || BackupFingerprint::read(&source))
                    .await
                    .map_err(|error| format!("备份指纹线程异常终止：{error}"))??;
            let result = provider
                .upload(
                    &repository,
                    &absolute.to_string_lossy(),
                    &target_id,
                    progress.clone(),
                )
                .await?;
            if provider.account_id()? != account_id {
                return Err("115 账号已切换，未登记本次备份，请在原账号下检查结果".to_string());
            }
            let record_repository = Arc::clone(&repository);
            let record_pair_id = pair_id.clone();
            let record_path = relative_path.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if BackupFingerprint::read(&absolute)? != before {
                    return Err("文件在上传期间发生变化，未标记为已同步，请重新备份".to_string());
                }
                record_repository.record_backup_file(
                    account_id,
                    &record_pair_id,
                    &record_path,
                    before.size_bytes,
                    before.modified_at,
                    &result.pick_code,
                )
            })
            .await
            .map_err(|error| format!("保存备份指纹线程异常终止：{error}"))?
        }
        .await;
        match result {
            Ok(()) => uploaded += 1,
            Err(reason) => failed.push(BackupFailure {
                relative_path,
                reason,
            }),
        }
        // 换号后的剩余条目不再发起远端操作，也不会被错登记到其他账号。
        if provider.account_id()? != account_id {
            return Err("115 账号已切换，备份已停止".to_string());
        }
    }
    if failed.is_empty() {
        let touch_repository = Arc::clone(&repository);
        let touched = tauri::async_runtime::spawn_blocking(move || {
            touch_repository.touch_backup_pair(account_id, &pair_id)
        })
        .await
        .map_err(|error| format!("保存备份时间线程异常终止：{error}"))?;
        if let Err(reason) = touched {
            failed.push(BackupFailure {
                relative_path: "同步记录".to_string(),
                reason,
            });
        }
    }
    Ok(BackupRunResult {
        uploaded,
        completed: failed.is_empty(),
        failed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::PathBuf, sync::Mutex};

    /// 隔离本地备份目录与真实仓储；退出测试时释放数据库并清理文件。
    struct Fixture {
        root: PathBuf,
        repository: Arc<LibraryRepository>,
        pair_id: String,
    }

    impl Fixture {
        fn new() -> Self {
            let unique = crate::transfer::next_transfer_id();
            let root = std::env::temp_dir().join(format!("sirius-backup-workflow-{unique}"));
            std::fs::create_dir_all(root.join("source/a")).unwrap();
            std::fs::create_dir_all(root.join("source/b")).unwrap();
            std::fs::write(root.join("source/a/report.txt"), b"first version").unwrap();
            std::fs::write(root.join("source/b/report.txt"), b"second version").unwrap();
            let repository =
                Arc::new(LibraryRepository::open(&root.join("state.sqlite3")).unwrap());
            let pair = repository
                .add_backup_pair(
                    1,
                    &root.join("source").to_string_lossy(),
                    "remote-root",
                    "备份",
                )
                .unwrap();
            Self {
                root,
                repository,
                pair_id: pair.id,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }

    /// 仅替换远端上传；可在上传后编辑源文件，复现等待网络期间的本地变化。
    #[derive(Default)]
    struct MockProvider {
        change_source: bool,
        calls: Mutex<Vec<(String, String)>>,
    }

    impl BackupProvider for MockProvider {
        fn account_id(&self) -> Result<u64, String> {
            Ok(1)
        }

        async fn ensure_parent(
            &self,
            root_id: &str,
            relative_parent: &str,
            _cache: &mut HashMap<String, String>,
        ) -> Result<String, String> {
            Ok(format!("{root_id}/{relative_parent}"))
        }

        async fn upload(
            &self,
            _repository: &LibraryRepository,
            path: &str,
            target_id: &str,
            _progress: Option<ProgressCallback>,
        ) -> Result<Cloud115UploadResult, String> {
            self.calls
                .lock()
                .unwrap()
                .push((path.to_string(), target_id.to_string()));
            if self.change_source {
                std::fs::write(path, b"edited while the old snapshot was uploading").unwrap();
            }
            Ok(Cloud115UploadResult {
                file_name: "report.txt".to_string(),
                pick_code: "uploaded-pick".to_string(),
                instant: false,
            })
        }
    }

    #[tokio::test]
    async fn backup_preserves_distinct_relative_parents_and_skips_completed_files() {
        let fixture = Fixture::new();
        let provider = MockProvider::default();
        let report = run_with_provider(
            &provider,
            Arc::clone(&fixture.repository),
            1,
            fixture.pair_id.clone(),
            None,
        )
        .await
        .unwrap();
        assert!(report.completed);
        assert_eq!(report.uploaded, 2);
        let targets: Vec<_> = provider
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|(_, target)| target.clone())
            .collect();
        assert_eq!(targets, ["remote-root/a", "remote-root/b"]);
        assert_eq!(
            fixture
                .repository
                .scan_backup_pair(1, &fixture.pair_id)
                .unwrap()
                .pending_files,
            0
        );
        let second = run_with_provider(
            &provider,
            Arc::clone(&fixture.repository),
            1,
            fixture.pair_id.clone(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(second.uploaded, 0);
        assert_eq!(provider.calls.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn changed_upload_source_stays_pending_and_is_reported() {
        let fixture = Fixture::new();
        let provider = MockProvider {
            change_source: true,
            ..Default::default()
        };
        let report = run_with_provider(
            &provider,
            Arc::clone(&fixture.repository),
            1,
            fixture.pair_id.clone(),
            None,
        )
        .await
        .unwrap();
        assert!(!report.completed);
        assert_eq!(report.uploaded, 0);
        assert_eq!(report.failed.len(), 2);
        assert!(report
            .failed
            .iter()
            .all(|item| item.reason.contains("上传期间发生变化")));
        assert_eq!(
            fixture
                .repository
                .scan_backup_pair(1, &fixture.pair_id)
                .unwrap()
                .pending_files,
            2
        );
        assert!(fixture
            .repository
            .backup_pair(1, &fixture.pair_id)
            .unwrap()
            .last_synced_at
            .is_none());
    }

    #[tokio::test]
    async fn backup_state_write_failure_cannot_report_success() {
        let fixture = Fixture::new();
        let database = rusqlite::Connection::open(fixture.root.join("state.sqlite3")).unwrap();
        database.execute_batch("CREATE TRIGGER fail_backup_record BEFORE INSERT ON backup_file_state BEGIN SELECT RAISE(FAIL, 'simulated disk write failure'); END;").unwrap();
        let report = run_with_provider(
            &MockProvider::default(),
            Arc::clone(&fixture.repository),
            1,
            fixture.pair_id.clone(),
            None,
        )
        .await
        .unwrap();
        assert!(!report.completed);
        assert_eq!(report.uploaded, 0);
        assert_eq!(report.failed.len(), 2);
        assert!(report
            .failed
            .iter()
            .all(|item| item.reason.contains("simulated disk write failure")));
        assert_eq!(
            fixture
                .repository
                .scan_backup_pair(1, &fixture.pair_id)
                .unwrap()
                .pending_files,
            2
        );
    }

    #[tokio::test]
    async fn backup_completion_timestamp_failure_is_exposed() {
        let fixture = Fixture::new();
        let database = rusqlite::Connection::open(fixture.root.join("state.sqlite3")).unwrap();
        database.execute_batch("CREATE TRIGGER fail_backup_touch BEFORE UPDATE ON backup_pairs BEGIN SELECT RAISE(FAIL, 'simulated timestamp failure'); END;").unwrap();
        let report = run_with_provider(
            &MockProvider::default(),
            Arc::clone(&fixture.repository),
            1,
            fixture.pair_id.clone(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(report.uploaded, 2);
        assert!(!report.completed);
        assert_eq!(report.failed.len(), 1);
        assert!(report.failed[0]
            .reason
            .contains("simulated timestamp failure"));
    }
}
