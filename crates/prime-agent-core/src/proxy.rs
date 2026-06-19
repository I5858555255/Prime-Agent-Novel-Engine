use std::collections::{BTreeMap, HashMap};
use std::error::Error;
use std::fmt;

use prime_agent_ai::{
    AssistantMessage, AssistantMessageEvent, CacheRetention, ContentBlock, Model,
    SimpleStreamOptions, StopReason, ThinkingBudgets, ThinkingLevel, Transport, Usage,
    parse_streaming_json,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxySerializableStreamOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ThinkingLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_retention: Option<CacheRetention>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<Transport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_budgets: Option<ThinkingBudgets>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_retry_delay_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ProxyAssistantMessageEvent {
    Start,
    TextStart {
        content_index: usize,
    },
    TextDelta {
        content_index: usize,
        delta: String,
    },
    TextEnd {
        content_index: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        content_signature: Option<String>,
    },
    ThinkingStart {
        content_index: usize,
    },
    ThinkingDelta {
        content_index: usize,
        delta: String,
    },
    ThinkingEnd {
        content_index: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        content_signature: Option<String>,
    },
    ToolcallStart {
        content_index: usize,
        id: String,
        tool_name: String,
    },
    ToolcallDelta {
        content_index: usize,
        delta: String,
    },
    ToolcallEnd {
        content_index: usize,
    },
    Done {
        reason: StopReason,
        usage: Usage,
    },
    Error {
        reason: StopReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        error_message: Option<String>,
        usage: Usage,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyEventError {
    TextDeltaForNonText,
    TextEndForNonText,
    ThinkingDeltaForNonThinking,
    ThinkingEndForNonThinking,
    ToolcallDeltaForNonToolCall,
}

impl fmt::Display for ProxyEventError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::TextDeltaForNonText => "Received text_delta for non-text content",
            Self::TextEndForNonText => "Received text_end for non-text content",
            Self::ThinkingDeltaForNonThinking => "Received thinking_delta for non-thinking content",
            Self::ThinkingEndForNonThinking => "Received thinking_end for non-thinking content",
            Self::ToolcallDeltaForNonToolCall => "Received toolcall_delta for non-toolCall content",
        };
        f.write_str(message)
    }
}

impl Error for ProxyEventError {}

#[derive(Debug, Clone, PartialEq)]
pub struct ProxyMessageAccumulator {
    partial: AssistantMessage,
    tool_call_json: BTreeMap<usize, String>,
}

impl ProxyMessageAccumulator {
    pub fn new(model: &Model, timestamp: i64) -> Self {
        Self {
            partial: initial_proxy_partial(model, timestamp),
            tool_call_json: BTreeMap::new(),
        }
    }

    pub fn partial(&self) -> &AssistantMessage {
        &self.partial
    }

    pub fn into_partial(self) -> AssistantMessage {
        self.partial
    }

    pub fn process_event(
        &mut self,
        event: ProxyAssistantMessageEvent,
    ) -> Result<Option<AssistantMessageEvent>, ProxyEventError> {
        process_proxy_event(event, &mut self.partial, &mut self.tool_call_json)
    }
}

pub fn build_proxy_request_options(
    options: &SimpleStreamOptions,
) -> ProxySerializableStreamOptions {
    ProxySerializableStreamOptions {
        temperature: options.stream.temperature,
        max_tokens: options.stream.max_tokens,
        reasoning: options.reasoning,
        cache_retention: options.stream.cache_retention,
        session_id: options.stream.session_id.clone(),
        headers: options.stream.headers.clone(),
        metadata: options.stream.metadata.clone(),
        transport: options.stream.transport,
        thinking_budgets: options.thinking_budgets.clone(),
        max_retry_delay_ms: options.stream.max_retry_delay_ms,
    }
}

pub fn initial_proxy_partial(model: &Model, timestamp: i64) -> AssistantMessage {
    AssistantMessage {
        content: Vec::new(),
        api: model.api.clone(),
        provider: model.provider.clone(),
        model: model.id.clone(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: Usage::default(),
        stop_reason: StopReason::Stop,
        error_message: None,
        timestamp,
    }
}

pub fn process_proxy_event(
    event: ProxyAssistantMessageEvent,
    partial: &mut AssistantMessage,
    tool_call_json: &mut BTreeMap<usize, String>,
) -> Result<Option<AssistantMessageEvent>, ProxyEventError> {
    match event {
        ProxyAssistantMessageEvent::Start => Ok(Some(AssistantMessageEvent::Start {
            partial: partial.clone(),
        })),
        ProxyAssistantMessageEvent::TextStart { content_index } => {
            set_content(
                &mut partial.content,
                content_index,
                ContentBlock::Text {
                    text: String::new(),
                    text_signature: None,
                },
            );
            Ok(Some(AssistantMessageEvent::TextStart {
                content_index,
                partial: partial.clone(),
            }))
        }
        ProxyAssistantMessageEvent::TextDelta {
            content_index,
            delta,
        } => match partial.content.get_mut(content_index) {
            Some(ContentBlock::Text { text, .. }) => {
                text.push_str(&delta);
                Ok(Some(AssistantMessageEvent::TextDelta {
                    content_index,
                    delta,
                    partial: partial.clone(),
                }))
            }
            _ => Err(ProxyEventError::TextDeltaForNonText),
        },
        ProxyAssistantMessageEvent::TextEnd {
            content_index,
            content_signature,
        } => match partial.content.get_mut(content_index) {
            Some(ContentBlock::Text {
                text,
                text_signature,
            }) => {
                *text_signature = content_signature;
                Ok(Some(AssistantMessageEvent::TextEnd {
                    content_index,
                    content: text.clone(),
                    partial: partial.clone(),
                }))
            }
            _ => Err(ProxyEventError::TextEndForNonText),
        },
        ProxyAssistantMessageEvent::ThinkingStart { content_index } => {
            set_content(
                &mut partial.content,
                content_index,
                ContentBlock::Thinking {
                    thinking: String::new(),
                    thinking_signature: None,
                    redacted: None,
                },
            );
            Ok(Some(AssistantMessageEvent::ThinkingStart {
                content_index,
                partial: partial.clone(),
            }))
        }
        ProxyAssistantMessageEvent::ThinkingDelta {
            content_index,
            delta,
        } => match partial.content.get_mut(content_index) {
            Some(ContentBlock::Thinking { thinking, .. }) => {
                thinking.push_str(&delta);
                Ok(Some(AssistantMessageEvent::ThinkingDelta {
                    content_index,
                    delta,
                    partial: partial.clone(),
                }))
            }
            _ => Err(ProxyEventError::ThinkingDeltaForNonThinking),
        },
        ProxyAssistantMessageEvent::ThinkingEnd {
            content_index,
            content_signature,
        } => match partial.content.get_mut(content_index) {
            Some(ContentBlock::Thinking {
                thinking,
                thinking_signature,
                ..
            }) => {
                *thinking_signature = content_signature;
                Ok(Some(AssistantMessageEvent::ThinkingEnd {
                    content_index,
                    content: thinking.clone(),
                    partial: partial.clone(),
                }))
            }
            _ => Err(ProxyEventError::ThinkingEndForNonThinking),
        },
        ProxyAssistantMessageEvent::ToolcallStart {
            content_index,
            id,
            tool_name,
        } => {
            tool_call_json.insert(content_index, String::new());
            set_content(
                &mut partial.content,
                content_index,
                ContentBlock::ToolCall {
                    id,
                    name: tool_name,
                    arguments: Map::new(),
                    thought_signature: None,
                },
            );
            Ok(Some(AssistantMessageEvent::ToolcallStart {
                content_index,
                partial: partial.clone(),
            }))
        }
        ProxyAssistantMessageEvent::ToolcallDelta {
            content_index,
            delta,
        } => match partial.content.get_mut(content_index) {
            Some(ContentBlock::ToolCall { arguments, .. }) => {
                let partial_json = tool_call_json.entry(content_index).or_default();
                partial_json.push_str(&delta);
                *arguments = parse_streaming_json(Some(partial_json))
                    .as_object()
                    .cloned()
                    .unwrap_or_default();
                Ok(Some(AssistantMessageEvent::ToolcallDelta {
                    content_index,
                    delta,
                    partial: partial.clone(),
                }))
            }
            _ => Err(ProxyEventError::ToolcallDeltaForNonToolCall),
        },
        ProxyAssistantMessageEvent::ToolcallEnd { content_index } => {
            tool_call_json.remove(&content_index);
            match partial.content.get(content_index) {
                Some(ContentBlock::ToolCall { .. }) => {
                    Ok(Some(AssistantMessageEvent::ToolcallEnd {
                        content_index,
                        tool_call: partial.content[content_index].clone(),
                        partial: partial.clone(),
                    }))
                }
                _ => Ok(None),
            }
        }
        ProxyAssistantMessageEvent::Done { reason, usage } => {
            partial.stop_reason = reason;
            partial.usage = usage;
            Ok(Some(AssistantMessageEvent::Done {
                message: partial.clone(),
            }))
        }
        ProxyAssistantMessageEvent::Error {
            reason,
            error_message,
            usage,
        } => {
            partial.stop_reason = reason;
            partial.error_message = error_message;
            partial.usage = usage;
            Ok(Some(AssistantMessageEvent::Error {
                message: partial.clone(),
            }))
        }
    }
}

fn set_content(content: &mut Vec<ContentBlock>, index: usize, block: ContentBlock) {
    if index >= content.len() {
        content.resize_with(index + 1, || ContentBlock::text(""));
    }
    content[index] = block;
}

#[cfg(test)]
mod tests {
    use prime_agent_ai::{Cost, StreamOptions};
    use serde_json::json;

    use super::*;

    fn model() -> Model {
        Model {
            id: "proxy-model".to_string(),
            api: "proxy-api".to_string(),
            provider: "proxy-provider".to_string(),
            ..Model::default()
        }
    }

    fn usage(input: u64, output: u64) -> Usage {
        Usage {
            input,
            output,
            total_tokens: input + output,
            cost: Cost::default(),
            ..Usage::default()
        }
    }

    #[test]
    fn build_proxy_request_options_keeps_only_serializable_stream_fields() {
        let mut metadata = Map::new();
        metadata.insert("trace".to_string(), Value::Bool(true));
        let options = SimpleStreamOptions {
            stream: StreamOptions {
                temperature: Some(0.2),
                max_tokens: Some(100),
                api_key: Some("secret".to_string()),
                transport: Some(Transport::Sse),
                cache_retention: Some(CacheRetention::Short),
                session_id: Some("session".to_string()),
                max_retry_delay_ms: Some(500),
                metadata: Some(metadata),
                ..StreamOptions::default()
            },
            reasoning: Some(ThinkingLevel::Low),
            thinking_budgets: Some(ThinkingBudgets {
                minimal: None,
                low: Some(64),
                medium: None,
                high: None,
            }),
        };

        let value = serde_json::to_value(build_proxy_request_options(&options)).unwrap();

        assert_eq!(value["temperature"], 0.2);
        assert_eq!(value["maxTokens"], 100);
        assert_eq!(value["reasoning"], "low");
        assert_eq!(value["cacheRetention"], "short");
        assert_eq!(value["sessionId"], "session");
        assert_eq!(value["transport"], "sse");
        assert_eq!(value["thinkingBudgets"]["low"], 64);
        assert_eq!(value["maxRetryDelayMs"], 500);
        assert!(value.get("apiKey").is_none());
    }

    #[test]
    fn proxy_accumulator_builds_text_and_done_events() {
        let mut accumulator = ProxyMessageAccumulator::new(&model(), 123);

        assert!(matches!(
            accumulator
                .process_event(ProxyAssistantMessageEvent::Start)
                .unwrap(),
            Some(AssistantMessageEvent::Start { .. })
        ));
        accumulator
            .process_event(ProxyAssistantMessageEvent::TextStart { content_index: 0 })
            .unwrap();
        accumulator
            .process_event(ProxyAssistantMessageEvent::TextDelta {
                content_index: 0,
                delta: "hel".to_string(),
            })
            .unwrap();
        let event = accumulator
            .process_event(ProxyAssistantMessageEvent::TextEnd {
                content_index: 0,
                content_signature: Some("sig".to_string()),
            })
            .unwrap()
            .unwrap();

        assert!(matches!(
            event,
            AssistantMessageEvent::TextEnd {
                content,
                ..
            } if content == "hel"
        ));

        let done = accumulator
            .process_event(ProxyAssistantMessageEvent::Done {
                reason: StopReason::Stop,
                usage: usage(5, 7),
            })
            .unwrap()
            .unwrap();

        let AssistantMessageEvent::Done { message } = done else {
            panic!("expected done event");
        };
        assert_eq!(message.stop_reason, StopReason::Stop);
        assert_eq!(message.usage.total_tokens, 12);
        assert_eq!(message.timestamp, 123);
        assert_eq!(
            message.content[0],
            ContentBlock::Text {
                text: "hel".to_string(),
                text_signature: Some("sig".to_string()),
            }
        );
    }

    #[test]
    fn proxy_accumulator_streams_tool_call_arguments_from_partial_json() {
        let mut accumulator = ProxyMessageAccumulator::new(&model(), 0);
        accumulator
            .process_event(ProxyAssistantMessageEvent::ToolcallStart {
                content_index: 0,
                id: "call_1".to_string(),
                tool_name: "bash".to_string(),
            })
            .unwrap();

        accumulator
            .process_event(ProxyAssistantMessageEvent::ToolcallDelta {
                content_index: 0,
                delta: r#"{"cmd":"ec"#.to_string(),
            })
            .unwrap();
        accumulator
            .process_event(ProxyAssistantMessageEvent::ToolcallDelta {
                content_index: 0,
                delta: r#"ho"}"#.to_string(),
            })
            .unwrap();

        let ContentBlock::ToolCall { arguments, .. } = &accumulator.partial().content[0] else {
            panic!("expected tool call content");
        };
        assert_eq!(arguments.get("cmd"), Some(&json!("echo")));

        let end = accumulator
            .process_event(ProxyAssistantMessageEvent::ToolcallEnd { content_index: 0 })
            .unwrap()
            .unwrap();
        assert!(matches!(
            end,
            AssistantMessageEvent::ToolcallEnd {
                tool_call: ContentBlock::ToolCall { .. },
                ..
            }
        ));
    }

    #[test]
    fn proxy_accumulator_errors_on_mismatched_delta_types() {
        let mut accumulator = ProxyMessageAccumulator::new(&model(), 0);

        assert_eq!(
            accumulator.process_event(ProxyAssistantMessageEvent::TextDelta {
                content_index: 0,
                delta: "orphan".to_string(),
            }),
            Err(ProxyEventError::TextDeltaForNonText)
        );
    }

    #[test]
    fn proxy_accumulator_error_event_sets_stop_reason_and_message() {
        let mut accumulator = ProxyMessageAccumulator::new(&model(), 0);
        let event = accumulator
            .process_event(ProxyAssistantMessageEvent::Error {
                reason: StopReason::Error,
                error_message: Some("Proxy error".to_string()),
                usage: usage(1, 0),
            })
            .unwrap()
            .unwrap();

        let AssistantMessageEvent::Error { message } = event else {
            panic!("expected error event");
        };
        assert_eq!(message.stop_reason, StopReason::Error);
        assert_eq!(message.error_message.as_deref(), Some("Proxy error"));
        assert_eq!(message.usage.input, 1);
    }

    #[test]
    fn proxy_event_serialization_uses_typescript_field_names() {
        let value = serde_json::to_value(ProxyAssistantMessageEvent::ToolcallStart {
            content_index: 2,
            id: "call_1".to_string(),
            tool_name: "read".to_string(),
        })
        .unwrap();

        assert_eq!(
            value,
            json!({
                "type": "toolcall_start",
                "contentIndex": 2,
                "id": "call_1",
                "toolName": "read"
            })
        );
    }
}
