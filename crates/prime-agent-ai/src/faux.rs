use crate::stream::{
    ApiProvider, AssistantMessageEventStream, SimpleStreamOptions, StreamOptions, StreamResult,
    create_assistant_message_event_stream, register_api_provider_with_source,
    unregister_api_providers,
};
use crate::types::{
    AssistantMessage, AssistantMessageEvent, CacheRetention, ContentBlock, Context, Cost, Message,
    Model, ModelInput, ModelPricing, StopReason, ToolResultMessage, Usage,
};
use serde_json::{Map, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

pub const DEFAULT_FAUX_API: &str = "faux";
pub const DEFAULT_FAUX_PROVIDER: &str = "faux";
pub const DEFAULT_FAUX_MODEL_ID: &str = "faux-1";
pub const DEFAULT_FAUX_MODEL_NAME: &str = "Faux Model";
pub const DEFAULT_FAUX_BASE_URL: &str = "http://localhost:0";
pub const DEFAULT_FAUX_MIN_TOKEN_SIZE: usize = 3;
pub const DEFAULT_FAUX_MAX_TOKEN_SIZE: usize = 5;

static NEXT_FAUX_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq)]
pub struct FauxModelDefinition {
    pub id: String,
    pub name: Option<String>,
    pub reasoning: Option<bool>,
    pub input: Option<Vec<ModelInput>>,
    pub cost: Option<ModelPricing>,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
}

impl FauxModelDefinition {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: None,
            reasoning: None,
            input: None,
            cost: None,
            context_window: None,
            max_tokens: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FauxTokenSize {
    pub min: Option<usize>,
    pub max: Option<usize>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RegisterFauxProviderOptions {
    pub api: Option<String>,
    pub provider: Option<String>,
    pub models: Vec<FauxModelDefinition>,
    pub tokens_per_second: Option<f64>,
    pub token_size: Option<FauxTokenSize>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FauxToolCallOptions {
    pub id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FauxAssistantMessageOptions {
    pub stop_reason: Option<StopReason>,
    pub error_message: Option<String>,
    pub response_id: Option<String>,
    pub timestamp: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FauxAssistantContent {
    Text(String),
    Block(ContentBlock),
    Blocks(Vec<ContentBlock>),
}

impl From<&str> for FauxAssistantContent {
    fn from(value: &str) -> Self {
        Self::Text(value.to_string())
    }
}

impl From<String> for FauxAssistantContent {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}

impl From<ContentBlock> for FauxAssistantContent {
    fn from(value: ContentBlock) -> Self {
        Self::Block(value)
    }
}

impl From<Vec<ContentBlock>> for FauxAssistantContent {
    fn from(value: Vec<ContentBlock>) -> Self {
        Self::Blocks(value)
    }
}

pub type FauxResponseFactoryResult = Result<AssistantMessage, String>;
pub type FauxResponseFactory = Arc<
    dyn Fn(
            &Context,
            Option<&StreamOptions>,
            &FauxProviderState,
            &Model,
        ) -> FauxResponseFactoryResult
        + Send
        + Sync
        + 'static,
>;

#[derive(Clone)]
pub enum FauxResponseStep {
    Message(Box<AssistantMessage>),
    Factory(FauxResponseFactory),
}

impl FauxResponseStep {
    pub fn factory(
        factory: impl Fn(
            &Context,
            Option<&StreamOptions>,
            &FauxProviderState,
            &Model,
        ) -> FauxResponseFactoryResult
        + Send
        + Sync
        + 'static,
    ) -> Self {
        Self::Factory(Arc::new(factory))
    }
}

impl From<AssistantMessage> for FauxResponseStep {
    fn from(value: AssistantMessage) -> Self {
        Self::Message(Box::new(value))
    }
}

#[derive(Debug, Clone)]
pub struct FauxProviderState {
    call_count: Arc<AtomicUsize>,
}

impl FauxProviderState {
    pub fn call_count(&self) -> usize {
        self.call_count.load(Ordering::SeqCst)
    }

    fn increment_call_count(&self) {
        self.call_count.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Clone)]
pub struct FauxProviderRegistration {
    pub api: String,
    pub models: Vec<Model>,
    pub state: FauxProviderState,
    source_id: String,
    inner: Arc<Mutex<FauxProviderInner>>,
}

impl FauxProviderRegistration {
    pub fn get_model(&self) -> &Model {
        &self.models[0]
    }

    pub fn get_model_by_id(&self, model_id: &str) -> Option<&Model> {
        self.models.iter().find(|model| model.id == model_id)
    }

    pub fn set_responses(&self, responses: Vec<FauxResponseStep>) {
        self.inner
            .lock()
            .expect("faux provider mutex poisoned")
            .pending_responses = responses.into();
    }

    pub fn append_responses(&self, responses: Vec<FauxResponseStep>) {
        self.inner
            .lock()
            .expect("faux provider mutex poisoned")
            .pending_responses
            .extend(responses);
    }

    pub fn get_pending_response_count(&self) -> usize {
        self.inner
            .lock()
            .expect("faux provider mutex poisoned")
            .pending_responses
            .len()
    }

    pub fn unregister(&self) {
        unregister_api_providers(&self.source_id);
    }
}

struct FauxProviderInner {
    pending_responses: VecDeque<FauxResponseStep>,
    prompt_cache: HashMap<String, String>,
}

#[derive(Debug, Clone)]
struct FauxStreamRuntime {
    api: String,
    provider: String,
    min_token_size: usize,
    max_token_size: usize,
}

pub fn faux_text(text: impl Into<String>) -> ContentBlock {
    ContentBlock::Text {
        text: text.into(),
        text_signature: None,
    }
}

pub fn faux_thinking(thinking: impl Into<String>) -> ContentBlock {
    ContentBlock::Thinking {
        thinking: thinking.into(),
        thinking_signature: None,
        redacted: None,
    }
}

pub fn faux_tool_call(name: impl Into<String>, arguments: Map<String, Value>) -> ContentBlock {
    faux_tool_call_with_options(name, arguments, FauxToolCallOptions::default())
}

pub fn faux_tool_call_with_id(
    name: impl Into<String>,
    arguments: Map<String, Value>,
    id: impl Into<String>,
) -> ContentBlock {
    faux_tool_call_with_options(
        name,
        arguments,
        FauxToolCallOptions {
            id: Some(id.into()),
        },
    )
}

pub fn faux_tool_call_with_options(
    name: impl Into<String>,
    arguments: Map<String, Value>,
    options: FauxToolCallOptions,
) -> ContentBlock {
    ContentBlock::ToolCall {
        id: options.id.unwrap_or_else(|| random_id("tool")),
        name: name.into(),
        arguments,
        thought_signature: None,
    }
}

pub fn faux_assistant_message(content: impl Into<FauxAssistantContent>) -> AssistantMessage {
    faux_assistant_message_with_options(content, FauxAssistantMessageOptions::default())
}

pub fn faux_assistant_message_with_options(
    content: impl Into<FauxAssistantContent>,
    options: FauxAssistantMessageOptions,
) -> AssistantMessage {
    AssistantMessage {
        content: normalize_faux_assistant_content(content.into()),
        api: DEFAULT_FAUX_API.to_string(),
        provider: DEFAULT_FAUX_PROVIDER.to_string(),
        model: DEFAULT_FAUX_MODEL_ID.to_string(),
        response_model: None,
        response_id: options.response_id,
        diagnostics: None,
        usage: default_usage(),
        stop_reason: options.stop_reason.unwrap_or(StopReason::Stop),
        error_message: options.error_message,
        timestamp: options.timestamp.unwrap_or_else(current_timestamp_millis),
    }
}

pub fn register_faux_provider(options: RegisterFauxProviderOptions) -> FauxProviderRegistration {
    let api = options.api.unwrap_or_else(|| random_id(DEFAULT_FAUX_API));
    let provider = options
        .provider
        .unwrap_or_else(|| DEFAULT_FAUX_PROVIDER.to_string());
    let source_id = random_id("faux-provider");
    let min_token_size = normalized_min_token_size(options.token_size.as_ref());
    let max_token_size = normalized_max_token_size(options.token_size.as_ref(), min_token_size);
    let runtime = FauxStreamRuntime {
        api: api.clone(),
        provider: provider.clone(),
        min_token_size,
        max_token_size,
    };
    let state = FauxProviderState {
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    let inner = Arc::new(Mutex::new(FauxProviderInner {
        pending_responses: VecDeque::new(),
        prompt_cache: HashMap::new(),
    }));
    let model_definitions = if options.models.is_empty() {
        vec![default_model_definition()]
    } else {
        options.models
    };
    let models = model_definitions
        .into_iter()
        .map(|definition| model_from_definition(definition, &api, &provider))
        .collect::<Vec<_>>();

    let stream_inner = Arc::clone(&inner);
    let stream_state = state.clone();
    let stream_runtime = runtime.clone();
    let stream = move |request_model: &Model,
                       context: &Context,
                       stream_options: Option<&StreamOptions>|
          -> StreamResult<AssistantMessageEventStream> {
        Ok(run_faux_stream(
            &stream_inner,
            &stream_state,
            &stream_runtime,
            request_model,
            context,
            stream_options,
        ))
    };

    let simple_inner = Arc::clone(&inner);
    let simple_state = state.clone();
    let simple_runtime = runtime;
    let stream_simple = move |request_model: &Model,
                              context: &Context,
                              stream_options: Option<&SimpleStreamOptions>|
          -> StreamResult<AssistantMessageEventStream> {
        Ok(run_faux_stream(
            &simple_inner,
            &simple_state,
            &simple_runtime,
            request_model,
            context,
            stream_options.map(|options| &options.stream),
        ))
    };

    register_api_provider_with_source(
        ApiProvider::new(api.clone(), stream, stream_simple),
        &source_id,
    );

    FauxProviderRegistration {
        api,
        models,
        state,
        source_id,
        inner,
    }
}

pub fn register_default_faux_provider() -> FauxProviderRegistration {
    register_faux_provider(RegisterFauxProviderOptions::default())
}

fn run_faux_stream(
    inner: &Arc<Mutex<FauxProviderInner>>,
    state: &FauxProviderState,
    runtime: &FauxStreamRuntime,
    request_model: &Model,
    context: &Context,
    stream_options: Option<&StreamOptions>,
) -> AssistantMessageEventStream {
    let step = inner
        .lock()
        .expect("faux provider mutex poisoned")
        .pending_responses
        .pop_front();
    state.increment_call_count();

    let mut message = match step {
        Some(FauxResponseStep::Message(message)) => {
            clone_message(&message, &runtime.api, &runtime.provider, &request_model.id)
        }
        Some(FauxResponseStep::Factory(factory)) => {
            match factory(context, stream_options, state, request_model) {
                Ok(message) => {
                    clone_message(&message, &runtime.api, &runtime.provider, &request_model.id)
                }
                Err(error) => {
                    create_error_message(error, &runtime.api, &runtime.provider, &request_model.id)
                }
            }
        }
        None => create_error_message(
            "No more faux responses queued",
            &runtime.api,
            &runtime.provider,
            &request_model.id,
        ),
    };

    message = {
        let mut inner = inner.lock().expect("faux provider mutex poisoned");
        with_usage_estimate(message, context, stream_options, &mut inner.prompt_cache)
    };

    let mut stream = create_assistant_message_event_stream();
    stream_with_deltas(
        &mut stream,
        message,
        runtime.min_token_size,
        runtime.max_token_size,
    );
    stream
}

fn stream_with_deltas(
    stream: &mut AssistantMessageEventStream,
    message: AssistantMessage,
    min_token_size: usize,
    max_token_size: usize,
) {
    let mut partial = AssistantMessage {
        content: Vec::new(),
        ..message.clone()
    };

    stream.push(AssistantMessageEvent::Start {
        partial: partial.clone(),
    });

    for (index, block) in message.content.iter().enumerate() {
        match block {
            ContentBlock::Thinking { thinking, .. } => {
                partial.content.push(faux_thinking(""));
                stream.push(AssistantMessageEvent::ThinkingStart {
                    content_index: index,
                    partial: partial.clone(),
                });
                for chunk in split_string_by_token_size(thinking, min_token_size, max_token_size) {
                    if let Some(ContentBlock::Thinking {
                        thinking: partial_thinking,
                        ..
                    }) = partial.content.get_mut(index)
                    {
                        partial_thinking.push_str(&chunk);
                    }
                    stream.push(AssistantMessageEvent::ThinkingDelta {
                        content_index: index,
                        delta: chunk,
                        partial: partial.clone(),
                    });
                }
                stream.push(AssistantMessageEvent::ThinkingEnd {
                    content_index: index,
                    content: thinking.clone(),
                    partial: partial.clone(),
                });
            }
            ContentBlock::Text { text, .. } => {
                partial.content.push(faux_text(""));
                stream.push(AssistantMessageEvent::TextStart {
                    content_index: index,
                    partial: partial.clone(),
                });
                for chunk in split_string_by_token_size(text, min_token_size, max_token_size) {
                    if let Some(ContentBlock::Text {
                        text: partial_text, ..
                    }) = partial.content.get_mut(index)
                    {
                        partial_text.push_str(&chunk);
                    }
                    stream.push(AssistantMessageEvent::TextDelta {
                        content_index: index,
                        delta: chunk,
                        partial: partial.clone(),
                    });
                }
                stream.push(AssistantMessageEvent::TextEnd {
                    content_index: index,
                    content: text.clone(),
                    partial: partial.clone(),
                });
            }
            ContentBlock::ToolCall {
                id,
                name,
                arguments,
                thought_signature,
            } => {
                partial.content.push(ContentBlock::ToolCall {
                    id: id.clone(),
                    name: name.clone(),
                    arguments: Map::new(),
                    thought_signature: thought_signature.clone(),
                });
                stream.push(AssistantMessageEvent::ToolcallStart {
                    content_index: index,
                    partial: partial.clone(),
                });
                let argument_text =
                    serde_json::to_string(arguments).unwrap_or_else(|_| "{}".to_string());
                for chunk in
                    split_string_by_token_size(&argument_text, min_token_size, max_token_size)
                {
                    stream.push(AssistantMessageEvent::ToolcallDelta {
                        content_index: index,
                        delta: chunk,
                        partial: partial.clone(),
                    });
                }
                if let Some(ContentBlock::ToolCall {
                    arguments: partial_arguments,
                    ..
                }) = partial.content.get_mut(index)
                {
                    *partial_arguments = arguments.clone();
                }
                stream.push(AssistantMessageEvent::ToolcallEnd {
                    content_index: index,
                    tool_call: block.clone(),
                    partial: partial.clone(),
                });
            }
            ContentBlock::Image { .. } => {
                partial.content.push(block.clone());
            }
        }
    }

    if matches!(message.stop_reason, StopReason::Error | StopReason::Aborted) {
        stream.push(AssistantMessageEvent::Error { message });
    } else {
        stream.push(AssistantMessageEvent::Done { message });
    }
}

fn with_usage_estimate(
    mut message: AssistantMessage,
    context: &Context,
    options: Option<&StreamOptions>,
    prompt_cache: &mut HashMap<String, String>,
) -> AssistantMessage {
    let prompt_text = serialize_context(context);
    let prompt_tokens = estimate_tokens(&prompt_text);
    let output_tokens = estimate_tokens(&assistant_content_to_text(&message.content));
    let mut input = prompt_tokens;
    let mut cache_read = 0;
    let mut cache_write = 0;

    if let Some(session_id) = options.and_then(|options| options.session_id.as_deref())
        && options.and_then(|options| options.cache_retention) != Some(CacheRetention::None)
    {
        if let Some(previous_prompt) = prompt_cache.get(session_id) {
            let cached_chars = common_prefix_len(previous_prompt, &prompt_text);
            cache_read = estimate_tokens(&previous_prompt[..cached_chars]);
            cache_write = estimate_tokens(&prompt_text[cached_chars..]);
            input = prompt_tokens.saturating_sub(cache_read);
        } else {
            cache_write = prompt_tokens;
        }
        prompt_cache.insert(session_id.to_string(), prompt_text);
    }

    message.usage = Usage {
        input,
        output: output_tokens,
        cache_read,
        cache_write,
        total_tokens: input + output_tokens + cache_read + cache_write,
        cost: Cost::default(),
    };
    message
}

fn serialize_context(context: &Context) -> String {
    let mut parts = Vec::new();
    if let Some(system_prompt) = &context.system_prompt {
        parts.push(format!("system:{system_prompt}"));
    }
    for message in &context.messages {
        parts.push(format!(
            "{}:{}",
            message_role(message),
            message_to_text(message)
        ));
    }
    if let Some(tools) = &context.tools
        && !tools.is_empty()
    {
        parts.push(format!(
            "tools:{}",
            serde_json::to_string(tools).unwrap_or_else(|_| "[]".to_string())
        ));
    }
    parts.join("\n\n")
}

fn message_role(message: &Message) -> &'static str {
    match message {
        Message::User(_) => "user",
        Message::Assistant(_) => "assistant",
        Message::ToolResult(_) => "toolResult",
    }
}

fn message_to_text(message: &Message) -> String {
    match message {
        Message::User(message) => user_content_to_text(&message.content),
        Message::Assistant(message) => assistant_content_to_text(&message.content),
        Message::ToolResult(message) => tool_result_to_text(message),
    }
}

fn user_content_to_text(content: &crate::types::UserContent) -> String {
    match content {
        crate::types::UserContent::Text(text) => text.clone(),
        crate::types::UserContent::Blocks(blocks) => blocks
            .iter()
            .map(content_block_to_text)
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

fn assistant_content_to_text(content: &[ContentBlock]) -> String {
    content
        .iter()
        .map(content_block_to_text)
        .collect::<Vec<_>>()
        .join("\n")
}

fn tool_result_to_text(message: &ToolResultMessage) -> String {
    std::iter::once(message.tool_name.clone())
        .chain(message.content.iter().map(content_block_to_text))
        .collect::<Vec<_>>()
        .join("\n")
}

fn content_block_to_text(block: &ContentBlock) -> String {
    match block {
        ContentBlock::Text { text, .. } => text.clone(),
        ContentBlock::Thinking { thinking, .. } => thinking.clone(),
        ContentBlock::Image { data, mime_type } => format!("[image:{mime_type}:{}]", data.len()),
        ContentBlock::ToolCall {
            name, arguments, ..
        } => format!(
            "{name}:{}",
            serde_json::to_string(arguments).unwrap_or_else(|_| "{}".to_string())
        ),
    }
}

fn common_prefix_len(a: &str, b: &str) -> usize {
    let mut prefix_len = 0;
    for ((a_index, a_char), (b_index, b_char)) in a.char_indices().zip(b.char_indices()) {
        if a_char != b_char {
            break;
        }
        prefix_len = a_index + a_char.len_utf8();
        debug_assert_eq!(prefix_len, b_index + b_char.len_utf8());
    }
    prefix_len
}

fn estimate_tokens(text: &str) -> u64 {
    text.len().div_ceil(4) as u64
}

fn split_string_by_token_size(
    text: &str,
    min_token_size: usize,
    _max_token_size: usize,
) -> Vec<String> {
    let char_size = min_token_size.saturating_mul(4).max(1);
    let mut chunks = Vec::new();
    let mut current = String::new();
    for character in text.chars() {
        current.push(character);
        if current.len() >= char_size {
            chunks.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    if chunks.is_empty() {
        chunks.push(String::new());
    }
    chunks
}

fn normalize_faux_assistant_content(content: FauxAssistantContent) -> Vec<ContentBlock> {
    match content {
        FauxAssistantContent::Text(text) => vec![faux_text(text)],
        FauxAssistantContent::Block(block) => vec![block],
        FauxAssistantContent::Blocks(blocks) => blocks,
    }
}

fn clone_message(
    message: &AssistantMessage,
    api: &str,
    provider: &str,
    model_id: &str,
) -> AssistantMessage {
    AssistantMessage {
        api: api.to_string(),
        provider: provider.to_string(),
        model: model_id.to_string(),
        ..message.clone()
    }
}

fn create_error_message(
    error: impl Into<String>,
    api: &str,
    provider: &str,
    model_id: &str,
) -> AssistantMessage {
    AssistantMessage {
        content: Vec::new(),
        api: api.to_string(),
        provider: provider.to_string(),
        model: model_id.to_string(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: default_usage(),
        stop_reason: StopReason::Error,
        error_message: Some(error.into()),
        timestamp: current_timestamp_millis(),
    }
}

fn default_model_definition() -> FauxModelDefinition {
    FauxModelDefinition {
        id: DEFAULT_FAUX_MODEL_ID.to_string(),
        name: Some(DEFAULT_FAUX_MODEL_NAME.to_string()),
        reasoning: Some(false),
        input: Some(vec![ModelInput::Text, ModelInput::Image]),
        cost: Some(ModelPricing::default()),
        context_window: Some(128_000),
        max_tokens: Some(16_384),
    }
}

fn model_from_definition(definition: FauxModelDefinition, api: &str, provider: &str) -> Model {
    Model {
        name: definition.name.unwrap_or_else(|| definition.id.clone()),
        id: definition.id,
        api: api.to_string(),
        provider: provider.to_string(),
        base_url: DEFAULT_FAUX_BASE_URL.to_string(),
        reasoning: definition.reasoning.unwrap_or(false),
        thinking_level_map: None,
        input: definition
            .input
            .unwrap_or_else(|| vec![ModelInput::Text, ModelInput::Image]),
        cost: definition.cost.unwrap_or_default(),
        context_window: definition.context_window.unwrap_or(128_000),
        max_tokens: definition.max_tokens.unwrap_or(16_384),
        headers: None,
        compat: None,
    }
}

fn default_usage() -> Usage {
    Usage {
        cost: Cost::default(),
        ..Usage::default()
    }
}

fn normalized_min_token_size(token_size: Option<&FauxTokenSize>) -> usize {
    let min = token_size
        .and_then(|token_size| token_size.min)
        .unwrap_or(DEFAULT_FAUX_MIN_TOKEN_SIZE);
    let max = token_size
        .and_then(|token_size| token_size.max)
        .unwrap_or(DEFAULT_FAUX_MAX_TOKEN_SIZE);
    min.max(1).min(max)
}

fn normalized_max_token_size(token_size: Option<&FauxTokenSize>, min_token_size: usize) -> usize {
    token_size
        .and_then(|token_size| token_size.max)
        .unwrap_or(DEFAULT_FAUX_MAX_TOKEN_SIZE)
        .max(min_token_size)
}

fn random_id(prefix: &str) -> String {
    let id = NEXT_FAUX_ID.fetch_add(1, Ordering::SeqCst);
    format!("{prefix}:{id}")
}

fn current_timestamp_millis() -> i64 {
    let Ok(duration) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return 0;
    };

    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stream::{StreamError, complete, reset_api_providers};
    use crate::types::{Tool, UserContent, UserMessage};
    use serde_json::json;
    use std::sync::{MutexGuard, OnceLock};

    struct RegistryGuard {
        _guard: MutexGuard<'static, ()>,
    }

    impl Drop for RegistryGuard {
        fn drop(&mut self) {
            reset_api_providers();
        }
    }

    fn registry_test_guard() -> RegistryGuard {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let guard = LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        reset_api_providers();
        RegistryGuard { _guard: guard }
    }

    fn empty_context() -> Context {
        Context {
            system_prompt: None,
            messages: Vec::new(),
            tools: None,
        }
    }

    fn text_content(message: &AssistantMessage) -> Vec<String> {
        message
            .content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn faux_defaults_register_unique_api_and_default_model() {
        let _guard = registry_test_guard();

        let registration = register_default_faux_provider();
        let model = registration.get_model();

        assert!(registration.api.starts_with("faux:"));
        assert_eq!(registration.models.len(), 1);
        assert_eq!(model.id, DEFAULT_FAUX_MODEL_ID);
        assert_eq!(model.name, DEFAULT_FAUX_MODEL_NAME);
        assert_eq!(model.provider, DEFAULT_FAUX_PROVIDER);
        assert_eq!(model.base_url, DEFAULT_FAUX_BASE_URL);
        assert_eq!(model.input, vec![ModelInput::Text, ModelInput::Image]);
        assert!(!model.reasoning);
        assert_eq!(model.context_window, 128_000);
        assert_eq!(model.max_tokens, 16_384);
        assert_eq!(model.cost, ModelPricing::default());
    }

    #[test]
    fn faux_queued_responses_are_consumed_in_order_and_exhaustion_is_error() {
        let _guard = registry_test_guard();
        let registration = register_faux_provider(RegisterFauxProviderOptions {
            api: Some("faux-queued".to_string()),
            ..RegisterFauxProviderOptions::default()
        });
        registration.set_responses(vec![
            faux_assistant_message("first").into(),
            faux_assistant_message("second").into(),
        ]);

        let first = complete(registration.get_model(), &empty_context(), None).unwrap();
        let second = complete(registration.get_model(), &empty_context(), None).unwrap();
        let exhausted = complete(registration.get_model(), &empty_context(), None).unwrap();

        assert_eq!(text_content(&first), vec!["first"]);
        assert_eq!(text_content(&second), vec!["second"]);
        assert_eq!(exhausted.stop_reason, StopReason::Error);
        assert_eq!(
            exhausted.error_message.as_deref(),
            Some("No more faux responses queued")
        );
        assert_eq!(registration.get_pending_response_count(), 0);
        assert_eq!(registration.state.call_count(), 3);
    }

    #[test]
    fn faux_factories_see_context_model_and_call_count_state() {
        let _guard = registry_test_guard();
        let registration = register_faux_provider(RegisterFauxProviderOptions {
            api: Some("faux-factory".to_string()),
            models: vec![
                FauxModelDefinition {
                    name: Some("Fast".to_string()),
                    ..FauxModelDefinition::new("faux-fast")
                },
                FauxModelDefinition {
                    name: Some("Thinker".to_string()),
                    reasoning: Some(true),
                    ..FauxModelDefinition::new("faux-thinker")
                },
            ],
            ..RegisterFauxProviderOptions::default()
        });
        registration.set_responses(vec![
            FauxResponseStep::factory(|context, _options, state, model| {
                Ok(faux_assistant_message(format!(
                    "{}:{}:{}",
                    context.messages.len(),
                    state.call_count(),
                    model.id
                )))
            }),
            FauxResponseStep::factory(|_context, _options, state, model| {
                Ok(faux_assistant_message(format!(
                    "{}:{}",
                    state.call_count(),
                    model.reasoning
                )))
            }),
        ]);
        let context = Context {
            system_prompt: None,
            messages: vec![Message::User(UserMessage {
                content: "hello".into(),
                timestamp: 1,
            })],
            tools: None,
        };

        let fast = complete(
            registration.get_model_by_id("faux-fast").unwrap(),
            &context,
            None,
        )
        .unwrap();
        let thinker = complete(
            registration.get_model_by_id("faux-thinker").unwrap(),
            &context,
            None,
        )
        .unwrap();

        assert_eq!(text_content(&fast), vec!["1:1:faux-fast"]);
        assert_eq!(text_content(&thinker), vec!["2:true"]);
        assert_eq!(registration.state.call_count(), 2);
    }

    #[test]
    fn faux_usage_estimates_prompt_output_and_session_cache() {
        let _guard = registry_test_guard();
        let registration = register_faux_provider(RegisterFauxProviderOptions {
            api: Some("faux-usage".to_string()),
            ..RegisterFauxProviderOptions::default()
        });
        registration.set_responses(vec![
            faux_assistant_message("done").into(),
            faux_assistant_message("again").into(),
        ]);
        let tool = Tool {
            name: "echo".to_string(),
            description: "Echo back text".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string" }
                }
            }),
        };
        let mut context = Context {
            system_prompt: Some("sys".to_string()),
            messages: vec![
                Message::User(UserMessage {
                    content: UserContent::Blocks(vec![
                        faux_text("hello"),
                        ContentBlock::image("abcd", "image/png"),
                    ]),
                    timestamp: 1,
                }),
                Message::Assistant(faux_assistant_message_with_options(
                    "prior",
                    FauxAssistantMessageOptions {
                        timestamp: Some(2),
                        ..FauxAssistantMessageOptions::default()
                    },
                )),
                Message::ToolResult(ToolResultMessage {
                    tool_call_id: "tool-1".to_string(),
                    tool_name: "echo".to_string(),
                    content: vec![faux_text("tool out")],
                    details: None,
                    is_error: false,
                    timestamp: 3,
                }),
            ],
            tools: Some(vec![tool]),
        };
        let options = StreamOptions {
            session_id: Some("session-1".to_string()),
            cache_retention: Some(CacheRetention::Short),
            ..StreamOptions::default()
        };

        let first = complete(registration.get_model(), &context, Some(&options)).unwrap();
        let expected_prompt_tokens = estimate_tokens(&serialize_context(&context));
        assert_eq!(first.usage.input, expected_prompt_tokens);
        assert_eq!(first.usage.output, estimate_tokens("done"));
        assert_eq!(first.usage.cache_read, 0);
        assert_eq!(first.usage.cache_write, expected_prompt_tokens);
        assert_eq!(
            first.usage.total_tokens,
            first.usage.input
                + first.usage.output
                + first.usage.cache_read
                + first.usage.cache_write
        );

        context.messages.push(Message::Assistant(first));
        context.messages.push(Message::User(UserMessage {
            content: "follow up".into(),
            timestamp: 4,
        }));
        let second = complete(registration.get_model(), &context, Some(&options)).unwrap();

        assert!(second.usage.cache_read > 0);
        assert!(second.usage.cache_write > 0);
        assert_eq!(
            second.usage.total_tokens,
            second.usage.input
                + second.usage.output
                + second.usage.cache_read
                + second.usage.cache_write
        );
    }

    #[test]
    fn faux_unregister_removes_registered_provider() {
        let _guard = registry_test_guard();
        let registration = register_faux_provider(RegisterFauxProviderOptions {
            api: Some("faux-unregister".to_string()),
            ..RegisterFauxProviderOptions::default()
        });
        registration.set_responses(vec![faux_assistant_message("hello").into()]);
        let model = registration.get_model().clone();

        registration.unregister();
        let error = complete(&model, &empty_context(), None).unwrap_err();

        assert_eq!(
            error,
            StreamError::NoApiProvider {
                api: "faux-unregister".to_string()
            }
        );
    }
}
