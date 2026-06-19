use std::fmt::Write as _;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimingEntry {
    pub label: String,
    pub ms: u128,
}

#[derive(Debug)]
struct TimingState {
    enabled: bool,
    timings: Vec<TimingEntry>,
    last_time: u128,
}

impl TimingState {
    fn new() -> Self {
        Self {
            enabled: std::env::var("PI_TIMING").as_deref() == Ok("1"),
            timings: Vec::new(),
            last_time: current_time_millis(),
        }
    }
}

fn timing_state() -> &'static Mutex<TimingState> {
    static TIMING_STATE: OnceLock<Mutex<TimingState>> = OnceLock::new();
    TIMING_STATE.get_or_init(|| Mutex::new(TimingState::new()))
}

pub fn reset_timings() {
    reset_timings_at(current_time_millis());
}

pub fn reset_timings_at(now_ms: u128) {
    let mut state = timing_state().lock().unwrap();
    if !state.enabled {
        return;
    }
    state.timings.clear();
    state.last_time = now_ms;
}

pub fn time(label: impl Into<String>) {
    time_at(label, current_time_millis());
}

pub fn time_at(label: impl Into<String>, now_ms: u128) {
    let mut state = timing_state().lock().unwrap();
    if !state.enabled {
        return;
    }

    let ms = now_ms.saturating_sub(state.last_time);
    state.timings.push(TimingEntry {
        label: label.into(),
        ms,
    });
    state.last_time = now_ms;
}

pub fn print_timings() -> Option<String> {
    let state = timing_state().lock().unwrap();
    if !state.enabled {
        return None;
    }
    format_timings(&state.timings)
}

pub fn format_timings(timings: &[TimingEntry]) -> Option<String> {
    if timings.is_empty() {
        return None;
    }

    let mut output = String::new();
    let _ = writeln!(output, "\n--- Startup Timings ---");
    for timing in timings {
        let _ = writeln!(output, "  {}: {}ms", timing.label, timing.ms);
    }
    let total: u128 = timings.iter().map(|timing| timing.ms).sum();
    let _ = writeln!(output, "  TOTAL: {total}ms");
    let _ = writeln!(output, "------------------------");
    Some(output)
}

#[cfg(test)]
fn set_timings_enabled_for_tests(enabled: bool, now_ms: u128) {
    let mut state = timing_state().lock().unwrap();
    state.enabled = enabled;
    state.timings.clear();
    state.last_time = now_ms;
}

#[cfg(test)]
fn timing_entries_for_tests() -> Vec<TimingEntry> {
    timing_state().lock().unwrap().timings.clone()
}

fn current_time_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_timings_are_noops() {
        set_timings_enabled_for_tests(false, 100);

        reset_timings_at(200);
        time_at("startup", 250);

        assert_eq!(timing_entries_for_tests(), Vec::new());
        assert_eq!(print_timings(), None);
    }

    #[test]
    fn records_elapsed_time_between_marks_when_enabled() {
        set_timings_enabled_for_tests(true, 100);

        time_at("load-config", 175);
        time_at("render", 205);

        assert_eq!(
            timing_entries_for_tests(),
            vec![
                TimingEntry {
                    label: "load-config".to_string(),
                    ms: 75,
                },
                TimingEntry {
                    label: "render".to_string(),
                    ms: 30,
                },
            ]
        );
    }

    #[test]
    fn reset_clears_entries_and_resets_last_time() {
        set_timings_enabled_for_tests(true, 100);

        time_at("before", 125);
        reset_timings_at(200);
        time_at("after", 240);

        assert_eq!(
            timing_entries_for_tests(),
            vec![TimingEntry {
                label: "after".to_string(),
                ms: 40,
            }]
        );
    }

    #[test]
    fn formats_startup_timing_output_like_typescript() {
        let output = format_timings(&[
            TimingEntry {
                label: "config".to_string(),
                ms: 5,
            },
            TimingEntry {
                label: "render".to_string(),
                ms: 8,
            },
        ])
        .unwrap();

        assert!(output.contains("--- Startup Timings ---"));
        assert!(output.contains("  config: 5ms"));
        assert!(output.contains("  render: 8ms"));
        assert!(output.contains("  TOTAL: 13ms"));
        assert!(output.contains("------------------------"));
    }
}
