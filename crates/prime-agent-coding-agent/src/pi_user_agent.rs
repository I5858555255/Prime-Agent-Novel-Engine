pub fn get_pi_user_agent(
    version: impl AsRef<str>,
    platform: impl AsRef<str>,
    runtime: impl AsRef<str>,
    arch: impl AsRef<str>,
) -> String {
    format!(
        "prime-agent/{} ({}; {}; {})",
        version.as_ref(),
        platform.as_ref(),
        runtime.as_ref(),
        arch.as_ref()
    )
}

pub fn get_current_pi_user_agent(version: impl AsRef<str>) -> String {
    get_pi_user_agent(
        version,
        current_platform(),
        current_runtime(),
        current_arch(),
    )
}

fn current_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn current_runtime() -> &'static str {
    "rust/std"
}

fn current_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_the_prime_agent_user_agent() {
        let user_agent = get_pi_user_agent("1.2.3", "darwin", "node/v24.0.0", "arm64");

        assert_eq!(
            user_agent,
            "prime-agent/1.2.3 (darwin; node/v24.0.0; arm64)"
        );
    }

    #[test]
    fn formats_bun_runtime_user_agents() {
        let user_agent = get_pi_user_agent("0.4.5", "linux", "bun/1.2.19", "x64");

        assert_eq!(user_agent, "prime-agent/0.4.5 (linux; bun/1.2.19; x64)");
    }

    #[test]
    fn matches_the_typescript_test_shape() {
        let user_agent = get_pi_user_agent("1.2.3", "linux", "node/v24.0.0", "x64");

        assert!(matches_typescript_user_agent_pattern(&user_agent));
    }

    #[test]
    fn current_user_agent_uses_std_host_components() {
        let user_agent = get_current_pi_user_agent("1.2.3");

        assert_eq!(
            user_agent,
            get_pi_user_agent(
                "1.2.3",
                current_platform(),
                current_runtime(),
                current_arch()
            )
        );
        assert!(matches_typescript_user_agent_pattern(&user_agent));
    }

    fn matches_typescript_user_agent_pattern(value: &str) -> bool {
        let Some(rest) = value.strip_prefix("prime-agent/") else {
            return false;
        };
        let Some((version, suffix)) = rest.split_once(' ') else {
            return false;
        };
        if version.is_empty()
            || version
                .chars()
                .any(|ch| ch.is_whitespace() || ch == '(' || ch == ')')
        {
            return false;
        }

        let Some(body) = suffix
            .strip_prefix('(')
            .and_then(|value| value.strip_suffix(')'))
        else {
            return false;
        };
        let Some((platform, after_platform)) = body.split_once(';') else {
            return false;
        };
        if platform.is_empty() || platform.chars().any(|ch| matches!(ch, ';' | '(' | ')')) {
            return false;
        }

        let after_platform = after_platform.trim_start_matches(char::is_whitespace);
        let Some((runtime, arch)) = after_platform.split_once(';') else {
            return false;
        };
        if runtime.is_empty() || runtime.chars().any(|ch| matches!(ch, ';' | '(' | ')')) {
            return false;
        }

        let arch = arch.trim_start_matches(char::is_whitespace);
        !arch.is_empty() && arch.chars().all(|ch| !matches!(ch, '(' | ')'))
    }
}
