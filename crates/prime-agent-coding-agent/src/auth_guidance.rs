use std::path::Path;

use crate::config::get_docs_path;

const UNKNOWN_PROVIDER: &str = "unknown";

pub fn get_provider_login_help() -> String {
    get_provider_login_help_with_docs_path(get_docs_path())
}

pub fn get_provider_login_help_with_docs_path(docs_path: impl AsRef<Path>) -> String {
    let docs_path = docs_path.as_ref();
    [
        "Use /login to log into a provider via OAuth or API key. See:".to_string(),
        format!("  {}", docs_path.join("providers.md").display()),
        format!("  {}", docs_path.join("models.md").display()),
    ]
    .join("\n")
}

pub fn format_no_models_available_message() -> String {
    format_no_models_available_message_with_docs_path(get_docs_path())
}

pub fn format_no_models_available_message_with_docs_path(docs_path: impl AsRef<Path>) -> String {
    format!(
        "No models available. {}",
        get_provider_login_help_with_docs_path(docs_path)
    )
}

pub fn is_no_models_available_message(message: Option<&str>) -> bool {
    is_no_models_available_message_with_docs_path(message, get_docs_path())
}

pub fn is_no_models_available_message_with_docs_path(
    message: Option<&str>,
    docs_path: impl AsRef<Path>,
) -> bool {
    message == Some(format_no_models_available_message_with_docs_path(docs_path).as_str())
}

pub fn format_no_model_selected_message() -> String {
    format_no_model_selected_message_with_docs_path(get_docs_path())
}

pub fn format_no_model_selected_message_with_docs_path(docs_path: impl AsRef<Path>) -> String {
    format!(
        "No model selected.\n\n{}\n\nThen use /model to select a model.",
        get_provider_login_help_with_docs_path(docs_path)
    )
}

pub fn format_no_api_key_found_message(provider: &str) -> String {
    format_no_api_key_found_message_with_docs_path(provider, get_docs_path())
}

pub fn format_no_api_key_found_message_with_docs_path(
    provider: &str,
    docs_path: impl AsRef<Path>,
) -> String {
    let provider_display = if provider == UNKNOWN_PROVIDER {
        "the selected model"
    } else {
        provider
    };

    format!(
        "No API key found for {provider_display}.\n\n{}",
        get_provider_login_help_with_docs_path(docs_path)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOCS_PATH: &str = "/tmp/docs";

    #[test]
    fn auth_guidance_provider_login_help_matches_typescript_message_text() {
        assert_eq!(
            get_provider_login_help_with_docs_path(DOCS_PATH),
            "Use /login to log into a provider via OAuth or API key. See:\n  /tmp/docs/providers.md\n  /tmp/docs/models.md"
        );
    }

    #[test]
    fn auth_guidance_no_models_available_message_matches_typescript_message_text() {
        let message = format_no_models_available_message_with_docs_path(DOCS_PATH);

        assert_eq!(
            message,
            "No models available. Use /login to log into a provider via OAuth or API key. See:\n  /tmp/docs/providers.md\n  /tmp/docs/models.md"
        );
        assert!(is_no_models_available_message_with_docs_path(
            Some(&message),
            DOCS_PATH
        ));
        assert!(!is_no_models_available_message_with_docs_path(
            Some("different"),
            DOCS_PATH
        ));
        assert!(!is_no_models_available_message_with_docs_path(
            None, DOCS_PATH
        ));
    }

    #[test]
    fn auth_guidance_no_model_selected_message_matches_typescript_message_text() {
        assert_eq!(
            format_no_model_selected_message_with_docs_path(DOCS_PATH),
            "No model selected.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /tmp/docs/providers.md\n  /tmp/docs/models.md\n\nThen use /model to select a model."
        );
    }

    #[test]
    fn auth_guidance_no_api_key_found_message_matches_typescript_message_text() {
        assert_eq!(
            format_no_api_key_found_message_with_docs_path("openai", DOCS_PATH),
            "No API key found for openai.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /tmp/docs/providers.md\n  /tmp/docs/models.md"
        );
        assert_eq!(
            format_no_api_key_found_message_with_docs_path("unknown", DOCS_PATH),
            "No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /tmp/docs/providers.md\n  /tmp/docs/models.md"
        );
    }
}
