use std::collections::{HashMap, HashSet};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

use crate::openai_responses_shared::{
    OpenAIResponsesSharedError, apply_service_tier_pricing, convert_responses_messages,
    convert_responses_tools, map_completed_stop_reason, map_responses_usage,
    response_function_call_tool_call, response_output_message_text,
    response_output_message_text_signature, response_reasoning_item_text,
};
use crate::stream::{
    ApiProvider, AssistantMessageEventStream, StreamError, StreamOptions, StreamResult,
    create_assistant_message_event_stream,
};
use crate::types::{
    AssistantMessage, AssistantMessageEvent, ContentBlock, Context, Model, StopReason,
    ThinkingLevel, Usage,
};

const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const OPENAI_RESPONSES_API: &str = "openai-responses";

pub fn openai_responses_api_provider() -> ApiProvider {
    ApiProvider::new(
        OPENAI_RESPONSES_API,
        stream_openai_responses,
        |model, context, options| {
            let stream_options = options.map(|options| &options.stream);
            stream_openai_responses(model, context, stream_options)
        },
    )
}

fn stream_openai_responses(
    model: &Model,
    context: &Context,
    options: Option<&StreamOptions>,
) -> StreamResult<AssistantMessageEventStream> {
    let response = send_openai_responses_request(model, context, options)?;
    let message = parse_openai_responses_message(model, &response)?;
    Ok(event_stream_from_message(message))
}

fn send_openai_responses_request(
    model: &Model,
    context: &Context,
    options: Option<&StreamOptions>,
) -> StreamResult<Value> {
    let api_key = options
        .and_then(|options| options.api_key.as_deref())
        .filter(|api_key| !api_key.trim().is_empty())
        .ok_or_else(|| StreamError::Provider("No OpenAI API key provided".to_string()))?;
    let body = openai_responses_request_body(model, context, options)?;
    let timeout = options
        .and_then(|options| options.timeout_ms)
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_secs(600));
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| StreamError::Provider(format!("Failed to create HTTP client: {error}")))?;
    let mut request = client
        .post(openai_responses_url(model))
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
        StreamError::Provider(format!("OpenAI Responses request failed: {error}"))
    })?;
    let status = response.status();
    let text = response.text().map_err(|error| {
        StreamError::Provider(format!("Failed to read OpenAI response: {error}"))
    })?;
    let parsed = serde_json::from_str::<Value>(&text).map_err(|error| {
        StreamError::Provider(format!(
            "OpenAI Responses returned invalid JSON (status {}): {error}",
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

fn openai_responses_request_body(
    model: &Model,
    context: &Context,
    options: Option<&StreamOptions>,
) -> StreamResult<Value> {
    let allowed_tool_call_providers = HashSet::from([model.provider.clone()]);
    let input = convert_responses_messages(model, context, &allowed_tool_call_providers, None)
        .map_err(shared_error)?;
    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(model.id.clone()));
    body.insert("input".to_string(), Value::Array(input));
    body.insert("stream".to_string(), Value::Bool(false));

    if let Some(tools) = context.tools.as_ref().filter(|tools| !tools.is_empty()) {
        body.insert(
            "tools".to_string(),
            Value::Array(convert_responses_tools(tools, None)),
        );
    }

    if let Some(options) = options {
        if let Some(max_tokens) = options.max_tokens {
            body.insert("max_output_tokens".to_string(), json!(max_tokens));
        }
        if let Some(temperature) = options.temperature {
            body.insert("temperature".to_string(), json!(temperature));
        }
        if let Some(metadata) = &options.metadata {
            body.insert("metadata".to_string(), Value::Object(metadata.clone()));
        }
        for (key, value) in &options.extra {
            body.insert(key.clone(), value.clone());
        }
    }

    Ok(Value::Object(body))
}

fn parse_openai_responses_message(
    model: &Model,
    response: &Value,
) -> StreamResult<AssistantMessage> {
    if response.get("error").is_some() {
        return Ok(error_message(model, openai_error_message(200, response)));
    }

    let mut content = Vec::new();
    let mut has_tool_calls = false;
    for item in response
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match item.get("type").and_then(Value::as_str) {
            Some("message") => {
                let text = response_output_message_text(item);
                if !text.is_empty() {
                    content.push(ContentBlock::Text {
                        text,
                        text_signature: response_output_message_text_signature(item),
                    });
                }
            }
            Some("reasoning") => {
                let thinking = response_reasoning_item_text(item);
                if !thinking.is_empty() {
                    content.push(ContentBlock::Thinking {
                        thinking,
                        thinking_signature: serde_json::to_string(item).ok(),
                        redacted: None,
                    });
                }
            }
            Some("function_call") => {
                if let Some(tool_call) = response_function_call_tool_call(item) {
                    has_tool_calls = true;
                    content.push(tool_call);
                }
            }
            _ => {}
        }
    }

    let status = response.get("status").and_then(Value::as_str);
    let mut usage = map_responses_usage(model, response.get("usage")).unwrap_or_default();
    apply_service_tier_pricing(
        &mut usage,
        response.get("service_tier").and_then(Value::as_str),
        model,
    );
    let stop_reason = map_completed_stop_reason(status, has_tool_calls).map_err(shared_error)?;
    let error_message = response_error_details(response);

    Ok(AssistantMessage {
        content,
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
        usage,
        stop_reason: if error_message.is_some() {
            StopReason::Error
        } else {
            stop_reason
        },
        error_message,
        timestamp: current_timestamp_millis(),
    })
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

fn openai_responses_url(model: &Model) -> String {
    let base_url = if model.base_url.trim().is_empty() {
        DEFAULT_OPENAI_BASE_URL
    } else {
        model.base_url.trim()
    };
    format!("{}/responses", base_url.trim_end_matches('/'))
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

fn response_error_details(response: &Value) -> Option<String> {
    let error = response.get("error").or_else(|| {
        response
            .get("response")
            .and_then(|response| response.get("error"))
    })?;
    Some(error_object_message(error))
}

fn openai_error_message(status: u16, response: &Value) -> String {
    let detail = response_error_details(response).unwrap_or_else(|| response.to_string());
    if status == 200 {
        detail
    } else {
        format!("OpenAI Responses HTTP {status}: {detail}")
    }
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

fn shared_error(error: OpenAIResponsesSharedError) -> StreamError {
    StreamError::Provider(error.to_string())
}

fn current_timestamp_millis() -> i64 {
    let Ok(duration) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return 0;
    };
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

#[allow(dead_code)]
fn thinking_level_as_str(level: ThinkingLevel) -> &'static str {
    match level {
        ThinkingLevel::Minimal => "minimal",
        ThinkingLevel::Low => "low",
        ThinkingLevel::Medium => "medium",
        ThinkingLevel::High => "high",
        ThinkingLevel::Xhigh => "high",
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::types::{Message, ModelInput, ModelPricing, UserContent, UserMessage};

    fn model() -> Model {
        Model {
            id: "gpt-4o".to_string(),
            name: "GPT-4o".to_string(),
            api: OPENAI_RESPONSES_API.to_string(),
            provider: "openai".to_string(),
            base_url: String::new(),
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

    fn context() -> Context {
        Context {
            system_prompt: Some("be brief".to_string()),
            messages: vec![Message::User(UserMessage {
                content: UserContent::Text("hello".to_string()),
                timestamp: 1,
            })],
            tools: None,
        }
    }

    #[test]
    fn builds_non_streaming_responses_request_body() {
        let options = StreamOptions {
            max_tokens: Some(123),
            temperature: Some(0.2),
            ..StreamOptions::default()
        };

        let body = openai_responses_request_body(&model(), &context(), Some(&options)).unwrap();

        assert_eq!(body["model"], "gpt-4o");
        assert_eq!(body["stream"], false);
        assert_eq!(body["max_output_tokens"], 123);
        assert_eq!(body["temperature"], 0.2);
        assert_eq!(body["input"][0]["role"], "system");
        assert_eq!(body["input"][1]["role"], "user");
    }

    #[test]
    fn parses_completed_message_response() {
        let response = json!({
            "id": "resp_123",
            "model": "gpt-4o-2026-01-01",
            "status": "completed",
            "output": [{
                "id": "msg_1",
                "type": "message",
                "content": [{
                    "type": "output_text",
                    "text": "hello back"
                }]
            }],
            "usage": {
                "input_tokens": 10,
                "output_tokens": 3,
                "total_tokens": 13,
                "input_tokens_details": { "cached_tokens": 2 }
            }
        });

        let message = parse_openai_responses_message(&model(), &response).unwrap();

        assert_eq!(message.response_id.as_deref(), Some("resp_123"));
        assert_eq!(message.response_model.as_deref(), Some("gpt-4o-2026-01-01"));
        assert_eq!(message.stop_reason, StopReason::Stop);
        assert_eq!(message.usage.input, 8);
        assert_eq!(message.usage.cache_read, 2);
        assert_eq!(message.usage.output, 3);
        assert_eq!(
            message.content,
            vec![ContentBlock::Text {
                text: "hello back".to_string(),
                text_signature: Some("{\"v\":1,\"id\":\"msg_1\"}".to_string()),
            }]
        );
    }
}
