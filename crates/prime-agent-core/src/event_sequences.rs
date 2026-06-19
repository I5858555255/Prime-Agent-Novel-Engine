use prime_agent_ai::ToolResultMessage;

use crate::{AgentEvent, AgentMessage};

pub fn run_start_events(prompts: &[AgentMessage]) -> Vec<AgentEvent> {
    let mut events = Vec::with_capacity(2 + prompts.len().saturating_mul(2));
    events.push(AgentEvent::AgentStart);
    events.push(AgentEvent::TurnStart);
    for prompt in prompts {
        events.extend(message_lifecycle_events(prompt));
    }
    events
}

pub fn message_lifecycle_events(message: &AgentMessage) -> [AgentEvent; 2] {
    [
        AgentEvent::MessageStart {
            message: message.clone(),
        },
        AgentEvent::MessageEnd {
            message: message.clone(),
        },
    ]
}

pub fn tool_result_message_events(message: &ToolResultMessage) -> [AgentEvent; 2] {
    let message = AgentMessage::ToolResult(message.clone());
    message_lifecycle_events(&message)
}

pub fn agent_end_event(messages: Vec<AgentMessage>) -> AgentEvent {
    AgentEvent::AgentEnd { messages }
}

#[cfg(test)]
mod tests {
    use prime_agent_ai::{ContentBlock, ToolResultMessage};

    use super::*;
    use crate::state::text_user_message;

    fn tool_result() -> ToolResultMessage {
        ToolResultMessage {
            tool_call_id: "call_1".to_string(),
            tool_name: "bash".to_string(),
            content: vec![ContentBlock::text("ok")],
            details: None,
            is_error: false,
            timestamp: 2,
        }
    }

    #[test]
    fn run_start_events_match_typescript_prompt_lifecycle_order() {
        let prompt_a = text_user_message("a", 1);
        let prompt_b = text_user_message("b", 2);

        let events = run_start_events(&[prompt_a.clone(), prompt_b.clone()]);

        assert_eq!(
            events,
            vec![
                AgentEvent::AgentStart,
                AgentEvent::TurnStart,
                AgentEvent::MessageStart {
                    message: prompt_a.clone()
                },
                AgentEvent::MessageEnd { message: prompt_a },
                AgentEvent::MessageStart {
                    message: prompt_b.clone()
                },
                AgentEvent::MessageEnd { message: prompt_b },
            ]
        );
    }

    #[test]
    fn message_lifecycle_events_wrap_a_single_message() {
        let message = text_user_message("hello", 1);

        assert_eq!(
            message_lifecycle_events(&message),
            [
                AgentEvent::MessageStart {
                    message: message.clone()
                },
                AgentEvent::MessageEnd { message },
            ]
        );
    }

    #[test]
    fn tool_result_message_events_wrap_tool_result_as_agent_message() {
        let result = tool_result();
        let message = AgentMessage::ToolResult(result.clone());

        assert_eq!(
            tool_result_message_events(&result),
            [
                AgentEvent::MessageStart {
                    message: message.clone()
                },
                AgentEvent::MessageEnd { message },
            ]
        );
    }

    #[test]
    fn agent_end_event_carries_final_messages() {
        let messages = vec![text_user_message("done", 1)];

        assert_eq!(
            agent_end_event(messages.clone()),
            AgentEvent::AgentEnd { messages }
        );
    }
}
