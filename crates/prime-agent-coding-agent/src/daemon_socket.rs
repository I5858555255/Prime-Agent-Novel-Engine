use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::sync::mpsc;
#[cfg(unix)]
use std::thread;

pub const DAEMON_SOCKET_MODE: u32 = 0o600;
pub const DAEMON_SOCKET_DIR_MODE: u32 = 0o700;
pub const DAEMON_SOCKET_CONNECT_TIMEOUT: Duration = Duration::from_millis(250);

pub fn default_daemon_socket_path() -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(r"\\.\pipe\prime-agent-daemon")
    }

    #[cfg(not(windows))]
    {
        default_daemon_socket_dir().join("daemon.sock")
    }
}

pub fn default_daemon_socket_dir() -> PathBuf {
    std::env::temp_dir().join(format!("prime-agent-{}", current_user_suffix()))
}

pub fn prepare_daemon_socket_path<P>(socket_path: P) -> io::Result<()>
where
    P: AsRef<Path>,
{
    let socket_path = socket_path.as_ref();
    ensure_default_daemon_socket_dir(socket_path)?;

    #[cfg(not(unix))]
    {
        let _ = socket_path;
        Ok(())
    }

    #[cfg(unix)]
    {
        if fs::symlink_metadata(socket_path).is_err() {
            return Ok(());
        }

        let metadata = fs::symlink_metadata(socket_path)?;
        if !metadata.file_type().is_socket() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!(
                    "Daemon socket path exists and is not a socket: {}",
                    socket_path.display()
                ),
            ));
        }

        if can_connect_to_unix_socket(socket_path) {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                format!("Daemon socket already in use: {}", socket_path.display()),
            ));
        }

        fs::remove_file(socket_path)
    }
}

pub fn restrict_daemon_socket_path<P>(socket_path: P) -> io::Result<()>
where
    P: AsRef<Path>,
{
    #[cfg(not(unix))]
    {
        let _ = socket_path;
        Ok(())
    }

    #[cfg(unix)]
    {
        fs::set_permissions(
            socket_path.as_ref(),
            fs::Permissions::from_mode(DAEMON_SOCKET_MODE),
        )
    }
}

pub fn cleanup_daemon_socket_path<P>(socket_path: P)
where
    P: AsRef<Path>,
{
    #[cfg(unix)]
    {
        let _ = fs::remove_file(socket_path.as_ref());
    }

    #[cfg(not(unix))]
    {
        let _ = socket_path;
    }
}

pub fn can_connect_to_unix_socket<P>(socket_path: P) -> bool
where
    P: AsRef<Path>,
{
    #[cfg(not(unix))]
    {
        let _ = socket_path;
        false
    }

    #[cfg(unix)]
    {
        can_connect_to_unix_socket_with_timeout(
            socket_path.as_ref().to_path_buf(),
            DAEMON_SOCKET_CONNECT_TIMEOUT,
        )
    }
}

fn ensure_default_daemon_socket_dir(socket_path: &Path) -> io::Result<()> {
    #[cfg(not(unix))]
    {
        let _ = socket_path;
        Ok(())
    }

    #[cfg(unix)]
    {
        ensure_default_daemon_socket_dir_with_default(socket_path, &default_daemon_socket_dir())
    }
}

#[cfg(unix)]
fn ensure_default_daemon_socket_dir_with_default(
    socket_path: &Path,
    default_dir: &Path,
) -> io::Result<()> {
    if socket_path.parent() != Some(default_dir) {
        return Ok(());
    }

    if !default_dir.exists() {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(DAEMON_SOCKET_DIR_MODE)
            .create(default_dir)?;
    }

    let metadata = fs::symlink_metadata(default_dir)?;
    if !metadata.file_type().is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "Daemon socket directory exists and is not a directory: {}",
                default_dir.display()
            ),
        ));
    }

    let current_uid = current_uid();
    if metadata.uid() != current_uid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "Daemon socket directory is not owned by the current user: {}",
                default_dir.display()
            ),
        ));
    }

    fs::set_permissions(
        default_dir,
        fs::Permissions::from_mode(DAEMON_SOCKET_DIR_MODE),
    )
}

#[cfg(unix)]
fn can_connect_to_unix_socket_with_timeout(socket_path: PathBuf, timeout: Duration) -> bool {
    let (tx, rx) = mpsc::channel();
    let _ = thread::spawn(move || {
        let _ = tx.send(UnixStream::connect(socket_path).is_ok());
    });

    rx.recv_timeout(timeout).unwrap_or(false)
}

fn current_user_suffix() -> String {
    #[cfg(unix)]
    {
        current_uid().to_string()
    }

    #[cfg(not(unix))]
    {
        "user".to_string()
    }
}

#[cfg(unix)]
fn current_uid() -> u32 {
    unsafe extern "C" {
        fn getuid() -> u32;
    }

    // SAFETY: getuid has no preconditions and does not write through pointers.
    unsafe { getuid() }
}

#[cfg(test)]
#[allow(dead_code)]
pub(crate) fn ensure_default_daemon_socket_dir_for_test<P, Q>(
    socket_path: P,
    default_dir: Q,
) -> io::Result<()>
where
    P: AsRef<Path>,
    Q: AsRef<Path>,
{
    #[cfg(not(unix))]
    {
        let _ = socket_path;
        let _ = default_dir;
        Ok(())
    }

    #[cfg(unix)]
    {
        ensure_default_daemon_socket_dir_with_default(socket_path.as_ref(), default_dir.as_ref())
    }
}
