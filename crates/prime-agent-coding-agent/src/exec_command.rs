use crate::child_process::wait_for_child_process;
use std::ffi::OsStr;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Options for executing a command.
///
/// TypeScript's `AbortSignal` has no direct standard-library equivalent. The
/// `cancelled` flag approximates it: set the flag to `true` from another thread
/// and `exec_command` will terminate the child on the next polling interval.
#[derive(Debug, Clone, Default)]
pub struct ExecOptions {
    pub timeout: Option<Duration>,
    /// Overrides the `cwd` argument when present.
    pub cwd: Option<PathBuf>,
    pub cancelled: Option<Arc<AtomicBool>>,
}

/// Result of executing a command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
    pub killed: bool,
}

/// Execute a command with arguments, capturing stdout/stderr and the exit code.
pub fn exec_command<C, A, I, P>(
    command: C,
    args: I,
    cwd: P,
    options: Option<ExecOptions>,
) -> io::Result<ExecResult>
where
    C: AsRef<OsStr>,
    A: AsRef<OsStr>,
    I: IntoIterator<Item = A>,
    P: AsRef<Path>,
{
    let options = options.unwrap_or_default();
    let effective_cwd = options.cwd.as_deref().unwrap_or_else(|| cwd.as_ref());

    let mut child = Command::new(command)
        .args(args)
        .current_dir(effective_cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let stdout_reader = child.stdout.take().map(read_pipe_to_string);
    let stderr_reader = child.stderr.take().map(read_pipe_to_string);
    let started_at = Instant::now();
    let mut killed = false;

    loop {
        if child.try_wait()?.is_some() {
            break;
        }

        let timed_out = match options.timeout {
            Some(timeout) => timeout > Duration::ZERO && started_at.elapsed() >= timeout,
            None => false,
        };
        let cancelled = match &options.cancelled {
            Some(flag) => flag.load(Ordering::SeqCst),
            None => false,
        };

        if timed_out || cancelled {
            killed = true;
            let _ = child.kill();
            break;
        }

        thread::sleep(POLL_INTERVAL);
    }

    let code = wait_for_child_process(&mut child)?.unwrap_or(0);
    let stdout = join_reader(stdout_reader)?;
    let stderr = join_reader(stderr_reader)?;

    Ok(ExecResult {
        stdout,
        stderr,
        code,
        killed,
    })
}

fn read_pipe_to_string(
    mut pipe: impl Read + Send + 'static,
) -> thread::JoinHandle<io::Result<String>> {
    thread::spawn(move || {
        let mut output = String::new();
        pipe.read_to_string(&mut output)?;
        Ok(output)
    })
}

fn join_reader(reader: Option<thread::JoinHandle<io::Result<String>>>) -> io::Result<String> {
    match reader {
        Some(reader) => reader
            .join()
            .map_err(|_| io::Error::other("reader thread panicked"))?,
        None => Ok(String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell_command(script: &str) -> (&'static str, Vec<&str>) {
        if cfg!(windows) {
            ("cmd", vec!["/C", script])
        } else {
            ("sh", vec!["-c", script])
        }
    }

    fn run_script(script: &str, timeout: Option<Duration>) -> ExecResult {
        let (command, args) = shell_command(script);
        exec_command(
            command,
            args,
            ".",
            Some(ExecOptions {
                timeout,
                ..ExecOptions::default()
            }),
        )
        .unwrap()
    }

    #[test]
    fn exec_command_captures_success_stdout() {
        let result = run_script("echo hello", None);

        assert!(result.stdout.contains("hello"));
        assert_eq!(result.stderr, "");
        assert_eq!(result.code, 0);
        assert!(!result.killed);
    }

    #[test]
    fn exec_command_captures_stderr() {
        let result = run_script("echo problem 1>&2", None);

        assert_eq!(result.stdout, "");
        assert!(result.stderr.contains("problem"));
        assert_eq!(result.code, 0);
        assert!(!result.killed);
    }

    #[test]
    fn exec_command_reports_nonzero_exit() {
        let result = run_script("exit 7", None);

        assert_eq!(result.stdout, "");
        assert_eq!(result.stderr, "");
        assert_eq!(result.code, 7);
        assert!(!result.killed);
    }

    #[test]
    fn exec_command_kills_on_timeout() {
        let script = if cfg!(windows) {
            "ping -n 3 127.0.0.1 >NUL"
        } else {
            "sleep 1"
        };
        let result = run_script(script, Some(Duration::from_millis(50)));

        assert!(result.killed);
    }
}
