use crate::{AssistantMessage, StopReason};

const OVERFLOW_PATTERNS: &[&str] = &[
    "prompt is too long",
    "request_too_large",
    "input is too long for requested model",
    "exceeds the context window",
    "input token count",
    "maximum prompt length is",
    "reduce the length of the messages",
    "maximum context length is",
    "exceeds the limit of",
    "exceeds the available context size",
    "greater than the context length",
    "context window exceeds limit",
    "exceeded model token limit",
    "too large for model with",
    "model_context_window_exceeded",
    "prompt too long; exceeded",
    "context_length_exceeded",
    "context length exceeded",
    "too many tokens",
    "token limit exceeded",
];

fn matches_non_overflow_pattern(error_message: &str) -> bool {
    let lower = error_message.to_ascii_lowercase();

    lower.starts_with("throttling error:")
        || lower.starts_with("service unavailable:")
        || lower.contains("rate limit")
        || lower.contains("too many requests")
}

fn matches_cerebras_empty_body_error(error_message: &str) -> bool {
    let lower = error_message.trim_start().to_ascii_lowercase();
    let Some(rest) = lower
        .strip_prefix("400")
        .or_else(|| lower.strip_prefix("413"))
    else {
        return false;
    };

    let rest = rest.trim_start();
    let rest = rest
        .strip_prefix("status code")
        .unwrap_or(rest)
        .trim_start();
    rest.starts_with("(no body)")
}

fn matches_overflow_pattern(error_message: &str) -> bool {
    let lower = error_message.to_ascii_lowercase();

    if lower.contains("input token count") {
        return lower.contains("exceeds the maximum");
    }
    if lower.contains("maximum context length is") {
        return lower.contains("tokens");
    }
    if lower.contains("too large for model with") {
        return lower.contains("maximum context length");
    }
    if lower.contains("prompt too long; exceeded") {
        return lower.contains("context length");
    }

    OVERFLOW_PATTERNS
        .iter()
        .any(|pattern| lower.contains(pattern))
        || matches_cerebras_empty_body_error(error_message)
}

pub fn is_context_overflow(message: &AssistantMessage, context_window: Option<u64>) -> bool {
    if message.stop_reason == StopReason::Error
        && let Some(error_message) = &message.error_message
        && !matches_non_overflow_pattern(error_message)
        && matches_overflow_pattern(error_message)
    {
        return true;
    }

    if let Some(context_window) = context_window {
        let input_tokens = message.usage.input + message.usage.cache_read;

        if message.stop_reason == StopReason::Stop && input_tokens > context_window {
            return true;
        }

        if message.stop_reason == StopReason::Length
            && message.usage.output == 0
            && (input_tokens as f64) >= (context_window as f64 * 0.99)
        {
            return true;
        }
    }

    false
}

pub fn get_overflow_patterns() -> &'static [&'static str] {
    OVERFLOW_PATTERNS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AssistantMessage, Cost, Usage};

    fn create_message(
        stop_reason: StopReason,
        error_message: Option<&str>,
        input: u64,
        cache_read: u64,
        output: u64,
    ) -> AssistantMessage {
        AssistantMessage {
            content: vec![],
            api: "openai-completions".to_string(),
            provider: "ollama".to_string(),
            model: "qwen3.5:35b".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage {
                input,
                output,
                cache_read,
                cache_write: 0,
                total_tokens: input + cache_read + output,
                cost: Cost::default(),
            },
            stop_reason,
            error_message: error_message.map(str::to_owned),
            timestamp: 0,
        }
    }

    fn create_error_message(error_message: &str) -> AssistantMessage {
        create_message(StopReason::Error, Some(error_message), 0, 0, 0)
    }

    fn create_length_stop_message(input: u64, cache_read: u64, output: u64) -> AssistantMessage {
        create_message(StopReason::Length, None, input, cache_read, output)
    }

    #[test]
    fn detects_explicit_ollama_prompt_too_long_errors() {
        let message = create_error_message(
            "400 `prompt too long; exceeded max context length by 100918 tokens`",
        );

        assert!(is_context_overflow(&message, Some(32768)));
    }

    #[test]
    fn does_not_treat_generic_non_overflow_ollama_errors_as_overflow() {
        let message = create_error_message("500 `model runner crashed unexpectedly`");

        assert!(!is_context_overflow(&message, Some(32768)));
    }

    #[test]
    fn does_not_treat_bedrock_throttling_too_many_tokens_as_overflow() {
        let message = create_error_message(
            "Throttling error: Too many tokens, please wait before trying again.",
        );

        assert!(!is_context_overflow(&message, Some(200000)));
    }

    #[test]
    fn does_not_treat_bedrock_service_unavailable_as_overflow() {
        let message =
            create_error_message("Service unavailable: The service is temporarily unavailable.");

        assert!(!is_context_overflow(&message, Some(200000)));
    }

    #[test]
    fn does_not_treat_generic_rate_limit_errors_as_overflow() {
        let message = create_error_message("Rate limit exceeded, please retry after 30 seconds.");

        assert!(!is_context_overflow(&message, Some(200000)));
    }

    #[test]
    fn does_not_treat_http_429_style_errors_as_overflow() {
        let message = create_error_message("Too many requests. Please slow down.");

        assert!(!is_context_overflow(&message, Some(200000)));
    }

    #[test]
    fn detects_xiaomi_style_overflow() {
        let message = create_length_stop_message(58, 1048512, 0);

        assert!(is_context_overflow(&message, Some(1048576)));
    }

    #[test]
    fn does_not_treat_normal_length_stops_with_output_as_overflow() {
        let message = create_length_stop_message(1000, 0, 4096);

        assert!(!is_context_overflow(&message, Some(200000)));
    }

    #[test]
    fn does_not_treat_length_stops_far_below_context_as_overflow() {
        let message = create_length_stop_message(100, 0, 0);

        assert!(!is_context_overflow(&message, Some(200000)));
    }

    #[test]
    fn detects_silent_successful_overflow_from_usage() {
        let message = create_message(StopReason::Stop, None, 200001, 0, 1);

        assert!(is_context_overflow(&message, Some(200000)));
    }

    #[test]
    fn detects_other_provider_error_patterns() {
        for error_message in [
            "prompt is too long: 213462 tokens > 200000 maximum",
            r#"413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}"#,
            "Your input exceeds the context window of this model",
            "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
            "This model's maximum prompt length is 131072 but the request contains 537812 tokens",
            "This endpoint's maximum context length is 8192 tokens. However, you requested about 9000 tokens",
            "400 status code (no body)",
            "413 (no body)",
            "Prompt contains 300000 tokens and is too large for model with 200000 maximum context length",
        ] {
            assert!(
                is_context_overflow(&create_error_message(error_message), None),
                "{error_message}"
            );
        }
    }
}
