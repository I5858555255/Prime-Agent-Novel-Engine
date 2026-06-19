use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

fn is_valid_json_escape(char: char) -> bool {
    matches!(char, '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' | 'u')
}

fn is_control_character(char: char) -> bool {
    (char as u32) <= 0x1f
}

fn escape_control_character(char: char) -> String {
    match char {
        '\u{08}' => "\\b".to_string(),
        '\u{0c}' => "\\f".to_string(),
        '\n' => "\\n".to_string(),
        '\r' => "\\r".to_string(),
        '\t' => "\\t".to_string(),
        _ => format!("\\u{:04x}", char as u32),
    }
}

pub fn repair_json(json: &str) -> String {
    let mut repaired = String::with_capacity(json.len());
    let mut in_string = false;
    let mut chars = json.chars().peekable();

    while let Some(char) = chars.next() {
        if !in_string {
            repaired.push(char);
            if char == '"' {
                in_string = true;
            }
            continue;
        }

        match char {
            '"' => {
                repaired.push(char);
                in_string = false;
            }
            '\\' => {
                let Some(&next_char) = chars.peek() else {
                    repaired.push_str("\\\\");
                    continue;
                };

                if next_char == 'u' {
                    let mut lookahead = chars.clone();
                    let _ = lookahead.next();
                    let unicode_digits = lookahead.by_ref().take(4).collect::<String>();

                    if unicode_digits.chars().count() == 4
                        && unicode_digits.chars().all(|char| char.is_ascii_hexdigit())
                    {
                        repaired.push('\\');
                        repaired.push('u');
                        repaired.push_str(&unicode_digits);
                        let _ = chars.next();
                        for _ in 0..4 {
                            let _ = chars.next();
                        }
                        continue;
                    }
                }

                if is_valid_json_escape(next_char) {
                    repaired.push('\\');
                    repaired.push(next_char);
                    let _ = chars.next();
                    continue;
                }

                repaired.push_str("\\\\");
            }
            _ if is_control_character(char) => {
                repaired.push_str(&escape_control_character(char));
            }
            _ => repaired.push(char),
        }
    }

    repaired
}

pub fn parse_json_with_repair<T>(json: &str) -> serde_json::Result<T>
where
    T: DeserializeOwned,
{
    match serde_json::from_str(json) {
        Ok(parsed) => Ok(parsed),
        Err(error) => {
            let repaired_json = repair_json(json);
            if repaired_json != json {
                serde_json::from_str(&repaired_json)
            } else {
                Err(error)
            }
        }
    }
}

pub fn parse_streaming_json(partial_json: Option<&str>) -> Value {
    let Some(partial_json) = partial_json else {
        return empty_object();
    };

    if partial_json.trim().is_empty() {
        return empty_object();
    }

    if let Ok(parsed) = parse_json_with_repair(partial_json) {
        return parsed;
    }

    if let Some(parsed) = parse_partial_json(partial_json) {
        return parsed;
    }

    let repaired_json = repair_json(partial_json);
    if repaired_json != partial_json
        && let Some(parsed) = parse_partial_json(&repaired_json)
    {
        return parsed;
    }

    empty_object()
}

fn empty_object() -> Value {
    Value::Object(Map::new())
}

fn parse_partial_json(partial_json: &str) -> Option<Value> {
    let trimmed = partial_json.trim();
    if !matches!(trimmed.chars().next(), Some('{' | '[')) {
        return None;
    }

    let trimmed_end = partial_json.trim_end().len();
    let mut boundaries = partial_json[..trimmed_end]
        .char_indices()
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    boundaries.push(trimmed_end);

    for end in boundaries.into_iter().rev() {
        let prefix = partial_json[..end].trim_end();
        if prefix.trim().is_empty() {
            continue;
        }

        let Some(candidate) = complete_json_prefix(prefix) else {
            continue;
        };

        if let Ok(parsed) = serde_json::from_str(&candidate) {
            return Some(parsed);
        }
    }

    None
}

fn complete_json_prefix(prefix: &str) -> Option<String> {
    let prefix = prefix.trim_end();
    if !matches!(prefix.trim_start().chars().next(), Some('{' | '[')) {
        return None;
    }

    let mut stack = Vec::new();
    let mut in_string = false;
    let mut escaped = false;

    for char in prefix.chars() {
        if in_string {
            if escaped {
                escaped = false;
                continue;
            }

            match char {
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }

        match char {
            '"' => in_string = true,
            '{' => stack.push('}'),
            '[' => stack.push(']'),
            '}' | ']' if stack.pop() != Some(char) => return None,
            '}' | ']' => {}
            _ => {}
        }
    }

    let mut candidate = prefix.to_string();
    if in_string {
        if escaped {
            candidate.push('\\');
        }
        candidate.push('"');
    }

    for close in stack.iter().rev() {
        candidate.push(*close);
    }

    Some(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn repair_json_escapes_raw_control_characters_inside_strings() {
        let input = "{\"text\":\"a\nb\tc\r\u{08}\u{0c}\u{00}\"}";

        assert_eq!(
            repair_json(input),
            "{\"text\":\"a\\nb\\tc\\r\\b\\f\\u0000\"}"
        );
    }

    #[test]
    fn repair_json_preserves_valid_json_escapes() {
        let input = r#"{"text":"quote \" slash \/ backslash \\ newline \n unicode \u0041"}"#;

        assert_eq!(repair_json(input), input);
    }

    #[test]
    fn repair_json_doubles_backslashes_before_invalid_escape_characters() {
        let input = r#"{"value":"a\q b\z"}"#;

        assert_eq!(repair_json(input), r#"{"value":"a\\q b\\z"}"#);
    }

    #[test]
    fn repair_json_doubles_trailing_backslash_inside_string() {
        let input = "{\"value\":\"abc\\";

        assert_eq!(repair_json(input), "{\"value\":\"abc\\\\");
    }

    #[test]
    fn parse_json_with_repair_parses_repaired_json() {
        let parsed = parse_json_with_repair::<Value>(
            r#"{"value":"a\q","line":"a
b"}"#,
        )
        .unwrap();

        assert_eq!(parsed, json!({"value": "a\\q", "line": "a\nb"}));
    }

    #[test]
    fn parse_streaming_json_returns_empty_object_for_empty_or_failed_input() {
        assert_eq!(parse_streaming_json(None), json!({}));
        assert_eq!(parse_streaming_json(Some("  \n\t  ")), json!({}));
        assert_eq!(parse_streaming_json(Some("not json")), json!({}));
    }

    #[test]
    fn parse_streaming_json_parses_repaired_complete_json() {
        let parsed = parse_streaming_json(Some(r#"{"value":"a\q"}"#));

        assert_eq!(parsed, json!({"value": "a\\q"}));
    }

    #[test]
    fn parse_streaming_json_conservatively_completes_partial_objects_and_arrays() {
        let parsed = parse_streaming_json(Some(r#"{"alpha":1,"items":[true,{"name":"cod"#));

        assert_eq!(
            parsed,
            json!({"alpha": 1, "items": [true, {"name": "cod"}]})
        );
    }

    #[test]
    fn parse_streaming_json_truncates_trailing_incomplete_members() {
        let parsed = parse_streaming_json(Some(r#"{"alpha":1,"items":[true,]"#));

        assert_eq!(parsed, json!({"alpha": 1, "items": [true]}));
    }
}
