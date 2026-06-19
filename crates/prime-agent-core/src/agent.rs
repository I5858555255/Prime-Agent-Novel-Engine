use std::error::Error;
use std::fmt;

use prime_agent_ai::{ContentBlock, Message, Model, ThinkingBudgets, Transport, UserMessage};

use crate::{AgentEvent, AgentState, PendingMessageQueue, QueueMode, ToolExecutionMode};

#[derive(Debug, Clone, PartialEq)]
pub struct AgentOptions {
    pub initial_state: Option<AgentState>,
    pub steering_mode: QueueMode,
    pub follow_up_mode: QueueMode,
    pub session_id: Option<String>,
    pub thinking_budgets: Option<ThinkingBudgets>,
    pub transport: Transport,
    pub max_retry_delay_ms: Option<u64>,
    pub tool_execution: ToolExecutionMode,
}

impl Default for AgentOptions {
    fn default() -> Self {
        Self {
            initial_state: None,
            steering_mode: QueueMode::OneAtATime,
            follow_up_mode: QueueMode::OneAtATime,
            session_id: None,
            thinking_budgets: None,
            transport: Transport::Auto,
            max_retry_delay_ms: None,
            tool_execution: ToolExecutionMode::Parallel,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentError {
    ListenerOutsideActiveRun,
}

impl fmt::Display for AgentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ListenerOutsideActiveRun => {
                f.write_str("Agent listener invoked outside active run")
            }
        }
    }
}

impl Error for AgentError {}

#[derive(Debug, Clone, PartialEq)]
pub struct Agent {
    state: AgentState,
    steering_queue: PendingMessageQueue<Message>,
    follow_up_queue: PendingMessageQueue<Message>,
    pub session_id: Option<String>,
    pub thinking_budgets: Option<ThinkingBudgets>,
    pub transport: Transport,
    pub max_retry_delay_ms: Option<u64>,
    pub tool_execution: ToolExecutionMode,
}

impl Default for Agent {
    fn default() -> Self {
        Self::new(AgentOptions::default())
    }
}

impl Agent {
    pub fn new(options: AgentOptions) -> Self {
        Self {
            state: options.initial_state.unwrap_or_default(),
            steering_queue: PendingMessageQueue::new(options.steering_mode),
            follow_up_queue: PendingMessageQueue::new(options.follow_up_mode),
            session_id: options.session_id,
            thinking_budgets: options.thinking_budgets,
            transport: options.transport,
            max_retry_delay_ms: options.max_retry_delay_ms,
            tool_execution: options.tool_execution,
        }
    }

    pub fn state(&self) -> &AgentState {
        &self.state
    }

    pub fn state_mut(&mut self) -> &mut AgentState {
        &mut self.state
    }

    pub fn steering_mode(&self) -> QueueMode {
        self.steering_queue.mode()
    }

    pub fn set_steering_mode(&mut self, mode: QueueMode) {
        self.steering_queue.set_mode(mode);
    }

    pub fn follow_up_mode(&self) -> QueueMode {
        self.follow_up_queue.mode()
    }

    pub fn set_follow_up_mode(&mut self, mode: QueueMode) {
        self.follow_up_queue.set_mode(mode);
    }

    pub fn steer(&mut self, message: Message) {
        self.steering_queue.enqueue(message);
    }

    pub fn follow_up(&mut self, message: Message) {
        self.follow_up_queue.enqueue(message);
    }

    pub fn drain_steering_messages(&mut self) -> Vec<Message> {
        self.steering_queue.drain()
    }

    pub fn drain_follow_up_messages(&mut self) -> Vec<Message> {
        self.follow_up_queue.drain()
    }

    pub fn clear_steering_queue(&mut self) {
        self.steering_queue.clear();
    }

    pub fn clear_follow_up_queue(&mut self) {
        self.follow_up_queue.clear();
    }

    pub fn clear_all_queues(&mut self) {
        self.clear_steering_queue();
        self.clear_follow_up_queue();
    }

    pub fn remove_queued_messages<F>(&mut self, mut predicate: F) -> Vec<Message>
    where
        F: FnMut(&Message) -> bool,
    {
        let mut removed = self
            .steering_queue
            .remove_where(|message| predicate(message));
        removed.extend(
            self.follow_up_queue
                .remove_where(|message| predicate(message)),
        );
        removed
    }

    pub fn has_queued_messages(&self) -> bool {
        self.steering_queue.has_items() || self.follow_up_queue.has_items()
    }

    pub fn reset(&mut self) {
        self.state.messages.clear();
        self.state.is_streaming = false;
        self.state.streaming_message = None;
        self.state.pending_tool_calls.clear();
        self.state.error_message = None;
        self.clear_all_queues();
    }

    pub fn begin_run(&mut self) {
        self.state.is_streaming = true;
        self.state.streaming_message = None;
        self.state.error_message = None;
    }

    pub fn finish_run(&mut self) {
        self.state.finish_streaming();
    }

    pub fn process_event(&mut self, event: &AgentEvent) {
        match event {
            AgentEvent::MessageStart { message } | AgentEvent::MessageUpdate { message, .. } => {
                self.state.streaming_message = Some(message.clone());
            }
            AgentEvent::MessageEnd { message } => {
                self.state.streaming_message = None;
                self.state.messages.push(message.clone());
            }
            AgentEvent::ToolExecutionStart { tool_call_id, .. } => {
                self.state.mark_tool_pending(tool_call_id.clone());
            }
            AgentEvent::ToolExecutionEnd { tool_call_id, .. } => {
                self.state.mark_tool_done(tool_call_id);
            }
            AgentEvent::TurnEnd { message, .. } => {
                if let Message::Assistant(message) = message
                    && let Some(error_message) = &message.error_message
                {
                    self.state.error_message = Some(error_message.clone());
                }
            }
            AgentEvent::AgentEnd { .. } => {
                self.state.streaming_message = None;
            }
            AgentEvent::AgentStart
            | AgentEvent::TurnStart
            | AgentEvent::ToolExecutionUpdate { .. } => {}
        }
    }
}

pub fn default_convert_to_llm(messages: &[Message]) -> Vec<Message> {
    messages.to_vec()
}

pub fn normalize_text_prompt(
    text: impl Into<String>,
    images: impl IntoIterator<Item = ContentBlock>,
    timestamp: i64,
) -> Message {
    let mut content = vec![ContentBlock::text(text)];
    content.extend(images);
    Message::User(UserMessage {
        content: content.into(),
        timestamp,
    })
}

pub fn default_agent_model() -> Model {
    Model::default()
}

#[cfg(test)]
mod tests {
    use prime_agent_ai::{AssistantMessage, StopReason, Usage};

    use super::*;
    use crate::state::text_user_message;

    fn assistant_error(message: &str) -> Message {
        Message::Assistant(AssistantMessage {
            content: vec![ContentBlock::text("")],
            api: "unknown".to_string(),
            provider: "unknown".to_string(),
            model: "unknown".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage::default(),
            stop_reason: StopReason::Error,
            error_message: Some(message.to_string()),
            timestamp: 1,
        })
    }

    #[test]
    fn agent_defaults_match_typescript_constructor_defaults() {
        let agent = Agent::default();

        assert_eq!(agent.state(), &AgentState::default());
        assert_eq!(agent.steering_mode(), QueueMode::OneAtATime);
        assert_eq!(agent.follow_up_mode(), QueueMode::OneAtATime);
        assert_eq!(agent.transport, Transport::Auto);
        assert_eq!(agent.tool_execution, ToolExecutionMode::Parallel);
        assert!(agent.session_id.is_none());
    }

    #[test]
    fn agent_queues_steering_and_follow_up_messages_by_mode() {
        let mut agent = Agent::new(AgentOptions {
            steering_mode: QueueMode::All,
            ..AgentOptions::default()
        });

        agent.steer(text_user_message("a", 1));
        agent.steer(text_user_message("b", 2));
        agent.follow_up(text_user_message("c", 3));
        agent.follow_up(text_user_message("d", 4));

        assert!(agent.has_queued_messages());
        assert_eq!(agent.drain_steering_messages().len(), 2);
        assert_eq!(agent.drain_follow_up_messages().len(), 1);
        assert_eq!(agent.drain_follow_up_messages().len(), 1);
        assert!(!agent.has_queued_messages());
    }

    #[test]
    fn remove_queued_messages_checks_both_queues_in_order() {
        let mut agent = Agent::default();
        agent.steer(text_user_message("keep", 1));
        agent.steer(text_user_message("remove steering", 2));
        agent.follow_up(text_user_message("remove follow", 3));

        let removed = agent.remove_queued_messages(|message| match message {
            Message::User(user) => match &user.content {
                prime_agent_ai::UserContent::Text(text) => text.contains("remove"),
                prime_agent_ai::UserContent::Blocks(_) => false,
            },
            _ => false,
        });

        assert_eq!(removed.len(), 2);
        assert_eq!(agent.drain_steering_messages().len(), 1);
        assert!(agent.drain_follow_up_messages().is_empty());
    }

    #[test]
    fn reset_clears_transcript_runtime_state_and_queues() {
        let mut agent = Agent::default();
        agent
            .state_mut()
            .messages
            .push(text_user_message("hello", 1));
        agent.begin_run();
        agent.state_mut().mark_tool_pending("call_1".to_string());
        agent.steer(text_user_message("queued", 2));

        agent.reset();

        assert!(agent.state().messages.is_empty());
        assert!(!agent.state().is_streaming);
        assert!(agent.state().pending_tool_calls.is_empty());
        assert!(!agent.has_queued_messages());
    }

    #[test]
    fn process_event_reduces_runtime_state_like_typescript_agent() {
        let mut agent = Agent::default();
        let user = text_user_message("hello", 1);

        agent.process_event(&AgentEvent::MessageStart {
            message: user.clone(),
        });
        assert_eq!(agent.state().streaming_message, Some(user.clone()));

        agent.process_event(&AgentEvent::ToolExecutionStart {
            tool_call_id: "call_1".to_string(),
            tool_name: "bash".to_string(),
            args: serde_json::Value::Null,
        });
        assert!(agent.state().pending_tool_calls.contains("call_1"));

        agent.process_event(&AgentEvent::ToolExecutionEnd {
            tool_call_id: "call_1".to_string(),
            tool_name: "bash".to_string(),
            result: crate::AgentToolResult {
                content: vec![ContentBlock::text("ok")],
                details: serde_json::Value::Null,
                terminate: None,
            },
            is_error: false,
        });
        assert!(agent.state().pending_tool_calls.is_empty());

        agent.process_event(&AgentEvent::MessageEnd {
            message: user.clone(),
        });
        assert_eq!(agent.state().messages, vec![user]);

        agent.process_event(&AgentEvent::TurnEnd {
            message: assistant_error("failed"),
            tool_results: Vec::new(),
        });
        assert_eq!(agent.state().error_message.as_deref(), Some("failed"));
    }

    #[test]
    fn normalize_text_prompt_returns_user_blocks_with_images() {
        let message =
            normalize_text_prompt("look", [ContentBlock::image("base64", "image/png")], 42);

        let Message::User(user) = message else {
            panic!("expected user message");
        };
        assert_eq!(user.timestamp, 42);
        let prime_agent_ai::UserContent::Blocks(blocks) = user.content else {
            panic!("expected block content");
        };
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0], ContentBlock::text("look"));
        assert_eq!(blocks[1], ContentBlock::image("base64", "image/png"));
    }

    #[test]
    fn default_convert_to_llm_passes_standard_messages_through() {
        let messages = vec![text_user_message("hello", 1)];

        assert_eq!(default_convert_to_llm(&messages), messages);
    }
}
