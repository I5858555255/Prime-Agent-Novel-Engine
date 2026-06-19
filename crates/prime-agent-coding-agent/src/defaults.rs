use prime_agent_ai::ThinkingLevel;

pub const DEFAULT_THINKING_LEVEL: ThinkingLevel = ThinkingLevel::Medium;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_thinking_level_matches_typescript_constant() {
        assert_eq!(DEFAULT_THINKING_LEVEL, ThinkingLevel::Medium);
    }
}
