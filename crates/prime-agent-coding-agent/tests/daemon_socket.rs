#[path = "../src/daemon_socket.rs"]
mod daemon_socket;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use daemon_socket::{
    DAEMON_SOCKET_DIR_MODE, DAEMON_SOCKET_MODE, can_connect_to_unix_socket,
    cleanup_daemon_socket_path, default_daemon_socket_dir, default_daemon_socket_path,
    ensure_default_daemon_socket_dir_for_test, prepare_daemon_socket_path,
    restrict_daemon_socket_path,
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::net::UnixListener;

struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn new(name: &str) -> Self {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after the Unix epoch")
            .as_nanos();
        let path = test_temp_base().join(format!("pa-ds-{name}-{}-{now}", std::process::id()));
        fs::create_dir(&path).expect("test directory should be created");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn test_temp_base() -> PathBuf {
    #[cfg(unix)]
    {
        PathBuf::from("/tmp")
    }

    #[cfg(not(unix))]
    {
        std::env::temp_dir()
    }
}

#[test]
fn daemon_socket_default_path_uses_platform_default() {
    #[cfg(windows)]
    {
        assert_eq!(
            default_daemon_socket_path(),
            PathBuf::from(r"\\.\pipe\prime-agent-daemon")
        );
    }

    #[cfg(not(windows))]
    {
        let socket_path = default_daemon_socket_path();
        assert_eq!(
            socket_path.parent(),
            Some(default_daemon_socket_dir().as_path())
        );
        assert_eq!(
            socket_path.file_name().and_then(|name| name.to_str()),
            Some("daemon.sock")
        );
    }
}

#[cfg(unix)]
#[test]
fn daemon_socket_secure_default_directory_is_created_and_chmodded() {
    let test_dir = TestDir::new("secure-dir");
    let default_dir = test_dir.path().join("prime-agent-123");
    let socket_path = default_dir.join("daemon.sock");

    ensure_default_daemon_socket_dir_for_test(&socket_path, &default_dir)
        .expect("default socket directory should be created");

    let metadata = fs::metadata(&default_dir).expect("default socket directory should exist");
    assert!(metadata.is_dir());
    assert_eq!(
        metadata.permissions().mode() & 0o777,
        DAEMON_SOCKET_DIR_MODE
    );

    fs::set_permissions(&default_dir, fs::Permissions::from_mode(0o755))
        .expect("test should loosen directory permissions");
    ensure_default_daemon_socket_dir_for_test(&socket_path, &default_dir)
        .expect("default socket directory should be restricted again");
    let metadata = fs::metadata(&default_dir).expect("default socket directory should still exist");
    assert_eq!(
        metadata.permissions().mode() & 0o777,
        DAEMON_SOCKET_DIR_MODE
    );
}

#[cfg(unix)]
#[test]
fn daemon_socket_secure_default_directory_rejects_non_directory() {
    let test_dir = TestDir::new("default-dir-file");
    let default_dir = test_dir.path().join("prime-agent-123");
    let socket_path = default_dir.join("daemon.sock");
    fs::write(&default_dir, b"not a directory").expect("test file should be written");

    let error = ensure_default_daemon_socket_dir_for_test(&socket_path, &default_dir)
        .expect_err("non-directory default socket path should be rejected");

    assert!(
        error
            .to_string()
            .contains("Daemon socket directory exists and is not a directory")
    );
}

#[cfg(unix)]
#[test]
fn daemon_socket_custom_parent_does_not_create_directory() {
    let test_dir = TestDir::new("custom-parent");
    let default_dir = test_dir.path().join("prime-agent-123");
    let socket_path = test_dir.path().join("elsewhere").join("daemon.sock");

    ensure_default_daemon_socket_dir_for_test(&socket_path, &default_dir)
        .expect("custom socket directories should be ignored");

    assert!(!default_dir.exists());
    assert!(
        !socket_path
            .parent()
            .expect("socket path has a parent")
            .exists()
    );
}

#[cfg(unix)]
#[test]
fn daemon_socket_prepare_rejects_existing_non_socket_path() {
    let test_dir = TestDir::new("non-socket");
    let socket_path = test_dir.path().join("daemon.sock");
    fs::write(&socket_path, b"not a socket").expect("test file should be written");

    let error = prepare_daemon_socket_path(&socket_path)
        .expect_err("existing non-socket path should be rejected");

    assert!(
        error
            .to_string()
            .contains("Daemon socket path exists and is not a socket")
    );
    assert!(socket_path.exists());
}

#[cfg(unix)]
#[test]
fn daemon_socket_prepare_rejects_dangling_symlink_path() {
    let test_dir = TestDir::new("dangling-symlink");
    let socket_path = test_dir.path().join("daemon.sock");
    let missing_target = test_dir.path().join("missing.sock");
    std::os::unix::fs::symlink(&missing_target, &socket_path)
        .expect("test symlink should be created");

    assert!(!socket_path.exists());
    let error = prepare_daemon_socket_path(&socket_path)
        .expect_err("dangling symlink should be treated as an existing unsafe path");

    assert!(
        error
            .to_string()
            .contains("Daemon socket path exists and is not a socket")
    );
    assert!(
        fs::symlink_metadata(&socket_path)
            .expect("symlink should remain for caller inspection")
            .file_type()
            .is_symlink()
    );
}

#[cfg(unix)]
#[test]
fn daemon_socket_prepare_removes_stale_socket_file() {
    let test_dir = TestDir::new("stale-socket");
    let socket_path = test_dir.path().join("daemon.sock");
    let listener = UnixListener::bind(&socket_path).expect("test socket should bind");
    drop(listener);

    assert!(socket_path.exists());
    assert!(!can_connect_to_unix_socket(&socket_path));

    prepare_daemon_socket_path(&socket_path).expect("stale socket should be removed");

    assert!(!socket_path.exists());
}

#[cfg(unix)]
#[test]
fn daemon_socket_prepare_rejects_active_socket_file() {
    let test_dir = TestDir::new("active-socket");
    let socket_path = test_dir.path().join("daemon.sock");
    let listener = UnixListener::bind(&socket_path).expect("test socket should bind");

    assert!(can_connect_to_unix_socket(&socket_path));
    let error =
        prepare_daemon_socket_path(&socket_path).expect_err("active socket should not be removed");

    assert!(error.to_string().contains("Daemon socket already in use"));
    assert!(socket_path.exists());

    drop(listener);
    cleanup_daemon_socket_path(&socket_path);
}

#[cfg(unix)]
#[test]
fn daemon_socket_restrict_sets_socket_path_mode() {
    let test_dir = TestDir::new("restrict");
    let socket_path = test_dir.path().join("daemon.sock");
    fs::write(&socket_path, b"socket placeholder").expect("test file should be written");
    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o666))
        .expect("test should loosen file permissions");

    restrict_daemon_socket_path(&socket_path).expect("socket path should be chmodded");

    let metadata = fs::metadata(&socket_path).expect("socket path should exist");
    assert_eq!(metadata.permissions().mode() & 0o777, DAEMON_SOCKET_MODE);
}

#[cfg(unix)]
#[test]
fn daemon_socket_cleanup_removes_socket_path_and_ignores_missing_files() {
    let test_dir = TestDir::new("cleanup");
    let socket_path = test_dir.path().join("daemon.sock");
    fs::write(&socket_path, b"socket placeholder").expect("test file should be written");

    cleanup_daemon_socket_path(&socket_path);
    cleanup_daemon_socket_path(&socket_path);

    assert!(!socket_path.exists());
}
