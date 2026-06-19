use std::env;
use std::path::{Component, Path, PathBuf};

use unicode_normalization::UnicodeNormalization;

const NARROW_NO_BREAK_SPACE: char = '\u{202f}';

fn normalize_unicode_spaces(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if matches!(
                ch,
                '\u{00a0}' | '\u{2000}'..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}'
            ) {
                ' '
            } else {
                ch
            }
        })
        .collect()
}

fn normalize_at_prefix(file_path: &str) -> &str {
    file_path.strip_prefix('@').unwrap_or(file_path)
}

fn home_dir_string() -> Option<String> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .or_else(|| {
            let drive = env::var_os("HOMEDRIVE")?;
            let path = env::var_os("HOMEPATH")?;
            let mut combined = drive;
            combined.push(path);
            Some(combined)
        })
        .map(|home| PathBuf::from(home).to_string_lossy().into_owned())
}

pub fn expand_path(file_path: &str) -> String {
    let normalized = normalize_unicode_spaces(normalize_at_prefix(file_path));

    if normalized == "~" {
        return home_dir_string().unwrap_or(normalized);
    }

    if normalized.starts_with("~/")
        && let Some(home) = home_dir_string()
    {
        return format!("{home}{}", &normalized[1..]);
    }

    normalized
}

pub fn resolve_to_cwd(file_path: &str, cwd: impl AsRef<Path>) -> PathBuf {
    let expanded = expand_path(file_path);
    let expanded_path = Path::new(&expanded);

    if expanded_path.is_absolute() {
        return normalize_lexically(expanded_path.to_path_buf());
    }

    let cwd = cwd.as_ref();
    let base = if cwd.is_absolute() {
        cwd.to_path_buf()
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(cwd)
    };

    normalize_lexically(base.join(expanded_path))
}

pub fn resolve_read_path(file_path: &str, cwd: impl AsRef<Path>) -> PathBuf {
    let resolved = resolve_to_cwd(file_path, cwd);

    if file_exists(&resolved) {
        return resolved;
    }

    if let Some(am_pm_variant) = path_string_variant(&resolved, try_macos_screenshot_path)
        && am_pm_variant != resolved
        && file_exists(&am_pm_variant)
    {
        return am_pm_variant;
    }

    if let Some(nfd_variant) = path_string_variant(&resolved, try_nfd_variant) {
        if nfd_variant != resolved && file_exists(&nfd_variant) {
            return nfd_variant;
        }

        if let Some(curly_variant) = path_string_variant(&resolved, try_curly_quote_variant)
            && curly_variant != resolved
            && file_exists(&curly_variant)
        {
            return curly_variant;
        }

        if let Some(nfd_curly_variant) = path_string_variant(&nfd_variant, try_curly_quote_variant)
            && nfd_curly_variant != resolved
            && file_exists(&nfd_curly_variant)
        {
            return nfd_curly_variant;
        }
    }

    resolved
}

fn file_exists(file_path: &Path) -> bool {
    file_path.exists()
}

fn path_string_variant(file_path: &Path, transform: fn(&str) -> String) -> Option<PathBuf> {
    file_path.to_str().map(transform).map(PathBuf::from)
}

fn try_macos_screenshot_path(file_path: &str) -> String {
    let mut result = String::with_capacity(file_path.len());
    let mut index = 0;

    while index < file_path.len() {
        let remaining = &file_path[index..];
        let bytes = remaining.as_bytes();

        if bytes.len() >= 4
            && bytes[0] == b' '
            && matches!(bytes[1], b'A' | b'a' | b'P' | b'p')
            && matches!(bytes[2], b'M' | b'm')
            && bytes[3] == b'.'
        {
            result.push(NARROW_NO_BREAK_SPACE);
            result.push(bytes[1] as char);
            result.push(bytes[2] as char);
            result.push('.');
            index += 4;
            continue;
        }

        let ch = remaining.chars().next().expect("non-empty slice");
        result.push(ch);
        index += ch.len_utf8();
    }

    result
}

fn try_nfd_variant(file_path: &str) -> String {
    file_path.nfd().collect()
}

fn try_curly_quote_variant(file_path: &str) -> String {
    file_path.replace('\'', "\u{2019}")
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
    use std::fs;
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
                let path = base.join(format!("path-utils-test-{pid}-{nanos}-{attempt}"));

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

    fn write_file(path: impl AsRef<Path>) {
        fs::write(path, "content").unwrap();
    }

    #[test]
    fn expand_path_expands_home_directory() {
        let result = expand_path("~");

        assert!(!result.contains('~'));
    }

    #[test]
    fn expand_path_expands_home_prefixed_paths() {
        let result = expand_path("~/Documents/file.txt");

        assert!(!result.contains("~/"));
        assert!(result.ends_with("/Documents/file.txt"));
    }

    #[test]
    fn expand_path_strips_at_prefix() {
        assert_eq!(expand_path("@file.txt"), "file.txt");
    }

    #[test]
    fn expand_path_strips_at_prefix_before_home_expansion() {
        let result = expand_path("@~/Documents/file.txt");

        assert!(!result.contains("@~"));
        assert!(!result.contains("~/"));
        assert!(result.ends_with("/Documents/file.txt"));
    }

    #[test]
    fn expand_path_normalizes_unicode_spaces() {
        assert_eq!(expand_path("file\u{00a0}name.txt"), "file name.txt");
        assert_eq!(
            expand_path("one\u{2000}two\u{202f}three\u{3000}four.txt"),
            "one two three four.txt"
        );
    }

    #[test]
    fn resolve_to_cwd_keeps_absolute_paths() {
        let result = resolve_to_cwd("/absolute/path/file.txt", "/some/cwd");

        assert_eq!(result, PathBuf::from("/absolute/path/file.txt"));
    }

    #[test]
    fn resolve_to_cwd_resolves_relative_paths_against_cwd() {
        let result = resolve_to_cwd("relative/file.txt", "/some/cwd");

        assert_eq!(result, PathBuf::from("/some/cwd/relative/file.txt"));
    }

    #[test]
    fn resolve_to_cwd_normalizes_dot_segments() {
        let result = resolve_to_cwd("relative/../file.txt", "/some/cwd/.");

        assert_eq!(result, PathBuf::from("/some/cwd/file.txt"));
    }

    #[test]
    fn resolve_read_path_resolves_existing_file_path() {
        let temp_dir = TempDir::new().unwrap();
        let file_name = "test-file.txt";
        write_file(temp_dir.path().join(file_name));

        let result = resolve_read_path(file_name, temp_dir.path());

        assert_eq!(result, temp_dir.path().join(file_name));
    }

    #[test]
    fn resolve_read_path_strips_at_prefix() {
        let temp_dir = TempDir::new().unwrap();
        let file_name = "prefixed.txt";
        write_file(temp_dir.path().join(file_name));

        let result = resolve_read_path(format!("@{file_name}").as_str(), temp_dir.path());

        assert_eq!(result, temp_dir.path().join(file_name));
    }

    #[test]
    fn resolve_read_path_normalizes_unicode_spaces_before_lookup() {
        let temp_dir = TempDir::new().unwrap();
        let file_name = "file name.txt";
        write_file(temp_dir.path().join(file_name));

        let result = resolve_read_path("file\u{00a0}name.txt", temp_dir.path());

        assert_eq!(result, temp_dir.path().join(file_name));
    }

    #[test]
    fn resolve_read_path_handles_nfc_vs_nfd_unicode_normalization() {
        let temp_dir = TempDir::new().unwrap();
        let nfd_file_name = "file\u{0065}\u{0301}.txt";
        let nfc_file_name = "file\u{00e9}.txt";

        assert_ne!(nfd_file_name, nfc_file_name);
        assert_ne!(nfd_file_name.as_bytes(), nfc_file_name.as_bytes());
        assert_eq!(try_nfd_variant(nfc_file_name), nfd_file_name);

        write_file(temp_dir.path().join(nfd_file_name));

        let result = resolve_read_path(nfc_file_name, temp_dir.path());
        let result_string = result.to_string_lossy();

        assert!(result_string.contains(temp_dir.path().to_string_lossy().as_ref()));
        assert!(result_string.contains("file"));
        assert!(result_string.ends_with(".txt"));
        assert!(file_exists(&result));
    }

    #[test]
    fn resolve_read_path_handles_curly_quotes_vs_straight_quotes() {
        let temp_dir = TempDir::new().unwrap();
        let curly_quote_name = "Capture d\u{2019}cran.txt";
        let straight_quote_name = "Capture d'cran.txt";

        assert_ne!(curly_quote_name, straight_quote_name);

        write_file(temp_dir.path().join(curly_quote_name));

        let result = resolve_read_path(straight_quote_name, temp_dir.path());

        assert_eq!(result, temp_dir.path().join(curly_quote_name));
    }

    #[test]
    fn resolve_read_path_handles_combined_nfc_and_curly_quote() {
        let temp_dir = TempDir::new().unwrap();
        let nfc_curly_name = "Capture d\u{2019}\u{00e9}cran.txt";
        let nfc_straight_name = "Capture d'\u{00e9}cran.txt";

        assert_ne!(nfc_curly_name, nfc_straight_name);

        write_file(temp_dir.path().join(nfc_curly_name));

        let result = resolve_read_path(nfc_straight_name, temp_dir.path());

        assert_eq!(result, temp_dir.path().join(nfc_curly_name));
    }

    #[test]
    fn resolve_read_path_handles_combined_nfd_and_curly_quote() {
        let temp_dir = TempDir::new().unwrap();
        let nfd_curly_name = "Capture d\u{2019}e\u{0301}cran.txt";
        let nfc_straight_name = "Capture d'\u{00e9}cran.txt";

        assert_eq!(
            try_curly_quote_variant(&try_nfd_variant(nfc_straight_name)),
            nfd_curly_name
        );

        write_file(temp_dir.path().join(nfd_curly_name));

        let result = resolve_read_path(nfc_straight_name, temp_dir.path());
        let result_string = result.to_string_lossy();

        assert!(result_string.contains('\u{2019}'));
        assert!(result_string.contains("cran.txt"));
        assert!(file_exists(&result));
    }

    #[test]
    fn resolve_read_path_handles_macos_screenshot_am_pm_narrow_no_break_space() {
        let temp_dir = TempDir::new().unwrap();
        let macos_name = "Screenshot 2024-01-01 at 10.00.00\u{202f}AM.png";
        let user_name = "Screenshot 2024-01-01 at 10.00.00 AM.png";

        write_file(temp_dir.path().join(macos_name));

        let result = resolve_read_path(user_name, temp_dir.path());

        assert_eq!(result, temp_dir.path().join(macos_name));
    }

    #[test]
    fn resolve_read_path_handles_macos_screenshot_lowercase_am_pm_variant() {
        let temp_dir = TempDir::new().unwrap();
        let macos_name = "Screenshot 2024-01-01 at 10.00.00\u{202f}am.png";
        let user_name = "Screenshot 2024-01-01 at 10.00.00 am.png";

        write_file(temp_dir.path().join(macos_name));

        let result = resolve_read_path(user_name, temp_dir.path());

        assert_eq!(result, temp_dir.path().join(macos_name));
    }

    #[test]
    fn resolve_read_path_combines_at_prefix_unicode_space_and_screenshot_fallback() {
        let temp_dir = TempDir::new().unwrap();
        let macos_name = "Screenshot 2024-01-01 at 10.00.00\u{202f}PM.png";
        let user_name = "@Screenshot\u{00a0}2024-01-01\u{00a0}at\u{00a0}10.00.00\u{00a0}PM.png";

        write_file(temp_dir.path().join(macos_name));

        let result = resolve_read_path(user_name, temp_dir.path());

        assert_eq!(result, temp_dir.path().join(macos_name));
    }
}
