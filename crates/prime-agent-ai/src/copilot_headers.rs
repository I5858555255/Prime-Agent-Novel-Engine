use crate::types::{ContentBlock, Message, UserContent};
use std::collections::BTreeMap;

pub fn infer_copilot_initiator(messages: &[Message]) -> &'static str {
    match messages.last() {
        Some(Message::User(_)) | None => "user",
        Some(Message::Assistant(_) | Message::ToolResult(_)) => "agent",
    }
}

pub fn has_copilot_vision_input(messages: &[Message]) -> bool {
    messages.iter().any(|message| match message {
        Message::User(user) => match &user.content {
            UserContent::Blocks(blocks) => blocks.iter().any(is_image_block),
            UserContent::Text(_) => false,
        },
        Message::ToolResult(tool_result) => tool_result.content.iter().any(is_image_block),
        Message::Assistant(_) => false,
    })
}

pub fn build_copilot_dynamic_headers(
    messages: &[Message],
    has_images: bool,
) -> BTreeMap<String, String> {
    let mut headers = BTreeMap::from([
        (
            "X-Initiator".to_string(),
            infer_copilot_initiator(messages).to_string(),
        ),
        (
            "Openai-Intent".to_string(),
            "conversation-edits".to_string(),
        ),
    ]);

    if has_images {
        headers.insert("Copilot-Vision-Request".to_string(), "true".to_string());
    }

    headers
}

fn is_image_block(block: &ContentBlock) -> bool {
    matches!(block, ContentBlock::Image { .. })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AssistantMessage, Cost, StopReason, ToolResultMessage, Usage, UserMessage};

    fn user(content: UserContent) -> Message {
        Message::User(UserMessage {
            content,
            timestamp: 1,
        })
    }

    fn assistant() -> Message {
        Message::Assistant(AssistantMessage {
            content: vec![ContentBlock::text("ok")],
            api: "test".to_string(),
            provider: "test".to_string(),
            model: "test".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage {
                cost: Cost::default(),
                ..Usage::default()
            },
            stop_reason: StopReason::Stop,
            error_message: None,
            timestamp: 2,
        })
    }

    fn tool_result(content: Vec<ContentBlock>) -> Message {
        Message::ToolResult(ToolResultMessage {
            tool_call_id: "call".to_string(),
            tool_name: "tool".to_string(),
            content,
            details: None,
            is_error: false,
            timestamp: 3,
        })
    }

    #[test]
    fn infers_user_initiator_for_empty_or_user_last_message() {
        assert_eq!(infer_copilot_initiator(&[]), "user");
        assert_eq!(
            infer_copilot_initiator(&[user(UserContent::from("hello"))]),
            "user"
        );
    }

    #[test]
    fn infers_agent_initiator_for_non_user_last_message() {
        assert_eq!(infer_copilot_initiator(&[assistant()]), "agent");
        assert_eq!(
            infer_copilot_initiator(&[user(UserContent::from("hello")), assistant()]),
            "agent"
        );
    }

    #[test]
    fn detects_images_in_user_and_tool_result_content() {
        let image = ContentBlock::image("base64", "image/png");

        assert!(has_copilot_vision_input(&[user(UserContent::Blocks(
            vec![image.clone()]
        ))]));
        assert!(has_copilot_vision_input(&[tool_result(vec![image])]));
        assert!(!has_copilot_vision_input(&[user(UserContent::from(
            "text"
        ))]));
        assert!(!has_copilot_vision_input(&[assistant()]));
    }

    #[test]
    fn builds_required_dynamic_headers() {
        let headers = build_copilot_dynamic_headers(&[assistant()], true);

        assert_eq!(headers["X-Initiator"], "agent");
        assert_eq!(headers["Openai-Intent"], "conversation-edits");
        assert_eq!(headers["Copilot-Vision-Request"], "true");

        let headers = build_copilot_dynamic_headers(&[], false);
        assert_eq!(headers["X-Initiator"], "user");
        assert!(!headers.contains_key("Copilot-Vision-Request"));
    }
}
