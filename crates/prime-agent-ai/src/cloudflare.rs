use crate::types::Model;
use std::error::Error;
use std::fmt;

pub const CLOUDFLARE_WORKERS_AI_BASE_URL: &str =
    "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1";
pub const CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL: &str =
    "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat";
pub const CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL: &str =
    "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai";
pub const CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL: &str = "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/anthropic";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudflareBaseUrlError {
    pub variable: String,
    pub provider: String,
}

impl fmt::Display for CloudflareBaseUrlError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} is required for provider {} but is not set.",
            self.variable, self.provider
        )
    }
}

impl Error for CloudflareBaseUrlError {}

pub fn is_cloudflare_provider(provider: &str) -> bool {
    provider == "cloudflare-workers-ai" || provider == "cloudflare-ai-gateway"
}

pub fn resolve_cloudflare_base_url(model: &Model) -> Result<String, CloudflareBaseUrlError> {
    resolve_cloudflare_base_url_with_env(model, |name| std::env::var(name).ok())
}

pub fn resolve_cloudflare_base_url_with_env(
    model: &Model,
    mut env: impl FnMut(&str) -> Option<String>,
) -> Result<String, CloudflareBaseUrlError> {
    if !model.base_url.contains('{') {
        return Ok(model.base_url.clone());
    }

    let mut output = String::with_capacity(model.base_url.len());
    let mut chars = model.base_url.char_indices().peekable();
    let mut last_index = 0;

    while let Some((open_index, char)) = chars.next() {
        if char != '{' {
            continue;
        }

        let Some((close_index, _)) = chars.clone().find(|(_, candidate)| *candidate == '}') else {
            continue;
        };
        let variable = &model.base_url[open_index + 1..close_index];
        if !is_cloudflare_env_placeholder(variable) {
            continue;
        }

        output.push_str(&model.base_url[last_index..open_index]);
        let value = env(variable)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| CloudflareBaseUrlError {
                variable: variable.to_string(),
                provider: model.provider.clone(),
            })?;
        output.push_str(&value);

        while let Some((index, _)) = chars.peek().copied() {
            if index <= close_index {
                let _ = chars.next();
            } else {
                break;
            }
        }
        last_index = close_index + 1;
    }

    if last_index == 0 {
        Ok(model.base_url.clone())
    } else {
        output.push_str(&model.base_url[last_index..]);
        Ok(output)
    }
}

fn is_cloudflare_env_placeholder(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_uppercase())
        && chars.all(|char| char == '_' || char.is_ascii_uppercase() || char.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(base_url: &str, provider: &str) -> Model {
        Model {
            base_url: base_url.to_string(),
            provider: provider.to_string(),
            ..Model::default()
        }
    }

    #[test]
    fn identifies_cloudflare_providers() {
        assert!(is_cloudflare_provider("cloudflare-workers-ai"));
        assert!(is_cloudflare_provider("cloudflare-ai-gateway"));
        assert!(!is_cloudflare_provider("openai"));
    }

    #[test]
    fn returns_base_url_unchanged_without_placeholders() {
        let model = model("https://example.com/v1", "cloudflare-workers-ai");

        assert_eq!(
            resolve_cloudflare_base_url_with_env(&model, |_| None).unwrap(),
            "https://example.com/v1"
        );
    }

    #[test]
    fn substitutes_uppercase_placeholders_from_environment() {
        let model = model(
            CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
            "cloudflare-ai-gateway",
        );

        let resolved = resolve_cloudflare_base_url_with_env(&model, |name| match name {
            "CLOUDFLARE_ACCOUNT_ID" => Some("acct".to_string()),
            "CLOUDFLARE_GATEWAY_ID" => Some("gateway".to_string()),
            _ => None,
        })
        .unwrap();

        assert_eq!(
            resolved,
            "https://gateway.ai.cloudflare.com/v1/acct/gateway/openai"
        );
    }

    #[test]
    fn reports_missing_placeholder_with_provider_name() {
        let model = model(CLOUDFLARE_WORKERS_AI_BASE_URL, "cloudflare-workers-ai");

        let error = resolve_cloudflare_base_url_with_env(&model, |_| None).unwrap_err();

        assert_eq!(error.variable, "CLOUDFLARE_ACCOUNT_ID");
        assert_eq!(
            error.to_string(),
            "CLOUDFLARE_ACCOUNT_ID is required for provider cloudflare-workers-ai but is not set."
        );
    }

    #[test]
    fn leaves_non_environment_braces_unchanged() {
        let model = model(
            "https://example.com/{not-env}/{CLOUDFLARE_ACCOUNT_ID}",
            "test",
        );

        let resolved = resolve_cloudflare_base_url_with_env(&model, |name| {
            (name == "CLOUDFLARE_ACCOUNT_ID").then(|| "acct".to_string())
        })
        .unwrap();

        assert_eq!(resolved, "https://example.com/{not-env}/acct");
    }
}
