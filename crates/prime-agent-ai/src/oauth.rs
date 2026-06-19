use crate::oauth_types::{
    OAuthCredentials, OAuthProviderId, OAuthProviderInfo, OAuthProviderInterface,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::error::Error;
use std::fmt;
use std::sync::{LazyLock, Mutex};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthHttpRequest {
    pub method: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

impl OAuthHttpRequest {
    pub fn new(method: impl Into<String>, url: impl Into<String>) -> Self {
        Self {
            method: method.into(),
            url: url.into(),
            headers: BTreeMap::new(),
            body: None,
        }
    }

    pub fn with_headers<I, K, V>(mut self, headers: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        self.headers.extend(
            headers
                .into_iter()
                .map(|(key, value)| (key.into(), value.into())),
        );
        self
    }

    pub fn with_body(mut self, body: impl Into<String>) -> Self {
        self.body = Some(body.into());
        self
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthAuthorizationInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthApiKeyResult {
    pub new_credentials: OAuthCredentials,
    pub api_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OAuthApiKeyError {
    UnknownProvider { provider_id: String },
    ExpiredCredentials { provider_id: String },
}

impl fmt::Display for OAuthApiKeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownProvider { provider_id } => {
                write!(f, "Unknown OAuth provider: {provider_id}")
            }
            Self::ExpiredCredentials { provider_id } => {
                write!(
                    f,
                    "OAuth credentials for {provider_id} are expired and require a provider refresh"
                )
            }
        }
    }
}

impl Error for OAuthApiKeyError {}

static OAUTH_PROVIDER_REGISTRY: LazyLock<Mutex<Vec<OAuthProviderInterface>>> =
    LazyLock::new(|| Mutex::new(built_in_oauth_providers()));

pub fn built_in_oauth_providers() -> Vec<OAuthProviderInterface> {
    vec![
        OAuthProviderInterface {
            id: "anthropic".to_string(),
            name: "Anthropic (Claude Pro/Max)".to_string(),
            uses_callback_server: Some(true),
        },
        OAuthProviderInterface {
            id: "github-copilot".to_string(),
            name: "GitHub Copilot".to_string(),
            uses_callback_server: None,
        },
        OAuthProviderInterface {
            id: "openai-codex".to_string(),
            name: "ChatGPT Plus/Pro (Codex Subscription)".to_string(),
            uses_callback_server: Some(true),
        },
    ]
}

pub fn get_oauth_provider(id: &str) -> Option<OAuthProviderInterface> {
    OAUTH_PROVIDER_REGISTRY
        .lock()
        .expect("OAuth provider registry mutex poisoned")
        .iter()
        .find(|provider| provider.id == id)
        .cloned()
}

pub fn register_oauth_provider(provider: OAuthProviderInterface) {
    let mut registry = OAUTH_PROVIDER_REGISTRY
        .lock()
        .expect("OAuth provider registry mutex poisoned");

    if let Some(existing) = registry
        .iter_mut()
        .find(|candidate| candidate.id == provider.id)
    {
        *existing = provider;
        return;
    }

    registry.push(provider);
}

pub fn unregister_oauth_provider(id: &str) {
    let built_ins = built_in_oauth_providers();
    let mut registry = OAUTH_PROVIDER_REGISTRY
        .lock()
        .expect("OAuth provider registry mutex poisoned");

    if let Some(built_in) = built_ins.into_iter().find(|provider| provider.id == id) {
        if let Some(existing) = registry.iter_mut().find(|provider| provider.id == id) {
            *existing = built_in;
        } else {
            registry.push(built_in);
        }
        return;
    }

    registry.retain(|provider| provider.id != id);
}

pub fn reset_oauth_providers() {
    *OAUTH_PROVIDER_REGISTRY
        .lock()
        .expect("OAuth provider registry mutex poisoned") = built_in_oauth_providers();
}

pub fn get_oauth_providers() -> Vec<OAuthProviderInterface> {
    OAUTH_PROVIDER_REGISTRY
        .lock()
        .expect("OAuth provider registry mutex poisoned")
        .clone()
}

pub fn get_oauth_provider_info_list() -> Vec<OAuthProviderInfo> {
    get_oauth_providers()
        .into_iter()
        .map(|provider| OAuthProviderInfo {
            id: provider.id,
            name: provider.name,
            available: true,
        })
        .collect()
}

pub fn get_oauth_api_key_if_fresh(
    provider_id: &str,
    credentials: &HashMap<OAuthProviderId, OAuthCredentials>,
    now_ms: i64,
) -> Result<Option<OAuthApiKeyResult>, OAuthApiKeyError> {
    if get_oauth_provider(provider_id).is_none() {
        return Err(OAuthApiKeyError::UnknownProvider {
            provider_id: provider_id.to_string(),
        });
    }

    let Some(creds) = credentials.get(provider_id) else {
        return Ok(None);
    };

    if now_ms >= creds.expires {
        return Err(OAuthApiKeyError::ExpiredCredentials {
            provider_id: provider_id.to_string(),
        });
    }

    Ok(Some(OAuthApiKeyResult {
        new_credentials: creds.clone(),
        api_key: creds.access.clone(),
    }))
}

pub fn parse_authorization_input(input: &str) -> OAuthAuthorizationInput {
    let value = input.trim();
    if value.is_empty() {
        return OAuthAuthorizationInput::default();
    }

    if let Some(query) = absolute_url_query(value) {
        return parse_query_authorization_input(query);
    }

    if value.contains('#') {
        let mut parts = value.split('#');
        return OAuthAuthorizationInput {
            code: parts.next().map(ToString::to_string),
            state: parts.next().map(ToString::to_string),
        };
    }

    if value.contains("code=") {
        return parse_query_authorization_input(value);
    }

    OAuthAuthorizationInput {
        code: Some(value.to_string()),
        state: None,
    }
}

pub fn append_query(url: &str, params: &[(&str, &str)]) -> String {
    let separator = if url.contains('?') { '&' } else { '?' };
    format!("{url}{separator}{}", form_urlencode(params))
}

pub fn form_urlencode(params: &[(&str, &str)]) -> String {
    params
        .iter()
        .map(|(key, value)| {
            format!(
                "{}={}",
                form_encode_component(key),
                form_encode_component(value)
            )
        })
        .collect::<Vec<_>>()
        .join("&")
}

pub fn form_encode_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                encoded.push(*byte as char);
            }
            b' ' => encoded.push('+'),
            _ => {
                encoded.push('%');
                encoded.push(hex_digit(byte >> 4));
                encoded.push(hex_digit(byte & 0x0f));
            }
        }
    }
    encoded
}

pub fn form_urldecode(value: &str) -> String {
    let mut decoded = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hi = from_hex_digit(bytes[index + 1]);
                let lo = from_hex_digit(bytes[index + 2]);
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    decoded.push((hi << 4) | lo);
                    index += 3;
                } else {
                    decoded.push(bytes[index]);
                    index += 1;
                }
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }

    String::from_utf8_lossy(&decoded).into_owned()
}

fn parse_query_authorization_input(query: &str) -> OAuthAuthorizationInput {
    let query = query.strip_prefix('?').unwrap_or(query);
    let mut code = None;
    let mut state = None;

    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = form_urldecode(key);
        if key == "code" && code.is_none() {
            code = Some(form_urldecode(value));
        } else if key == "state" && state.is_none() {
            state = Some(form_urldecode(value));
        }
    }

    OAuthAuthorizationInput { code, state }
}

fn absolute_url_query(value: &str) -> Option<&str> {
    if !value.contains("://") {
        return None;
    }

    let query_start = value.find('?')? + 1;
    let query_with_fragment = &value[query_start..];
    Some(query_with_fragment.split('#').next().unwrap_or(""))
}

fn hex_digit(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        10..=15 => (b'A' + value - 10) as char,
        _ => unreachable!("nibble must be <= 15"),
    }
}

fn from_hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn oauth_parse_authorization_input_accepts_full_redirect_url() {
        let parsed = parse_authorization_input(
            " http://localhost:1455/auth/callback?code=abc%2B123&state=state+value#ignored ",
        );

        assert_eq!(parsed.code.as_deref(), Some("abc+123"));
        assert_eq!(parsed.state.as_deref(), Some("state value"));
    }

    #[test]
    fn oauth_parse_authorization_input_accepts_code_state_fragment_pair() {
        let parsed = parse_authorization_input("code-value#state-value#discarded");

        assert_eq!(parsed.code.as_deref(), Some("code-value"));
        assert_eq!(parsed.state.as_deref(), Some("state-value"));
    }

    #[test]
    fn oauth_parse_authorization_input_accepts_query_string_or_raw_code() {
        let parsed = parse_authorization_input("code=abc&state=xyz");

        assert_eq!(parsed.code.as_deref(), Some("abc"));
        assert_eq!(parsed.state.as_deref(), Some("xyz"));

        let parsed = parse_authorization_input("raw-code");
        assert_eq!(parsed.code.as_deref(), Some("raw-code"));
        assert_eq!(parsed.state, None);
    }

    #[test]
    fn oauth_form_urlencode_matches_url_search_params_encoding() {
        assert_eq!(
            form_urlencode(&[
                ("scope", "openid profile email offline_access"),
                ("redirect_uri", "http://localhost:1455/auth/callback"),
                ("tilde", "~"),
            ]),
            "scope=openid+profile+email+offline_access&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&tilde=%7E"
        );
    }

    #[test]
    fn oauth_built_in_provider_metadata_matches_typescript_registry() {
        let providers = built_in_oauth_providers();
        let ids = providers
            .iter()
            .map(|provider| provider.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(ids, vec!["anthropic", "github-copilot", "openai-codex"]);
        assert_eq!(providers[0].uses_callback_server, Some(true));
        assert_eq!(providers[1].uses_callback_server, None);
        assert_eq!(providers[2].uses_callback_server, Some(true));
    }

    #[test]
    fn oauth_provider_interface_uses_camel_case_for_callback_server_flag() {
        let provider = OAuthProviderInterface {
            id: "test".to_string(),
            name: "Test".to_string(),
            uses_callback_server: Some(true),
        };

        assert_eq!(
            serde_json::to_value(provider).unwrap(),
            json!({
                "id": "test",
                "name": "Test",
                "usesCallbackServer": true,
            })
        );
    }
}
