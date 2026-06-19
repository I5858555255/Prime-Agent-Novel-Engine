use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::fuzzy::fuzzy_filter;
use crate::keybindings::get_keybindings;

const PATH_DELIMITERS: [char; 5] = [' ', '\t', '"', '\'', '='];

pub type ArgumentCompletionFn =
    Arc<dyn Fn(&str) -> Option<Vec<AutocompleteItem>> + Send + Sync + 'static>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutocompleteItem {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
}

impl AutocompleteItem {
    pub fn new(value: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            label: label.into(),
            description: None,
        }
    }

    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }
}

#[derive(Clone)]
pub struct SlashCommand {
    pub name: String,
    pub aliases: Vec<String>,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    argument_completions: Option<ArgumentCompletionFn>,
}

impl std::fmt::Debug for SlashCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SlashCommand")
            .field("name", &self.name)
            .field("aliases", &self.aliases)
            .field("description", &self.description)
            .field("argument_hint", &self.argument_hint)
            .field("argument_completions", &self.argument_completions.is_some())
            .finish()
    }
}

impl SlashCommand {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            aliases: Vec::new(),
            description: None,
            argument_hint: None,
            argument_completions: None,
        }
    }

    pub fn with_aliases<I, S>(mut self, aliases: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.aliases = aliases.into_iter().map(Into::into).collect();
        self
    }

    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn with_argument_hint(mut self, argument_hint: impl Into<String>) -> Self {
        self.argument_hint = Some(argument_hint.into());
        self
    }

    pub fn with_argument_completions<F>(mut self, completions: F) -> Self
    where
        F: Fn(&str) -> Option<Vec<AutocompleteItem>> + Send + Sync + 'static,
    {
        self.argument_completions = Some(Arc::new(completions));
        self
    }
}

#[derive(Clone)]
pub enum AutocompleteCommand {
    Slash(SlashCommand),
    Item(AutocompleteItem),
}

impl std::fmt::Debug for AutocompleteCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Slash(command) => command.fmt(f),
            Self::Item(item) => item.fmt(f),
        }
    }
}

impl AutocompleteCommand {
    fn name(&self) -> &str {
        match self {
            Self::Slash(command) => &command.name,
            Self::Item(item) => &item.value,
        }
    }

    fn label(&self) -> &str {
        match self {
            Self::Slash(command) => &command.name,
            Self::Item(item) => &item.label,
        }
    }

    fn aliases(&self) -> &[String] {
        match self {
            Self::Slash(command) => &command.aliases,
            Self::Item(_) => &[],
        }
    }

    fn description(&self) -> Option<String> {
        match self {
            Self::Slash(command) => match (&command.argument_hint, &command.description) {
                (Some(hint), Some(description)) => Some(format!("{hint} - {description}")),
                (Some(hint), None) => Some(hint.clone()),
                (None, Some(description)) => Some(description.clone()),
                (None, None) => None,
            },
            Self::Item(item) => item.description.clone(),
        }
    }

    fn argument_completions(&self, argument_prefix: &str) -> Option<Vec<AutocompleteItem>> {
        match self {
            Self::Slash(command) => command
                .argument_completions
                .as_ref()
                .and_then(|completion| completion(argument_prefix)),
            Self::Item(_) => None,
        }
    }
}

impl From<SlashCommand> for AutocompleteCommand {
    fn from(value: SlashCommand) -> Self {
        Self::Slash(value)
    }
}

impl From<AutocompleteItem> for AutocompleteCommand {
    fn from(value: AutocompleteItem) -> Self {
        Self::Item(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutocompleteSuggestions {
    pub items: Vec<AutocompleteItem>,
    pub prefix: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionEdit {
    pub lines: Vec<String>,
    pub cursor_line: usize,
    pub cursor_col: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AutocompleteOptions {
    pub force: bool,
}

pub trait AutocompleteProvider {
    fn get_suggestions(
        &self,
        lines: &[String],
        cursor_line: usize,
        cursor_col: usize,
        options: AutocompleteOptions,
    ) -> Option<AutocompleteSuggestions>;

    fn apply_completion(
        &self,
        lines: &[String],
        cursor_line: usize,
        cursor_col: usize,
        item: &AutocompleteItem,
        prefix: &str,
    ) -> CompletionEdit {
        apply_completion(lines, cursor_line, cursor_col, item, prefix)
    }

    fn should_trigger_file_completion(
        &self,
        lines: &[String],
        cursor_line: usize,
        cursor_col: usize,
    ) -> bool {
        should_trigger_file_completion(lines, cursor_line, cursor_col)
    }
}

#[derive(Debug, Clone)]
pub struct CombinedAutocompleteProvider {
    commands: Vec<AutocompleteCommand>,
    base_path: PathBuf,
}

impl CombinedAutocompleteProvider {
    pub fn new(base_path: impl Into<PathBuf>) -> Self {
        Self {
            commands: Vec::new(),
            base_path: base_path.into(),
        }
    }

    pub fn with_commands<I, C>(commands: I, base_path: impl Into<PathBuf>) -> Self
    where
        I: IntoIterator<Item = C>,
        C: Into<AutocompleteCommand>,
    {
        Self {
            commands: commands.into_iter().map(Into::into).collect(),
            base_path: base_path.into(),
        }
    }

    pub fn commands(&self) -> &[AutocompleteCommand] {
        &self.commands
    }

    pub fn base_path(&self) -> &Path {
        &self.base_path
    }

    pub fn set_commands<I, C>(&mut self, commands: I)
    where
        I: IntoIterator<Item = C>,
        C: Into<AutocompleteCommand>,
    {
        self.commands = commands.into_iter().map(Into::into).collect();
    }

    pub fn set_base_path(&mut self, base_path: impl Into<PathBuf>) {
        self.base_path = base_path.into();
    }

    fn command_suggestions(&self, prefix: &str) -> Option<AutocompleteSuggestions> {
        #[derive(Clone)]
        struct CommandCandidate {
            name: String,
            search_text: String,
            label: String,
            description: Option<String>,
        }

        let candidates = self
            .commands
            .iter()
            .map(|command| {
                let mut search_parts = Vec::with_capacity(command.aliases().len() + 1);
                search_parts.push(command.name().to_string());
                search_parts.extend(command.aliases().iter().cloned());
                CommandCandidate {
                    name: command.name().to_string(),
                    search_text: search_parts.join(" "),
                    label: command.label().to_string(),
                    description: command.description(),
                }
            })
            .collect::<Vec<_>>();

        let items = fuzzy_filter(&candidates, prefix, |item| item.search_text.clone())
            .into_iter()
            .map(|item| AutocompleteItem {
                value: item.name,
                label: item.label,
                description: item.description,
            })
            .collect::<Vec<_>>();

        (!items.is_empty()).then(|| AutocompleteSuggestions {
            items,
            prefix: format!("/{prefix}"),
        })
    }

    fn argument_suggestions(
        &self,
        command_name: &str,
        argument_prefix: &str,
    ) -> Option<AutocompleteSuggestions> {
        let command = self
            .commands
            .iter()
            .find(|command| command.name() == command_name)?;
        let items = command.argument_completions(argument_prefix)?;
        (!items.is_empty()).then(|| AutocompleteSuggestions {
            items,
            prefix: argument_prefix.to_string(),
        })
    }

    fn get_file_suggestions(&self, prefix: &str) -> Vec<AutocompleteItem> {
        let parsed = parse_path_prefix(prefix);
        let mut expanded_prefix = parsed.raw_prefix.clone();
        if expanded_prefix.starts_with('~') {
            expanded_prefix = expand_home_path(&expanded_prefix);
        }

        let is_root_prefix = parsed.raw_prefix.is_empty()
            || parsed.raw_prefix == "./"
            || parsed.raw_prefix == "../"
            || parsed.raw_prefix == "~"
            || parsed.raw_prefix == "~/"
            || parsed.raw_prefix == "/"
            || (parsed.is_at_prefix && parsed.raw_prefix.is_empty());

        let (search_dir, search_prefix) = if is_root_prefix || parsed.raw_prefix.ends_with('/') {
            let search_dir = if parsed.raw_prefix.starts_with('~')
                || Path::new(&expanded_prefix).is_absolute()
            {
                PathBuf::from(&expanded_prefix)
            } else {
                self.base_path.join(&expanded_prefix)
            };
            (search_dir, String::new())
        } else {
            let dir = display_dirname(&expanded_prefix);
            let file = display_basename(&expanded_prefix);
            let search_dir = if parsed.raw_prefix.starts_with('~')
                || Path::new(&expanded_prefix).is_absolute()
            {
                PathBuf::from(dir)
            } else {
                self.base_path.join(dir)
            };
            (search_dir, file)
        };

        let Ok(entries) = fs::read_dir(search_dir) else {
            return Vec::new();
        };

        let search_prefix_lower = search_prefix.to_lowercase();
        let mut suggestions = Vec::new();

        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if !name.to_lowercase().starts_with(&search_prefix_lower) {
                continue;
            }

            let is_directory = entry
                .file_type()
                .map(|file_type| {
                    file_type.is_dir()
                        || (file_type.is_symlink()
                            && entry
                                .metadata()
                                .map(|metadata| metadata.is_dir())
                                .unwrap_or(false))
                })
                .unwrap_or(false);

            let relative_path = completion_relative_path(&parsed.raw_prefix, &name);
            let path_value = if is_directory {
                format!("{relative_path}/")
            } else {
                relative_path
            };
            let value = build_completion_value(
                &to_display_path(&path_value),
                BuildCompletionOptions {
                    is_at_prefix: parsed.is_at_prefix,
                    is_quoted_prefix: parsed.is_quoted_prefix,
                },
            );
            let label = if is_directory {
                format!("{name}/")
            } else {
                name
            };
            suggestions.push(AutocompleteItem::new(value, label));
        }

        suggestions.sort_by(|a, b| {
            let a_is_dir = a.label.ends_with('/');
            let b_is_dir = b.label.ends_with('/');
            match (a_is_dir, b_is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.label.cmp(&b.label),
            }
        });

        suggestions
    }
}

impl AutocompleteProvider for CombinedAutocompleteProvider {
    fn get_suggestions(
        &self,
        lines: &[String],
        cursor_line: usize,
        cursor_col: usize,
        options: AutocompleteOptions,
    ) -> Option<AutocompleteSuggestions> {
        let current_line = lines.get(cursor_line).map(String::as_str).unwrap_or("");
        let cursor_col = floor_char_boundary(current_line, cursor_col.min(current_line.len()));
        let text_before_cursor = &current_line[..cursor_col];

        if let Some(at_prefix) = extract_at_prefix(text_before_cursor) {
            let suggestions = self.get_file_suggestions(&at_prefix);
            return (!suggestions.is_empty()).then_some(AutocompleteSuggestions {
                items: suggestions,
                prefix: at_prefix,
            });
        }

        if !options.force && text_before_cursor.starts_with('/') {
            if let Some(space_index) = text_before_cursor.find(' ') {
                let command_name = &text_before_cursor[1..space_index];
                let argument_text = &text_before_cursor[space_index + 1..];
                return self.argument_suggestions(command_name, argument_text);
            }

            return self.command_suggestions(&text_before_cursor[1..]);
        }

        let path_match = extract_path_prefix(text_before_cursor, options.force)?;
        let suggestions = self.get_file_suggestions(&path_match);
        (!suggestions.is_empty()).then_some(AutocompleteSuggestions {
            items: suggestions,
            prefix: path_match,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutocompleteInputEvent {
    Handled,
    Accepted(AutocompleteItem),
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutocompleteState {
    suggestions: Option<AutocompleteSuggestions>,
    selected_index: usize,
    max_visible: usize,
}

impl Default for AutocompleteState {
    fn default() -> Self {
        Self::new(8)
    }
}

impl AutocompleteState {
    pub fn new(max_visible: usize) -> Self {
        Self {
            suggestions: None,
            selected_index: 0,
            max_visible,
        }
    }

    pub fn is_active(&self) -> bool {
        self.suggestions
            .as_ref()
            .is_some_and(|suggestions| !suggestions.items.is_empty())
    }

    pub fn suggestions(&self) -> Option<&AutocompleteSuggestions> {
        self.suggestions.as_ref()
    }

    pub fn selected_index(&self) -> usize {
        self.selected_index
    }

    pub fn max_visible(&self) -> usize {
        self.max_visible
    }

    pub fn set_max_visible(&mut self, max_visible: usize) {
        self.max_visible = max_visible;
        self.clamp_selection();
    }

    pub fn set_suggestions(&mut self, suggestions: Option<AutocompleteSuggestions>) {
        self.suggestions = suggestions.filter(|suggestions| !suggestions.items.is_empty());
        self.selected_index = 0;
    }

    pub fn clear(&mut self) {
        self.suggestions = None;
        self.selected_index = 0;
    }

    pub fn selected_item(&self) -> Option<&AutocompleteItem> {
        self.suggestions
            .as_ref()
            .and_then(|suggestions| suggestions.items.get(self.selected_index))
    }

    pub fn visible_items(&self) -> &[AutocompleteItem] {
        let Some(suggestions) = &self.suggestions else {
            return &[];
        };
        let start = self.visible_start_index();
        let end = start
            .saturating_add(self.max_visible)
            .min(suggestions.items.len());
        &suggestions.items[start..end]
    }

    pub fn select_next(&mut self) {
        let Some(len) = self.item_count() else {
            return;
        };
        self.selected_index = if self.selected_index + 1 >= len {
            0
        } else {
            self.selected_index + 1
        };
    }

    pub fn select_previous(&mut self) {
        let Some(len) = self.item_count() else {
            return;
        };
        self.selected_index = if self.selected_index == 0 {
            len - 1
        } else {
            self.selected_index - 1
        };
    }

    pub fn page_next(&mut self) {
        let Some(len) = self.item_count() else {
            return;
        };
        let step = self.max_visible.max(1);
        self.selected_index = self
            .selected_index
            .saturating_add(step)
            .min(len.saturating_sub(1));
    }

    pub fn page_previous(&mut self) {
        let Some(_) = self.item_count() else {
            return;
        };
        let step = self.max_visible.max(1);
        self.selected_index = self.selected_index.saturating_sub(step);
    }

    pub fn handle_input(&mut self, key_data: &str) -> Option<AutocompleteInputEvent> {
        if !self.is_active() {
            return None;
        }

        let (is_up, is_down, is_page_up, is_page_down, is_confirm, is_tab, is_cancel) = {
            let keybindings = get_keybindings();
            (
                keybindings.matches(key_data, "tui.select.up"),
                keybindings.matches(key_data, "tui.select.down"),
                keybindings.matches(key_data, "tui.select.pageUp"),
                keybindings.matches(key_data, "tui.select.pageDown"),
                keybindings.matches(key_data, "tui.select.confirm"),
                keybindings.matches(key_data, "tui.input.tab"),
                keybindings.matches(key_data, "tui.select.cancel"),
            )
        };

        if is_up {
            self.select_previous();
            return Some(AutocompleteInputEvent::Handled);
        }
        if is_down {
            self.select_next();
            return Some(AutocompleteInputEvent::Handled);
        }
        if is_page_up {
            self.page_previous();
            return Some(AutocompleteInputEvent::Handled);
        }
        if is_page_down {
            self.page_next();
            return Some(AutocompleteInputEvent::Handled);
        }
        if is_confirm || is_tab {
            let selected = self.selected_item().cloned();
            self.clear();
            return selected.map(AutocompleteInputEvent::Accepted);
        }
        if is_cancel {
            self.clear();
            return Some(AutocompleteInputEvent::Cancelled);
        }

        None
    }

    fn item_count(&self) -> Option<usize> {
        self.suggestions
            .as_ref()
            .map(|suggestions| suggestions.items.len())
            .filter(|len| *len > 0)
    }

    fn clamp_selection(&mut self) {
        if let Some(len) = self.item_count() {
            self.selected_index = self.selected_index.min(len - 1);
        } else {
            self.selected_index = 0;
        }
    }

    fn visible_start_index(&self) -> usize {
        let Some(len) = self.item_count() else {
            return 0;
        };
        if self.max_visible == 0 || len <= self.max_visible {
            return 0;
        }
        if self.selected_index < self.max_visible {
            0
        } else {
            self.selected_index + 1 - self.max_visible
        }
    }
}

pub fn apply_completion(
    lines: &[String],
    cursor_line: usize,
    cursor_col: usize,
    item: &AutocompleteItem,
    prefix: &str,
) -> CompletionEdit {
    let current_line = lines.get(cursor_line).map(String::as_str).unwrap_or("");
    let cursor_col = floor_char_boundary(current_line, cursor_col.min(current_line.len()));
    let prefix_start = floor_char_boundary(current_line, cursor_col.saturating_sub(prefix.len()));
    let before_prefix = &current_line[..prefix_start];
    let after_cursor = &current_line[cursor_col..];
    let is_quoted_prefix = prefix.starts_with('"') || prefix.starts_with("@\"");
    let adjusted_after_cursor =
        if is_quoted_prefix && item.value.ends_with('"') && after_cursor.starts_with('"') {
            &after_cursor[1..]
        } else {
            after_cursor
        };

    let mut new_lines = lines.to_vec();
    if new_lines.len() <= cursor_line {
        new_lines.resize(cursor_line + 1, String::new());
    }

    let is_slash_command =
        prefix.starts_with('/') && before_prefix.trim().is_empty() && !prefix[1..].contains('/');
    if is_slash_command {
        let new_line = format!("{before_prefix}/{} {adjusted_after_cursor}", item.value);
        let cursor_col = before_prefix.len() + item.value.len() + 2;
        new_lines[cursor_line] = new_line;
        return CompletionEdit {
            lines: new_lines,
            cursor_line,
            cursor_col,
        };
    }

    if prefix.starts_with('@') {
        let is_directory = item.label.ends_with('/');
        let suffix = if is_directory { "" } else { " " };
        let new_line = format!(
            "{before_prefix}{}{suffix}{adjusted_after_cursor}",
            item.value
        );
        let cursor_offset = if is_directory && item.value.ends_with('"') {
            item.value.len().saturating_sub(1)
        } else {
            item.value.len()
        };
        new_lines[cursor_line] = new_line;
        return CompletionEdit {
            lines: new_lines,
            cursor_line,
            cursor_col: before_prefix.len() + cursor_offset + suffix.len(),
        };
    }

    let text_before_cursor = &current_line[..cursor_col];
    let new_line = format!("{before_prefix}{}{adjusted_after_cursor}", item.value);
    let is_directory = item.label.ends_with('/');
    let cursor_offset = if is_directory && item.value.ends_with('"') {
        item.value.len().saturating_sub(1)
    } else {
        item.value.len()
    };
    new_lines[cursor_line] = new_line;

    let _is_command_argument = text_before_cursor.contains('/') && text_before_cursor.contains(' ');
    CompletionEdit {
        lines: new_lines,
        cursor_line,
        cursor_col: before_prefix.len() + cursor_offset,
    }
}

pub fn should_trigger_file_completion(
    lines: &[String],
    cursor_line: usize,
    cursor_col: usize,
) -> bool {
    let current_line = lines.get(cursor_line).map(String::as_str).unwrap_or("");
    let cursor_col = floor_char_boundary(current_line, cursor_col.min(current_line.len()));
    let text_before_cursor = current_line[..cursor_col].trim();
    !text_before_cursor.starts_with('/') || text_before_cursor.contains(' ')
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedPathPrefix {
    raw_prefix: String,
    is_at_prefix: bool,
    is_quoted_prefix: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BuildCompletionOptions {
    is_at_prefix: bool,
    is_quoted_prefix: bool,
}

fn to_display_path(value: &str) -> String {
    value.replace('\\', "/")
}

fn find_last_delimiter(text: &str) -> Option<usize> {
    text.char_indices()
        .rev()
        .find(|(_, ch)| PATH_DELIMITERS.contains(ch))
        .map(|(index, _)| index)
}

fn find_unclosed_quote_start(text: &str) -> Option<usize> {
    let mut in_quotes = false;
    let mut quote_start = None;

    for (index, ch) in text.char_indices() {
        if ch == '"' {
            in_quotes = !in_quotes;
            if in_quotes {
                quote_start = Some(index);
            }
        }
    }

    in_quotes.then_some(quote_start).flatten()
}

fn is_token_start(text: &str, index: usize) -> bool {
    if index == 0 {
        return true;
    }
    text[..index]
        .chars()
        .next_back()
        .is_some_and(|ch| PATH_DELIMITERS.contains(&ch))
}

fn extract_quoted_prefix(text: &str) -> Option<String> {
    let quote_start = find_unclosed_quote_start(text)?;
    if quote_start > 0 && text[..quote_start].ends_with('@') {
        let at_start = quote_start - '@'.len_utf8();
        if !is_token_start(text, at_start) {
            return None;
        }
        return Some(text[at_start..].to_string());
    }

    if !is_token_start(text, quote_start) {
        return None;
    }
    Some(text[quote_start..].to_string())
}

fn parse_path_prefix(prefix: &str) -> ParsedPathPrefix {
    if let Some(raw_prefix) = prefix.strip_prefix("@\"") {
        return ParsedPathPrefix {
            raw_prefix: raw_prefix.to_string(),
            is_at_prefix: true,
            is_quoted_prefix: true,
        };
    }
    if let Some(raw_prefix) = prefix.strip_prefix('"') {
        return ParsedPathPrefix {
            raw_prefix: raw_prefix.to_string(),
            is_at_prefix: false,
            is_quoted_prefix: true,
        };
    }
    if let Some(raw_prefix) = prefix.strip_prefix('@') {
        return ParsedPathPrefix {
            raw_prefix: raw_prefix.to_string(),
            is_at_prefix: true,
            is_quoted_prefix: false,
        };
    }
    ParsedPathPrefix {
        raw_prefix: prefix.to_string(),
        is_at_prefix: false,
        is_quoted_prefix: false,
    }
}

fn build_completion_value(path: &str, options: BuildCompletionOptions) -> String {
    let needs_quotes = options.is_quoted_prefix || path.contains(' ');
    let prefix = if options.is_at_prefix { "@" } else { "" };
    if needs_quotes {
        format!("{prefix}\"{path}\"")
    } else {
        format!("{prefix}{path}")
    }
}

fn extract_at_prefix(text: &str) -> Option<String> {
    if let Some(quoted_prefix) = extract_quoted_prefix(text)
        && quoted_prefix.starts_with("@\"")
    {
        return Some(quoted_prefix);
    }

    let token_start = find_last_delimiter(text).map_or(0, |index| index + 1);
    text[token_start..]
        .starts_with('@')
        .then(|| text[token_start..].to_string())
}

fn extract_path_prefix(text: &str, force_extract: bool) -> Option<String> {
    if let Some(quoted_prefix) = extract_quoted_prefix(text) {
        return Some(quoted_prefix);
    }

    let token_start = find_last_delimiter(text).map_or(0, |index| index + 1);
    let path_prefix = &text[token_start..];

    if force_extract {
        return Some(path_prefix.to_string());
    }

    if path_prefix.contains('/') || path_prefix.starts_with('.') || path_prefix.starts_with("~/") {
        return Some(path_prefix.to_string());
    }

    if path_prefix.is_empty() && text.ends_with(' ') {
        return Some(String::new());
    }

    None
}

fn expand_home_path(path: &str) -> String {
    let Some(home) = env::var_os("HOME").map(PathBuf::from) else {
        return path.to_string();
    };
    let Some(home) = home.to_str() else {
        return path.to_string();
    };

    if path == "~" {
        return home.to_string();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        let expanded = Path::new(home).join(rest);
        let mut expanded = expanded.to_string_lossy().into_owned();
        if path.ends_with('/') && !expanded.ends_with('/') {
            expanded.push('/');
        }
        return expanded;
    }
    path.to_string()
}

fn display_dirname(path: &str) -> String {
    let normalized = to_display_path(path);
    let trimmed = normalized.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/".to_string();
    }
    match trimmed.rfind('/') {
        Some(0) => "/".to_string(),
        Some(index) => trimmed[..index].to_string(),
        None => ".".to_string(),
    }
}

fn display_basename(path: &str) -> String {
    let normalized = to_display_path(path);
    normalized
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string()
}

fn join_display_path(dir: &str, name: &str) -> String {
    if dir == "." || dir.is_empty() {
        name.to_string()
    } else if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn completion_relative_path(display_prefix: &str, name: &str) -> String {
    if display_prefix.ends_with('/') {
        return format!("{display_prefix}{name}");
    }

    if display_prefix.contains('/') || display_prefix.contains('\\') {
        if let Some(home_relative_dir) = display_prefix.strip_prefix("~/") {
            let dir = display_dirname(home_relative_dir);
            return if dir == "." {
                format!("~/{name}")
            } else {
                format!("~/{dir}/{name}")
            };
        }

        if display_prefix.starts_with('/') {
            let dir = display_dirname(display_prefix);
            return join_display_path(&dir, name);
        }

        let dir = display_dirname(display_prefix);
        let mut relative = join_display_path(&dir, name);
        if display_prefix.starts_with("./") && !relative.starts_with("./") {
            relative = format!("./{relative}");
        }
        return relative;
    }

    if display_prefix.starts_with('~') {
        format!("~/{name}")
    } else {
        name.to_string()
    }
}

fn floor_char_boundary(value: &str, index: usize) -> usize {
    let mut index = index.min(value.len());
    while index > 0 && !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let path = env::temp_dir().join(format!(
            "prime-agent-tui-autocomplete-{name}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn lines<const N: usize>(items: [&str; N]) -> Vec<String> {
        items.into_iter().map(String::from).collect()
    }

    #[test]
    fn autocomplete_filters_slash_commands_by_name_and_alias() {
        let provider = CombinedAutocompleteProvider::with_commands(
            [
                SlashCommand::new("help")
                    .with_aliases(["h"])
                    .with_description("show help"),
                SlashCommand::new("model").with_aliases(["m"]),
            ],
            ".",
        );

        let suggestions = provider
            .get_suggestions(&lines(["/h"]), 0, 2, AutocompleteOptions::default())
            .expect("slash command suggestions");

        assert_eq!(suggestions.prefix, "/h");
        assert_eq!(suggestions.items[0].value, "help");
        assert_eq!(suggestions.items[0].label, "help");
        assert_eq!(
            suggestions.items[0].description.as_deref(),
            Some("show help")
        );

        let alias_suggestions = provider
            .get_suggestions(&lines(["/m"]), 0, 2, AutocompleteOptions::default())
            .expect("alias suggestions");
        assert_eq!(alias_suggestions.items[0].value, "model");
    }

    #[test]
    fn autocomplete_uses_command_argument_completion_after_space() {
        let provider = CombinedAutocompleteProvider::with_commands(
            [
                SlashCommand::new("open").with_argument_completions(|prefix| {
                    Some(
                        ["one", "two"]
                            .into_iter()
                            .filter(|item| item.starts_with(prefix))
                            .map(|item| AutocompleteItem::new(item, item))
                            .collect(),
                    )
                }),
            ],
            ".",
        );

        let suggestions = provider
            .get_suggestions(
                &lines(["/open t"]),
                0,
                "/open t".len(),
                AutocompleteOptions::default(),
            )
            .expect("argument suggestions");

        assert_eq!(suggestions.prefix, "t");
        assert_eq!(suggestions.items, vec![AutocompleteItem::new("two", "two")]);
    }

    #[test]
    fn autocomplete_extracts_file_prefixes_and_quotes_at_paths_with_spaces() {
        let dir = temp_dir("files");
        fs::create_dir(dir.join("src")).expect("create src");
        fs::write(dir.join("space file.txt"), "").expect("write file");

        let provider = CombinedAutocompleteProvider::new(&dir);
        let suggestions = provider
            .get_suggestions(
                &lines(["attach @sp"]),
                0,
                "attach @sp".len(),
                AutocompleteOptions::default(),
            )
            .expect("file suggestions");

        assert_eq!(suggestions.prefix, "@sp");
        assert_eq!(
            suggestions.items,
            vec![AutocompleteItem::new(
                "@\"space file.txt\"",
                "space file.txt"
            )]
        );

        fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn autocomplete_sorts_directories_before_files() {
        let dir = temp_dir("sort");
        fs::create_dir(dir.join("apple")).expect("create dir");
        fs::write(dir.join("aardvark.txt"), "").expect("write file");

        let provider = CombinedAutocompleteProvider::new(&dir);
        let suggestions = provider
            .get_suggestions(&lines([""]), 0, 0, AutocompleteOptions { force: true })
            .expect("file suggestions");

        assert_eq!(suggestions.items[0].label, "apple/");
        assert_eq!(suggestions.items[1].label, "aardvark.txt");

        fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn autocomplete_apply_completion_handles_slash_and_at_prefixes() {
        let edit = apply_completion(
            &lines(["/he"]),
            0,
            3,
            &AutocompleteItem::new("help", "help"),
            "/he",
        );

        assert_eq!(edit.lines, lines(["/help "]));
        assert_eq!(edit.cursor_col, "/help ".len());

        let edit = apply_completion(
            &lines(["read @sp now"]),
            0,
            "read @sp".len(),
            &AutocompleteItem::new("@\"space file.txt\"", "space file.txt"),
            "@sp",
        );

        assert_eq!(edit.lines, lines(["read @\"space file.txt\"  now"]));
        assert_eq!(edit.cursor_col, "read @\"space file.txt\" ".len());
    }

    #[test]
    fn autocomplete_state_tracks_selection_and_key_acceptance() {
        let mut state = AutocompleteState::new(2);
        state.set_suggestions(Some(AutocompleteSuggestions {
            prefix: "/".to_string(),
            items: vec![
                AutocompleteItem::new("one", "one"),
                AutocompleteItem::new("two", "two"),
                AutocompleteItem::new("three", "three"),
            ],
        }));

        assert_eq!(
            state.selected_item().map(|item| item.value.as_str()),
            Some("one")
        );
        assert_eq!(
            state.handle_input("\u{1b}[B"),
            Some(AutocompleteInputEvent::Handled)
        );
        assert_eq!(
            state.selected_item().map(|item| item.value.as_str()),
            Some("two")
        );
        assert_eq!(
            state.handle_input("\t"),
            Some(AutocompleteInputEvent::Accepted(AutocompleteItem::new(
                "two", "two"
            )))
        );
        assert!(!state.is_active());
    }

    #[test]
    fn autocomplete_file_completion_skips_bare_slash_command_tab() {
        assert!(!should_trigger_file_completion(
            &lines(["/help"]),
            0,
            "/help".len()
        ));
        assert!(should_trigger_file_completion(
            &lines(["/open file"]),
            0,
            "/open file".len()
        ));
    }
}
