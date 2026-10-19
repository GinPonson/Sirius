use std::sync::Mutex;

/// 给钥匙串读取错误附加可执行的重新授权指引，不包含或记录凭据内容。
///
/// `error` 是底层读取错误文本；返回值保留原错误，并说明授权后重新打开应用的处理方式。
#[cfg(any(test, all(not(debug_assertions), target_os = "macos")))]
pub(crate) fn keychain_read_error(error: impl std::fmt::Display) -> String {
    format!("{error}。如系统提示钥匙串访问授权，请允许 Sirius 访问此凭据后重新打开应用")
}

/// 进程内凭据快照；首次读取结果（包括缺失或错误）会一直复用到进程退出。
enum CacheState<T> {
    Uninitialized,
    Loaded(Result<Option<T>, String>),
}

/// 串行化一个凭据的首次读取和持久化更新，避免钥匙串并发访问及旧值覆盖新值。
pub(crate) struct CredentialCache<T: Clone> {
    state: Mutex<CacheState<T>>,
}

impl<T: Clone> CredentialCache<T> {
    /// 创建尚未读取凭据的空缓存。
    pub(crate) const fn new() -> Self {
        Self {
            state: Mutex::new(CacheState::Uninitialized),
        }
    }

    /// 返回已缓存的凭据状态；首次调用时执行 `read` 并缓存成功或失败结果。
    ///
    /// `read` 仅在缓存尚未初始化时执行一次，返回 `Ok(None)` 表示凭据不存在；读取错误
    /// 会原样保留并在后续调用继续返回。底层读取期间持锁，以免并发首次访问重复触发系统授权。
    pub(crate) fn load(
        &self,
        read: impl FnOnce() -> Result<Option<T>, String>,
    ) -> Result<Option<T>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "凭据缓存锁已损坏".to_string())?;
        match &*state {
            CacheState::Loaded(result) => result.clone(),
            CacheState::Uninitialized => {
                let result = read();
                *state = CacheState::Loaded(result.clone());
                result
            }
        }
    }

    /// 持久化 `value` 后更新缓存；`persist` 失败时保留原缓存状态并返回原错误。
    ///
    /// `value` 是要写入的凭据快照，`persist` 负责实际存储；只有持久化成功才会返回 `Ok(())`
    /// 并让后续读取立即看到新值。
    pub(crate) fn save(
        &self,
        value: T,
        persist: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "凭据缓存锁已损坏".to_string())?;
        persist()?;
        *state = CacheState::Loaded(Ok(Some(value)));
        Ok(())
    }

    /// 仅当缓存仍与 `expected` 完全一致时持久化并替换为 `value`。
    ///
    /// `expected` 是发起异步操作时读取的凭据快照，`value` 是基于该快照产生的更新；
    /// `persist` 收到待写入值并执行同步持久化。若期间凭据已变化，返回 `Ok(false)` 且不写入；
    /// 锁会覆盖比较、持久化和缓存替换，避免旧快照覆盖并发刷新或账号切换后的凭据。
    pub(crate) fn update_if_equal(
        &self,
        expected: &T,
        value: T,
        persist: impl FnOnce(&T) -> Result<(), String>,
    ) -> Result<bool, String>
    where
        T: PartialEq,
    {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "凭据缓存锁已损坏".to_string())?;
        match &*state {
            CacheState::Loaded(Ok(Some(current))) if current == expected => {}
            CacheState::Loaded(Err(error)) => return Err(error.clone()),
            CacheState::Uninitialized => {
                return Err("凭据缓存尚未读取，不能执行条件更新".to_string())
            }
            _ => return Ok(false),
        }
        persist(&value)?;
        *state = CacheState::Loaded(Ok(Some(value)));
        Ok(true)
    }

    /// 删除持久凭据后把缓存设为空；删除失败时保留原缓存状态并返回原错误。
    ///
    /// `delete` 负责实际存储删除；只有删除成功才会返回 `Ok(())` 并让后续读取看到未配置。
    pub(crate) fn delete(&self, delete: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "凭据缓存锁已损坏".to_string())?;
        delete()?;
        *state = CacheState::Loaded(Ok(None));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::CredentialCache;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Barrier,
    };
    use std::thread;
    use std::time::Duration;

    /// 并发首次读取只执行一次底层读取，并将同一结果交给所有调用方。
    #[test]
    fn concurrent_first_read_runs_once() {
        let cache = Arc::new(CredentialCache::new());
        let read_count = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let cache = Arc::clone(&cache);
                let read_count = Arc::clone(&read_count);
                let start = Arc::clone(&start);
                thread::spawn(move || {
                    start.wait();
                    cache.load(|| {
                        read_count.fetch_add(1, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(10));
                        Ok(Some(42))
                    })
                })
            })
            .collect();

        for worker in workers {
            assert_eq!(worker.join().unwrap().unwrap(), Some(42));
        }
        assert_eq!(read_count.load(Ordering::SeqCst), 1);
    }

    /// 首次读取发现凭据不存在后会缓存 `None`，不再访问底层存储。
    #[test]
    fn caches_missing_credential() {
        let cache = CredentialCache::<u8>::new();
        let read_count = AtomicUsize::new(0);

        assert_eq!(
            cache
                .load(|| {
                    read_count.fetch_add(1, Ordering::SeqCst);
                    Ok(None)
                })
                .unwrap(),
            None
        );
        assert_eq!(
            cache
                .load(|| panic!("cached missing value must skip storage"))
                .unwrap(),
            None
        );
        assert_eq!(read_count.load(Ordering::SeqCst), 1);
    }

    /// 首次读取失败后持续返回相同错误，避免系统授权失败引发自动重试风暴。
    #[test]
    fn caches_read_error() {
        let cache = CredentialCache::<u8>::new();
        let read_count = AtomicUsize::new(0);

        let first_error = cache
            .load(|| {
                read_count.fetch_add(1, Ordering::SeqCst);
                Err(super::keychain_read_error(
                    "读取 macOS 钥匙串失败：访问被拒绝",
                ))
            })
            .unwrap_err();
        let second_error = cache
            .load(|| panic!("cached read error must skip storage"))
            .unwrap_err();

        assert_eq!(first_error, second_error);
        assert!(second_error.contains("重新打开应用"));
        assert_eq!(read_count.load(Ordering::SeqCst), 1);
    }

    /// 成功保存和删除后，后续读取立即返回对应状态且不再访问底层读取函数。
    #[test]
    fn save_and_delete_update_cached_state() {
        let cache = CredentialCache::new();
        let write_count = AtomicUsize::new(0);

        cache
            .save(7_u8, || {
                write_count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .unwrap();
        assert_eq!(
            cache.load(|| panic!("saved value must be cached")).unwrap(),
            Some(7)
        );

        cache
            .delete(|| {
                write_count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .unwrap();
        assert_eq!(
            cache
                .load(|| panic!("deleted value must be cached"))
                .unwrap(),
            None
        );
        assert_eq!(write_count.load(Ordering::SeqCst), 2);
    }

    /// 持久化失败不会把未落盘的新值或删除状态伪装成缓存成功。
    #[test]
    fn persistence_failure_preserves_cached_state() {
        let cache = CredentialCache::<u8>::new();
        assert_eq!(
            cache
                .save(9, || Err("write failed".to_string()))
                .unwrap_err(),
            "write failed"
        );
        assert_eq!(
            cache
                .load(|| Ok(Some(3)))
                .expect("a failed save must leave the cache uninitialized"),
            Some(3)
        );

        assert_eq!(
            cache
                .delete(|| Err("delete failed".to_string()))
                .unwrap_err(),
            "delete failed"
        );
        assert_eq!(
            cache
                .load(|| panic!("cached value must survive failed deletion"))
                .unwrap(),
            Some(3)
        );
    }

    /// 条件更新遇到不同的当前凭据时不执行持久化，也不覆盖新快照。
    #[test]
    fn conditional_update_rejects_changed_snapshot() {
        let cache = CredentialCache::new();
        let writes = AtomicUsize::new(0);
        cache
            .save("new-token".to_string(), || Ok(()))
            .expect("initial token should save");

        assert!(!cache
            .update_if_equal(
                &"old-token".to_string(),
                "old-token-with-id".to_string(),
                |_| {
                    writes.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            )
            .expect("changed token should not be updated"));
        assert_eq!(
            cache
                .load(|| panic!("current token should remain cached"))
                .unwrap(),
            Some("new-token".to_string())
        );
        assert_eq!(writes.load(Ordering::SeqCst), 0);
    }

    /// 条件匹配时仅在持久化成功后更新缓存，持久化失败保留原快照。
    #[test]
    fn conditional_update_persists_before_replacing_cache() {
        let cache = CredentialCache::new();
        let original = "token-without-id".to_string();
        cache
            .save(original.clone(), || Ok(()))
            .expect("initial token should save");

        assert_eq!(
            cache
                .update_if_equal(&original, "token-with-id".to_string(), |_| {
                    Err("keychain write failed".to_string())
                })
                .unwrap_err(),
            "keychain write failed"
        );
        assert_eq!(
            cache
                .load(|| panic!("failed update must preserve the current token"))
                .unwrap(),
            Some(original.clone())
        );

        assert!(cache
            .update_if_equal(&original, "token-with-id".to_string(), |_| Ok(()))
            .expect("matching token should update"));
        assert_eq!(
            cache
                .load(|| panic!("updated token should be cached"))
                .unwrap(),
            Some("token-with-id".to_string())
        );
    }

    /// 首次读取与并发写入由同一把锁排序，完成写入后旧读取不能覆盖缓存新值。
    #[test]
    fn read_write_race_does_not_revert_cached_value() {
        let cache = Arc::new(CredentialCache::new());
        let (read_started_tx, read_started_rx) = mpsc::channel();
        let (finish_read_tx, finish_read_rx) = mpsc::channel();

        let reader_cache = Arc::clone(&cache);
        let reader = thread::spawn(move || {
            reader_cache.load(|| {
                read_started_tx.send(()).unwrap();
                finish_read_rx.recv().unwrap();
                Ok(Some(1))
            })
        });
        read_started_rx.recv().unwrap();

        let writer_cache = Arc::clone(&cache);
        let writer = thread::spawn(move || writer_cache.save(2, || Ok(())));
        finish_read_tx.send(()).unwrap();

        assert_eq!(reader.join().unwrap().unwrap(), Some(1));
        writer.join().unwrap().unwrap();
        assert_eq!(
            cache
                .load(|| panic!("writer must leave its value cached"))
                .unwrap(),
            Some(2)
        );
    }
}
