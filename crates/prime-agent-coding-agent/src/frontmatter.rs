use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFrontmatter {
    pub frontmatter: Value,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExtractedFrontmatter {
    yaml_string: Option<String>,
    body: String,
}

fn normalize_newlines(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

fn extract_frontmatter(content: &str) -> ExtractedFrontmatter {
    let normalized = normalize_newlines(content);

    if !normalized.starts_with("---") {
        return ExtractedFrontmatter {
            yaml_string: None,
            body: normalized,
        };
    }

    let Some(relative_end_index) = normalized[3..].find("\n---") else {
        return ExtractedFrontmatter {
            yaml_string: None,
            body: normalized,
        };
    };
    let end_index = relative_end_index + 3;

    ExtractedFrontmatter {
        yaml_string: Some(normalized[4..end_index].to_owned()),
        body: normalized[end_index + 4..].trim().to_owned(),
    }
}

fn empty_frontmatter_object() -> Value {
    Value::Object(Map::new())
}

fn restore_literal_block_newlines(yaml_string: &str, parsed: &mut Value) {
    let Value::Object(fields) = parsed else {
        return;
    };

    for line in yaml_string.lines() {
        let Some((key, marker)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let marker = marker.trim();
        if key.is_empty() || !(marker == "|" || marker.starts_with("| ") || marker == ">") {
            continue;
        }

        if let Some(Value::String(value)) = fields.get_mut(key)
            && !value.ends_with('\n')
        {
            value.push('\n');
        }
    }
}

pub fn parse_frontmatter(content: &str) -> Result<ParsedFrontmatter, serde_yaml::Error> {
    let extracted = extract_frontmatter(content);
    let Some(yaml_string) = extracted.yaml_string else {
        return Ok(ParsedFrontmatter {
            frontmatter: empty_frontmatter_object(),
            body: extracted.body,
        });
    };

    if yaml_string.trim().is_empty() {
        return Ok(ParsedFrontmatter {
            frontmatter: empty_frontmatter_object(),
            body: extracted.body,
        });
    }

    let mut parsed = serde_yaml::from_str::<Value>(&yaml_string)?;
    restore_literal_block_newlines(&yaml_string, &mut parsed);
    let frontmatter = match parsed {
        Value::Null => empty_frontmatter_object(),
        value => value,
    };

    Ok(ParsedFrontmatter {
        frontmatter,
        body: extracted.body,
    })
}

pub fn strip_frontmatter(content: &str) -> Result<String, serde_yaml::Error> {
    parse_frontmatter(content).map(|parsed| parsed.body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn string_field<'a>(value: &'a Value, key: &str) -> &'a str {
        value.get(key).and_then(Value::as_str).unwrap()
    }

    #[test]
    fn parses_keys_strips_quotes_and_returns_body() {
        let input =
            "---\nname: \"skill-name\"\ndescription: 'A desc'\nfoo-bar: value\n---\n\nBody text";
        let parsed = parse_frontmatter(input).unwrap();

        assert_eq!(string_field(&parsed.frontmatter, "name"), "skill-name");
        assert_eq!(string_field(&parsed.frontmatter, "description"), "A desc");
        assert_eq!(string_field(&parsed.frontmatter, "foo-bar"), "value");
        assert_eq!(parsed.body, "Body text");
    }

    #[test]
    fn normalizes_newlines_and_handles_crlf() {
        let input = "---\r\nname: test\r\n---\r\nLine one\r\nLine two";
        let parsed = parse_frontmatter(input).unwrap();

        assert_eq!(parsed.body, "Line one\nLine two");
    }

    #[test]
    fn throws_on_invalid_yaml_frontmatter() {
        let input = "---\nfoo: [bar\n---\nBody";
        let err = parse_frontmatter(input).unwrap_err();

        assert!(err.to_string().contains("line 1"));
    }

    #[test]
    fn parses_multiline_yaml_block_syntax() {
        let input = "---\ndescription: |\n  Line one\n  Line two\n---\n\nBody";
        let parsed = parse_frontmatter(input).unwrap();

        assert_eq!(
            string_field(&parsed.frontmatter, "description"),
            "Line one\nLine two\n"
        );
        assert_eq!(parsed.body, "Body");
    }

    #[test]
    fn returns_original_content_when_frontmatter_is_missing_or_unterminated() {
        let no_frontmatter = "Just text\nsecond line";
        let missing_end = "---\nname: test\nBody without terminator";

        let result_no_frontmatter = parse_frontmatter(no_frontmatter).unwrap();
        let result_missing_end = parse_frontmatter(missing_end).unwrap();

        assert_eq!(result_no_frontmatter.body, "Just text\nsecond line");
        assert_eq!(
            result_missing_end.body,
            "---\nname: test\nBody without terminator"
        );
    }

    #[test]
    fn returns_empty_object_for_empty_or_comment_only_frontmatter() {
        let input = "---\n# just a comment\n---\nBody";
        let parsed = parse_frontmatter(input).unwrap();

        assert_eq!(parsed.frontmatter, empty_frontmatter_object());
    }

    #[test]
    fn strip_frontmatter_removes_frontmatter_and_trims_body() {
        let input = "---\nkey: value\n---\n\nBody\n";

        assert_eq!(strip_frontmatter(input).unwrap(), "Body");
    }

    #[test]
    fn strip_frontmatter_returns_body_when_no_frontmatter_present() {
        let input = "\n  No frontmatter body  \n";

        assert_eq!(
            strip_frontmatter(input).unwrap(),
            "\n  No frontmatter body  \n"
        );
    }
}
