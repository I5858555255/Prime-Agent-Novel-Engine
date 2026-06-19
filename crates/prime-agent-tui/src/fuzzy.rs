use std::cmp::Ordering;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FuzzyMatch {
    pub matches: bool,
    pub score: f64,
}

pub fn fuzzy_match(query: &str, text: &str) -> FuzzyMatch {
    let query_lower = query.to_lowercase();
    let text_lower = text.to_lowercase();

    let primary_match = match_query(&query_lower, &text_lower);
    if primary_match.matches {
        return primary_match;
    }

    let swapped_query = swapped_alpha_numeric_query(&query_lower);
    if swapped_query.is_empty() {
        return primary_match;
    }

    let swapped_match = match_query(&swapped_query, &text_lower);
    if !swapped_match.matches {
        return primary_match;
    }

    FuzzyMatch {
        matches: true,
        score: swapped_match.score + 5.0,
    }
}

pub fn fuzzy_filter<T, F>(items: &[T], query: &str, get_text: F) -> Vec<T>
where
    T: Clone,
    F: Fn(&T) -> String,
{
    if query.trim().is_empty() {
        return items.to_vec();
    }

    let tokens = query.split_whitespace().collect::<Vec<_>>();
    if tokens.is_empty() {
        return items.to_vec();
    }

    let mut results = Vec::new();
    for item in items {
        let text = get_text(item);
        let mut total_score = 0.0;
        let mut all_match = true;

        for token in &tokens {
            let matched = fuzzy_match(token, &text);
            if matched.matches {
                total_score += matched.score;
            } else {
                all_match = false;
                break;
            }
        }

        if all_match {
            results.push((item.clone(), total_score));
        }
    }

    results.sort_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    results.into_iter().map(|(item, _)| item).collect()
}

fn match_query(normalized_query: &str, text_lower: &str) -> FuzzyMatch {
    let query_chars = normalized_query.chars().collect::<Vec<_>>();
    let text_chars = text_lower.chars().collect::<Vec<_>>();

    if query_chars.is_empty() {
        return FuzzyMatch {
            matches: true,
            score: 0.0,
        };
    }

    if query_chars.len() > text_chars.len() {
        return FuzzyMatch {
            matches: false,
            score: 0.0,
        };
    }

    let mut query_index = 0;
    let mut score = 0.0;
    let mut last_match_index: isize = -1;
    let mut consecutive_matches = 0.0;

    for (index, text_char) in text_chars.iter().enumerate() {
        if query_index >= query_chars.len() {
            break;
        }

        if *text_char != query_chars[query_index] {
            continue;
        }

        let is_word_boundary = index == 0 || is_boundary_char(text_chars[index - 1]);

        let index = index as isize;

        if last_match_index == index - 1 {
            consecutive_matches += 1.0;
            score -= consecutive_matches * 5.0;
        } else {
            consecutive_matches = 0.0;
            if last_match_index >= 0 {
                score += ((index - last_match_index - 1) * 2) as f64;
            }
        }

        if is_word_boundary {
            score -= 10.0;
        }

        score += index as f64 * 0.1;

        last_match_index = index;
        query_index += 1;
    }

    if query_index < query_chars.len() {
        return FuzzyMatch {
            matches: false,
            score: 0.0,
        };
    }

    if normalized_query == text_lower {
        score -= 100.0;
    }

    FuzzyMatch {
        matches: true,
        score,
    }
}

fn is_boundary_char(value: char) -> bool {
    value.is_whitespace() || matches!(value, '-' | '_' | '.' | '/' | ':')
}

fn swapped_alpha_numeric_query(query: &str) -> String {
    let split = query
        .char_indices()
        .find(|(_, ch)| ch.is_ascii_digit())
        .map(|(index, _)| index);

    if let Some(index) = split {
        let (letters, digits) = query.split_at(index);
        if !letters.is_empty()
            && letters.chars().all(|ch| ch.is_ascii_lowercase())
            && !digits.is_empty()
            && digits.chars().all(|ch| ch.is_ascii_digit())
        {
            return format!("{digits}{letters}");
        }
    }

    let split = query
        .char_indices()
        .find(|(_, ch)| ch.is_ascii_lowercase())
        .map(|(index, _)| index);

    if let Some(index) = split {
        let (digits, letters) = query.split_at(index);
        if !digits.is_empty()
            && digits.chars().all(|ch| ch.is_ascii_digit())
            && !letters.is_empty()
            && letters.chars().all(|ch| ch.is_ascii_lowercase())
        {
            return format!("{letters}{digits}");
        }
    }

    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_query_matches_everything_with_score_zero() {
        let result = fuzzy_match("", "anything");
        assert!(result.matches);
        assert_eq!(result.score, 0.0);
    }

    #[test]
    fn query_longer_than_text_does_not_match() {
        let result = fuzzy_match("longquery", "short");
        assert!(!result.matches);
    }

    #[test]
    fn exact_match_has_good_score() {
        let result = fuzzy_match("test", "test");
        assert!(result.matches);
        assert!(result.score < 0.0);
    }

    #[test]
    fn characters_must_appear_in_order() {
        assert!(fuzzy_match("abc", "aXbXc").matches);
        assert!(!fuzzy_match("abc", "cba").matches);
    }

    #[test]
    fn matching_is_case_insensitive() {
        assert!(fuzzy_match("ABC", "abc").matches);
        assert!(fuzzy_match("abc", "ABC").matches);
    }

    #[test]
    fn consecutive_matches_score_better_than_scattered_matches() {
        let consecutive = fuzzy_match("foo", "foobar");
        let scattered = fuzzy_match("foo", "f_o_o_bar");

        assert!(consecutive.matches);
        assert!(scattered.matches);
        assert!(consecutive.score < scattered.score);
    }

    #[test]
    fn word_boundary_matches_score_better() {
        let at_boundary = fuzzy_match("fb", "foo-bar");
        let not_at_boundary = fuzzy_match("fb", "afbx");

        assert!(at_boundary.matches);
        assert!(not_at_boundary.matches);
        assert!(at_boundary.score < not_at_boundary.score);
    }

    #[test]
    fn matches_swapped_alpha_numeric_tokens() {
        let result = fuzzy_match("codex52", "gpt-5.2-codex");
        assert!(result.matches);
    }

    #[test]
    fn empty_filter_query_returns_all_items_unchanged() {
        let items = vec!["apple", "banana", "cherry"];
        let result = fuzzy_filter(&items, "", |item| item.to_string());
        assert_eq!(result, items);
    }

    #[test]
    fn filter_removes_non_matching_items() {
        let items = vec!["apple", "banana", "cherry"];
        let result = fuzzy_filter(&items, "an", |item| item.to_string());

        assert!(result.contains(&"banana"));
        assert!(!result.contains(&"apple"));
        assert!(!result.contains(&"cherry"));
    }

    #[test]
    fn filter_sorts_results_by_match_quality() {
        let items = vec!["a_p_p", "app", "application"];
        let result = fuzzy_filter(&items, "app", |item| item.to_string());
        assert_eq!(result.first(), Some(&"app"));
    }

    #[test]
    fn filter_prioritizes_exact_matches_over_longer_prefix_matches() {
        let items = vec!["clone", "cl"];
        let result = fuzzy_filter(&items, "cl", |item| item.to_string());
        assert_eq!(result, vec!["cl", "clone"]);
    }

    #[test]
    fn filter_uses_custom_text_projection() {
        #[derive(Clone)]
        struct Item {
            name: &'static str,
            id: u8,
        }

        let items = vec![
            Item { name: "foo", id: 1 },
            Item { name: "bar", id: 2 },
            Item {
                name: "foobar",
                id: 3,
            },
        ];

        let result = fuzzy_filter(&items, "foo", |item| item.name.to_string());
        let ids = result.into_iter().map(|item| item.id).collect::<Vec<_>>();

        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&1));
        assert!(ids.contains(&3));
    }
}
