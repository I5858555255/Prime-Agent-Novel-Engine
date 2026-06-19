#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedCliMessages {
    pub messages: Vec<String>,
}

#[derive(Debug)]
pub struct InitialMessageInput<'a> {
    pub parsed: &'a mut ParsedCliMessages,
    pub file_text: Option<&'a str>,
    pub stdin_content: Option<&'a str>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InitialMessageResult {
    pub initial_message: Option<String>,
}

/// Combine stdin content, @file text, and the first CLI message into a single
/// initial prompt for non-interactive mode.
///
/// The TypeScript implementation also passes through `ImageContent[]`. This
/// crate does not currently define `prime_agent_ai::ImageContent`, so the Rust
/// helper intentionally models only the text portion.
pub fn build_initial_message(input: InitialMessageInput<'_>) -> InitialMessageResult {
    let mut parts = Vec::new();

    if let Some(stdin_content) = input.stdin_content {
        parts.push(stdin_content.to_string());
    }

    if let Some(file_text) = input.file_text
        && !file_text.is_empty()
    {
        parts.push(file_text.to_string());
    }

    if !input.parsed.messages.is_empty() {
        parts.push(input.parsed.messages.remove(0));
    }

    InitialMessageResult {
        initial_message: if parts.is_empty() {
            None
        } else {
            Some(parts.join(""))
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_message_concatenates_stdin_file_and_first_cli_message() {
        let mut parsed = ParsedCliMessages {
            messages: vec!["prompt".to_string(), "next".to_string()],
        };

        let result = build_initial_message(InitialMessageInput {
            parsed: &mut parsed,
            stdin_content: Some("stdin\n"),
            file_text: Some("file\n"),
        });

        assert_eq!(
            result,
            InitialMessageResult {
                initial_message: Some("stdin\nfile\nprompt".to_string()),
            }
        );
        assert_eq!(parsed.messages, vec!["next".to_string()]);
    }

    #[test]
    fn initial_message_shifts_only_the_first_cli_message() {
        let mut parsed = ParsedCliMessages {
            messages: vec![
                "first".to_string(),
                "second".to_string(),
                "third".to_string(),
            ],
        };

        let result = build_initial_message(InitialMessageInput {
            parsed: &mut parsed,
            stdin_content: None,
            file_text: None,
        });

        assert_eq!(result.initial_message, Some("first".to_string()));
        assert_eq!(
            parsed.messages,
            vec!["second".to_string(), "third".to_string()]
        );
    }

    #[test]
    fn initial_message_keeps_defined_empty_stdin_content() {
        let mut parsed = ParsedCliMessages::default();

        let result = build_initial_message(InitialMessageInput {
            parsed: &mut parsed,
            stdin_content: Some(""),
            file_text: Some(""),
        });

        assert_eq!(result.initial_message, Some(String::new()));
        assert!(parsed.messages.is_empty());
    }

    #[test]
    fn initial_message_returns_none_without_parts() {
        let mut parsed = ParsedCliMessages::default();

        let result = build_initial_message(InitialMessageInput {
            parsed: &mut parsed,
            stdin_content: None,
            file_text: Some(""),
        });

        assert_eq!(result.initial_message, None);
    }
}
