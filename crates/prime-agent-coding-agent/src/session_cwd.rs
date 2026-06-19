use std::error::Error;
use std::fmt;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionCwdIssue {
    pub session_file: Option<PathBuf>,
    pub session_cwd: PathBuf,
    pub fallback_cwd: PathBuf,
}

pub trait SessionCwdSource {
    fn cwd(&self) -> &Path;
    fn session_file(&self) -> Option<&Path>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingSessionCwdError {
    pub issue: SessionCwdIssue,
}

impl MissingSessionCwdError {
    pub fn new(issue: SessionCwdIssue) -> Self {
        Self { issue }
    }
}

impl fmt::Display for MissingSessionCwdError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&format_missing_session_cwd_error(&self.issue))
    }
}

impl Error for MissingSessionCwdError {}

pub fn get_missing_session_cwd_issue(
    session: &impl SessionCwdSource,
    fallback_cwd: impl AsRef<Path>,
) -> Option<SessionCwdIssue> {
    let session_file = session.session_file()?;
    let session_cwd = session.cwd();

    if session_cwd.as_os_str().is_empty() || session_cwd.exists() {
        return None;
    }

    Some(SessionCwdIssue {
        session_file: Some(session_file.to_path_buf()),
        session_cwd: session_cwd.to_path_buf(),
        fallback_cwd: fallback_cwd.as_ref().to_path_buf(),
    })
}

pub fn format_missing_session_cwd_error(issue: &SessionCwdIssue) -> String {
    let session_file = issue
        .session_file
        .as_ref()
        .map(|path| format!("\nSession file: {}", path.display()))
        .unwrap_or_default();

    format!(
        "Stored session working directory does not exist: {}{session_file}\nCurrent working directory: {}",
        issue.session_cwd.display(),
        issue.fallback_cwd.display()
    )
}

pub fn format_missing_session_cwd_prompt(issue: &SessionCwdIssue) -> String {
    format!(
        "cwd from session file does not exist\n{}\n\ncontinue in current cwd\n{}",
        issue.session_cwd.display(),
        issue.fallback_cwd.display()
    )
}

pub fn assert_session_cwd_exists(
    session: &impl SessionCwdSource,
    fallback_cwd: impl AsRef<Path>,
) -> Result<(), MissingSessionCwdError> {
    if let Some(issue) = get_missing_session_cwd_issue(session, fallback_cwd) {
        return Err(MissingSessionCwdError::new(issue));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[derive(Debug)]
    struct TestSession {
        cwd: PathBuf,
        session_file: Option<PathBuf>,
    }

    impl SessionCwdSource for TestSession {
        fn cwd(&self) -> &Path {
            &self.cwd
        }

        fn session_file(&self) -> Option<&Path> {
            self.session_file.as_deref()
        }
    }

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
                    Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(err) => return Err(err),
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

    #[test]
    fn detects_missing_session_cwd_when_session_file_exists() {
        let fallback = TempDir::new("session-cwd-fallback").unwrap();
        let session_file = fallback.path.join("session.jsonl");
        let missing_cwd = fallback.path.join("does-not-exist");
        let session = TestSession {
            cwd: missing_cwd.clone(),
            session_file: Some(session_file.clone()),
        };

        let issue = get_missing_session_cwd_issue(&session, &fallback.path).unwrap();

        assert_eq!(
            issue,
            SessionCwdIssue {
                session_file: Some(session_file),
                session_cwd: missing_cwd,
                fallback_cwd: fallback.path.clone(),
            }
        );
    }

    #[test]
    fn returns_none_without_session_file() {
        let fallback = TempDir::new("session-cwd-no-file").unwrap();
        let session = TestSession {
            cwd: fallback.path.join("does-not-exist"),
            session_file: None,
        };

        assert_eq!(
            get_missing_session_cwd_issue(&session, &fallback.path),
            None
        );
    }

    #[test]
    fn returns_none_when_session_cwd_exists() {
        let fallback = TempDir::new("session-cwd-exists").unwrap();
        let session = TestSession {
            cwd: fallback.path.clone(),
            session_file: Some(fallback.path.join("session.jsonl")),
        };

        assert_eq!(
            get_missing_session_cwd_issue(&session, &fallback.path),
            None
        );
    }

    #[test]
    fn formats_missing_session_cwd_error_with_session_file() {
        let issue = SessionCwdIssue {
            session_file: Some(PathBuf::from("/tmp/session.jsonl")),
            session_cwd: PathBuf::from("/tmp/missing"),
            fallback_cwd: PathBuf::from("/tmp/current"),
        };

        assert_eq!(
            format_missing_session_cwd_error(&issue),
            "Stored session working directory does not exist: /tmp/missing\nSession file: /tmp/session.jsonl\nCurrent working directory: /tmp/current"
        );
    }

    #[test]
    fn formats_missing_session_cwd_error_without_session_file() {
        let issue = SessionCwdIssue {
            session_file: None,
            session_cwd: PathBuf::from("/tmp/missing"),
            fallback_cwd: PathBuf::from("/tmp/current"),
        };

        assert_eq!(
            format_missing_session_cwd_error(&issue),
            "Stored session working directory does not exist: /tmp/missing\nCurrent working directory: /tmp/current"
        );
    }

    #[test]
    fn formats_missing_session_cwd_prompt() {
        let issue = SessionCwdIssue {
            session_file: Some(PathBuf::from("/tmp/session.jsonl")),
            session_cwd: PathBuf::from("/tmp/missing"),
            fallback_cwd: PathBuf::from("/tmp/current"),
        };

        assert_eq!(
            format_missing_session_cwd_prompt(&issue),
            "cwd from session file does not exist\n/tmp/missing\n\ncontinue in current cwd\n/tmp/current"
        );
    }

    #[test]
    fn assert_session_cwd_exists_returns_controlled_error() {
        let fallback = TempDir::new("session-cwd-assert").unwrap();
        let missing_cwd = fallback.path.join("does-not-exist");
        let session = TestSession {
            cwd: missing_cwd.clone(),
            session_file: Some(fallback.path.join("session.jsonl")),
        };

        let err = assert_session_cwd_exists(&session, &fallback.path).unwrap_err();

        assert_eq!(err.issue.session_cwd, missing_cwd);
        assert_eq!(
            err.to_string(),
            format_missing_session_cwd_error(&err.issue)
        );
    }
}
