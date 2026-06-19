use chrono::DateTime;
use prime_agent_ai::{ContentBlock, Message, UserContent, UserMessage};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const COMPACTION_SUMMARY_PREFIX: &str = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
pub const COMPACTION_SUMMARY_SUFFIX: &str = "\n</summary>";
pub const BRANCH_SUMMARY_PREFIX: &str =
    "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
pub const BRANCH_SUMMARY_SUFFIX: &str = "</summary>";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BashExecutionMessage {
    pub command: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub cancelled: bool,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_output_path: Option<String>,
    pub timestamp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclude_from_context: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomMessage {
    pub custom_type: String,
    pub content: UserContent,
    pub display: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    pub timestamp: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSummaryMessage {
    pub summary: String,
    pub from_id: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionSummaryMessage {
    pub summary: String,
    pub tokens_before: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_instructions: Option<String>,
    pub timestamp: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role")]
pub enum CodingAgentMessage {
    #[serde(rename = "user")]
    User(UserMessage),
    #[serde(rename = "assistant")]
    Assistant(prime_agent_ai::AssistantMessage),
    #[serde(rename = "toolResult")]
    ToolResult(prime_agent_ai::ToolResultMessage),
    #[serde(rename = "bashExecution")]
    BashExecution(BashExecutionMessage),
    #[serde(rename = "custom")]
    Custom(CustomMessage),
    #[serde(rename = "branchSummary")]
    BranchSummary(BranchSummaryMessage),
    #[serde(rename = "compactionSummary")]
    CompactionSummary(CompactionSummaryMessage),
}

pub fn bash_execution_to_text(message: &BashExecutionMessage) -> String {
    let mut text = format!("Ran `{}`\n", message.command);

    if message.output.is_empty() {
        text.push_str("(no output)");
    } else {
        text.push_str("```\n");
        text.push_str(&message.output);
        text.push_str("\n```");
    }

    if message.cancelled {
        text.push_str("\n\n(command cancelled)");
    } else if let Some(exit_code) = message.exit_code
        && exit_code != 0
    {
        text.push_str(&format!("\n\nCommand exited with code {exit_code}"));
    }

    if message.truncated
        && let Some(path) = &message.full_output_path
    {
        text.push_str(&format!("\n\n[Output truncated. Full output: {path}]"));
    }

    text
}

pub fn create_branch_summary_message(
    summary: impl Into<String>,
    from_id: impl Into<String>,
    timestamp: &str,
) -> Result<BranchSummaryMessage, chrono::ParseError> {
    Ok(BranchSummaryMessage {
        summary: summary.into(),
        from_id: from_id.into(),
        timestamp: timestamp_millis(timestamp)?,
    })
}

pub fn create_compaction_summary_message(
    summary: impl Into<String>,
    tokens_before: u64,
    timestamp: &str,
    custom_instructions: Option<String>,
) -> Result<CompactionSummaryMessage, chrono::ParseError> {
    Ok(CompactionSummaryMessage {
        summary: summary.into(),
        tokens_before,
        custom_instructions,
        timestamp: timestamp_millis(timestamp)?,
    })
}

pub fn create_custom_message(
    custom_type: impl Into<String>,
    content: impl Into<UserContent>,
    display: bool,
    details: Option<Value>,
    timestamp: &str,
) -> Result<CustomMessage, chrono::ParseError> {
    Ok(CustomMessage {
        custom_type: custom_type.into(),
        content: content.into(),
        display,
        details,
        timestamp: timestamp_millis(timestamp)?,
    })
}

pub fn convert_to_llm(messages: &[CodingAgentMessage]) -> Vec<Message> {
    messages
        .iter()
        .filter_map(|message| match message {
            CodingAgentMessage::BashExecution(message) => {
                if message.exclude_from_context.unwrap_or(false) {
                    return None;
                }

                Some(Message::User(UserMessage {
                    content: vec![ContentBlock::text(bash_execution_to_text(message))].into(),
                    timestamp: message.timestamp,
                }))
            }
            CodingAgentMessage::Custom(message) => Some(Message::User(UserMessage {
                content: message.content.clone(),
                timestamp: message.timestamp,
            })),
            CodingAgentMessage::BranchSummary(message) => Some(Message::User(UserMessage {
                content: vec![ContentBlock::text(format!(
                    "{BRANCH_SUMMARY_PREFIX}{}{BRANCH_SUMMARY_SUFFIX}",
                    message.summary
                ))]
                .into(),
                timestamp: message.timestamp,
            })),
            CodingAgentMessage::CompactionSummary(message) => Some(Message::User(UserMessage {
                content: vec![ContentBlock::text(format!(
                    "{COMPACTION_SUMMARY_PREFIX}{}{COMPACTION_SUMMARY_SUFFIX}",
                    message.summary
                ))]
                .into(),
                timestamp: message.timestamp,
            })),
            CodingAgentMessage::User(message) => Some(Message::User(message.clone())),
            CodingAgentMessage::Assistant(message) => Some(Message::Assistant(message.clone())),
            CodingAgentMessage::ToolResult(message) => Some(Message::ToolResult(message.clone())),
        })
        .collect()
}

fn timestamp_millis(timestamp: &str) -> Result<i64, chrono::ParseError> {
    Ok(DateTime::parse_from_rfc3339(timestamp)?.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;
    use prime_agent_ai::{StopReason, Usage};

    #[test]
    fn bash_execution_to_text_matches_typescript_format() {
        let message = BashExecutionMessage {
            command: "cargo test".to_string(),
            output: "ok".to_string(),
            exit_code: Some(2),
            cancelled: false,
            truncated: true,
            full_output_path: Some("/tmp/full.log".to_string()),
            timestamp: 1,
            exclude_from_context: None,
        };

        assert_eq!(
            bash_execution_to_text(&message),
            "Ran `cargo test`\n```\nok\n```\n\nCommand exited with code 2\n\n[Output truncated. Full output: /tmp/full.log]"
        );
    }

    #[test]
    fn bash_execution_without_output_uses_no_output_marker() {
        let message = BashExecutionMessage {
            command: "true".to_string(),
            output: String::new(),
            exit_code: Some(0),
            cancelled: false,
            truncated: false,
            full_output_path: None,
            timestamp: 1,
            exclude_from_context: None,
        };

        assert_eq!(bash_execution_to_text(&message), "Ran `true`\n(no output)");
    }

    #[test]
    fn convert_to_llm_skips_excluded_bash_execution() {
        let messages = vec![CodingAgentMessage::BashExecution(BashExecutionMessage {
            command: "secret".to_string(),
            output: "hidden".to_string(),
            exit_code: Some(0),
            cancelled: false,
            truncated: false,
            full_output_path: None,
            timestamp: 1,
            exclude_from_context: Some(true),
        })];

        assert!(convert_to_llm(&messages).is_empty());
    }

    #[test]
    fn convert_to_llm_wraps_branch_summary() {
        let message =
            create_branch_summary_message("fixed bug", "branch-1", "2026-06-18T20:00:00Z").unwrap();
        let converted = convert_to_llm(&[CodingAgentMessage::BranchSummary(message)]);

        assert_eq!(converted.len(), 1);
        let Message::User(user) = &converted[0] else {
            panic!("expected user message");
        };
        let UserContent::Blocks(blocks) = &user.content else {
            panic!("expected content blocks");
        };

        assert_eq!(
            blocks,
            &vec![ContentBlock::text(format!(
                "{BRANCH_SUMMARY_PREFIX}fixed bug{BRANCH_SUMMARY_SUFFIX}"
            ))]
        );
        assert_eq!(user.timestamp, 1_781_812_800_000);
    }

    #[test]
    fn convert_to_llm_passes_standard_messages_through() {
        let assistant = prime_agent_ai::AssistantMessage {
            content: vec![ContentBlock::text("done")],
            api: "openai-responses".to_string(),
            provider: "openai".to_string(),
            model: "gpt".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage::default(),
            stop_reason: StopReason::Stop,
            error_message: None,
            timestamp: 2,
        };
        let converted = convert_to_llm(&[CodingAgentMessage::Assistant(assistant.clone())]);

        assert_eq!(converted, vec![Message::Assistant(assistant)]);
    }
}
