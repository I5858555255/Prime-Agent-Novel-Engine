#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSkillBlock {
    pub name: String,
    pub location: String,
    pub content: String,
    pub user_message: Option<String>,
}

pub fn parse_skill_block(text: &str) -> Option<ParsedSkillBlock> {
    let rest = text.strip_prefix("<skill name=\"")?;
    let (name, rest) = rest.split_once("\" location=\"")?;
    if name.contains('"') {
        return None;
    }

    let (location, rest) = rest.split_once("\">\n")?;
    if location.contains('"') {
        return None;
    }

    let close_marker = "\n</skill>";
    for (close_index, _) in rest.match_indices(close_marker) {
        let after_close = &rest[close_index + close_marker.len()..];
        let user_message = if after_close.is_empty() {
            None
        } else if let Some(message) = after_close.strip_prefix("\n\n") {
            if message.is_empty() {
                continue;
            }
            let trimmed = message.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        } else {
            continue;
        };

        return Some(ParsedSkillBlock {
            name: name.to_string(),
            location: location.to_string(),
            content: rest[..close_index].to_string(),
            user_message,
        });
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_skill_block_without_user_message() {
        assert_eq!(
            parse_skill_block("<skill name=\"python\" location=\"builtin\">\nprint(1)\n</skill>"),
            Some(ParsedSkillBlock {
                name: "python".to_string(),
                location: "builtin".to_string(),
                content: "print(1)".to_string(),
                user_message: None,
            })
        );
    }

    #[test]
    fn parses_skill_block_with_trimmed_user_message() {
        assert_eq!(
            parse_skill_block(
                "<skill name=\"markdown\" location=\"/tmp/SKILL.md\">\nbody\n</skill>\n\n  run this  \n"
            ),
            Some(ParsedSkillBlock {
                name: "markdown".to_string(),
                location: "/tmp/SKILL.md".to_string(),
                content: "body".to_string(),
                user_message: Some("run this".to_string()),
            })
        );
    }

    #[test]
    fn supports_multiline_skill_content() {
        assert_eq!(
            parse_skill_block(
                "<skill name=\"s\" location=\"l\">\nline 1\nline 2\n</skill>\n\nmessage"
            )
            .map(|block| block.content),
            Some("line 1\nline 2".to_string())
        );
    }

    #[test]
    fn keeps_later_closing_tag_when_first_candidate_cannot_satisfy_anchor() {
        assert_eq!(
            parse_skill_block(
                "<skill name=\"s\" location=\"l\">\nfirst\n</skill>\nnot user\n</skill>\n\nmessage"
            )
            .map(|block| block.content),
            Some("first\n</skill>\nnot user".to_string())
        );
    }

    #[test]
    fn rejects_text_without_exact_skill_block_shape() {
        assert_eq!(
            parse_skill_block("prefix <skill name=\"s\" location=\"l\">\nx\n</skill>"),
            None
        );
        assert_eq!(
            parse_skill_block("<skill name=\"s\" location=\"l\">\nx\n</skill>\n\n"),
            None
        );
        assert_eq!(
            parse_skill_block("<skill name=\"s\" location=\"l\">\nx\n</skill>\ntrailing"),
            None
        );
    }

    #[test]
    fn whitespace_only_user_message_becomes_none_when_group_exists() {
        assert_eq!(
            parse_skill_block("<skill name=\"s\" location=\"l\">\nx\n</skill>\n\n  \n\t"),
            Some(ParsedSkillBlock {
                name: "s".to_string(),
                location: "l".to_string(),
                content: "x".to_string(),
                user_message: None,
            })
        );
    }
}
