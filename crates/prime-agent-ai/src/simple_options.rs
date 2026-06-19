use crate::stream::{SimpleStreamOptions, StreamOptions};
use crate::types::{Model, ThinkingBudgets, ThinkingLevel};

const DEFAULT_MINIMAL_THINKING_BUDGET: u64 = 1_024;
const DEFAULT_LOW_THINKING_BUDGET: u64 = 2_048;
const DEFAULT_MEDIUM_THINKING_BUDGET: u64 = 8_192;
const DEFAULT_HIGH_THINKING_BUDGET: u64 = 16_384;
const MIN_OUTPUT_TOKENS: u64 = 1_024;
const DEFAULT_MAX_TOKENS_CAP: u64 = 32_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdjustedThinkingTokens {
    pub max_tokens: u64,
    pub thinking_budget: u64,
}

pub fn build_base_options(
    model: &Model,
    options: Option<&SimpleStreamOptions>,
    api_key: Option<&str>,
) -> StreamOptions {
    let stream = options.map(|options| &options.stream);

    StreamOptions {
        temperature: stream.and_then(|stream| stream.temperature),
        max_tokens: stream
            .and_then(|stream| stream.max_tokens)
            .or_else(|| default_max_tokens(model)),
        api_key: api_key
            .filter(|api_key| !api_key.is_empty())
            .map(str::to_owned)
            .or_else(|| stream.and_then(|stream| stream.api_key.clone())),
        transport: stream.and_then(|stream| stream.transport),
        cache_retention: stream.and_then(|stream| stream.cache_retention),
        session_id: stream.and_then(|stream| stream.session_id.clone()),
        headers: stream.and_then(|stream| stream.headers.clone()),
        timeout_ms: stream.and_then(|stream| stream.timeout_ms),
        max_retries: stream.and_then(|stream| stream.max_retries),
        max_retry_delay_ms: stream.and_then(|stream| stream.max_retry_delay_ms),
        metadata: stream.and_then(|stream| stream.metadata.clone()),
        extra: stream
            .map(|stream| stream.extra.clone())
            .unwrap_or_default(),
    }
}

pub const fn clamp_reasoning(effort: Option<ThinkingLevel>) -> Option<ThinkingLevel> {
    match effort {
        Some(ThinkingLevel::Xhigh) => Some(ThinkingLevel::High),
        effort => effort,
    }
}

pub fn adjust_max_tokens_for_thinking(
    base_max_tokens: u64,
    model_max_tokens: u64,
    reasoning_level: ThinkingLevel,
    custom_budgets: Option<&ThinkingBudgets>,
) -> AdjustedThinkingTokens {
    let level = clamp_reasoning(Some(reasoning_level))
        .expect("reasoning_level is always present when wrapped in Some");
    let mut thinking_budget = thinking_budget_for_level(level, custom_budgets);
    let max_tokens = base_max_tokens
        .saturating_add(thinking_budget)
        .min(model_max_tokens);

    if max_tokens <= thinking_budget {
        thinking_budget = max_tokens.saturating_sub(MIN_OUTPUT_TOKENS);
    }

    AdjustedThinkingTokens {
        max_tokens,
        thinking_budget,
    }
}

fn default_max_tokens(model: &Model) -> Option<u64> {
    (model.max_tokens > 0).then(|| model.max_tokens.min(DEFAULT_MAX_TOKENS_CAP))
}

fn thinking_budget_for_level(
    level: ThinkingLevel,
    custom_budgets: Option<&ThinkingBudgets>,
) -> u64 {
    match level {
        ThinkingLevel::Minimal => custom_budgets
            .and_then(|budgets| budgets.minimal)
            .map(u64::from)
            .unwrap_or(DEFAULT_MINIMAL_THINKING_BUDGET),
        ThinkingLevel::Low => custom_budgets
            .and_then(|budgets| budgets.low)
            .map(u64::from)
            .unwrap_or(DEFAULT_LOW_THINKING_BUDGET),
        ThinkingLevel::Medium => custom_budgets
            .and_then(|budgets| budgets.medium)
            .map(u64::from)
            .unwrap_or(DEFAULT_MEDIUM_THINKING_BUDGET),
        ThinkingLevel::High | ThinkingLevel::Xhigh => custom_budgets
            .and_then(|budgets| budgets.high)
            .map(u64::from)
            .unwrap_or(DEFAULT_HIGH_THINKING_BUDGET),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CacheRetention, Transport};
    use serde_json::{Map, Value};
    use std::collections::HashMap;

    #[test]
    fn build_base_options_uses_explicit_options_and_api_key_override() {
        let model = Model {
            max_tokens: 100_000,
            ..Model::default()
        };
        let mut headers = HashMap::new();
        headers.insert("x-test".to_string(), "1".to_string());
        let mut metadata = Map::new();
        metadata.insert("trace".to_string(), Value::Bool(true));
        let mut extra = Map::new();
        extra.insert(
            "providerOption".to_string(),
            Value::String("kept".to_string()),
        );

        let options = SimpleStreamOptions {
            stream: StreamOptions {
                temperature: Some(0.2),
                max_tokens: Some(4_096),
                api_key: Some("option-key".to_string()),
                transport: Some(Transport::Sse),
                cache_retention: Some(CacheRetention::Short),
                session_id: Some("session-1".to_string()),
                headers: Some(headers.clone()),
                timeout_ms: Some(5_000),
                max_retries: Some(3),
                max_retry_delay_ms: Some(250),
                metadata: Some(metadata.clone()),
                extra: extra.clone(),
            },
            reasoning: Some(ThinkingLevel::Medium),
            thinking_budgets: None,
        };

        let base = build_base_options(&model, Some(&options), Some("override-key"));

        assert_eq!(base.temperature, Some(0.2));
        assert_eq!(base.max_tokens, Some(4_096));
        assert_eq!(base.api_key.as_deref(), Some("override-key"));
        assert_eq!(base.transport, Some(Transport::Sse));
        assert_eq!(base.cache_retention, Some(CacheRetention::Short));
        assert_eq!(base.session_id.as_deref(), Some("session-1"));
        assert_eq!(base.headers, Some(headers));
        assert_eq!(base.timeout_ms, Some(5_000));
        assert_eq!(base.max_retries, Some(3));
        assert_eq!(base.max_retry_delay_ms, Some(250));
        assert_eq!(base.metadata, Some(metadata));
        assert_eq!(base.extra, extra);
    }

    #[test]
    fn build_base_options_falls_back_to_model_max_tokens_capped_at_32000() {
        let model = Model {
            max_tokens: 100_000,
            ..Model::default()
        };

        let base = build_base_options(&model, None, None);

        assert_eq!(base.max_tokens, Some(32_000));
    }

    #[test]
    fn build_base_options_keeps_missing_model_max_tokens_undefined() {
        let model = Model {
            max_tokens: 0,
            ..Model::default()
        };

        let base = build_base_options(&model, None, None);

        assert_eq!(base.max_tokens, None);
    }

    #[test]
    fn build_base_options_empty_api_key_override_falls_back_to_options_key() {
        let model = Model::default();
        let options = SimpleStreamOptions {
            stream: StreamOptions {
                api_key: Some("option-key".to_string()),
                ..StreamOptions::default()
            },
            ..SimpleStreamOptions::default()
        };

        let base = build_base_options(&model, Some(&options), Some(""));

        assert_eq!(base.api_key.as_deref(), Some("option-key"));
    }

    #[test]
    fn clamp_reasoning_downgrades_xhigh_to_high() {
        assert_eq!(
            clamp_reasoning(Some(ThinkingLevel::Xhigh)),
            Some(ThinkingLevel::High)
        );
        assert_eq!(
            clamp_reasoning(Some(ThinkingLevel::Medium)),
            Some(ThinkingLevel::Medium)
        );
        assert_eq!(clamp_reasoning(None), None);
    }

    #[test]
    fn adjust_max_tokens_for_thinking_uses_default_budget() {
        let adjusted = adjust_max_tokens_for_thinking(4_096, 100_000, ThinkingLevel::Medium, None);

        assert_eq!(
            adjusted,
            AdjustedThinkingTokens {
                max_tokens: 12_288,
                thinking_budget: 8_192,
            }
        );
    }

    #[test]
    fn adjust_max_tokens_for_thinking_merges_custom_budget_for_level() {
        let budgets = ThinkingBudgets {
            minimal: None,
            low: Some(3_000),
            medium: None,
            high: None,
        };

        let adjusted =
            adjust_max_tokens_for_thinking(2_000, 10_000, ThinkingLevel::Low, Some(&budgets));

        assert_eq!(
            adjusted,
            AdjustedThinkingTokens {
                max_tokens: 5_000,
                thinking_budget: 3_000,
            }
        );
    }

    #[test]
    fn adjust_max_tokens_for_thinking_clamps_xhigh_to_high_budget() {
        let adjusted = adjust_max_tokens_for_thinking(1_000, 100_000, ThinkingLevel::Xhigh, None);

        assert_eq!(
            adjusted,
            AdjustedThinkingTokens {
                max_tokens: 17_384,
                thinking_budget: 16_384,
            }
        );
    }

    #[test]
    fn adjust_max_tokens_for_thinking_reduces_budget_to_leave_output_tokens() {
        let adjusted = adjust_max_tokens_for_thinking(4_096, 8_000, ThinkingLevel::High, None);

        assert_eq!(
            adjusted,
            AdjustedThinkingTokens {
                max_tokens: 8_000,
                thinking_budget: 6_976,
            }
        );
    }

    #[test]
    fn adjust_max_tokens_for_thinking_saturates_budget_at_zero_when_too_small() {
        let adjusted = adjust_max_tokens_for_thinking(128, 512, ThinkingLevel::Minimal, None);

        assert_eq!(
            adjusted,
            AdjustedThinkingTokens {
                max_tokens: 512,
                thinking_budget: 0,
            }
        );
    }
}
