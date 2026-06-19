use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

use crate::stream::{
    ApiProvider, AssistantMessageEventStream, StreamError, StreamOptions, StreamResult,
    create_assistant_message_event_stream,
};
use crate::types::{
    AssistantMessage, AssistantMessageEvent, ContentBlock, Context, Message, Model, StopReason,
    Usage,
};

const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const OPENAI_COMPLETIONS_API: &str = "openai-completions";

pub fn openai_completions_api_provider() -> ApiProvider {
    ApiProvider::new(
        OPENAI_COMPLETIONS_API,
        stream_openai_completions,
        |model, context, options| {
            let stream_options = options.map(|options| &options.stream);
            stream_openai_completions(model, context, stream_options)
        },
    )
}

fn stream_openai_completions(
    model: &Model,
    context: &Context,
    options: Option<&StreamOptions>,
) -> StreamResult<AssistantMessageEventStream> {
    let response = send_openai_completions_request(model, context, options)?;
    let message = parse_openai_completions_message(model, &response);
    Ok(event_stream_from_message(message))
}

fn send_openai_completions_request(
    model: &Model,
    context: &Context,
    options: Option<&StreamOptions>,
) -> StreamResult<Value> {
    let api_key = options
        .and_then(|options| options.api_key.as_deref())
        .filter(|api_key| !api_key.trim().is_empty())
        .ok_or_else(|| StreamError::Provider("No API key provided".to_string()))?;
    let body = openai_completions_request_body(model, context, options);
    let timeout = options
        .and_then(|options| options.timeout_ms)
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_secs(600));
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| StreamError::Provider(format!("Failed to create HTTP client: {error}")))?;
    let mut request = client
        .post(openai_completions_url(model))
        .bearer_auth(api_key)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .json(&body);

    for (key, value) in model_headers(model)
        .into_iter()
        .chain(option_headers(options))
    {
        request = request.header(key, value);
    }

    let response = request.send().map_err(|error| {
        StreamError::Provider(format!("OpenAI Chat Completions request failed: {error}"))
    })?;
    let status = response.status();
    let text = response.text().map_err(|error| {
        StreamError::Provider(format!("Failed to read Chat Completions response: {error}"))
    })?;
    let parsed = serde_json::from_str::<Value>(&text).map_err(|error| {
        StreamError::Provider(format!(
            "Chat Completions returned invalid JSON (status {}): {error}",
            status.as_u16()
        ))
    })?;

    if !status.is_success() {
        return Err(StreamError::Provider(openai_error_message(
            status.as_u16(),
            &parsed,
        )));
    }

    Ok(parsed)
}

fn openai_completions_request_body(
    model: &Model,
    context: &Context,
    options: Option<&StreamOptions>,
) -> Value {
    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(model.id.clone()));
    body.insert("messages".to_string(), Value::Array(chat_messages(context)));
    body.insert("stream".to_string(), Value::Bool(false));

    if let Some(options) = options {
        if let Some(max_tokens) = options.max_tokens {
            body.insert("max_tokens".to_string(), json!(max_tokens));
        }
        if let Some(temperature) = options.temperature {
            body.insert("temperature".to_string(), json!(temperature));
        }
        for (key, value) in &options.extra {
            body.insert(key.clone(), value.clone());
        }
    }

    Value::Object(body)
}

fn chat_messages(context: &Context) -> Vec<Value> {
    let mut messages = Vec::new();
    if let Some(system_prompt) = context
        .system_prompt
        .as_deref()
        .filter(|system_prompt| !system_prompt.is_empty())
    {
        messages.push(json!({ "role": "system", "content": system_prompt }));
    }

    for message in &context.messages {
        match message {
            Message::User(user) => {
                messages.push(json!({
                    "role": "user",
                    "content": user_content_text(&user.content),
                }));
            }
            Message::Assistant(assistant) => {
                let text = assistant_text(&assistant.content);
                if !text.is_empty() {
                    messages.push(json!({ "role": "assistant", "content": text }));
                }
            }
            Message::ToolResult(tool_result) => {
                let text = assistant_text(&tool_result.content);
                if !text.is_empty() {
                    messages.push(json!({ "role": "tool", "content": text }));
                }
            }
        }
    }

    messages
}

fn parse_openai_completions_message(model: &Model, response: &Value) -> AssistantMessage {
    if let Some(error) = response.get("error") {
        return error_message(model, error_object_message(error));
    }

    let choice = response
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first());
    let text = choice
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let stop_reason = match choice
        .and_then(|choice| choice.get("finish_reason"))
        .and_then(Value::as_str)
    {
        Some("length") => StopReason::Length,
        Some("tool_calls") | Some("function_call") => StopReason::ToolUse,
        Some("content_filter") => StopReason::Error,
        _ => StopReason::Stop,
    };

    AssistantMessage {
        content: if text.is_empty() {
            Vec::new()
        } else {
            vec![ContentBlock::text(text)]
        },
        api: model.api.clone(),
        provider: model.provider.clone(),
        model: model.id.clone(),
        response_model: response
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string),
        response_id: response
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string),
        diagnostics: None,
        usage: chat_usage(model, response.get("usage")),
        stop_reason,
        error_message: None,
        timestamp: current_timestamp_millis(),
    }
}

fn event_stream_from_message(message: AssistantMessage) -> AssistantMessageEventStream {
    let mut stream = create_assistant_message_event_stream();
    if message.stop_reason == StopReason::Error {
        stream.push(AssistantMessageEvent::Error { message });
    } else {
        stream.push(AssistantMessageEvent::Done { message });
    }
    stream
}

fn openai_completions_url(model: &Model) -> String {
    let base_url = if model.base_url.trim().is_empty() {
        DEFAULT_OPENAI_BASE_URL
    } else {
        model.base_url.trim()
    };
    format!("{}/chat/completions", base_url.trim_end_matches('/'))
}

fn user_content_text(content: &crate::types::UserContent) -> String {
    match content {
        crate::types::UserContent::Text(text) => text.clone(),
        crate::types::UserContent::Blocks(blocks) => assistant_text(blocks),
    }
}

fn assistant_text(content: &[ContentBlock]) -> String {
    content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn chat_usage(model: &Model, usage: Option<&Value>) -> Usage {
    let Some(usage) = usage else {
        return Usage::default();
    };
    let mut mapped = Usage {
        input: usage
            .get("prompt_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output: usage
            .get("completion_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        total_tokens: usage
            .get("total_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        ..Usage::default()
    };
    crate::models::calculate_cost(model, &mut mapped);
    mapped
}

fn model_headers(model: &Model) -> HashMap<String, String> {
    model
        .headers
        .as_ref()
        .into_iter()
        .flat_map(|headers| headers.iter())
        .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string())))
        .collect()
}

fn option_headers(options: Option<&StreamOptions>) -> HashMap<String, String> {
    options
        .and_then(|options| options.headers.as_ref())
        .cloned()
        .unwrap_or_default()
}

fn openai_error_message(status: u16, response: &Value) -> String {
    let detail = response
        .get("error")
        .map(error_object_message)
        .unwrap_or_else(|| response.to_string());
    format!("OpenAI Chat Completions HTTP {status}: {detail}")
}

fn error_object_message(error: &Value) -> String {
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Unknown error");
    format!("{code}: {message}")
}

fn error_message(model: &Model, message: String) -> AssistantMessage {
    AssistantMessage {
        content: Vec::new(),
        api: model.api.clone(),
        provider: model.provider.clone(),
        model: model.id.clone(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: Usage::default(),
        stop_reason: StopReason::Error,
        error_message: Some(message),
        timestamp: current_timestamp_millis(),
    }
}

fn current_timestamp_millis() -> i64 {
    let Ok(duration) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return 0;
    };
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ModelInput, ModelPricing, UserContent, UserMessage};

    fn model() -> Model {
        Model {
            id: "z-ai/glm-5.1".to_string(),
            name: "GLM 5.1".to_string(),
            api: OPENAI_COMPLETIONS_API.to_string(),
            provider: "prime-inference".to_string(),
            base_url: "https://api.pinference.ai/api/v1".to_string(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![ModelInput::Text],
            cost: ModelPricing::default(),
            context_window: 128_000,
            max_tokens: 16_000,
            headers: None,
            compat: None,
        }
    }

    #[test]
    fn builds_chat_completions_request_body() {
        let context = Context {
            system_prompt: Some("be brief".to_string()),
            messages: vec![Message::User(UserMessage {
                content: UserContent::Text("hello".to_string()),
                timestamp: 1,
            })],
            tools: None,
        };
        let options = StreamOptions {
            max_tokens: Some(321),
            temperature: Some(0.4),
            ..StreamOptions::default()
        };

        let body = openai_completions_request_body(&model(), &context, Some(&options));

        assert_eq!(body["model"], "z-ai/glm-5.1");
        assert_eq!(body["stream"], false);
        assert_eq!(body["max_tokens"], 321);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["role"], "user");
    }

    #[test]
    fn parses_chat_completion_response() {
        let response = json!({
            "id": "chatcmpl_123",
            "model": "z-ai/glm-5.1",
            "choices": [{
                "finish_reason": "stop",
                "message": { "role": "assistant", "content": "hello back" }
            }],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 4,
                "total_tokens": 14
            }
        });

        let message = parse_openai_completions_message(&model(), &response);

        assert_eq!(message.response_id.as_deref(), Some("chatcmpl_123"));
        assert_eq!(message.stop_reason, StopReason::Stop);
        assert_eq!(message.usage.input, 10);
        assert_eq!(message.usage.output, 4);
        assert_eq!(assistant_text(&message.content), "hello back");
    }
}
