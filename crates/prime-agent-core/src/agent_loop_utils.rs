use prime_agent_ai::{ContentBlock, ToolResultMessage};
use serde_json::{Map, Value};

use crate::{AfterToolCallResult, AgentToolResult};

#[derive(Debug, Clone, PartialEq)]
pub struct FinalizedToolCallOutcome<T = Value> {
    pub tool_call_id: String,
    pub tool_name: String,
    pub result: AgentToolResult<T>,
    pub is_error: bool,
}

pub fn should_terminate_tool_batch<T>(finalized_calls: &[FinalizedToolCallOutcome<T>]) -> bool {
    !finalized_calls.is_empty()
        && finalized_calls
            .iter()
            .all(|finalized| finalized.result.terminate == Some(true))
}

pub fn create_error_tool_result(message: impl Into<String>) -> AgentToolResult<Value> {
    AgentToolResult {
        content: vec![ContentBlock::text(message)],
        details: Value::Object(Map::new()),
        terminate: None,
    }
}

pub fn create_tool_result_message<T>(
    finalized: FinalizedToolCallOutcome<T>,
    details: Option<Value>,
    timestamp: i64,
) -> ToolResultMessage {
    ToolResultMessage {
        tool_call_id: finalized.tool_call_id,
        tool_name: finalized.tool_name,
        content: finalized.result.content,
        details,
        is_error: finalized.is_error,
        timestamp,
    }
}

pub fn create_json_tool_result_message(
    finalized: FinalizedToolCallOutcome<Value>,
    timestamp: i64,
) -> ToolResultMessage {
    let FinalizedToolCallOutcome {
        tool_call_id,
        tool_name,
        result,
        is_error,
    } = finalized;
    let details = match result.details {
        Value::Null => None,
        value => Some(value),
    };
    ToolResultMessage {
        tool_call_id,
        tool_name,
        content: result.content,
        details,
        is_error,
        timestamp,
    }
}

pub fn apply_after_tool_call_result(
    mut result: AgentToolResult<Value>,
    mut is_error: bool,
    after_result: Option<AfterToolCallResult>,
) -> (AgentToolResult<Value>, bool) {
    if let Some(after_result) = after_result {
        if let Some(content) = after_result.content {
            result.content = content;
        }
        if let Some(details) = after_result.details
            && !details.is_null()
        {
            result.details = details;
        }
        if let Some(terminate) = after_result.terminate {
            result.terminate = Some(terminate);
        }
        if let Some(next_is_error) = after_result.is_error {
            is_error = next_is_error;
        }
    }

    (result, is_error)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn outcome(terminate: Option<bool>) -> FinalizedToolCallOutcome<Value> {
        FinalizedToolCallOutcome {
            tool_call_id: "call_1".to_string(),
            tool_name: "bash".to_string(),
            result: AgentToolResult {
                content: vec![ContentBlock::text("ok")],
                details: json!({ "code": 0 }),
                terminate,
            },
            is_error: false,
        }
    }

    #[test]
    fn terminate_batch_requires_nonempty_all_true_results() {
        assert!(!should_terminate_tool_batch::<Value>(&[]));
        assert!(should_terminate_tool_batch(&[
            outcome(Some(true)),
            outcome(Some(true))
        ]));
        assert!(!should_terminate_tool_batch(&[
            outcome(Some(true)),
            outcome(None)
        ]));
        assert!(!should_terminate_tool_batch(&[
            outcome(Some(true)),
            outcome(Some(false))
        ]));
    }

    #[test]
    fn creates_error_tool_result_like_typescript_helper() {
        let result = create_error_tool_result("blocked");

        assert_eq!(result.content, vec![ContentBlock::text("blocked")]);
        assert_eq!(result.details, json!({}));
        assert_eq!(result.terminate, None);
    }

    #[test]
    fn after_tool_call_result_overrides_fields_independently() {
        let original = AgentToolResult {
            content: vec![ContentBlock::text("original")],
            details: json!({ "before": true }),
            terminate: Some(true),
        };

        let (result, is_error) = apply_after_tool_call_result(
            original,
            true,
            Some(AfterToolCallResult {
                content: Some(vec![ContentBlock::text("override")]),
                details: Some(json!({ "after": true })),
                is_error: Some(false),
                terminate: Some(false),
            }),
        );

        assert_eq!(result.content, vec![ContentBlock::text("override")]);
        assert_eq!(result.details, json!({ "after": true }));
        assert_eq!(result.terminate, Some(false));
        assert!(!is_error);
    }

    #[test]
    fn after_tool_call_result_omitted_and_nullish_fields_fall_back() {
        let original = AgentToolResult {
            content: vec![ContentBlock::text("original")],
            details: json!({ "before": true }),
            terminate: Some(true),
        };

        let (result, is_error) = apply_after_tool_call_result(
            original.clone(),
            true,
            Some(AfterToolCallResult {
                content: None,
                details: Some(Value::Null),
                is_error: None,
                terminate: None,
            }),
        );

        assert_eq!(result, original);
        assert!(is_error);

        let (result, is_error) = apply_after_tool_call_result(original.clone(), false, None);
        assert_eq!(result, original);
        assert!(!is_error);
    }

    #[test]
    fn creates_tool_result_message_from_finalized_call() {
        let message = create_json_tool_result_message(outcome(Some(true)), 42);

        assert_eq!(message.tool_call_id, "call_1");
        assert_eq!(message.tool_name, "bash");
        assert_eq!(message.content, vec![ContentBlock::text("ok")]);
        assert_eq!(message.details, Some(json!({ "code": 0 })));
        assert!(!message.is_error);
        assert_eq!(message.timestamp, 42);
    }

    #[test]
    fn null_details_are_omitted_from_json_tool_result_message() {
        let finalized = FinalizedToolCallOutcome {
            result: AgentToolResult {
                content: vec![ContentBlock::text("ok")],
                details: Value::Null,
                terminate: None,
            },
            ..outcome(None)
        };

        let message = create_json_tool_result_message(finalized, 1);

        assert_eq!(message.details, None);
    }
}
