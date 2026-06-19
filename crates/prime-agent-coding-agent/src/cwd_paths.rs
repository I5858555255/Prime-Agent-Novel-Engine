use std::env;
use std::fs;
use std::path::{Component, MAIN_SEPARATOR, Path, PathBuf};

/// Resolve a path to its canonical form, following symlinks.
///
/// If resolution fails, returns the original path unchanged so callers can pass
/// paths that do not exist yet without turning that into an error.
pub fn canonicalize_path(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Returns true if the value is not a package source or URL protocol.
///
/// Bare names and relative paths without a `./` prefix are considered local.
pub fn is_local_path(value: &str) -> bool {
    let trimmed = value.trim();

    !["npm:", "git:", "github:", "http:", "https:", "ssh:"]
        .iter()
        .any(|prefix| trimmed.starts_with(prefix))
}

pub fn get_cwd_relative_path(file_path: impl AsRef<Path>, cwd: impl AsRef<Path>) -> Option<String> {
    let resolved_cwd = resolve_path(cwd.as_ref());
    let resolved_path = resolve_against_cwd(file_path.as_ref(), &resolved_cwd);
    let relative_path = resolved_path.strip_prefix(&resolved_cwd).ok()?;

    if relative_path.as_os_str().is_empty() {
        Some(".".to_string())
    } else {
        Some(relative_path.to_string_lossy().into_owned())
    }
}

pub fn format_path_relative_to_cwd_or_absolute(
    file_path: impl AsRef<Path>,
    cwd: impl AsRef<Path>,
) -> String {
    let absolute_path = resolve_against_cwd(file_path.as_ref(), cwd.as_ref());
    let path = get_cwd_relative_path(&absolute_path, cwd.as_ref())
        .unwrap_or_else(|| absolute_path.to_string_lossy().into_owned());

    normalize_separators(&path)
}

fn resolve_against_cwd(file_path: &Path, cwd: &Path) -> PathBuf {
    if file_path.is_absolute() {
        resolve_path(file_path)
    } else {
        normalize_lexically(resolve_path(cwd).join(file_path))
    }
}

fn resolve_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        normalize_lexically(path.to_path_buf())
    } else {
        normalize_lexically(
            env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path),
        )
    }
}

fn normalize_separators(path: &str) -> String {
    if MAIN_SEPARATOR == '/' {
        path.to_string()
    } else {
        path.replace(MAIN_SEPARATOR, "/")
    }
}

fn normalize_lexically(path: PathBuf) -> PathBuf {
    let is_absolute = path.is_absolute();
    let mut normalized = PathBuf::new();

    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() && !is_absolute {
                    normalized.push("..");
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }

    if normalized.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        normalized
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> io::Result<Self> {
            let base = env::temp_dir();
            let pid = std::process::id();

            for attempt in 0..100 {
                let nanos = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                let path = base.join(format!("cwd-paths-test-{pid}-{nanos}-{attempt}"));

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

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn canonicalize_path_falls_back_to_raw_path_when_missing() {
        let missing = PathBuf::from("missing/path.txt");

        assert_eq!(canonicalize_path(&missing), missing);
    }

    #[cfg(unix)]
    #[test]
    fn canonicalize_path_resolves_symlinks() {
        use std::os::unix::fs::symlink;

        let temp_dir = TempDir::new().unwrap();
        let target = temp_dir.path().join("target.txt");
        let link = temp_dir.path().join("link.txt");
        fs::write(&target, "content").unwrap();
        symlink(&target, &link).unwrap();

        assert_eq!(canonicalize_path(&link), fs::canonicalize(&target).unwrap());
    }

    #[test]
    fn is_local_path_rejects_known_non_local_prefixes_after_trimming() {
        for value in [
            "npm:pkg",
            "git:https://example.test/repo",
            "github:owner/repo",
            "http://example.test",
            "https://example.test",
            "ssh://example.test/repo",
            "  npm:pkg  ",
        ] {
            assert!(!is_local_path(value), "{value} should not be local");
        }
    }

    #[test]
    fn is_local_path_accepts_bare_names_and_relative_paths() {
        for value in ["pkg", "./pkg", "../pkg", "relative/path", "/absolute/path"] {
            assert!(is_local_path(value), "{value} should be local");
        }
    }

    #[test]
    fn get_cwd_relative_path_returns_dot_for_cwd() {
        let temp_dir = TempDir::new().unwrap();

        assert_eq!(
            get_cwd_relative_path(temp_dir.path(), temp_dir.path()),
            Some(".".to_string())
        );
    }

    #[test]
    fn get_cwd_relative_path_resolves_relative_paths_against_cwd() {
        let temp_dir = TempDir::new().unwrap();

        assert_eq!(
            get_cwd_relative_path("src/../README.md", temp_dir.path()),
            Some("README.md".to_string())
        );
    }

    #[test]
    fn get_cwd_relative_path_returns_none_for_paths_outside_cwd() {
        let temp_dir = TempDir::new().unwrap();
        let sibling = temp_dir
            .path()
            .parent()
            .unwrap()
            .join("outside-cwd-paths-test-file.txt");

        assert_eq!(get_cwd_relative_path(&sibling, temp_dir.path()), None);
    }

    #[test]
    fn get_cwd_relative_path_does_not_treat_same_prefix_sibling_as_inside() {
        let temp_dir = TempDir::new().unwrap();
        let sibling = temp_dir
            .path()
            .parent()
            .unwrap()
            .join(format!(
                "{}-sibling",
                temp_dir.path().file_name().unwrap().to_string_lossy()
            ))
            .join("file.txt");

        assert_eq!(get_cwd_relative_path(&sibling, temp_dir.path()), None);
    }

    #[test]
    fn format_path_relative_to_cwd_or_absolute_returns_relative_inside_cwd() {
        let temp_dir = TempDir::new().unwrap();

        assert_eq!(
            format_path_relative_to_cwd_or_absolute("src/main.rs", temp_dir.path()),
            "src/main.rs"
        );
    }

    #[test]
    fn format_path_relative_to_cwd_or_absolute_returns_normalized_absolute_outside_cwd() {
        let temp_dir = TempDir::new().unwrap();
        let outside = temp_dir
            .path()
            .parent()
            .unwrap()
            .join("cwd-paths-outside.txt");
        let formatted = format_path_relative_to_cwd_or_absolute(&outside, temp_dir.path());

        assert!(formatted.contains('/'));
        assert!(!formatted.contains('\\'));
        assert!(formatted.ends_with("/cwd-paths-outside.txt"));
    }
}
