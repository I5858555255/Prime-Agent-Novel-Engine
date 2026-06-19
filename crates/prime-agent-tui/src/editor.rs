use std::collections::{HashMap, HashSet};

use crate::editor_component::EditorComponent;
use crate::input::CURSOR_MARKER;
use crate::keybindings::get_keybindings;
use crate::keys::{decode_printable_key, matches_key};
use crate::kill_ring::{KillRing, KillRingPushOptions};
use crate::undo_stack::UndoStack;
use crate::utils::{is_punctuation_char, is_whitespace_char, truncate_to_width, visible_width};

const PASTE_START: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";
const DEFAULT_RENDER_ROWS: usize = 24;
const MAX_HISTORY: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextSegment {
    pub segment: String,
    pub index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextChunk {
    pub text: String,
    pub start_index: usize,
    pub end_index: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CursorPosition {
    pub line: usize,
    pub col: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorState {
    pub lines: Vec<String>,
    pub cursor_line: usize,
    pub cursor_col: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutLine {
    pub text: String,
    pub has_cursor: bool,
    pub cursor_pos: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VisualLine {
    pub logical_line: usize,
    pub start_col: usize,
    pub length: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EditorOptions {
    pub padding_x: usize,
    pub autocomplete_max_visible: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EditorRenderOptions {
    pub terminal_rows: usize,
    pub focused: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditorEvent {
    Changed(String),
    Submitted(String),
    Cancelled,
    AutocompleteRequested { force: bool, explicit_tab: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LastAction {
    Kill,
    Yank,
    TypeWord,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JumpMode {
    Forward,
    Backward,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Editor {
    state: EditorState,
    padding_x: usize,
    prompt_prefix: String,
    autocomplete_max_visible: usize,
    last_width: usize,
    scroll_offset: usize,
    pastes: HashMap<usize, String>,
    paste_counter: usize,
    paste_buffer: String,
    is_in_paste: bool,
    history: Vec<String>,
    history_index: Option<usize>,
    kill_ring: KillRing,
    last_action: Option<LastAction>,
    jump_mode: Option<JumpMode>,
    preferred_visual_col: Option<usize>,
    snapped_from_cursor_col: Option<usize>,
    undo_stack: UndoStack<EditorState>,
    disable_submit: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct EditorKeyAction {
    cancel: bool,
    undo: bool,
    submit: bool,
    new_line: bool,
    tab: bool,
    delete_backward: bool,
    delete_forward: bool,
    delete_word_backward: bool,
    delete_word_forward: bool,
    delete_to_line_start: bool,
    delete_to_line_end: bool,
    yank: bool,
    yank_pop: bool,
    cursor_up: bool,
    cursor_down: bool,
    cursor_left: bool,
    cursor_right: bool,
    cursor_line_start: bool,
    cursor_line_end: bool,
    cursor_word_left: bool,
    cursor_word_right: bool,
    page_up: bool,
    page_down: bool,
    jump_forward: bool,
    jump_backward: bool,
}

impl Default for EditorState {
    fn default() -> Self {
        Self {
            lines: vec![String::new()],
            cursor_line: 0,
            cursor_col: 0,
        }
    }
}

impl EditorState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_text(text: &str) -> Self {
        let mut state = Self {
            lines: split_lines(&normalize_text(text)),
            cursor_line: 0,
            cursor_col: 0,
        };
        state.cursor_line = state.lines.len().saturating_sub(1);
        state.cursor_col = state
            .lines
            .last()
            .map_or(0, |line| floor_char_boundary(line, line.len()));
        state
    }

    pub fn text(&self) -> String {
        self.lines.join("\n")
    }

    pub fn cursor(&self) -> CursorPosition {
        CursorPosition {
            line: self.cursor_line,
            col: self.cursor_col,
        }
    }
}

impl Default for EditorOptions {
    fn default() -> Self {
        Self {
            padding_x: 0,
            autocomplete_max_visible: 5,
        }
    }
}

impl Default for EditorRenderOptions {
    fn default() -> Self {
        Self {
            terminal_rows: DEFAULT_RENDER_ROWS,
            focused: false,
        }
    }
}

impl Default for Editor {
    fn default() -> Self {
        Self::new()
    }
}

impl Editor {
    pub fn new() -> Self {
        Self::with_options(EditorOptions::default())
    }

    pub fn with_options(options: EditorOptions) -> Self {
        Self {
            state: EditorState::default(),
            padding_x: options.padding_x,
            prompt_prefix: String::new(),
            autocomplete_max_visible: clamp_autocomplete_max_visible(
                options.autocomplete_max_visible,
            ),
            last_width: 80,
            scroll_offset: 0,
            pastes: HashMap::new(),
            paste_counter: 0,
            paste_buffer: String::new(),
            is_in_paste: false,
            history: Vec::new(),
            history_index: None,
            kill_ring: KillRing::new(),
            last_action: None,
            jump_mode: None,
            preferred_visual_col: None,
            snapped_from_cursor_col: None,
            undo_stack: UndoStack::new(),
            disable_submit: false,
        }
    }

    pub fn state(&self) -> &EditorState {
        &self.state
    }

    pub fn lines(&self) -> &[String] {
        &self.state.lines
    }

    pub fn cursor(&self) -> CursorPosition {
        self.state.cursor()
    }

    pub fn text(&self) -> String {
        self.state.text()
    }

    pub fn set_disable_submit(&mut self, disable_submit: bool) {
        self.disable_submit = disable_submit;
    }

    pub fn disable_submit(&self) -> bool {
        self.disable_submit
    }

    pub fn padding_x(&self) -> usize {
        self.padding_x
    }

    pub fn set_padding_x(&mut self, padding_x: usize) {
        self.padding_x = padding_x;
    }

    pub fn prompt_prefix(&self) -> &str {
        &self.prompt_prefix
    }

    pub fn set_prompt_prefix(&mut self, prompt_prefix: impl Into<String>) {
        self.prompt_prefix = prompt_prefix.into();
    }

    pub fn autocomplete_max_visible(&self) -> usize {
        self.autocomplete_max_visible
    }

    pub fn set_autocomplete_max_visible(&mut self, max_visible: usize) {
        self.autocomplete_max_visible = clamp_autocomplete_max_visible(max_visible);
    }

    pub fn set_text(&mut self, text: &str) -> bool {
        self.history_index = None;
        self.last_action = None;
        let normalized = normalize_text(text);
        if self.text() != normalized {
            self.push_undo_snapshot();
        }
        self.set_text_internal(&normalized)
    }

    pub fn set_cursor(&mut self, line: usize, col: usize) {
        self.state.cursor_line = line.min(self.state.lines.len().saturating_sub(1));
        let current = self.current_line();
        self.set_cursor_col(floor_char_boundary(&current, col.min(current.len())));
    }

    pub fn insert_text_at_cursor(&mut self, text: &str) -> bool {
        if text.is_empty() {
            return false;
        }
        self.push_undo_snapshot();
        self.history_index = None;
        self.last_action = None;
        self.insert_text_at_cursor_internal(text)
    }

    pub fn expanded_text(&self) -> String {
        expand_paste_markers(&self.text(), &self.pastes)
    }

    pub fn add_to_history(&mut self, text: &str) {
        let trimmed = text.trim();
        if trimmed.is_empty() || self.history.first().is_some_and(|item| item == trimmed) {
            return;
        }

        self.history.insert(0, trimmed.to_string());
        if self.history.len() > MAX_HISTORY {
            self.history.pop();
        }
    }

    pub fn history(&self) -> &[String] {
        &self.history
    }

    pub fn navigate_history_up(&mut self) -> bool {
        self.navigate_history(-1)
    }

    pub fn navigate_history_down(&mut self) -> bool {
        self.navigate_history(1)
    }

    pub fn layout_text(&self, content_width: usize) -> Vec<LayoutLine> {
        let content_width = content_width.max(1);
        let mut layout_lines = Vec::new();

        if self.is_empty() {
            layout_lines.push(LayoutLine {
                text: String::new(),
                has_cursor: true,
                cursor_pos: Some(0),
            });
            return layout_lines;
        }

        for (line_index, line) in self.state.lines.iter().enumerate() {
            let hidden_prefix = self.line_hidden_prefix_length(line_index, line);
            let display_line = &line[hidden_prefix..];
            let is_current_line = line_index == self.state.cursor_line;

            if display_line.is_empty() {
                layout_lines.push(LayoutLine {
                    text: String::new(),
                    has_cursor: is_current_line,
                    cursor_pos: is_current_line.then_some(0),
                });
                continue;
            }

            if visible_width(display_line) <= content_width {
                let cursor_pos = self
                    .state
                    .cursor_col
                    .saturating_sub(hidden_prefix)
                    .min(display_line.len());
                layout_lines.push(LayoutLine {
                    text: display_line.to_string(),
                    has_cursor: is_current_line,
                    cursor_pos: is_current_line.then_some(cursor_pos),
                });
                continue;
            }

            let valid_ids = self.valid_paste_ids();
            let chunks = word_wrap_line_with_markers(display_line, content_width, &valid_ids);
            for (chunk_index, chunk) in chunks.iter().enumerate() {
                let is_last_chunk = chunk_index == chunks.len().saturating_sub(1);
                let cursor_pos = self.state.cursor_col.saturating_sub(hidden_prefix);
                let mut has_cursor = false;
                let mut adjusted_cursor_pos = 0;

                if is_current_line {
                    if is_last_chunk {
                        has_cursor = cursor_pos >= chunk.start_index;
                        adjusted_cursor_pos = cursor_pos.saturating_sub(chunk.start_index);
                    } else if cursor_pos >= chunk.start_index && cursor_pos < chunk.end_index {
                        has_cursor = true;
                        adjusted_cursor_pos = cursor_pos
                            .saturating_sub(chunk.start_index)
                            .min(chunk.text.len());
                    }
                }

                layout_lines.push(LayoutLine {
                    text: chunk.text.clone(),
                    has_cursor,
                    cursor_pos: has_cursor.then_some(adjusted_cursor_pos),
                });
            }
        }

        layout_lines
    }

    pub fn build_visual_line_map(&self, width: usize) -> Vec<VisualLine> {
        let width = width.max(1);
        let mut visual_lines = Vec::new();

        for (line_index, line) in self.state.lines.iter().enumerate() {
            let hidden_prefix = self.line_hidden_prefix_length(line_index, line);
            let display_line = &line[hidden_prefix..];
            if display_line.is_empty() {
                visual_lines.push(VisualLine {
                    logical_line: line_index,
                    start_col: hidden_prefix,
                    length: 0,
                });
            } else if visible_width(display_line) <= width {
                visual_lines.push(VisualLine {
                    logical_line: line_index,
                    start_col: hidden_prefix,
                    length: display_line.len(),
                });
            } else {
                let valid_ids = self.valid_paste_ids();
                let chunks = word_wrap_line_with_markers(display_line, width, &valid_ids);
                for chunk in chunks {
                    visual_lines.push(VisualLine {
                        logical_line: line_index,
                        start_col: hidden_prefix + chunk.start_index,
                        length: chunk.end_index.saturating_sub(chunk.start_index),
                    });
                }
            }
        }

        if visual_lines.is_empty() {
            visual_lines.push(VisualLine {
                logical_line: 0,
                start_col: 0,
                length: 0,
            });
        }

        visual_lines
    }

    pub fn find_visual_line_at(
        &self,
        visual_lines: &[VisualLine],
        line: usize,
        col: usize,
    ) -> usize {
        if visual_lines.is_empty() {
            return 0;
        }

        let hidden_prefix = self
            .state
            .lines
            .get(line)
            .map_or(0, |logical| self.line_hidden_prefix_length(line, logical));
        for (index, visual_line) in visual_lines.iter().enumerate() {
            if visual_line.logical_line != line {
                continue;
            }
            if hidden_prefix > 0 && col < hidden_prefix && visual_line.start_col == hidden_prefix {
                return index;
            }

            let offset = col.saturating_sub(visual_line.start_col);
            let is_after_start = col >= visual_line.start_col;
            let is_last_segment = index == visual_lines.len().saturating_sub(1)
                || visual_lines
                    .get(index + 1)
                    .is_none_or(|next| next.logical_line != visual_line.logical_line);

            if is_after_start
                && (offset < visual_line.length
                    || (is_last_segment && offset == visual_line.length))
            {
                return index;
            }
        }

        visual_lines.len().saturating_sub(1)
    }

    pub fn find_current_visual_line(&self, visual_lines: &[VisualLine]) -> usize {
        self.find_visual_line_at(visual_lines, self.state.cursor_line, self.state.cursor_col)
    }

    pub fn render(&mut self, width: usize, options: EditorRenderOptions) -> Vec<String> {
        let width = width.max(1);
        let max_padding = width.saturating_sub(1) / 2;
        let padding_x = self.padding_x.min(max_padding);
        let content_width = width.saturating_sub(padding_x * 2).max(1);
        let prompt_prefix_width =
            visible_width(&self.prompt_prefix).min(content_width.saturating_sub(1));
        let input_width = content_width.saturating_sub(prompt_prefix_width).max(1);
        let prompt_prefix = if prompt_prefix_width > 0 {
            truncate_to_width(&self.prompt_prefix, prompt_prefix_width, "", false)
        } else {
            String::new()
        };
        let layout_width = if padding_x == 0 {
            input_width.saturating_sub(1).max(1)
        } else {
            input_width
        };

        self.last_width = layout_width;
        let layout_lines = self.layout_text(layout_width);
        let max_visible_lines = (options.terminal_rows.saturating_mul(3) / 10).max(5);
        let mut cursor_line_index = layout_lines
            .iter()
            .position(|line| line.has_cursor)
            .unwrap_or(0);
        cursor_line_index = cursor_line_index.min(layout_lines.len().saturating_sub(1));

        if cursor_line_index < self.scroll_offset {
            self.scroll_offset = cursor_line_index;
        } else if cursor_line_index >= self.scroll_offset.saturating_add(max_visible_lines) {
            self.scroll_offset =
                cursor_line_index.saturating_sub(max_visible_lines.saturating_sub(1));
        }

        let max_scroll_offset = layout_lines.len().saturating_sub(max_visible_lines);
        self.scroll_offset = self.scroll_offset.min(max_scroll_offset);
        let visible_end = self
            .scroll_offset
            .saturating_add(max_visible_lines)
            .min(layout_lines.len());
        let visible_lines = &layout_lines[self.scroll_offset..visible_end];

        let mut result = Vec::new();
        result.push(border_line(width, self.scroll_offset, true));

        let left_padding = " ".repeat(padding_x);
        let right_padding = " ".repeat(padding_x);
        for (visible_index, layout_line) in visible_lines.iter().enumerate() {
            let absolute_index = self.scroll_offset + visible_index;
            let line_prompt_prefix = if absolute_index == 0 {
                prompt_prefix.clone()
            } else {
                " ".repeat(prompt_prefix_width)
            };

            let mut display_text = layout_line.text.clone();
            let mut line_visible_width = visible_width(&layout_line.text);
            if layout_line.has_cursor {
                let cursor_pos = layout_line.cursor_pos.unwrap_or(0);
                let rendered = render_cursor(&display_text, cursor_pos, options.focused);
                line_visible_width = rendered.visible_width;
                display_text = rendered.text;
            }

            let padding = " ".repeat(input_width.saturating_sub(line_visible_width));
            let line =
                format!("{left_padding}{line_prompt_prefix}{display_text}{padding}{right_padding}");
            result.push(fit_line_to_width(&line, width));
        }

        let lines_below = layout_lines
            .len()
            .saturating_sub(self.scroll_offset + visible_lines.len());
        result.push(border_line(width, lines_below, false));
        result
    }

    pub fn handle_input(&mut self, data: &str) -> Vec<EditorEvent> {
        if data.contains(PASTE_START) {
            self.is_in_paste = true;
            self.paste_buffer.clear();
            let data = data.replacen(PASTE_START, "", 1);
            return self.handle_input(&data);
        }

        if self.is_in_paste {
            self.paste_buffer.push_str(data);
            let Some(end_index) = self.paste_buffer.find(PASTE_END) else {
                return Vec::new();
            };

            let paste_content = self.paste_buffer[..end_index].to_string();
            let remaining_start = end_index + PASTE_END.len();
            let remaining = self.paste_buffer[remaining_start..].to_string();
            self.paste_buffer.clear();
            self.is_in_paste = false;

            let mut events = changed_event(self.handle_paste(&paste_content), &self.text());
            if !remaining.is_empty() {
                events.extend(self.handle_input(&remaining));
            }
            return events;
        }

        if self.handle_jump_mode(data) {
            return Vec::new();
        }

        let action = {
            let keybindings = get_keybindings();
            EditorKeyAction {
                cancel: keybindings.matches(data, "tui.select.cancel"),
                undo: keybindings.matches(data, "tui.editor.undo"),
                submit: keybindings.matches(data, "tui.input.submit"),
                new_line: keybindings.matches(data, "tui.input.newLine"),
                tab: keybindings.matches(data, "tui.input.tab"),
                delete_backward: keybindings.matches(data, "tui.editor.deleteCharBackward")
                    || matches_key(data, "shift+backspace"),
                delete_forward: keybindings.matches(data, "tui.editor.deleteCharForward")
                    || matches_key(data, "shift+delete"),
                delete_word_backward: keybindings.matches(data, "tui.editor.deleteWordBackward"),
                delete_word_forward: keybindings.matches(data, "tui.editor.deleteWordForward"),
                delete_to_line_start: keybindings.matches(data, "tui.editor.deleteToLineStart"),
                delete_to_line_end: keybindings.matches(data, "tui.editor.deleteToLineEnd"),
                yank: keybindings.matches(data, "tui.editor.yank"),
                yank_pop: keybindings.matches(data, "tui.editor.yankPop"),
                cursor_up: keybindings.matches(data, "tui.editor.cursorUp"),
                cursor_down: keybindings.matches(data, "tui.editor.cursorDown"),
                cursor_left: keybindings.matches(data, "tui.editor.cursorLeft"),
                cursor_right: keybindings.matches(data, "tui.editor.cursorRight"),
                cursor_line_start: keybindings.matches(data, "tui.editor.cursorLineStart"),
                cursor_line_end: keybindings.matches(data, "tui.editor.cursorLineEnd"),
                cursor_word_left: keybindings.matches(data, "tui.editor.cursorWordLeft"),
                cursor_word_right: keybindings.matches(data, "tui.editor.cursorWordRight"),
                page_up: keybindings.matches(data, "tui.editor.pageUp"),
                page_down: keybindings.matches(data, "tui.editor.pageDown"),
                jump_forward: keybindings.matches(data, "tui.editor.jumpForward"),
                jump_backward: keybindings.matches(data, "tui.editor.jumpBackward"),
            }
        };

        if action.cancel {
            return vec![EditorEvent::Cancelled];
        }
        if action.undo {
            return changed_event(self.undo(), &self.text());
        }
        if action.tab {
            let current_line = self.current_line();
            let before_cursor = &current_line[..self.state.cursor_col];
            let force = !self.is_in_slash_command_context(before_cursor)
                || before_cursor.trim_start().contains(' ');
            return vec![EditorEvent::AutocompleteRequested {
                force,
                explicit_tab: true,
            }];
        }
        if action.delete_to_line_end {
            return changed_event(self.delete_to_end_of_line(), &self.text());
        }
        if action.delete_to_line_start {
            return changed_event(self.delete_to_start_of_line(), &self.text());
        }
        if action.delete_word_backward {
            return changed_event(self.delete_word_backward(), &self.text());
        }
        if action.delete_word_forward {
            return changed_event(self.delete_word_forward(), &self.text());
        }
        if action.delete_backward {
            return changed_event(self.backspace(), &self.text());
        }
        if action.delete_forward {
            return changed_event(self.delete_forward(), &self.text());
        }
        if action.yank {
            return changed_event(self.yank(), &self.text());
        }
        if action.yank_pop {
            return changed_event(self.yank_pop(), &self.text());
        }
        if action.cursor_line_start {
            self.move_to_line_start();
            return Vec::new();
        }
        if action.cursor_line_end {
            self.move_to_line_end();
            return Vec::new();
        }
        if action.cursor_word_left {
            self.move_word_backward();
            return Vec::new();
        }
        if action.cursor_word_right {
            self.move_word_forward();
            return Vec::new();
        }
        if action.new_line || data == "\n" {
            return changed_event(self.add_new_line(), &self.text());
        }
        if action.submit {
            if self.disable_submit {
                return Vec::new();
            }
            return self.submit_value();
        }
        if action.cursor_up {
            if self.is_empty() || (self.history_index.is_some() && self.is_on_first_visual_line()) {
                return changed_event(self.navigate_history_up(), &self.text());
            }
            if self.is_on_first_visual_line() {
                self.move_to_line_start();
            } else {
                self.move_cursor(-1, 0);
            }
            return Vec::new();
        }
        if action.cursor_down {
            if self.history_index.is_some() && self.is_on_last_visual_line() {
                return changed_event(self.navigate_history_down(), &self.text());
            }
            if self.is_on_last_visual_line() {
                self.move_to_line_end();
            } else {
                self.move_cursor(1, 0);
            }
            return Vec::new();
        }
        if action.cursor_right {
            self.move_cursor(0, 1);
            return Vec::new();
        }
        if action.cursor_left {
            self.move_cursor(0, -1);
            return Vec::new();
        }
        if action.page_up {
            self.page_scroll(-1, DEFAULT_RENDER_ROWS);
            return Vec::new();
        }
        if action.page_down {
            self.page_scroll(1, DEFAULT_RENDER_ROWS);
            return Vec::new();
        }
        if action.jump_forward {
            self.jump_mode = Some(JumpMode::Forward);
            return Vec::new();
        }
        if action.jump_backward {
            self.jump_mode = Some(JumpMode::Backward);
            return Vec::new();
        }
        if matches_key(data, "shift+space") {
            return changed_event(self.insert_character(" "), &self.text());
        }
        if let Some(printable) = decode_printable_key(data) {
            return changed_event(self.insert_character(&printable), &self.text());
        }
        if is_printable_text(data) {
            return changed_event(self.insert_character(data), &self.text());
        }

        Vec::new()
    }

    pub fn handle_paste(&mut self, pasted_text: &str) -> bool {
        self.history_index = None;
        self.last_action = None;
        self.push_undo_snapshot();

        let decoded_text = decode_paste_control_sequences(pasted_text);
        let clean_text = normalize_text(&decoded_text);
        let mut filtered_text = clean_text
            .chars()
            .filter(|ch| *ch == '\n' || is_printable_scalar(*ch))
            .collect::<String>();

        if starts_like_path(&filtered_text) && self.char_before_cursor().is_some_and(is_word_char) {
            filtered_text.insert(0, ' ');
        }
        if filtered_text.is_empty() {
            return false;
        }

        let pasted_line_count = filtered_text.split('\n').count();
        let total_chars = filtered_text.chars().count();
        if pasted_line_count > 10 || total_chars > 1000 {
            self.paste_counter += 1;
            let paste_id = self.paste_counter;
            self.pastes.insert(paste_id, filtered_text);
            let marker = if pasted_line_count > 10 {
                format!("[paste #{paste_id} +{pasted_line_count} lines]")
            } else {
                format!("[paste #{paste_id} {total_chars} chars]")
            };
            return self.insert_text_at_cursor_internal(&marker);
        }

        self.insert_text_at_cursor_internal(&filtered_text)
    }

    pub fn add_new_line(&mut self) -> bool {
        self.history_index = None;
        self.last_action = None;
        self.push_undo_snapshot();

        let current_line = self.current_line();
        let before = current_line[..self.state.cursor_col].to_string();
        let after = current_line[self.state.cursor_col..].to_string();

        self.state.lines[self.state.cursor_line] = before;
        self.state.lines.insert(self.state.cursor_line + 1, after);
        self.state.cursor_line += 1;
        self.set_cursor_col(0);
        true
    }

    pub fn backspace(&mut self) -> bool {
        self.history_index = None;
        self.last_action = None;

        let line = self.current_line();
        let line_start_col = self.line_hidden_prefix_length(self.state.cursor_line, &line);
        if self.state.cursor_col > line_start_col {
            self.push_undo_snapshot();
            let before_cursor = &line[line_start_col..self.state.cursor_col];
            let segments = self.segment(before_cursor);
            let delete_len = segments.last().map_or(1, |segment| segment.segment.len());
            let delete_start = self.state.cursor_col.saturating_sub(delete_len);
            self.state.lines[self.state.cursor_line]
                .replace_range(delete_start..self.state.cursor_col, "");
            self.set_cursor_col(delete_start);
            return true;
        }

        if self.state.cursor_line > 0 {
            self.push_undo_snapshot();
            let current_line = self.state.lines.remove(self.state.cursor_line);
            self.state.cursor_line -= 1;
            let previous_len = self.state.lines[self.state.cursor_line].len();
            self.state.lines[self.state.cursor_line].push_str(&current_line);
            self.set_cursor_col(previous_len);
            return true;
        }

        false
    }

    pub fn delete_forward(&mut self) -> bool {
        self.history_index = None;
        self.last_action = None;

        let current_line = self.current_line();
        if self.state.cursor_col < current_line.len() {
            self.push_undo_snapshot();
            let after_cursor = &current_line[self.state.cursor_col..];
            let segments = self.segment(after_cursor);
            let delete_len = segments.first().map_or(1, |segment| segment.segment.len());
            let delete_end = self.state.cursor_col + delete_len;
            self.state.lines[self.state.cursor_line]
                .replace_range(self.state.cursor_col..delete_end, "");
            return true;
        }

        if self.state.cursor_line < self.state.lines.len().saturating_sub(1) {
            self.push_undo_snapshot();
            let next_line = self.state.lines.remove(self.state.cursor_line + 1);
            self.state.lines[self.state.cursor_line].push_str(&next_line);
            return true;
        }

        false
    }

    pub fn delete_to_start_of_line(&mut self) -> bool {
        self.history_index = None;
        let current_line = self.current_line();
        let line_start_col = self.line_hidden_prefix_length(self.state.cursor_line, &current_line);

        if self.state.cursor_col > line_start_col {
            self.push_undo_snapshot();
            let deleted = current_line[line_start_col..self.state.cursor_col].to_string();
            self.kill_ring.push(
                &deleted,
                KillRingPushOptions {
                    prepend: true,
                    accumulate: self.last_action == Some(LastAction::Kill),
                },
            );
            self.last_action = Some(LastAction::Kill);
            self.state.lines[self.state.cursor_line]
                .replace_range(line_start_col..self.state.cursor_col, "");
            self.set_cursor_col(line_start_col);
            return true;
        }

        if self.state.cursor_line > 0 {
            self.push_undo_snapshot();
            self.kill_ring.push(
                "\n",
                KillRingPushOptions {
                    prepend: true,
                    accumulate: self.last_action == Some(LastAction::Kill),
                },
            );
            self.last_action = Some(LastAction::Kill);
            let current_line = self.state.lines.remove(self.state.cursor_line);
            self.state.cursor_line -= 1;
            let previous_len = self.state.lines[self.state.cursor_line].len();
            self.state.lines[self.state.cursor_line].push_str(&current_line);
            self.set_cursor_col(previous_len);
            return true;
        }

        false
    }

    pub fn delete_to_end_of_line(&mut self) -> bool {
        self.history_index = None;
        let current_line = self.current_line();

        if self.state.cursor_col < current_line.len() {
            self.push_undo_snapshot();
            let deleted = current_line[self.state.cursor_col..].to_string();
            self.kill_ring.push(
                &deleted,
                KillRingPushOptions {
                    prepend: false,
                    accumulate: self.last_action == Some(LastAction::Kill),
                },
            );
            self.last_action = Some(LastAction::Kill);
            self.state.lines[self.state.cursor_line].truncate(self.state.cursor_col);
            return true;
        }

        if self.state.cursor_line < self.state.lines.len().saturating_sub(1) {
            self.push_undo_snapshot();
            self.kill_ring.push(
                "\n",
                KillRingPushOptions {
                    prepend: false,
                    accumulate: self.last_action == Some(LastAction::Kill),
                },
            );
            self.last_action = Some(LastAction::Kill);
            let next_line = self.state.lines.remove(self.state.cursor_line + 1);
            self.state.lines[self.state.cursor_line].push_str(&next_line);
            return true;
        }

        false
    }

    pub fn delete_word_backward(&mut self) -> bool {
        self.history_index = None;
        let current_line = self.current_line();
        if self.state.cursor_col == 0 {
            if self.state.cursor_line == 0 {
                return false;
            }
            self.push_undo_snapshot();
            self.kill_ring.push(
                "\n",
                KillRingPushOptions {
                    prepend: true,
                    accumulate: self.last_action == Some(LastAction::Kill),
                },
            );
            self.last_action = Some(LastAction::Kill);
            let current_line = self.state.lines.remove(self.state.cursor_line);
            self.state.cursor_line -= 1;
            let previous_len = self.state.lines[self.state.cursor_line].len();
            self.state.lines[self.state.cursor_line].push_str(&current_line);
            self.set_cursor_col(previous_len);
            return true;
        }

        self.push_undo_snapshot();
        let was_kill = self.last_action == Some(LastAction::Kill);
        let old_cursor = self.state.cursor_col;
        self.move_word_backward();
        let delete_from = self.state.cursor_col;
        self.set_cursor_col(old_cursor);

        let deleted = current_line[delete_from..old_cursor].to_string();
        self.kill_ring.push(
            &deleted,
            KillRingPushOptions {
                prepend: true,
                accumulate: was_kill,
            },
        );
        self.last_action = Some(LastAction::Kill);
        self.state.lines[self.state.cursor_line].replace_range(delete_from..old_cursor, "");
        self.set_cursor_col(delete_from);
        true
    }

    pub fn delete_word_forward(&mut self) -> bool {
        self.history_index = None;
        let current_line = self.current_line();
        if self.state.cursor_col >= current_line.len() {
            if self.state.cursor_line >= self.state.lines.len().saturating_sub(1) {
                return false;
            }
            self.push_undo_snapshot();
            self.kill_ring.push(
                "\n",
                KillRingPushOptions {
                    prepend: false,
                    accumulate: self.last_action == Some(LastAction::Kill),
                },
            );
            self.last_action = Some(LastAction::Kill);
            let next_line = self.state.lines.remove(self.state.cursor_line + 1);
            self.state.lines[self.state.cursor_line].push_str(&next_line);
            return true;
        }

        self.push_undo_snapshot();
        let was_kill = self.last_action == Some(LastAction::Kill);
        let old_cursor = self.state.cursor_col;
        self.move_word_forward();
        let delete_to = self.state.cursor_col;
        self.set_cursor_col(old_cursor);

        let deleted = current_line[old_cursor..delete_to].to_string();
        self.kill_ring.push(
            &deleted,
            KillRingPushOptions {
                prepend: false,
                accumulate: was_kill,
            },
        );
        self.last_action = Some(LastAction::Kill);
        self.state.lines[self.state.cursor_line].replace_range(old_cursor..delete_to, "");
        true
    }

    pub fn yank(&mut self) -> bool {
        let Some(text) = self.kill_ring.peek().map(str::to_string) else {
            return false;
        };
        self.push_undo_snapshot();
        self.insert_yanked_text(&text);
        self.last_action = Some(LastAction::Yank);
        true
    }

    pub fn yank_pop(&mut self) -> bool {
        if self.last_action != Some(LastAction::Yank) || self.kill_ring.len() <= 1 {
            return false;
        }

        self.push_undo_snapshot();
        self.delete_yanked_text();
        self.kill_ring.rotate();
        let Some(text) = self.kill_ring.peek().map(str::to_string) else {
            return false;
        };
        self.insert_yanked_text(&text);
        self.last_action = Some(LastAction::Yank);
        true
    }

    pub fn undo(&mut self) -> bool {
        self.history_index = None;
        let Some(snapshot) = self.undo_stack.pop() else {
            return false;
        };
        self.state = snapshot;
        self.last_action = None;
        self.preferred_visual_col = None;
        self.snapped_from_cursor_col = None;
        true
    }

    pub fn move_to_line_start(&mut self) {
        self.last_action = None;
        let current_line = self.current_line();
        self.set_cursor_col(self.line_hidden_prefix_length(self.state.cursor_line, &current_line));
    }

    pub fn move_to_line_end(&mut self) {
        self.last_action = None;
        let current_line = self.current_line();
        self.set_cursor_col(current_line.len());
    }

    pub fn move_cursor(&mut self, delta_line: isize, delta_col: isize) {
        self.last_action = None;
        let visual_lines = self.build_visual_line_map(self.last_width);
        let current_visual_line = self.find_current_visual_line(&visual_lines);

        if delta_line != 0 {
            let target = current_visual_line as isize + delta_line;
            if target >= 0 && (target as usize) < visual_lines.len() {
                self.move_to_visual_line(&visual_lines, current_visual_line, target as usize);
            }
        }

        if delta_col > 0 {
            let current_line = self.current_line();
            if self.state.cursor_col < current_line.len() {
                let after_cursor = &current_line[self.state.cursor_col..];
                let segments = self.segment(after_cursor);
                let len = segments.first().map_or(1, |segment| segment.segment.len());
                self.set_cursor_col(self.state.cursor_col + len);
            } else if self.state.cursor_line < self.state.lines.len().saturating_sub(1) {
                self.state.cursor_line += 1;
                self.set_cursor_col(0);
            } else if let Some(current_visual) = visual_lines.get(current_visual_line) {
                self.preferred_visual_col = Some(
                    self.state
                        .cursor_col
                        .saturating_sub(current_visual.start_col),
                );
            }
        } else if delta_col < 0 {
            let current_line = self.current_line();
            let line_start_col =
                self.line_hidden_prefix_length(self.state.cursor_line, &current_line);
            if self.state.cursor_col > line_start_col {
                let before_cursor = &current_line[line_start_col..self.state.cursor_col];
                let segments = self.segment(before_cursor);
                let len = segments.last().map_or(1, |segment| segment.segment.len());
                self.set_cursor_col(
                    self.state
                        .cursor_col
                        .saturating_sub(len)
                        .max(line_start_col),
                );
            } else if self.state.cursor_line > 0 {
                self.state.cursor_line -= 1;
                let previous_line_len = self.state.lines[self.state.cursor_line].len();
                self.set_cursor_col(previous_line_len);
            }
        }
    }

    pub fn page_scroll(&mut self, direction: isize, terminal_rows: usize) {
        self.last_action = None;
        let page_size = (terminal_rows.saturating_mul(3) / 10).max(5);
        let visual_lines = self.build_visual_line_map(self.last_width);
        let current_visual_line = self.find_current_visual_line(&visual_lines);
        let target = (current_visual_line as isize + direction * page_size as isize)
            .clamp(0, visual_lines.len().saturating_sub(1) as isize);
        self.move_to_visual_line(&visual_lines, current_visual_line, target as usize);
    }

    pub fn move_word_backward(&mut self) {
        self.last_action = None;
        let current_line = self.current_line();
        let line_start_col = self.line_hidden_prefix_length(self.state.cursor_line, &current_line);
        if self.state.cursor_col <= line_start_col {
            if self.state.cursor_line > 0 {
                self.state.cursor_line -= 1;
                let previous_len = self.state.lines[self.state.cursor_line].len();
                self.set_cursor_col(previous_len);
            }
            return;
        }

        let text_before_cursor = &current_line[line_start_col..self.state.cursor_col];
        let mut segments = self.segment(text_before_cursor);
        let mut new_col = self.state.cursor_col;

        while let Some(segment) = segments.last() {
            if is_paste_marker(&segment.segment) || !is_whitespace_segment(&segment.segment) {
                break;
            }
            new_col = new_col.saturating_sub(segment.segment.len());
            segments.pop();
        }

        if let Some(last) = segments.last() {
            if is_paste_marker(&last.segment) {
                new_col = new_col.saturating_sub(last.segment.len());
            } else if is_punctuation_segment(&last.segment) {
                while let Some(segment) = segments.last() {
                    if is_paste_marker(&segment.segment)
                        || !is_punctuation_segment(&segment.segment)
                    {
                        break;
                    }
                    new_col = new_col.saturating_sub(segment.segment.len());
                    segments.pop();
                }
            } else {
                while let Some(segment) = segments.last() {
                    if is_paste_marker(&segment.segment)
                        || is_whitespace_segment(&segment.segment)
                        || is_punctuation_segment(&segment.segment)
                    {
                        break;
                    }
                    new_col = new_col.saturating_sub(segment.segment.len());
                    segments.pop();
                }
            }
        }

        self.set_cursor_col(new_col.max(line_start_col));
    }

    pub fn move_word_forward(&mut self) {
        self.last_action = None;
        let current_line = self.current_line();
        if self.state.cursor_col >= current_line.len() {
            if self.state.cursor_line < self.state.lines.len().saturating_sub(1) {
                self.state.cursor_line += 1;
                self.set_cursor_col(0);
            }
            return;
        }

        let text_after_cursor = &current_line[self.state.cursor_col..];
        let segments = self.segment(text_after_cursor);
        let mut index = 0;
        let mut new_col = self.state.cursor_col;

        while let Some(segment) = segments.get(index) {
            if is_paste_marker(&segment.segment) || !is_whitespace_segment(&segment.segment) {
                break;
            }
            new_col += segment.segment.len();
            index += 1;
        }

        if let Some(first) = segments.get(index) {
            if is_paste_marker(&first.segment) {
                new_col += first.segment.len();
            } else if is_punctuation_segment(&first.segment) {
                while let Some(segment) = segments.get(index) {
                    if is_paste_marker(&segment.segment)
                        || !is_punctuation_segment(&segment.segment)
                    {
                        break;
                    }
                    new_col += segment.segment.len();
                    index += 1;
                }
            } else {
                while let Some(segment) = segments.get(index) {
                    if is_paste_marker(&segment.segment)
                        || is_whitespace_segment(&segment.segment)
                        || is_punctuation_segment(&segment.segment)
                    {
                        break;
                    }
                    new_col += segment.segment.len();
                    index += 1;
                }
            }
        }

        self.set_cursor_col(new_col);
    }

    pub fn jump_to_char(&mut self, ch: char, direction: JumpDirection) {
        self.last_action = None;
        let is_forward = matches!(direction, JumpDirection::Forward);
        let start_line = self.state.cursor_line;

        if is_forward {
            for line_index in start_line..self.state.lines.len() {
                let line = &self.state.lines[line_index];
                let search_from = if line_index == start_line {
                    next_char_end(line, self.state.cursor_col).unwrap_or(line.len())
                } else {
                    0
                };
                if let Some(relative) = line[search_from..].find(ch) {
                    self.state.cursor_line = line_index;
                    self.set_cursor_col(search_from + relative);
                    return;
                }
            }
        } else {
            for line_index in (0..=start_line).rev() {
                let line = &self.state.lines[line_index];
                let search_until = if line_index == start_line {
                    self.state.cursor_col
                } else {
                    line.len()
                };
                if let Some(index) = line[..search_until].rfind(ch) {
                    self.state.cursor_line = line_index;
                    self.set_cursor_col(index);
                    return;
                }
            }
        }
    }

    fn set_text_internal(&mut self, text: &str) -> bool {
        self.state.lines = split_lines(text);
        self.state.cursor_line = self.state.lines.len().saturating_sub(1);
        let col = self.state.lines[self.state.cursor_line].len();
        self.set_cursor_col(col);
        self.scroll_offset = 0;
        true
    }

    fn insert_text_at_cursor_internal(&mut self, text: &str) -> bool {
        if text.is_empty() {
            return false;
        }

        let normalized = normalize_text(text);
        let inserted_lines = normalized.split('\n').collect::<Vec<_>>();
        let current_line = self.current_line();
        let before_cursor = &current_line[..self.state.cursor_col];
        let after_cursor = &current_line[self.state.cursor_col..];

        if inserted_lines.len() == 1 {
            self.state.lines[self.state.cursor_line] =
                format!("{before_cursor}{normalized}{after_cursor}");
            self.set_cursor_col(self.state.cursor_col + normalized.len());
            return true;
        }

        let mut lines = Vec::new();
        lines.extend(self.state.lines[..self.state.cursor_line].iter().cloned());
        lines.push(format!("{}{}", before_cursor, inserted_lines[0]));
        for middle in inserted_lines
            .iter()
            .skip(1)
            .take(inserted_lines.len().saturating_sub(2))
        {
            lines.push((*middle).to_string());
        }
        let last_inserted = inserted_lines.last().copied().unwrap_or("");
        lines.push(format!("{last_inserted}{after_cursor}"));
        lines.extend(
            self.state.lines[self.state.cursor_line + 1..]
                .iter()
                .cloned(),
        );

        self.state.lines = lines;
        self.state.cursor_line += inserted_lines.len() - 1;
        self.set_cursor_col(last_inserted.len());
        true
    }

    fn insert_character(&mut self, text: &str) -> bool {
        if text.is_empty() {
            return false;
        }

        self.history_index = None;
        if text.chars().any(is_whitespace_char) || self.last_action != Some(LastAction::TypeWord) {
            self.push_undo_snapshot();
        }
        self.last_action = Some(LastAction::TypeWord);
        self.insert_text_at_cursor_internal(text)
    }

    fn submit_value(&mut self) -> Vec<EditorEvent> {
        let result = self.expanded_text().trim().to_string();
        self.state = EditorState::default();
        self.pastes.clear();
        self.paste_counter = 0;
        self.history_index = None;
        self.scroll_offset = 0;
        self.undo_stack.clear();
        self.last_action = None;
        self.preferred_visual_col = None;
        self.snapped_from_cursor_col = None;
        vec![
            EditorEvent::Changed(String::new()),
            EditorEvent::Submitted(result),
        ]
    }

    fn navigate_history(&mut self, direction: isize) -> bool {
        self.last_action = None;
        if self.history.is_empty() {
            return false;
        }

        let new_index = match (self.history_index, direction) {
            (None, -1) => Some(0),
            (None, 1) => return false,
            (Some(index), -1) if index + 1 < self.history.len() => Some(index + 1),
            (Some(_), -1) => return false,
            (Some(0), 1) => None,
            (Some(index), 1) => Some(index - 1),
            _ => return false,
        };

        if self.history_index.is_none() && new_index.is_some() {
            self.push_undo_snapshot();
        }
        self.history_index = new_index;
        let text = self
            .history_index
            .and_then(|index| self.history.get(index))
            .cloned()
            .unwrap_or_default();
        self.set_text_internal(&text)
    }

    fn is_empty(&self) -> bool {
        self.state.lines.len() == 1 && self.state.lines[0].is_empty()
    }

    fn is_on_first_visual_line(&self) -> bool {
        let visual_lines = self.build_visual_line_map(self.last_width);
        self.find_current_visual_line(&visual_lines) == 0
    }

    fn is_on_last_visual_line(&self) -> bool {
        let visual_lines = self.build_visual_line_map(self.last_width);
        self.find_current_visual_line(&visual_lines) == visual_lines.len().saturating_sub(1)
    }

    fn current_line(&self) -> String {
        self.state
            .lines
            .get(self.state.cursor_line)
            .cloned()
            .unwrap_or_default()
    }

    fn char_before_cursor(&self) -> Option<char> {
        let line = self.state.lines.get(self.state.cursor_line)?;
        line[..self.state.cursor_col].chars().next_back()
    }

    fn valid_paste_ids(&self) -> HashSet<usize> {
        self.pastes.keys().copied().collect()
    }

    fn segment(&self, text: &str) -> Vec<TextSegment> {
        segment_with_markers(text, &self.valid_paste_ids())
    }

    fn line_hidden_prefix_length(&self, _line_index: usize, _line: &str) -> usize {
        0
    }

    fn set_cursor_col(&mut self, col: usize) {
        let line = self.current_line();
        self.state.cursor_col = floor_char_boundary(&line, col.min(line.len()));
        self.preferred_visual_col = None;
        self.snapped_from_cursor_col = None;
    }

    fn move_to_visual_line(
        &mut self,
        visual_lines: &[VisualLine],
        current_visual_line: usize,
        target_visual_line: usize,
    ) {
        let Some(current_visual) = visual_lines.get(current_visual_line).copied() else {
            return;
        };
        let Some(target_visual) = visual_lines.get(target_visual_line).copied() else {
            return;
        };

        let current_visual_col = if let Some(snapped_col) = self.snapped_from_cursor_col {
            let visual_index =
                self.find_visual_line_at(visual_lines, current_visual.logical_line, snapped_col);
            snapped_col.saturating_sub(visual_lines[visual_index].start_col)
        } else {
            self.state
                .cursor_col
                .saturating_sub(current_visual.start_col)
        };

        let is_last_source_segment = current_visual_line == visual_lines.len().saturating_sub(1)
            || visual_lines
                .get(current_visual_line + 1)
                .is_none_or(|next| next.logical_line != current_visual.logical_line);
        let source_max_visual_col = if is_last_source_segment {
            current_visual.length
        } else {
            current_visual.length.saturating_sub(1)
        };

        let is_last_target_segment = target_visual_line == visual_lines.len().saturating_sub(1)
            || visual_lines
                .get(target_visual_line + 1)
                .is_none_or(|next| next.logical_line != target_visual.logical_line);
        let target_max_visual_col = if is_last_target_segment {
            target_visual.length
        } else {
            target_visual.length.saturating_sub(1)
        };

        let move_to_visual_col = self.compute_vertical_move_column(
            current_visual_col,
            source_max_visual_col,
            target_max_visual_col,
        );
        self.state.cursor_line = target_visual.logical_line;
        let target_col = target_visual.start_col + move_to_visual_col;
        let logical_line = self.current_line();
        self.state.cursor_col =
            floor_char_boundary(&logical_line, target_col.min(logical_line.len()));

        let segments = self.segment(&logical_line);
        for segment in segments {
            if segment.index > self.state.cursor_col {
                break;
            }
            if segment.segment.len() <= 1 {
                continue;
            }
            let segment_end = segment.index + segment.segment.len();
            if self.state.cursor_col < segment_end {
                let is_continuation = segment.index < target_visual.start_col;
                let is_moving_down = target_visual_line > current_visual_line;
                if is_continuation && is_moving_down {
                    let mut next = target_visual_line + 1;
                    while next < visual_lines.len()
                        && visual_lines[next].logical_line == target_visual.logical_line
                        && visual_lines[next].start_col < segment_end
                    {
                        next += 1;
                    }
                    if next < visual_lines.len() {
                        self.move_to_visual_line(visual_lines, current_visual_line, next);
                        return;
                    }
                }

                self.snapped_from_cursor_col = Some(self.state.cursor_col);
                self.state.cursor_col = segment.index;
                return;
            }
        }

        self.snapped_from_cursor_col = None;
    }

    fn compute_vertical_move_column(
        &mut self,
        current_visual_col: usize,
        source_max_visual_col: usize,
        target_max_visual_col: usize,
    ) -> usize {
        let has_preferred = self.preferred_visual_col.is_some();
        let cursor_in_middle = current_visual_col < source_max_visual_col;
        let target_too_short = target_max_visual_col < current_visual_col;

        if !has_preferred || cursor_in_middle {
            if target_too_short {
                self.preferred_visual_col = Some(current_visual_col);
                return target_max_visual_col;
            }
            self.preferred_visual_col = None;
            return current_visual_col;
        }

        let preferred = self.preferred_visual_col.unwrap_or(current_visual_col);
        if target_too_short || target_max_visual_col < preferred {
            return target_max_visual_col;
        }

        self.preferred_visual_col = None;
        preferred
    }

    fn insert_yanked_text(&mut self, text: &str) {
        self.history_index = None;
        self.insert_text_at_cursor_internal(text);
    }

    fn delete_yanked_text(&mut self) {
        let Some(yanked_text) = self.kill_ring.peek().map(str::to_string) else {
            return;
        };
        let yank_lines = yanked_text.split('\n').collect::<Vec<_>>();

        if yank_lines.len() == 1 {
            let delete_len = yanked_text.len();
            let Some(start) = self.state.cursor_col.checked_sub(delete_len) else {
                return;
            };
            if !self.state.lines[self.state.cursor_line].is_char_boundary(start) {
                return;
            }
            self.state.lines[self.state.cursor_line]
                .replace_range(start..self.state.cursor_col, "");
            self.set_cursor_col(start);
            return;
        }

        let Some(start_line) = self.state.cursor_line.checked_sub(yank_lines.len() - 1) else {
            return;
        };
        let first_len = yank_lines.first().map_or(0, |line| line.len());
        let Some(start_col) = self.state.lines[start_line].len().checked_sub(first_len) else {
            return;
        };
        let after_cursor =
            self.state.lines[self.state.cursor_line][self.state.cursor_col..].to_string();
        let before_yank = self.state.lines[start_line][..start_col].to_string();
        self.state.lines.splice(
            start_line..=self.state.cursor_line,
            [format!("{before_yank}{after_cursor}")],
        );
        self.state.cursor_line = start_line;
        self.set_cursor_col(start_col);
    }

    fn push_undo_snapshot(&mut self) {
        self.undo_stack.push(&self.state);
    }

    fn is_in_slash_command_context(&self, text_before_cursor: &str) -> bool {
        self.state.cursor_line == 0 && text_before_cursor.trim_start().starts_with('/')
    }

    fn handle_jump_mode(&mut self, data: &str) -> bool {
        let Some(mode) = self.jump_mode else {
            return false;
        };
        let keybindings = get_keybindings();
        if keybindings.matches(data, "tui.editor.jumpForward")
            || keybindings.matches(data, "tui.editor.jumpBackward")
        {
            drop(keybindings);
            self.jump_mode = None;
            return true;
        }
        drop(keybindings);

        let printable = decode_printable_key(data).or_else(|| {
            data.chars()
                .next()
                .filter(|ch| is_printable_scalar(*ch))
                .map(|ch| ch.to_string())
        });

        if let Some(printable) = printable
            && let Some(ch) = printable.chars().next()
        {
            self.jump_mode = None;
            let direction = if mode == JumpMode::Forward {
                JumpDirection::Forward
            } else {
                JumpDirection::Backward
            };
            self.jump_to_char(ch, direction);
            return true;
        }

        self.jump_mode = None;
        false
    }
}

impl EditorComponent for Editor {
    fn render(&mut self, width: usize, options: EditorRenderOptions) -> Vec<String> {
        Editor::render(self, width, options)
    }

    fn get_text(&self) -> String {
        self.text()
    }

    fn set_text(&mut self, text: &str) -> Vec<EditorEvent> {
        changed_event(Editor::set_text(self, text), &self.text())
    }

    fn handle_input(&mut self, data: &str) -> Vec<EditorEvent> {
        Editor::handle_input(self, data)
    }

    fn add_to_history(&mut self, text: &str) {
        Editor::add_to_history(self, text);
    }

    fn insert_text_at_cursor(&mut self, text: &str) -> Vec<EditorEvent> {
        changed_event(Editor::insert_text_at_cursor(self, text), &self.text())
    }

    fn get_expanded_text(&self) -> String {
        self.expanded_text()
    }

    fn set_padding_x(&mut self, padding: usize) {
        Editor::set_padding_x(self, padding);
    }

    fn set_autocomplete_max_visible(&mut self, max_visible: usize) {
        Editor::set_autocomplete_max_visible(self, max_visible);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JumpDirection {
    Forward,
    Backward,
}

pub fn word_wrap_line(line: &str, max_width: usize) -> Vec<TextChunk> {
    let segments = segment_text(line);
    word_wrap_segments(line, max_width, &segments)
}

pub fn word_wrap_line_with_markers(
    line: &str,
    max_width: usize,
    valid_ids: &HashSet<usize>,
) -> Vec<TextChunk> {
    let segments = segment_with_markers(line, valid_ids);
    word_wrap_segments(line, max_width, &segments)
}

pub fn word_wrap_segments(
    line: &str,
    max_width: usize,
    segments: &[TextSegment],
) -> Vec<TextChunk> {
    if line.is_empty() || max_width == 0 {
        return vec![TextChunk {
            text: String::new(),
            start_index: 0,
            end_index: 0,
        }];
    }

    if visible_width(line) <= max_width {
        return vec![TextChunk {
            text: line.to_string(),
            start_index: 0,
            end_index: line.len(),
        }];
    }

    let mut chunks = Vec::new();
    let mut current_width = 0;
    let mut chunk_start = 0;
    let mut wrap_opp_index = None;
    let mut wrap_opp_width = 0;

    for (index, segment) in segments.iter().enumerate() {
        let grapheme = &segment.segment;
        let grapheme_width = visible_width(grapheme);
        let char_index = segment.index;
        let is_whitespace = !is_paste_marker(grapheme) && is_whitespace_segment(grapheme);

        if current_width + grapheme_width > max_width {
            if let Some(wrap_index) = wrap_opp_index {
                if current_width.saturating_sub(wrap_opp_width) + grapheme_width <= max_width {
                    chunks.push(TextChunk {
                        text: line[chunk_start..wrap_index].to_string(),
                        start_index: chunk_start,
                        end_index: wrap_index,
                    });
                    chunk_start = wrap_index;
                    current_width = current_width.saturating_sub(wrap_opp_width);
                } else if chunk_start < char_index {
                    chunks.push(TextChunk {
                        text: line[chunk_start..char_index].to_string(),
                        start_index: chunk_start,
                        end_index: char_index,
                    });
                    chunk_start = char_index;
                    current_width = 0;
                }
            } else if chunk_start < char_index {
                chunks.push(TextChunk {
                    text: line[chunk_start..char_index].to_string(),
                    start_index: chunk_start,
                    end_index: char_index,
                });
                chunk_start = char_index;
                current_width = 0;
            }
            wrap_opp_index = None;
        }

        if grapheme_width > max_width {
            let sub_segments = segment_text(grapheme);
            if sub_segments.len() <= 1 {
                chunks.push(TextChunk {
                    text: grapheme.clone(),
                    start_index: char_index,
                    end_index: char_index + grapheme.len(),
                });
                chunk_start = char_index + grapheme.len();
                current_width = 0;
                wrap_opp_index = None;
                continue;
            }

            let sub_chunks = word_wrap_segments(grapheme, max_width, &sub_segments);
            for sub_chunk in sub_chunks.iter().take(sub_chunks.len().saturating_sub(1)) {
                chunks.push(TextChunk {
                    text: sub_chunk.text.clone(),
                    start_index: char_index + sub_chunk.start_index,
                    end_index: char_index + sub_chunk.end_index,
                });
            }
            if let Some(last) = sub_chunks.last() {
                chunk_start = char_index + last.start_index;
                current_width = visible_width(&last.text);
            }
            wrap_opp_index = None;
            continue;
        }

        current_width += grapheme_width;
        let next = segments.get(index + 1);
        if is_whitespace
            && next.is_some_and(|item| {
                is_paste_marker(&item.segment) || !is_whitespace_segment(&item.segment)
            })
        {
            wrap_opp_index = next.map(|item| item.index);
            wrap_opp_width = current_width;
        }
    }

    chunks.push(TextChunk {
        text: line[chunk_start..].to_string(),
        start_index: chunk_start,
        end_index: line.len(),
    });
    chunks
}

pub fn segment_text(text: &str) -> Vec<TextSegment> {
    let mut segments = Vec::new();
    let mut index = 0;
    while index < text.len() {
        let end = next_grapheme_end(text, index);
        segments.push(TextSegment {
            segment: text[index..end].to_string(),
            index,
        });
        index = end;
    }
    segments
}

pub fn segment_with_markers(text: &str, valid_ids: &HashSet<usize>) -> Vec<TextSegment> {
    if valid_ids.is_empty() || !text.contains("[paste #") {
        return segment_text(text);
    }

    let mut segments = Vec::new();
    let mut index = 0;
    while index < text.len() {
        if let Some(marker) = parse_paste_marker_at(text, index)
            && valid_ids.contains(&marker.id)
        {
            segments.push(TextSegment {
                segment: text[index..marker.end].to_string(),
                index,
            });
            index = marker.end;
            continue;
        }

        let end = next_grapheme_end(text, index);
        segments.push(TextSegment {
            segment: text[index..end].to_string(),
            index,
        });
        index = end;
    }

    segments
}

pub fn is_paste_marker(segment: &str) -> bool {
    parse_paste_marker(segment).is_some()
}

fn changed_event(changed: bool, value: &str) -> Vec<EditorEvent> {
    if changed {
        vec![EditorEvent::Changed(value.to_string())]
    } else {
        Vec::new()
    }
}

fn normalize_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\t', "    ")
}

fn split_lines(text: &str) -> Vec<String> {
    let lines = text.split('\n').map(str::to_string).collect::<Vec<_>>();
    if lines.is_empty() {
        vec![String::new()]
    } else {
        lines
    }
}

fn clamp_autocomplete_max_visible(max_visible: usize) -> usize {
    max_visible.clamp(3, 20)
}

fn is_printable_text(value: &str) -> bool {
    !value.is_empty() && value.chars().all(is_printable_scalar)
}

fn is_printable_scalar(ch: char) -> bool {
    let code = ch as u32;
    code >= 32 && code != 0x7f && !(0x80..=0x9f).contains(&code)
}

fn starts_like_path(text: &str) -> bool {
    text.starts_with('/') || text.starts_with('~') || text.starts_with('.')
}

fn is_word_char(ch: char) -> bool {
    ch == '_' || ch.is_alphanumeric()
}

fn is_whitespace_segment(segment: &str) -> bool {
    segment.chars().any(is_whitespace_char)
}

fn is_punctuation_segment(segment: &str) -> bool {
    segment.chars().any(is_punctuation_char)
}

fn floor_char_boundary(value: &str, index: usize) -> usize {
    let mut index = index.min(value.len());
    while index > 0 && !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn next_char_end(value: &str, index: usize) -> Option<usize> {
    let index = floor_char_boundary(value, index);
    value[index..]
        .chars()
        .next()
        .map(|ch| index + ch.len_utf8())
}

fn next_char(value: &str, index: usize) -> Option<(char, usize)> {
    let ch = value.get(index..)?.chars().next()?;
    Some((ch, index + ch.len_utf8()))
}

fn next_grapheme_end(value: &str, start: usize) -> usize {
    let Some((first, mut end)) = next_char(value, start) else {
        return start;
    };

    if first == '\r'
        && let Some(('\n', next)) = next_char(value, end)
    {
        return next;
    }

    if is_regional_indicator(first) {
        if let Some((next, next_end)) = next_char(value, end)
            && is_regional_indicator(next)
        {
            return next_end;
        }
        return end;
    }

    while let Some((ch, next)) = next_char(value, end) {
        if is_combining_mark(ch)
            || is_variation_selector(ch)
            || is_emoji_modifier(ch)
            || ch == '\u{20e3}'
        {
            end = next;
            continue;
        }

        if ch == '\u{200d}' {
            end = next;
            if let Some((_, after_joiner)) = next_char(value, end) {
                end = after_joiner;
                while let Some((joined_mark, mark_end)) = next_char(value, end) {
                    if is_combining_mark(joined_mark)
                        || is_variation_selector(joined_mark)
                        || is_emoji_modifier(joined_mark)
                    {
                        end = mark_end;
                    } else {
                        break;
                    }
                }
            }
            continue;
        }

        break;
    }

    end
}

fn is_combining_mark(ch: char) -> bool {
    matches!(
        ch as u32,
        0x0300..=0x036f
            | 0x0483..=0x0489
            | 0x0591..=0x05bd
            | 0x05bf
            | 0x05c1..=0x05c2
            | 0x05c4..=0x05c5
            | 0x05c7
            | 0x0610..=0x061a
            | 0x064b..=0x065f
            | 0x0670
            | 0x06d6..=0x06dc
            | 0x06df..=0x06e4
            | 0x06e7..=0x06e8
            | 0x06ea..=0x06ed
            | 0x0711
            | 0x0730..=0x074a
            | 0x07a6..=0x07b0
            | 0x07eb..=0x07f3
            | 0x0816..=0x0819
            | 0x081b..=0x0823
            | 0x0825..=0x0827
            | 0x0829..=0x082d
            | 0x0859..=0x085b
            | 0x08d3..=0x0903
            | 0x093a
            | 0x093c
            | 0x0941..=0x0948
            | 0x094d
            | 0x0951..=0x0957
            | 0x0962..=0x0963
            | 0x0981
            | 0x09bc
            | 0x09c1..=0x09c4
            | 0x09cd
            | 0x0a01..=0x0a02
            | 0x0a3c
            | 0x0a41..=0x0a42
            | 0x0a47..=0x0a48
            | 0x0a4b..=0x0a4d
            | 0x0a51
            | 0x0a70..=0x0a71
            | 0x0a75
            | 0x0a81..=0x0a82
            | 0x0abc
            | 0x0ac1..=0x0ac5
            | 0x0ac7..=0x0ac8
            | 0x0acd
            | 0x0ae2..=0x0ae3
            | 0x0afa..=0x0aff
            | 0x0b01
            | 0x0b3c
            | 0x0b3f
            | 0x0b41..=0x0b44
            | 0x0b4d
            | 0x0b55..=0x0b56
            | 0x0b62..=0x0b63
            | 0x0b82
            | 0x0bc0
            | 0x0bcd
            | 0x0c00
            | 0x0c04
            | 0x0c3e..=0x0c40
            | 0x0c46..=0x0c48
            | 0x0c4a..=0x0c4d
            | 0x0c55..=0x0c56
            | 0x0c62..=0x0c63
            | 0x0c81
            | 0x0cbc
            | 0x0cbf
            | 0x0cc6
            | 0x0ccc..=0x0ccd
            | 0x0ce2..=0x0ce3
            | 0x0d00..=0x0d01
            | 0x0d3b..=0x0d3c
            | 0x0d41..=0x0d44
            | 0x0d4d
            | 0x0d62..=0x0d63
            | 0x0d81
            | 0x0dca
            | 0x0dd2..=0x0dd4
            | 0x0dd6
            | 0x0e31
            | 0x0e34..=0x0e3a
            | 0x0e47..=0x0e4e
            | 0x0eb1
            | 0x0eb4..=0x0ebc
            | 0x0ec8..=0x0ecd
            | 0x0f18..=0x0f19
            | 0x0f35
            | 0x0f37
            | 0x0f39
            | 0x0f71..=0x0f7e
            | 0x0f80..=0x0f84
            | 0x0f86..=0x0f87
            | 0x0f8d..=0x0fbc
            | 0x102d..=0x1030
            | 0x1032..=0x1037
            | 0x1039..=0x103a
            | 0x103d..=0x103e
            | 0x1058..=0x1059
            | 0x105e..=0x1060
            | 0x1071..=0x1074
            | 0x1082
            | 0x1085..=0x1086
            | 0x108d
            | 0x109d
            | 0x135d..=0x135f
            | 0x1712..=0x1714
            | 0x1732..=0x1734
            | 0x1752..=0x1753
            | 0x1772..=0x1773
            | 0x17b4..=0x17b5
            | 0x17b7..=0x17bd
            | 0x17c6
            | 0x17c9..=0x17d3
            | 0x17dd
            | 0x180b..=0x180d
            | 0x1885..=0x1886
            | 0x18a9
            | 0x1920..=0x1922
            | 0x1927..=0x1928
            | 0x1932
            | 0x1939..=0x193b
            | 0x1a17..=0x1a18
            | 0x1a1b
            | 0x1a56
            | 0x1a58..=0x1a5e
            | 0x1a60
            | 0x1a62
            | 0x1a65..=0x1a6c
            | 0x1a73..=0x1a7c
            | 0x1a7f
            | 0x1ab0..=0x1aff
            | 0x1dc0..=0x1dff
            | 0x20d0..=0x20ff
            | 0xfe20..=0xfe2f
    )
}

fn is_variation_selector(ch: char) -> bool {
    matches!(ch as u32, 0xfe00..=0xfe0f | 0xe0100..=0xe01ef)
}

fn is_emoji_modifier(ch: char) -> bool {
    matches!(ch as u32, 0x1f3fb..=0x1f3ff)
}

fn is_regional_indicator(ch: char) -> bool {
    matches!(ch as u32, 0x1f1e6..=0x1f1ff)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PasteMarker {
    id: usize,
    end: usize,
}

fn parse_paste_marker_at(text: &str, start: usize) -> Option<PasteMarker> {
    let rest = text.get(start..)?;
    let end_offset = rest.find(']')? + 1;
    let candidate = &rest[..end_offset];
    let id = parse_paste_marker(candidate)?;
    Some(PasteMarker {
        id,
        end: start + end_offset,
    })
}

fn parse_paste_marker(text: &str) -> Option<usize> {
    let inner = text.strip_prefix("[paste #")?.strip_suffix(']')?;
    let digit_len = inner.bytes().take_while(u8::is_ascii_digit).count();
    if digit_len == 0 {
        return None;
    }

    let id = inner[..digit_len].parse::<usize>().ok()?;
    let suffix = &inner[digit_len..];
    if suffix.is_empty() || valid_paste_marker_suffix(suffix) {
        Some(id)
    } else {
        None
    }
}

fn valid_paste_marker_suffix(suffix: &str) -> bool {
    let Some(detail) = suffix.strip_prefix(' ') else {
        return false;
    };
    if let Some(lines) = detail
        .strip_prefix('+')
        .and_then(|item| item.strip_suffix(" lines"))
    {
        return !lines.is_empty() && lines.bytes().all(|byte| byte.is_ascii_digit());
    }
    if let Some(chars) = detail.strip_suffix(" chars") {
        return !chars.is_empty() && chars.bytes().all(|byte| byte.is_ascii_digit());
    }
    false
}

fn expand_paste_markers(text: &str, pastes: &HashMap<usize, String>) -> String {
    if pastes.is_empty() || !text.contains("[paste #") {
        return text.to_string();
    }

    let mut result = String::new();
    let mut index = 0;
    while index < text.len() {
        if let Some(marker) = parse_paste_marker_at(text, index)
            && let Some(content) = pastes.get(&marker.id)
        {
            result.push_str(content);
            index = marker.end;
            continue;
        }

        let Some((ch, next)) = next_char(text, index) else {
            break;
        };
        result.push(ch);
        index = next;
    }

    result
}

fn decode_paste_control_sequences(text: &str) -> String {
    let mut result = String::new();
    let mut index = 0;
    while index < text.len() {
        let rest = &text[index..];
        if let Some(sequence) = rest.strip_prefix("\x1b[")
            && let Some(end) = sequence.find('u')
        {
            let body = &sequence[..end];
            if let Some(code) = body
                .strip_suffix(";5")
                .and_then(|value| value.parse::<u32>().ok())
                && ((65..=90).contains(&code) || (97..=122).contains(&code))
            {
                let control = char::from_u32(if code >= 97 { code - 96 } else { code - 64 });
                if let Some(control) = control {
                    result.push(control);
                    index += 2 + end + 1;
                    continue;
                }
            }
        }

        let Some((ch, next)) = next_char(text, index) else {
            break;
        };
        result.push(ch);
        index = next;
    }
    result
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RenderedCursor {
    text: String,
    visible_width: usize,
}

fn render_cursor(text: &str, cursor_pos: usize, focused: bool) -> RenderedCursor {
    let cursor_pos = floor_char_boundary(text, cursor_pos.min(text.len()));
    let before = &text[..cursor_pos];
    let after = &text[cursor_pos..];
    let marker = if focused { CURSOR_MARKER } else { "" };

    if after.is_empty() {
        let rendered = format!("{before}{marker}\x1b[7m \x1b[27m");
        return RenderedCursor {
            text: rendered,
            visible_width: visible_width(text) + 1,
        };
    }

    let segments = segment_text(after);
    let first = segments
        .first()
        .map_or("", |segment| segment.segment.as_str());
    let rest = &after[first.len()..];
    let rendered = format!("{before}{marker}\x1b[7m{first}\x1b[27m{rest}");
    RenderedCursor {
        text: rendered,
        visible_width: visible_width(text),
    }
}

fn fit_line_to_width(line: &str, width: usize) -> String {
    let line = if visible_width(line) > width {
        truncate_to_width(line, width, "", false)
    } else {
        line.to_string()
    };
    let padding = " ".repeat(width.saturating_sub(visible_width(&line)));
    format!("{line}{padding}")
}

fn border_line(width: usize, count: usize, top: bool) -> String {
    if count == 0 {
        return "-".repeat(width);
    }

    let indicator = if top {
        format!("--- ^ {count} more ")
    } else {
        format!("--- v {count} more ")
    };
    fit_line_to_width(&format!("{indicator}{}", "-".repeat(width)), width)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk_text(chunks: &[TextChunk]) -> Vec<String> {
        chunks.iter().map(|chunk| chunk.text.clone()).collect()
    }

    #[test]
    fn editor_word_wrap_prefers_word_boundaries_and_breaks_long_words() {
        let chunks = word_wrap_line("alpha beta gamma", 10);
        assert_eq!(chunk_text(&chunks), vec!["alpha ", "beta gamma"]);
        assert_eq!(
            chunks,
            vec![
                TextChunk {
                    text: "alpha ".to_string(),
                    start_index: 0,
                    end_index: 6,
                },
                TextChunk {
                    text: "beta gamma".to_string(),
                    start_index: 6,
                    end_index: "alpha beta gamma".len(),
                },
            ]
        );

        let long = word_wrap_line("abcdef", 3);
        assert_eq!(chunk_text(&long), vec!["abc", "def"]);
    }

    #[test]
    fn editor_word_wrap_accounts_for_wide_text() {
        let chunks = word_wrap_line("a界b", 2);
        assert_eq!(chunk_text(&chunks), vec!["a", "界", "b"]);
        assert!(chunks.iter().all(|chunk| visible_width(&chunk.text) <= 2));
    }

    #[test]
    fn editor_segments_valid_paste_markers_as_atomic_chunks() {
        let marker = "[paste #7 +12 lines]";
        let mut ids = HashSet::new();
        ids.insert(7);

        let segments = segment_with_markers(marker, &ids);
        assert_eq!(
            segments,
            vec![TextSegment {
                segment: marker.to_string(),
                index: 0,
            }]
        );
        assert!(is_paste_marker(marker));

        let visual_chunks = word_wrap_line_with_markers(marker, 8, &ids);
        assert_eq!(visual_chunks.first().unwrap().start_index, 0);
        assert_eq!(visual_chunks.last().unwrap().end_index, marker.len());
        assert!(visual_chunks.len() > 1);
    }

    #[test]
    fn editor_large_paste_inserts_marker_and_expands_on_read() {
        let pasted = (0..12)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let mut editor = Editor::new();

        assert!(editor.handle_paste(&pasted));
        assert_eq!(editor.text(), "[paste #1 +12 lines]");
        assert_eq!(editor.expanded_text(), pasted);
        assert!(editor.backspace());
        assert_eq!(editor.text(), "");
    }

    #[test]
    fn editor_tracks_cursor_line_and_column_for_multiline_text() {
        let mut editor = Editor::new();

        assert!(editor.set_text("hello\nworld"));
        assert_eq!(editor.cursor(), CursorPosition { line: 1, col: 5 });
        editor.move_cursor(0, -1);
        assert_eq!(editor.cursor(), CursorPosition { line: 1, col: 4 });
        editor.move_to_line_start();
        assert_eq!(editor.cursor(), CursorPosition { line: 1, col: 0 });
        editor.move_cursor(0, -1);
        assert_eq!(editor.cursor(), CursorPosition { line: 0, col: 5 });
    }

    #[test]
    fn editor_insert_delete_move_and_undo_are_state_operations() {
        let mut editor = Editor::new();

        assert!(editor.insert_text_at_cursor("abc"));
        editor.move_cursor(0, -1);
        assert!(editor.insert_text_at_cursor("X"));
        assert_eq!(editor.text(), "abXc");
        assert_eq!(editor.cursor().col, 3);
        assert!(editor.backspace());
        assert_eq!(editor.text(), "abc");
        editor.move_to_line_end();
        assert!(editor.add_new_line());
        assert!(editor.insert_text_at_cursor("next"));
        assert_eq!(editor.text(), "abc\nnext");
        editor.move_to_line_start();
        assert!(editor.backspace());
        assert_eq!(editor.text(), "abcnext");
        assert!(editor.undo());
        assert_eq!(editor.text(), "abc\nnext");
    }

    #[test]
    fn editor_history_navigation_is_deterministic() {
        let mut editor = Editor::new();
        editor.add_to_history("first");
        editor.add_to_history("second");
        editor.add_to_history("second");

        assert_eq!(
            editor.history(),
            &["second".to_string(), "first".to_string()]
        );
        assert!(editor.navigate_history_up());
        assert_eq!(editor.text(), "second");
        assert!(editor.navigate_history_up());
        assert_eq!(editor.text(), "first");
        assert!(editor.navigate_history_down());
        assert_eq!(editor.text(), "second");
        assert!(editor.navigate_history_down());
        assert_eq!(editor.text(), "");
    }

    #[test]
    fn editor_layout_maps_cursor_and_wraps_to_width() {
        let mut editor = Editor::new();
        editor.set_text("alpha beta gamma");
        editor.set_cursor(0, "alpha beta".len());

        let layout = editor.layout_text(8);
        assert_eq!(layout.len(), 3);
        assert_eq!(layout[1].text, "beta ");
        assert!(layout[1].has_cursor);
        assert_eq!(layout[1].cursor_pos, Some("beta".len()));

        let visual = editor.build_visual_line_map(8);
        assert_eq!(
            visual,
            vec![
                VisualLine {
                    logical_line: 0,
                    start_col: 0,
                    length: 6,
                },
                VisualLine {
                    logical_line: 0,
                    start_col: 6,
                    length: 5,
                },
                VisualLine {
                    logical_line: 0,
                    start_col: 11,
                    length: 5,
                },
            ]
        );
        assert_eq!(editor.find_current_visual_line(&visual), 1);
    }

    #[test]
    fn editor_render_respects_width_and_includes_cursor_marker_when_focused() {
        let mut editor = Editor::with_options(EditorOptions {
            padding_x: 1,
            autocomplete_max_visible: 5,
        });
        editor.set_prompt_prefix("> ");
        editor.set_text("alpha beta gamma");
        editor.set_cursor(0, "alpha".len());

        let lines = editor.render(
            12,
            EditorRenderOptions {
                terminal_rows: 20,
                focused: true,
            },
        );

        assert!(lines.iter().all(|line| visible_width(line) == 12));
        assert!(lines.iter().any(|line| line.contains(CURSOR_MARKER)));
    }

    #[test]
    fn editor_handle_input_returns_events_instead_of_callbacks() {
        let mut editor = Editor::new();

        assert_eq!(
            editor.handle_input("abc"),
            vec![EditorEvent::Changed("abc".to_string())]
        );
        assert_eq!(
            editor.handle_input("\n"),
            vec![EditorEvent::Changed("abc\n".to_string())]
        );
        assert_eq!(
            editor.handle_input("def"),
            vec![EditorEvent::Changed("abc\ndef".to_string())]
        );
        assert_eq!(
            editor.handle_input("\r"),
            vec![
                EditorEvent::Changed(String::new()),
                EditorEvent::Submitted("abc\ndef".to_string()),
            ]
        );
    }
}
