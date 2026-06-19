pub const BUILT_IN_PROVIDER_DISPLAY_NAMES: &[(&str, &str)] = &[
    ("anthropic", "Anthropic"),
    ("amazon-bedrock", "Amazon Bedrock"),
    ("azure-openai-responses", "Azure OpenAI Responses"),
    ("cerebras", "Cerebras"),
    ("cloudflare-ai-gateway", "Cloudflare AI Gateway"),
    ("cloudflare-workers-ai", "Cloudflare Workers AI"),
    ("deepseek", "DeepSeek"),
    ("fireworks", "Fireworks"),
    ("google", "Google Gemini"),
    ("google-vertex", "Google Vertex AI"),
    ("groq", "Groq"),
    ("huggingface", "Hugging Face"),
    ("kimi-coding", "Kimi For Coding"),
    ("mistral", "Mistral"),
    ("minimax", "MiniMax"),
    ("minimax-cn", "MiniMax (China)"),
    ("moonshotai", "Moonshot AI"),
    ("moonshotai-cn", "Moonshot AI (China)"),
    ("opencode", "OpenCode Zen"),
    ("opencode-go", "OpenCode Go"),
    ("openai", "OpenAI"),
    ("openrouter", "OpenRouter"),
    ("prime-agent-traces", "Prime Agent Traces"),
    ("prime-inference", "Prime Inference"),
    ("vercel-ai-gateway", "Vercel AI Gateway"),
    ("xai", "xAI"),
    ("zai", "ZAI"),
    ("xiaomi", "Xiaomi MiMo"),
    ("xiaomi-token-plan-cn", "Xiaomi MiMo Token Plan (China)"),
    (
        "xiaomi-token-plan-ams",
        "Xiaomi MiMo Token Plan (Amsterdam)",
    ),
    (
        "xiaomi-token-plan-sgp",
        "Xiaomi MiMo Token Plan (Singapore)",
    ),
];

pub fn built_in_provider_display_name(provider: &str) -> Option<&'static str> {
    BUILT_IN_PROVIDER_DISPLAY_NAMES
        .iter()
        .find_map(|(id, name)| (*id == provider).then_some(*name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn includes_current_typescript_builtin_provider_names() {
        assert_eq!(
            built_in_provider_display_name("anthropic"),
            Some("Anthropic")
        );
        assert_eq!(
            built_in_provider_display_name("prime-inference"),
            Some("Prime Inference")
        );
        assert_eq!(
            built_in_provider_display_name("xiaomi-token-plan-ams"),
            Some("Xiaomi MiMo Token Plan (Amsterdam)")
        );
    }

    #[test]
    fn unknown_provider_has_no_builtin_display_name() {
        assert_eq!(built_in_provider_display_name("custom-provider"), None);
    }

    #[test]
    fn preserves_table_size_from_typescript_source() {
        assert_eq!(BUILT_IN_PROVIDER_DISPLAY_NAMES.len(), 31);
    }
}
