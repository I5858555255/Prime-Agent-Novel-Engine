use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::error::Error;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DiagnosticCode {
    String(String),
    Number(i64),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticErrorInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<DiagnosticCode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessageDiagnostic {
    #[serde(rename = "type")]
    pub kind: String,
    pub timestamp: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<DiagnosticErrorInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Map<String, Value>>,
}

pub trait HasDiagnostics {
    fn diagnostics_mut(&mut self) -> &mut Vec<AssistantMessageDiagnostic>;
}

pub fn format_thrown_value(value: impl ToString) -> String {
    value.to_string()
}

pub fn extract_thrown_value(value: impl ToString) -> DiagnosticErrorInfo {
    DiagnosticErrorInfo {
        name: Some("ThrownValue".to_string()),
        message: format_thrown_value(value),
        stack: None,
        code: None,
    }
}

pub fn extract_diagnostic_error(error: &(impl Error + ?Sized)) -> DiagnosticErrorInfo {
    let message = error.to_string();
    DiagnosticErrorInfo {
        name: Some(std::any::type_name_of_val(error).to_string()),
        message: if message.is_empty() {
            std::any::type_name_of_val(error).to_string()
        } else {
            message
        },
        stack: None,
        code: None,
    }
}

pub fn create_assistant_message_diagnostic_at(
    kind: impl Into<String>,
    error: DiagnosticErrorInfo,
    details: Option<Map<String, Value>>,
    timestamp: u128,
) -> AssistantMessageDiagnostic {
    AssistantMessageDiagnostic {
        kind: kind.into(),
        timestamp,
        error: Some(error),
        details,
    }
}

pub fn create_assistant_message_diagnostic(
    kind: impl Into<String>,
    error: DiagnosticErrorInfo,
    details: Option<Map<String, Value>>,
) -> AssistantMessageDiagnostic {
    create_assistant_message_diagnostic_at(kind, error, details, current_time_millis())
}

pub fn append_assistant_message_diagnostic<T>(
    message: &mut T,
    diagnostic: AssistantMessageDiagnostic,
) where
    T: HasDiagnostics,
{
    message.diagnostics_mut().push(diagnostic);
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
    use serde_json::json;
    use std::fmt;

    #[derive(Debug)]
    struct EmptyError;

    impl fmt::Display for EmptyError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(formatter, "")
        }
    }

    impl Error for EmptyError {}

    #[derive(Default)]
    struct Message {
        diagnostics: Vec<AssistantMessageDiagnostic>,
    }

    impl HasDiagnostics for Message {
        fn diagnostics_mut(&mut self) -> &mut Vec<AssistantMessageDiagnostic> {
            &mut self.diagnostics
        }
    }

    #[test]
    fn thrown_values_use_the_typescript_thrown_value_name() {
        let error = extract_thrown_value("plain string");

        assert_eq!(error.name.as_deref(), Some("ThrownValue"));
        assert_eq!(error.message, "plain string");
        assert_eq!(error.stack, None);
        assert_eq!(error.code, None);
    }

    #[test]
    fn diagnostic_errors_fall_back_to_error_type_when_message_is_empty() {
        let error = extract_diagnostic_error(&EmptyError);

        assert!(error.message.contains("EmptyError"));
        assert_eq!(error.code, None);
    }

    #[test]
    fn creates_diagnostic_with_timestamp_details_and_serialized_type_field() {
        let mut details = Map::new();
        details.insert("attempt".to_string(), json!(2));

        let diagnostic = create_assistant_message_diagnostic_at(
            "provider-error",
            extract_thrown_value("bad"),
            Some(details),
            1234,
        );

        assert_eq!(diagnostic.kind, "provider-error");
        assert_eq!(diagnostic.timestamp, 1234);
        assert_eq!(
            serde_json::to_value(&diagnostic).unwrap(),
            json!({
                "type": "provider-error",
                "timestamp": 1234,
                "error": {
                    "name": "ThrownValue",
                    "message": "bad"
                },
                "details": {
                    "attempt": 2
                }
            })
        );
    }

    #[test]
    fn appends_diagnostics_without_replacing_existing_entries() {
        let mut message = Message::default();
        let first =
            create_assistant_message_diagnostic_at("first", extract_thrown_value("one"), None, 1);
        let second =
            create_assistant_message_diagnostic_at("second", extract_thrown_value("two"), None, 2);

        append_assistant_message_diagnostic(&mut message, first);
        append_assistant_message_diagnostic(&mut message, second);

        assert_eq!(message.diagnostics.len(), 2);
        assert_eq!(message.diagnostics[0].kind, "first");
        assert_eq!(message.diagnostics[1].kind, "second");
    }
}
