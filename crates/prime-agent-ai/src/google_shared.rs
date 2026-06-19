//! Shared pure helpers for Google Generative AI and Google Vertex payloads.

use serde_json::{Map, Value};

use crate::sanitize_unicode::sanitize_surrogates;
use crate::transform_messages::transform_messages_with_tool_call_id_normalizer;
use crate::types::{
    AssistantMessage, ContentBlock, Context, Message, Model, ModelInput, StopReason, Tool,
    UserContent,
};

/// Thinking level names used by Gemini 3 thinking configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoogleThinkingLevel {
    ThinkingLevelUnspecified,
    Minimal,
    Low,
    Medium,
    High,
}

impl GoogleThinkingLevel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ThinkingLevelUnspecified => "THINKING_LEVEL_UNSPECIFIED",
            Self::Minimal => "MINIMAL",
            Self::Low => "LOW",
            Self::Medium => "MEDIUM",
            Self::High => "HIGH",
        }
    }
}

/// Gemini function calling mode values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoogleToolChoice {
    Auto,
    None,
    Any,
}

impl GoogleToolChoice {
    pub const fn as_mode(self) -> &'static str {
        match self {
            Self::Auto => "AUTO",
            Self::None => "NONE",
            Self::Any => "ANY",
        }
    }
}

/// Options for converting a full context into a Gemini request-like JSON object.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ConvertGoogleContextOptions {
    pub tool_choice: Option<GoogleToolChoice>,
    pub use_parameters: bool,
}

/// `thoughtSignature` alone is not a thinking marker; only `thought: true` is.
pub fn is_thinking_part(part: &Value) -> bool {
    part.get("thought").and_then(Value::as_bool) == Some(true)
}

/// Keep the last non-empty thought signature for a streamed block.
pub fn retain_thought_signature(existing: Option<&str>, incoming: Option<&str>) -> Option<String> {
    incoming
        .filter(|signature| !signature.is_empty())
        .or(existing)
        .map(str::to_string)
}

/// Thought signatures sent to Google APIs are TYPE_BYTES and must be base64.
pub fn is_valid_thought_signature(signature: &str) -> bool {
    if signature.is_empty() || !signature.len().is_multiple_of(4) {
        return false;
    }

    let mut padding = 0usize;
    for ch in signature.chars().rev() {
        if ch == '=' {
            padding += 1;
        } else {
            break;
        }
    }
    if padding > 2 {
        return false;
    }

    let data_len = signature.len().saturating_sub(padding);
    if data_len == 0 {
        return false;
    }

    signature[..data_len]
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '+' || ch == '/')
        && signature[data_len..].chars().all(|ch| ch == '=')
}

/// Only replay valid signatures from the same provider/model.
pub fn resolve_thought_signature(
    is_same_provider_and_model: bool,
    signature: Option<&str>,
) -> Option<String> {
    let signature = signature?;
    (is_same_provider_and_model && is_valid_thought_signature(signature))
        .then(|| signature.to_string())
}

/// Models via Google APIs that require explicit tool call IDs.
pub fn requires_tool_call_id(model_id: &str) -> bool {
    model_id.starts_with("claude-") || model_id.starts_with("gpt-oss-")
}

/// Parse the major version from IDs like `gemini-2.5-flash` or `gemini-live-3`.
pub fn get_gemini_major_version(model_id: &str) -> Option<u32> {
    let lower = model_id.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("gemini-live-")
        .or_else(|| lower.strip_prefix("gemini-"))?;
    let digits = rest
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<u32>().ok()
}

/// Gemini 3+ supports images nested in `functionResponse.parts`.
pub fn supports_multimodal_function_response(model_id: &str) -> bool {
    get_gemini_major_version(model_id).is_none_or(|version| version >= 3)
}

/// Convert internal messages to Gemini `Content[]` JSON values.
pub fn convert_messages(model: &Model, context: &Context) -> Vec<Value> {
    let transformed_messages = transform_messages_with_tool_call_id_normalizer(
        &context.messages,
        model,
        |id, model, _source| normalize_tool_call_id(id, model),
    );
    let mut contents = Vec::new();

    for message in transformed_messages {
        match message {
            Message::User(user) => {
                if let Some(parts) = convert_user_parts(user.content) {
                    contents.push(content_value("user", parts));
                }
            }
            Message::Assistant(assistant) => {
                if let Some(parts) = convert_assistant_parts(model, assistant) {
                    contents.push(content_value("model", parts));
                }
            }
            Message::ToolResult(tool_result) => {
                append_tool_result_content(model, &mut contents, tool_result);
            }
        }
    }

    contents
}

/// Convert a full context into a Gemini request-like JSON object.
///
/// This mirrors the TS providers' shared payload pieces: `contents`,
/// optional `systemInstruction`, optional `tools`, and optional tool choice
/// under `config.toolConfig.functionCallingConfig.mode`.
pub fn convert_context(
    model: &Model,
    context: &Context,
    options: Option<&ConvertGoogleContextOptions>,
) -> Value {
    let options = options.copied().unwrap_or_default();
    let mut request = Map::new();
    request.insert(
        "contents".to_string(),
        Value::Array(convert_messages(model, context)),
    );

    if let Some(system_prompt) = &context.system_prompt {
        request.insert(
            "systemInstruction".to_string(),
            string_value(sanitize_surrogates(system_prompt)),
        );
    }

    let has_tools = context
        .tools
        .as_ref()
        .is_some_and(|tools| !tools.is_empty());
    if let Some(tools) = context
        .tools
        .as_deref()
        .and_then(|tools| convert_tools(tools, options.use_parameters))
    {
        request.insert("tools".to_string(), Value::Array(tools));
    }

    if has_tools && let Some(tool_choice) = options.tool_choice {
        request.insert(
            "config".to_string(),
            object_from_iter([(
                "toolConfig",
                object_from_iter([(
                    "functionCallingConfig",
                    object_from_iter([("mode", string_value(tool_choice.as_mode()))]),
                )]),
            )]),
        );
    }

    Value::Object(request)
}

/// Convert tools to Gemini function declarations.
pub fn convert_tools(tools: &[Tool], use_parameters: bool) -> Option<Vec<Value>> {
    if tools.is_empty() {
        return None;
    }

    let declarations = tools
        .iter()
        .map(|tool| {
            let mut declaration = Map::new();
            declaration.insert("name".to_string(), string_value(&tool.name));
            declaration.insert("description".to_string(), string_value(&tool.description));
            if use_parameters {
                declaration.insert(
                    "parameters".to_string(),
                    sanitize_for_open_api(&tool.parameters),
                );
            } else {
                declaration.insert("parametersJsonSchema".to_string(), tool.parameters.clone());
            }
            Value::Object(declaration)
        })
        .collect::<Vec<_>>();

    Some(vec![object_from_iter([(
        "functionDeclarations",
        Value::Array(declarations),
    )])])
}

/// Map a tool choice string to Gemini's function calling mode.
pub fn map_tool_choice(choice: &str) -> GoogleToolChoice {
    match choice {
        "none" => GoogleToolChoice::None,
        "any" => GoogleToolChoice::Any,
        "auto" => GoogleToolChoice::Auto,
        _ => GoogleToolChoice::Auto,
    }
}

/// Map raw Google finish reason strings to Prime Agent stop reasons.
pub fn map_google_stop_reason(reason: &str) -> StopReason {
    match reason {
        "STOP" => StopReason::Stop,
        "MAX_TOKENS" => StopReason::Length,
        _ => StopReason::Error,
    }
}

fn convert_user_parts(content: UserContent) -> Option<Vec<Value>> {
    match content {
        UserContent::Text(text) => Some(vec![text_part(&text)]),
        UserContent::Blocks(blocks) => {
            let parts = blocks
                .into_iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text, .. } => Some(text_part(&text)),
                    ContentBlock::Image { data, mime_type } => {
                        Some(inline_data_part(&data, &mime_type))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            (!parts.is_empty()).then_some(parts)
        }
    }
}

fn convert_assistant_parts(model: &Model, assistant: AssistantMessage) -> Option<Vec<Value>> {
    let is_same_provider_and_model =
        assistant.provider == model.provider && assistant.model == model.id;
    let mut parts = Vec::new();

    for block in assistant.content {
        match block {
            ContentBlock::Text {
                text,
                text_signature,
            } => {
                if text.trim().is_empty() {
                    continue;
                }
                let mut part = Map::new();
                part.insert("text".to_string(), string_value(sanitize_surrogates(&text)));
                if let Some(signature) =
                    resolve_thought_signature(is_same_provider_and_model, text_signature.as_deref())
                {
                    part.insert("thoughtSignature".to_string(), string_value(signature));
                }
                parts.push(Value::Object(part));
            }
            ContentBlock::Thinking {
                thinking,
                thinking_signature,
                ..
            } => {
                if thinking.trim().is_empty() {
                    continue;
                }
                let mut part = Map::new();
                if is_same_provider_and_model {
                    part.insert("thought".to_string(), Value::Bool(true));
                    part.insert(
                        "text".to_string(),
                        string_value(sanitize_surrogates(&thinking)),
                    );
                    if let Some(signature) = resolve_thought_signature(
                        is_same_provider_and_model,
                        thinking_signature.as_deref(),
                    ) {
                        part.insert("thoughtSignature".to_string(), string_value(signature));
                    }
                } else {
                    part.insert(
                        "text".to_string(),
                        string_value(sanitize_surrogates(&thinking)),
                    );
                }
                parts.push(Value::Object(part));
            }
            ContentBlock::ToolCall {
                id,
                name,
                arguments,
                thought_signature,
            } => {
                let mut function_call = Map::new();
                function_call.insert("name".to_string(), string_value(name));
                function_call.insert("args".to_string(), Value::Object(arguments));
                if requires_tool_call_id(&model.id) {
                    function_call.insert("id".to_string(), string_value(id));
                }

                let mut part = Map::new();
                part.insert("functionCall".to_string(), Value::Object(function_call));
                if let Some(signature) = resolve_thought_signature(
                    is_same_provider_and_model,
                    thought_signature.as_deref(),
                ) {
                    part.insert("thoughtSignature".to_string(), string_value(signature));
                }
                parts.push(Value::Object(part));
            }
            ContentBlock::Image { .. } => {}
        }
    }

    (!parts.is_empty()).then_some(parts)
}

fn append_tool_result_content(
    model: &Model,
    contents: &mut Vec<Value>,
    tool_result: crate::types::ToolResultMessage,
) {
    let text_result = tool_result
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let image_content = if model.input.contains(&ModelInput::Image) {
        tool_result
            .content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Image { data, mime_type } => {
                    Some((data.as_str(), mime_type.as_str()))
                }
                _ => None,
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    let has_text = !text_result.is_empty();
    let has_images = !image_content.is_empty();
    let supports_multimodal = supports_multimodal_function_response(&model.id);
    let response_value = if has_text {
        sanitize_surrogates(&text_result)
    } else if has_images {
        "(see attached image)".to_string()
    } else {
        String::new()
    };
    let image_parts = image_content
        .iter()
        .map(|(data, mime_type)| inline_data_part(data, mime_type))
        .collect::<Vec<_>>();

    let mut response = Map::new();
    response.insert(
        if tool_result.is_error {
            "error"
        } else {
            "output"
        }
        .to_string(),
        string_value(response_value),
    );

    let mut function_response = Map::new();
    function_response.insert("name".to_string(), string_value(tool_result.tool_name));
    function_response.insert("response".to_string(), Value::Object(response));
    if has_images && supports_multimodal {
        function_response.insert("parts".to_string(), Value::Array(image_parts.clone()));
    }
    if requires_tool_call_id(&model.id) {
        function_response.insert("id".to_string(), string_value(tool_result.tool_call_id));
    }

    let function_response_part =
        object_from_iter([("functionResponse", Value::Object(function_response))]);

    if let Some(last_content) = contents.last_mut()
        && content_has_function_response(last_content)
        && let Some(parts) = last_content.get_mut("parts").and_then(Value::as_array_mut)
    {
        parts.push(function_response_part);
    } else {
        contents.push(content_value("user", vec![function_response_part]));
    }

    if has_images && !supports_multimodal {
        let mut parts = vec![text_part("Tool result image:")];
        parts.extend(image_parts);
        contents.push(content_value("user", parts));
    }
}

fn content_has_function_response(content: &Value) -> bool {
    content.get("role").and_then(Value::as_str) == Some("user")
        && content
            .get("parts")
            .and_then(Value::as_array)
            .is_some_and(|parts| {
                parts
                    .iter()
                    .any(|part| part.get("functionResponse").is_some())
            })
}

fn normalize_tool_call_id(id: &str, model: &Model) -> String {
    if !requires_tool_call_id(&model.id) {
        return id.to_string();
    }

    id.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .take(64)
        .collect()
}

fn sanitize_for_open_api(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| !is_json_schema_meta_declaration(key))
                .map(|(key, value)| (key.clone(), sanitize_for_open_api(value)))
                .collect(),
        ),
        _ => schema.clone(),
    }
}

fn is_json_schema_meta_declaration(key: &str) -> bool {
    matches!(
        key,
        "$schema"
            | "$id"
            | "$anchor"
            | "$dynamicAnchor"
            | "$vocabulary"
            | "$comment"
            | "$defs"
            | "definitions"
    )
}

fn content_value(role: &str, parts: Vec<Value>) -> Value {
    object_from_iter([("role", string_value(role)), ("parts", Value::Array(parts))])
}

fn text_part(text: &str) -> Value {
    object_from_iter([("text", string_value(sanitize_surrogates(text)))])
}

fn inline_data_part(data: &str, mime_type: &str) -> Value {
    object_from_iter([(
        "inlineData",
        object_from_iter([
            ("mimeType", string_value(mime_type)),
            ("data", string_value(data)),
        ]),
    )])
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

    use crate::types::{
        AssistantMessage, Cost, ModelPricing, ToolResultMessage, Usage, UserMessage,
    };

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
            max_tokens: 8192,
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
            tool_name: "read".to_string(),
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

    fn thinking(text: &str, signature: Option<&str>) -> ContentBlock {
        ContentBlock::Thinking {
            thinking: text.to_string(),
            thinking_signature: signature.map(str::to_string),
            redacted: None,
        }
    }

    fn tool_call(id: &str, name: &str, arguments: Map<String, Value>) -> ContentBlock {
        ContentBlock::ToolCall {
            id: id.to_string(),
            name: name.to_string(),
            arguments,
            thought_signature: None,
        }
    }

    fn tool_call_with_signature(id: &str, signature: &str) -> ContentBlock {
        ContentBlock::ToolCall {
            id: id.to_string(),
            name: "bash".to_string(),
            arguments: Map::from_iter([("command".to_string(), json!("echo hi"))]),
            thought_signature: Some(signature.to_string()),
        }
    }

    fn image(data: &str) -> ContentBlock {
        ContentBlock::Image {
            data: data.to_string(),
            mime_type: "image/png".to_string(),
        }
    }

    #[test]
    fn google_shared_thought_signature_helpers_match_google_semantics() {
        assert!(is_thinking_part(
            &json!({ "thought": true, "thoughtSignature": "sig" })
        ));
        assert!(!is_thinking_part(&json!({ "thoughtSignature": "sig" })));
        assert!(!is_thinking_part(
            &json!({ "thought": false, "thoughtSignature": "sig" })
        ));

        let retained = retain_thought_signature(None, Some("sig-1"));
        assert_eq!(retained.as_deref(), Some("sig-1"));
        let retained = retain_thought_signature(retained.as_deref(), None);
        assert_eq!(retained.as_deref(), Some("sig-1"));
        let retained = retain_thought_signature(retained.as_deref(), Some(""));
        assert_eq!(retained.as_deref(), Some("sig-1"));
        assert_eq!(
            retain_thought_signature(retained.as_deref(), Some("sig-2")).as_deref(),
            Some("sig-2")
        );

        assert!(is_valid_thought_signature("AAAAAAAAAAAAAAAAAAAAAA=="));
        assert!(!is_valid_thought_signature("not base64"));
        assert!(!is_valid_thought_signature("AAA"));
        assert_eq!(
            resolve_thought_signature(true, Some("AAAAAAAAAAAAAAAAAAAAAA==")).as_deref(),
            Some("AAAAAAAAAAAAAAAAAAAAAA==")
        );
        assert_eq!(
            resolve_thought_signature(false, Some("AAAAAAAAAAAAAAAAAAAAAA==")),
            None
        );
    }

    #[test]
    fn google_shared_tool_call_id_requirements_and_version_gates_match_ts_helper() {
        assert!(requires_tool_call_id("claude-sonnet-4"));
        assert!(requires_tool_call_id("gpt-oss-120b"));
        assert!(!requires_tool_call_id("gemini-3-pro-preview"));

        assert_eq!(get_gemini_major_version("gemini-2.5-flash"), Some(2));
        assert_eq!(get_gemini_major_version("Gemini-Live-3-preview"), Some(3));
        assert_eq!(get_gemini_major_version("claude-sonnet-4"), None);
        assert!(!supports_multimodal_function_response("gemini-2.5-flash"));
        assert!(supports_multimodal_function_response(
            "gemini-3-pro-preview"
        ));
        assert!(supports_multimodal_function_response("claude-sonnet-4"));

        let target = model(
            "google",
            "google-generative-ai",
            "claude-sonnet-4",
            vec![ModelInput::Text],
        );
        let ctx = context(vec![assistant(
            "other",
            "other-api",
            "foreign",
            vec![tool_call(
                "call|with!invalid/chars-and-a-very-long-suffix-that-will-be-truncated-after-sixty-four-bytes",
                "bash",
                Map::new(),
            )],
        )]);

        let contents = convert_messages(&target, &ctx);
        assert_eq!(
            contents[0]["parts"][0]["functionCall"]["id"],
            json!("call_with_invalid_chars-and-a-very-long-suffix-that-will-be-trun")
        );
    }

    #[test]
    fn google_shared_convert_messages_keeps_valid_same_provider_signatures_only() {
        let target = model(
            "google",
            "google-generative-ai",
            "gemini-3-pro-preview",
            vec![ModelInput::Text],
        );
        let valid_sig = "AAAAAAAAAAAAAAAAAAAAAA==";
        let ctx = context(vec![
            assistant(
                "google",
                "google-generative-ai",
                "gemini-3-pro-preview",
                vec![
                    thinking("why", Some(valid_sig)),
                    text_with_signature("answer", valid_sig),
                    tool_call_with_signature("call_1", valid_sig),
                    text_with_signature("invalid", "not base64"),
                ],
            ),
            assistant(
                "google",
                "google-generative-ai",
                "other-model",
                vec![text_with_signature("old answer", valid_sig)],
            ),
        ]);

        let contents = convert_messages(&target, &ctx);

        assert_eq!(contents[0]["role"], json!("model"));
        assert_eq!(contents[0]["parts"][0]["thought"], json!(true));
        assert_eq!(
            contents[0]["parts"][0]["thoughtSignature"],
            json!(valid_sig)
        );
        assert_eq!(
            contents[0]["parts"][1]["thoughtSignature"],
            json!(valid_sig)
        );
        assert_eq!(
            contents[0]["parts"][2]["thoughtSignature"],
            json!(valid_sig)
        );
        assert!(contents[0]["parts"][3].get("thoughtSignature").is_none());
        assert!(contents[1]["parts"][0].get("thoughtSignature").is_none());
    }

    #[test]
    fn google_shared_routes_tool_result_images_by_gemini_major_version() {
        let make_ctx = |model: &Model| {
            context(vec![
                user_text("read the files"),
                assistant(
                    &model.provider,
                    &model.api,
                    &model.id,
                    vec![
                        tool_call("call_a", "read", Map::new()),
                        tool_call("call_img", "read", Map::new()),
                        tool_call("call_b", "read", Map::new()),
                    ],
                ),
                tool_result("call_a", vec![text("alpha text")]),
                tool_result("call_img", vec![image("abc")]),
                tool_result("call_b", vec![text("beta text")]),
            ])
        };
        let gemini_2 = model(
            "google",
            "google-generative-ai",
            "gemini-2.5-flash",
            vec![ModelInput::Text, ModelInput::Image],
        );
        let gemini_3 = model(
            "google",
            "google-generative-ai",
            "gemini-3-pro-preview",
            vec![ModelInput::Text, ModelInput::Image],
        );

        let contents = convert_messages(&gemini_2, &make_ctx(&gemini_2));
        assert_eq!(contents.len(), 5);
        assert!(
            contents[2]["parts"]
                .as_array()
                .unwrap()
                .iter()
                .all(|part| part.get("functionResponse").is_some())
        );
        assert_eq!(contents[3]["parts"][0]["text"], json!("Tool result image:"));
        assert!(contents[3]["parts"][1].get("inlineData").is_some());
        assert!(contents[4]["parts"][0].get("functionResponse").is_some());

        let contents = convert_messages(&gemini_3, &make_ctx(&gemini_3));
        assert_eq!(contents.len(), 3);
        assert_eq!(contents[2]["parts"].as_array().unwrap().len(), 3);
        assert_eq!(
            contents[2]["parts"][1]["functionResponse"]["parts"][0]["inlineData"]["data"],
            json!("abc")
        );
    }

    #[test]
    fn google_shared_convert_context_includes_contents_system_tools_and_tool_choice() {
        let target = model(
            "google",
            "google-generative-ai",
            "gemini-3-pro-preview",
            vec![ModelInput::Text, ModelInput::Image],
        );
        let mut ctx = context(vec![
            Message::User(UserMessage {
                content: UserContent::Blocks(vec![text("look"), image("pngdata")]),
                timestamp: 1,
            }),
            assistant(
                "google",
                "google-generative-ai",
                "gemini-3-pro-preview",
                vec![ContentBlock::Text {
                    text: "I will read it".to_string(),
                    text_signature: None,
                }],
            ),
        ]);
        ctx.system_prompt = Some("Follow policy".to_string());
        ctx.tools = Some(vec![Tool {
            name: "read".to_string(),
            description: "Read a file".to_string(),
            parameters: json!({
                "$schema": "http://json-schema.org/draft-07/schema#",
                "$defs": { "path": { "type": "string" } },
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }),
        }]);

        let converted = convert_context(
            &target,
            &ctx,
            Some(&ConvertGoogleContextOptions {
                tool_choice: Some(map_tool_choice("any")),
                use_parameters: true,
            }),
        );

        assert_eq!(
            converted,
            json!({
                "contents": [
                    {
                        "role": "user",
                        "parts": [
                            { "text": "look" },
                            { "inlineData": { "mimeType": "image/png", "data": "pngdata" } }
                        ]
                    },
                    {
                        "role": "model",
                        "parts": [{ "text": "I will read it" }]
                    }
                ],
                "systemInstruction": "Follow policy",
                "tools": [{
                    "functionDeclarations": [{
                        "name": "read",
                        "description": "Read a file",
                        "parameters": {
                            "type": "object",
                            "properties": { "path": { "type": "string" } },
                            "required": ["path"]
                        }
                    }]
                }],
                "config": {
                    "toolConfig": {
                        "functionCallingConfig": {
                            "mode": "ANY"
                        }
                    }
                }
            })
        );
    }
}
