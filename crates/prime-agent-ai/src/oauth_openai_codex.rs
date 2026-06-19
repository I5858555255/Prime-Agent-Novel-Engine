use crate::oauth::{
    OAuthAuthorizationInput, OAuthHttpRequest, append_query, form_urlencode,
    parse_authorization_input,
};
use crate::oauth_pkce::OAuthPkce;
use crate::oauth_types::{OAuthAuthInfo, OAuthCredentials, OAuthPrompt};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::error::Error;
use std::fmt;

pub const OPENAI_CODEX_CALLBACK_HOST_ENV_VAR: &str = "PI_OAUTH_CALLBACK_HOST";
pub const OPENAI_CODEX_DEFAULT_CALLBACK_HOST: &str = "127.0.0.1";
pub const OPENAI_CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const OPENAI_CODEX_AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
pub const OPENAI_CODEX_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
pub const OPENAI_CODEX_REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
pub const OPENAI_CODEX_SCOPE: &str = "openid profile email offline_access";
pub const OPENAI_CODEX_JWT_CLAIM_PATH: &str = "https://api.openai.com/auth";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAICodexAuthorizationFlow {
    pub verifier: String,
    pub state: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenAICodexTokenResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenAICodexTokenOperation {
    Exchange,
    Refresh,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum OpenAICodexTokenResult {
    #[serde(rename = "success")]
    Success {
        access: String,
        refresh: String,
        expires: i64,
    },
    #[serde(rename = "failed")]
    Failed {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<u16>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenAICodexCredentialsError {
    TokenFailed(String),
    MissingAccountId,
}

impl fmt::Display for OpenAICodexCredentialsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TokenFailed(message) => f.write_str(message),
            Self::MissingAccountId => f.write_str("Failed to extract accountId from token"),
        }
    }
}

impl Error for OpenAICodexCredentialsError {}

impl OpenAICodexTokenOperation {
    fn label(self) -> &'static str {
        match self {
            Self::Exchange => "exchange",
            Self::Refresh => "refresh",
        }
    }

    fn failed_prefix(self) -> &'static str {
        match self {
            Self::Exchange => "OpenAI Codex token exchange failed",
            Self::Refresh => "OpenAI Codex token refresh failed",
        }
    }
}

pub fn generate_openai_codex_state() -> Result<String, getrandom::Error> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes)?;
    Ok(hex_encode(&bytes))
}

pub fn create_openai_codex_authorization_flow(
    pkce: &OAuthPkce,
    state: &str,
    originator: Option<&str>,
) -> OpenAICodexAuthorizationFlow {
    OpenAICodexAuthorizationFlow {
        verifier: pkce.verifier.clone(),
        state: state.to_string(),
        url: build_openai_codex_authorization_url(&pkce.challenge, state, originator),
    }
}

pub fn build_openai_codex_authorization_url(
    challenge: &str,
    state: &str,
    originator: Option<&str>,
) -> String {
    append_query(
        OPENAI_CODEX_AUTHORIZE_URL,
        &[
            ("response_type", "code"),
            ("client_id", OPENAI_CODEX_CLIENT_ID),
            ("redirect_uri", OPENAI_CODEX_REDIRECT_URI),
            ("scope", OPENAI_CODEX_SCOPE),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("state", state),
            ("id_token_add_organizations", "true"),
            ("codex_cli_simplified_flow", "true"),
            ("originator", originator.unwrap_or("pi")),
        ],
    )
}

pub fn parse_openai_codex_authorization_input(input: &str) -> OAuthAuthorizationInput {
    parse_authorization_input(input)
}

pub fn openai_codex_auth_info(url: impl Into<String>) -> OAuthAuthInfo {
    OAuthAuthInfo {
        url: url.into(),
        instructions: Some("A browser window should open. Complete login to finish.".to_string()),
    }
}

pub fn openai_codex_manual_code_prompt() -> OAuthPrompt {
    OAuthPrompt {
        message: "Paste the authorization code (or full redirect URL):".to_string(),
        placeholder: None,
        allow_empty: None,
    }
}

pub fn build_openai_codex_authorization_code_exchange_request(
    code: &str,
    verifier: &str,
    redirect_uri: Option<&str>,
) -> OAuthHttpRequest {
    OAuthHttpRequest::new("POST", OPENAI_CODEX_TOKEN_URL)
        .with_headers([("Content-Type", "application/x-www-form-urlencoded")])
        .with_body(form_urlencode(&[
            ("grant_type", "authorization_code"),
            ("client_id", OPENAI_CODEX_CLIENT_ID),
            ("code", code),
            ("code_verifier", verifier),
            (
                "redirect_uri",
                redirect_uri.unwrap_or(OPENAI_CODEX_REDIRECT_URI),
            ),
        ]))
}

pub fn build_openai_codex_refresh_token_request(refresh_token: &str) -> OAuthHttpRequest {
    OAuthHttpRequest::new("POST", OPENAI_CODEX_TOKEN_URL)
        .with_headers([("Content-Type", "application/x-www-form-urlencoded")])
        .with_body(form_urlencode(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", OPENAI_CODEX_CLIENT_ID),
        ]))
}

pub fn parse_openai_codex_token_response(
    status: u16,
    status_text: &str,
    body: &str,
    now_ms: i64,
    operation: OpenAICodexTokenOperation,
) -> OpenAICodexTokenResult {
    if !(200..300).contains(&status) {
        let detail = if body.is_empty() { status_text } else { body };
        return OpenAICodexTokenResult::Failed {
            status: Some(status),
            message: format!("{} ({status}): {detail}", operation.failed_prefix()),
        };
    }

    let value = match serde_json::from_str::<Value>(body) {
        Ok(value) => value,
        Err(error) => {
            return OpenAICodexTokenResult::Failed {
                status: None,
                message: format!(
                    "OpenAI Codex token {} response invalid JSON: {error}",
                    operation.label()
                ),
            };
        }
    };

    let json = match serde_json::from_value::<OpenAICodexTokenResponse>(value.clone()) {
        Ok(json) => json,
        Err(error) => {
            return OpenAICodexTokenResult::Failed {
                status: None,
                message: format!(
                    "OpenAI Codex token {} response invalid shape: {error}",
                    operation.label()
                ),
            };
        }
    };

    let compact = serde_json::to_string(&value).unwrap_or_else(|_| body.to_string());
    let Some(access) = json.access_token.filter(|value| !value.is_empty()) else {
        return missing_fields_result(operation, compact);
    };
    let Some(refresh) = json.refresh_token.filter(|value| !value.is_empty()) else {
        return missing_fields_result(operation, compact);
    };
    let Some(expires_in) = json.expires_in else {
        return missing_fields_result(operation, compact);
    };

    OpenAICodexTokenResult::Success {
        access,
        refresh,
        expires: now_ms.saturating_add(expires_in.saturating_mul(1000)),
    }
}

pub fn openai_codex_credentials_from_token_result(
    result: &OpenAICodexTokenResult,
) -> Result<OAuthCredentials, OpenAICodexCredentialsError> {
    match result {
        OpenAICodexTokenResult::Success {
            access,
            refresh,
            expires,
        } => openai_codex_credentials(access, refresh, *expires),
        OpenAICodexTokenResult::Failed { message, .. } => {
            Err(OpenAICodexCredentialsError::TokenFailed(message.clone()))
        }
    }
}

pub fn openai_codex_credentials(
    access_token: &str,
    refresh_token: &str,
    expires: i64,
) -> Result<OAuthCredentials, OpenAICodexCredentialsError> {
    let account_id = get_openai_codex_account_id(access_token)
        .ok_or(OpenAICodexCredentialsError::MissingAccountId)?;
    let mut extra = Map::new();
    extra.insert("accountId".to_string(), Value::String(account_id));

    Ok(OAuthCredentials {
        refresh: refresh_token.to_string(),
        access: access_token.to_string(),
        expires,
        extra,
    })
}

pub fn get_openai_codex_account_id(access_token: &str) -> Option<String> {
    let payload = decode_openai_codex_jwt_payload(access_token)?;
    let account_id = payload
        .get(OPENAI_CODEX_JWT_CLAIM_PATH)?
        .get("chatgpt_account_id")?
        .as_str()?;

    (!account_id.is_empty()).then(|| account_id.to_string())
}

pub fn decode_openai_codex_jwt_payload(access_token: &str) -> Option<Value> {
    let mut parts = access_token.split('.');
    parts.next()?;
    let payload = parts.next()?;
    parts.next()?;
    if parts.next().is_some() {
        return None;
    }

    let decoded = decode_base64_payload(payload)?;
    serde_json::from_slice(&decoded).ok()
}

fn missing_fields_result(
    operation: OpenAICodexTokenOperation,
    compact_json: String,
) -> OpenAICodexTokenResult {
    OpenAICodexTokenResult::Failed {
        status: None,
        message: format!(
            "OpenAI Codex token {} response missing fields: {compact_json}",
            operation.label()
        ),
    }
}

fn decode_base64_payload(value: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| URL_SAFE.decode(value))
        .or_else(|_| STANDARD_NO_PAD.decode(value))
        .or_else(|_| STANDARD.decode(value))
        .ok()
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(hex_digit(byte >> 4));
        out.push(hex_digit(byte & 0x0f));
    }
    out
}

fn hex_digit(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        10..=15 => (b'a' + value - 10) as char,
        _ => unreachable!("nibble must be <= 15"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn oauth_openai_codex_builds_authorization_url_in_typescript_order() {
        let url = build_openai_codex_authorization_url("challenge value", "state-value", None);

        assert_eq!(
            url,
            "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_access&code_challenge=challenge+value&code_challenge_method=S256&state=state-value&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=pi"
        );
    }

    #[test]
    fn oauth_openai_codex_creates_authorization_flow_from_pkce_and_state() {
        let pkce = OAuthPkce {
            verifier: "verifier".to_string(),
            challenge: "challenge".to_string(),
        };
        let flow = create_openai_codex_authorization_flow(&pkce, "state", Some("codex"));

        assert_eq!(flow.verifier, "verifier");
        assert_eq!(flow.state, "state");
        assert!(flow.url.ends_with("&originator=codex"));
    }

    #[test]
    fn oauth_openai_codex_builds_token_requests() {
        let exchange =
            build_openai_codex_authorization_code_exchange_request("code value", "verifier", None);
        assert_eq!(exchange.method, "POST");
        assert_eq!(exchange.url, OPENAI_CODEX_TOKEN_URL);
        assert_eq!(
            exchange.headers["Content-Type"],
            "application/x-www-form-urlencoded"
        );
        assert_eq!(
            exchange.body.as_deref(),
            Some(
                "grant_type=authorization_code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&code=code+value&code_verifier=verifier&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback"
            )
        );

        let refresh = build_openai_codex_refresh_token_request("refresh token");
        assert_eq!(
            refresh.body.as_deref(),
            Some(
                "grant_type=refresh_token&refresh_token=refresh+token&client_id=app_EMoamEEZ73f0CkXaXp7hrann"
            )
        );
    }

    #[test]
    fn oauth_openai_codex_parses_success_and_failure_token_results() {
        let success = parse_openai_codex_token_response(
            200,
            "OK",
            r#"{"access_token":"a","refresh_token":"r","expires_in":3600}"#,
            1_000,
            OpenAICodexTokenOperation::Exchange,
        );
        assert_eq!(
            success,
            OpenAICodexTokenResult::Success {
                access: "a".to_string(),
                refresh: "r".to_string(),
                expires: 3_601_000,
            }
        );

        let missing = parse_openai_codex_token_response(
            200,
            "OK",
            r#"{"access_token":"a"}"#,
            1_000,
            OpenAICodexTokenOperation::Refresh,
        );
        assert_eq!(
            missing,
            OpenAICodexTokenResult::Failed {
                status: None,
                message:
                    "OpenAI Codex token refresh response missing fields: {\"access_token\":\"a\"}"
                        .to_string(),
            }
        );

        let failed = parse_openai_codex_token_response(
            401,
            "Unauthorized",
            "",
            1_000,
            OpenAICodexTokenOperation::Exchange,
        );
        assert_eq!(
            failed,
            OpenAICodexTokenResult::Failed {
                status: Some(401),
                message: "OpenAI Codex token exchange failed (401): Unauthorized".to_string(),
            }
        );
    }

    #[test]
    fn oauth_openai_codex_extracts_account_id_from_jwt_and_credentials() {
        let token = jwt_with_payload(json!({
            OPENAI_CODEX_JWT_CLAIM_PATH: {
                "chatgpt_account_id": "account-123"
            }
        }));

        assert_eq!(
            get_openai_codex_account_id(&token).as_deref(),
            Some("account-123")
        );

        let credentials = openai_codex_credentials(&token, "refresh", 123).unwrap();
        assert_eq!(
            serde_json::to_value(credentials).unwrap(),
            json!({
                "refresh": "refresh",
                "access": token,
                "expires": 123,
                "accountId": "account-123",
            })
        );
    }

    #[test]
    fn oauth_openai_codex_rejects_missing_account_id() {
        let token = jwt_with_payload(json!({ "sub": "user" }));

        assert_eq!(
            openai_codex_credentials(&token, "refresh", 123).unwrap_err(),
            OpenAICodexCredentialsError::MissingAccountId
        );
        assert_eq!(get_openai_codex_account_id("not.jwt"), None);
    }

    #[test]
    fn oauth_openai_codex_token_result_serializes_with_type_tag() {
        let result = OpenAICodexTokenResult::Failed {
            message: "bad".to_string(),
            status: Some(400),
        };

        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({
                "type": "failed",
                "message": "bad",
                "status": 400,
            })
        );
    }

    fn jwt_with_payload(payload: Value) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"none","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        format!("{header}.{payload}.signature")
    }
}
