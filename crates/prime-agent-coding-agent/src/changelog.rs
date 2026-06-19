use std::fs;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangelogEntry {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Version {
    major: u64,
    minor: u64,
    patch: u64,
}

/// Parse changelog entries from CHANGELOG.md.
///
/// Scans for `##` lines and collects content until the next `##` or EOF.
pub fn parse_changelog(changelog_path: impl AsRef<Path>) -> Vec<ChangelogEntry> {
    let changelog_path = changelog_path.as_ref();
    if !changelog_path.exists() {
        return Vec::new();
    }

    let Ok(content) = fs::read(changelog_path) else {
        return Vec::new();
    };
    let content = String::from_utf8_lossy(&content);

    parse_changelog_content(&content)
}

fn parse_changelog_content(content: &str) -> Vec<ChangelogEntry> {
    let mut entries = Vec::new();
    let mut current_lines: Vec<&str> = Vec::new();
    let mut current_version: Option<Version> = None;

    for line in content.split('\n') {
        if line.starts_with("## ") {
            push_current_entry(&mut entries, current_version, &current_lines);

            if let Some(version) = parse_version_header(line) {
                current_version = Some(version);
                current_lines = vec![line];
            } else {
                current_version = None;
                current_lines.clear();
            }
        } else if current_version.is_some() {
            current_lines.push(line);
        }
    }

    push_current_entry(&mut entries, current_version, &current_lines);
    entries
}

fn push_current_entry(
    entries: &mut Vec<ChangelogEntry>,
    current_version: Option<Version>,
    current_lines: &[&str],
) {
    let Some(version) = current_version else {
        return;
    };

    if current_lines.is_empty() {
        return;
    }

    entries.push(ChangelogEntry {
        major: version.major,
        minor: version.minor,
        patch: version.patch,
        content: current_lines.join("\n").trim().to_owned(),
    });
}

fn parse_version_header(line: &str) -> Option<Version> {
    let rest = line.strip_prefix("##")?.trim_start();
    let rest = rest.strip_prefix('[').unwrap_or(rest);
    let (major, rest) = parse_u64_prefix(rest)?;
    let rest = rest.strip_prefix('.')?;
    let (minor, rest) = parse_u64_prefix(rest)?;
    let rest = rest.strip_prefix('.')?;
    let (patch, _) = parse_u64_prefix(rest)?;

    Some(Version {
        major,
        minor,
        patch,
    })
}

fn parse_u64_prefix(value: &str) -> Option<(u64, &str)> {
    let end = value
        .char_indices()
        .take_while(|(_, ch)| ch.is_ascii_digit())
        .map(|(index, ch)| index + ch.len_utf8())
        .last()
        .unwrap_or(0);

    if end == 0 {
        return None;
    }

    let number = value[..end].parse().ok()?;
    Some((number, &value[end..]))
}

/// Compare versions. Returns a negative value if `v1 < v2`, 0 if equal, and a
/// positive value if `v1 > v2`.
pub fn compare_versions(v1: &ChangelogEntry, v2: &ChangelogEntry) -> i64 {
    if v1.major != v2.major {
        return version_diff(v1.major, v2.major);
    }
    if v1.minor != v2.minor {
        return version_diff(v1.minor, v2.minor);
    }
    version_diff(v1.patch, v2.patch)
}

fn version_diff(left: u64, right: u64) -> i64 {
    let diff = left.abs_diff(right).min(i64::MAX as u64) as i64;

    if left >= right { diff } else { -diff }
}

/// Get entries newer than `last_version`.
pub fn get_new_entries(entries: &[ChangelogEntry], last_version: &str) -> Vec<ChangelogEntry> {
    let mut parts = last_version
        .split('.')
        .map(|part| part.trim().parse::<u64>().ok());
    let last = ChangelogEntry {
        major: parts.next().flatten().unwrap_or(0),
        minor: parts.next().flatten().unwrap_or(0),
        patch: parts.next().flatten().unwrap_or(0),
        content: String::new(),
    };

    entries
        .iter()
        .filter(|entry| compare_versions(entry, &last) > 0)
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::io;
    use std::path::{Path, PathBuf};
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
                let path = base.join(format!("changelog-test-{pid}-{nanos}-{attempt}"));

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

    fn entry(major: u64, minor: u64, patch: u64) -> ChangelogEntry {
        ChangelogEntry {
            major,
            minor,
            patch,
            content: String::new(),
        }
    }

    #[test]
    fn parse_changelog_returns_empty_for_missing_file() {
        let temp = TempDir::new().unwrap();
        let missing_path = temp.path().join("CHANGELOG.md");

        assert_eq!(parse_changelog(missing_path), Vec::new());
    }

    #[test]
    fn parse_changelog_collects_version_sections() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("CHANGELOG.md");
        fs::write(
            &path,
            "# Changelog\n\n## [1.2.3] - 2026-01-02\n- Added\n\n## 1.2.2\n- Fixed\n",
        )
        .unwrap();

        let entries = parse_changelog(path);

        assert_eq!(entries.len(), 2);
        assert_eq!(
            (entries[0].major, entries[0].minor, entries[0].patch),
            (1, 2, 3)
        );
        assert_eq!(entries[0].content, "## [1.2.3] - 2026-01-02\n- Added");
        assert_eq!(
            (entries[1].major, entries[1].minor, entries[1].patch),
            (1, 2, 2)
        );
        assert_eq!(entries[1].content, "## 1.2.2\n- Fixed");
    }

    #[test]
    fn parse_changelog_resets_on_unparseable_level_two_headers() {
        let entries = parse_changelog_content(
            "## [2.0.0]\n- Major\n## Unreleased\n- Ignored\n## [1.0.0]\n- Initial",
        );

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].content, "## [2.0.0]\n- Major");
        assert_eq!(entries[1].content, "## [1.0.0]\n- Initial");
    }

    #[test]
    fn parse_changelog_accepts_optional_bracket_like_typescript_regex() {
        let entries = parse_changelog_content("## [3.4.5\nA\n## 3.4.4]\nB");

        assert_eq!(
            entries
                .iter()
                .map(|entry| (entry.major, entry.minor, entry.patch))
                .collect::<Vec<_>>(),
            vec![(3, 4, 5), (3, 4, 4)]
        );
    }

    #[test]
    fn compare_versions_returns_component_difference() {
        assert!(compare_versions(&entry(2, 0, 0), &entry(1, 99, 99)) > 0);
        assert_eq!(compare_versions(&entry(1, 5, 0), &entry(1, 2, 0)), 3);
        assert_eq!(compare_versions(&entry(1, 0, 1), &entry(1, 0, 3)), -2);
        assert_eq!(compare_versions(&entry(1, 0, 0), &entry(1, 0, 0)), 0);
    }

    #[test]
    fn get_new_entries_filters_against_last_version() {
        let entries = vec![
            entry(1, 3, 0),
            entry(1, 2, 1),
            entry(1, 2, 0),
            entry(0, 9, 9),
        ];

        let newer = get_new_entries(&entries, "1.2.0");

        assert_eq!(
            newer
                .iter()
                .map(|entry| (entry.major, entry.minor, entry.patch))
                .collect::<Vec<_>>(),
            vec![(1, 3, 0), (1, 2, 1)]
        );
    }

    #[test]
    fn get_new_entries_defaults_invalid_or_missing_version_parts_to_zero() {
        let entries = vec![entry(0, 1, 0), entry(0, 0, 1), entry(0, 0, 0)];

        let newer = get_new_entries(&entries, "bad.0");

        assert_eq!(
            newer
                .iter()
                .map(|entry| (entry.major, entry.minor, entry.patch))
                .collect::<Vec<_>>(),
            vec![(0, 1, 0), (0, 0, 1)]
        );
    }
}
