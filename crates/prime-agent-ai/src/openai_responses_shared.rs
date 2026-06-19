use std::collections::HashSet;
use std::error::Error;
use std::fmt;

use serde_json::{Map, Value};

use crate::hash::short_hash;
use crate::json_parse::parse_streaming_json;
use crate::models::calculate_cost;
use crate::sanitize_unicode::sanitize_surrogates;
use crate::transform_messages::transform_messages_with_tool_call_id_normalizer;
use crate::types::{
    AssistantMessage, ContentBlock, Context, Message, Model, ModelInput, StopReason, TextPhase,
    TextSignatureV1, Tool, Usage, UserContent,
};

pub type OpenAIResponsesSharedResult<T> = Result<T, OpenAIResponsesSharedError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenAIResponsesSharedError {
    InvalidThinkingSignature { signature: String, message: String },
    UnhandledStopReason(String),
}

impl fmt::Display for OpenAIResponsesSharedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidThinkingSignature { message, .. } => {
                write!(f, "invalid OpenAI Responses thinking signature: {message}")
            }
            Self::UnhandledStopReason(status) => {
                write!(f, "unhandled OpenAI Responses stop reason: {status}")
            }
        }
    }
}

impl Error for OpenAIResponsesSharedError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConvertResponsesMessagesOptions {
    pub include_system_prompt: bool,
}

impl Default for ConvertResponsesMessagesOptions {
    fn default() -> Self {
        Self {
            include_system_prompt: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponsesToolStrict {
    Bool(bool),
    Null,
}

impl ResponsesToolStrict {
    fn into_value(self) -> Value {
        match self {
            Self::Bool(value) => Value::Bool(value),
            Self::Null => Value::Null,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ConvertResponsesToolsOptions {
    pub strict: Option<ResponsesToolStrict>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedTextSignature {
    pub id: String,
    pub phase: Option<TextPhase>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResponsesStreamEventKind {
    ResponseCreated,
    OutputItemAdded,
    ReasoningSummaryPartAdded,
    ReasoningSummaryTextDelta,
    ReasoningSummaryPartDone,
    ReasoningTextDelta,
    ContentPartAdded,
    OutputTextDelta,
    RefusalDelta,
    FunctionCallArgumentsDelta,
    FunctionCallArgumentsDone,
    OutputItemDone,
    Completed,
    Error,
    Failed,
    Unknown(String),
}

pub fn encode_text_signature_v1(id: &str, phase: Option<TextPhase>) -> String {
    serde_json::to_string(&TextSignatureV1 {
        v: 1,
        id: id.to_string(),
        phase,
    })
    .expect("TextSignatureV1 only contains serializable fields")
}

pub fn parse_text_signature(signature: Option<&str>) -> Option<ParsedTextSignature> {
    let signature = signature.filter(|signature| !signature.is_empty())?;

    if signature.starts_with('{')
        && let Ok(parsed) = serde_json::from_str::<Value>(signature)
        && parsed.get("v").and_then(Value::as_u64) == Some(1)
        && let Some(id) = parsed.get("id").and_then(Value::as_str)
    {
        let phase = parsed
            .get("phase")
            .and_then(Value::as_str)
            .and_then(parse_text_phase);
        return Some(ParsedTextSignature {
            id: id.to_string(),
            phase,
        });
    }

    Some(ParsedTextSignature {
        id: signature.to_string(),
        phase: None,
    })
}

pub fn parse_text_phase(phase: &str) -> Option<TextPhase> {
    match phase {
        "commentary" => Some(TextPhase::Commentary),
        "final_answer" => Some(TextPhase::FinalAnswer),
        _ => None,
    }
}

pub const fn text_phase_as_str(phase: TextPhase) -> &'static str {
    match phase {
        TextPhase::Commentary => "commentary",
        TextPhase::FinalAnswer => "final_answer",
    }
}

pub fn convert_responses_messages(
    model: &Model,
    context: &Context,
    allowed_tool_call_providers: &HashSet<String>,
    options: Option<&ConvertResponsesMessagesOptions>,
) -> OpenAIResponsesSharedResult<Vec<Value>> {
    let mut messages = Vec::new();

    let transformed_messages = transform_messages_with_tool_call_id_normalizer(
        &context.messages,
        model,
        |id, model, source| normalize_tool_call_id(id, model, source, allowed_tool_call_providers),
    );

    let include_system_prompt = options.copied().unwrap_or_default().include_system_prompt;
    if include_system_prompt && let Some(system_prompt) = &context.system_prompt {
        let role = if model.reasoning {
            "developer"
        } else {
            "system"
        };
        messages.push(object_from_iter([
            ("role", string_value(role)),
            ("content", string_value(sanitize_surrogates(system_prompt))),
        ]));
    }

    let mut msg_index = 0usize;
    for message in transformed_messages {
        match message {
            Message::User(user) => {
                let Some(content) = convert_user_content(user.content) else {
                    continue;
                };
                messages.push(object_from_iter([
                    ("role", string_value("user")),
                    ("content", Value::Array(content)),
                ]));
            }
            Message::Assistant(assistant) => {
                let output = convert_assistant_message(model, assistant, msg_index)?;
                if output.is_empty() {
                    continue;
                }
                messages.extend(output);
            }
            Message::ToolResult(tool_result) => {
                messages.push(convert_tool_result_message(model, tool_result));
            }
        }
        msg_index += 1;
    }

    Ok(messages)
}

pub fn convert_responses_tools(
    tools: &[Tool],
    options: Option<&ConvertResponsesToolsOptions>,
) -> Vec<Value> {
    let strict = options
        .and_then(|options| options.strict)
        .unwrap_or(ResponsesToolStrict::Bool(false))
        .into_value();

    tools
        .iter()
        .map(|tool| {
            object_from_iter([
                ("type", string_value("function")),
                ("name", string_value(&tool.name)),
                ("description", string_value(&tool.description)),
                ("parameters", tool.parameters.clone()),
                ("strict", strict.clone()),
            ])
        })
        .collect()
}

pub fn map_stop_reason(status: Option<&str>) -> OpenAIResponsesSharedResult<StopReason> {
    match status {
        None | Some("completed") | Some("in_progress") | Some("queued") => Ok(StopReason::Stop),
        Some("incomplete") => Ok(StopReason::Length),
        Some("failed" | "cancelled") => Ok(StopReason::Error),
        Some(status) => Err(OpenAIResponsesSharedError::UnhandledStopReason(
            status.to_string(),
        )),
    }
}

pub fn map_completed_stop_reason(
    status: Option<&str>,
    has_tool_calls: bool,
) -> OpenAIResponsesSharedResult<StopReason> {
    let stop_reason = map_stop_reason(status)?;
    if has_tool_calls && stop_reason == StopReason::Stop {
        Ok(StopReason::ToolUse)
    } else {
        Ok(stop_reason)
    }
}

pub fn map_responses_usage(model: &Model, response_usage: Option<&Value>) -> Option<Usage> {
    let response_usage = response_usage?;
    let cached_tokens = value_u64(
        response_usage
            .get("input_tokens_details")
            .and_then(|details| details.get("cached_tokens")),
    );
    let input_tokens = value_u64(response_usage.get("input_tokens"));

    let mut usage = Usage {
        input: input_tokens.saturating_sub(cached_tokens),
        output: value_u64(response_usage.get("output_tokens")),
        cache_read: cached_tokens,
        cache_write: 0,
        total_tokens: value_u64(response_usage.get("total_tokens")),
        cost: Default::default(),
    };
    calculate_cost(model, &mut usage);
    Some(usage)
}

pub fn get_service_tier_cost_multiplier(model: &Model, service_tier: Option<&str>) -> f64 {
    match service_tier {
        Some("flex") => 0.5,
        Some("priority") if model.id == "gpt-5.5" => 2.5,
        Some("priority") => 2.0,
        _ => 1.0,
    }
}

pub fn apply_service_tier_pricing(usage: &mut Usage, service_tier: Option<&str>, model: &Model) {
    let multiplier = get_service_tier_cost_multiplier(model, service_tier);
    if multiplier == 1.0 {
        return;
    }

    usage.cost.input *= multiplier;
    usage.cost.output *= multiplier;
    usage.cost.cache_read *= multiplier;
    usage.cost.cache_write *= multiplier;
    usage.cost.total =
        usage.cost.input + usage.cost.output + usage.cost.cache_read + usage.cost.cache_write;
}

pub fn responses_stream_event_type(event: &Value) -> Option<&str> {
    event.get("type").and_then(Value::as_str)
}

pub fn responses_stream_event_kind(event: &Value) -> Option<ResponsesStreamEventKind> {
    let event_type = responses_stream_event_type(event)?;
    Some(match event_type {
        "response.created" => ResponsesStreamEventKind::ResponseCreated,
        "response.output_item.added" => ResponsesStreamEventKind::OutputItemAdded,
        "response.reasoning_summary_part.added" => {
            ResponsesStreamEventKind::ReasoningSummaryPartAdded
        }
        "response.reasoning_summary_text.delta" => {
            ResponsesStreamEventKind::ReasoningSummaryTextDelta
        }
        "response.reasoning_summary_part.done" => {
            ResponsesStreamEventKind::ReasoningSummaryPartDone
        }
        "response.reasoning_text.delta" => ResponsesStreamEventKind::ReasoningTextDelta,
        "response.content_part.added" => ResponsesStreamEventKind::ContentPartAdded,
        "response.output_text.delta" => ResponsesStreamEventKind::OutputTextDelta,
        "response.refusal.delta" => ResponsesStreamEventKind::RefusalDelta,
        "response.function_call_arguments.delta" => {
            ResponsesStreamEventKind::FunctionCallArgumentsDelta
        }
        "response.function_call_arguments.done" => {
            ResponsesStreamEventKind::FunctionCallArgumentsDone
        }
        "response.output_item.done" => ResponsesStreamEventKind::OutputItemDone,
        "response.completed" => ResponsesStreamEventKind::Completed,
        "error" => ResponsesStreamEventKind::Error,
        "response.failed" => ResponsesStreamEventKind::Failed,
        other => ResponsesStreamEventKind::Unknown(other.to_string()),
    })
}

pub fn response_event_error_message(event: &Value) -> Option<String> {
    match responses_stream_event_type(event)? {
        "error" => {
            let code = event
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let message = event
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Unknown error");
            Some(format!("Error Code {code}: {message}"))
        }
        "response.failed" => {
            let response = event.get("response");
            let error = response.and_then(|response| response.get("error"));
            if error.is_some() {
                let code = error
                    .and_then(|error| error.get("code"))
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let message = error
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("no message");
                return Some(format!("{code}: {message}"));
            }

            if let Some(reason) = response
                .and_then(|response| response.get("incomplete_details"))
                .and_then(|details| details.get("reason"))
                .and_then(Value::as_str)
            {
                return Some(format!("incomplete: {reason}"));
            }

            Some("Unknown error (no error details in response)".to_string())
        }
        _ => None,
    }
}

pub fn response_output_message_text(item: &Value) -> String {
    item.get("content")
        .and_then(Value::as_array)
        .map(|content| {
            content
                .iter()
                .filter_map(|part| match part.get("type").and_then(Value::as_str) {
                    Some("output_text") => part.get("text").and_then(Value::as_str),
                    Some("refusal") => part.get("refusal").and_then(Value::as_str),
                    _ => None,
                })
                .collect::<String>()
        })
        .unwrap_or_default()
}

pub fn response_output_message_text_signature(item: &Value) -> Option<String> {
    let id = item.get("id").and_then(Value::as_str)?;
    let phase = item
        .get("phase")
        .and_then(Value::as_str)
        .and_then(parse_text_phase);
    Some(encode_text_signature_v1(id, phase))
}

pub fn response_reasoning_item_text(item: &Value) -> String {
    let summary_text = collect_response_text_parts(item.get("summary"));
    if summary_text.is_empty() {
        collect_response_text_parts(item.get("content"))
    } else {
        summary_text
    }
}

pub fn parse_response_function_arguments(arguments: Option<&str>) -> Value {
    parse_streaming_json(arguments)
}

pub fn parse_response_function_arguments_object(arguments: Option<&str>) -> Map<String, Value> {
    parse_response_function_arguments(arguments)
        .as_object()
        .cloned()
        .unwrap_or_default()
}

pub fn response_function_call_tool_call(item: &Value) -> Option<ContentBlock> {
    if item.get("type").and_then(Value::as_str) != Some("function_call") {
        return None;
    }

    let call_id = item.get("call_id").and_then(Value::as_str)?;
    let item_id = item.get("id").and_then(Value::as_str)?;
    let name = item.get("name").and_then(Value::as_str)?;
    let arguments =
        parse_response_function_arguments_object(item.get("arguments").and_then(Value::as_str));

    Some(ContentBlock::ToolCall {
        id: format!("{call_id}|{item_id}"),
        name: name.to_string(),
        arguments,
        thought_signature: None,
    })
}

fn convert_user_content(content: UserContent) -> Option<Vec<Value>> {
    match content {
        UserContent::Text(text) => Some(vec![input_text_part(&text)]),
        UserContent::Blocks(blocks) => {
            let content = blocks
                .into_iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text, .. } => Some(input_text_part(&text)),
                    ContentBlock::Image { data, mime_type } => {
                        Some(input_image_part(&data, &mime_type))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            (!content.is_empty()).then_some(content)
        }
    }
}

fn convert_assistant_message(
    target_model: &Model,
    assistant: AssistantMessage,
    msg_index: usize,
) -> OpenAIResponsesSharedResult<Vec<Value>> {
    let is_different_model = assistant.model != target_model.id
        && assistant.provider == target_model.provider
        && assistant.api == target_model.api;
    let mut output = Vec::new();

    for block in assistant.content {
        match block {
            ContentBlock::Thinking {
                thinking_signature: Some(signature),
                ..
            } => {
                let reasoning_item =
                    serde_json::from_str::<Value>(&signature).map_err(|error| {
                        OpenAIResponsesSharedError::InvalidThinkingSignature {
                            signature: signature.clone(),
                            message: error.to_string(),
                        }
                    })?;
                output.push(reasoning_item);
            }
            ContentBlock::Thinking { .. } => {}
            ContentBlock::Text {
                text,
                text_signature,
            } => {
                output.push(convert_assistant_text_block(
                    &text,
                    text_signature.as_deref(),
                    msg_index,
                ));
            }
            ContentBlock::ToolCall {
                id,
                name,
                arguments,
                ..
            } => {
                output.push(convert_assistant_tool_call(
                    &id,
                    &name,
                    arguments,
                    is_different_model,
                ));
            }
            ContentBlock::Image { .. } => {}
        }
    }

    Ok(output)
}

fn convert_assistant_text_block(
    text: &str,
    text_signature: Option<&str>,
    msg_index: usize,
) -> Value {
    let parsed_signature = parse_text_signature(text_signature);
    let id = parsed_signature
        .as_ref()
        .map(|signature| signature.id.as_str())
        .filter(|id| !id.is_empty())
        .map(|id| {
            if js_string_len(id) > 64 {
                format!("msg_{}", short_hash(id))
            } else {
                id.to_string()
            }
        })
        .unwrap_or_else(|| format!("msg_{msg_index}"));

    let mut message = Map::new();
    message.insert("type".to_string(), string_value("message"));
    message.insert("role".to_string(), string_value("assistant"));
    message.insert(
        "content".to_string(),
        Value::Array(vec![object_from_iter([
            ("type", string_value("output_text")),
            ("text", string_value(sanitize_surrogates(text))),
            ("annotations", Value::Array(Vec::new())),
        ])]),
    );
    message.insert("status".to_string(), string_value("completed"));
    message.insert("id".to_string(), string_value(id));
    if let Some(phase) = parsed_signature.and_then(|signature| signature.phase) {
        message.insert("phase".to_string(), string_value(text_phase_as_str(phase)));
    }
    Value::Object(message)
}

fn convert_assistant_tool_call(
    id: &str,
    name: &str,
    arguments: Map<String, Value>,
    is_different_model: bool,
) -> Value {
    let (call_id, mut item_id) = split_responses_tool_call_id(id);
    if is_different_model
        && item_id
            .as_deref()
            .is_some_and(|item_id| item_id.starts_with("fc_"))
    {
        item_id = None;
    }

    let mut tool_call = Map::new();
    tool_call.insert("type".to_string(), string_value("function_call"));
    if let Some(item_id) = item_id {
        tool_call.insert("id".to_string(), string_value(item_id));
    }
    tool_call.insert("call_id".to_string(), string_value(call_id));
    tool_call.insert("name".to_string(), string_value(name));
    tool_call.insert(
        "arguments".to_string(),
        string_value(
            serde_json::to_string(&arguments)
                .expect("tool call arguments only contain serializable JSON values"),
        ),
    );
    Value::Object(tool_call)
}

fn convert_tool_result_message(
    model: &Model,
    tool_result: crate::types::ToolResultMessage,
) -> Value {
    let text_result = tool_result
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let has_images = tool_result
        .content
        .iter()
        .any(|block| matches!(block, ContentBlock::Image { .. }));
    let has_text = !text_result.is_empty();
    let call_id = tool_result
        .tool_call_id
        .split('|')
        .next()
        .unwrap_or_default()
        .to_string();

    let output = if has_images && model.input.contains(&ModelInput::Image) {
        let mut content_parts = Vec::new();
        if has_text {
            content_parts.push(input_text_part(&text_result));
        }
        for block in &tool_result.content {
            if let ContentBlock::Image { data, mime_type } = block {
                content_parts.push(input_image_part(data, mime_type));
            }
        }
        Value::Array(content_parts)
    } else {
        string_value(sanitize_surrogates(if has_text {
            &text_result
        } else {
            "(see attached image)"
        }))
    };

    object_from_iter([
        ("type", string_value("function_call_output")),
        ("call_id", string_value(call_id)),
        ("output", output),
    ])
}

fn normalize_tool_call_id(
    id: &str,
    model: &Model,
    source: &AssistantMessage,
    allowed_tool_call_providers: &HashSet<String>,
) -> String {
    if !allowed_tool_call_providers.contains(&model.provider) {
        return normalize_id_part(id);
    }

    if !id.contains('|') {
        return normalize_id_part(id);
    }

    let mut parts = id.split('|');
    let call_id = parts.next().unwrap_or_default();
    let item_id = parts.next().unwrap_or_default();
    let normalized_call_id = normalize_id_part(call_id);
    let is_foreign_tool_call = source.provider != model.provider || source.api != model.api;
    let mut normalized_item_id = if is_foreign_tool_call {
        build_foreign_responses_item_id(item_id)
    } else {
        normalize_id_part(item_id)
    };

    if !normalized_item_id.starts_with("fc_") {
        normalized_item_id = normalize_id_part(&format!("fc_{normalized_item_id}"));
    }

    format!("{normalized_call_id}|{normalized_item_id}")
}

fn normalize_id_part(part: &str) -> String {
    let sanitized = part
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .take(64)
        .collect::<String>();
    sanitized.trim_end_matches('_').to_string()
}

fn build_foreign_responses_item_id(item_id: &str) -> String {
    let normalized = format!("fc_{}", short_hash(item_id));
    normalized.chars().take(64).collect()
}

fn split_responses_tool_call_id(id: &str) -> (String, Option<String>) {
    let mut parts = id.split('|');
    let call_id = parts.next().unwrap_or_default().to_string();
    let item_id = parts.next().map(str::to_string);
    (call_id, item_id)
}

fn input_text_part(text: &str) -> Value {
    object_from_iter([
        ("type", string_value("input_text")),
        ("text", string_value(sanitize_surrogates(text))),
    ])
}

fn input_image_part(data: &str, mime_type: &str) -> Value {
    object_from_iter([
        ("type", string_value("input_image")),
        ("detail", string_value("auto")),
        (
            "image_url",
            string_value(format!("data:{mime_type};base64,{data}")),
        ),
    ])
}

fn collect_response_text_parts(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default()
}

fn value_u64(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

fn js_string_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn string_value(value: impl Into<String>) -> Value {
    Value::String(value.into())
}

fn object_from_iter<const N: usize>(entries: [(&str, Value); N]) -> Value {
    Value::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use crate::types::{AssistantMessage, Cost, ModelPricing, ToolResultMessage, UserMessage};

    fn model(
        provider: &str,
        api: &str,
        id: &str,
        reasoning: bool,
        input: Vec<ModelInput>,
    ) -> Model {
        Model {
            id: id.to_string(),
            name: id.to_string(),
            api: api.to_string(),
            provider: provider.to_string(),
            base_url: "https://example.com".to_string(),
            reasoning,
            thinking_level_map: None,
            input,
            cost: ModelPricing {
                input: 5.0,
                output: 30.0,
                cache_read: 1.0,
                cache_write: 2.0,
            },
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

    fn allowed_openai_tool_call_providers() -> HashSet<String> {
        ["openai"].into_iter().map(str::to_string).collect()
    }

    fn context(messages: Vec<Message>) -> Context {
        Context {
            system_prompt: None,
            messages,
            tools: None,
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

    fn assistant(provider: &str, api: &str, model: &str, content: Vec<ContentBlock>) -> Message {
        Message::Assistant(AssistantMessage {
            content,
            api: api.to_string(),
            provider: provider.to_string(),
            model: model.to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: usage(),
            stop_reason: StopReason::ToolUse,
            error_message: None,
            timestamp: 2,
        })
    }

    fn tool_result(id: &str, content: Vec<ContentBlock>) -> Message {
        Message::ToolResult(ToolResultMessage {
            tool_call_id: id.to_string(),
            tool_name: "inspect".to_string(),
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

    fn image(data: &str) -> ContentBlock {
        ContentBlock::Image {
            data: data.to_string(),
            mime_type: "image/png".to_string(),
        }
    }

    #[test]
    fn converts_user_text_and_images_to_response_input_content() {
        let target = model(
            "openai",
            "openai-responses",
            "gpt-5",
            false,
            vec![ModelInput::Text, ModelInput::Image],
        );
        let ctx = context(vec![
            user_text("hello"),
            user_blocks(vec![text("look"), image("abc123")]),
        ]);

        let converted =
            convert_responses_messages(&target, &ctx, &allowed_openai_tool_call_providers(), None)
                .unwrap();

        assert_eq!(
            converted,
            vec![
                json!({
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "hello" }]
                }),
                json!({
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "look" },
                        {
                            "type": "input_image",
                            "detail": "auto",
                            "image_url": "data:image/png;base64,abc123"
                        }
                    ]
                })
            ]
        );
    }

    #[test]
    fn uses_system_role_for_regular_models_and_developer_role_for_reasoning_models() {
        let mut ctx = context(Vec::new());
        ctx.system_prompt = Some("Follow policy".to_string());
        let allowed = allowed_openai_tool_call_providers();
        let regular = model(
            "openai",
            "openai-responses",
            "gpt-4.1",
            false,
            vec![ModelInput::Text],
        );
        let reasoning = model(
            "openai",
            "openai-responses",
            "gpt-5",
            true,
            vec![ModelInput::Text],
        );

        assert_eq!(
            convert_responses_messages(&regular, &ctx, &allowed, None).unwrap(),
            vec![json!({ "role": "system", "content": "Follow policy" })]
        );
        assert_eq!(
            convert_responses_messages(&reasoning, &ctx, &allowed, None).unwrap(),
            vec![json!({ "role": "developer", "content": "Follow policy" })]
        );
        assert_eq!(
            convert_responses_messages(
                &reasoning,
                &ctx,
                &allowed,
                Some(&ConvertResponsesMessagesOptions {
                    include_system_prompt: false,
                }),
            )
            .unwrap(),
            Vec::<Value>::new()
        );
    }

    #[test]
    fn converts_assistant_text_tool_calls_and_thinking_signatures() {
        let target = model(
            "openai",
            "openai-responses",
            "gpt-5",
            true,
            vec![ModelInput::Text],
        );
        let thinking_signature = json!({
            "type": "reasoning",
            "id": "rs_1",
            "summary": [{ "type": "summary_text", "text": "why" }]
        })
        .to_string();
        let text_signature = encode_text_signature_v1("msg_existing", Some(TextPhase::Commentary));
        let arguments = Map::from_iter([("path".to_string(), json!("README.md"))]);
        let ctx = context(vec![assistant(
            "openai",
            "openai-responses",
            "gpt-5",
            vec![
                ContentBlock::Thinking {
                    thinking: String::new(),
                    thinking_signature: Some(thinking_signature),
                    redacted: None,
                },
                text_with_signature("answer", &text_signature),
                ContentBlock::ToolCall {
                    id: "call_1|fc_1".to_string(),
                    name: "read".to_string(),
                    arguments,
                    thought_signature: None,
                },
            ],
        )]);

        let converted =
            convert_responses_messages(&target, &ctx, &allowed_openai_tool_call_providers(), None)
                .unwrap();

        assert_eq!(
            converted,
            vec![
                json!({
                    "type": "reasoning",
                    "id": "rs_1",
                    "summary": [{ "type": "summary_text", "text": "why" }]
                }),
                json!({
                    "type": "message",
                    "role": "assistant",
                    "content": [{
                        "type": "output_text",
                        "text": "answer",
                        "annotations": []
                    }],
                    "status": "completed",
                    "id": "msg_existing",
                    "phase": "commentary"
                }),
                json!({
                    "type": "function_call",
                    "id": "fc_1",
                    "call_id": "call_1",
                    "name": "read",
                    "arguments": "{\"path\":\"README.md\"}"
                }),
                json!({
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "No result provided"
                })
            ]
        );
    }

    #[test]
    fn converts_tool_results_with_and_without_image_capable_models() {
        let image_target = model(
            "openai",
            "openai-responses",
            "gpt-5",
            false,
            vec![ModelInput::Text, ModelInput::Image],
        );
        let text_target = model(
            "openai",
            "openai-responses",
            "gpt-4.1",
            false,
            vec![ModelInput::Text],
        );
        let ctx = context(vec![tool_result(
            "call_1|fc_1",
            vec![text("done"), image("pngdata")],
        )]);
        let allowed = allowed_openai_tool_call_providers();

        assert_eq!(
            convert_responses_messages(&image_target, &ctx, &allowed, None).unwrap(),
            vec![json!({
                "type": "function_call_output",
                "call_id": "call_1",
                "output": [
                    { "type": "input_text", "text": "done" },
                    {
                        "type": "input_image",
                        "detail": "auto",
                        "image_url": "data:image/png;base64,pngdata"
                    }
                ]
            })]
        );
        assert_eq!(
            convert_responses_messages(&text_target, &ctx, &allowed, None).unwrap(),
            vec![json!({
                "type": "function_call_output",
                "call_id": "call_1",
                "output": "done\n(tool image omitted: model does not support images)"
            })]
        );
    }

    #[test]
    fn normalizes_foreign_tool_call_ids_and_remaps_tool_results() {
        let target = model(
            "openai",
            "openai-responses",
            "gpt-5",
            false,
            vec![ModelInput::Text],
        );
        let ctx = context(vec![
            assistant(
                "anthropic",
                "anthropic",
                "claude",
                vec![ContentBlock::ToolCall {
                    id: "call one!!|foreign/item with spaces".to_string(),
                    name: "bash".to_string(),
                    arguments: Map::new(),
                    thought_signature: None,
                }],
            ),
            tool_result("call one!!|foreign/item with spaces", vec![text("ok")]),
        ]);
        let expected_item_id = format!("fc_{}", short_hash("foreign/item with spaces"));

        let converted =
            convert_responses_messages(&target, &ctx, &allowed_openai_tool_call_providers(), None)
                .unwrap();

        assert_eq!(
            converted,
            vec![
                json!({
                    "type": "function_call",
                    "id": expected_item_id,
                    "call_id": "call_one",
                    "name": "bash",
                    "arguments": "{}"
                }),
                json!({
                    "type": "function_call_output",
                    "call_id": "call_one",
                    "output": "ok"
                })
            ]
        );
    }

    #[test]
    fn converts_tools_with_default_bool_and_explicit_null_strict_values() {
        let tools = vec![Tool {
            name: "read".to_string(),
            description: "Read a file".to_string(),
            parameters: json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }),
        }];

        assert_eq!(
            convert_responses_tools(&tools, None),
            vec![json!({
                "type": "function",
                "name": "read",
                "description": "Read a file",
                "parameters": {
                    "type": "object",
                    "properties": { "path": { "type": "string" } },
                    "required": ["path"]
                },
                "strict": false
            })]
        );
        assert_eq!(
            convert_responses_tools(
                &tools,
                Some(&ConvertResponsesToolsOptions {
                    strict: Some(ResponsesToolStrict::Null),
                }),
            ),
            vec![json!({
                "type": "function",
                "name": "read",
                "description": "Read a file",
                "parameters": {
                    "type": "object",
                    "properties": { "path": { "type": "string" } },
                    "required": ["path"]
                },
                "strict": null
            })]
        );
    }

    #[test]
    fn encodes_and_parses_text_signatures_with_legacy_fallbacks() {
        let encoded = encode_text_signature_v1("msg_1", Some(TextPhase::Commentary));
        assert_eq!(encoded, r#"{"v":1,"id":"msg_1","phase":"commentary"}"#);

        assert_eq!(
            parse_text_signature(Some(&encoded)),
            Some(ParsedTextSignature {
                id: "msg_1".to_string(),
                phase: Some(TextPhase::Commentary),
            })
        );
        assert_eq!(
            parse_text_signature(Some(r#"{"v":1,"id":"msg_2","phase":"unknown"}"#)),
            Some(ParsedTextSignature {
                id: "msg_2".to_string(),
                phase: None,
            })
        );
        assert_eq!(
            parse_text_signature(Some("legacy-id")),
            Some(ParsedTextSignature {
                id: "legacy-id".to_string(),
                phase: None,
            })
        );
        assert_eq!(
            parse_text_signature(Some("{not json")),
            Some(ParsedTextSignature {
                id: "{not json".to_string(),
                phase: None,
            })
        );
        assert_eq!(parse_text_signature(None), None);
        assert_eq!(parse_text_signature(Some("")), None);
    }

    #[test]
    fn maps_usage_cost_service_tiers_and_stop_reasons() {
        let target = model(
            "openai",
            "openai-responses",
            "gpt-5.5",
            false,
            vec![ModelInput::Text],
        );
        let mut usage = map_responses_usage(
            &target,
            Some(&json!({
                "input_tokens": 1000,
                "output_tokens": 2000,
                "total_tokens": 3500,
                "input_tokens_details": { "cached_tokens": 500 }
            })),
        )
        .unwrap();

        assert_eq!(usage.input, 500);
        assert_eq!(usage.output, 2000);
        assert_eq!(usage.cache_read, 500);
        assert_eq!(usage.total_tokens, 3500);
        assert_close(usage.cost.input, 0.0025);
        assert_close(usage.cost.output, 0.06);
        assert_close(usage.cost.cache_read, 0.0005);

        apply_service_tier_pricing(&mut usage, Some("priority"), &target);
        assert_close(usage.cost.input, 0.00625);
        assert_close(usage.cost.output, 0.15);
        assert_close(usage.cost.cache_read, 0.00125);
        assert_close(usage.cost.total, 0.1575);

        assert_eq!(
            map_stop_reason(Some("completed")).unwrap(),
            StopReason::Stop
        );
        assert_eq!(
            map_stop_reason(Some("incomplete")).unwrap(),
            StopReason::Length
        );
        assert_eq!(map_stop_reason(Some("failed")).unwrap(), StopReason::Error);
        assert_eq!(
            map_completed_stop_reason(Some("completed"), true).unwrap(),
            StopReason::ToolUse
        );
        assert!(map_stop_reason(Some("new_status")).is_err());
    }

    #[test]
    fn parses_value_backed_response_event_helpers() {
        let event = json!({ "type": "response.output_text.delta", "delta": "hi" });
        assert_eq!(
            responses_stream_event_kind(&event),
            Some(ResponsesStreamEventKind::OutputTextDelta)
        );
        assert_eq!(
            response_event_error_message(&json!({
                "type": "response.failed",
                "response": { "error": { "code": "bad", "message": "Nope" } }
            })),
            Some("bad: Nope".to_string())
        );
        assert_eq!(
            response_output_message_text(&json!({
                "content": [
                    { "type": "output_text", "text": "hello " },
                    { "type": "refusal", "refusal": "no" }
                ]
            })),
            "hello no"
        );
        assert_eq!(
            response_reasoning_item_text(&json!({
                "summary": [{ "text": "a" }, { "text": "b" }],
                "content": [{ "text": "fallback" }]
            })),
            "a\n\nb"
        );
        assert_eq!(
            response_function_call_tool_call(&json!({
                "type": "function_call",
                "id": "fc_1",
                "call_id": "call_1",
                "name": "read",
                "arguments": "{\"path\":\"README.md\"}"
            })),
            Some(ContentBlock::ToolCall {
                id: "call_1|fc_1".to_string(),
                name: "read".to_string(),
                arguments: Map::from_iter([("path".to_string(), json!("README.md"))]),
                thought_signature: None,
            })
        );
    }

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1e-12,
            "expected {actual} to be close to {expected}"
        );
    }
}
