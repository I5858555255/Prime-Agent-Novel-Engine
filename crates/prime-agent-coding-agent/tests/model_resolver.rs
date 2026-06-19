#[path = "../src/model_resolver.rs"]
mod model_resolver;

use model_resolver::{
    ParseModelPatternOptions, find_exact_model_reference_match, is_alias, parse_model_pattern,
    parse_model_pattern_with_options, resolve_model_scope_from_models,
};
use prime_agent_ai::{Model, ModelInput, ModelPricing, ModelThinkingLevel};

fn test_model(provider: &str, id: &str, name: &str) -> Model {
    Model {
        id: id.to_string(),
        name: name.to_string(),
        api: "anthropic-messages".to_string(),
        provider: provider.to_string(),
        base_url: "https://example.com".to_string(),
        reasoning: true,
        thinking_level_map: None,
        input: vec![ModelInput::Text],
        cost: ModelPricing::default(),
        context_window: 128_000,
        max_tokens: 8_192,
        headers: None,
        compat: None,
    }
}

fn all_models() -> Vec<Model> {
    vec![
        test_model(
            "anthropic",
            "claude-sonnet-4-5-20250929",
            "Claude Sonnet 4.5 Dated",
        ),
        test_model("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
        test_model("openai", "gpt-4o", "GPT-4o"),
        test_model("openai", "dated-only-20241022", "Dated Only 20241022"),
        test_model("openai", "dated-only-20250101", "Dated Only 20250101"),
        test_model("openai", "shared-model", "Shared OpenAI"),
        test_model("anthropic", "shared-model", "Shared Anthropic"),
        test_model(
            "openrouter",
            "qwen/qwen3-coder:exacto",
            "Qwen3 Coder Exacto",
        ),
        test_model("openrouter", "openai/gpt-4o:extended", "GPT-4o Extended"),
    ]
}

#[test]
fn model_resolver_exact_reference_matches_provider_model_and_rejects_ambiguous_bare_ids() {
    let models = all_models();

    let canonical =
        find_exact_model_reference_match("openrouter/qwen/qwen3-coder:exacto", &models).unwrap();
    assert_eq!(canonical.provider, "openrouter");
    assert_eq!(canonical.id, "qwen/qwen3-coder:exacto");

    let spaced = find_exact_model_reference_match(" OPENAI / GPT-4O ", &models).unwrap();
    assert_eq!(spaced.provider, "openai");
    assert_eq!(spaced.id, "gpt-4o");

    assert!(find_exact_model_reference_match("shared-model", &models).is_none());
}

#[test]
fn model_resolver_partial_matching_prefers_alias_then_latest_dated_version() {
    let models = all_models();

    assert!(is_alias("claude-sonnet-4-5"));
    assert!(is_alias("devstral-medium-latest"));
    assert!(!is_alias("claude-sonnet-4-5-20250929"));

    let alias = parse_model_pattern("sonnet-4-5", &models);
    assert_eq!(alias.model.unwrap().id, "claude-sonnet-4-5");
    assert_eq!(alias.thinking_level, None);
    assert_eq!(alias.warning, None);

    let dated = parse_model_pattern("dated-only", &models);
    assert_eq!(dated.model.unwrap().id, "dated-only-20250101");
}

#[test]
fn model_resolver_colon_parsing_preserves_model_id_colons_and_extracts_thinking_level() {
    let models = all_models();

    let exact = parse_model_pattern("qwen/qwen3-coder:exacto", &models);
    assert_eq!(exact.model.unwrap().id, "qwen/qwen3-coder:exacto");
    assert_eq!(exact.thinking_level, None);
    assert_eq!(exact.warning, None);

    let with_thinking = parse_model_pattern("qwen/qwen3-coder:exacto:high", &models);
    assert_eq!(with_thinking.model.unwrap().id, "qwen/qwen3-coder:exacto");
    assert_eq!(with_thinking.thinking_level, Some(ModelThinkingLevel::High));
    assert_eq!(with_thinking.warning, None);

    let invalid = parse_model_pattern("qwen/qwen3-coder:exacto:random", &models);
    assert_eq!(invalid.model.unwrap().id, "qwen/qwen3-coder:exacto");
    assert_eq!(invalid.thinking_level, None);
    assert!(invalid.warning.unwrap().contains("Invalid thinking level"));
}

#[test]
fn model_resolver_strict_colon_parsing_treats_invalid_suffix_as_part_of_model_id() {
    let models = all_models();
    let openai_models = models
        .into_iter()
        .filter(|model| model.provider == "openai")
        .collect::<Vec<_>>();

    let result = parse_model_pattern_with_options(
        "gpt-4o:extended",
        &openai_models,
        ParseModelPatternOptions {
            allow_invalid_thinking_level_fallback: false,
        },
    );

    assert!(result.model.is_none());
    assert_eq!(result.thinking_level, None);
    assert_eq!(result.warning, None);
}

#[test]
fn model_resolver_scope_resolution_matches_globs_adds_thinking_and_deduplicates() {
    let models = all_models();
    let patterns = ["openai/gpt-4o:medium", "*gpt-4o*", "openrouter/qwen/*:high"];

    let result = resolve_model_scope_from_models(&patterns, &models);

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.scoped_models.len(), 2);
    assert_eq!(result.scoped_models[0].model.provider, "openai");
    assert_eq!(result.scoped_models[0].model.id, "gpt-4o");
    assert_eq!(
        result.scoped_models[0].thinking_level,
        Some(ModelThinkingLevel::Medium)
    );
    assert_eq!(result.scoped_models[1].model.provider, "openrouter");
    assert_eq!(result.scoped_models[1].model.id, "qwen/qwen3-coder:exacto");
    assert_eq!(
        result.scoped_models[1].thinking_level,
        Some(ModelThinkingLevel::High)
    );
}

#[test]
fn model_resolver_scope_resolution_reports_missing_patterns_as_data() {
    let models = all_models();
    let result = resolve_model_scope_from_models(&["missing-model"], &models);

    assert!(result.scoped_models.is_empty());
    assert_eq!(
        result.warnings,
        vec!["No models match pattern \"missing-model\"".to_string()]
    );
}
