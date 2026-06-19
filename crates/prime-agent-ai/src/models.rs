use crate::{Cost, Model, ModelThinkingLevel, Usage};

pub const EXTENDED_THINKING_LEVELS: [ModelThinkingLevel; 6] = [
    ModelThinkingLevel::Off,
    ModelThinkingLevel::Minimal,
    ModelThinkingLevel::Low,
    ModelThinkingLevel::Medium,
    ModelThinkingLevel::High,
    ModelThinkingLevel::Xhigh,
];

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ModelRegistry {
    providers: Vec<(String, Vec<Model>)>,
}

impl ModelRegistry {
    pub fn new() -> Self {
        Self {
            providers: Vec::new(),
        }
    }

    pub fn insert_provider(&mut self, provider: impl Into<String>, models: Vec<Model>) {
        let provider = provider.into();
        if let Some((_, existing_models)) = self
            .providers
            .iter_mut()
            .find(|(existing_provider, _)| *existing_provider == provider)
        {
            *existing_models = models;
            return;
        }

        self.providers.push((provider, models));
    }

    pub fn get_model(&self, provider: &str, model_id: &str) -> Option<&Model> {
        self.providers
            .iter()
            .find(|(candidate, _)| candidate == provider)
            .and_then(|(_, models)| models.iter().find(|model| model.id == model_id))
    }

    pub fn get_providers(&self) -> Vec<&str> {
        self.providers
            .iter()
            .map(|(provider, _)| provider.as_str())
            .collect()
    }

    pub fn get_models(&self, provider: &str) -> Vec<&Model> {
        self.providers
            .iter()
            .find(|(candidate, _)| candidate == provider)
            .map(|(_, models)| models.iter().collect())
            .unwrap_or_default()
    }
}

pub fn calculate_cost(model: &Model, usage: &mut Usage) -> Cost {
    usage.cost.input = (model.cost.input / 1_000_000.0) * usage.input as f64;
    usage.cost.output = (model.cost.output / 1_000_000.0) * usage.output as f64;
    usage.cost.cache_read = (model.cost.cache_read / 1_000_000.0) * usage.cache_read as f64;
    usage.cost.cache_write = (model.cost.cache_write / 1_000_000.0) * usage.cache_write as f64;
    usage.cost.total =
        usage.cost.input + usage.cost.output + usage.cost.cache_read + usage.cost.cache_write;
    usage.cost.clone()
}

pub fn get_supported_thinking_levels(model: &Model) -> Vec<ModelThinkingLevel> {
    if !model.reasoning {
        return vec![ModelThinkingLevel::Off];
    }

    EXTENDED_THINKING_LEVELS
        .into_iter()
        .filter(|level| {
            let mapped = model
                .thinking_level_map
                .as_ref()
                .and_then(|map| map.get(level.as_str()));

            if mapped.is_some_and(|value| value.is_null()) {
                return false;
            }

            if *level == ModelThinkingLevel::Xhigh {
                return mapped.is_some();
            }

            true
        })
        .collect()
}

pub fn clamp_thinking_level(model: &Model, level: ModelThinkingLevel) -> ModelThinkingLevel {
    let available_levels = get_supported_thinking_levels(model);
    if available_levels.contains(&level) {
        return level;
    }

    let Some(requested_index) = EXTENDED_THINKING_LEVELS
        .iter()
        .position(|candidate| *candidate == level)
    else {
        return available_levels
            .first()
            .copied()
            .unwrap_or(ModelThinkingLevel::Off);
    };

    for candidate in EXTENDED_THINKING_LEVELS.iter().skip(requested_index) {
        if available_levels.contains(candidate) {
            return *candidate;
        }
    }

    for candidate in EXTENDED_THINKING_LEVELS.iter().take(requested_index).rev() {
        if available_levels.contains(candidate) {
            return *candidate;
        }
    }

    available_levels
        .first()
        .copied()
        .unwrap_or(ModelThinkingLevel::Off)
}

pub fn models_are_equal(a: Option<&Model>, b: Option<&Model>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.id == b.id && a.provider == b.provider,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ModelInput, ModelPricing};
    use serde_json::{Map, json};

    fn test_model(provider: &str, id: &str, reasoning: bool) -> Model {
        Model {
            id: id.to_string(),
            name: id.to_string(),
            api: "openai-completions".to_string(),
            provider: provider.to_string(),
            base_url: "https://example.com".to_string(),
            reasoning,
            thinking_level_map: None,
            input: vec![ModelInput::Text],
            cost: ModelPricing {
                input: 5.0,
                output: 30.0,
                cache_read: 1.0,
                cache_write: 2.0,
            },
            context_window: 100,
            max_tokens: 10,
            headers: None,
            compat: None,
        }
    }

    #[test]
    fn registry_preserves_provider_and_model_order() {
        let mut registry = ModelRegistry::new();
        registry.insert_provider(
            "openai",
            vec![
                test_model("openai", "gpt-a", false),
                test_model("openai", "gpt-b", false),
            ],
        );
        registry.insert_provider("anthropic", vec![test_model("anthropic", "claude", false)]);

        assert_eq!(registry.get_providers(), vec!["openai", "anthropic"]);
        assert_eq!(
            registry
                .get_models("openai")
                .into_iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["gpt-a", "gpt-b"]
        );
        assert_eq!(
            registry.get_model("anthropic", "claude").unwrap().provider,
            "anthropic"
        );
        assert!(registry.get_model("missing", "model").is_none());
    }

    #[test]
    fn calculate_cost_matches_typescript_per_million_formula() {
        let model = test_model("openai", "gpt", true);
        let mut usage = Usage {
            input: 1_000_000,
            output: 500_000,
            cache_read: 250_000,
            cache_write: 100_000,
            total_tokens: 1_850_000,
            cost: Cost::default(),
        };

        let cost = calculate_cost(&model, &mut usage);

        assert_close(cost.input, 5.0);
        assert_close(cost.output, 15.0);
        assert_close(cost.cache_read, 0.25);
        assert_close(cost.cache_write, 0.2);
        assert_close(cost.total, 20.45);
        assert_eq!(usage.cost, cost);
    }

    #[test]
    fn non_reasoning_models_only_support_off() {
        let model = test_model("openai", "gpt", false);

        assert_eq!(
            get_supported_thinking_levels(&model),
            vec![ModelThinkingLevel::Off]
        );
        assert_eq!(
            clamp_thinking_level(&model, ModelThinkingLevel::High),
            ModelThinkingLevel::Off
        );
    }

    #[test]
    fn reasoning_models_support_standard_levels_but_not_xhigh_by_default() {
        let model = test_model("openai", "gpt", true);

        assert_eq!(
            get_supported_thinking_levels(&model),
            vec![
                ModelThinkingLevel::Off,
                ModelThinkingLevel::Minimal,
                ModelThinkingLevel::Low,
                ModelThinkingLevel::Medium,
                ModelThinkingLevel::High,
            ]
        );
    }

    #[test]
    fn thinking_level_map_null_excludes_level_and_xhigh_requires_mapping() {
        let mut model = test_model("deepseek", "deepseek-v4-flash", true);
        model.thinking_level_map = Some(Map::from_iter([
            ("minimal".to_string(), json!(null)),
            ("low".to_string(), json!(null)),
            ("medium".to_string(), json!(null)),
            ("xhigh".to_string(), json!("xhigh")),
        ]));

        assert_eq!(
            get_supported_thinking_levels(&model),
            vec![
                ModelThinkingLevel::Off,
                ModelThinkingLevel::High,
                ModelThinkingLevel::Xhigh,
            ]
        );
        assert_eq!(
            clamp_thinking_level(&model, ModelThinkingLevel::Low),
            ModelThinkingLevel::High
        );
        assert_eq!(
            clamp_thinking_level(&model, ModelThinkingLevel::Xhigh),
            ModelThinkingLevel::Xhigh
        );
    }

    #[test]
    fn clamp_searches_upward_then_downward_from_requested_level() {
        let mut model = test_model("provider", "model", true);
        model.thinking_level_map = Some(Map::from_iter([
            ("minimal".to_string(), json!(null)),
            ("low".to_string(), json!(null)),
            ("medium".to_string(), json!(null)),
            ("high".to_string(), json!(null)),
            ("xhigh".to_string(), json!("xhigh")),
        ]));

        assert_eq!(
            clamp_thinking_level(&model, ModelThinkingLevel::Minimal),
            ModelThinkingLevel::Xhigh
        );

        model.thinking_level_map = Some(Map::from_iter([
            ("minimal".to_string(), json!(null)),
            ("low".to_string(), json!(null)),
            ("medium".to_string(), json!(null)),
            ("high".to_string(), json!(null)),
        ]));

        assert_eq!(
            clamp_thinking_level(&model, ModelThinkingLevel::High),
            ModelThinkingLevel::Off
        );
    }

    #[test]
    fn models_are_equal_compares_provider_and_id_only() {
        let a = test_model("openai", "gpt", true);
        let mut same = test_model("openai", "gpt", false);
        same.name = "Different display name".to_string();
        let different_provider = test_model("other", "gpt", true);
        let different_id = test_model("openai", "other", true);

        assert!(models_are_equal(Some(&a), Some(&same)));
        assert!(!models_are_equal(Some(&a), Some(&different_provider)));
        assert!(!models_are_equal(Some(&a), Some(&different_id)));
        assert!(!models_are_equal(Some(&a), None));
        assert!(!models_are_equal(None, None));
    }

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < f64::EPSILON * 16.0,
            "expected {actual} to be close to {expected}",
        );
    }
}
