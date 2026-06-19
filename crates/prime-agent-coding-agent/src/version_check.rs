use serde_json::Value;

pub const DEFAULT_PRIME_AGENT_DOWNLOAD_BASE_URL: &str =
    "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev";
pub const LATEST_VERSION_MANIFEST_PATH: &str = "latest.json";
pub const DEFAULT_VERSION_CHECK_TIMEOUT_MS: u64 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LatestPiRelease {
    pub version: String,
    pub package_name: Option<String>,
    pub install_spec: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionCheckRequest {
    pub manifest_url: String,
    pub user_agent: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedVersion {
    major: i64,
    minor: i64,
    patch: i64,
    prerelease: Option<String>,
}

fn parse_package_version(version: &str) -> Option<ParsedVersion> {
    let mut rest = version.trim();
    if let Some(stripped) = rest.strip_prefix('v') {
        rest = stripped;
    }

    let Some((core, suffix)) = split_once_either(rest, &['-', '+']) else {
        return parse_version_core(rest, None);
    };

    match rest.as_bytes().get(core.len()).copied() {
        Some(b'-') => {
            let Some((prerelease, _build)) = split_once_either(suffix, &['+']) else {
                return parse_version_core(core, Some(suffix));
            };
            parse_version_core(core, Some(prerelease))
        }
        Some(b'+') => parse_version_core(core, None),
        _ => None,
    }
}

fn split_once_either<'a>(value: &'a str, delimiters: &[char]) -> Option<(&'a str, &'a str)> {
    value
        .char_indices()
        .find(|(_, ch)| delimiters.contains(ch))
        .map(|(index, ch)| {
            let delimiter_len = ch.len_utf8();
            (&value[..index], &value[index + delimiter_len..])
        })
}

fn parse_version_core(core: &str, prerelease: Option<&str>) -> Option<ParsedVersion> {
    let mut parts = core.split('.');
    let major = parse_decimal_component(parts.next()?)?;
    let minor = parse_decimal_component(parts.next()?)?;
    let patch = parse_decimal_component(parts.next()?)?;
    if parts.next().is_some() {
        return None;
    }

    let prerelease = match prerelease {
        Some(value)
            if !value.is_empty()
                && value
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '-') =>
        {
            Some(value.to_string())
        }
        Some(_) => return None,
        None => None,
    };

    Some(ParsedVersion {
        major,
        minor,
        patch,
        prerelease,
    })
}

fn parse_decimal_component(value: &str) -> Option<i64> {
    if value.is_empty() || !value.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

pub fn compare_package_versions(left_version: &str, right_version: &str) -> Option<i64> {
    let left = parse_package_version(left_version)?;
    let right = parse_package_version(right_version)?;

    if left.major != right.major {
        return Some(left.major - right.major);
    }
    if left.minor != right.minor {
        return Some(left.minor - right.minor);
    }
    if left.patch != right.patch {
        return Some(left.patch - right.patch);
    }
    if left.prerelease == right.prerelease {
        return Some(0);
    }
    if left.prerelease.is_none() {
        return Some(1);
    }
    if right.prerelease.is_none() {
        return Some(-1);
    }

    Some(match left.prerelease.cmp(&right.prerelease) {
        std::cmp::Ordering::Less => -1,
        std::cmp::Ordering::Equal => 0,
        std::cmp::Ordering::Greater => 1,
    })
}

pub fn is_newer_package_version(candidate_version: &str, current_version: &str) -> bool {
    if let Some(comparison) = compare_package_versions(candidate_version, current_version) {
        return comparison > 0;
    }
    candidate_version.trim() != current_version.trim()
}

pub fn should_skip_version_check() -> bool {
    env_flag_is_set("PI_SKIP_VERSION_CHECK") || env_flag_is_set("PI_OFFLINE")
}

fn env_flag_is_set(name: &str) -> bool {
    std::env::var_os(name)
        .map(|value| !value.is_empty())
        .unwrap_or(false)
}

pub fn prime_agent_download_base_url() -> String {
    trim_trailing_slashes(
        &std::env::var("PRIME_AGENT_DOWNLOAD_BASE_URL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_PRIME_AGENT_DOWNLOAD_BASE_URL.to_string()),
    )
}

pub fn normalize_release_version(version: &str) -> String {
    version
        .trim()
        .strip_prefix('v')
        .unwrap_or(version.trim())
        .to_string()
}

pub fn resolve_release_url(base_url: &str, path_or_url: &str) -> Option<String> {
    let trimmed = path_or_url.trim();
    if trimmed.is_empty() {
        return None;
    }
    if has_url_scheme(trimmed) {
        return Some(trimmed.to_string());
    }

    Some(format!(
        "{}/{}",
        trim_trailing_slashes(base_url),
        trimmed.trim_start_matches('/')
    ))
}

fn trim_trailing_slashes(value: &str) -> String {
    value.trim_end_matches('/').to_string()
}

fn has_url_scheme(value: &str) -> bool {
    let Some((scheme, _rest)) = value.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphabetic()
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'))
}

pub fn parse_latest_pi_release_manifest(
    base_url: &str,
    manifest_json: &str,
) -> Option<LatestPiRelease> {
    let data: Value = serde_json::from_str(manifest_json).ok()?;
    latest_pi_release_from_manifest_value(base_url, &data)
}

pub fn latest_pi_release_from_manifest_value(
    base_url: &str,
    data: &Value,
) -> Option<LatestPiRelease> {
    let version = data.get("version")?.as_str()?;
    if version.trim().is_empty() {
        return None;
    }

    let package_name = non_empty_string_field(data, "package")
        .or_else(|| non_empty_string_field(data, "packageName"));
    let install_spec = data
        .get("tarball")
        .and_then(Value::as_str)
        .and_then(|tarball| resolve_release_url(base_url, tarball));

    Some(LatestPiRelease {
        version: normalize_release_version(version),
        package_name,
        install_spec,
    })
}

fn non_empty_string_field(data: &Value, field: &str) -> Option<String> {
    data.get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub fn version_check_request(
    current_version: &str,
    timeout_ms: Option<u64>,
) -> Option<VersionCheckRequest> {
    if should_skip_version_check() {
        return None;
    }

    let base_url = prime_agent_download_base_url();
    Some(VersionCheckRequest {
        manifest_url: format!("{base_url}/{LATEST_VERSION_MANIFEST_PATH}"),
        user_agent: crate::pi_user_agent::get_current_pi_user_agent(current_version),
        timeout_ms: timeout_ms.unwrap_or(DEFAULT_VERSION_CHECK_TIMEOUT_MS),
    })
}

pub fn latest_pi_version_from_manifest(base_url: &str, manifest_json: &str) -> Option<String> {
    parse_latest_pi_release_manifest(base_url, manifest_json).map(|release| release.version)
}

pub fn check_for_new_pi_version_from_manifest(
    current_version: &str,
    base_url: &str,
    manifest_json: &str,
) -> Option<String> {
    let latest_version = latest_pi_version_from_manifest(base_url, manifest_json)?;
    is_newer_package_version(&latest_version, current_version).then_some(latest_version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_package_versions_like_the_typescript_port() {
        assert!(compare_package_versions("2.0.0", "1.99.99").unwrap() > 0);
        assert_eq!(compare_package_versions("1.5.0", "1.2.0"), Some(3));
        assert_eq!(compare_package_versions("1.0.1", "1.0.3"), Some(-2));
        assert_eq!(compare_package_versions("v1.0.0+build.1", "1.0.0"), Some(0));
        assert_eq!(compare_package_versions("1.0.0", "1.0.0-beta"), Some(1));
        assert_eq!(compare_package_versions("1.0.0-alpha", "1.0.0"), Some(-1));
        assert!(compare_package_versions("1.0.0-beta", "1.0.0-alpha").unwrap() > 0);
    }

    #[test]
    fn rejects_invalid_versions_and_falls_back_to_trimmed_string_difference() {
        assert_eq!(compare_package_versions("1.2", "1.2.0"), None);
        assert_eq!(compare_package_versions("1.2.3-", "1.2.3"), None);
        assert!(is_newer_package_version(" latest ", "current"));
        assert!(!is_newer_package_version(" current ", "current"));
    }

    #[test]
    fn resolves_release_urls_against_the_download_base() {
        let base_url = "https://example.com/releases///";

        assert_eq!(
            resolve_release_url(base_url, "/prime-agent.tgz"),
            Some("https://example.com/releases/prime-agent.tgz".to_string())
        );
        assert_eq!(
            resolve_release_url(base_url, "https://cdn.example.com/prime-agent.tgz"),
            Some("https://cdn.example.com/prime-agent.tgz".to_string())
        );
        assert_eq!(resolve_release_url(base_url, "   "), None);
    }

    #[test]
    fn parses_latest_release_manifest_fields() {
        let release = parse_latest_pi_release_manifest(
            "https://example.com/base",
            r#"{
                "version": " v1.2.3 ",
                "package": " prime-agent ",
                "packageName": " ignored ",
                "tarball": "/downloads/prime-agent.tgz"
            }"#,
        )
        .unwrap();

        assert_eq!(
            release,
            LatestPiRelease {
                version: "1.2.3".to_string(),
                package_name: Some("prime-agent".to_string()),
                install_spec: Some(
                    "https://example.com/base/downloads/prime-agent.tgz".to_string()
                ),
            }
        );
    }

    #[test]
    fn falls_back_to_package_name_and_ignores_bad_manifest_shapes() {
        let release = parse_latest_pi_release_manifest(
            "https://example.com/base",
            r#"{"version":"1.2.3","packageName":" prime-agent-beta ","tarball":42}"#,
        )
        .unwrap();

        assert_eq!(release.version, "1.2.3");
        assert_eq!(release.package_name, Some("prime-agent-beta".to_string()));
        assert_eq!(release.install_spec, None);

        assert_eq!(
            parse_latest_pi_release_manifest("https://example.com/base", r#"{"version":"  "}"#),
            None
        );
        assert_eq!(
            parse_latest_pi_release_manifest("https://example.com/base", r#"{"version":42}"#),
            None
        );
    }

    #[test]
    fn checks_for_new_versions_from_manifest_without_network() {
        assert_eq!(
            check_for_new_pi_version_from_manifest(
                "1.2.2",
                "https://example.com",
                r#"{"version":"1.2.3"}"#
            ),
            Some("1.2.3".to_string())
        );
        assert_eq!(
            check_for_new_pi_version_from_manifest(
                "1.2.3",
                "https://example.com",
                r#"{"version":"1.2.3"}"#
            ),
            None
        );
    }
}
