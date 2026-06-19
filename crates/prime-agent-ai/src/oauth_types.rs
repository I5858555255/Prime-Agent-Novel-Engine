use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub type OAuthProviderId = String;

#[deprecated(note = "Use OAuthProviderId instead")]
pub type OAuthProvider = OAuthProviderId;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCredentials {
    pub refresh: String,
    pub access: String,
    pub expires: i64,
    #[serde(default, flatten, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthPrompt {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_empty: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthAuthInfo {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthSelectOption {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthSelectPrompt {
    pub message: String,
    pub options: Vec<OAuthSelectOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthProviderInterface {
    pub id: OAuthProviderId,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uses_callback_server: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthProviderInfo {
    pub id: OAuthProviderId,
    pub name: String,
    pub available: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn oauth_credentials_round_trip_with_extra_fields() {
        let value = json!({
            "refresh": "refresh-token",
            "access": "access-token",
            "expires": 1_800_000_000_000_i64,
            "enterpriseUrl": "github.example.com"
        });

        let credentials: OAuthCredentials = serde_json::from_value(value.clone()).unwrap();

        assert_eq!(credentials.refresh, "refresh-token");
        assert_eq!(credentials.access, "access-token");
        assert_eq!(credentials.expires, 1_800_000_000_000_i64);
        assert_eq!(
            credentials.extra.get("enterpriseUrl"),
            Some(&json!("github.example.com"))
        );
        assert_eq!(serde_json::to_value(credentials).unwrap(), value);
    }

    #[test]
    fn oauth_prompt_round_trip_uses_camel_case_fields() {
        let value = json!({
            "message": "Paste code",
            "placeholder": "code",
            "allowEmpty": true
        });

        let prompt: OAuthPrompt = serde_json::from_value(value.clone()).unwrap();

        assert_eq!(prompt.message, "Paste code");
        assert_eq!(prompt.placeholder.as_deref(), Some("code"));
        assert_eq!(prompt.allow_empty, Some(true));
        assert_eq!(serde_json::to_value(prompt).unwrap(), value);
    }

    #[test]
    fn oauth_select_prompt_round_trip() {
        let value = json!({
            "message": "Choose provider",
            "options": [
                { "id": "openai-codex", "label": "OpenAI Codex" },
                { "id": "github-copilot", "label": "GitHub Copilot" }
            ]
        });

        let prompt: OAuthSelectPrompt = serde_json::from_value(value.clone()).unwrap();

        assert_eq!(prompt.message, "Choose provider");
        assert_eq!(prompt.options.len(), 2);
        assert_eq!(prompt.options[0].id, "openai-codex");
        assert_eq!(prompt.options[1].label, "GitHub Copilot");
        assert_eq!(serde_json::to_value(prompt).unwrap(), value);
    }
}
