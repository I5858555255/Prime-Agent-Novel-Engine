use std::error::Error;
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SleepError {
    Aborted,
}

impl fmt::Display for SleepError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Aborted => write!(f, "Aborted"),
        }
    }
}

impl Error for SleepError {}

/// Blocking sleep helper with optional cancellation.
///
/// Set the `cancelled` flag to `true` from another thread to abort before the
/// requested duration elapses.
pub fn sleep(duration: Duration, cancelled: Option<Arc<AtomicBool>>) -> Result<(), SleepError> {
    if is_cancelled(&cancelled) {
        return Err(SleepError::Aborted);
    }

    if duration.is_zero() {
        return Ok(());
    }

    let started_at = Instant::now();
    loop {
        if is_cancelled(&cancelled) {
            return Err(SleepError::Aborted);
        }

        let elapsed = started_at.elapsed();
        if elapsed >= duration {
            return Ok(());
        }

        thread::sleep(POLL_INTERVAL.min(duration - elapsed));
    }
}

fn is_cancelled(cancelled: &Option<Arc<AtomicBool>>) -> bool {
    cancelled
        .as_ref()
        .is_some_and(|flag| flag.load(Ordering::SeqCst))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sleep_returns_error_when_already_cancelled() {
        let cancelled = Arc::new(AtomicBool::new(true));

        assert_eq!(
            sleep(Duration::from_millis(50), Some(cancelled)),
            Err(SleepError::Aborted)
        );
    }

    #[test]
    fn sleep_returns_error_when_cancelled_during_sleep() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let thread_flag = Arc::clone(&cancelled);

        let handle = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            thread_flag.store(true, Ordering::SeqCst);
        });

        let result = sleep(Duration::from_secs(1), Some(cancelled));
        handle.join().unwrap();

        assert_eq!(result, Err(SleepError::Aborted));
    }

    #[test]
    fn sleep_completes_when_not_cancelled() {
        assert_eq!(sleep(Duration::from_millis(1), None), Ok(()));
    }
}
