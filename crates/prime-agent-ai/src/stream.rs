pub use crate::event_stream::{
    AssistantMessageEventStream, EventStream, EventStreamError, EventStreamResult,
    create_assistant_message_event_stream,
};
use crate::types::{
    Api, AssistantMessage, Context, Model, ThinkingBudgets, ThinkingLevel, Transport,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::error::Error;
use std::fmt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

pub type StreamResult<T> = Result<T, StreamError>;
pub type StreamFunction<TOptions> = dyn Fn(&Model, &Context, Option<&TOptions>) -> StreamResult<AssistantMessageEventStream>
    + Send
    + Sync
    + 'static;
pub type SessionResourceCleanup =
    dyn Fn(Option<&str>) -> Result<(), Box<dyn Error + Send + Sync>> + Send + Sync + 'static;
type CleanupEntry = (usize, Arc<SessionResourceCleanup>);
type CleanupRegistry = Vec<CleanupEntry>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuiltInApiProviderMetadata {
    pub api: &'static str,
    pub module_specifier: &'static str,
    pub stream_export: &'static str,
    pub stream_simple_export: &'static str,
    pub node_only: bool,
}

pub const BUILT_IN_API_PROVIDER_METADATA: [BuiltInApiProviderMetadata; 9] = [
    BuiltInApiProviderMetadata {
        api: "anthropic-messages",
        module_specifier: "./anthropic.js",
        stream_export: "streamAnthropic",
        stream_simple_export: "streamSimpleAnthropic",
        node_only: false,
    },
    BuiltInApiProviderMetadata {
        api: "openai-completions",
        module_specifier: "./openai-completions.js",
        stream_export: "streamOpenAICompletions",
        stream_simple_export: "streamSimpleOpenAICompletions",
        node_only: false,
    },
    BuiltInApiProviderMetadata {
        api: "mistral-conversations",
        module_specifier: "./mistral.js",
        stream_export: "streamMistral",
        stream_simple_export: "streamSimpleMistral",
        node_only: false,
    },
    BuiltInApiProviderMetadata {
        api: "openai-responses",
        module_specifier: "./openai-responses.js",
        stream_export: "streamOpenAIResponses",
        stream_simple_export: "streamSimpleOpenAIResponses",
        node_only: false,
    },
    BuiltInApiProviderMetadata {
        api: "azure-openai-responses",
        module_specifier: "./azure-openai-responses.js",
        stream_export: "streamAzureOpenAIResponses",
        stream_simple_export: "streamSimpleAzureOpenAIResponses",
        node_only: false,
    },
    BuiltInApiProviderMetadata {
        api: "openai-codex-responses",
        module_specifier: "./openai-codex-responses.js",
        stream_export: "streamOpenAICodexResponses",
        stream_simple_export: "streamSimpleOpenAICodexResponses",
        node_only: false,
    },
    BuiltInApiProviderMetadata {
        api: "google-generative-ai",
        module_specifier: "./google.js",
        stream_export: "streamGoogle",
        stream_simple_export: "streamSimpleGoogle",
        node_only: false,
    },
    BuiltInApiProviderMetadata {
        api: "google-vertex",
        module_specifier: "./google-vertex.js",
        stream_export: "streamGoogleVertex",
        stream_simple_export: "streamSimpleGoogleVertex",
        node_only: false,
    },
    BuiltInApiProviderMetadata {
        api: "bedrock-converse-stream",
        module_specifier: "./amazon-bedrock.js",
        stream_export: "streamBedrock",
        stream_simple_export: "streamSimpleBedrock",
        node_only: true,
    },
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<Transport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_retention: Option<crate::types::CacheRetention>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_retries: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_retry_delay_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Map<String, Value>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for StreamOptions {
    fn default() -> Self {
        Self {
            temperature: None,
            max_tokens: None,
            api_key: None,
            transport: None,
            cache_retention: None,
            session_id: None,
            headers: None,
            timeout_ms: None,
            max_retries: None,
            max_retry_delay_ms: None,
            metadata: None,
            extra: Map::new(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimpleStreamOptions {
    #[serde(flatten)]
    pub stream: StreamOptions,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ThinkingLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_budgets: Option<ThinkingBudgets>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamError {
    NoApiProvider { api: Api },
    MismatchedApi { actual: Api, expected: Api },
    NoTerminalEvent,
    EndedWithoutResult,
    Provider(String),
}

impl fmt::Display for StreamError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoApiProvider { api } => write!(f, "No API provider registered for api: {api}"),
            Self::MismatchedApi { actual, expected } => {
                write!(f, "Mismatched api: {actual} expected {expected}")
            }
            Self::NoTerminalEvent => write!(f, "stream has no terminal result yet"),
            Self::EndedWithoutResult => write!(f, "stream ended without a result"),
            Self::Provider(message) => f.write_str(message),
        }
    }
}

impl Error for StreamError {}

impl From<EventStreamError> for StreamError {
    fn from(error: EventStreamError) -> Self {
        match error {
            EventStreamError::NoTerminalEvent => Self::NoTerminalEvent,
            EventStreamError::EndedWithoutResult => Self::EndedWithoutResult,
        }
    }
}

pub struct ApiProvider {
    pub api: Api,
    stream: Arc<StreamFunction<StreamOptions>>,
    stream_simple: Arc<StreamFunction<SimpleStreamOptions>>,
}

impl ApiProvider {
    pub fn new(
        api: impl Into<Api>,
        stream: impl Fn(
            &Model,
            &Context,
            Option<&StreamOptions>,
        ) -> StreamResult<AssistantMessageEventStream>
        + Send
        + Sync
        + 'static,
        stream_simple: impl Fn(
            &Model,
            &Context,
            Option<&SimpleStreamOptions>,
        ) -> StreamResult<AssistantMessageEventStream>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        Self {
            api: api.into(),
            stream: Arc::new(stream),
            stream_simple: Arc::new(stream_simple),
        }
    }

    pub fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&StreamOptions>,
    ) -> StreamResult<AssistantMessageEventStream> {
        if model.api != self.api {
            return Err(StreamError::MismatchedApi {
                actual: model.api.clone(),
                expected: self.api.clone(),
            });
        }
        (self.stream)(model, context, options)
    }

    pub fn stream_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&SimpleStreamOptions>,
    ) -> StreamResult<AssistantMessageEventStream> {
        if model.api != self.api {
            return Err(StreamError::MismatchedApi {
                actual: model.api.clone(),
                expected: self.api.clone(),
            });
        }
        (self.stream_simple)(model, context, options)
    }
}

impl Clone for ApiProvider {
    fn clone(&self) -> Self {
        Self {
            api: self.api.clone(),
            stream: Arc::clone(&self.stream),
            stream_simple: Arc::clone(&self.stream_simple),
        }
    }
}

#[derive(Clone)]
struct RegisteredApiProvider {
    provider: ApiProvider,
    source_id: Option<String>,
}

static API_PROVIDER_REGISTRY: OnceLock<Mutex<Vec<RegisteredApiProvider>>> = OnceLock::new();
static SESSION_RESOURCE_CLEANUPS: OnceLock<Mutex<CleanupRegistry>> = OnceLock::new();
static NEXT_CLEANUP_ID: AtomicUsize = AtomicUsize::new(1);

fn api_provider_registry() -> &'static Mutex<Vec<RegisteredApiProvider>> {
    API_PROVIDER_REGISTRY.get_or_init(|| Mutex::new(built_in_api_provider_entries()))
}

fn cleanup_registry() -> &'static Mutex<CleanupRegistry> {
    SESSION_RESOURCE_CLEANUPS.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn built_in_api_provider_metadata() -> Vec<BuiltInApiProviderMetadata> {
    BUILT_IN_API_PROVIDER_METADATA.to_vec()
}

pub fn get_built_in_api_provider_metadata(api: &str) -> Option<BuiltInApiProviderMetadata> {
    BUILT_IN_API_PROVIDER_METADATA
        .iter()
        .copied()
        .find(|metadata| metadata.api == api)
}

pub fn built_in_api_names() -> Vec<&'static str> {
    BUILT_IN_API_PROVIDER_METADATA
        .iter()
        .map(|metadata| metadata.api)
        .collect()
}

fn built_in_api_provider_entries() -> Vec<RegisteredApiProvider> {
    BUILT_IN_API_PROVIDER_METADATA
        .iter()
        .copied()
        .map(|metadata| RegisteredApiProvider {
            provider: built_in_api_provider(metadata),
            source_id: None,
        })
        .collect()
}

fn built_in_api_provider(metadata: BuiltInApiProviderMetadata) -> ApiProvider {
    ApiProvider::new(
        metadata.api,
        move |model, _context, _options| {
            Ok(built_in_stream_unavailable(
                metadata,
                metadata.stream_export,
                model,
            ))
        },
        move |model, _context, _options| {
            Ok(built_in_stream_unavailable(
                metadata,
                metadata.stream_simple_export,
                model,
            ))
        },
    )
}

fn built_in_stream_unavailable(
    metadata: BuiltInApiProviderMetadata,
    export_name: &str,
    model: &Model,
) -> AssistantMessageEventStream {
    let message = create_lazy_load_error_message(
        model,
        format!(
            "Built-in API provider {} ({export_name} from {}) is registered, but provider streaming is not implemented in Rust",
            metadata.api, metadata.module_specifier
        ),
    );
    let mut stream = AssistantMessageEventStream::new();
    stream.push(crate::types::AssistantMessageEvent::Error { message });
    stream
}

fn create_lazy_load_error_message(model: &Model, error_message: String) -> AssistantMessage {
    AssistantMessage {
        content: Vec::new(),
        api: model.api.clone(),
        provider: model.provider.clone(),
        model: model.id.clone(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: crate::types::Usage {
            cost: crate::types::Cost::default(),
            ..crate::types::Usage::default()
        },
        stop_reason: crate::types::StopReason::Error,
        error_message: Some(error_message),
        timestamp: current_timestamp_millis(),
    }
}

fn current_timestamp_millis() -> i64 {
    let Ok(duration) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return 0;
    };

    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

pub fn register_api_provider(provider: ApiProvider) {
    register_api_provider_internal(provider, None);
}

pub fn register_api_provider_with_source(provider: ApiProvider, source_id: impl Into<String>) {
    register_api_provider_internal(provider, Some(source_id.into()));
}

fn register_api_provider_internal(provider: ApiProvider, source_id: Option<String>) {
    let mut registry = api_provider_registry()
        .lock()
        .expect("api provider registry mutex poisoned");

    if let Some(entry) = registry
        .iter_mut()
        .find(|entry| entry.provider.api == provider.api)
    {
        *entry = RegisteredApiProvider {
            provider,
            source_id,
        };
    } else {
        registry.push(RegisteredApiProvider {
            provider,
            source_id,
        });
    }
}

pub fn get_api_provider(api: &str) -> Option<ApiProvider> {
    api_provider_registry()
        .lock()
        .expect("api provider registry mutex poisoned")
        .iter()
        .find(|entry| entry.provider.api == api)
        .map(|entry| &entry.provider)
        .cloned()
}

pub fn get_api_providers() -> Vec<ApiProvider> {
    api_provider_registry()
        .lock()
        .expect("api provider registry mutex poisoned")
        .iter()
        .map(|entry| entry.provider.clone())
        .collect()
}

pub fn unregister_api_providers(source_id: &str) {
    api_provider_registry()
        .lock()
        .expect("api provider registry mutex poisoned")
        .retain(|entry| entry.source_id.as_deref() != Some(source_id));
}

pub fn clear_api_providers() {
    api_provider_registry()
        .lock()
        .expect("api provider registry mutex poisoned")
        .clear();
}

pub fn register_built_in_api_providers() {
    for metadata in BUILT_IN_API_PROVIDER_METADATA {
        register_api_provider(built_in_api_provider(metadata));
    }
}

pub fn reset_api_providers() {
    *api_provider_registry()
        .lock()
        .expect("api provider registry mutex poisoned") = built_in_api_provider_entries();
}

pub fn stream(
    model: &Model,
    context: &Context,
    options: Option<&StreamOptions>,
) -> StreamResult<AssistantMessageEventStream> {
    let provider = get_api_provider(&model.api).ok_or_else(|| StreamError::NoApiProvider {
        api: model.api.clone(),
    })?;
    provider.stream(model, context, options)
}

pub fn complete(
    model: &Model,
    context: &Context,
    options: Option<&StreamOptions>,
) -> StreamResult<AssistantMessage> {
    Ok(stream(model, context, options)?.result()?)
}

pub fn stream_simple(
    model: &Model,
    context: &Context,
    options: Option<&SimpleStreamOptions>,
) -> StreamResult<AssistantMessageEventStream> {
    let provider = get_api_provider(&model.api).ok_or_else(|| StreamError::NoApiProvider {
        api: model.api.clone(),
    })?;
    provider.stream_simple(model, context, options)
}

pub fn complete_simple(
    model: &Model,
    context: &Context,
    options: Option<&SimpleStreamOptions>,
) -> StreamResult<AssistantMessage> {
    Ok(stream_simple(model, context, options)?.result()?)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SessionResourceCleanupRegistration {
    id: usize,
}

impl SessionResourceCleanupRegistration {
    pub fn unregister(self) {
        cleanup_registry()
            .lock()
            .expect("session cleanup registry mutex poisoned")
            .retain(|(id, _cleanup)| *id != self.id);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionResourceCleanupError {
    pub message: String,
    pub errors: Vec<String>,
}

impl fmt::Display for SessionResourceCleanupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl Error for SessionResourceCleanupError {}

pub fn register_session_resource_cleanup(
    cleanup: impl Fn(Option<&str>) -> Result<(), Box<dyn Error + Send + Sync>> + Send + Sync + 'static,
) -> SessionResourceCleanupRegistration {
    let id = NEXT_CLEANUP_ID.fetch_add(1, Ordering::Relaxed);
    cleanup_registry()
        .lock()
        .expect("session cleanup registry mutex poisoned")
        .push((id, Arc::new(cleanup)));
    SessionResourceCleanupRegistration { id }
}

pub fn cleanup_session_resources(
    session_id: Option<&str>,
) -> Result<(), SessionResourceCleanupError> {
    let cleanups: Vec<_> = cleanup_registry()
        .lock()
        .expect("session cleanup registry mutex poisoned")
        .iter()
        .map(|(_id, cleanup)| Arc::clone(cleanup))
        .collect();
    let errors: Vec<String> = cleanups
        .into_iter()
        .filter_map(|cleanup| cleanup(session_id).err().map(|error| error.to_string()))
        .collect();

    if errors.is_empty() {
        Ok(())
    } else {
        Err(SessionResourceCleanupError {
            message: "Failed to cleanup session resources".to_string(),
            errors,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AssistantMessageEvent, Cost, StopReason, Usage};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

    fn registry_test_lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
    }

    fn test_model(api: &str) -> Model {
        Model {
            api: api.to_string(),
            id: "model-id".to_string(),
            name: "Model".to_string(),
            ..Model::default()
        }
    }

    fn empty_context() -> Context {
        Context {
            system_prompt: None,
            messages: vec![],
            tools: None,
        }
    }

    fn assistant_message(api: &str, text: &str) -> AssistantMessage {
        AssistantMessage {
            content: vec![crate::types::ContentBlock::text(text)],
            api: api.to_string(),
            provider: "test".to_string(),
            model: "model-id".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage {
                cost: Cost::default(),
                ..Usage::default()
            },
            stop_reason: StopReason::Stop,
            error_message: None,
            timestamp: 42,
        }
    }

    fn stream_with_done(message: AssistantMessage) -> AssistantMessageEventStream {
        let mut stream = AssistantMessageEventStream::new();
        stream.push(AssistantMessageEvent::Start {
            partial: message.clone(),
        });
        stream.push(AssistantMessageEvent::Done { message });
        stream
    }

    fn provider_for(api: &str, text: &'static str) -> ApiProvider {
        ApiProvider::new(
            api,
            move |model, _context, _options| {
                Ok(stream_with_done(assistant_message(&model.api, text)))
            },
            move |model, _context, _options| {
                Ok(stream_with_done(assistant_message(&model.api, text)))
            },
        )
    }

    #[test]
    fn stream_dispatches_to_registered_provider_and_complete_returns_final_message() {
        let _guard = registry_test_lock();
        clear_api_providers();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_stream = Arc::clone(&calls);

        register_api_provider(ApiProvider::new(
            "test-api",
            move |model, _context, options| {
                calls_for_stream.fetch_add(1, Ordering::SeqCst);
                assert_eq!(options.and_then(|options| options.max_tokens), Some(7));
                Ok(stream_with_done(assistant_message(&model.api, "done")))
            },
            |_model, _context, _options| unreachable!("simple stream should not be called"),
        ));

        let options = StreamOptions {
            max_tokens: Some(7),
            ..StreamOptions::default()
        };
        let result = complete(&test_model("test-api"), &empty_context(), Some(&options)).unwrap();

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            result.content,
            vec![crate::types::ContentBlock::text("done")]
        );
    }

    #[test]
    fn stream_returns_error_for_unregistered_api() {
        let _guard = registry_test_lock();
        clear_api_providers();

        let error = stream(&test_model("missing-api"), &empty_context(), None).unwrap_err();

        assert_eq!(
            error,
            StreamError::NoApiProvider {
                api: "missing-api".to_string()
            }
        );
    }

    #[test]
    fn registered_provider_rejects_mismatched_model_api() {
        let provider = ApiProvider::new(
            "expected-api",
            |_model, _context, _options| unreachable!("mismatched api should fail before call"),
            |_model, _context, _options| unreachable!("mismatched api should fail before call"),
        );

        let error = provider
            .stream(&test_model("actual-api"), &empty_context(), None)
            .unwrap_err();

        assert_eq!(
            error,
            StreamError::MismatchedApi {
                actual: "actual-api".to_string(),
                expected: "expected-api".to_string()
            }
        );
    }

    #[test]
    fn registered_simple_provider_rejects_mismatched_model_api() {
        let provider = ApiProvider::new(
            "expected-api",
            |_model, _context, _options| unreachable!("mismatched api should fail before call"),
            |_model, _context, _options| unreachable!("mismatched api should fail before call"),
        );

        let error = provider
            .stream_simple(&test_model("actual-api"), &empty_context(), None)
            .unwrap_err();

        assert_eq!(
            error,
            StreamError::MismatchedApi {
                actual: "actual-api".to_string(),
                expected: "expected-api".to_string()
            }
        );
    }

    #[test]
    fn api_registry_preserves_registration_order_and_replaces_by_api() {
        let _guard = registry_test_lock();
        clear_api_providers();

        register_api_provider(provider_for("first-api", "first"));
        register_api_provider(provider_for("second-api", "second"));
        register_api_provider(provider_for("third-api", "third"));
        register_api_provider(provider_for("second-api", "replacement"));

        let apis = get_api_providers()
            .into_iter()
            .map(|provider| provider.api)
            .collect::<Vec<_>>();

        assert_eq!(apis, vec!["first-api", "second-api", "third-api"]);

        let result = complete(&test_model("second-api"), &empty_context(), None).unwrap();
        assert_eq!(
            result.content,
            vec![crate::types::ContentBlock::text("replacement")]
        );
    }

    #[test]
    fn api_registry_unregisters_providers_by_source_id() {
        let _guard = registry_test_lock();
        clear_api_providers();

        register_api_provider_with_source(provider_for("source-api-a", "a"), "source-1");
        register_api_provider_with_source(provider_for("source-api-b", "b"), "source-2");
        register_api_provider_with_source(provider_for("source-api-c", "c"), "source-1");
        register_api_provider(provider_for("builtin-api", "builtin"));

        unregister_api_providers("source-1");

        assert!(get_api_provider("source-api-a").is_none());
        assert!(get_api_provider("source-api-c").is_none());
        assert!(get_api_provider("source-api-b").is_some());
        assert!(get_api_provider("builtin-api").is_some());
    }

    #[test]
    fn api_registry_clear_and_reset_restores_builtin_providers() {
        let _guard = registry_test_lock();
        clear_api_providers();

        assert!(get_api_providers().is_empty());

        reset_api_providers();

        let apis = get_api_providers()
            .into_iter()
            .map(|provider| provider.api)
            .collect::<Vec<_>>();
        assert_eq!(apis, built_in_api_names());
    }

    #[test]
    fn api_registry_registers_builtin_providers_after_custom_entries() {
        let _guard = registry_test_lock();
        clear_api_providers();

        register_api_provider(provider_for("custom-api", "custom"));
        register_built_in_api_providers();

        let apis = get_api_providers()
            .into_iter()
            .map(|provider| provider.api)
            .collect::<Vec<_>>();
        let mut expected = vec!["custom-api"];
        expected.extend(built_in_api_names());
        assert_eq!(apis, expected);
    }

    #[test]
    fn api_registry_builtin_api_names_match_typescript_registration_order() {
        assert_eq!(
            built_in_api_names(),
            vec![
                "anthropic-messages",
                "openai-completions",
                "mistral-conversations",
                "openai-responses",
                "azure-openai-responses",
                "openai-codex-responses",
                "google-generative-ai",
                "google-vertex",
                "bedrock-converse-stream",
            ]
        );
    }

    #[test]
    fn api_registry_builtin_metadata_tracks_lazy_provider_exports() {
        let metadata = get_built_in_api_provider_metadata("bedrock-converse-stream").unwrap();

        assert_eq!(metadata.module_specifier, "./amazon-bedrock.js");
        assert_eq!(metadata.stream_export, "streamBedrock");
        assert_eq!(metadata.stream_simple_export, "streamSimpleBedrock");
        assert!(metadata.node_only);
        assert!(get_built_in_api_provider_metadata("missing-api").is_none());
        assert_eq!(built_in_api_provider_metadata().len(), 9);
    }

    #[test]
    fn api_registry_builtin_streams_return_lazy_load_error_events() {
        let _guard = registry_test_lock();
        reset_api_providers();

        let mut stream = stream(&test_model("anthropic-messages"), &empty_context(), None).unwrap();
        let result = stream.result().unwrap();

        assert!(matches!(
            stream.next_event(),
            Some(crate::types::AssistantMessageEvent::Error { .. })
        ));
        assert_eq!(result.api, "anthropic-messages");
        assert_eq!(result.stop_reason, StopReason::Error);
        assert!(
            result
                .error_message
                .as_deref()
                .unwrap()
                .contains("streamAnthropic from ./anthropic.js")
        );
    }

    #[test]
    fn simple_stream_dispatches_to_simple_provider() {
        let _guard = registry_test_lock();
        clear_api_providers();

        register_api_provider(ApiProvider::new(
            "test-api",
            |_model, _context, _options| unreachable!("provider stream should not be called"),
            |model, _context, options| {
                assert_eq!(
                    options.and_then(|options| options.reasoning),
                    Some(ThinkingLevel::High)
                );
                Ok(stream_with_done(assistant_message(&model.api, "simple")))
            },
        ));

        let options = SimpleStreamOptions {
            reasoning: Some(ThinkingLevel::High),
            ..SimpleStreamOptions::default()
        };
        let result =
            complete_simple(&test_model("test-api"), &empty_context(), Some(&options)).unwrap();

        assert_eq!(
            result.content,
            vec![crate::types::ContentBlock::text("simple")]
        );
    }

    #[test]
    fn event_stream_ignores_events_after_terminal_event() {
        let done = assistant_message("test-api", "done");
        let late = assistant_message("test-api", "late");
        let mut stream = AssistantMessageEventStream::new();

        stream.push(AssistantMessageEvent::Done {
            message: done.clone(),
        });
        stream.push(AssistantMessageEvent::Done { message: late });

        assert!(stream.is_done());
        assert_eq!(stream.result().unwrap(), done);
        assert_eq!(stream.count(), 1);
    }

    #[test]
    fn stream_options_are_camel_case_and_preserve_extra_provider_options() {
        let mut extra = Map::new();
        extra.insert(
            "reasoningEffort".to_string(),
            Value::String("high".to_string()),
        );
        let options = StreamOptions {
            max_tokens: Some(128),
            session_id: Some("session-1".to_string()),
            extra,
            ..StreamOptions::default()
        };

        let value = serde_json::to_value(options).unwrap();

        assert_eq!(value["maxTokens"], 128);
        assert_eq!(value["sessionId"], "session-1");
        assert_eq!(value["reasoningEffort"], "high");
    }

    #[test]
    fn session_cleanup_runs_all_callbacks_and_aggregates_errors() {
        let _guard = registry_test_lock();
        let first_seen = Arc::new(Mutex::new(None));
        let second_seen = Arc::new(Mutex::new(None));
        let first_seen_cleanup = Arc::clone(&first_seen);
        let second_seen_cleanup = Arc::clone(&second_seen);

        let first = register_session_resource_cleanup(move |session_id| {
            *first_seen_cleanup.lock().unwrap() = session_id.map(str::to_string);
            Err(std::io::Error::other("first failed").into())
        });
        let second = register_session_resource_cleanup(move |session_id| {
            *second_seen_cleanup.lock().unwrap() = session_id.map(str::to_string);
            Err(std::io::Error::other("second failed").into())
        });

        let error = cleanup_session_resources(Some("session-1")).unwrap_err();
        first.unregister();
        second.unregister();

        assert_eq!(*first_seen.lock().unwrap(), Some("session-1".to_string()));
        assert_eq!(*second_seen.lock().unwrap(), Some("session-1".to_string()));
        assert_eq!(error.message, "Failed to cleanup session resources");
        assert_eq!(error.errors.len(), 2);
        assert!(error.errors.iter().any(|error| error == "first failed"));
        assert!(error.errors.iter().any(|error| error == "second failed"));
    }

    #[test]
    fn unregister_session_cleanup_removes_callback() {
        let _guard = registry_test_lock();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_cleanup = Arc::clone(&calls);
        let registration = register_session_resource_cleanup(move |_session_id| {
            calls_cleanup.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });

        registration.unregister();
        cleanup_session_resources(None).unwrap();

        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}
