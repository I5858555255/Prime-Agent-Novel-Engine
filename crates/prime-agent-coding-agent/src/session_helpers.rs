use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fmt;
use std::path::{Path, PathBuf};

const UNKNOWN_PROVIDER: &str = "unknown";

pub fn get_provider_login_help(docs_path: impl AsRef<Path>) -> String {
    get_provider_login_help_with_docs_path(docs_path)
}

pub fn get_provider_login_help_with_docs_path(docs_path: impl AsRef<Path>) -> String {
    let docs_path = docs_path.as_ref();
    [
        "Use /login to log into a provider via OAuth or API key. See:".to_string(),
        format!("  {}", docs_path.join("providers.md").display()),
        format!("  {}", docs_path.join("models.md").display()),
    ]
    .join("\n")
}

pub fn format_no_models_available_message(docs_path: impl AsRef<Path>) -> String {
    format_no_models_available_message_with_docs_path(docs_path)
}

pub fn format_no_models_available_message_with_docs_path(docs_path: impl AsRef<Path>) -> String {
    format!(
        "No models available. {}",
        get_provider_login_help_with_docs_path(docs_path)
    )
}

pub fn is_no_models_available_message(message: Option<&str>, docs_path: impl AsRef<Path>) -> bool {
    is_no_models_available_message_with_docs_path(message, docs_path)
}

pub fn is_no_models_available_message_with_docs_path(
    message: Option<&str>,
    docs_path: impl AsRef<Path>,
) -> bool {
    message == Some(format_no_models_available_message_with_docs_path(docs_path).as_str())
}

pub fn format_no_model_selected_message(docs_path: impl AsRef<Path>) -> String {
    format_no_model_selected_message_with_docs_path(docs_path)
}

pub fn format_no_model_selected_message_with_docs_path(docs_path: impl AsRef<Path>) -> String {
    format!(
        "No model selected.\n\n{}\n\nThen use /model to select a model.",
        get_provider_login_help_with_docs_path(docs_path)
    )
}

pub fn format_no_api_key_found_message(provider: &str, docs_path: impl AsRef<Path>) -> String {
    format_no_api_key_found_message_with_docs_path(provider, docs_path)
}

pub fn format_no_api_key_found_message_with_docs_path(
    provider: &str,
    docs_path: impl AsRef<Path>,
) -> String {
    let provider_display = if provider == UNKNOWN_PROVIDER {
        "the selected model"
    } else {
        provider
    };

    format!(
        "No API key found for {provider_display}.\n\n{}",
        get_provider_login_help_with_docs_path(docs_path)
    )
}

/// Thrown when /import references a JSONL file path that does not exist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionImportFileNotFoundError {
    pub file_path: PathBuf,
}

impl SessionImportFileNotFoundError {
    pub fn new(file_path: impl Into<PathBuf>) -> Self {
        Self {
            file_path: file_path.into(),
        }
    }

    pub fn file_path(&self) -> &Path {
        &self.file_path
    }
}

impl fmt::Display for SessionImportFileNotFoundError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "File not found: {}", self.file_path.display())
    }
}

impl Error for SessionImportFileNotFoundError {}

/** Session statistics for the /session command and connection snapshots. */
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_file: Option<String>,
    pub session_id: String,
    pub user_messages: u64,
    pub assistant_messages: u64,
    pub tool_calls: u64,
    pub tool_results: u64,
    pub total_messages: u64,
    pub tokens: SessionTokenStats,
    pub cost: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_usage: Option<ContextUsage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTokenStats {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    pub tokens: Option<u64>,
    pub context_window: u64,
    pub percent: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DOCS_PATH: &str = "/tmp/docs";

    #[test]
    fn provider_login_help_matches_typescript_message_text() {
        assert_eq!(
            get_provider_login_help_with_docs_path(DOCS_PATH),
            "Use /login to log into a provider via OAuth or API key. See:\n  /tmp/docs/providers.md\n  /tmp/docs/models.md"
        );
    }

    #[test]
    fn no_models_available_message_matches_typescript_message_text() {
        let message = format_no_models_available_message_with_docs_path(DOCS_PATH);

        assert_eq!(
            message,
            "No models available. Use /login to log into a provider via OAuth or API key. See:\n  /tmp/docs/providers.md\n  /tmp/docs/models.md"
        );
        assert!(is_no_models_available_message_with_docs_path(
            Some(&message),
            DOCS_PATH
        ));
        assert!(!is_no_models_available_message_with_docs_path(
            None, DOCS_PATH
        ));
    }

    #[test]
    fn no_model_selected_message_matches_typescript_message_text() {
        assert_eq!(
            format_no_model_selected_message_with_docs_path(DOCS_PATH),
            "No model selected.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /tmp/docs/providers.md\n  /tmp/docs/models.md\n\nThen use /model to select a model."
        );
    }

    #[test]
    fn no_api_key_found_message_matches_typescript_message_text() {
        assert_eq!(
            format_no_api_key_found_message_with_docs_path("openai", DOCS_PATH),
            "No API key found for openai.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /tmp/docs/providers.md\n  /tmp/docs/models.md"
        );
        assert_eq!(
            format_no_api_key_found_message_with_docs_path("unknown", DOCS_PATH),
            "No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /tmp/docs/providers.md\n  /tmp/docs/models.md"
        );
    }

    #[test]
    fn session_import_file_not_found_error_exposes_path_and_display() {
        let error = SessionImportFileNotFoundError::new("/missing/session.jsonl");

        assert_eq!(error.file_path(), Path::new("/missing/session.jsonl"));
        assert_eq!(error.to_string(), "File not found: /missing/session.jsonl");
    }

    #[test]
    fn session_stats_serializes_with_typescript_field_names() {
        let stats = SessionStats {
            session_file: Some("/tmp/session.jsonl".to_string()),
            session_id: "session-1".to_string(),
            user_messages: 2,
            assistant_messages: 3,
            tool_calls: 4,
            tool_results: 5,
            total_messages: 14,
            tokens: SessionTokenStats {
                input: 10,
                output: 20,
                cache_read: 30,
                cache_write: 40,
                total: 100,
            },
            cost: 1.25,
            context_usage: Some(ContextUsage {
                tokens: Some(80),
                context_window: 200,
                percent: Some(40.0),
            }),
        };

        assert_eq!(
            serde_json::to_value(stats).unwrap(),
            json!({
                "sessionFile": "/tmp/session.jsonl",
                "sessionId": "session-1",
                "userMessages": 2,
                "assistantMessages": 3,
                "toolCalls": 4,
                "toolResults": 5,
                "totalMessages": 14,
                "tokens": {
                    "input": 10,
                    "output": 20,
                    "cacheRead": 30,
                    "cacheWrite": 40,
                    "total": 100
                },
                "cost": 1.25,
                "contextUsage": {
                    "tokens": 80,
                    "contextWindow": 200,
                    "percent": 40.0
                }
            })
        );
    }

    #[test]
    fn optional_session_stats_fields_are_omitted_and_context_tokens_can_be_null() {
        let stats = SessionStats {
            session_file: None,
            session_id: "session-1".to_string(),
            user_messages: 0,
            assistant_messages: 0,
            tool_calls: 0,
            tool_results: 0,
            total_messages: 0,
            tokens: SessionTokenStats {
                input: 0,
                output: 0,
                cache_read: 0,
                cache_write: 0,
                total: 0,
            },
            cost: 0.0,
            context_usage: Some(ContextUsage {
                tokens: None,
                context_window: 128_000,
                percent: None,
            }),
        };

        assert_eq!(
            serde_json::to_value(stats).unwrap(),
            json!({
                "sessionId": "session-1",
                "userMessages": 0,
                "assistantMessages": 0,
                "toolCalls": 0,
                "toolResults": 0,
                "totalMessages": 0,
                "tokens": {
                    "input": 0,
                    "output": 0,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "total": 0
                },
                "cost": 0.0,
                "contextUsage": {
                    "tokens": null,
                    "contextWindow": 128000,
                    "percent": null
                }
            })
        );
    }
}
