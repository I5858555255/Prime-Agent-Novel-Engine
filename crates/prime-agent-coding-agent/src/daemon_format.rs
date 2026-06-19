use chrono::{DateTime, Utc};
use prime_agent_ai::Model;

use crate::format_session_display_id;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DaemonStatus {
    Current,
    Stale,
    Unreachable,
    OrphanFile,
}

impl DaemonStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Stale => "stale",
            Self::Unreachable => "unreachable",
            Self::OrphanFile => "orphan-file",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DaemonInfo {
    pub socket_path: String,
    pub pid: Option<u32>,
    pub uptime_seconds: Option<f64>,
    pub version: Option<String>,
    pub protocol_version: Option<u32>,
    pub session_count: Option<u32>,
    pub status: DaemonStatus,
    pub is_default: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStatus {
    User,
    Idle,
    Tool,
    Model,
    Active,
    Sleep,
    Crash,
    Hidden,
}

impl SessionStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Idle => "idle",
            Self::Tool => "tool",
            Self::Model => "model",
            Self::Active => "active",
            Self::Sleep => "sleep",
            Self::Crash => "crash",
            Self::Hidden => "hidden",
        }
    }

    const fn sort_order(self) -> u8 {
        match self {
            Self::User => 0,
            Self::Idle => 1,
            Self::Tool => 2,
            Self::Model => 3,
            Self::Active => 4,
            Self::Sleep => 5,
            Self::Crash => 6,
            Self::Hidden => 7,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionSummary {
    pub id: String,
    pub status: SessionStatus,
    pub session_id: String,
    pub session_name: Option<String>,
    pub cwd: String,
    pub model: Option<Model>,
    pub is_streaming: bool,
    pub is_compacting: bool,
    pub attached_clients: u32,
    pub message_count: u32,
    pub pending_message_count: u32,
    pub modified: Option<String>,
}

pub fn format_uptime(uptime_seconds: Option<f64>) -> String {
    let Some(uptime_seconds) = uptime_seconds else {
        return String::new();
    };
    if !uptime_seconds.is_finite() {
        return String::new();
    }

    format_duration_seconds(uptime_seconds.floor().max(0.0) as u64, false)
}

pub fn format_daemon_list_table(daemons: &[DaemonInfo]) -> String {
    let rows = daemons
        .iter()
        .map(|daemon| {
            vec![
                if daemon.is_default {
                    format!("{} *", daemon.socket_path)
                } else {
                    daemon.socket_path.clone()
                },
                daemon.pid.map(|pid| pid.to_string()).unwrap_or_default(),
                daemon.version.clone().unwrap_or_default(),
                daemon.status.as_str().to_string(),
                daemon
                    .session_count
                    .map(|count| count.to_string())
                    .unwrap_or_default(),
                format_uptime(daemon.uptime_seconds),
            ]
        })
        .collect::<Vec<_>>();

    let table = format_table(
        &["socket", "pid", "version", "status", "sessions", "uptime"],
        &rows,
    );
    if daemons.iter().any(|daemon| daemon.is_default) {
        format!("{table}\n\n* default daemon")
    } else {
        table
    }
}

pub fn format_session_list_table(sessions: &[SessionSummary], now_ms: i64) -> String {
    let mut indexed_sessions = sessions.iter().enumerate().collect::<Vec<_>>();
    indexed_sessions.sort_by_key(|(index, session)| (session.status.sort_order(), *index));

    let rows = indexed_sessions
        .into_iter()
        .map(|(_, session)| {
            vec![
                session.session_name.clone().unwrap_or_default(),
                format_session_display_id(&session.id),
                session.status.as_str().to_string(),
                format_session_age(session.modified.as_deref(), now_ms),
                format_session_model(session.model.as_ref()),
                session.message_count.to_string(),
                session.attached_clients.to_string(),
            ]
        })
        .collect::<Vec<_>>();

    format_table(
        &[
            "name", "id", "status", "age", "model", "messages", "clients",
        ],
        &rows,
    )
}

fn format_session_age(modified: Option<&str>, now_ms: i64) -> String {
    let Some(modified) = modified else {
        return String::new();
    };
    let Ok(modified) = DateTime::parse_from_rfc3339(modified) else {
        return String::new();
    };
    let modified_ms = modified.with_timezone(&Utc).timestamp_millis();
    let age_seconds = ((now_ms - modified_ms) / 1000).max(0) as u64;

    format_duration_seconds(age_seconds, true)
}

fn format_duration_seconds(seconds: u64, include_years: bool) -> String {
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours}h");
    }
    let days = hours / 24;
    if days < 7 {
        return format!("{days}d");
    }
    let weeks = days / 7;
    if include_years && weeks >= 52 {
        return format!("{}y", weeks / 52);
    }
    format!("{weeks}w")
}

fn format_session_model(model: Option<&Model>) -> String {
    model
        .map(|model| format!("{}/{}", model.provider, model.id))
        .unwrap_or_default()
}

fn format_table(headers: &[&str], rows: &[Vec<String>]) -> String {
    let widths = headers
        .iter()
        .enumerate()
        .map(|(index, header)| {
            rows.iter()
                .map(|row| row[index].len())
                .max()
                .unwrap_or(0)
                .max(header.len())
        })
        .collect::<Vec<_>>();

    let mut lines = vec![
        headers
            .iter()
            .enumerate()
            .map(|(index, header)| format!("{header:<width$}", width = widths[index]))
            .collect::<Vec<_>>()
            .join("  "),
    ];

    for row in rows {
        lines.push(
            row.iter()
                .enumerate()
                .map(|(index, value)| format!("{value:<width$}", width = widths[index]))
                .collect::<Vec<_>>()
                .join("  "),
        );
    }

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use prime_agent_ai::Model;

    use super::*;

    #[test]
    fn formats_seconds_into_compact_human_duration() {
        assert_eq!(format_uptime(Some(0.0)), "0s");
        assert_eq!(format_uptime(Some(45.0)), "45s");
        assert_eq!(format_uptime(Some(90.0)), "1m");
        assert_eq!(format_uptime(Some((3 * 3600) as f64)), "3h");
        assert_eq!(format_uptime(Some((5 * 86400) as f64)), "5d");
        assert_eq!(format_uptime(Some((14 * 86400) as f64)), "2w");
    }

    #[test]
    fn format_uptime_returns_empty_for_unknown_or_invalid_uptime() {
        assert_eq!(format_uptime(None), "");
        assert_eq!(format_uptime(Some(f64::INFINITY)), "");
    }

    #[test]
    fn renders_daemon_columns_default_marker_and_blank_missing_fields() {
        let daemons = vec![
            DaemonInfo {
                socket_path: "/tmp/prime-agent-1000/daemon.sock".to_string(),
                pid: Some(1234),
                uptime_seconds: Some(7200.0),
                version: Some("0.1.5".to_string()),
                protocol_version: Some(1),
                session_count: Some(2),
                status: DaemonStatus::Current,
                is_default: true,
            },
            DaemonInfo {
                socket_path: "/tmp/orphan.sock".to_string(),
                pid: None,
                uptime_seconds: None,
                version: None,
                protocol_version: None,
                session_count: None,
                status: DaemonStatus::OrphanFile,
                is_default: false,
            },
        ];

        let table = format_daemon_list_table(&daemons);
        let lines = table.split('\n').collect::<Vec<_>>();

        assert_eq!(
            lines[0].split_whitespace().collect::<Vec<_>>(),
            ["socket", "pid", "version", "status", "sessions", "uptime"]
        );
        assert!(table.contains("/tmp/prime-agent-1000/daemon.sock *"));
        assert!(table.contains("* default daemon"));
        assert!(table.contains("current"));
        assert!(table.contains("orphan-file"));
        assert!(table.contains("2h"));
    }

    #[test]
    fn sorts_sessions_by_status_and_renders_compact_suffix_ids() {
        let now_ms = DateTime::parse_from_rfc3339("2026-05-29T12:00:00.000Z")
            .unwrap()
            .timestamp_millis();
        let table = format_session_list_table(
            &[
                make_summary(
                    "sleep",
                    "019e71ec-e08a-75a9-b573-fc10e9f8380f",
                    SessionStatus::Sleep,
                    None,
                ),
                make_summary("tool", "ccccddddeeee", SessionStatus::Tool, None),
                make_summary(
                    "crash",
                    "019e71ec-e08a-75a9-b573-abcdef123456",
                    SessionStatus::Crash,
                    None,
                ),
                make_summary("idle", "bbbbccccdddd", SessionStatus::Idle, None),
                make_summary("model", "ddddeeeeffff", SessionStatus::Model, None),
                make_summary(
                    "user",
                    "aaaabbbbcccc",
                    SessionStatus::User,
                    Some(Model {
                        provider: "openai-codex".to_string(),
                        id: "gpt-5.5".to_string(),
                        ..Model::default()
                    }),
                ),
            ],
            now_ms,
        );

        let lines = table.split('\n').collect::<Vec<_>>();
        assert_eq!(
            lines[0].split_whitespace().collect::<Vec<_>>(),
            [
                "name", "id", "status", "age", "model", "messages", "clients"
            ]
        );
        assert_eq!(
            lines[1..]
                .iter()
                .map(|line| line.split_whitespace().take(3).collect::<Vec<_>>())
                .collect::<Vec<_>>(),
            [
                vec!["user", "aaaabbbbcccc", "user"],
                vec!["idle", "bbbbccccdddd", "idle"],
                vec!["tool", "ccccddddeeee", "tool"],
                vec!["model", "ddddeeeeffff", "model"],
                vec!["sleep", "fc10e9f8380f", "sleep"],
                vec!["crash", "abcdef123456", "crash"],
            ]
        );
        assert!(table.contains("openai-codex/gpt-5.5"));
        assert!(!table.contains("/tmp/project"));
        assert!(!table.contains("019e71ec-e08a"));
    }

    fn make_summary(
        name: &str,
        id: &str,
        status: SessionStatus,
        model: Option<Model>,
    ) -> SessionSummary {
        SessionSummary {
            id: id.to_string(),
            status,
            session_id: id.to_string(),
            session_name: Some(name.to_string()),
            cwd: "/tmp/project".to_string(),
            model,
            is_streaming: matches!(status, SessionStatus::Tool | SessionStatus::Model),
            is_compacting: false,
            attached_clients: u32::from(status == SessionStatus::User),
            message_count: 2,
            pending_message_count: 0,
            modified: Some("2026-05-29T10:00:00.000Z".to_string()),
        }
    }
}
