use std::collections::BTreeSet;
use std::io;
use std::path::Path;
use std::process::Child;

pub const EXIT_STDIO_GRACE_MS: u64 = 100;

pub fn should_use_windows_shell(command: &str) -> bool {
    should_use_windows_shell_for_platform(cfg!(windows), command)
}

pub fn should_use_windows_shell_for_platform(is_windows: bool, command: &str) -> bool {
    if !is_windows {
        return false;
    }

    let command_name = Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command)
        .to_ascii_lowercase();

    command_name.ends_with(".cmd")
        || command_name.ends_with(".bat")
        || windows_shell_commands().contains(command_name.as_str())
}

pub fn wait_for_child_process(child: &mut Child) -> io::Result<Option<i32>> {
    child.wait().map(|status| status.code())
}

fn windows_shell_commands() -> BTreeSet<&'static str> {
    ["npm", "npx", "pnpm", "yarn", "yarnpkg", "corepack"]
        .into_iter()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    #[test]
    fn non_windows_never_uses_windows_shell() {
        assert!(!should_use_windows_shell_for_platform(false, "npm"));
        assert!(!should_use_windows_shell_for_platform(false, "script.cmd"));
    }

    #[test]
    fn windows_uses_shell_for_cmd_bat_and_package_manager_shims() {
        for command in [
            "npm",
            "npx",
            "pnpm",
            "yarn",
            "yarnpkg",
            "corepack",
            "C:/Program Files/node/npm.cmd",
            "C:/tools/run.BAT",
        ] {
            assert!(
                should_use_windows_shell_for_platform(true, command),
                "{command} should use shell"
            );
        }
    }

    #[test]
    fn windows_does_not_use_shell_for_regular_executables() {
        assert!(!should_use_windows_shell_for_platform(true, "node"));
        assert!(!should_use_windows_shell_for_platform(true, "python.exe"));
    }

    #[test]
    fn waits_for_child_process_and_returns_exit_code() {
        let mut child = if cfg!(windows) {
            Command::new("cmd")
                .args(["/C", "exit 7"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap()
        } else {
            Command::new("sh")
                .args(["-c", "exit 7"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap()
        };

        assert_eq!(wait_for_child_process(&mut child).unwrap(), Some(7));
    }
}
