use std::collections::BTreeSet;

use prime_agent_ai::{ContentBlock, Message, Model, ModelThinkingLevel, Tool};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolExecutionMode {
    Sequential,
    Parallel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTool {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<ToolExecutionMode>,
}

impl From<AgentTool> for Tool {
    fn from(tool: AgentTool) -> Self {
        Self {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentState {
    pub system_prompt: String,
    pub model: Model,
    pub thinking_level: ModelThinkingLevel,
    pub tools: Vec<AgentTool>,
    pub messages: Vec<Message>,
    pub is_streaming: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streaming_message: Option<Message>,
    pub pending_tool_calls: BTreeSet<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

impl AgentState {
    pub fn new(system_prompt: impl Into<String>, model: Model) -> Self {
        Self {
            system_prompt: system_prompt.into(),
            model,
            thinking_level: ModelThinkingLevel::Off,
            tools: Vec::new(),
            messages: Vec::new(),
            is_streaming: false,
            streaming_message: None,
            pending_tool_calls: BTreeSet::new(),
            error_message: None,
        }
    }

    pub fn with_message(mut self, message: Message) -> Self {
        self.messages.push(message);
        self
    }

    pub fn set_tools(&mut self, tools: Vec<AgentTool>) {
        self.tools = tools;
    }

    pub fn set_messages(&mut self, messages: Vec<Message>) {
        self.messages = messages;
    }

    pub fn start_streaming(&mut self, message: Option<Message>) {
        self.is_streaming = true;
        self.streaming_message = message;
        self.error_message = None;
    }

    pub fn finish_streaming(&mut self) {
        self.is_streaming = false;
        self.streaming_message = None;
        self.pending_tool_calls.clear();
    }

    pub fn fail_streaming(&mut self, error_message: impl Into<String>) {
        self.is_streaming = false;
        self.streaming_message = None;
        self.pending_tool_calls.clear();
        self.error_message = Some(error_message.into());
    }

    pub fn mark_tool_pending(&mut self, tool_call_id: impl Into<String>) {
        self.pending_tool_calls.insert(tool_call_id.into());
    }

    pub fn mark_tool_done(&mut self, tool_call_id: &str) {
        self.pending_tool_calls.remove(tool_call_id);
    }
}

impl Default for AgentState {
    fn default() -> Self {
        Self::new("", Model::default())
    }
}

pub fn text_user_message(text: impl Into<String>, timestamp: i64) -> Message {
    Message::User(prime_agent_ai::UserMessage {
        content: text.into().into(),
        timestamp,
    })
}

pub fn text_tool_result(
    tool_call_id: impl Into<String>,
    tool_name: impl Into<String>,
    text: impl Into<String>,
    is_error: bool,
    timestamp: i64,
) -> Message {
    Message::ToolResult(prime_agent_ai::ToolResultMessage {
        tool_call_id: tool_call_id.into(),
        tool_name: tool_name.into(),
        content: vec![ContentBlock::text(text)],
        details: None,
        is_error,
        timestamp,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_state_matches_typescript_initial_state_defaults() {
        let state = AgentState::default();

        assert_eq!(state.system_prompt, "");
        assert_eq!(state.model, Model::default());
        assert_eq!(state.thinking_level, ModelThinkingLevel::Off);
        assert!(state.tools.is_empty());
        assert!(state.messages.is_empty());
        assert!(!state.is_streaming);
        assert!(state.streaming_message.is_none());
        assert!(state.pending_tool_calls.is_empty());
        assert!(state.error_message.is_none());
    }

    #[test]
    fn streaming_lifecycle_tracks_partial_message_and_pending_tools() {
        let mut state = AgentState::default();
        let message = text_user_message("hello", 10);

        state.start_streaming(Some(message.clone()));
        state.mark_tool_pending("call_1");

        assert!(state.is_streaming);
        assert_eq!(state.streaming_message, Some(message));
        assert!(state.pending_tool_calls.contains("call_1"));

        state.mark_tool_done("call_1");
        state.finish_streaming();

        assert!(!state.is_streaming);
        assert!(state.streaming_message.is_none());
        assert!(state.pending_tool_calls.is_empty());
    }

    #[test]
    fn fail_streaming_clears_runtime_state_and_records_error() {
        let mut state = AgentState::default();
        state.start_streaming(None);
        state.mark_tool_pending("call_1");

        state.fail_streaming("aborted");

        assert!(!state.is_streaming);
        assert!(state.streaming_message.is_none());
        assert!(state.pending_tool_calls.is_empty());
        assert_eq!(state.error_message.as_deref(), Some("aborted"));
    }

    #[test]
    fn agent_tool_serializes_with_camel_case_execution_mode() {
        let tool = AgentTool {
            name: "bash".to_string(),
            description: "Run a command".to_string(),
            parameters: json!({ "type": "object" }),
            label: "Bash".to_string(),
            execution_mode: Some(ToolExecutionMode::Parallel),
        };

        let value = serde_json::to_value(tool).unwrap();
        assert_eq!(
            value,
            json!({
                "name": "bash",
                "description": "Run a command",
                "parameters": { "type": "object" },
                "label": "Bash",
                "executionMode": "parallel"
            })
        );
    }
}
