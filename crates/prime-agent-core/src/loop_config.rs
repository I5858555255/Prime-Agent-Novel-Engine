use prime_agent_ai::{Model, ModelThinkingLevel, ThinkingBudgets, Transport};
use serde::{Deserialize, Serialize};

use crate::{AgentContext, AgentTool, ToolExecutionMode};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLoopConfigSnapshot {
    pub model: Model,
    pub system_prompt: String,
    pub thinking_level: ModelThinkingLevel,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_budgets: Option<ThinkingBudgets>,
    pub transport: Transport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_retry_delay_ms: Option<u64>,
    pub tool_execution: ToolExecutionMode,
}

impl Default for AgentLoopConfigSnapshot {
    fn default() -> Self {
        Self {
            model: Model::default(),
            system_prompt: String::new(),
            thinking_level: ModelThinkingLevel::Off,
            thinking_budgets: None,
            transport: Transport::Auto,
            max_retry_delay_ms: None,
            tool_execution: ToolExecutionMode::Parallel,
        }
    }
}

impl AgentLoopConfigSnapshot {
    pub fn new(model: Model) -> Self {
        Self {
            model,
            ..Self::default()
        }
    }

    pub fn context(
        &self,
        messages: Vec<crate::AgentMessage>,
        tools: Vec<AgentTool>,
    ) -> AgentContext {
        AgentContext {
            system_prompt: self.system_prompt.clone(),
            messages,
            tools: (!tools.is_empty()).then_some(tools),
        }
    }

    pub fn with_system_prompt(mut self, system_prompt: impl Into<String>) -> Self {
        self.system_prompt = system_prompt.into();
        self
    }

    pub fn with_thinking_level(mut self, thinking_level: ModelThinkingLevel) -> Self {
        self.thinking_level = thinking_level;
        self
    }

    pub fn with_transport(mut self, transport: Transport) -> Self {
        self.transport = transport;
        self
    }

    pub fn with_tool_execution(mut self, tool_execution: ToolExecutionMode) -> Self {
        self.tool_execution = tool_execution;
        self
    }
}

#[cfg(test)]
mod tests {
    use prime_agent_ai::{ContentBlock, Message, UserMessage};
    use serde_json::json;

    use super::*;

    fn user_message(text: &str) -> Message {
        Message::User(UserMessage {
            content: text.into(),
            timestamp: 1,
        })
    }

    fn tool(name: &str) -> AgentTool {
        AgentTool {
            name: name.to_string(),
            description: format!("Run {name}"),
            parameters: json!({ "type": "object" }),
            label: name.to_string(),
            execution_mode: None,
        }
    }

    #[test]
    fn default_loop_config_snapshot_matches_agent_defaults() {
        let snapshot = AgentLoopConfigSnapshot::default();

        assert_eq!(snapshot.model, Model::default());
        assert_eq!(snapshot.system_prompt, "");
        assert_eq!(snapshot.thinking_level, ModelThinkingLevel::Off);
        assert_eq!(snapshot.thinking_budgets, None);
        assert_eq!(snapshot.transport, Transport::Auto);
        assert_eq!(snapshot.max_retry_delay_ms, None);
        assert_eq!(snapshot.tool_execution, ToolExecutionMode::Parallel);
    }

    #[test]
    fn loop_config_context_omits_empty_tools_like_typescript_optional_tools() {
        let snapshot = AgentLoopConfigSnapshot::new(Model::default()).with_system_prompt("system");
        let context = snapshot.context(vec![user_message("hello")], Vec::new());

        assert_eq!(context.system_prompt, "system");
        assert_eq!(context.messages.len(), 1);
        assert_eq!(context.tools, None);
    }

    #[test]
    fn loop_config_context_includes_nonempty_tools() {
        let snapshot = AgentLoopConfigSnapshot::default();
        let context = snapshot.context(vec![user_message("hello")], vec![tool("bash")]);

        assert_eq!(context.tools.as_ref().map(Vec::len), Some(1));
    }

    #[test]
    fn loop_config_snapshot_serializes_with_typescript_field_names() {
        let snapshot = AgentLoopConfigSnapshot::default()
            .with_system_prompt("system")
            .with_thinking_level(ModelThinkingLevel::High)
            .with_transport(Transport::WebsocketCached)
            .with_tool_execution(ToolExecutionMode::Sequential);

        let value = serde_json::to_value(snapshot).unwrap();

        assert_eq!(value["systemPrompt"], json!("system"));
        assert_eq!(value["thinkingLevel"], json!("high"));
        assert_eq!(value["transport"], json!("websocket-cached"));
        assert_eq!(value["toolExecution"], json!("sequential"));
        assert!(value.get("thinkingBudgets").is_none());
        assert!(value.get("maxRetryDelayMs").is_none());
    }

    #[test]
    fn loop_config_context_preserves_agent_messages() {
        let snapshot = AgentLoopConfigSnapshot::default();
        let message = Message::User(UserMessage {
            content: vec![ContentBlock::text("look")].into(),
            timestamp: 7,
        });

        let context = snapshot.context(vec![message.clone()], Vec::new());

        assert_eq!(context.messages, vec![message]);
    }
}
