use std::{env, fs, path::PathBuf};

const AUTHENTICATED: &str = "<authenticated>";

pub fn api_key_env_vars(provider: &str) -> Option<&'static [&'static str]> {
    match provider {
        "github-copilot" => Some(&["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]),
        "anthropic" => Some(&["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]),
        "openai" => Some(&["OPENAI_API_KEY"]),
        "azure-openai-responses" => Some(&["AZURE_OPENAI_API_KEY"]),
        "prime-inference" => Some(&["PRIME_API_KEY"]),
        "deepseek" => Some(&["DEEPSEEK_API_KEY"]),
        "google" => Some(&["GEMINI_API_KEY"]),
        "google-vertex" => Some(&["GOOGLE_CLOUD_API_KEY"]),
        "groq" => Some(&["GROQ_API_KEY"]),
        "cerebras" => Some(&["CEREBRAS_API_KEY"]),
        "xai" => Some(&["XAI_API_KEY"]),
        "openrouter" => Some(&["OPENROUTER_API_KEY"]),
        "vercel-ai-gateway" => Some(&["AI_GATEWAY_API_KEY"]),
        "zai" => Some(&["ZAI_API_KEY"]),
        "mistral" => Some(&["MISTRAL_API_KEY"]),
        "minimax" => Some(&["MINIMAX_API_KEY"]),
        "minimax-cn" => Some(&["MINIMAX_CN_API_KEY"]),
        "moonshotai" | "moonshotai-cn" => Some(&["MOONSHOT_API_KEY"]),
        "huggingface" => Some(&["HF_TOKEN"]),
        "fireworks" => Some(&["FIREWORKS_API_KEY"]),
        "opencode" | "opencode-go" => Some(&["OPENCODE_API_KEY"]),
        "kimi-coding" => Some(&["KIMI_API_KEY"]),
        "cloudflare-workers-ai" | "cloudflare-ai-gateway" => Some(&["CLOUDFLARE_API_KEY"]),
        "xiaomi" => Some(&["XIAOMI_API_KEY"]),
        "xiaomi-token-plan-cn" => Some(&["XIAOMI_TOKEN_PLAN_CN_API_KEY"]),
        "xiaomi-token-plan-ams" => Some(&["XIAOMI_TOKEN_PLAN_AMS_API_KEY"]),
        "xiaomi-token-plan-sgp" => Some(&["XIAOMI_TOKEN_PLAN_SGP_API_KEY"]),
        _ => None,
    }
}

pub fn find_env_keys(provider: &str) -> Option<Vec<String>> {
    find_env_keys_with(provider, lookup_env)
}

pub fn find_env_keys_with<F>(provider: &str, lookup: F) -> Option<Vec<String>>
where
    F: Fn(&str) -> Option<String>,
{
    let found = api_key_env_vars(provider)?
        .iter()
        .filter(|env_var| lookup(env_var).is_some_and(|value| !value.is_empty()))
        .map(|env_var| (*env_var).to_string())
        .collect::<Vec<_>>();

    if found.is_empty() { None } else { Some(found) }
}

pub fn get_env_api_key(provider: &str) -> Option<String> {
    get_env_api_key_with(provider, lookup_env, has_vertex_adc_credentials)
}

pub fn get_env_api_key_with<F, G>(
    provider: &str,
    lookup: F,
    has_vertex_adc_credentials: G,
) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
    G: Fn() -> bool,
{
    if let Some(env_key) =
        find_env_keys_with(provider, &lookup).and_then(|keys| keys.into_iter().next())
    {
        return lookup(&env_key);
    }

    if provider == "google-vertex" {
        let has_project = lookup("GOOGLE_CLOUD_PROJECT")
            .or_else(|| lookup("GCLOUD_PROJECT"))
            .is_some_and(|value| !value.is_empty());
        let has_location = lookup("GOOGLE_CLOUD_LOCATION").is_some_and(|value| !value.is_empty());

        if has_vertex_adc_credentials() && has_project && has_location {
            return Some(AUTHENTICATED.to_string());
        }
    }

    if provider == "amazon-bedrock" && has_bedrock_credentials(&lookup) {
        return Some(AUTHENTICATED.to_string());
    }

    None
}

pub fn get_prime_team_id() -> Option<String> {
    let from_env = lookup_env("PRIME_TEAM_ID").and_then(non_empty_trimmed);
    if from_env.is_some() {
        return from_env;
    }

    let config_path = home_dir()?.join(".prime").join("config.json");
    let config_json = fs::read_to_string(config_path).ok()?;
    get_prime_team_id_from_config(&config_json)
}

pub fn get_prime_team_id_with<F>(lookup: F, config_json: Option<&str>) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
{
    let from_env = lookup("PRIME_TEAM_ID").and_then(non_empty_trimmed);
    if from_env.is_some() {
        return from_env;
    }

    config_json.and_then(get_prime_team_id_from_config)
}

fn get_prime_team_id_from_config(config_json: &str) -> Option<String> {
    let parsed = serde_json::from_str::<serde_json::Value>(config_json).ok()?;
    parsed
        .as_object()
        .and_then(|object| object.get("team_id"))
        .and_then(|value| value.as_str())
        .and_then(|value| non_empty_trimmed(value.to_string()))
}

fn has_bedrock_credentials<F>(lookup: F) -> bool
where
    F: Fn(&str) -> Option<String>,
{
    let has = |key: &str| lookup(key).is_some_and(|value| !value.is_empty());
    has("AWS_PROFILE")
        || (has("AWS_ACCESS_KEY_ID") && has("AWS_SECRET_ACCESS_KEY"))
        || has("AWS_BEARER_TOKEN_BEDROCK")
        || has("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")
        || has("AWS_CONTAINER_CREDENTIALS_FULL_URI")
        || has("AWS_WEB_IDENTITY_TOKEN_FILE")
}

fn has_vertex_adc_credentials() -> bool {
    if let Some(path) = lookup_env("GOOGLE_APPLICATION_CREDENTIALS") {
        return fs::metadata(path).is_ok();
    }

    home_dir()
        .map(|home| {
            home.join(".config")
                .join("gcloud")
                .join("application_default_credentials.json")
        })
        .is_some_and(|path| fs::metadata(path).is_ok())
}

fn lookup_env(key: &str) -> Option<String> {
    env::var(key).ok()
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

fn non_empty_trimmed(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env_lookup(values: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let values = values
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect::<HashMap<_, _>>();
        move |key| values.get(key).cloned()
    }

    #[test]
    fn maps_known_providers_to_api_key_environment_variables() {
        assert_eq!(api_key_env_vars("openai"), Some(&["OPENAI_API_KEY"][..]));
        assert_eq!(
            api_key_env_vars("anthropic"),
            Some(&["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"][..])
        );
        assert_eq!(
            api_key_env_vars("github-copilot"),
            Some(&["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"][..])
        );
        assert_eq!(
            api_key_env_vars("prime-inference"),
            Some(&["PRIME_API_KEY"][..])
        );
        assert_eq!(
            api_key_env_vars("moonshotai-cn"),
            Some(&["MOONSHOT_API_KEY"][..])
        );
        assert_eq!(
            api_key_env_vars("cloudflare-ai-gateway"),
            Some(&["CLOUDFLARE_API_KEY"][..])
        );
        assert!(api_key_env_vars("amazon-bedrock").is_none());
        assert!(api_key_env_vars("unknown").is_none());
    }

    #[test]
    fn find_env_keys_reports_configured_key_names_in_priority_order() {
        let lookup = env_lookup(&[
            ("ANTHROPIC_API_KEY", "api-key"),
            ("ANTHROPIC_OAUTH_TOKEN", "oauth-token"),
        ]);

        assert_eq!(
            find_env_keys_with("anthropic", lookup),
            Some(vec![
                "ANTHROPIC_OAUTH_TOKEN".to_string(),
                "ANTHROPIC_API_KEY".to_string(),
            ])
        );
    }

    #[test]
    fn get_env_api_key_returns_first_configured_provider_key() {
        let lookup = env_lookup(&[
            ("ANTHROPIC_API_KEY", "api-key"),
            ("ANTHROPIC_OAUTH_TOKEN", "oauth-token"),
        ]);

        assert_eq!(
            get_env_api_key_with("anthropic", lookup, || false),
            Some("oauth-token".to_string())
        );
    }

    #[test]
    fn explicit_prime_api_key_is_required_for_prime_inference() {
        assert_eq!(
            find_env_keys_with(
                "prime-inference",
                env_lookup(&[("PRIME_API_KEY", "test-prime-key")])
            ),
            Some(vec!["PRIME_API_KEY".to_string()])
        );
        assert_eq!(
            get_env_api_key_with(
                "prime-inference",
                env_lookup(&[("PRIME_API_KEY", "test-prime-key")]),
                || false
            ),
            Some("test-prime-key".to_string())
        );
        assert!(find_env_keys_with("prime-inference", env_lookup(&[])).is_none());
        assert!(get_env_api_key_with("prime-inference", env_lookup(&[]), || false).is_none());
    }

    #[test]
    fn google_vertex_supports_explicit_key_or_adc_project_and_location() {
        assert_eq!(
            get_env_api_key_with(
                "google-vertex",
                env_lookup(&[("GOOGLE_CLOUD_API_KEY", "vertex-key")]),
                || false,
            ),
            Some("vertex-key".to_string())
        );
        assert_eq!(
            get_env_api_key_with(
                "google-vertex",
                env_lookup(&[
                    ("GOOGLE_CLOUD_PROJECT", "project"),
                    ("GOOGLE_CLOUD_LOCATION", "us-central1"),
                ]),
                || true,
            ),
            Some(AUTHENTICATED.to_string())
        );
        assert!(
            get_env_api_key_with(
                "google-vertex",
                env_lookup(&[("GOOGLE_CLOUD_PROJECT", "project")]),
                || true,
            )
            .is_none()
        );
    }

    #[test]
    fn amazon_bedrock_supports_ambient_auth_sources_without_find_env_keys() {
        assert!(
            find_env_keys_with("amazon-bedrock", env_lookup(&[("AWS_PROFILE", "default")]))
                .is_none()
        );
        assert_eq!(
            get_env_api_key_with(
                "amazon-bedrock",
                env_lookup(&[("AWS_PROFILE", "default")]),
                || false
            ),
            Some(AUTHENTICATED.to_string())
        );
        assert_eq!(
            get_env_api_key_with(
                "amazon-bedrock",
                env_lookup(&[
                    ("AWS_ACCESS_KEY_ID", "key"),
                    ("AWS_SECRET_ACCESS_KEY", "secret"),
                ]),
                || false,
            ),
            Some(AUTHENTICATED.to_string())
        );
        assert!(
            get_env_api_key_with(
                "amazon-bedrock",
                env_lookup(&[("AWS_ACCESS_KEY_ID", "key")]),
                || false,
            )
            .is_none()
        );
    }

    #[test]
    fn prime_team_id_prefers_trimmed_env_then_config_json() {
        assert_eq!(
            get_prime_team_id_with(
                env_lookup(&[("PRIME_TEAM_ID", " team-env ")]),
                Some(r#"{"team_id":"team-config"}"#)
            ),
            Some("team-env".to_string())
        );
        assert_eq!(
            get_prime_team_id_with(env_lookup(&[]), Some(r#"{"team_id":" team-config "}"#)),
            Some("team-config".to_string())
        );
        assert!(get_prime_team_id_with(env_lookup(&[]), Some(r#"{"team_id":"   "}"#)).is_none());
        assert!(get_prime_team_id_with(env_lookup(&[]), Some("not-json")).is_none());
    }
}
