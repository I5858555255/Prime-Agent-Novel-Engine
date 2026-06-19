pub const TERMINAL_PROGRESS_KEEPALIVE_MS: u64 = 1000;
pub const TERMINAL_PROGRESS_ACTIVE_SEQUENCE: &str = "\x1b]9;4;3\x07";
pub const TERMINAL_PROGRESS_CLEAR_SEQUENCE: &str = "\x1b]9;4;0;\x07";
pub const ENABLE_BRACKETED_PASTE_SEQUENCE: &str = "\x1b[?2004h";
pub const DISABLE_BRACKETED_PASTE_SEQUENCE: &str = "\x1b[?2004l";
pub const QUERY_KITTY_KEYBOARD_PROTOCOL_SEQUENCE: &str = "\x1b[?u";
pub const ENABLE_KITTY_KEYBOARD_PROTOCOL_SEQUENCE: &str = "\x1b[>7u";
pub const DISABLE_KITTY_KEYBOARD_PROTOCOL_SEQUENCE: &str = "\x1b[<u";
pub const ENABLE_MODIFY_OTHER_KEYS_SEQUENCE: &str = "\x1b[>4;2m";
pub const DISABLE_MODIFY_OTHER_KEYS_SEQUENCE: &str = "\x1b[>4;0m";

pub const DEFAULT_COLUMNS: u16 = 80;
pub const DEFAULT_ROWS: u16 = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalDimensions {
    pub columns: u16,
    pub rows: u16,
}

impl Default for TerminalDimensions {
    fn default() -> Self {
        Self {
            columns: DEFAULT_COLUMNS,
            rows: DEFAULT_ROWS,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSizeInputs<'a> {
    pub stdout_columns: Option<u16>,
    pub stdout_rows: Option<u16>,
    pub env_columns: Option<&'a str>,
    pub env_lines: Option<&'a str>,
}

pub trait Terminal {
    fn start_sequences(&self) -> Vec<&'static str>;
    fn stop_sequences(&self) -> Vec<&'static str>;
    fn dimensions(&self) -> TerminalDimensions;
    fn kitty_protocol_active(&self) -> bool;
    fn set_kitty_protocol_active(&mut self, active: bool);
    fn modify_other_keys_active(&self) -> bool;
    fn set_modify_other_keys_active(&mut self, active: bool);
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProcessTerminalState {
    dimensions: TerminalDimensions,
    kitty_protocol_active: bool,
    modify_other_keys_active: bool,
    progress_active: bool,
}

impl ProcessTerminalState {
    pub fn new(inputs: TerminalSizeInputs<'_>) -> Self {
        Self {
            dimensions: resolve_terminal_dimensions(inputs),
            ..Self::default()
        }
    }

    pub fn progress_active(&self) -> bool {
        self.progress_active
    }

    pub fn set_progress(&mut self, active: bool) -> &'static str {
        self.progress_active = active;
        if active {
            TERMINAL_PROGRESS_ACTIVE_SEQUENCE
        } else {
            TERMINAL_PROGRESS_CLEAR_SEQUENCE
        }
    }

    pub fn set_dimensions(&mut self, dimensions: TerminalDimensions) {
        self.dimensions = TerminalDimensions {
            columns: dimensions.columns.max(1),
            rows: dimensions.rows.max(1),
        };
    }
}

impl Terminal for ProcessTerminalState {
    fn start_sequences(&self) -> Vec<&'static str> {
        vec![
            ENABLE_BRACKETED_PASTE_SEQUENCE,
            QUERY_KITTY_KEYBOARD_PROTOCOL_SEQUENCE,
        ]
    }

    fn stop_sequences(&self) -> Vec<&'static str> {
        let mut sequences = Vec::new();
        if self.progress_active {
            sequences.push(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
        }
        sequences.push(DISABLE_BRACKETED_PASTE_SEQUENCE);
        if self.kitty_protocol_active {
            sequences.push(DISABLE_KITTY_KEYBOARD_PROTOCOL_SEQUENCE);
        }
        if self.modify_other_keys_active {
            sequences.push(DISABLE_MODIFY_OTHER_KEYS_SEQUENCE);
        }
        sequences
    }

    fn dimensions(&self) -> TerminalDimensions {
        self.dimensions
    }

    fn kitty_protocol_active(&self) -> bool {
        self.kitty_protocol_active
    }

    fn set_kitty_protocol_active(&mut self, active: bool) {
        self.kitty_protocol_active = active;
        if active {
            self.modify_other_keys_active = false;
        }
    }

    fn modify_other_keys_active(&self) -> bool {
        self.modify_other_keys_active
    }

    fn set_modify_other_keys_active(&mut self, active: bool) {
        self.modify_other_keys_active = active && !self.kitty_protocol_active;
    }
}

pub fn resolve_terminal_dimensions(inputs: TerminalSizeInputs<'_>) -> TerminalDimensions {
    TerminalDimensions {
        columns: resolve_terminal_columns(inputs.stdout_columns, inputs.env_columns),
        rows: resolve_terminal_rows(inputs.stdout_rows, inputs.env_lines),
    }
}

pub fn resolve_terminal_columns(stdout_columns: Option<u16>, env_columns: Option<&str>) -> u16 {
    stdout_columns
        .filter(|columns| *columns > 0)
        .or_else(|| parse_positive_u16(env_columns))
        .unwrap_or(DEFAULT_COLUMNS)
}

pub fn resolve_terminal_rows(stdout_rows: Option<u16>, env_lines: Option<&str>) -> u16 {
    stdout_rows
        .filter(|rows| *rows > 0)
        .or_else(|| parse_positive_u16(env_lines))
        .unwrap_or(DEFAULT_ROWS)
}

pub fn move_by_sequence(lines: i32) -> Option<String> {
    match lines.cmp(&0) {
        std::cmp::Ordering::Greater => Some(format!("\x1b[{lines}B")),
        std::cmp::Ordering::Less => Some(format!("\x1b[{}A", -lines)),
        std::cmp::Ordering::Equal => None,
    }
}

pub fn hide_cursor_sequence() -> &'static str {
    "\x1b[?25l"
}

pub fn show_cursor_sequence() -> &'static str {
    "\x1b[?25h"
}

pub fn clear_line_sequence() -> &'static str {
    "\x1b[K"
}

pub fn clear_from_cursor_sequence() -> &'static str {
    "\x1b[J"
}

pub fn clear_screen_sequence() -> &'static str {
    "\x1b[2J\x1b[H"
}

pub fn set_title_sequence(title: &str) -> String {
    format!("\x1b]0;{}\x07", sanitize_title(title))
}

pub fn kitty_protocol_response_flags(sequence: &str) -> Option<u32> {
    let flags = sequence.strip_prefix("\x1b[?")?.strip_suffix('u')?;
    (!flags.is_empty())
        .then(|| flags.parse::<u32>().ok())
        .flatten()
}

fn sanitize_title(title: &str) -> String {
    title
        .chars()
        .filter(|ch| *ch != '\x1b' && *ch != '\x07')
        .collect()
}

fn parse_positive_u16(value: Option<&str>) -> Option<u16> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    let parsed = value.parse::<u16>().ok()?;
    (parsed > 0).then_some(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_dimensions_follow_stdout_env_then_defaults_like_process_terminal() {
        assert_eq!(
            resolve_terminal_dimensions(TerminalSizeInputs {
                stdout_columns: Some(132),
                stdout_rows: Some(43),
                env_columns: Some("123"),
                env_lines: Some("45"),
            }),
            TerminalDimensions {
                columns: 132,
                rows: 43
            }
        );

        assert_eq!(
            resolve_terminal_dimensions(TerminalSizeInputs {
                stdout_columns: None,
                stdout_rows: None,
                env_columns: Some("123"),
                env_lines: Some("45"),
            }),
            TerminalDimensions {
                columns: 123,
                rows: 45
            }
        );

        assert_eq!(
            resolve_terminal_dimensions(TerminalSizeInputs {
                stdout_columns: Some(0),
                stdout_rows: Some(0),
                env_columns: Some("0"),
                env_lines: Some("bad"),
            }),
            TerminalDimensions::default()
        );
    }

    #[test]
    fn terminal_sequences_match_typescript_process_terminal_writes() {
        assert_eq!(move_by_sequence(3).as_deref(), Some("\x1b[3B"));
        assert_eq!(move_by_sequence(-2).as_deref(), Some("\x1b[2A"));
        assert_eq!(move_by_sequence(0), None);
        assert_eq!(hide_cursor_sequence(), "\x1b[?25l");
        assert_eq!(show_cursor_sequence(), "\x1b[?25h");
        assert_eq!(clear_line_sequence(), "\x1b[K");
        assert_eq!(clear_from_cursor_sequence(), "\x1b[J");
        assert_eq!(clear_screen_sequence(), "\x1b[2J\x1b[H");
        assert_eq!(set_title_sequence("Prime"), "\x1b]0;Prime\x07");
        assert_eq!(
            set_title_sequence("bad\x1btitle\x07"),
            "\x1b]0;badtitle\x07"
        );
    }

    #[test]
    fn process_terminal_state_tracks_protocol_and_progress_stop_sequences() {
        let mut terminal = ProcessTerminalState::new(TerminalSizeInputs {
            stdout_columns: None,
            stdout_rows: None,
            env_columns: Some("100"),
            env_lines: Some("30"),
        });

        assert_eq!(
            terminal.start_sequences(),
            vec![
                ENABLE_BRACKETED_PASTE_SEQUENCE,
                QUERY_KITTY_KEYBOARD_PROTOCOL_SEQUENCE
            ]
        );
        assert_eq!(
            terminal.dimensions(),
            TerminalDimensions {
                columns: 100,
                rows: 30
            }
        );

        assert_eq!(
            terminal.set_progress(true),
            TERMINAL_PROGRESS_ACTIVE_SEQUENCE
        );
        terminal.set_modify_other_keys_active(true);
        assert!(terminal.modify_other_keys_active());
        terminal.set_kitty_protocol_active(true);
        assert!(terminal.kitty_protocol_active());
        assert!(!terminal.modify_other_keys_active());

        assert_eq!(
            terminal.stop_sequences(),
            vec![
                TERMINAL_PROGRESS_CLEAR_SEQUENCE,
                DISABLE_BRACKETED_PASTE_SEQUENCE,
                DISABLE_KITTY_KEYBOARD_PROTOCOL_SEQUENCE
            ]
        );
        assert_eq!(
            terminal.set_progress(false),
            TERMINAL_PROGRESS_CLEAR_SEQUENCE
        );
    }

    #[test]
    fn kitty_protocol_response_parser_accepts_only_query_responses() {
        assert_eq!(kitty_protocol_response_flags("\x1b[?7u"), Some(7));
        assert_eq!(kitty_protocol_response_flags("\x1b[?0u"), Some(0));
        assert_eq!(kitty_protocol_response_flags("\x1b[>7u"), None);
        assert_eq!(kitty_protocol_response_flags("\x1b[?u"), None);
        assert_eq!(kitty_protocol_response_flags("plain"), None);
    }
}
