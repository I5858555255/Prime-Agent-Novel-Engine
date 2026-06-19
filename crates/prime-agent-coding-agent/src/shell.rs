use std::collections::{HashMap, HashSet};
use std::env;
use std::error::Error;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellConfig {
    pub shell: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellPlatform {
    Windows,
    Unix,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellConfigError {
    message: String,
}

impl ShellConfigError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for ShellConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for ShellConfigError {}

pub fn current_shell_platform() -> ShellPlatform {
    if cfg!(windows) {
        ShellPlatform::Windows
    } else {
        ShellPlatform::Unix
    }
}

pub fn find_bash_on_path() -> Option<String> {
    find_bash_on_path_for_platform(current_shell_platform(), |path| path.exists())
}

pub fn find_bash_on_path_for_platform(
    platform: ShellPlatform,
    path_exists: impl Fn(&Path) -> bool,
) -> Option<String> {
    let (command, arg) = match platform {
        ShellPlatform::Windows => ("where", "bash.exe"),
        ShellPlatform::Unix => ("which", "bash"),
    };

    let output = Command::new(command).arg(arg).output().ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let first_match = stdout.lines().next()?.trim();
    if first_match.is_empty() {
        return None;
    }

    if platform == ShellPlatform::Windows && !path_exists(Path::new(first_match)) {
        return None;
    }

    Some(first_match.to_owned())
}

pub fn get_shell_config(custom_shell_path: Option<&str>) -> Result<ShellConfig, ShellConfigError> {
    get_shell_config_with(
        custom_shell_path,
        current_shell_platform(),
        |key| env::var(key).ok(),
        |path| path.exists(),
        find_bash_on_path,
    )
}

pub fn get_shell_config_with(
    custom_shell_path: Option<&str>,
    platform: ShellPlatform,
    env_var: impl Fn(&str) -> Option<String>,
    path_exists: impl Fn(&Path) -> bool,
    find_bash: impl Fn() -> Option<String>,
) -> Result<ShellConfig, ShellConfigError> {
    if let Some(custom_shell_path) = custom_shell_path.filter(|path| !path.is_empty()) {
        if path_exists(Path::new(custom_shell_path)) {
            return Ok(shell_config(custom_shell_path));
        }

        return Err(ShellConfigError::new(format!(
            "Custom shell path not found: {custom_shell_path}"
        )));
    }

    match platform {
        ShellPlatform::Windows => get_windows_shell_config(env_var, path_exists, find_bash),
        ShellPlatform::Unix => {
            if path_exists(Path::new("/bin/bash")) {
                return Ok(shell_config("/bin/bash"));
            }

            if let Some(bash_on_path) = find_bash() {
                return Ok(shell_config(bash_on_path));
            }

            Ok(shell_config("sh"))
        }
    }
}

fn get_windows_shell_config(
    env_var: impl Fn(&str) -> Option<String>,
    path_exists: impl Fn(&Path) -> bool,
    find_bash: impl Fn() -> Option<String>,
) -> Result<ShellConfig, ShellConfigError> {
    let mut paths = Vec::new();

    if let Some(program_files) = env_var("ProgramFiles") {
        paths.push(format!("{program_files}\\Git\\bin\\bash.exe"));
    }

    if let Some(program_files_x86) = env_var("ProgramFiles(x86)") {
        paths.push(format!("{program_files_x86}\\Git\\bin\\bash.exe"));
    }

    for path in &paths {
        if path_exists(Path::new(path)) {
            return Ok(shell_config(path));
        }
    }

    if let Some(bash_on_path) = find_bash() {
        return Ok(shell_config(bash_on_path));
    }

    Err(ShellConfigError::new(format!(
        "No bash shell found. Options:\n  1. Install Git for Windows: https://git-scm.com/download/win\n  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n  3. Set shellPath in settings.json\n\nSearched Git Bash in:\n{}",
        paths
            .iter()
            .map(|path| format!("  {path}"))
            .collect::<Vec<_>>()
            .join("\n")
    )))
}

fn shell_config(shell: impl Into<String>) -> ShellConfig {
    ShellConfig {
        shell: shell.into(),
        args: vec!["-c".to_owned()],
    }
}

pub fn get_shell_env(bin_dir: impl AsRef<Path>) -> HashMap<String, String> {
    get_shell_env_with(bin_dir, env::vars(), env_path_delimiter())
}

pub fn get_shell_env_with<I, K, V>(
    bin_dir: impl AsRef<Path>,
    env_vars: I,
    path_delimiter: char,
) -> HashMap<String, String>
where
    I: IntoIterator<Item = (K, V)>,
    K: Into<String>,
    V: Into<String>,
{
    let mut result: HashMap<String, String> = env_vars
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect();

    let path_key = result
        .keys()
        .find(|key| key.eq_ignore_ascii_case("path"))
        .cloned()
        .unwrap_or_else(|| "PATH".to_owned());
    let current_path = result.get(&path_key).cloned().unwrap_or_default();
    let bin_dir = bin_dir.as_ref().to_string_lossy().into_owned();
    let has_bin_dir = current_path
        .split(path_delimiter)
        .filter(|entry| !entry.is_empty())
        .any(|entry| entry == bin_dir);

    if !has_bin_dir {
        let updated_path = if current_path.is_empty() {
            bin_dir
        } else {
            format!("{bin_dir}{path_delimiter}{current_path}")
        };
        result.insert(path_key, updated_path);
    }

    result
}

pub fn env_path_delimiter() -> char {
    if cfg!(windows) { ';' } else { ':' }
}

pub fn default_bin_dir() -> PathBuf {
    agent_dir().join("bin")
}

fn agent_dir() -> PathBuf {
    for key in ["PRIME_AGENT_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"] {
        if let Some(value) = env::var_os(key)
            && !value.is_empty()
        {
            return expand_tilde(PathBuf::from(value));
        }
    }

    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".prime")
        .join("agent")
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

fn expand_tilde(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy().into_owned();
    if value == "~" {
        return home_dir().unwrap_or(path);
    }
    if let Some(rest) = value.strip_prefix("~/")
        && let Some(home) = home_dir()
    {
        return home.join(rest);
    }
    path
}

pub fn sanitize_binary_output(value: &str) -> String {
    value
        .chars()
        .filter(|ch| {
            let code = *ch as u32;

            if matches!(code, 0x09 | 0x0a | 0x0d) {
                return true;
            }

            if code <= 0x1f {
                return false;
            }

            if (0xfff9..=0xfffb).contains(&code) {
                return false;
            }

            true
        })
        .collect()
}

fn tracked_detached_child_pids() -> &'static Mutex<HashSet<u32>> {
    static TRACKED_DETACHED_CHILD_PIDS: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
    TRACKED_DETACHED_CHILD_PIDS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn track_detached_child_pid(pid: u32) {
    tracked_detached_child_pids().lock().unwrap().insert(pid);
}

pub fn untrack_detached_child_pid(pid: u32) {
    tracked_detached_child_pids().lock().unwrap().remove(&pid);
}

pub fn tracked_detached_child_pid_count() -> usize {
    tracked_detached_child_pids().lock().unwrap().len()
}

pub fn kill_tracked_detached_children() {
    kill_tracked_detached_children_with(current_shell_platform(), |platform, pid| {
        kill_process_tree_for_platform(platform, pid)
    });
}

pub fn kill_tracked_detached_children_with(
    platform: ShellPlatform,
    mut kill_process_tree: impl FnMut(ShellPlatform, u32),
) {
    let pids = {
        let mut tracked = tracked_detached_child_pids().lock().unwrap();
        tracked.drain().collect::<Vec<_>>()
    };

    for pid in pids {
        kill_process_tree(platform, pid);
    }
}

pub fn kill_process_tree(pid: u32) {
    kill_process_tree_for_platform(current_shell_platform(), pid);
}

pub fn kill_process_tree_for_platform(platform: ShellPlatform, pid: u32) {
    match platform {
        ShellPlatform::Windows => {
            let pid = pid.to_string();
            let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", pid.as_str()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        }
        ShellPlatform::Unix => {
            let process_group = format!("-{pid}");
            if !run_kill_command(&process_group) {
                let _ = run_kill_command(&pid.to_string());
            }
        }
    }
}

fn run_kill_command(pid: &str) -> bool {
    Command::new("kill")
        .args(["-KILL", "--", pid])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(
        custom_shell_path: Option<&str>,
        platform: ShellPlatform,
        env: &[(&str, &str)],
        existing_paths: &[&str],
        bash_on_path: Option<&str>,
    ) -> Result<ShellConfig, ShellConfigError> {
        get_shell_config_with(
            custom_shell_path,
            platform,
            |key| {
                env.iter()
                    .find(|(candidate, _)| *candidate == key)
                    .map(|(_, value)| (*value).to_owned())
            },
            |path| {
                existing_paths
                    .iter()
                    .any(|candidate| Path::new(*candidate) == path)
            },
            || bash_on_path.map(str::to_owned),
        )
    }

    #[test]
    fn uses_existing_custom_shell_path() {
        assert_eq!(
            config(
                Some("/custom/bash"),
                ShellPlatform::Unix,
                &[],
                &["/custom/bash"],
                None
            )
            .unwrap(),
            ShellConfig {
                shell: "/custom/bash".to_owned(),
                args: vec!["-c".to_owned()],
            }
        );
    }

    #[test]
    fn rejects_missing_custom_shell_path() {
        let err = config(
            Some("/missing/bash"),
            ShellPlatform::Unix,
            &[],
            &[],
            Some("/usr/bin/bash"),
        )
        .unwrap_err();

        assert_eq!(
            err.to_string(),
            "Custom shell path not found: /missing/bash"
        );
    }

    #[test]
    fn resolves_unix_shell_by_preference_order() {
        assert_eq!(
            config(None, ShellPlatform::Unix, &[], &["/bin/bash"], None)
                .unwrap()
                .shell,
            "/bin/bash"
        );

        assert_eq!(
            config(
                None,
                ShellPlatform::Unix,
                &[],
                &[],
                Some("/usr/local/bin/bash")
            )
            .unwrap()
            .shell,
            "/usr/local/bin/bash"
        );

        assert_eq!(
            config(None, ShellPlatform::Unix, &[], &[], None)
                .unwrap()
                .shell,
            "sh"
        );
    }

    #[test]
    fn resolves_windows_git_bash_before_path_search() {
        let shell = config(
            None,
            ShellPlatform::Windows,
            &[("ProgramFiles", "C:\\Program Files")],
            &["C:\\Program Files\\Git\\bin\\bash.exe"],
            Some("C:\\msys64\\usr\\bin\\bash.exe"),
        )
        .unwrap();

        assert_eq!(shell.shell, "C:\\Program Files\\Git\\bin\\bash.exe");
    }

    #[test]
    fn resolves_windows_bash_on_path_after_known_locations() {
        let shell = config(
            None,
            ShellPlatform::Windows,
            &[("ProgramFiles", "C:\\Program Files")],
            &[],
            Some("C:\\msys64\\usr\\bin\\bash.exe"),
        )
        .unwrap();

        assert_eq!(shell.shell, "C:\\msys64\\usr\\bin\\bash.exe");
    }

    #[test]
    fn returns_windows_error_with_searched_paths() {
        let err = config(
            None,
            ShellPlatform::Windows,
            &[
                ("ProgramFiles", "C:\\Program Files"),
                ("ProgramFiles(x86)", "C:\\Program Files (x86)"),
            ],
            &[],
            None,
        )
        .unwrap_err();
        let message = err.to_string();

        assert!(message.contains("No bash shell found."));
        assert!(message.contains("C:\\Program Files\\Git\\bin\\bash.exe"));
        assert!(message.contains("C:\\Program Files (x86)\\Git\\bin\\bash.exe"));
    }

    #[test]
    fn prepends_bin_dir_to_path_without_duplication() {
        let env = get_shell_env_with(
            "/agent/bin",
            [("HOME", "/home/user"), ("PATH", "/usr/bin:/bin")],
            ':',
        );

        assert_eq!(
            env.get("PATH"),
            Some(&"/agent/bin:/usr/bin:/bin".to_owned())
        );

        let env = get_shell_env_with(
            "/agent/bin",
            [("PATH", "/agent/bin:/usr/bin"), ("HOME", "/home/user")],
            ':',
        );

        assert_eq!(env.get("PATH"), Some(&"/agent/bin:/usr/bin".to_owned()));
    }

    #[test]
    fn preserves_existing_path_key_casing() {
        let env = get_shell_env_with("C:\\agent\\bin", [("Path", "C:\\Windows")], ';');

        assert_eq!(
            env.get("Path"),
            Some(&"C:\\agent\\bin;C:\\Windows".to_owned())
        );
        assert!(!env.contains_key("PATH"));
    }

    #[test]
    fn creates_path_when_missing() {
        let env = get_shell_env_with("/agent/bin", [("HOME", "/home/user")], ':');

        assert_eq!(env.get("PATH"), Some(&"/agent/bin".to_owned()));
    }

    #[test]
    fn sanitizes_binary_output_control_and_format_characters() {
        let input = "ok\u{0} tabs\t newlines\n returns\r \u{fff9}done";

        assert_eq!(
            sanitize_binary_output(input),
            "ok tabs\t newlines\n returns\r done"
        );
    }

    #[test]
    fn tracks_untracks_and_drains_detached_pids_without_killing_processes() {
        kill_tracked_detached_children_with(ShellPlatform::Unix, |_, _| {});

        track_detached_child_pid(101);
        track_detached_child_pid(202);
        track_detached_child_pid(101);
        untrack_detached_child_pid(202);

        let mut killed = Vec::new();
        kill_tracked_detached_children_with(ShellPlatform::Unix, |platform, pid| {
            killed.push((platform, pid));
        });

        assert_eq!(killed, vec![(ShellPlatform::Unix, 101)]);
        assert_eq!(tracked_detached_child_pid_count(), 0);
    }
}
