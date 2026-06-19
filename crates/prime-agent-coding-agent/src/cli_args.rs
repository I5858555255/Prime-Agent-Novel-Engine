use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Text,
    Json,
    Rpc,
    Daemon,
}

impl Mode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Json => "json",
            Self::Rpc => "rpc",
            Self::Daemon => "daemon",
        }
    }
}

impl FromStr for Mode {
    type Err = ParseModeError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "text" => Ok(Self::Text),
            "json" => Ok(Self::Json),
            "rpc" => Ok(Self::Rpc),
            "daemon" => Ok(Self::Daemon),
            _ => Err(ParseModeError),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseModeError;

impl fmt::Display for ParseModeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invalid mode")
    }
}

impl std::error::Error for ParseModeError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CliThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
}

impl CliThinkingLevel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
        }
    }
}

impl FromStr for CliThinkingLevel {
    type Err = ParseThinkingLevelError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "off" => Ok(Self::Off),
            "minimal" => Ok(Self::Minimal),
            "low" => Ok(Self::Low),
            "medium" => Ok(Self::Medium),
            "high" => Ok(Self::High),
            "xhigh" => Ok(Self::Xhigh),
            _ => Err(ParseThinkingLevelError),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseThinkingLevelError;

impl fmt::Display for ParseThinkingLevelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invalid thinking level")
    }
}

impl std::error::Error for ParseThinkingLevelError {}

pub const VALID_THINKING_LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticType {
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliDiagnostic {
    #[serde(rename = "type")]
    pub kind: DiagnosticType,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UnknownFlagValue {
    Bool(bool),
    String(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ListModels {
    All(bool),
    Search(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Args {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub append_system_prompt: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<CliThinkingLevel>,
    #[serde(rename = "continue", skip_serializing_if = "Option::is_none")]
    pub continue_session: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<Mode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daemon_socket: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_session: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fork: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_builtin_tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_extensions: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub print: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub export: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_skills: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_templates: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_prompt_templates: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub themes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_themes: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_context_files: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list_models: Option<ListModels>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offline: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verbose: Option<bool>,
    pub messages: Vec<String>,
    pub file_args: Vec<String>,
    pub unknown_flags: BTreeMap<String, UnknownFlagValue>,
    pub diagnostics: Vec<CliDiagnostic>,
}

const REMOVED_BUILTIN_TOOL_NAMES: &[&str] = &["read", "write", "grep", "find", "ls"];
const BUILTIN_TOOL_NAMES: &[&str] = &["ipython", "bash", "edit"];

pub fn is_valid_thinking_level(level: &str) -> bool {
    CliThinkingLevel::from_str(level).is_ok()
}

pub fn parse_args<I, S>(args: I) -> Args
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let args = args.into_iter().map(Into::into).collect::<Vec<_>>();
    let mut result = Args::default();
    let mut index = 0;

    while index < args.len() {
        let arg = &args[index];

        match arg.as_str() {
            "--help" | "-h" => result.help = Some(true),
            "--version" | "-v" => result.version = Some(true),
            "--continue" | "-c" => result.continue_session = Some(true),
            "--resume" | "-r" => result.resume = Some(true),
            "--no-session" => result.no_session = Some(true),
            "--no-tools" | "-nt" => result.no_tools = Some(true),
            "--no-builtin-tools" | "-nbt" => result.no_builtin_tools = Some(true),
            "--print" | "-p" => {
                result.print = Some(true);
                if let Some(next) = args.get(index + 1)
                    && !next.starts_with('@')
                    && (!next.starts_with('-') || next.starts_with("---"))
                {
                    result.messages.push(next.clone());
                    index += 1;
                }
            }
            "--no-extensions" | "-ne" => result.no_extensions = Some(true),
            "--no-skills" | "-ns" => result.no_skills = Some(true),
            "--no-prompt-templates" | "-np" => result.no_prompt_templates = Some(true),
            "--no-themes" => result.no_themes = Some(true),
            "--no-context-files" | "-nc" => result.no_context_files = Some(true),
            "--verbose" => result.verbose = Some(true),
            "--offline" => result.offline = Some(true),
            "--mode" if has_value(&args, index) => {
                index += 1;
                if let Ok(mode) = Mode::from_str(&args[index]) {
                    result.mode = Some(mode);
                }
            }
            "--daemon-socket" if has_value(&args, index) => {
                index += 1;
                result.daemon_socket = Some(args[index].clone());
            }
            "--provider" if has_value(&args, index) => {
                index += 1;
                result.provider = Some(args[index].clone());
            }
            "--model" if has_value(&args, index) => {
                index += 1;
                result.model = Some(args[index].clone());
            }
            "--api-key" if has_value(&args, index) => {
                index += 1;
                result.api_key = Some(args[index].clone());
            }
            "--cwd" if has_value(&args, index) => {
                index += 1;
                result.cwd = Some(args[index].clone());
            }
            "--system-prompt" if has_value(&args, index) => {
                index += 1;
                result.system_prompt = Some(args[index].clone());
            }
            "--append-system-prompt" if has_value(&args, index) => {
                index += 1;
                result
                    .append_system_prompt
                    .get_or_insert_with(Vec::new)
                    .push(args[index].clone());
            }
            "--session" if has_value(&args, index) => {
                index += 1;
                result.session = Some(args[index].clone());
            }
            "--fork" if has_value(&args, index) => {
                index += 1;
                result.fork = Some(args[index].clone());
            }
            "--session-dir" if has_value(&args, index) => {
                index += 1;
                result.session_dir = Some(args[index].clone());
            }
            "--models" if has_value(&args, index) => {
                index += 1;
                result.models = Some(
                    args[index]
                        .split(',')
                        .map(|value| value.trim().to_string())
                        .collect(),
                );
            }
            "--tools" | "-t" if has_value(&args, index) => {
                index += 1;
                let tools = args[index]
                    .split(',')
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(ToString::to_string)
                    .collect::<Vec<_>>();
                push_removed_tool_diagnostic(&mut result, &tools);
                result.tools = Some(tools);
            }
            "--thinking" if has_value(&args, index) => {
                index += 1;
                match CliThinkingLevel::from_str(&args[index]) {
                    Ok(level) => result.thinking = Some(level),
                    Err(_) => result.diagnostics.push(CliDiagnostic {
                        kind: DiagnosticType::Warning,
                        message: format!(
                            "Invalid thinking level \"{}\". Valid values: {}",
                            args[index],
                            VALID_THINKING_LEVELS.join(", ")
                        ),
                    }),
                }
            }
            "--export" if has_value(&args, index) => {
                index += 1;
                result.export = Some(args[index].clone());
            }
            "--extension" | "-e" if has_value(&args, index) => {
                index += 1;
                result
                    .extensions
                    .get_or_insert_with(Vec::new)
                    .push(args[index].clone());
            }
            "--skill" if has_value(&args, index) => {
                index += 1;
                result
                    .skills
                    .get_or_insert_with(Vec::new)
                    .push(args[index].clone());
            }
            "--prompt-template" if has_value(&args, index) => {
                index += 1;
                result
                    .prompt_templates
                    .get_or_insert_with(Vec::new)
                    .push(args[index].clone());
            }
            "--theme" if has_value(&args, index) => {
                index += 1;
                result
                    .themes
                    .get_or_insert_with(Vec::new)
                    .push(args[index].clone());
            }
            "--list-models" => {
                if let Some(next) = args.get(index + 1)
                    && !next.starts_with('-')
                    && !next.starts_with('@')
                {
                    result.list_models = Some(ListModels::Search(next.clone()));
                    index += 1;
                } else {
                    result.list_models = Some(ListModels::All(true));
                }
            }
            _ if arg.starts_with('@') => {
                result.file_args.push(arg[1..].to_string());
            }
            _ if arg.starts_with("--") => {
                parse_unknown_long_flag(&args, &mut result, &mut index);
            }
            _ if arg.starts_with('-') => {
                result.diagnostics.push(CliDiagnostic {
                    kind: DiagnosticType::Error,
                    message: format!("Unknown option: {arg}"),
                });
            }
            _ => {
                result.messages.push(arg.clone());
            }
        }

        index += 1;
    }

    result
}

fn has_value(args: &[String], index: usize) -> bool {
    index + 1 < args.len()
}

fn parse_unknown_long_flag(args: &[String], result: &mut Args, index: &mut usize) {
    let arg = &args[*index];
    if let Some(eq_index) = arg.find('=') {
        result.unknown_flags.insert(
            arg[2..eq_index].to_string(),
            UnknownFlagValue::String(arg[eq_index + 1..].to_string()),
        );
        return;
    }

    let flag_name = arg[2..].to_string();
    if let Some(next) = args.get(*index + 1)
        && !next.starts_with('-')
        && !next.starts_with('@')
    {
        result
            .unknown_flags
            .insert(flag_name, UnknownFlagValue::String(next.clone()));
        *index += 1;
    } else {
        result
            .unknown_flags
            .insert(flag_name, UnknownFlagValue::Bool(true));
    }
}

fn push_removed_tool_diagnostic(result: &mut Args, tools: &[String]) {
    let removed_tools = tools
        .iter()
        .filter(|tool| REMOVED_BUILTIN_TOOL_NAMES.contains(&tool.as_str()))
        .cloned()
        .collect::<Vec<_>>();

    if removed_tools.is_empty() {
        return;
    }

    result.diagnostics.push(CliDiagnostic {
        kind: DiagnosticType::Error,
        message: format!(
            "Unknown built-in tool(s): {}. Available built-in tools: {}",
            removed_tools.join(", "),
            BUILTIN_TOOL_NAMES.join(", ")
        ),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_args_parses_core_options() {
        let result = parse_args([
            "--provider",
            "openai",
            "--model",
            "gpt-4o",
            "--api-key",
            "sk-test",
            "--cwd",
            "/repo",
            "--system-prompt",
            "system",
            "--append-system-prompt",
            "a",
            "--append-system-prompt",
            "b",
            "--daemon-socket",
            "/tmp/prime.sock",
            "--session",
            "session.jsonl",
            "--fork",
            "abcd",
            "--session-dir",
            "/sessions",
            "--export",
            "out.html",
        ]);

        assert_eq!(result.provider.as_deref(), Some("openai"));
        assert_eq!(result.model.as_deref(), Some("gpt-4o"));
        assert_eq!(result.api_key.as_deref(), Some("sk-test"));
        assert_eq!(result.cwd.as_deref(), Some("/repo"));
        assert_eq!(result.system_prompt.as_deref(), Some("system"));
        assert_eq!(
            result.append_system_prompt,
            Some(vec!["a".to_string(), "b".to_string()])
        );
        assert_eq!(result.daemon_socket.as_deref(), Some("/tmp/prime.sock"));
        assert_eq!(result.session.as_deref(), Some("session.jsonl"));
        assert_eq!(result.fork.as_deref(), Some("abcd"));
        assert_eq!(result.session_dir.as_deref(), Some("/sessions"));
        assert_eq!(result.export.as_deref(), Some("out.html"));
    }

    #[test]
    fn cli_args_parses_boolean_flags_and_shorthands() {
        let result = parse_args([
            "--help",
            "-v",
            "-c",
            "-r",
            "--no-session",
            "-nt",
            "-nbt",
            "-ne",
            "-ns",
            "-np",
            "--no-themes",
            "-nc",
            "--verbose",
            "--offline",
        ]);

        assert_eq!(result.help, Some(true));
        assert_eq!(result.version, Some(true));
        assert_eq!(result.continue_session, Some(true));
        assert_eq!(result.resume, Some(true));
        assert_eq!(result.no_session, Some(true));
        assert_eq!(result.no_tools, Some(true));
        assert_eq!(result.no_builtin_tools, Some(true));
        assert_eq!(result.no_extensions, Some(true));
        assert_eq!(result.no_skills, Some(true));
        assert_eq!(result.no_prompt_templates, Some(true));
        assert_eq!(result.no_themes, Some(true));
        assert_eq!(result.no_context_files, Some(true));
        assert_eq!(result.verbose, Some(true));
        assert_eq!(result.offline, Some(true));
    }

    #[test]
    fn cli_args_serializes_continue_with_typescript_field_name() {
        let result = parse_args(["--continue"]);
        let value = serde_json::to_value(result).unwrap();

        assert_eq!(value.get("continue"), Some(&serde_json::json!(true)));
        assert_eq!(value.get("continueSession"), None);
    }

    #[test]
    fn cli_args_parses_message_and_file_args() {
        let result = parse_args([
            "@README.md",
            "explain this",
            "@src/main.rs",
            "then summarize",
        ]);

        assert_eq!(result.file_args, vec!["README.md", "src/main.rs"]);
        assert_eq!(result.messages, vec!["explain this", "then summarize"]);
    }

    #[test]
    fn cli_args_print_consumes_prompt_but_not_options_or_file_args() {
        let frontmatter = "---\ntitle: hello\n---\nSay hi.";
        let result = parse_args(["-p", frontmatter, "--provider", "openai", "@file.txt"]);

        assert_eq!(result.print, Some(true));
        assert_eq!(result.messages, vec![frontmatter]);
        assert_eq!(result.provider.as_deref(), Some("openai"));
        assert_eq!(result.file_args, vec!["file.txt"]);
    }

    #[test]
    fn cli_args_invalid_thinking_level_emits_warning() {
        let result = parse_args(["--thinking", "extreme"]);

        assert_eq!(result.thinking, None);
        assert_eq!(
            result.diagnostics,
            vec![CliDiagnostic {
                kind: DiagnosticType::Warning,
                message:
                    "Invalid thinking level \"extreme\". Valid values: off, minimal, low, medium, high, xhigh"
                        .to_string(),
            }]
        );
    }

    #[test]
    fn cli_args_accepts_all_valid_thinking_levels_including_off() {
        for (raw, expected) in [
            ("off", CliThinkingLevel::Off),
            ("minimal", CliThinkingLevel::Minimal),
            ("low", CliThinkingLevel::Low),
            ("medium", CliThinkingLevel::Medium),
            ("high", CliThinkingLevel::High),
            ("xhigh", CliThinkingLevel::Xhigh),
        ] {
            let result = parse_args(["--thinking", raw]);
            assert_eq!(result.thinking, Some(expected));
        }
    }

    #[test]
    fn cli_args_parses_comma_separated_tools_and_models() {
        let result = parse_args([
            "--models",
            "gpt-4o, claude-sonnet,,gemini",
            "-t",
            "ipython, bash,,edit",
        ]);

        assert_eq!(
            result.models,
            Some(vec![
                "gpt-4o".to_string(),
                "claude-sonnet".to_string(),
                String::new(),
                "gemini".to_string(),
            ])
        );
        assert_eq!(
            result.tools,
            Some(vec![
                "ipython".to_string(),
                "bash".to_string(),
                "edit".to_string(),
            ])
        );
    }

    #[test]
    fn cli_args_removed_builtin_tools_emit_error_but_are_kept() {
        let result = parse_args(["--tools", "read,bash,grep"]);

        assert_eq!(
            result.tools,
            Some(vec![
                "read".to_string(),
                "bash".to_string(),
                "grep".to_string(),
            ])
        );
        assert_eq!(
            result.diagnostics,
            vec![CliDiagnostic {
                kind: DiagnosticType::Error,
                message:
                    "Unknown built-in tool(s): read, grep. Available built-in tools: ipython, bash, edit"
                        .to_string(),
            }]
        );
    }

    #[test]
    fn cli_args_mode_parsing_sets_only_valid_modes() {
        assert_eq!(parse_args(["--mode", "text"]).mode, Some(Mode::Text));
        assert_eq!(parse_args(["--mode", "json"]).mode, Some(Mode::Json));
        assert_eq!(parse_args(["--mode", "rpc"]).mode, Some(Mode::Rpc));
        assert_eq!(parse_args(["--mode", "daemon"]).mode, Some(Mode::Daemon));
        assert_eq!(parse_args(["--mode", "xml"]).mode, None);
    }

    #[test]
    fn cli_args_list_models_accepts_optional_search_pattern() {
        assert_eq!(
            parse_args(["--list-models"]).list_models,
            Some(ListModels::All(true))
        );
        assert_eq!(
            parse_args(["--list-models", "sonnet"]).list_models,
            Some(ListModels::Search("sonnet".to_string()))
        );
        assert_eq!(
            parse_args(["--list-models", "@file"]).list_models,
            Some(ListModels::All(true))
        );
    }

    #[test]
    fn cli_args_unknown_flags_match_extension_flag_behavior() {
        let result = parse_args([
            "--flag",
            "value",
            "--other=true",
            "--boolean",
            "--message",
            "@file",
            "-z",
        ]);

        assert_eq!(
            result.unknown_flags.get("flag"),
            Some(&UnknownFlagValue::String("value".to_string()))
        );
        assert_eq!(
            result.unknown_flags.get("other"),
            Some(&UnknownFlagValue::String("true".to_string()))
        );
        assert_eq!(
            result.unknown_flags.get("boolean"),
            Some(&UnknownFlagValue::Bool(true))
        );
        assert_eq!(
            result.unknown_flags.get("message"),
            Some(&UnknownFlagValue::Bool(true))
        );
        assert_eq!(result.file_args, vec!["file"]);
        assert_eq!(
            result.diagnostics,
            vec![CliDiagnostic {
                kind: DiagnosticType::Error,
                message: "Unknown option: -z".to_string(),
            }]
        );
    }
}
