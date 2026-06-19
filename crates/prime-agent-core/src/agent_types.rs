use prime_agent_ai::{
    AssistantMessage, AssistantMessageEvent, ContentBlock, Message, ToolResultMessage,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::AgentTool;

pub type AgentMessage = Message;
pub type AgentToolCall = ContentBlock;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeforeToolCallResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolResult<T = Value> {
    pub content: Vec<ContentBlock>,
    pub details: T,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminate: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AfterToolCallResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<Vec<ContentBlock>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminate: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContext {
    pub system_prompt: String,
    pub messages: Vec<AgentMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<AgentTool>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeforeToolCallContext {
    pub assistant_message: AssistantMessage,
    pub tool_call: AgentToolCall,
    pub args: Value,
    pub context: AgentContext,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AfterToolCallContext {
    pub assistant_message: AssistantMessage,
    pub tool_call: AgentToolCall,
    pub args: Value,
    pub result: AgentToolResult<Value>,
    pub is_error: bool,
    pub context: AgentContext,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShouldStopAfterTurnContext {
    pub message: AssistantMessage,
    pub tool_results: Vec<ToolResultMessage>,
    pub context: AgentContext,
    pub new_messages: Vec<AgentMessage>,
}

pub type GetContinuationMessagesContext = ShouldStopAfterTurnContext;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    AgentStart,
    AgentEnd {
        messages: Vec<AgentMessage>,
    },
    TurnStart,
    TurnEnd {
        message: AgentMessage,
        tool_results: Vec<ToolResultMessage>,
    },
    MessageStart {
        message: AgentMessage,
    },
    MessageUpdate {
        message: AgentMessage,
        assistant_message_event: Box<AssistantMessageEvent>,
    },
    MessageEnd {
        message: AgentMessage,
    },
    ToolExecutionStart {
        tool_call_id: String,
        tool_name: String,
        args: Value,
    },
    ToolExecutionUpdate {
        tool_call_id: String,
        tool_name: String,
        args: Value,
        partial_result: AgentToolResult<Value>,
    },
    ToolExecutionEnd {
        tool_call_id: String,
        tool_name: String,
        result: AgentToolResult<Value>,
        is_error: bool,
    },
}

pub fn is_tool_call(block: &AgentToolCall) -> bool {
    matches!(block, ContentBlock::ToolCall { .. })
}

#[cfg(test)]
mod tests {
    use prime_agent_ai::{StopReason, Usage};
    use serde_json::json;

    use super::*;

    fn assistant_message() -> AssistantMessage {
        AssistantMessage {
            content: vec![ContentBlock::text("done")],
            api: "openai-responses".to_string(),
            provider: "openai".to_string(),
            model: "gpt-5.5".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage::default(),
            stop_reason: StopReason::Stop,
            error_message: None,
            timestamp: 42,
        }
    }

    fn user_message() -> AgentMessage {
        Message::User(prime_agent_ai::UserMessage {
            content: "hello".into(),
            timestamp: 7,
        })
    }

    #[test]
    fn before_tool_call_result_serializes_optional_fields_like_typescript_shape() {
        let result = BeforeToolCallResult {
            block: Some(true),
            reason: Some("blocked".to_string()),
        };

        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({
                "block": true,
                "reason": "blocked"
            })
        );
        assert_eq!(
            serde_json::to_value(BeforeToolCallResult::default()).unwrap(),
            json!({})
        );
    }

    #[test]
    fn after_tool_call_result_serializes_override_fields_with_camel_case() {
        let result = AfterToolCallResult {
            content: Some(vec![ContentBlock::text("override")]),
            details: Some(json!({ "exitCode": 1 })),
            is_error: Some(true),
            terminate: Some(false),
        };

        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({
                "content": [{ "type": "text", "text": "override" }],
                "details": { "exitCode": 1 },
                "isError": true,
                "terminate": false
            })
        );
    }

    #[test]
    fn agent_context_serializes_prompt_messages_and_optional_tools() {
        let context = AgentContext {
            system_prompt: "You are terse.".to_string(),
            messages: vec![user_message()],
            tools: None,
        };

        assert_eq!(
            serde_json::to_value(context).unwrap(),
            json!({
                "systemPrompt": "You are terse.",
                "messages": [{
                    "role": "user",
                    "content": "hello",
                    "timestamp": 7
                }]
            })
        );
    }

    #[test]
    fn agent_events_match_typescript_discriminants_and_field_names() {
        let event = AgentEvent::ToolExecutionEnd {
            tool_call_id: "call_1".to_string(),
            tool_name: "bash".to_string(),
            result: AgentToolResult {
                content: vec![ContentBlock::text("ok")],
                details: json!({ "code": 0 }),
                terminate: Some(true),
            },
            is_error: false,
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({
                "type": "tool_execution_end",
                "toolCallId": "call_1",
                "toolName": "bash",
                "result": {
                    "content": [{ "type": "text", "text": "ok" }],
                    "details": { "code": 0 },
                    "terminate": true
                },
                "isError": false
            })
        );
    }

    #[test]
    fn turn_end_event_carries_tool_results_and_agent_messages() {
        let tool_result = ToolResultMessage {
            tool_call_id: "call_1".to_string(),
            tool_name: "bash".to_string(),
            content: vec![ContentBlock::text("done")],
            details: None,
            is_error: false,
            timestamp: 99,
        };
        let event = AgentEvent::TurnEnd {
            message: Message::Assistant(assistant_message()),
            tool_results: vec![tool_result],
        };

        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["type"], "turn_end");
        assert_eq!(value["toolResults"][0]["toolCallId"], "call_1");
        assert_eq!(value["message"]["role"], "assistant");
    }

    #[test]
    fn detects_tool_call_content_blocks() {
        let tool_call = ContentBlock::ToolCall {
            id: "call_1".to_string(),
            name: "bash".to_string(),
            arguments: serde_json::Map::new(),
            thought_signature: None,
        };

        assert!(is_tool_call(&tool_call));
        assert!(!is_tool_call(&ContentBlock::text("not a tool")));
    }
}
