use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::types::{
    AssistantMessage, ContentBlock, Message, Model, ModelInput, StopReason, ToolResultMessage,
    UserContent,
};

pub const NON_VISION_USER_IMAGE_PLACEHOLDER: &str =
    "(image omitted: model does not support images)";
pub const NON_VISION_TOOL_IMAGE_PLACEHOLDER: &str =
    "(tool image omitted: model does not support images)";

const SYNTHETIC_TOOL_RESULT_TEXT: &str = "No result provided";

pub fn transform_messages(messages: &[Message], model: &Model) -> Vec<Message> {
    transform_messages_impl::<fn(&str, &Model, &AssistantMessage) -> String>(messages, model, None)
}

pub fn transform_messages_with_tool_call_id_normalizer<F>(
    messages: &[Message],
    model: &Model,
    normalize_tool_call_id: F,
) -> Vec<Message>
where
    F: FnMut(&str, &Model, &AssistantMessage) -> String,
{
    transform_messages_impl(messages, model, Some(normalize_tool_call_id))
}

fn transform_messages_impl<F>(
    messages: &[Message],
    model: &Model,
    mut normalize_tool_call_id: Option<F>,
) -> Vec<Message>
where
    F: FnMut(&str, &Model, &AssistantMessage) -> String,
{
    let mut tool_call_id_map: HashMap<String, String> = HashMap::new();
    let image_aware_messages = downgrade_unsupported_images(messages, model);
    let mut transformed = Vec::with_capacity(image_aware_messages.len());

    for message in image_aware_messages {
        match message {
            Message::User(_) => transformed.push(message),
            Message::ToolResult(mut tool_result) => {
                if let Some(normalized_id) = tool_call_id_map.get(&tool_result.tool_call_id)
                    && normalized_id != &tool_result.tool_call_id
                {
                    tool_result.tool_call_id = normalized_id.clone();
                }
                transformed.push(Message::ToolResult(tool_result));
            }
            Message::Assistant(mut assistant) => {
                let source = assistant.clone();
                let same_model = is_same_model(&source, model);
                assistant.content = assistant
                    .content
                    .into_iter()
                    .filter_map(|block| {
                        transform_assistant_block(
                            block,
                            same_model,
                            model,
                            &source,
                            &mut normalize_tool_call_id,
                            &mut tool_call_id_map,
                        )
                    })
                    .collect();
                transformed.push(Message::Assistant(assistant));
            }
        }
    }

    insert_synthetic_orphan_tool_results(transformed)
}

fn downgrade_unsupported_images(messages: &[Message], model: &Model) -> Vec<Message> {
    if model.input.contains(&ModelInput::Image) {
        return messages.to_vec();
    }

    messages
        .iter()
        .cloned()
        .map(|message| match message {
            Message::User(mut user) => {
                user.content = match user.content {
                    UserContent::Text(text) => UserContent::Text(text),
                    UserContent::Blocks(blocks) => UserContent::Blocks(
                        replace_images_with_placeholder(blocks, NON_VISION_USER_IMAGE_PLACEHOLDER),
                    ),
                };
                Message::User(user)
            }
            Message::ToolResult(mut tool_result) => {
                tool_result.content = replace_images_with_placeholder(
                    tool_result.content,
                    NON_VISION_TOOL_IMAGE_PLACEHOLDER,
                );
                Message::ToolResult(tool_result)
            }
            Message::Assistant(assistant) => Message::Assistant(assistant),
        })
        .collect()
}

fn replace_images_with_placeholder(
    content: Vec<ContentBlock>,
    placeholder: &str,
) -> Vec<ContentBlock> {
    let mut result = Vec::with_capacity(content.len());
    let mut previous_was_placeholder = false;

    for block in content {
        match block {
            ContentBlock::Image { .. } => {
                if !previous_was_placeholder {
                    result.push(ContentBlock::text(placeholder));
                }
                previous_was_placeholder = true;
            }
            ContentBlock::Text {
                text,
                text_signature,
            } => {
                previous_was_placeholder = text == placeholder;
                result.push(ContentBlock::Text {
                    text,
                    text_signature,
                });
            }
            block => {
                previous_was_placeholder = false;
                result.push(block);
            }
        }
    }

    result
}

fn transform_assistant_block<F>(
    block: ContentBlock,
    same_model: bool,
    model: &Model,
    source: &AssistantMessage,
    normalize_tool_call_id: &mut Option<F>,
    tool_call_id_map: &mut HashMap<String, String>,
) -> Option<ContentBlock>
where
    F: FnMut(&str, &Model, &AssistantMessage) -> String,
{
    match block {
        ContentBlock::Thinking {
            thinking,
            thinking_signature,
            redacted,
        } => transform_thinking_block(thinking, thinking_signature, redacted, same_model),
        ContentBlock::Text {
            text,
            text_signature,
        } => {
            if same_model {
                Some(ContentBlock::Text {
                    text,
                    text_signature,
                })
            } else {
                Some(ContentBlock::Text {
                    text,
                    text_signature: None,
                })
            }
        }
        ContentBlock::ToolCall {
            id,
            name,
            arguments,
            thought_signature,
        } => {
            let original_id = id;
            let mut id = original_id.clone();
            let mut thought_signature = thought_signature;

            if !same_model {
                thought_signature = None;

                if let Some(normalizer) = normalize_tool_call_id.as_mut() {
                    let normalized_id = normalizer(&original_id, model, source);
                    if normalized_id != original_id {
                        tool_call_id_map.insert(original_id, normalized_id.clone());
                        id = normalized_id;
                    }
                }
            }

            Some(ContentBlock::ToolCall {
                id,
                name,
                arguments,
                thought_signature,
            })
        }
        block => Some(block),
    }
}

fn transform_thinking_block(
    thinking: String,
    thinking_signature: Option<String>,
    redacted: Option<bool>,
    same_model: bool,
) -> Option<ContentBlock> {
    if redacted.unwrap_or(false) {
        return same_model.then_some(ContentBlock::Thinking {
            thinking,
            thinking_signature,
            redacted,
        });
    }

    let has_signature = thinking_signature
        .as_deref()
        .is_some_and(|signature| !signature.is_empty());
    if same_model && has_signature {
        return Some(ContentBlock::Thinking {
            thinking,
            thinking_signature,
            redacted,
        });
    }

    if thinking.trim().is_empty() {
        return None;
    }

    if same_model {
        Some(ContentBlock::Thinking {
            thinking,
            thinking_signature,
            redacted,
        })
    } else {
        Some(ContentBlock::Text {
            text: thinking,
            text_signature: None,
        })
    }
}

fn insert_synthetic_orphan_tool_results(messages: Vec<Message>) -> Vec<Message> {
    let mut result = Vec::with_capacity(messages.len());
    let mut pending_tool_calls = Vec::new();
    let mut existing_tool_result_ids = HashSet::new();

    for message in messages {
        match message {
            Message::Assistant(assistant) => {
                insert_synthetic_tool_results(
                    &mut result,
                    &mut pending_tool_calls,
                    &mut existing_tool_result_ids,
                );

                if matches!(
                    assistant.stop_reason,
                    StopReason::Error | StopReason::Aborted
                ) {
                    continue;
                }

                let tool_calls = assistant
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::ToolCall { id, name, .. } => Some((id.clone(), name.clone())),
                        _ => None,
                    })
                    .collect::<Vec<_>>();

                if !tool_calls.is_empty() {
                    pending_tool_calls = tool_calls;
                    existing_tool_result_ids = HashSet::new();
                }

                result.push(Message::Assistant(assistant));
            }
            Message::ToolResult(tool_result) => {
                existing_tool_result_ids.insert(tool_result.tool_call_id.clone());
                result.push(Message::ToolResult(tool_result));
            }
            Message::User(user) => {
                insert_synthetic_tool_results(
                    &mut result,
                    &mut pending_tool_calls,
                    &mut existing_tool_result_ids,
                );
                result.push(Message::User(user));
            }
        }
    }

    insert_synthetic_tool_results(
        &mut result,
        &mut pending_tool_calls,
        &mut existing_tool_result_ids,
    );

    result
}

fn insert_synthetic_tool_results(
    result: &mut Vec<Message>,
    pending_tool_calls: &mut Vec<(String, String)>,
    existing_tool_result_ids: &mut HashSet<String>,
) {
    if pending_tool_calls.is_empty() {
        return;
    }

    for (id, name) in pending_tool_calls.drain(..) {
        if existing_tool_result_ids.contains(&id) {
            continue;
        }

        result.push(Message::ToolResult(ToolResultMessage {
            tool_call_id: id,
            tool_name: name,
            content: vec![ContentBlock::text(SYNTHETIC_TOOL_RESULT_TEXT)],
            details: None,
            is_error: true,
            timestamp: now_millis(),
        }));
    }

    existing_tool_result_ids.clear();
}

fn is_same_model(message: &AssistantMessage, model: &Model) -> bool {
    message.provider == model.provider && message.api == model.api && message.model == model.id
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        AssistantMessage, Cost, ModelPricing, ToolResultMessage, Usage, UserMessage,
    };
    use serde_json::Map;

    fn model(provider: &str, api: &str, id: &str, input: Vec<ModelInput>) -> Model {
        Model {
            id: id.to_string(),
            name: id.to_string(),
            api: api.to_string(),
            provider: provider.to_string(),
            base_url: "https://example.com".to_string(),
            reasoning: true,
            thinking_level_map: None,
            input,
            cost: ModelPricing::default(),
            context_window: 128_000,
            max_tokens: 16_000,
            headers: None,
            compat: None,
        }
    }

    fn usage() -> Usage {
        Usage {
            cost: Cost::default(),
            ..Usage::default()
        }
    }

    fn user_text(text: &str) -> Message {
        Message::User(UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp: 1,
        })
    }

    fn user_blocks(blocks: Vec<ContentBlock>) -> Message {
        Message::User(UserMessage {
            content: UserContent::Blocks(blocks),
            timestamp: 1,
        })
    }

    fn assistant(
        provider: &str,
        api: &str,
        model: &str,
        content: Vec<ContentBlock>,
        stop_reason: StopReason,
    ) -> Message {
        Message::Assistant(AssistantMessage {
            content,
            api: api.to_string(),
            provider: provider.to_string(),
            model: model.to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: usage(),
            stop_reason,
            error_message: None,
            timestamp: 2,
        })
    }

    fn tool_result(id: &str, name: &str, content: Vec<ContentBlock>) -> Message {
        Message::ToolResult(ToolResultMessage {
            tool_call_id: id.to_string(),
            tool_name: name.to_string(),
            content,
            details: None,
            is_error: false,
            timestamp: 3,
        })
    }

    fn text(text: &str) -> ContentBlock {
        ContentBlock::Text {
            text: text.to_string(),
            text_signature: None,
        }
    }

    fn text_with_signature(text: &str, signature: &str) -> ContentBlock {
        ContentBlock::Text {
            text: text.to_string(),
            text_signature: Some(signature.to_string()),
        }
    }

    fn thinking(text: &str, signature: Option<&str>, redacted: Option<bool>) -> ContentBlock {
        ContentBlock::Thinking {
            thinking: text.to_string(),
            thinking_signature: signature.map(str::to_string),
            redacted,
        }
    }

    fn tool_call(id: &str, name: &str, thought_signature: Option<&str>) -> ContentBlock {
        ContentBlock::ToolCall {
            id: id.to_string(),
            name: name.to_string(),
            arguments: Map::new(),
            thought_signature: thought_signature.map(str::to_string),
        }
    }

    fn image() -> ContentBlock {
        ContentBlock::image("base64", "image/png")
    }

    #[test]
    fn transform_messages_replaces_unsupported_images_with_coalesced_placeholders() {
        let target = model("provider", "api", "text-only", vec![ModelInput::Text]);
        let messages = vec![
            user_blocks(vec![
                image(),
                image(),
                text("describe"),
                image(),
                text(NON_VISION_USER_IMAGE_PLACEHOLDER),
                image(),
            ]),
            tool_result(
                "call_1",
                "inspect",
                vec![text("before"), image(), image(), text("after")],
            ),
        ];

        let result = transform_messages(&messages, &target);

        let Message::User(user) = &result[0] else {
            panic!("expected user message");
        };
        let UserContent::Blocks(user_blocks) = &user.content else {
            panic!("expected user block content");
        };
        assert_eq!(
            user_blocks,
            &vec![
                text(NON_VISION_USER_IMAGE_PLACEHOLDER),
                text("describe"),
                text(NON_VISION_USER_IMAGE_PLACEHOLDER),
                text(NON_VISION_USER_IMAGE_PLACEHOLDER),
            ]
        );

        let Message::ToolResult(tool_result) = &result[1] else {
            panic!("expected tool result message");
        };
        assert_eq!(
            tool_result.content,
            vec![
                text("before"),
                text(NON_VISION_TOOL_IMAGE_PLACEHOLDER),
                text("after"),
            ]
        );
    }

    #[test]
    fn transform_messages_preserves_same_model_thinking_and_signatures() {
        let target = model("provider", "api", "same", vec![ModelInput::Text]);
        let messages = vec![assistant(
            "provider",
            "api",
            "same",
            vec![
                thinking("", Some("reasoning-id"), None),
                thinking("encrypted", Some("opaque"), Some(true)),
                text_with_signature("answer", "text-sig"),
                tool_call("call_1", "bash", Some("thought-sig")),
            ],
            StopReason::ToolUse,
        )];

        let result = transform_messages(&messages, &target);

        let Message::Assistant(assistant) = &result[0] else {
            panic!("expected assistant message");
        };
        assert_eq!(
            assistant.content,
            vec![
                thinking("", Some("reasoning-id"), None),
                thinking("encrypted", Some("opaque"), Some(true)),
                text_with_signature("answer", "text-sig"),
                tool_call("call_1", "bash", Some("thought-sig")),
            ]
        );
    }

    #[test]
    fn transform_messages_converts_and_drops_cross_model_thinking_signatures() {
        let target = model("provider", "api", "target", vec![ModelInput::Text]);
        let messages = vec![assistant(
            "provider",
            "api",
            "source",
            vec![
                thinking("redacted", Some("opaque"), Some(true)),
                thinking("visible thought", Some("reasoning-id"), None),
                thinking("", Some("empty-reasoning-id"), None),
                thinking("   ", None, None),
                text_with_signature("answer", "text-sig"),
                tool_call("call_1", "bash", Some("thought-sig")),
            ],
            StopReason::ToolUse,
        )];

        let result = transform_messages(&messages, &target);

        let Message::Assistant(assistant) = &result[0] else {
            panic!("expected assistant message");
        };
        assert_eq!(
            assistant.content,
            vec![
                text("visible thought"),
                text("answer"),
                tool_call("call_1", "bash", None),
            ]
        );
    }

    #[test]
    fn transform_messages_normalizes_tool_call_ids_and_remaps_results() {
        let target = model("new-provider", "api", "target", vec![ModelInput::Text]);
        let messages = vec![
            assistant(
                "old-provider",
                "api",
                "source",
                vec![tool_call("call_1|foreign", "bash", None)],
                StopReason::ToolUse,
            ),
            tool_result("call_1|foreign", "bash", vec![text("done")]),
        ];

        let result =
            transform_messages_with_tool_call_id_normalizer(&messages, &target, |id, _, _| {
                id.replace('|', "_")
            });

        let Message::Assistant(assistant) = &result[0] else {
            panic!("expected assistant message");
        };
        assert_eq!(
            assistant.content,
            vec![tool_call("call_1_foreign", "bash", None)]
        );

        let Message::ToolResult(tool_result) = &result[1] else {
            panic!("expected tool result message");
        };
        assert_eq!(tool_result.tool_call_id, "call_1_foreign");
        assert!(!tool_result.is_error);
    }

    #[test]
    fn transform_messages_inserts_synthetic_results_before_user_assistant_and_at_end() {
        let target = model("provider", "api", "same", vec![ModelInput::Text]);
        let messages = vec![
            user_text("start"),
            assistant(
                "provider",
                "api",
                "same",
                vec![tool_call("call_before_assistant", "read", None)],
                StopReason::ToolUse,
            ),
            assistant(
                "provider",
                "api",
                "same",
                vec![text("next assistant")],
                StopReason::Stop,
            ),
            assistant(
                "provider",
                "api",
                "same",
                vec![tool_call("call_before_user", "bash", None)],
                StopReason::ToolUse,
            ),
            user_text("interrupt"),
            assistant(
                "provider",
                "api",
                "same",
                vec![tool_call("call_at_end", "write", None)],
                StopReason::ToolUse,
            ),
        ];

        let result = transform_messages(&messages, &target);
        let synthetic = result
            .iter()
            .enumerate()
            .filter_map(|(index, message)| match message {
                Message::ToolResult(tool_result) if tool_result.is_error => Some((
                    index,
                    tool_result.tool_call_id.clone(),
                    tool_result.tool_name.clone(),
                )),
                _ => None,
            })
            .collect::<Vec<_>>();

        assert_eq!(
            synthetic,
            vec![
                (2, "call_before_assistant".to_string(), "read".to_string()),
                (5, "call_before_user".to_string(), "bash".to_string()),
                (8, "call_at_end".to_string(), "write".to_string()),
            ]
        );

        for (_, id, _) in &synthetic {
            let Message::ToolResult(tool_result) = result
                .iter()
                .find(|message| {
                    matches!(
                        message,
                        Message::ToolResult(tool_result)
                            if tool_result.is_error
                                && tool_result.tool_call_id.as_str() == id.as_str()
                    )
                })
                .unwrap()
            else {
                panic!("expected synthetic tool result");
            };
            assert_eq!(tool_result.content, vec![text(SYNTHETIC_TOOL_RESULT_TEXT)]);
        }
    }

    #[test]
    fn transform_messages_skips_errored_and_aborted_assistant_messages() {
        let target = model("provider", "api", "same", vec![ModelInput::Text]);
        let messages = vec![
            user_text("start"),
            assistant(
                "provider",
                "api",
                "same",
                vec![tool_call("error_call", "bash", None)],
                StopReason::Error,
            ),
            assistant(
                "provider",
                "api",
                "same",
                vec![tool_call("aborted_call", "read", None)],
                StopReason::Aborted,
            ),
            user_text("continue"),
        ];

        let result = transform_messages(&messages, &target);

        assert_eq!(result, vec![user_text("start"), user_text("continue")]);
    }
}
