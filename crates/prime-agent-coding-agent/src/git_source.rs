use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSource {
    #[serde(rename = "type")]
    pub r#type: String,
    pub repo: String,
    pub host: String,
    pub path: String,
    #[serde(rename = "ref")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_: Option<String>,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SplitRef {
    repo: String,
    ref_: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedUrl {
    host: String,
    path: String,
}

pub fn parse_git_url(source: &str) -> Option<GitSource> {
    let trimmed = source.trim();
    let has_git_prefix = trimmed.starts_with("git:");
    let url = if has_git_prefix {
        trimmed[4..].trim()
    } else {
        trimmed
    };

    if !has_git_prefix && !has_explicit_protocol(url) {
        return None;
    }

    let split = split_ref(url);
    parse_hosted_git_url(&split).or_else(|| parse_generic_git_url(url))
}

fn split_ref(url: &str) -> SplitRef {
    if let Some((host, path_with_maybe_ref)) = parse_scp_like(url) {
        if let Some((repo_path, ref_)) = split_path_ref(path_with_maybe_ref) {
            return SplitRef {
                repo: format!("git@{host}:{repo_path}"),
                ref_: Some(ref_.to_string()),
            };
        }

        return SplitRef {
            repo: url.to_string(),
            ref_: None,
        };
    }

    if url.contains("://") {
        return split_protocol_ref(url);
    }

    let Some(slash_index) = url.find('/') else {
        return SplitRef {
            repo: url.to_string(),
            ref_: None,
        };
    };

    let host = &url[..slash_index];
    let path_with_maybe_ref = &url[slash_index + 1..];
    if let Some((repo_path, ref_)) = split_path_ref(path_with_maybe_ref) {
        return SplitRef {
            repo: format!("{host}/{repo_path}"),
            ref_: Some(ref_.to_string()),
        };
    }

    SplitRef {
        repo: url.to_string(),
        ref_: None,
    }
}

fn parse_generic_git_url(url: &str) -> Option<GitSource> {
    let split = split_ref(url);
    let repo_without_ref = split.repo.as_str();
    let mut repo = split.repo.clone();
    let (host, path) = if let Some((host, path)) = parse_scp_like(repo_without_ref) {
        (host.to_string(), path.to_string())
    } else if has_explicit_protocol(repo_without_ref) {
        let parsed = parse_explicit_url(repo_without_ref)?;
        (parsed.host, parsed.path)
    } else {
        let slash_index = repo_without_ref.find('/')?;
        let host = &repo_without_ref[..slash_index];
        let path = &repo_without_ref[slash_index + 1..];

        if !is_generic_host(host) {
            return None;
        }

        repo = format!("https://{repo_without_ref}");
        (host.to_string(), path.to_string())
    };

    let normalized_path = strip_dot_git(path.trim_start_matches('/'));
    if host.is_empty() || normalized_path.is_empty() || normalized_path.split('/').count() < 2 {
        return None;
    }

    Some(GitSource {
        r#type: "git".to_string(),
        repo,
        host,
        path: normalized_path.to_string(),
        ref_: split.ref_.clone(),
        pinned: split.ref_.is_some(),
    })
}

fn parse_hosted_git_url(split: &SplitRef) -> Option<GitSource> {
    let parsed = if let Some((host, path)) = parse_scp_like(split.repo.as_str()) {
        ParsedUrl {
            host: host.to_string(),
            path: path.to_string(),
        }
    } else if has_explicit_protocol(split.repo.as_str()) {
        parse_explicit_url(split.repo.as_str())?
    } else {
        parse_host_path(split.repo.as_str())?
    };

    if !is_common_hosted_domain(parsed.host.as_str()) {
        return None;
    }

    let path = strip_dot_git(parsed.path.trim_start_matches('/'));
    if path.is_empty()
        || path.split('/').count() < 2
        || path.split('/').any(str::is_empty)
        || path.contains('@')
    {
        return None;
    }

    let repo = if needs_https_prefix(split.repo.as_str()) {
        format!("https://{}", split.repo)
    } else {
        split.repo.clone()
    };

    Some(GitSource {
        r#type: "git".to_string(),
        repo,
        host: parsed.host,
        path: path.to_string(),
        ref_: split.ref_.clone(),
        pinned: split.ref_.is_some(),
    })
}

fn split_protocol_ref(url: &str) -> SplitRef {
    let Some(scheme_end) = url.find("://") else {
        return SplitRef {
            repo: url.to_string(),
            ref_: None,
        };
    };
    let after_scheme = scheme_end + 3;
    let Some(path_offset) = url[after_scheme..].find('/') else {
        return SplitRef {
            repo: url.to_string(),
            ref_: None,
        };
    };
    let path_start = after_scheme + path_offset + 1;
    let path_end = url[path_start..]
        .find(['?', '#'])
        .map(|index| path_start + index)
        .unwrap_or(url.len());
    let path_with_maybe_ref = &url[path_start..path_end];

    let Some((repo_path, ref_)) = split_path_ref(path_with_maybe_ref) else {
        return SplitRef {
            repo: url.to_string(),
            ref_: None,
        };
    };

    let mut repo = format!("{}{}{}", &url[..path_start], repo_path, &url[path_end..]);
    if repo.ends_with('/') {
        repo.pop();
    }

    SplitRef {
        repo,
        ref_: Some(ref_.to_string()),
    }
}

fn split_path_ref(path: &str) -> Option<(&str, &str)> {
    let separator = path.find('@')?;
    let repo_path = &path[..separator];
    let ref_ = &path[separator + 1..];

    if repo_path.is_empty() || ref_.is_empty() {
        return None;
    }

    Some((repo_path, ref_))
}

fn parse_scp_like(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("git@")?;
    let colon_index = rest.find(':')?;
    let host = &rest[..colon_index];
    let path = &rest[colon_index + 1..];

    if host.is_empty() || path.is_empty() {
        return None;
    }

    Some((host, path))
}

fn parse_explicit_url(url: &str) -> Option<ParsedUrl> {
    let scheme_end = url.find("://")?;
    let scheme = &url[..scheme_end];
    if !matches!(
        scheme.to_ascii_lowercase().as_str(),
        "http" | "https" | "ssh" | "git"
    ) {
        return None;
    }

    let rest = &url[scheme_end + 3..];
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let host = parse_authority_host(authority)?;
    let path = if authority_end < rest.len() && rest.as_bytes()[authority_end] == b'/' {
        let path_start = authority_end + 1;
        let path_end = rest[path_start..]
            .find(['?', '#'])
            .map(|index| path_start + index)
            .unwrap_or(rest.len());
        &rest[path_start..path_end]
    } else {
        ""
    };

    Some(ParsedUrl {
        host: host.to_string(),
        path: path.to_string(),
    })
}

fn parse_authority_host(authority: &str) -> Option<&str> {
    let without_user = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);

    if let Some(rest) = without_user.strip_prefix('[') {
        let end = rest.find(']')?;
        let host = &rest[..end];
        return (!host.is_empty()).then_some(host);
    }

    let host = without_user
        .split_once(':')
        .map_or(without_user, |(host, _)| host);
    (!host.is_empty()).then_some(host)
}

fn parse_host_path(value: &str) -> Option<ParsedUrl> {
    let slash_index = value.find('/')?;
    let host = &value[..slash_index];
    let path = &value[slash_index + 1..];

    if host.is_empty() || path.is_empty() {
        return None;
    }

    Some(ParsedUrl {
        host: host.to_string(),
        path: path.to_string(),
    })
}

fn has_explicit_protocol(url: &str) -> bool {
    let Some(scheme_end) = url.find("://") else {
        return false;
    };

    matches!(
        url[..scheme_end].to_ascii_lowercase().as_str(),
        "http" | "https" | "ssh" | "git"
    )
}

fn needs_https_prefix(repo: &str) -> bool {
    !has_explicit_protocol(repo) && !repo.starts_with("git@")
}

fn is_common_hosted_domain(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "github.com" | "gitlab.com" | "bitbucket.org"
    )
}

fn is_generic_host(host: &str) -> bool {
    host.contains('.') || host == "localhost"
}

fn strip_dot_git(path: &str) -> &str {
    path.strip_suffix(".git").unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bare_path_without_git_prefix() {
        assert_eq!(parse_git_url("github.com/user/repo"), None);
    }

    #[test]
    fn accepts_git_prefixed_host_path() {
        let source = parse_git_url("git:github.com/user/repo").unwrap();

        assert_eq!(source.repo, "https://github.com/user/repo");
        assert_eq!(source.host, "github.com");
        assert_eq!(source.path, "user/repo");
        assert_eq!(source.ref_, None);
        assert!(!source.pinned);
    }

    #[test]
    fn accepts_https_url() {
        let source = parse_git_url("https://github.com/user/repo").unwrap();

        assert_eq!(source.repo, "https://github.com/user/repo");
        assert_eq!(source.host, "github.com");
        assert_eq!(source.path, "user/repo");
        assert!(!source.pinned);
    }

    #[test]
    fn accepts_scp_like_url_with_git_prefix() {
        let source = parse_git_url("git:git@github.com:user/repo").unwrap();

        assert_eq!(source.repo, "git@github.com:user/repo");
        assert_eq!(source.host, "github.com");
        assert_eq!(source.path, "user/repo");
        assert!(!source.pinned);
    }

    #[test]
    fn splits_ref_from_path() {
        let source = parse_git_url("git:github.com/user/repo@main").unwrap();

        assert_eq!(source.repo, "https://github.com/user/repo");
        assert_eq!(source.host, "github.com");
        assert_eq!(source.path, "user/repo");
        assert_eq!(source.ref_.as_deref(), Some("main"));
        assert!(source.pinned);
    }

    #[test]
    fn rejects_invalid_path() {
        assert_eq!(parse_git_url("git:github.com/user"), None);
    }

    #[test]
    fn strips_dot_git_from_path() {
        let source = parse_git_url("https://github.com/user/repo.git").unwrap();

        assert_eq!(source.repo, "https://github.com/user/repo.git");
        assert_eq!(source.host, "github.com");
        assert_eq!(source.path, "user/repo");
    }

    #[test]
    fn splits_ref_from_scp_like_path() {
        let source = parse_git_url("git:git@github.com:user/repo@v1").unwrap();

        assert_eq!(source.repo, "git@github.com:user/repo");
        assert_eq!(source.ref_.as_deref(), Some("v1"));
        assert!(source.pinned);
    }

    #[test]
    fn accepts_generic_dotted_host_with_git_prefix() {
        let source = parse_git_url("git:git.example.com/team/repo").unwrap();

        assert_eq!(source.repo, "https://git.example.com/team/repo");
        assert_eq!(source.host, "git.example.com");
        assert_eq!(source.path, "team/repo");
    }
}
