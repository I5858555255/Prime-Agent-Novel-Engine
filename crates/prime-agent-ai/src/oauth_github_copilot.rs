use crate::oauth::{OAuthHttpRequest, form_urlencode};
use crate::oauth_types::{OAuthAuthInfo, OAuthCredentials, OAuthPrompt};
use crate::types::Model;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;

pub const GITHUB_COPILOT_CLIENT_ID: &str = "Iv1.b507a08c87ecfe98";
pub const GITHUB_COPILOT_DEFAULT_DOMAIN: &str = "github.com";
pub const GITHUB_COPILOT_DEFAULT_BASE_URL: &str = "https://api.individual.githubcopilot.com";
pub const GITHUB_COPILOT_USER_AGENT: &str = "GitHubCopilotChat/0.35.0";
pub const GITHUB_COPILOT_EDITOR_VERSION: &str = "vscode/1.107.0";
pub const GITHUB_COPILOT_EDITOR_PLUGIN_VERSION: &str = "copilot-chat/0.35.0";
pub const GITHUB_COPILOT_INTEGRATION_ID: &str = "vscode-chat";
pub const GITHUB_COPILOT_INITIAL_POLL_INTERVAL_MULTIPLIER: f64 = 1.2;
pub const GITHUB_COPILOT_SLOW_DOWN_POLL_INTERVAL_MULTIPLIER: f64 = 1.4;

const DEVICE_CODE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const TOKEN_REFRESH_SKEW_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubCopilotUrls {
    pub device_code_url: String,
    pub access_token_url: String,
    pub copilot_token_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitHubDeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitHubDeviceTokenSuccessResponse {
    pub access_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitHubDeviceTokenErrorResponse {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum GitHubDeviceTokenPollResponse {
    Success(GitHubDeviceTokenSuccessResponse),
    Error(GitHubDeviceTokenErrorResponse),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitHubCopilotTokenResponse {
    pub token: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitHubDevicePollAction {
    AuthorizationPending,
    SlowDown,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GitHubDevicePollState {
    pub interval_ms: u64,
    pub interval_multiplier: f64,
    pub slow_down_responses: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitHubDeviceFlowError {
    Failed {
        error: String,
        description: Option<String>,
    },
}

impl fmt::Display for GitHubDeviceFlowError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Failed { error, description } => {
                if let Some(description) = description {
                    write!(f, "Device flow failed: {error}: {description}")
                } else {
                    write!(f, "Device flow failed: {error}")
                }
            }
        }
    }
}

impl Error for GitHubDeviceFlowError {}

impl GitHubDevicePollState {
    pub fn new(interval_seconds: u64) -> Self {
        Self {
            interval_ms: 1000_u64.max(interval_seconds.saturating_mul(1000)),
            interval_multiplier: GITHUB_COPILOT_INITIAL_POLL_INTERVAL_MULTIPLIER,
            slow_down_responses: 0,
        }
    }

    pub fn wait_ms(&self, remaining_ms: u64) -> u64 {
        let wait = ((self.interval_ms as f64) * self.interval_multiplier).ceil() as u64;
        wait.min(remaining_ms)
    }

    pub fn apply_error(
        &mut self,
        response: &GitHubDeviceTokenErrorResponse,
    ) -> Result<GitHubDevicePollAction, GitHubDeviceFlowError> {
        match response.error.as_str() {
            "authorization_pending" => Ok(GitHubDevicePollAction::AuthorizationPending),
            "slow_down" => {
                self.slow_down_responses = self.slow_down_responses.saturating_add(1);
                self.interval_ms = response
                    .interval
                    .filter(|interval| *interval > 0)
                    .map(|interval| interval.saturating_mul(1000))
                    .unwrap_or_else(|| 1000_u64.max(self.interval_ms.saturating_add(5000)));
                self.interval_multiplier = GITHUB_COPILOT_SLOW_DOWN_POLL_INTERVAL_MULTIPLIER;
                Ok(GitHubDevicePollAction::SlowDown)
            }
            error => Err(GitHubDeviceFlowError::Failed {
                error: error.to_string(),
                description: response.error_description.clone(),
            }),
        }
    }

    pub fn timeout_error_message(&self) -> &'static str {
        if self.slow_down_responses > 0 {
            "Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again."
        } else {
            "Device flow timed out"
        }
    }
}

pub fn normalize_domain(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    let without_scheme = if let Some((scheme, rest)) = trimmed.split_once("://") {
        if scheme.is_empty() {
            return None;
        }
        rest
    } else {
        trimmed
    };

    let authority = without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let host = strip_port(host_port).trim_end_matches('.');

    if host.is_empty()
        || host.bytes().any(|byte| byte.is_ascii_whitespace())
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return None;
    }

    Some(host.to_ascii_lowercase())
}

pub fn github_copilot_urls(domain: &str) -> GitHubCopilotUrls {
    GitHubCopilotUrls {
        device_code_url: format!("https://{domain}/login/device/code"),
        access_token_url: format!("https://{domain}/login/oauth/access_token"),
        copilot_token_url: format!("https://api.{domain}/copilot_internal/v2/token"),
    }
}

pub fn github_copilot_headers() -> BTreeMap<String, String> {
    BTreeMap::from([
        (
            "User-Agent".to_string(),
            GITHUB_COPILOT_USER_AGENT.to_string(),
        ),
        (
            "Editor-Version".to_string(),
            GITHUB_COPILOT_EDITOR_VERSION.to_string(),
        ),
        (
            "Editor-Plugin-Version".to_string(),
            GITHUB_COPILOT_EDITOR_PLUGIN_VERSION.to_string(),
        ),
        (
            "Copilot-Integration-Id".to_string(),
            GITHUB_COPILOT_INTEGRATION_ID.to_string(),
        ),
    ])
}

pub fn get_base_url_from_copilot_token(token: &str) -> Option<String> {
    let start = token.find("proxy-ep=")? + "proxy-ep=".len();
    let proxy_host = token[start..].split(';').next().unwrap_or_default();
    if proxy_host.is_empty() {
        return None;
    }

    let api_host = proxy_host
        .strip_prefix("proxy.")
        .map(|suffix| format!("api.{suffix}"))
        .unwrap_or_else(|| proxy_host.to_string());

    Some(format!("https://{api_host}"))
}

pub fn get_github_copilot_base_url(token: Option<&str>, enterprise_domain: Option<&str>) -> String {
    if let Some(token) = token
        && let Some(url) = get_base_url_from_copilot_token(token)
    {
        return url;
    }

    if let Some(domain) = enterprise_domain {
        return format!("https://copilot-api.{domain}");
    }

    GITHUB_COPILOT_DEFAULT_BASE_URL.to_string()
}

pub fn github_copilot_enterprise_prompt() -> OAuthPrompt {
    OAuthPrompt {
        message: "GitHub Enterprise URL/domain (blank for github.com)".to_string(),
        placeholder: Some("company.ghe.com".to_string()),
        allow_empty: Some(true),
    }
}

pub fn github_copilot_device_auth_info(device: &GitHubDeviceCodeResponse) -> OAuthAuthInfo {
    OAuthAuthInfo {
        url: device.verification_uri.clone(),
        instructions: Some(format!("Enter code: {}", device.user_code)),
    }
}

pub fn build_github_device_code_request(domain: &str) -> OAuthHttpRequest {
    let urls = github_copilot_urls(domain);
    OAuthHttpRequest::new("POST", urls.device_code_url)
        .with_headers([
            ("Accept", "application/json"),
            ("Content-Type", "application/x-www-form-urlencoded"),
            ("User-Agent", GITHUB_COPILOT_USER_AGENT),
        ])
        .with_body(form_urlencode(&[
            ("client_id", GITHUB_COPILOT_CLIENT_ID),
            ("scope", "read:user"),
        ]))
}

pub fn build_github_access_token_poll_request(domain: &str, device_code: &str) -> OAuthHttpRequest {
    let urls = github_copilot_urls(domain);
    OAuthHttpRequest::new("POST", urls.access_token_url)
        .with_headers([
            ("Accept", "application/json"),
            ("Content-Type", "application/x-www-form-urlencoded"),
            ("User-Agent", GITHUB_COPILOT_USER_AGENT),
        ])
        .with_body(form_urlencode(&[
            ("client_id", GITHUB_COPILOT_CLIENT_ID),
            ("device_code", device_code),
            ("grant_type", DEVICE_CODE_GRANT_TYPE),
        ]))
}

pub fn build_github_copilot_token_request(
    refresh_token: &str,
    enterprise_domain: Option<&str>,
) -> OAuthHttpRequest {
    let domain = enterprise_domain.unwrap_or(GITHUB_COPILOT_DEFAULT_DOMAIN);
    let urls = github_copilot_urls(domain);
    let mut headers = BTreeMap::from([
        ("Accept".to_string(), "application/json".to_string()),
        (
            "Authorization".to_string(),
            format!("Bearer {refresh_token}"),
        ),
    ]);
    headers.extend(github_copilot_headers());

    OAuthHttpRequest {
        method: "GET".to_string(),
        url: urls.copilot_token_url,
        headers,
        body: None,
    }
}

pub fn build_enable_github_copilot_model_request(
    token: &str,
    model_id: &str,
    enterprise_domain: Option<&str>,
) -> OAuthHttpRequest {
    let base_url = get_github_copilot_base_url(Some(token), enterprise_domain);
    let mut headers = BTreeMap::from([
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Authorization".to_string(), format!("Bearer {token}")),
    ]);
    headers.extend(github_copilot_headers());
    headers.insert("openai-intent".to_string(), "chat-policy".to_string());
    headers.insert("x-interaction-type".to_string(), "chat-policy".to_string());

    OAuthHttpRequest {
        method: "POST".to_string(),
        url: format!("{base_url}/models/{model_id}/policy"),
        headers,
        body: Some(r#"{"state":"enabled"}"#.to_string()),
    }
}

pub fn parse_github_device_code_response(
    body: &str,
) -> Result<GitHubDeviceCodeResponse, serde_json::Error> {
    serde_json::from_str(body)
}

pub fn parse_github_device_token_poll_response(
    body: &str,
) -> Result<GitHubDeviceTokenPollResponse, serde_json::Error> {
    serde_json::from_str(body)
}

pub fn parse_github_copilot_token_response(
    body: &str,
) -> Result<GitHubCopilotTokenResponse, serde_json::Error> {
    serde_json::from_str(body)
}

pub fn github_copilot_credentials_from_token_response(
    refresh_token: &str,
    response: &GitHubCopilotTokenResponse,
    enterprise_domain: Option<&str>,
) -> OAuthCredentials {
    github_copilot_credentials(
        refresh_token,
        &response.token,
        response
            .expires_at
            .saturating_mul(1000)
            .saturating_sub(TOKEN_REFRESH_SKEW_MS),
        enterprise_domain,
    )
}

pub fn github_copilot_credentials(
    refresh_token: &str,
    access_token: &str,
    expires: i64,
    enterprise_domain: Option<&str>,
) -> OAuthCredentials {
    let mut extra = Map::new();
    if let Some(domain) = enterprise_domain {
        extra.insert(
            "enterpriseUrl".to_string(),
            Value::String(domain.to_string()),
        );
    }

    OAuthCredentials {
        refresh: refresh_token.to_string(),
        access: access_token.to_string(),
        expires,
        extra,
    }
}

pub fn modify_github_copilot_models(
    models: &[Model],
    credentials: &OAuthCredentials,
) -> Vec<Model> {
    let enterprise_domain = credentials
        .extra
        .get("enterpriseUrl")
        .and_then(Value::as_str)
        .and_then(normalize_domain);
    let base_url =
        get_github_copilot_base_url(Some(&credentials.access), enterprise_domain.as_deref());

    models
        .iter()
        .cloned()
        .map(|mut model| {
            if model.provider == "github-copilot" {
                model.base_url.clone_from(&base_url);
            }
            model
        })
        .collect()
}

fn strip_port(host_port: &str) -> &str {
    if host_port.starts_with('[') {
        return host_port;
    }

    let Some((host, port)) = host_port.rsplit_once(':') else {
        return host_port;
    };

    if port.bytes().all(|byte| byte.is_ascii_digit()) {
        host
    } else {
        host_port
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ModelInput, ModelPricing};
    use serde_json::json;

    #[test]
    fn oauth_github_normalize_domain_matches_url_hostname_behavior() {
        assert_eq!(
            normalize_domain(" company.ghe.com "),
            Some("company.ghe.com".to_string())
        );
        assert_eq!(
            normalize_domain("https://User:pass@Company.GHE.com:8443/path?q=1"),
            Some("company.ghe.com".to_string())
        );
        assert_eq!(
            normalize_domain("github.com:443"),
            Some("github.com".to_string())
        );
        assert_eq!(normalize_domain(""), None);
        assert_eq!(normalize_domain("not a domain"), None);
        assert_eq!(normalize_domain("https://"), None);
    }

    #[test]
    fn oauth_github_base_url_prefers_proxy_endpoint_in_token() {
        assert_eq!(
            get_base_url_from_copilot_token(
                "tid=abc;exp=123;proxy-ep=proxy.individual.githubcopilot.com;sku=test"
            )
            .as_deref(),
            Some("https://api.individual.githubcopilot.com")
        );
        assert_eq!(
            get_github_copilot_base_url(
                Some("x;proxy-ep=proxy.enterprise.example.com;y"),
                Some("ghe.example.com")
            ),
            "https://api.enterprise.example.com"
        );
        assert_eq!(
            get_github_copilot_base_url(None, Some("ghe.example.com")),
            "https://copilot-api.ghe.example.com"
        );
        assert_eq!(
            get_github_copilot_base_url(None, None),
            GITHUB_COPILOT_DEFAULT_BASE_URL
        );
    }

    #[test]
    fn oauth_github_builds_device_code_and_poll_requests() {
        let start = build_github_device_code_request("github.com");
        assert_eq!(start.method, "POST");
        assert_eq!(start.url, "https://github.com/login/device/code");
        assert_eq!(start.headers["Accept"], "application/json");
        assert_eq!(
            start.body.as_deref(),
            Some("client_id=Iv1.b507a08c87ecfe98&scope=read%3Auser")
        );

        let poll = build_github_access_token_poll_request("github.com", "device code");
        assert_eq!(poll.url, "https://github.com/login/oauth/access_token");
        assert_eq!(
            poll.body.as_deref(),
            Some(
                "client_id=Iv1.b507a08c87ecfe98&device_code=device+code&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"
            )
        );
    }

    #[test]
    fn oauth_github_builds_copilot_token_and_policy_requests() {
        let token = build_github_copilot_token_request("gh-token", Some("ghe.example.com"));
        assert_eq!(
            token.url,
            "https://api.ghe.example.com/copilot_internal/v2/token"
        );
        assert_eq!(token.method, "GET");
        assert_eq!(token.headers["Authorization"], "Bearer gh-token");
        assert_eq!(token.headers["Copilot-Integration-Id"], "vscode-chat");

        let policy = build_enable_github_copilot_model_request(
            "tid=x;proxy-ep=proxy.individual.githubcopilot.com;",
            "claude-3.5-sonnet",
            None,
        );
        assert_eq!(
            policy.url,
            "https://api.individual.githubcopilot.com/models/claude-3.5-sonnet/policy"
        );
        assert_eq!(policy.headers["openai-intent"], "chat-policy");
        assert_eq!(policy.body.as_deref(), Some(r#"{"state":"enabled"}"#));
    }

    #[test]
    fn oauth_github_parses_responses_and_shapes_credentials() {
        let device = parse_github_device_code_response(
            r#"{"device_code":"device","user_code":"ABCD","verification_uri":"https://github.com/login/device","interval":5,"expires_in":900}"#,
        )
        .unwrap();
        assert_eq!(device.user_code, "ABCD");

        let poll = parse_github_device_token_poll_response(r#"{"error":"authorization_pending"}"#)
            .unwrap();
        assert!(matches!(poll, GitHubDeviceTokenPollResponse::Error(_)));

        let response =
            parse_github_copilot_token_response(r#"{"token":"copilot","expires_at":1800}"#)
                .unwrap();
        let credentials = github_copilot_credentials_from_token_response(
            "github-access",
            &response,
            Some("ghe.example.com"),
        );

        assert_eq!(credentials.refresh, "github-access");
        assert_eq!(credentials.access, "copilot");
        assert_eq!(credentials.expires, 1_500_000);
        assert_eq!(
            serde_json::to_value(credentials).unwrap(),
            json!({
                "refresh": "github-access",
                "access": "copilot",
                "expires": 1_500_000,
                "enterpriseUrl": "ghe.example.com",
            })
        );
    }

    #[test]
    fn oauth_github_poll_state_handles_pending_slow_down_and_failures() {
        let mut state = GitHubDevicePollState::new(5);
        assert_eq!(state.wait_ms(10_000), 6000);

        let action = state
            .apply_error(&GitHubDeviceTokenErrorResponse {
                error: "authorization_pending".to_string(),
                error_description: None,
                interval: None,
            })
            .unwrap();
        assert_eq!(action, GitHubDevicePollAction::AuthorizationPending);

        let action = state
            .apply_error(&GitHubDeviceTokenErrorResponse {
                error: "slow_down".to_string(),
                error_description: None,
                interval: None,
            })
            .unwrap();
        assert_eq!(action, GitHubDevicePollAction::SlowDown);
        assert_eq!(state.interval_ms, 10_000);
        assert_eq!(state.wait_ms(30_000), 14_000);
        assert_eq!(
            state.timeout_error_message(),
            "Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again."
        );

        let error = state
            .apply_error(&GitHubDeviceTokenErrorResponse {
                error: "access_denied".to_string(),
                error_description: Some("denied".to_string()),
                interval: None,
            })
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Device flow failed: access_denied: denied"
        );
    }

    #[test]
    fn oauth_github_modify_models_updates_only_copilot_models() {
        let models = vec![
            test_model("github-copilot", "gpt-5"),
            test_model("openai", "gpt-5"),
        ];
        let credentials = github_copilot_credentials(
            "refresh",
            "tid=x;proxy-ep=proxy.individual.githubcopilot.com;",
            100,
            None,
        );

        let modified = modify_github_copilot_models(&models, &credentials);

        assert_eq!(
            modified[0].base_url,
            "https://api.individual.githubcopilot.com"
        );
        assert_eq!(modified[1].base_url, "https://original.example.com");
    }

    fn test_model(provider: &str, id: &str) -> Model {
        Model {
            id: id.to_string(),
            name: id.to_string(),
            api: "openai-completions".to_string(),
            provider: provider.to_string(),
            base_url: "https://original.example.com".to_string(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![ModelInput::Text],
            cost: ModelPricing::default(),
            context_window: 1,
            max_tokens: 1,
            headers: None,
            compat: None,
        }
    }
}
