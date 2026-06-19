#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuiltinSlashCommand {
    pub name: &'static str,
    pub description: &'static str,
    pub argument_hint: Option<&'static str>,
    pub aliases: &'static [&'static str],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSlashCommand {
    pub name: String,
    pub args: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSlashCommand {
    pub name: String,
    pub args: String,
    pub original_name: String,
    pub is_alias: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BuiltinSlashCommandAlias {
    name: &'static str,
    alias_for: &'static str,
}

const EMPTY_ALIASES: &[&str] = &[];
const CLEAR_ALIAS: &[&str] = &["clear"];
const USAGE_ALIAS: &[&str] = &["usage"];

const BUILTIN_SLASH_COMMAND_ALIASES: &[BuiltinSlashCommandAlias] = &[
    BuiltinSlashCommandAlias {
        name: "clear",
        alias_for: "new",
    },
    BuiltinSlashCommandAlias {
        name: "usage",
        alias_for: "context",
    },
];

const BUILTIN_SLASH_COMMANDS: &[BuiltinSlashCommand] = &[
    BuiltinSlashCommand {
        name: "settings",
        description: "Open settings menu",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "model",
        description: "Select model (opens selector UI)",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "scoped-models",
        description: "Enable/disable models for Ctrl+P cycling",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "export",
        description: "Export session (HTML default, or specify path: .html/.jsonl)",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "import",
        description: "Import and resume a session from a JSONL file",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "share",
        description: "Share session as a secret GitHub gist",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "copy",
        description: "Copy last agent message to clipboard",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "name",
        description: "Set session display name",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "session",
        description: "Show session info",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "logs",
        description: "Show where daemon and client logs are saved",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "traces",
        description: "Opt in or out of Prime Agent trace sharing",
        argument_hint: Some("[status|on|off|upload|login]"),
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "context",
        description: "Show token, cost, and context usage for agent and sub-agents",
        argument_hint: None,
        aliases: USAGE_ALIAS,
    },
    BuiltinSlashCommand {
        name: "changelog",
        description: "Show changelog entries",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "hotkeys",
        description: "Show all keyboard shortcuts",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "fork",
        description: "Create a new fork from a previous user message",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "clone",
        description: "Duplicate the current session at the current position",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "tree",
        description: "Navigate session tree (switch branches)",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "login",
        description: "Configure provider authentication",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "logout",
        description: "Remove provider authentication",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "new",
        description: "Start a new session",
        argument_hint: None,
        aliases: CLEAR_ALIAS,
    },
    BuiltinSlashCommand {
        name: "compact",
        description: "Compact the session context; optional instructions focus the summary",
        argument_hint: Some("[instructions]"),
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "refine",
        description: "Refine editable harness prompt notes, skills, subagents, and memory",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "goal",
        description: "Set or view a persistent goal; supports pause, resume, and clear",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "heartbeat",
        description: "Set or view a persistent heartbeat; supports pause, resume, and clear",
        argument_hint: Some("[--every <interval>] <instruction>"),
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "resume",
        description: "Resume a different session",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "reload",
        description: "Reload keybindings, extensions, skills, prompts, and themes",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
    BuiltinSlashCommand {
        name: "quit",
        description: "Quit prime-agent",
        argument_hint: None,
        aliases: EMPTY_ALIASES,
    },
];

pub fn builtin_slash_commands() -> &'static [BuiltinSlashCommand] {
    BUILTIN_SLASH_COMMANDS
}

pub fn parse_slash_command(text: &str) -> Option<ParsedSlashCommand> {
    if !text.starts_with('/') {
        return None;
    }

    let space_index = text.find(' ');
    let name = match space_index {
        Some(index) => &text[1..index],
        None => &text[1..],
    };

    if name.is_empty() {
        return None;
    }

    let args = match space_index {
        Some(index) => text[index + 1..].trim(),
        None => "",
    };

    Some(ParsedSlashCommand {
        name: name.to_owned(),
        args: args.to_owned(),
    })
}

pub fn resolve_builtin_slash_command_name(name: &str) -> &str {
    BUILTIN_SLASH_COMMAND_ALIASES
        .iter()
        .find(|alias| alias.name == name)
        .map_or(name, |alias| alias.alias_for)
}

pub fn is_builtin_slash_command_name(name: &str) -> bool {
    BUILTIN_SLASH_COMMANDS
        .iter()
        .any(|command| command.name == name)
        || BUILTIN_SLASH_COMMAND_ALIASES
            .iter()
            .any(|alias| alias.name == name)
}

pub fn resolve_slash_command(command: ParsedSlashCommand) -> ResolvedSlashCommand {
    let original_name = command.name;
    let name = resolve_builtin_slash_command_name(&original_name).to_owned();
    let is_alias = name != original_name;

    ResolvedSlashCommand {
        name,
        args: command.args,
        original_name,
        is_alias,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_canonical_builtin_commands() {
        let command_names: Vec<_> = builtin_slash_commands()
            .iter()
            .map(|command| command.name)
            .collect();

        assert_eq!(
            command_names,
            vec![
                "settings",
                "model",
                "scoped-models",
                "export",
                "import",
                "share",
                "copy",
                "name",
                "session",
                "logs",
                "traces",
                "context",
                "changelog",
                "hotkeys",
                "fork",
                "clone",
                "tree",
                "login",
                "logout",
                "new",
                "compact",
                "refine",
                "goal",
                "heartbeat",
                "resume",
                "reload",
                "quit",
            ]
        );
        assert!(command_names.contains(&"heartbeat"));
        assert!(!command_names.contains(&"cron"));
    }

    #[test]
    fn keeps_aliases_hidden_on_canonical_command_entries() {
        assert!(
            builtin_slash_commands()
                .iter()
                .find(|command| command.name == "clear")
                .is_none()
        );
        assert!(
            builtin_slash_commands()
                .iter()
                .find(|command| command.name == "usage")
                .is_none()
        );

        assert_eq!(
            builtin_slash_commands()
                .iter()
                .find(|command| command.name == "new"),
            Some(&BuiltinSlashCommand {
                name: "new",
                description: "Start a new session",
                argument_hint: None,
                aliases: CLEAR_ALIAS,
            })
        );
        assert_eq!(
            builtin_slash_commands()
                .iter()
                .find(|command| command.name == "context"),
            Some(&BuiltinSlashCommand {
                name: "context",
                description: "Show token, cost, and context usage for agent and sub-agents",
                argument_hint: None,
                aliases: USAGE_ALIAS,
            })
        );
    }

    #[test]
    fn parses_slash_commands() {
        assert_eq!(
            parse_slash_command("/login"),
            Some(ParsedSlashCommand {
                name: "login".to_owned(),
                args: String::new(),
            })
        );
        assert_eq!(
            parse_slash_command("/model opus anthropic"),
            Some(ParsedSlashCommand {
                name: "model".to_owned(),
                args: "opus anthropic".to_owned(),
            })
        );
        assert_eq!(
            parse_slash_command("/compact  focus on the bug "),
            Some(ParsedSlashCommand {
                name: "compact".to_owned(),
                args: "focus on the bug".to_owned(),
            })
        );
        assert_eq!(parse_slash_command("fix the bug"), None);
        assert_eq!(parse_slash_command(""), None);
        assert_eq!(parse_slash_command("/"), None);
        assert_eq!(parse_slash_command("/ leading space"), None);
    }

    #[test]
    fn recognizes_builtin_names_and_hidden_aliases() {
        assert!(is_builtin_slash_command_name("new"));
        assert!(is_builtin_slash_command_name("clear"));
        assert!(is_builtin_slash_command_name("context"));
        assert!(is_builtin_slash_command_name("usage"));
        assert!(!is_builtin_slash_command_name("cron"));
        assert!(!is_builtin_slash_command_name("unknown"));
    }

    #[test]
    fn resolves_builtin_slash_command_names() {
        assert_eq!(resolve_builtin_slash_command_name("clear"), "new");
        assert_eq!(resolve_builtin_slash_command_name("usage"), "context");
        assert_eq!(resolve_builtin_slash_command_name("new"), "new");
        assert_eq!(resolve_builtin_slash_command_name("unknown"), "unknown");
    }

    #[test]
    fn resolves_clear_to_new_through_the_alias_path() {
        let parsed = parse_slash_command("/clear").unwrap();

        assert_eq!(
            parsed,
            ParsedSlashCommand {
                name: "clear".to_owned(),
                args: String::new(),
            }
        );
        assert!(is_builtin_slash_command_name("clear"));
        assert_eq!(resolve_builtin_slash_command_name("clear"), "new");
        assert_eq!(
            resolve_slash_command(parsed),
            ResolvedSlashCommand {
                name: "new".to_owned(),
                args: String::new(),
                original_name: "clear".to_owned(),
                is_alias: true,
            }
        );
    }

    #[test]
    fn preserves_arguments_when_resolving_aliases() {
        let parsed = parse_slash_command("/usage latest turn").unwrap();

        assert_eq!(
            resolve_slash_command(parsed),
            ResolvedSlashCommand {
                name: "context".to_owned(),
                args: "latest turn".to_owned(),
                original_name: "usage".to_owned(),
                is_alias: true,
            }
        );
    }

    #[test]
    fn preserves_original_name_when_resolving_non_aliases() {
        let parsed = parse_slash_command("/compact summarize this").unwrap();

        assert_eq!(
            resolve_slash_command(parsed),
            ResolvedSlashCommand {
                name: "compact".to_owned(),
                args: "summarize this".to_owned(),
                original_name: "compact".to_owned(),
                is_alias: false,
            }
        );
    }

    #[test]
    fn builtin_aliases_target_existing_canonical_commands() {
        for alias in BUILTIN_SLASH_COMMAND_ALIASES {
            assert!(
                builtin_slash_commands()
                    .iter()
                    .any(|command| command.name == alias.alias_for),
                "alias /{} targets unknown command /{}",
                alias.name,
                alias.alias_for
            );
        }
    }
}
