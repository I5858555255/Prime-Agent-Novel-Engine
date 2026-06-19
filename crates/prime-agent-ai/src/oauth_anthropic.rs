use crate::oauth::{
    OAuthAuthorizationInput, OAuthHttpRequest, append_query, parse_authorization_input,
};
use crate::oauth_pkce::OAuthPkce;
use crate::oauth_types::{OAuthAuthInfo, OAuthCredentials, OAuthPrompt};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;

pub const ANTHROPIC_CALLBACK_HOST_ENV_VAR: &str = "PI_OAUTH_CALLBACK_HOST";
pub const ANTHROPIC_DEFAULT_CALLBACK_HOST: &str = "127.0.0.1";
pub const ANTHROPIC_CLIENT_ID: &str = "9d1c250a-e61b-44d5-88ed-5944d1962f5e";
pub const ANTHROPIC_AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
pub const ANTHROPIC_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
pub const ANTHROPIC_CALLBACK_PORT: u16 = 53692;
pub const ANTHROPIC_CALLBACK_PATH: &str = "/callback";
pub const ANTHROPIC_REDIRECT_URI: &str = "http://localhost:53692/callback";
pub const ANTHROPIC_SCOPES: &str = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

const TOKEN_REFRESH_SKEW_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnthropicAuthorizationFlow {
    pub verifier: String,
    pub state: String,
    pub redirect_uri: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnthropicTokenResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnthropicFormattedError {
    pub name: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errno: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<Box<AnthropicFormattedError>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnthropicTokenError {
    InvalidJson { body: String, details: String },
    MissingFields { body: String },
}

impl fmt::Display for AnthropicTokenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidJson { body, details } => write!(
                f,
                "Anthropic token response returned invalid JSON. url={ANTHROPIC_TOKEN_URL}; body={body}; details={details}"
            ),
            Self::MissingFields { body } => write!(
                f,
                "Anthropic token response missing fields. url={ANTHROPIC_TOKEN_URL}; body={body}"
            ),
        }
    }
}

impl Error for AnthropicTokenError {}

pub fn create_anthropic_authorization_flow(pkce: &OAuthPkce) -> AnthropicAuthorizationFlow {
    AnthropicAuthorizationFlow {
        verifier: pkce.verifier.clone(),
        state: pkce.verifier.clone(),
        redirect_uri: ANTHROPIC_REDIRECT_URI.to_string(),
        url: build_anthropic_authorization_url(&pkce.challenge, &pkce.verifier),
    }
}

pub fn build_anthropic_authorization_url(challenge: &str, state: &str) -> String {
    append_query(
        ANTHROPIC_AUTHORIZE_URL,
        &[
            ("code", "true"),
            ("client_id", ANTHROPIC_CLIENT_ID),
            ("response_type", "code"),
            ("redirect_uri", ANTHROPIC_REDIRECT_URI),
            ("scope", ANTHROPIC_SCOPES),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("state", state),
        ],
    )
}

pub fn parse_anthropic_authorization_input(input: &str) -> OAuthAuthorizationInput {
    parse_authorization_input(input)
}

pub fn anthropic_auth_info(url: impl Into<String>) -> OAuthAuthInfo {
    OAuthAuthInfo {
        url: url.into(),
        instructions: Some(
            "Complete login in your browser. If the browser is on another machine, paste the final redirect URL here."
                .to_string(),
        ),
    }
}

pub fn anthropic_manual_code_prompt() -> OAuthPrompt {
    OAuthPrompt {
        message: "Paste the authorization code or full redirect URL:".to_string(),
        placeholder: Some(ANTHROPIC_REDIRECT_URI.to_string()),
        allow_empty: None,
    }
}

pub fn build_anthropic_authorization_code_exchange_request(
    code: &str,
    state: &str,
    verifier: &str,
    redirect_uri: &str,
) -> OAuthHttpRequest {
    json_request(json!({
        "grant_type": "authorization_code",
        "client_id": ANTHROPIC_CLIENT_ID,
        "code": code,
        "state": state,
        "redirect_uri": redirect_uri,
        "code_verifier": verifier,
    }))
}

pub fn build_anthropic_refresh_token_request(refresh_token: &str) -> OAuthHttpRequest {
    json_request(json!({
        "grant_type": "refresh_token",
        "client_id": ANTHROPIC_CLIENT_ID,
        "refresh_token": refresh_token,
    }))
}

pub fn parse_anthropic_token_response(
    body: &str,
    now_ms: i64,
) -> Result<OAuthCredentials, AnthropicTokenError> {
    let value =
        serde_json::from_str::<Value>(body).map_err(|error| AnthropicTokenError::InvalidJson {
            body: body.to_string(),
            details: error.to_string(),
        })?;

    let response =
        serde_json::from_value::<AnthropicTokenResponse>(value.clone()).map_err(|error| {
            AnthropicTokenError::InvalidJson {
                body: body.to_string(),
                details: error.to_string(),
            }
        })?;

    anthropic_credentials_from_token_response(&response, now_ms).map_err(|_| {
        AnthropicTokenError::MissingFields {
            body: serde_json::to_string(&value).unwrap_or_else(|_| body.to_string()),
        }
    })
}

pub fn anthropic_credentials_from_token_response(
    response: &AnthropicTokenResponse,
    now_ms: i64,
) -> Result<OAuthCredentials, AnthropicTokenError> {
    let Some(access_token) = response
        .access_token
        .as_ref()
        .filter(|value| !value.is_empty())
    else {
        return Err(AnthropicTokenError::MissingFields {
            body: String::new(),
        });
    };
    let Some(refresh_token) = response
        .refresh_token
        .as_ref()
        .filter(|value| !value.is_empty())
    else {
        return Err(AnthropicTokenError::MissingFields {
            body: String::new(),
        });
    };
    let Some(expires_in) = response.expires_in else {
        return Err(AnthropicTokenError::MissingFields {
            body: String::new(),
        });
    };

    Ok(anthropic_credentials(
        access_token,
        refresh_token,
        now_ms
            .saturating_add(expires_in.saturating_mul(1000))
            .saturating_sub(TOKEN_REFRESH_SKEW_MS),
    ))
}

pub fn anthropic_credentials(
    access_token: &str,
    refresh_token: &str,
    expires: i64,
) -> OAuthCredentials {
    OAuthCredentials {
        refresh: refresh_token.to_string(),
        access: access_token.to_string(),
        expires,
        extra: Map::new(),
    }
}

pub fn format_anthropic_error_details(error: &AnthropicFormattedError) -> String {
    let mut details = vec![format!("{}: {}", error.name, error.message)];
    if let Some(code) = &error.code {
        details.push(format!("code={code}"));
    }
    if let Some(errno) = &error.errno {
        details.push(format!("errno={errno}"));
    }
    if let Some(cause) = &error.cause {
        details.push(format!("cause={}", format_anthropic_error_details(cause)));
    }
    if let Some(stack) = &error.stack {
        details.push(format!("stack={stack}"));
    }
    details.join("; ")
}

pub fn anthropic_token_exchange_request_failed_message(
    redirect_uri: &str,
    details: &str,
) -> String {
    format!(
        "Token exchange request failed. url={ANTHROPIC_TOKEN_URL}; redirect_uri={redirect_uri}; response_type=authorization_code; details={details}"
    )
}

pub fn anthropic_token_refresh_request_failed_message(details: &str) -> String {
    format!("Anthropic token refresh request failed. url={ANTHROPIC_TOKEN_URL}; details={details}")
}

fn json_request(body: Value) -> OAuthHttpRequest {
    OAuthHttpRequest {
        method: "POST".to_string(),
        url: ANTHROPIC_TOKEN_URL.to_string(),
        headers: BTreeMap::from([
            ("Content-Type".to_string(), "application/json".to_string()),
            ("Accept".to_string(), "application/json".to_string()),
        ]),
        body: Some(body.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn oauth_anthropic_builds_authorization_url_in_typescript_order() {
        let url = build_anthropic_authorization_url("challenge value", "verifier");

        assert_eq!(
            url,
            "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d5-88ed-5944d1962f5e&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&code_challenge=challenge+value&code_challenge_method=S256&state=verifier"
        );
    }

    #[test]
    fn oauth_anthropic_creates_flow_with_verifier_as_state() {
        let pkce = OAuthPkce {
            verifier: "verifier".to_string(),
            challenge: "challenge".to_string(),
        };
        let flow = create_anthropic_authorization_flow(&pkce);

        assert_eq!(flow.verifier, "verifier");
        assert_eq!(flow.state, "verifier");
        assert_eq!(flow.redirect_uri, ANTHROPIC_REDIRECT_URI);
        assert!(flow.url.ends_with("&state=verifier"));
    }

    #[test]
    fn oauth_anthropic_builds_json_token_requests() {
        let exchange = build_anthropic_authorization_code_exchange_request(
            "code",
            "state",
            "verifier",
            ANTHROPIC_REDIRECT_URI,
        );

        assert_eq!(exchange.method, "POST");
        assert_eq!(exchange.url, ANTHROPIC_TOKEN_URL);
        assert_eq!(exchange.headers["Content-Type"], "application/json");
        assert_eq!(exchange.headers["Accept"], "application/json");
        assert_eq!(
            serde_json::from_str::<Value>(exchange.body.as_deref().unwrap()).unwrap(),
            json!({
                "grant_type": "authorization_code",
                "client_id": ANTHROPIC_CLIENT_ID,
                "code": "code",
                "state": "state",
                "redirect_uri": ANTHROPIC_REDIRECT_URI,
                "code_verifier": "verifier",
            })
        );

        let refresh = build_anthropic_refresh_token_request("refresh");
        assert_eq!(
            serde_json::from_str::<Value>(refresh.body.as_deref().unwrap()).unwrap(),
            json!({
                "grant_type": "refresh_token",
                "client_id": ANTHROPIC_CLIENT_ID,
                "refresh_token": "refresh",
            })
        );
    }

    #[test]
    fn oauth_anthropic_parses_token_response_with_refresh_skew() {
        let credentials = parse_anthropic_token_response(
            r#"{"access_token":"access","refresh_token":"refresh","expires_in":3600,"scope":"user:profile"}"#,
            1_000,
        )
        .unwrap();

        assert_eq!(
            serde_json::to_value(credentials).unwrap(),
            json!({
                "refresh": "refresh",
                "access": "access",
                "expires": 3_301_000,
            })
        );
    }

    #[test]
    fn oauth_anthropic_reports_missing_fields_and_invalid_json() {
        let missing =
            parse_anthropic_token_response(r#"{"access_token":"access"}"#, 0).unwrap_err();
        assert_eq!(
            missing.to_string(),
            "Anthropic token response missing fields. url=https://platform.claude.com/v1/oauth/token; body={\"access_token\":\"access\"}"
        );

        let invalid = parse_anthropic_token_response("not json", 0).unwrap_err();
        assert!(
            invalid
                .to_string()
                .starts_with("Anthropic token response returned invalid JSON.")
        );
    }

    #[test]
    fn oauth_anthropic_formats_nested_error_details_like_typescript() {
        let details = format_anthropic_error_details(&AnthropicFormattedError {
            name: "Error".to_string(),
            message: "listen failed".to_string(),
            code: Some("EADDRINUSE".to_string()),
            errno: Some("48".to_string()),
            cause: Some(Box::new(AnthropicFormattedError {
                name: "Cause".to_string(),
                message: "port busy".to_string(),
                code: None,
                errno: None,
                cause: None,
                stack: None,
            })),
            stack: Some("stack trace".to_string()),
        });

        assert_eq!(
            details,
            "Error: listen failed; code=EADDRINUSE; errno=48; cause=Cause: port busy; stack=stack trace"
        );
        assert_eq!(
            anthropic_token_exchange_request_failed_message(ANTHROPIC_REDIRECT_URI, &details),
            "Token exchange request failed. url=https://platform.claude.com/v1/oauth/token; redirect_uri=http://localhost:53692/callback; response_type=authorization_code; details=Error: listen failed; code=EADDRINUSE; errno=48; cause=Cause: port busy; stack=stack trace"
        );
    }

    #[test]
    fn oauth_anthropic_prompt_builders_match_login_copy() {
        let auth = anthropic_auth_info("https://claude.ai/oauth/authorize?x=1");
        assert_eq!(
            auth.instructions.as_deref(),
            Some(
                "Complete login in your browser. If the browser is on another machine, paste the final redirect URL here."
            )
        );

        let prompt = anthropic_manual_code_prompt();
        assert_eq!(
            prompt.message,
            "Paste the authorization code or full redirect URL:"
        );
        assert_eq!(prompt.placeholder.as_deref(), Some(ANTHROPIC_REDIRECT_URI));
    }
}
