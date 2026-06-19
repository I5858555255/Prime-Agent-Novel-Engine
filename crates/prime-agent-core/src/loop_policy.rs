use std::error::Error;
use std::fmt;

use prime_agent_ai::{ContentBlock, Message};

use crate::{AgentTool, ToolExecutionMode};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentLoopPolicyError {
    EmptyContinuationContext,
    AssistantContinuationContext,
}

impl fmt::Display for AgentLoopPolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyContinuationContext => {
                f.write_str("Cannot continue: no messages in context")
            }
            Self::AssistantContinuationContext => {
                f.write_str("Cannot continue from message role: assistant")
            }
        }
    }
}

impl Error for AgentLoopPolicyError {}

pub fn validate_continue_context(messages: &[Message]) -> Result<(), AgentLoopPolicyError> {
    match messages.last() {
        None => Err(AgentLoopPolicyError::EmptyContinuationContext),
        Some(Message::Assistant(_)) => Err(AgentLoopPolicyError::AssistantContinuationContext),
        Some(Message::User(_) | Message::ToolResult(_)) => Ok(()),
    }
}

pub fn tool_batch_requires_sequential_execution(
    default_mode: ToolExecutionMode,
    tool_calls: &[ContentBlock],
    tools: &[AgentTool],
) -> bool {
    default_mode == ToolExecutionMode::Sequential
        || tool_calls.iter().any(|tool_call| {
            let ContentBlock::ToolCall { name, .. } = tool_call else {
                return false;
            };
            tools.iter().any(|tool| {
                tool.name == *name && tool.execution_mode == Some(ToolExecutionMode::Sequential)
            })
        })
}

pub fn assistant_tool_calls(message: &Message) -> Vec<ContentBlock> {
    match message {
        Message::Assistant(assistant) => assistant
            .content
            .iter()
            .filter(|block| matches!(block, ContentBlock::ToolCall { .. }))
            .cloned()
            .collect(),
        Message::User(_) | Message::ToolResult(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use prime_agent_ai::{
        AssistantMessage, ContentBlock, StopReason, ToolResultMessage, Usage, UserMessage,
    };
    use serde_json::{Map, Value, json};

    use super::*;

    fn user_message() -> Message {
        Message::User(UserMessage {
            content: "next".into(),
            timestamp: 1,
        })
    }

    fn tool_result_message() -> Message {
        Message::ToolResult(ToolResultMessage {
            tool_call_id: "call_1".to_string(),
            tool_name: "bash".to_string(),
            content: vec![ContentBlock::text("ok")],
            details: None,
            is_error: false,
            timestamp: 2,
        })
    }

    fn assistant_message(content: Vec<ContentBlock>) -> Message {
        Message::Assistant(AssistantMessage {
            content,
            api: "unknown".to_string(),
            provider: "unknown".to_string(),
            model: "unknown".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage::default(),
            stop_reason: StopReason::Stop,
            error_message: None,
            timestamp: 3,
        })
    }

    fn tool(name: &str, execution_mode: Option<ToolExecutionMode>) -> AgentTool {
        AgentTool {
            name: name.to_string(),
            description: format!("Run {name}"),
            parameters: json!({ "type": "object" }),
            label: name.to_string(),
            execution_mode,
        }
    }

    fn tool_call(id: &str, name: &str) -> ContentBlock {
        ContentBlock::ToolCall {
            id: id.to_string(),
            name: name.to_string(),
            arguments: Map::<String, Value>::new(),
            thought_signature: None,
        }
    }

    #[test]
    fn continuation_requires_nonempty_non_assistant_last_message() {
        assert_eq!(
            validate_continue_context(&[]),
            Err(AgentLoopPolicyError::EmptyContinuationContext)
        );
        assert_eq!(
            validate_continue_context(&[assistant_message(Vec::new())]),
            Err(AgentLoopPolicyError::AssistantContinuationContext)
        );
        assert_eq!(validate_continue_context(&[user_message()]), Ok(()));
        assert_eq!(validate_continue_context(&[tool_result_message()]), Ok(()));
        assert_eq!(
            validate_continue_context(&[assistant_message(Vec::new()), user_message()]),
            Ok(())
        );
    }

    #[test]
    fn policy_error_messages_match_typescript_loop_guards() {
        assert_eq!(
            AgentLoopPolicyError::EmptyContinuationContext.to_string(),
            "Cannot continue: no messages in context"
        );
        assert_eq!(
            AgentLoopPolicyError::AssistantContinuationContext.to_string(),
            "Cannot continue from message role: assistant"
        );
    }

    #[test]
    fn sequential_mode_or_per_tool_override_forces_sequential_batch() {
        let calls = vec![tool_call("call_1", "bash"), tool_call("call_2", "read")];
        let tools = vec![
            tool("bash", Some(ToolExecutionMode::Parallel)),
            tool("read", Some(ToolExecutionMode::Sequential)),
        ];

        assert!(tool_batch_requires_sequential_execution(
            ToolExecutionMode::Sequential,
            &calls,
            &[]
        ));
        assert!(tool_batch_requires_sequential_execution(
            ToolExecutionMode::Parallel,
            &calls,
            &tools
        ));
        assert!(!tool_batch_requires_sequential_execution(
            ToolExecutionMode::Parallel,
            &calls,
            &[tool("bash", Some(ToolExecutionMode::Parallel))]
        ));
        assert!(!tool_batch_requires_sequential_execution(
            ToolExecutionMode::Parallel,
            &[ContentBlock::text("not a tool")],
            &tools
        ));
    }

    #[test]
    fn assistant_tool_calls_extracts_only_tool_call_blocks() {
        let message = assistant_message(vec![
            ContentBlock::text("I will inspect"),
            tool_call("call_1", "read"),
            ContentBlock::text("done"),
            tool_call("call_2", "bash"),
        ]);

        let calls = assistant_tool_calls(&message);

        assert_eq!(
            calls,
            vec![tool_call("call_1", "read"), tool_call("call_2", "bash")]
        );
        assert!(assistant_tool_calls(&user_message()).is_empty());
    }
}
