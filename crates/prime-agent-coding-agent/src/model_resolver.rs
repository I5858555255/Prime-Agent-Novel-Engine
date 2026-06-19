use std::collections::HashMap;

use prime_agent_ai::{Model, ModelThinkingLevel};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseModelPatternOptions {
    pub allow_invalid_thinking_level_fallback: bool,
}

impl Default for ParseModelPatternOptions {
    fn default() -> Self {
        Self {
            allow_invalid_thinking_level_fallback: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScopedModel<'a> {
    pub model: &'a Model,
    pub thinking_level: Option<ModelThinkingLevel>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedModelResult<'a> {
    pub model: Option<&'a Model>,
    pub thinking_level: Option<ModelThinkingLevel>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolveModelScopeResult<'a> {
    pub scoped_models: Vec<ScopedModel<'a>>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum MatchState<'a> {
    None,
    One(&'a Model),
    Multiple,
}

pub fn parse_thinking_level(level: &str) -> Option<ModelThinkingLevel> {
    match level {
        "off" => Some(ModelThinkingLevel::Off),
        "minimal" => Some(ModelThinkingLevel::Minimal),
        "low" => Some(ModelThinkingLevel::Low),
        "medium" => Some(ModelThinkingLevel::Medium),
        "high" => Some(ModelThinkingLevel::High),
        "xhigh" => Some(ModelThinkingLevel::Xhigh),
        _ => None,
    }
}

pub fn is_alias(id: &str) -> bool {
    if id.ends_with("-latest") {
        return true;
    }

    let bytes = id.as_bytes();
    if bytes.len() >= 9 {
        let date_suffix = &bytes[bytes.len() - 9..];
        if date_suffix[0] == b'-' && date_suffix[1..].iter().all(u8::is_ascii_digit) {
            return false;
        }
    }

    true
}

pub fn find_exact_model_reference_match<'a>(
    model_reference: &str,
    available_models: &'a [Model],
) -> Option<&'a Model> {
    let trimmed_reference = model_reference.trim();
    if trimmed_reference.is_empty() {
        return None;
    }

    let normalized_reference = trimmed_reference.to_lowercase();
    match match_state(available_models.iter().filter(|model| {
        format!("{}/{}", model.provider, model.id).to_lowercase() == normalized_reference
    })) {
        MatchState::One(model) => return Some(model),
        MatchState::Multiple => return None,
        MatchState::None => {}
    }

    if let Some(slash_index) = trimmed_reference.find('/') {
        let provider = trimmed_reference[..slash_index].trim();
        let model_id = trimmed_reference[slash_index + 1..].trim();
        if !provider.is_empty() && !model_id.is_empty() {
            let provider = provider.to_lowercase();
            let model_id = model_id.to_lowercase();
            match match_state(available_models.iter().filter(|model| {
                model.provider.to_lowercase() == provider && model.id.to_lowercase() == model_id
            })) {
                MatchState::One(model) => return Some(model),
                MatchState::Multiple => return None,
                MatchState::None => {}
            }
        }
    }

    match match_state(
        available_models
            .iter()
            .filter(|model| model.id.to_lowercase() == normalized_reference),
    ) {
        MatchState::One(model) => Some(model),
        MatchState::None | MatchState::Multiple => None,
    }
}

pub fn parse_model_pattern<'a>(
    pattern: &str,
    available_models: &'a [Model],
) -> ParsedModelResult<'a> {
    parse_model_pattern_with_options(
        pattern,
        available_models,
        ParseModelPatternOptions::default(),
    )
}

pub fn parse_model_pattern_with_options<'a>(
    pattern: &str,
    available_models: &'a [Model],
    options: ParseModelPatternOptions,
) -> ParsedModelResult<'a> {
    if let Some(model) = try_match_model(pattern, available_models) {
        return ParsedModelResult {
            model: Some(model),
            thinking_level: None,
            warning: None,
        };
    }

    let Some(last_colon_index) = pattern.rfind(':') else {
        return ParsedModelResult {
            model: None,
            thinking_level: None,
            warning: None,
        };
    };

    let prefix = &pattern[..last_colon_index];
    let suffix = &pattern[last_colon_index + 1..];

    if let Some(thinking_level) = parse_thinking_level(suffix) {
        let result = parse_model_pattern_with_options(prefix, available_models, options);
        if result.model.is_some() {
            return ParsedModelResult {
                model: result.model,
                thinking_level: result.warning.is_none().then_some(thinking_level),
                warning: result.warning,
            };
        }
        return result;
    }

    if !options.allow_invalid_thinking_level_fallback {
        return ParsedModelResult {
            model: None,
            thinking_level: None,
            warning: None,
        };
    }

    let result = parse_model_pattern_with_options(prefix, available_models, options);
    if result.model.is_some() {
        return ParsedModelResult {
            model: result.model,
            thinking_level: None,
            warning: Some(format!(
                "Invalid thinking level \"{suffix}\" in pattern \"{pattern}\". Using default instead."
            )),
        };
    }

    result
}

pub fn resolve_model_scope_from_models<'a, S>(
    patterns: &[S],
    available_models: &'a [Model],
) -> ResolveModelScopeResult<'a>
where
    S: AsRef<str>,
{
    let mut scoped_models = Vec::new();
    let mut warnings = Vec::new();

    for pattern in patterns {
        let pattern = pattern.as_ref();
        if contains_glob(pattern) {
            let mut glob_pattern = pattern;
            let mut thinking_level = None;

            if let Some(colon_index) = pattern.rfind(':') {
                let suffix = &pattern[colon_index + 1..];
                if let Some(level) = parse_thinking_level(suffix) {
                    thinking_level = Some(level);
                    glob_pattern = &pattern[..colon_index];
                }
            }

            let matching_models = available_models
                .iter()
                .filter(|model| {
                    let full_id = format!("{}/{}", model.provider, model.id);
                    glob_match_nocase(glob_pattern, &full_id)
                        || glob_match_nocase(glob_pattern, &model.id)
                })
                .collect::<Vec<_>>();

            if matching_models.is_empty() {
                warnings.push(format!("No models match pattern \"{pattern}\""));
                continue;
            }

            for model in matching_models {
                push_scoped_model_once(&mut scoped_models, model, thinking_level);
            }
            continue;
        }

        let result = parse_model_pattern(pattern, available_models);
        if let Some(warning) = result.warning {
            warnings.push(warning);
        }

        let Some(model) = result.model else {
            warnings.push(format!("No models match pattern \"{pattern}\""));
            continue;
        };

        push_scoped_model_once(&mut scoped_models, model, result.thinking_level);
    }

    ResolveModelScopeResult {
        scoped_models,
        warnings,
    }
}

fn try_match_model<'a>(model_pattern: &str, available_models: &'a [Model]) -> Option<&'a Model> {
    if let Some(exact_match) = find_exact_model_reference_match(model_pattern, available_models) {
        return Some(exact_match);
    }

    let normalized_pattern = model_pattern.to_lowercase();
    let matches = available_models
        .iter()
        .filter(|model| {
            model.id.to_lowercase().contains(&normalized_pattern)
                || model.name.to_lowercase().contains(&normalized_pattern)
        })
        .collect::<Vec<_>>();

    if matches.is_empty() {
        return None;
    }

    let mut aliases = matches
        .iter()
        .copied()
        .filter(|model| is_alias(&model.id))
        .collect::<Vec<_>>();

    if !aliases.is_empty() {
        aliases.sort_by(|a, b| b.id.cmp(&a.id));
        return aliases.first().copied();
    }

    let mut dated_versions = matches;
    dated_versions.sort_by(|a, b| b.id.cmp(&a.id));
    dated_versions.first().copied()
}

fn match_state<'a>(models: impl Iterator<Item = &'a Model>) -> MatchState<'a> {
    let mut matches = models.fuse();
    let Some(first) = matches.next() else {
        return MatchState::None;
    };

    if matches.next().is_some() {
        MatchState::Multiple
    } else {
        MatchState::One(first)
    }
}

fn push_scoped_model_once<'a>(
    scoped_models: &mut Vec<ScopedModel<'a>>,
    model: &'a Model,
    thinking_level: Option<ModelThinkingLevel>,
) {
    if scoped_models
        .iter()
        .any(|scoped| models_are_equal(scoped.model, model))
    {
        return;
    }

    scoped_models.push(ScopedModel {
        model,
        thinking_level,
    });
}

fn models_are_equal(a: &Model, b: &Model) -> bool {
    a.id == b.id && a.provider == b.provider
}

fn contains_glob(pattern: &str) -> bool {
    pattern.contains('*') || pattern.contains('?') || pattern.contains('[')
}

fn glob_match_nocase(pattern: &str, text: &str) -> bool {
    let pattern = pattern.to_lowercase().chars().collect::<Vec<_>>();
    let text = text.to_lowercase().chars().collect::<Vec<_>>();
    let mut memo = HashMap::new();
    glob_match_at(&pattern, 0, &text, 0, &mut memo)
}

fn glob_match_at(
    pattern: &[char],
    pattern_index: usize,
    text: &[char],
    text_index: usize,
    memo: &mut HashMap<(usize, usize), bool>,
) -> bool {
    if let Some(cached) = memo.get(&(pattern_index, text_index)) {
        return *cached;
    }

    let matched = if pattern_index == pattern.len() {
        text_index == text.len()
    } else {
        match pattern[pattern_index] {
            '*' => {
                let next_pattern_index = consume_stars(pattern, pattern_index);
                let is_globstar = next_pattern_index - pattern_index > 1;

                if glob_match_at(pattern, next_pattern_index, text, text_index, memo) {
                    true
                } else {
                    let mut next_text_index = text_index;
                    let mut matched = false;
                    while next_text_index < text.len()
                        && (is_globstar || text[next_text_index] != '/')
                    {
                        next_text_index += 1;
                        if glob_match_at(pattern, next_pattern_index, text, next_text_index, memo) {
                            matched = true;
                            break;
                        }
                    }
                    matched
                }
            }
            '?' => {
                text_index < text.len()
                    && text[text_index] != '/'
                    && glob_match_at(pattern, pattern_index + 1, text, text_index + 1, memo)
            }
            '[' => {
                if text_index >= text.len() || text[text_index] == '/' {
                    false
                } else if let Some((class_matched, next_pattern_index)) =
                    match_character_class(pattern, pattern_index, text[text_index])
                {
                    class_matched
                        && glob_match_at(pattern, next_pattern_index, text, text_index + 1, memo)
                } else {
                    text.get(text_index) == Some(&'[')
                        && glob_match_at(pattern, pattern_index + 1, text, text_index + 1, memo)
                }
            }
            literal => {
                text.get(text_index) == Some(&literal)
                    && glob_match_at(pattern, pattern_index + 1, text, text_index + 1, memo)
            }
        }
    };

    memo.insert((pattern_index, text_index), matched);
    matched
}

fn consume_stars(pattern: &[char], start: usize) -> usize {
    let mut index = start;
    while index < pattern.len() && pattern[index] == '*' {
        index += 1;
    }
    index
}

fn match_character_class(pattern: &[char], start: usize, character: char) -> Option<(bool, usize)> {
    let mut index = start + 1;
    let negated = matches!(pattern.get(index), Some('!' | '^'));
    if negated {
        index += 1;
    }

    let mut matched = false;
    while index < pattern.len() && pattern[index] != ']' {
        if index + 2 < pattern.len() && pattern[index + 1] == '-' && pattern[index + 2] != ']' {
            matched |= pattern[index] <= character && character <= pattern[index + 2];
            index += 3;
        } else {
            matched |= pattern[index] == character;
            index += 1;
        }
    }

    if index >= pattern.len() {
        return None;
    }

    Some((if negated { !matched } else { matched }, index + 1))
}
