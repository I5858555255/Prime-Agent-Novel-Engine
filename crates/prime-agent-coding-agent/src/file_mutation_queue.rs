use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

type QueueLock = Arc<Mutex<()>>;

fn file_mutation_queues() -> &'static Mutex<HashMap<String, QueueLock>> {
    static FILE_MUTATION_QUEUES: OnceLock<Mutex<HashMap<String, QueueLock>>> = OnceLock::new();
    FILE_MUTATION_QUEUES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn with_file_mutation_queue<T>(
    file_path: impl AsRef<Path>,
    operation: impl FnOnce() -> T,
) -> T {
    let key = get_mutation_queue_key(file_path.as_ref());
    let lock = {
        let mut queues = file_mutation_queues().lock().unwrap();
        queues
            .entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };

    let _guard = lock.lock().unwrap();
    let result = operation();

    let mut queues = file_mutation_queues().lock().unwrap();
    if Arc::strong_count(&lock) == 2 {
        queues.remove(&key);
    }

    result
}

pub fn get_mutation_queue_key_for_tests(file_path: impl AsRef<Path>) -> String {
    get_mutation_queue_key(file_path.as_ref())
}

fn get_mutation_queue_key(file_path: &Path) -> String {
    let resolved_path = if file_path.is_absolute() {
        normalize_lexically(file_path.to_path_buf())
    } else {
        normalize_lexically(
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(file_path),
        )
    };

    fs::canonicalize(&resolved_path)
        .unwrap_or(resolved_path)
        .to_string_lossy()
        .into_owned()
}

fn normalize_lexically(path: PathBuf) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            std::path::Component::RootDir => normalized.push(component.as_os_str()),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                let _ = normalized.pop();
            }
            std::path::Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn temp_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "prime-agent-file-mutation-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn key_uses_canonical_path_when_file_exists() {
        let dir = temp_dir();
        let file = dir.join("file.txt");
        fs::write(&file, "content").unwrap();

        assert_eq!(
            get_mutation_queue_key_for_tests(&file),
            fs::canonicalize(&file).unwrap().to_string_lossy()
        );
    }

    #[test]
    fn key_falls_back_to_resolved_path_when_file_is_missing() {
        let dir = temp_dir();
        let file = dir.join("missing").join("..").join("file.txt");

        let key = get_mutation_queue_key_for_tests(file);

        assert!(key.ends_with("file.txt"));
        assert!(!key.contains("/../"));
    }

    #[test]
    fn serializes_operations_for_same_file() {
        let dir = temp_dir();
        let file = dir.join("file.txt");
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));

        let handles = (0..8)
            .map(|_| {
                let file = file.clone();
                let active = Arc::clone(&active);
                let max_active = Arc::clone(&max_active);
                thread::spawn(move || {
                    with_file_mutation_queue(file, || {
                        let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                        max_active.fetch_max(current, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(5));
                        active.fetch_sub(1, Ordering::SeqCst);
                    });
                })
            })
            .collect::<Vec<_>>();

        for handle in handles {
            handle.join().unwrap();
        }

        assert_eq!(max_active.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn different_files_use_different_queue_keys() {
        let dir = temp_dir();
        let a = get_mutation_queue_key_for_tests(dir.join("a.txt"));
        let b = get_mutation_queue_key_for_tests(dir.join("b.txt"));

        let mut hasher_a = DefaultHasher::new();
        let mut hasher_b = DefaultHasher::new();
        a.hash(&mut hasher_a);
        b.hash(&mut hasher_b);

        assert_ne!(hasher_a.finish(), hasher_b.finish());
    }
}
