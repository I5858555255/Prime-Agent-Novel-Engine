use std::collections::{BTreeMap, HashSet};
use std::error::Error;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::openai_responses_shared::{
    OpenAIResponsesSharedError, convert_responses_messages, convert_responses_tools,
};
use crate::stream::StreamOptions;
use crate::types::{Context, Model};

pub const DEFAULT_AZURE_API_VERSION: &str = "v1";

const AZURE_OPENAI_API_KEY_ENV: &str = "AZURE_OPENAI_API_KEY";
const AZURE_OPENAI_API_VERSION_ENV: &str = "AZURE_OPENAI_API_VERSION";
const AZURE_OPENAI_BASE_URL_ENV: &str = "AZURE_OPENAI_BASE_URL";
const AZURE_OPENAI_RESOURCE_NAME_ENV: &str = "AZURE_OPENAI_RESOURCE_NAME";
const AZURE_OPENAI_DEPLOYMENT_NAME_MAP_ENV: &str = "AZURE_OPENAI_DEPLOYMENT_NAME_MAP";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureOpenAIResponsesOptions {
    #[serde(flatten)]
    pub stream: StreamOptions,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub azure_api_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub azure_resource_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub azure_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub azure_deployment_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AzureOpenAIResponsesConfig {
    pub base_url: String,
    pub api_version: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AzureOpenAIResponsesClientConfig {
    pub api_key: String,
    pub base_url: String,
    pub api_version: String,
    pub headers: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AzureOpenAIResponsesRequest {
    pub deployment_name: String,
    pub config: AzureOpenAIResponsesConfig,
    pub url: String,
    pub payload: Value,
}

pub type AzureOpenAIResponsesResult<T> = Result<T, AzureOpenAIResponsesError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AzureOpenAIResponsesError {
    InvalidBaseUrl { base_url: String },
    MissingBaseUrl,
    MissingApiKey,
    Shared(OpenAIResponsesSharedError),
}

impl fmt::Display for AzureOpenAIResponsesError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidBaseUrl { base_url } => {
                write!(formatter, "Invalid Azure OpenAI base URL: {base_url}")
            }
            Self::MissingBaseUrl => formatter.write_str(
                "Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or \
                 AZURE_OPENAI_RESOURCE_NAME, or pass azureBaseUrl, azureResourceName, or \
                 model.baseUrl.",
            ),
            Self::MissingApiKey => formatter.write_str(
                "Azure OpenAI API key is required. Set AZURE_OPENAI_API_KEY environment variable \
                 or pass it as an argument.",
            ),
            Self::Shared(error) => error.fmt(formatter),
        }
    }
}

impl Error for AzureOpenAIResponsesError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Shared(error) => Some(error),
            _ => None,
        }
    }
}

impl From<OpenAIResponsesSharedError> for AzureOpenAIResponsesError {
    fn from(error: OpenAIResponsesSharedError) -> Self {
        Self::Shared(error)
    }
}

pub fn parse_deployment_name_map(value: Option<&str>) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    let Some(value) = value else {
        return map;
    };

    for entry in value.split(',') {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            continue;
        }

        let mut parts = trimmed.split('=');
        let Some(model_id) = parts.next() else {
            continue;
        };
        let Some(deployment_name) = parts.next() else {
            continue;
        };

        if model_id.is_empty() || deployment_name.is_empty() {
            continue;
        }

        map.insert(
            model_id.trim().to_string(),
            deployment_name.trim().to_string(),
        );
    }

    map
}

pub fn resolve_deployment_name(
    model: &Model,
    options: Option<&AzureOpenAIResponsesOptions>,
) -> String {
    resolve_deployment_name_with_env(model, options, |name| std::env::var(name).ok())
}

pub fn resolve_deployment_name_with_env(
    model: &Model,
    options: Option<&AzureOpenAIResponsesOptions>,
    mut env: impl FnMut(&str) -> Option<String>,
) -> String {
    if let Some(deployment_name) = options
        .and_then(|options| options.azure_deployment_name.as_ref())
        .filter(|deployment_name| !deployment_name.is_empty())
    {
        return deployment_name.clone();
    }

    let map_value = env(AZURE_OPENAI_DEPLOYMENT_NAME_MAP_ENV);
    parse_deployment_name_map(map_value.as_deref())
        .get(&model.id)
        .cloned()
        .unwrap_or_else(|| model.id.clone())
}

pub fn normalize_azure_base_url(base_url: &str) -> AzureOpenAIResponsesResult<String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    let mut parsed =
        ParsedBaseUrl::parse(trimmed).ok_or_else(|| AzureOpenAIResponsesError::InvalidBaseUrl {
            base_url: base_url.to_string(),
        })?;

    let normalized_path = parsed.path.trim_end_matches('/');
    if parsed.is_azure_host()
        && (normalized_path.is_empty() || normalized_path == "/" || normalized_path == "/openai")
    {
        parsed.path = "/openai/v1".to_string();
        parsed.query = None;
    }

    Ok(parsed.to_url_string().trim_end_matches('/').to_string())
}

pub fn build_default_base_url(resource_name: &str) -> String {
    format!("https://{resource_name}.openai.azure.com/openai/v1")
}

pub fn resolve_azure_config(
    model: &Model,
    options: Option<&AzureOpenAIResponsesOptions>,
) -> AzureOpenAIResponsesResult<AzureOpenAIResponsesConfig> {
    resolve_azure_config_with_env(model, options, |name| std::env::var(name).ok())
}

pub fn resolve_azure_config_with_env(
    model: &Model,
    options: Option<&AzureOpenAIResponsesOptions>,
    mut env: impl FnMut(&str) -> Option<String>,
) -> AzureOpenAIResponsesResult<AzureOpenAIResponsesConfig> {
    let api_version = options
        .and_then(|options| options.azure_api_version.as_ref())
        .filter(|api_version| !api_version.is_empty())
        .cloned()
        .or_else(|| env(AZURE_OPENAI_API_VERSION_ENV).filter(|api_version| !api_version.is_empty()))
        .unwrap_or_else(|| DEFAULT_AZURE_API_VERSION.to_string());

    let base_url = options
        .and_then(|options| options.azure_base_url.as_deref())
        .and_then(trimmed_non_empty)
        .or_else(|| env(AZURE_OPENAI_BASE_URL_ENV).and_then(|value| trimmed_non_empty(&value)));

    let resource_name = options
        .and_then(|options| options.azure_resource_name.as_ref())
        .filter(|resource_name| !resource_name.is_empty())
        .cloned()
        .or_else(|| {
            env(AZURE_OPENAI_RESOURCE_NAME_ENV).filter(|resource_name| !resource_name.is_empty())
        });

    let resolved_base_url = base_url
        .or_else(|| resource_name.as_deref().map(build_default_base_url))
        .or_else(|| (!model.base_url.is_empty()).then(|| model.base_url.clone()))
        .ok_or(AzureOpenAIResponsesError::MissingBaseUrl)?;

    Ok(AzureOpenAIResponsesConfig {
        base_url: normalize_azure_base_url(&resolved_base_url)?,
        api_version,
    })
}

pub fn resolve_azure_client_config(
    model: &Model,
    options: Option<&AzureOpenAIResponsesOptions>,
) -> AzureOpenAIResponsesResult<AzureOpenAIResponsesClientConfig> {
    resolve_azure_client_config_with_env(model, options, |name| std::env::var(name).ok())
}

pub fn resolve_azure_client_config_with_env(
    model: &Model,
    options: Option<&AzureOpenAIResponsesOptions>,
    mut env: impl FnMut(&str) -> Option<String>,
) -> AzureOpenAIResponsesResult<AzureOpenAIResponsesClientConfig> {
    let api_key = options
        .and_then(|options| options.stream.api_key.as_ref())
        .filter(|api_key| !api_key.is_empty())
        .cloned()
        .or_else(|| env(AZURE_OPENAI_API_KEY_ENV).filter(|api_key| !api_key.is_empty()))
        .ok_or(AzureOpenAIResponsesError::MissingApiKey)?;

    let config = resolve_azure_config_with_env(model, options, &mut env)?;
    let mut headers = model.headers.clone().unwrap_or_default();
    if let Some(option_headers) = options.and_then(|options| options.stream.headers.as_ref()) {
        for (key, value) in option_headers {
            headers.insert(key.clone(), Value::String(value.clone()));
        }
    }

    Ok(AzureOpenAIResponsesClientConfig {
        api_key,
        base_url: config.base_url,
        api_version: config.api_version,
        headers,
    })
}

pub fn build_responses_request_url(config: &AzureOpenAIResponsesConfig) -> String {
    build_responses_request_url_from_parts(&config.base_url, &config.api_version)
}

pub fn build_responses_request_url_from_parts(base_url: &str, api_version: &str) -> String {
    let (without_fragment, fragment) = split_once(base_url, '#');
    let (without_query, query) = split_once(without_fragment, '?');

    let mut url = without_query.trim_end_matches('/').to_string();
    url.push_str("/responses");

    let query = merge_api_version_query(query, api_version);
    if !query.is_empty() {
        url.push('?');
        url.push_str(&query);
    }

    if let Some(fragment) = fragment {
        url.push('#');
        url.push_str(fragment);
    }

    url
}

pub fn build_azure_openai_responses_payload(
    model: &Model,
    context: &Context,
    options: Option<&AzureOpenAIResponsesOptions>,
    deployment_name: &str,
) -> AzureOpenAIResponsesResult<Value> {
    let messages = convert_responses_messages(model, context, &azure_tool_call_providers(), None)?;
    let mut params = Map::new();
    params.insert(
        "model".to_string(),
        Value::String(deployment_name.to_string()),
    );
    params.insert("input".to_string(), Value::Array(messages));
    params.insert("stream".to_string(), Value::Bool(true));

    if let Some(session_id) = options.and_then(|options| options.stream.session_id.as_ref()) {
        params.insert(
            "prompt_cache_key".to_string(),
            Value::String(session_id.clone()),
        );
    }

    if let Some(max_tokens) = options
        .and_then(|options| options.stream.max_tokens)
        .filter(|max_tokens| *max_tokens > 0)
    {
        params.insert("max_output_tokens".to_string(), Value::from(max_tokens));
    }

    if let Some(temperature) = options.and_then(|options| options.stream.temperature) {
        params.insert("temperature".to_string(), Value::from(temperature));
    }

    if let Some(tools) = context.tools.as_ref().filter(|tools| !tools.is_empty()) {
        params.insert(
            "tools".to_string(),
            Value::Array(convert_responses_tools(tools, None)),
        );
    }

    add_reasoning_params(model, options, &mut params);

    Ok(Value::Object(params))
}

pub fn build_azure_openai_responses_request(
    model: &Model,
    context: &Context,
    options: Option<&AzureOpenAIResponsesOptions>,
) -> AzureOpenAIResponsesResult<AzureOpenAIResponsesRequest> {
    build_azure_openai_responses_request_with_env(model, context, options, |name| {
        std::env::var(name).ok()
    })
}

pub fn build_azure_openai_responses_request_with_env(
    model: &Model,
    context: &Context,
    options: Option<&AzureOpenAIResponsesOptions>,
    mut env: impl FnMut(&str) -> Option<String>,
) -> AzureOpenAIResponsesResult<AzureOpenAIResponsesRequest> {
    let deployment_name = resolve_deployment_name_with_env(model, options, &mut env);
    let config = resolve_azure_config_with_env(model, options, &mut env)?;
    let url = build_responses_request_url(&config);
    let payload = build_azure_openai_responses_payload(model, context, options, &deployment_name)?;

    Ok(AzureOpenAIResponsesRequest {
        deployment_name,
        config,
        url,
        payload,
    })
}

fn azure_tool_call_providers() -> HashSet<String> {
    [
        "openai",
        "openai-codex",
        "opencode",
        "azure-openai-responses",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn add_reasoning_params(
    model: &Model,
    options: Option<&AzureOpenAIResponsesOptions>,
    params: &mut Map<String, Value>,
) {
    if !model.reasoning {
        return;
    }

    let reasoning_effort = options
        .and_then(|options| options.reasoning_effort.as_deref())
        .filter(|effort| !effort.is_empty());
    let reasoning_summary = options
        .and_then(|options| options.reasoning_summary.as_deref())
        .filter(|summary| !summary.is_empty());

    if reasoning_effort.is_some() || reasoning_summary.is_some() {
        let effort = reasoning_effort
            .map(|effort| {
                mapped_thinking_level(model, effort).unwrap_or_else(|| effort.to_string())
            })
            .unwrap_or_else(|| "medium".to_string());
        let summary = reasoning_summary.unwrap_or("auto").to_string();
        params.insert(
            "reasoning".to_string(),
            object_from_iter([
                ("effort", Value::String(effort)),
                ("summary", Value::String(summary)),
            ]),
        );
        params.insert(
            "include".to_string(),
            Value::Array(vec![Value::String(
                "reasoning.encrypted_content".to_string(),
            )]),
        );
    } else if thinking_level_is_not_null(model, "off") {
        let effort = mapped_thinking_level(model, "off").unwrap_or_else(|| "none".to_string());
        params.insert(
            "reasoning".to_string(),
            object_from_iter([("effort", Value::String(effort))]),
        );
    }
}

fn mapped_thinking_level(model: &Model, level: &str) -> Option<String> {
    model
        .thinking_level_map
        .as_ref()
        .and_then(|map| map.get(level))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn thinking_level_is_not_null(model: &Model, level: &str) -> bool {
    model
        .thinking_level_map
        .as_ref()
        .and_then(|map| map.get(level))
        .is_none_or(|value| !value.is_null())
}

fn trimmed_non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn split_once(value: &str, delimiter: char) -> (&str, Option<&str>) {
    value
        .split_once(delimiter)
        .map_or((value, None), |(head, tail)| (head, Some(tail)))
}

fn merge_api_version_query(query: Option<&str>, api_version: &str) -> String {
    let mut parts = query
        .into_iter()
        .flat_map(|query| query.split('&'))
        .filter(|part| !part.is_empty() && !part.starts_with("api-version="))
        .map(str::to_string)
        .collect::<Vec<_>>();
    parts.push(format!("api-version={api_version}"));
    parts.join("&")
}

fn object_from_iter<const N: usize>(entries: [(&str, Value); N]) -> Value {
    Value::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedBaseUrl {
    scheme: String,
    authority: String,
    path: String,
    query: Option<String>,
    fragment: Option<String>,
}

impl ParsedBaseUrl {
    fn parse(value: &str) -> Option<Self> {
        let (scheme, after_scheme) = value.split_once("://")?;
        if scheme.is_empty() || after_scheme.is_empty() {
            return None;
        }

        let authority_end = after_scheme
            .find(|character| ['/', '?', '#'].contains(&character))
            .unwrap_or(after_scheme.len());
        let authority = &after_scheme[..authority_end];
        if authority.is_empty()
            || scheme.chars().any(char::is_whitespace)
            || authority.chars().any(char::is_whitespace)
        {
            return None;
        }

        let tail = &after_scheme[authority_end..];
        let (without_fragment, fragment) = split_once(tail, '#');
        let (path, query) = split_once(without_fragment, '?');

        Some(Self {
            scheme: scheme.to_string(),
            authority: authority.to_string(),
            path: path.to_string(),
            query: query.map(str::to_string),
            fragment: fragment.map(str::to_string),
        })
    }

    fn is_azure_host(&self) -> bool {
        let hostname = self.hostname().to_ascii_lowercase();
        hostname.ends_with(".openai.azure.com")
            || hostname.ends_with(".cognitiveservices.azure.com")
    }

    fn hostname(&self) -> &str {
        let without_userinfo = self
            .authority
            .rsplit_once('@')
            .map_or(self.authority.as_str(), |(_, host)| host);
        if let Some(rest) = without_userinfo.strip_prefix('[') {
            return rest
                .split_once(']')
                .map_or(without_userinfo, |(host, _)| host);
        }
        without_userinfo
            .split_once(':')
            .map_or(without_userinfo, |(host, _)| host)
    }

    fn to_url_string(&self) -> String {
        let mut value = format!("{}://{}", self.scheme, self.authority);
        value.push_str(&self.path);
        if let Some(query) = &self.query {
            value.push('?');
            value.push_str(query);
        }
        if let Some(fragment) = &self.fragment {
            value.push('#');
            value.push_str(fragment);
        }
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::{Map, json};

    use crate::types::{Message, ModelPricing, Tool, UserMessage};

    fn model(id: &str) -> Model {
        Model {
            id: id.to_string(),
            name: id.to_string(),
            api: "azure-openai-responses".to_string(),
            provider: "azure-openai-responses".to_string(),
            base_url: String::new(),
            reasoning: false,
            thinking_level_map: None,
            input: Vec::new(),
            cost: ModelPricing::default(),
            context_window: 128_000,
            max_tokens: 16_000,
            headers: None,
            compat: None,
        }
    }

    fn user_context() -> Context {
        Context {
            system_prompt: Some("You are concise.".to_string()),
            messages: vec![Message::User(UserMessage {
                content: "Hello".into(),
                timestamp: 0,
            })],
            tools: None,
        }
    }

    #[test]
    fn azure_openai_responses_parses_deployment_name_map_like_typescript() {
        let parsed = parse_deployment_name_map(Some(
            " gpt-4o-mini = mini-prod ,, bad, gpt-4o=prod, ignored=first=second ",
        ));

        assert_eq!(
            parsed.get("gpt-4o-mini").map(String::as_str),
            Some("mini-prod")
        );
        assert_eq!(parsed.get("gpt-4o").map(String::as_str), Some("prod"));
        assert_eq!(parsed.get("ignored").map(String::as_str), Some("first"));
        assert!(!parsed.contains_key("bad"));
    }

    #[test]
    fn azure_openai_responses_resolves_deployment_from_options_env_then_model_id() {
        let target = model("gpt-4o-mini");
        let options = AzureOpenAIResponsesOptions {
            azure_deployment_name: Some("explicit-deployment".to_string()),
            ..AzureOpenAIResponsesOptions::default()
        };

        assert_eq!(
            resolve_deployment_name_with_env(&target, Some(&options), |_| {
                Some("gpt-4o-mini=env-deployment".to_string())
            }),
            "explicit-deployment"
        );
        assert_eq!(
            resolve_deployment_name_with_env(&target, None, |name| {
                (name == AZURE_OPENAI_DEPLOYMENT_NAME_MAP_ENV)
                    .then(|| "gpt-4o-mini=env-deployment".to_string())
            }),
            "env-deployment"
        );
        assert_eq!(
            resolve_deployment_name_with_env(&target, None, |_| None),
            "gpt-4o-mini"
        );
    }

    #[test]
    fn azure_openai_responses_normalizes_azure_base_urls() {
        assert_eq!(
            normalize_azure_base_url("https://my-resource.openai.azure.com").unwrap(),
            "https://my-resource.openai.azure.com/openai/v1"
        );
        assert_eq!(
            normalize_azure_base_url("https://my-resource.cognitiveservices.azure.com/openai/")
                .unwrap(),
            "https://my-resource.cognitiveservices.azure.com/openai/v1"
        );
        assert_eq!(
            normalize_azure_base_url("https://my-resource.openai.azure.com/openai?api-version=old")
                .unwrap(),
            "https://my-resource.openai.azure.com/openai/v1"
        );
        assert_eq!(
            normalize_azure_base_url("https://proxy.example.com/v1?custom=true").unwrap(),
            "https://proxy.example.com/v1?custom=true"
        );
        assert_eq!(
            normalize_azure_base_url("not-a-url").unwrap_err(),
            AzureOpenAIResponsesError::InvalidBaseUrl {
                base_url: "not-a-url".to_string()
            }
        );
    }

    #[test]
    fn azure_openai_responses_resolves_config_with_option_env_resource_and_model_precedence() {
        let target = Model {
            base_url: "https://model.example.com/root".to_string(),
            ..model("gpt-4o-mini")
        };
        let options = AzureOpenAIResponsesOptions {
            azure_base_url: Some(" https://option.openai.azure.com/openai ".to_string()),
            azure_api_version: Some("2025-01-01-preview".to_string()),
            ..AzureOpenAIResponsesOptions::default()
        };

        let from_options =
            resolve_azure_config_with_env(&target, Some(&options), |name| match name {
                AZURE_OPENAI_BASE_URL_ENV => Some("https://env.openai.azure.com".to_string()),
                AZURE_OPENAI_API_VERSION_ENV => Some("2024-12-01-preview".to_string()),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            from_options,
            AzureOpenAIResponsesConfig {
                base_url: "https://option.openai.azure.com/openai/v1".to_string(),
                api_version: "2025-01-01-preview".to_string(),
            }
        );

        let from_env = resolve_azure_config_with_env(&target, None, |name| match name {
            AZURE_OPENAI_BASE_URL_ENV => Some("https://env.openai.azure.com".to_string()),
            AZURE_OPENAI_API_VERSION_ENV => Some("2024-12-01-preview".to_string()),
            _ => None,
        })
        .unwrap();
        assert_eq!(from_env.base_url, "https://env.openai.azure.com/openai/v1");
        assert_eq!(from_env.api_version, "2024-12-01-preview");

        let from_resource = resolve_azure_config_with_env(&target, None, |name| {
            (name == AZURE_OPENAI_RESOURCE_NAME_ENV).then(|| "resource-name".to_string())
        })
        .unwrap();
        assert_eq!(
            from_resource.base_url,
            "https://resource-name.openai.azure.com/openai/v1"
        );
        assert_eq!(from_resource.api_version, DEFAULT_AZURE_API_VERSION);

        let from_model = resolve_azure_config_with_env(&target, None, |_| None).unwrap();
        assert_eq!(from_model.base_url, "https://model.example.com/root");
    }

    #[test]
    fn azure_openai_responses_resolves_client_config_api_key_and_headers() {
        let target = Model {
            headers: Some(Map::from_iter([(
                "x-model".to_string(),
                Value::String("model".to_string()),
            )])),
            ..model("gpt-4o-mini")
        };
        let mut option_headers = std::collections::HashMap::new();
        option_headers.insert("x-option".to_string(), "option".to_string());
        let options = AzureOpenAIResponsesOptions {
            stream: StreamOptions {
                api_key: Some("option-key".to_string()),
                headers: Some(option_headers),
                ..StreamOptions::default()
            },
            azure_base_url: Some("https://resource.openai.azure.com".to_string()),
            ..AzureOpenAIResponsesOptions::default()
        };

        let config = resolve_azure_client_config_with_env(&target, Some(&options), |name| {
            (name == AZURE_OPENAI_API_KEY_ENV).then(|| "env-key".to_string())
        })
        .unwrap();

        assert_eq!(config.api_key, "option-key");
        assert_eq!(
            config.base_url,
            "https://resource.openai.azure.com/openai/v1"
        );
        assert_eq!(config.api_version, DEFAULT_AZURE_API_VERSION);
        assert_eq!(config.headers["x-model"], "model");
        assert_eq!(config.headers["x-option"], "option");
    }

    #[test]
    fn azure_openai_responses_builds_responses_request_url_with_api_version() {
        let config = AzureOpenAIResponsesConfig {
            base_url: "https://resource.openai.azure.com/openai/v1".to_string(),
            api_version: "2024-12-01-preview".to_string(),
        };

        assert_eq!(
            build_responses_request_url(&config),
            "https://resource.openai.azure.com/openai/v1/responses?api-version=2024-12-01-preview"
        );
        assert_eq!(
            build_responses_request_url_from_parts(
                "https://proxy.example.com/v1?custom=true",
                "v1"
            ),
            "https://proxy.example.com/v1/responses?custom=true&api-version=v1"
        );
    }

    #[test]
    fn azure_openai_responses_builds_request_payload_shape() {
        let mut target = model("gpt-4o-mini");
        target.reasoning = true;
        target.thinking_level_map = Some(Map::from_iter([(
            "high".to_string(),
            Value::String("mapped-high".to_string()),
        )]));
        let mut context = user_context();
        context.tools = Some(vec![Tool {
            name: "lookup".to_string(),
            description: "Lookup a value".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" }
                },
                "required": ["query"]
            }),
        }]);
        let options = AzureOpenAIResponsesOptions {
            stream: StreamOptions {
                max_tokens: Some(256),
                temperature: Some(0.0),
                session_id: Some("session-1".to_string()),
                ..StreamOptions::default()
            },
            reasoning_effort: Some("high".to_string()),
            reasoning_summary: Some("detailed".to_string()),
            ..AzureOpenAIResponsesOptions::default()
        };

        let payload =
            build_azure_openai_responses_payload(&target, &context, Some(&options), "deployment-1")
                .unwrap();

        assert_eq!(payload["model"], "deployment-1");
        assert_eq!(payload["stream"], true);
        assert_eq!(payload["prompt_cache_key"], "session-1");
        assert_eq!(payload["max_output_tokens"], 256);
        assert_eq!(payload["temperature"], 0.0);
        assert_eq!(payload["input"][0]["role"], "developer");
        assert_eq!(payload["input"][1]["role"], "user");
        assert_eq!(payload["tools"][0]["name"], "lookup");
        assert_eq!(payload["tools"][0]["strict"], false);
        assert_eq!(payload["reasoning"]["effort"], "mapped-high");
        assert_eq!(payload["reasoning"]["summary"], "detailed");
        assert_eq!(payload["include"][0], "reasoning.encrypted_content");
    }

    #[test]
    fn azure_openai_responses_request_combines_config_deployment_url_and_payload() {
        let target = model("gpt-4o-mini");
        let options = AzureOpenAIResponsesOptions {
            azure_base_url: Some("https://resource.openai.azure.com".to_string()),
            azure_api_version: Some("v1".to_string()),
            ..AzureOpenAIResponsesOptions::default()
        };

        let request = build_azure_openai_responses_request_with_env(
            &target,
            &user_context(),
            Some(&options),
            |name| {
                (name == AZURE_OPENAI_DEPLOYMENT_NAME_MAP_ENV)
                    .then(|| "gpt-4o-mini=deployment-from-env".to_string())
            },
        )
        .unwrap();

        assert_eq!(request.deployment_name, "deployment-from-env");
        assert_eq!(
            request.url,
            "https://resource.openai.azure.com/openai/v1/responses?api-version=v1"
        );
        assert_eq!(request.payload["model"], "deployment-from-env");
    }
}
