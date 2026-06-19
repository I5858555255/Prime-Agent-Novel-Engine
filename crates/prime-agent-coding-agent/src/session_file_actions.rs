use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteSessionFileMethod {
    Trash,
    Unlink,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeleteSessionFileResult {
    Success { method: DeleteSessionFileMethod },
    Error { error: String },
}

impl DeleteSessionFileResult {
    pub fn ok(method: DeleteSessionFileMethod) -> Self {
        Self::Success { method }
    }

    pub fn error(error: impl Into<String>) -> Self {
        Self::Error {
            error: error.into(),
        }
    }

    pub fn is_ok(&self) -> bool {
        matches!(self, Self::Success { .. })
    }
}

#[derive(Debug)]
struct TrashResult {
    status_success: bool,
    stderr: Vec<u8>,
    error: Option<io::Error>,
}

trait SessionFileRemover {
    fn trash(&self, args: &[OsString]) -> TrashResult;
    fn file_exists(&self, path: &Path) -> bool;
    fn unlink(&self, path: &Path) -> io::Result<()>;
}

#[derive(Debug, Default)]
struct SystemSessionFileRemover;

impl SessionFileRemover for SystemSessionFileRemover {
    fn trash(&self, args: &[OsString]) -> TrashResult {
        match Command::new("trash").args(args).output() {
            Ok(output) => TrashResult {
                status_success: output.status.success(),
                stderr: output.stderr,
                error: None,
            },
            Err(error) => TrashResult {
                status_success: false,
                stderr: Vec::new(),
                error: Some(error),
            },
        }
    }

    fn file_exists(&self, path: &Path) -> bool {
        path.exists()
    }

    fn unlink(&self, path: &Path) -> io::Result<()> {
        fs::remove_file(path)
    }
}

pub fn session_artifacts_dir(session_path: impl AsRef<Path>) -> Option<PathBuf> {
    let session_path = session_path.as_ref();
    let session_id = session_path.file_name()?.to_string_lossy();
    let session_id = session_id.strip_suffix(".jsonl").unwrap_or(&session_id);

    if session_id.is_empty() {
        return None;
    }

    let sessions_parent = session_path.parent()?.parent()?;
    Some(sessions_parent.join("session-artifacts").join(session_id))
}

pub fn delete_session_artifacts(session_path: impl AsRef<Path>) -> io::Result<()> {
    let Some(artifact_dir) = session_artifacts_dir(session_path) else {
        return Ok(());
    };

    match fs::remove_dir_all(&artifact_dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

pub fn remove_session_file(session_path: impl AsRef<Path>) -> DeleteSessionFileResult {
    remove_session_file_with_remover(session_path.as_ref(), &SystemSessionFileRemover)
}

pub fn delete_session_file(session_path: impl AsRef<Path>) -> DeleteSessionFileResult {
    let session_path = session_path.as_ref();
    let result = remove_session_file(session_path);

    if result.is_ok()
        && let Err(error) = delete_session_artifacts(session_path)
    {
        return DeleteSessionFileResult::error(error.to_string());
    }

    result
}

fn remove_session_file_with_remover(
    session_path: &Path,
    remover: &impl SessionFileRemover,
) -> DeleteSessionFileResult {
    let trash_args = trash_args_for_path(session_path);
    let trash_result = remover.trash(&trash_args);

    if trash_result.status_success || !remover.file_exists(session_path) {
        return DeleteSessionFileResult::ok(DeleteSessionFileMethod::Trash);
    }

    match remover.unlink(session_path) {
        Ok(()) => DeleteSessionFileResult::ok(DeleteSessionFileMethod::Unlink),
        Err(error) => {
            let unlink_error = error.to_string();
            let error = trash_error_hint(&trash_result)
                .map(|hint| format!("{unlink_error} ({hint})"))
                .unwrap_or(unlink_error);
            DeleteSessionFileResult::error(error)
        }
    }
}

fn trash_args_for_path(path: &Path) -> Vec<OsString> {
    let path_arg = path.as_os_str().to_os_string();

    if path_arg.to_string_lossy().starts_with('-') {
        vec![OsString::from("--"), path_arg]
    } else {
        vec![path_arg]
    }
}

fn trash_error_hint(result: &TrashResult) -> Option<String> {
    let mut parts = Vec::new();

    if let Some(error) = &result.error {
        parts.push(error.to_string());
    }

    let stderr = String::from_utf8_lossy(&result.stderr);
    if let Some(first_line) = stderr.trim().lines().next()
        && !first_line.is_empty()
    {
        parts.push(first_line.to_owned());
    }

    if parts.is_empty() {
        None
    } else {
        Some(format!(
            "trash: {}",
            truncate_chars(&parts.join(" - "), 200)
        ))
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(prefix: &str) -> io::Result<Self> {
            let base = std::env::temp_dir();
            let pid = std::process::id();

            for attempt in 0..100 {
                let nanos = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                let path = base.join(format!("{prefix}-{pid}-{nanos}-{attempt}"));

                match fs::create_dir(&path) {
                    Ok(()) => return Ok(Self { path }),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(error),
                }
            }

            Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "could not create unique temp dir",
            ))
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[derive(Debug)]
    struct FakeRemover {
        trash_result: TrashResult,
        exists: RefCell<bool>,
        unlink_result: RefCell<Option<io::Result<()>>>,
        trash_args: RefCell<Vec<OsString>>,
        unlinked: RefCell<Vec<PathBuf>>,
    }

    impl FakeRemover {
        fn new(trash_result: TrashResult, exists: bool, unlink_result: io::Result<()>) -> Self {
            Self {
                trash_result,
                exists: RefCell::new(exists),
                unlink_result: RefCell::new(Some(unlink_result)),
                trash_args: RefCell::new(Vec::new()),
                unlinked: RefCell::new(Vec::new()),
            }
        }
    }

    impl SessionFileRemover for FakeRemover {
        fn trash(&self, args: &[OsString]) -> TrashResult {
            self.trash_args.borrow_mut().extend(args.iter().cloned());
            TrashResult {
                status_success: self.trash_result.status_success,
                stderr: self.trash_result.stderr.clone(),
                error: self
                    .trash_result
                    .error
                    .as_ref()
                    .map(|error| io::Error::new(error.kind(), error.to_string())),
            }
        }

        fn file_exists(&self, _path: &Path) -> bool {
            *self.exists.borrow()
        }

        fn unlink(&self, path: &Path) -> io::Result<()> {
            self.unlinked.borrow_mut().push(path.to_path_buf());
            let result = self
                .unlink_result
                .borrow_mut()
                .take()
                .expect("unlink called more than once");
            if result.is_ok() {
                *self.exists.borrow_mut() = false;
            }
            result
        }
    }

    fn trash_result(status_success: bool, stderr: &str) -> TrashResult {
        TrashResult {
            status_success,
            stderr: stderr.as_bytes().to_vec(),
            error: None,
        }
    }

    #[test]
    fn derives_artifact_dir_from_session_file() {
        let path = Path::new("/tmp/prime/sessions/session-123.jsonl");

        assert_eq!(
            session_artifacts_dir(path),
            Some(PathBuf::from("/tmp/prime/session-artifacts/session-123"))
        );
    }

    #[test]
    fn delete_session_file_removes_artifacts_after_file_is_removed() {
        let temp = TempDir::new("session-file-actions-delete").unwrap();
        let sessions_dir = temp.path.join("sessions");
        let artifacts_dir = temp.path.join("session-artifacts").join("abc");
        let session_file = sessions_dir.join("abc.jsonl");

        fs::create_dir(&sessions_dir).unwrap();
        fs::create_dir_all(&artifacts_dir).unwrap();
        fs::write(&session_file, "{}\n").unwrap();
        fs::write(artifacts_dir.join("state.json"), "{}").unwrap();

        let result = delete_session_file(&session_file);

        assert!(matches!(
            result,
            DeleteSessionFileResult::Success {
                method: DeleteSessionFileMethod::Trash | DeleteSessionFileMethod::Unlink
            }
        ));
        assert!(!session_file.exists());
        assert!(!artifacts_dir.exists());
    }

    #[test]
    fn remove_session_file_uses_trash_when_trash_succeeds() {
        let remover = FakeRemover::new(trash_result(true, ""), true, Ok(()));
        let result = remove_session_file_with_remover(Path::new("session.jsonl"), &remover);

        assert_eq!(
            result,
            DeleteSessionFileResult::ok(DeleteSessionFileMethod::Trash)
        );
        assert!(remover.unlinked.borrow().is_empty());
    }

    #[test]
    fn remove_session_file_treats_missing_file_after_trash_as_trash_success() {
        let remover = FakeRemover::new(trash_result(false, "trash failed"), false, Ok(()));
        let result = remove_session_file_with_remover(Path::new("session.jsonl"), &remover);

        assert_eq!(
            result,
            DeleteSessionFileResult::ok(DeleteSessionFileMethod::Trash)
        );
        assert!(remover.unlinked.borrow().is_empty());
    }

    #[test]
    fn remove_session_file_falls_back_to_unlink() {
        let remover = FakeRemover::new(trash_result(false, "trash failed"), true, Ok(()));
        let result = remove_session_file_with_remover(Path::new("session.jsonl"), &remover);

        assert_eq!(
            result,
            DeleteSessionFileResult::ok(DeleteSessionFileMethod::Unlink)
        );
        assert_eq!(
            remover.unlinked.borrow().as_slice(),
            &[PathBuf::from("session.jsonl")]
        );
    }

    #[test]
    fn remove_session_file_includes_trash_hint_when_unlink_fails() {
        let remover = FakeRemover::new(
            trash_result(false, "first trash line\nsecond trash line"),
            true,
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "unlink failed",
            )),
        );
        let result = remove_session_file_with_remover(Path::new("session.jsonl"), &remover);

        assert_eq!(
            result,
            DeleteSessionFileResult::error("unlink failed (trash: first trash line)")
        );
    }

    #[test]
    fn trash_args_insert_double_dash_for_dash_prefixed_paths() {
        let remover = FakeRemover::new(trash_result(true, ""), true, Ok(()));

        let _ = remove_session_file_with_remover(Path::new("-session.jsonl"), &remover);

        assert_eq!(
            remover.trash_args.borrow().as_slice(),
            &[OsString::from("--"), OsString::from("-session.jsonl")]
        );
    }
}
