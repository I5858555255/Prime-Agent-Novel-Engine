use std::env;
use std::path::{Path, PathBuf};

pub const PACKAGE_NAME: &str = "@earendil-works/pi-coding-agent";
pub const APP_NAME: &str = "prime-agent";
pub const APP_TITLE: &str = APP_NAME;
pub const CONFIG_DIR_NAME: &str = ".prime/agent";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub const ENV_AGENT_DIR: &str = "PRIME_AGENT_CODING_AGENT_DIR";
pub const ENV_SESSION_DIR: &str = "PRIME_AGENT_SESSION_DIR";
pub const ENV_LEGACY_SESSION_DIR: &str = "PRIME_AGENT_CODING_AGENT_SESSION_DIR";
pub const ENV_PACKAGE_DIR: &str = "PI_PACKAGE_DIR";
pub const ENV_SHARE_VIEWER_URL: &str = "PI_SHARE_VIEWER_URL";

pub const DEFAULT_SHARE_VIEWER_URL: &str = "https://pi.dev/session/";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigPaths {
    agent_dir: PathBuf,
    session_dir_override: Option<PathBuf>,
}

impl ConfigPaths {
    pub fn new(agent_dir: impl Into<PathBuf>, session_dir_override: Option<PathBuf>) -> Self {
        Self {
            agent_dir: agent_dir.into(),
            session_dir_override,
        }
    }

    pub fn from_env() -> Self {
        Self {
            agent_dir: get_agent_dir_from_env_value(env::var(ENV_AGENT_DIR).ok().as_deref()),
            session_dir_override: get_session_dir_env_override_from_values(
                env::var(ENV_SESSION_DIR).ok().as_deref(),
                env::var(ENV_LEGACY_SESSION_DIR).ok().as_deref(),
            ),
        }
    }

    pub fn agent_dir(&self) -> &Path {
        &self.agent_dir
    }

    pub fn custom_themes_dir(&self) -> PathBuf {
        self.agent_dir.join("themes")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.agent_dir.join("logs")
    }

    pub fn client_error_log_path(&self) -> PathBuf {
        self.logs_dir().join("client-errors.log")
    }

    pub fn models_path(&self) -> PathBuf {
        self.agent_dir.join("models.json")
    }

    pub fn auth_path(&self) -> PathBuf {
        self.agent_dir.join("auth.json")
    }

    pub fn settings_path(&self) -> PathBuf {
        self.agent_dir.join("settings.json")
    }

    pub fn cron_jobs_path(&self) -> PathBuf {
        self.agent_dir.join("cron-jobs.json")
    }

    pub fn tools_dir(&self) -> PathBuf {
        self.agent_dir.join("tools")
    }

    pub fn bin_dir(&self) -> PathBuf {
        self.agent_dir.join("bin")
    }

    pub fn prompts_dir(&self) -> PathBuf {
        self.agent_dir.join("prompts")
    }

    pub fn sessions_dir(&self) -> PathBuf {
        self.session_dir_override
            .clone()
            .unwrap_or_else(|| self.agent_dir.join("sessions"))
    }

    pub fn debug_log_path(&self) -> PathBuf {
        self.agent_dir.join(format!("{APP_NAME}-debug.log"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackagePaths {
    package_dir: PathBuf,
}

impl PackagePaths {
    pub fn new(package_dir: impl Into<PathBuf>) -> Self {
        Self {
            package_dir: package_dir.into(),
        }
    }

    pub fn from_env_or_current_exe() -> Self {
        Self::new(get_package_dir())
    }

    pub fn package_dir(&self) -> &Path {
        &self.package_dir
    }

    pub fn package_json_path(&self) -> PathBuf {
        self.package_dir.join("package.json")
    }

    pub fn readme_path(&self) -> PathBuf {
        absolutize(self.package_dir.join("README.md"))
    }

    pub fn docs_path(&self) -> PathBuf {
        absolutize(self.package_dir.join("docs"))
    }

    pub fn examples_path(&self) -> PathBuf {
        absolutize(self.package_dir.join("examples"))
    }

    pub fn changelog_path(&self) -> PathBuf {
        absolutize(self.package_dir.join("CHANGELOG.md"))
    }

    pub fn bundled_skills_dir(&self) -> PathBuf {
        self.package_dir.join("skills")
    }

    pub fn themes_dir(&self) -> PathBuf {
        self.source_or_dist_dir()
            .join("modes")
            .join("interactive")
            .join("theme")
    }

    pub fn export_template_dir(&self) -> PathBuf {
        self.source_or_dist_dir().join("core").join("export-html")
    }

    pub fn interactive_assets_dir(&self) -> PathBuf {
        self.source_or_dist_dir()
            .join("modes")
            .join("interactive")
            .join("assets")
    }

    pub fn bundled_interactive_asset_path(&self, name: impl AsRef<Path>) -> PathBuf {
        self.interactive_assets_dir().join(name)
    }

    fn source_or_dist_dir(&self) -> PathBuf {
        let src = self.package_dir.join("src");
        if src.exists() {
            src
        } else {
            self.package_dir.join("dist")
        }
    }
}

pub fn env_prefix_for_app_name(app_name: &str) -> String {
    let mut result = String::new();
    let mut previous_was_separator = true;

    for ch in app_name.chars().flat_map(char::to_uppercase) {
        if ch.is_ascii_alphanumeric() {
            result.push(ch);
            previous_was_separator = false;
        } else if !previous_was_separator {
            result.push('_');
            previous_was_separator = true;
        }
    }

    while result.ends_with('_') {
        result.pop();
    }

    if result.is_empty() {
        "PI".to_string()
    } else {
        result
    }
}

pub fn expand_tilde_path(path: &str) -> PathBuf {
    if path == "~" {
        return home_dir().unwrap_or_else(|| PathBuf::from(path));
    }

    if let Some(rest) = path.strip_prefix("~/")
        && let Some(home) = home_dir()
    {
        return home.join(rest);
    }

    PathBuf::from(path)
}

pub fn get_share_viewer_url(gist_id: &str) -> String {
    get_share_viewer_url_from_env_value(env::var(ENV_SHARE_VIEWER_URL).ok().as_deref(), gist_id)
}

pub fn get_share_viewer_url_from_env_value(base_url: Option<&str>, gist_id: &str) -> String {
    format!("{}#{gist_id}", base_url.unwrap_or(DEFAULT_SHARE_VIEWER_URL))
}

pub fn get_agent_dir() -> PathBuf {
    ConfigPaths::from_env().agent_dir().to_path_buf()
}

pub fn get_agent_dir_from_env_value(env_dir: Option<&str>) -> PathBuf {
    env_dir
        .filter(|value| !value.is_empty())
        .map(expand_tilde_path)
        .unwrap_or_else(|| {
            home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(CONFIG_DIR_NAME)
        })
}

pub fn get_custom_themes_dir() -> PathBuf {
    ConfigPaths::from_env().custom_themes_dir()
}

pub fn get_logs_dir() -> PathBuf {
    ConfigPaths::from_env().logs_dir()
}

pub fn get_client_error_log_path() -> PathBuf {
    ConfigPaths::from_env().client_error_log_path()
}

pub fn get_models_path() -> PathBuf {
    ConfigPaths::from_env().models_path()
}

pub fn get_auth_path() -> PathBuf {
    ConfigPaths::from_env().auth_path()
}

pub fn get_settings_path() -> PathBuf {
    ConfigPaths::from_env().settings_path()
}

pub fn get_cron_jobs_path(agent_dir: impl AsRef<Path>) -> PathBuf {
    agent_dir.as_ref().join("cron-jobs.json")
}

pub fn get_tools_dir() -> PathBuf {
    ConfigPaths::from_env().tools_dir()
}

pub fn get_bin_dir() -> PathBuf {
    ConfigPaths::from_env().bin_dir()
}

pub fn get_prompts_dir() -> PathBuf {
    ConfigPaths::from_env().prompts_dir()
}

pub fn get_sessions_dir(agent_dir: impl AsRef<Path>) -> PathBuf {
    get_sessions_dir_from_env_values(
        agent_dir,
        env::var(ENV_SESSION_DIR).ok().as_deref(),
        env::var(ENV_LEGACY_SESSION_DIR).ok().as_deref(),
    )
}

pub fn get_sessions_dir_from_env_values(
    agent_dir: impl AsRef<Path>,
    session_dir: Option<&str>,
    legacy_session_dir: Option<&str>,
) -> PathBuf {
    get_session_dir_env_override_from_values(session_dir, legacy_session_dir)
        .unwrap_or_else(|| agent_dir.as_ref().join("sessions"))
}

pub fn get_session_dir_env_override() -> Option<PathBuf> {
    get_session_dir_env_override_from_values(
        env::var(ENV_SESSION_DIR).ok().as_deref(),
        env::var(ENV_LEGACY_SESSION_DIR).ok().as_deref(),
    )
}

pub fn get_session_dir_env_override_from_values(
    session_dir: Option<&str>,
    legacy_session_dir: Option<&str>,
) -> Option<PathBuf> {
    session_dir
        .filter(|value| !value.is_empty())
        .or_else(|| legacy_session_dir.filter(|value| !value.is_empty()))
        .map(expand_tilde_path)
}

pub fn get_debug_log_path() -> PathBuf {
    ConfigPaths::from_env().debug_log_path()
}

pub fn get_package_dir() -> PathBuf {
    if let Ok(env_dir) = env::var(ENV_PACKAGE_DIR)
        && !env_dir.is_empty()
    {
        return expand_tilde_path(&env_dir);
    }

    env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn get_package_json_path() -> PathBuf {
    PackagePaths::from_env_or_current_exe().package_json_path()
}

pub fn get_readme_path() -> PathBuf {
    PackagePaths::from_env_or_current_exe().readme_path()
}

pub fn get_docs_path() -> PathBuf {
    PackagePaths::from_env_or_current_exe().docs_path()
}

pub fn get_examples_path() -> PathBuf {
    PackagePaths::from_env_or_current_exe().examples_path()
}

pub fn get_changelog_path() -> PathBuf {
    PackagePaths::from_env_or_current_exe().changelog_path()
}

pub fn get_themes_dir() -> PathBuf {
    PackagePaths::from_env_or_current_exe().themes_dir()
}

pub fn get_export_template_dir() -> PathBuf {
    PackagePaths::from_env_or_current_exe().export_template_dir()
}

pub fn get_interactive_assets_dir() -> PathBuf {
    PackagePaths::from_env_or_current_exe().interactive_assets_dir()
}

pub fn get_bundled_interactive_asset_path(name: impl AsRef<Path>) -> PathBuf {
    PackagePaths::from_env_or_current_exe().bundled_interactive_asset_path(name)
}

pub fn get_bundled_skills_dir() -> PathBuf {
    PackagePaths::from_env_or_current_exe().bundled_skills_dir()
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .or_else(|| {
            let drive = env::var_os("HOMEDRIVE")?;
            let path = env::var_os("HOMEPATH")?;
            let mut combined = drive;
            combined.push(path);
            Some(combined)
        })
        .map(PathBuf::from)
}

fn absolutize(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_constants_match_typescript_package_metadata() {
        assert_eq!(PACKAGE_NAME, "@earendil-works/pi-coding-agent");
        assert_eq!(APP_NAME, "prime-agent");
        assert_eq!(APP_TITLE, "prime-agent");
        assert_eq!(CONFIG_DIR_NAME, ".prime/agent");
        assert_eq!(VERSION, "0.1.7");
    }

    #[test]
    fn config_env_names_use_prime_agent_prefix() {
        assert_eq!(env_prefix_for_app_name("prime-agent"), "PRIME_AGENT");
        assert_eq!(ENV_AGENT_DIR, "PRIME_AGENT_CODING_AGENT_DIR");
        assert_eq!(ENV_SESSION_DIR, "PRIME_AGENT_SESSION_DIR");
        assert_eq!(
            ENV_LEGACY_SESSION_DIR,
            "PRIME_AGENT_CODING_AGENT_SESSION_DIR"
        );
    }

    #[test]
    fn config_env_prefix_falls_back_to_pi_when_name_has_no_ascii_alphanumerics() {
        assert_eq!(env_prefix_for_app_name("π"), "PI");
        assert_eq!(env_prefix_for_app_name("__prime  agent__"), "PRIME_AGENT");
    }

    #[test]
    fn config_agent_dir_defaults_to_home_config_dir() {
        let agent_dir = get_agent_dir_from_env_value(None);

        assert!(agent_dir.ends_with(CONFIG_DIR_NAME));
        assert!(!agent_dir.to_string_lossy().contains('~'));
    }

    #[test]
    fn config_agent_dir_uses_env_override_and_expands_tilde() {
        let agent_dir = get_agent_dir_from_env_value(Some("~/custom-agent"));

        assert!(agent_dir.ends_with("custom-agent"));
        assert!(!agent_dir.to_string_lossy().contains('~'));
    }

    #[test]
    fn config_paths_build_agent_file_locations() {
        let paths = ConfigPaths::new("/agent", None);

        assert_eq!(paths.models_path(), PathBuf::from("/agent/models.json"));
        assert_eq!(paths.auth_path(), PathBuf::from("/agent/auth.json"));
        assert_eq!(paths.settings_path(), PathBuf::from("/agent/settings.json"));
        assert_eq!(
            paths.cron_jobs_path(),
            PathBuf::from("/agent/cron-jobs.json")
        );
        assert_eq!(paths.tools_dir(), PathBuf::from("/agent/tools"));
        assert_eq!(paths.bin_dir(), PathBuf::from("/agent/bin"));
        assert_eq!(paths.prompts_dir(), PathBuf::from("/agent/prompts"));
        assert_eq!(paths.sessions_dir(), PathBuf::from("/agent/sessions"));
        assert_eq!(
            paths.debug_log_path(),
            PathBuf::from("/agent/prime-agent-debug.log")
        );
    }

    #[test]
    fn config_sessions_dir_prefers_new_override_then_legacy_override() {
        assert_eq!(
            get_sessions_dir_from_env_values("/agent", Some("/sessions"), Some("/legacy")),
            PathBuf::from("/sessions")
        );
        assert_eq!(
            get_sessions_dir_from_env_values("/agent", None, Some("/legacy")),
            PathBuf::from("/legacy")
        );
        assert_eq!(
            get_sessions_dir_from_env_values("/agent", None, None),
            PathBuf::from("/agent/sessions")
        );
    }

    #[test]
    fn config_sessions_dir_expands_tilde_override() {
        let sessions_dir =
            get_sessions_dir_from_env_values("/agent", Some("~/prime-agent-sessions"), None);

        assert!(sessions_dir.ends_with("prime-agent-sessions"));
        assert!(!sessions_dir.to_string_lossy().contains('~'));
    }

    #[test]
    fn config_package_paths_build_metadata_and_asset_locations() {
        let paths = PackagePaths::new("/pkg");

        assert_eq!(
            paths.package_json_path(),
            PathBuf::from("/pkg/package.json")
        );
        assert_eq!(paths.readme_path(), PathBuf::from("/pkg/README.md"));
        assert_eq!(paths.docs_path(), PathBuf::from("/pkg/docs"));
        assert_eq!(paths.examples_path(), PathBuf::from("/pkg/examples"));
        assert_eq!(paths.changelog_path(), PathBuf::from("/pkg/CHANGELOG.md"));
        assert_eq!(paths.bundled_skills_dir(), PathBuf::from("/pkg/skills"));
    }

    #[test]
    fn config_share_viewer_url_uses_default_or_override() {
        assert_eq!(
            get_share_viewer_url_from_env_value(None, "abc123"),
            "https://pi.dev/session/#abc123"
        );
        assert_eq!(
            get_share_viewer_url_from_env_value(Some("https://example.test/view"), "abc123"),
            "https://example.test/view#abc123"
        );
    }
}
