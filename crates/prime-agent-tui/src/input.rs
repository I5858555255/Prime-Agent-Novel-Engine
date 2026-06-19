use crate::keybindings::get_keybindings;
use crate::keys::decode_printable_key;
use crate::kill_ring::{KillRing, KillRingPushOptions};
use crate::undo_stack::UndoStack;
use crate::utils::{is_punctuation_char, is_whitespace_char, slice_by_column, visible_width};

pub const CURSOR_MARKER: &str = "\x1b_pi:c\x07";
const PASTE_START: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputEvent {
    Changed(String),
    Submitted(String),
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InputState {
    value: String,
    cursor: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LastAction {
    Kill,
    Yank,
    TypeWord,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Input {
    value: String,
    cursor: usize,
    prompt: String,
    placeholder: Option<String>,
    focused: bool,
    paste_buffer: String,
    is_in_paste: bool,
    kill_ring: KillRing,
    last_action: Option<LastAction>,
    undo_stack: UndoStack<InputState>,
}

impl Default for Input {
    fn default() -> Self {
        Self::new()
    }
}

impl Input {
    pub fn new() -> Self {
        Self {
            value: String::new(),
            cursor: 0,
            prompt: "> ".to_string(),
            placeholder: None,
            focused: false,
            paste_buffer: String::new(),
            is_in_paste: false,
            kill_ring: KillRing::new(),
            last_action: None,
            undo_stack: UndoStack::new(),
        }
    }

    pub fn with_value(value: impl Into<String>) -> Self {
        let mut input = Self::new();
        input.set_value(value);
        input.move_to_end();
        input
    }

    pub fn with_placeholder(placeholder: impl Into<String>) -> Self {
        let mut input = Self::new();
        input.placeholder = Some(placeholder.into());
        input
    }

    pub fn value(&self) -> &str {
        &self.value
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub fn prompt(&self) -> &str {
        &self.prompt
    }

    pub fn placeholder(&self) -> Option<&str> {
        self.placeholder.as_deref()
    }

    pub fn is_focused(&self) -> bool {
        self.focused
    }

    pub fn set_value(&mut self, value: impl Into<String>) {
        self.value = value.into();
        self.cursor = floor_char_boundary(&self.value, self.cursor.min(self.value.len()));
        self.last_action = None;
        self.undo_stack.clear();
    }

    pub fn set_cursor(&mut self, cursor: usize) {
        self.cursor = floor_char_boundary(&self.value, cursor.min(self.value.len()));
        self.last_action = None;
    }

    pub fn set_prompt(&mut self, prompt: impl Into<String>) {
        self.prompt = prompt.into();
    }

    pub fn set_placeholder(&mut self, placeholder: Option<impl Into<String>>) {
        self.placeholder = placeholder.map(Into::into);
    }

    pub fn set_focused(&mut self, focused: bool) {
        self.focused = focused;
    }

    pub fn handle_input(&mut self, data: &str) -> Vec<InputEvent> {
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

            let mut events = Vec::new();
            if self.handle_paste(&paste_content) {
                events.push(InputEvent::Changed(self.value.clone()));
            }
            if !remaining.is_empty() {
                events.extend(self.handle_input(&remaining));
            }
            return events;
        }

        let action = {
            let keybindings = get_keybindings();
            InputKeyAction {
                cancel: keybindings.matches(data, "tui.select.cancel"),
                undo: keybindings.matches(data, "tui.editor.undo"),
                submit: keybindings.matches(data, "tui.input.submit") || data == "\n",
                delete_backward: keybindings.matches(data, "tui.editor.deleteCharBackward"),
                delete_forward: keybindings.matches(data, "tui.editor.deleteCharForward"),
                delete_word_backward: keybindings.matches(data, "tui.editor.deleteWordBackward"),
                delete_word_forward: keybindings.matches(data, "tui.editor.deleteWordForward"),
                delete_to_line_start: keybindings.matches(data, "tui.editor.deleteToLineStart"),
                delete_to_line_end: keybindings.matches(data, "tui.editor.deleteToLineEnd"),
                yank: keybindings.matches(data, "tui.editor.yank"),
                yank_pop: keybindings.matches(data, "tui.editor.yankPop"),
                cursor_left: keybindings.matches(data, "tui.editor.cursorLeft"),
                cursor_right: keybindings.matches(data, "tui.editor.cursorRight"),
                cursor_line_start: keybindings.matches(data, "tui.editor.cursorLineStart"),
                cursor_line_end: keybindings.matches(data, "tui.editor.cursorLineEnd"),
                cursor_word_left: keybindings.matches(data, "tui.editor.cursorWordLeft"),
                cursor_word_right: keybindings.matches(data, "tui.editor.cursorWordRight"),
            }
        };

        if action.cancel {
            return vec![InputEvent::Cancelled];
        }
        if action.undo {
            return changed_event(self.undo(), &self.value);
        }
        if action.submit {
            return vec![InputEvent::Submitted(self.value.clone())];
        }
        if action.delete_backward {
            return changed_event(self.backspace(), &self.value);
        }
        if action.delete_forward {
            return changed_event(self.delete_forward(), &self.value);
        }
        if action.delete_word_backward {
            return changed_event(self.delete_word_backward(), &self.value);
        }
        if action.delete_word_forward {
            return changed_event(self.delete_word_forward(), &self.value);
        }
        if action.delete_to_line_start {
            return changed_event(self.delete_to_line_start(), &self.value);
        }
        if action.delete_to_line_end {
            return changed_event(self.delete_to_line_end(), &self.value);
        }
        if action.yank {
            return changed_event(self.yank(), &self.value);
        }
        if action.yank_pop {
            return changed_event(self.yank_pop(), &self.value);
        }
        if action.cursor_left {
            self.move_left();
            return Vec::new();
        }
        if action.cursor_right {
            self.move_right();
            return Vec::new();
        }
        if action.cursor_line_start {
            self.move_to_start();
            return Vec::new();
        }
        if action.cursor_line_end {
            self.move_to_end();
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

        if let Some(printable) = decode_printable_key(data) {
            return changed_event(self.insert_text(&printable), &self.value);
        }

        if is_printable_text(data) {
            return changed_event(self.insert_text(data), &self.value);
        }

        Vec::new()
    }

    pub fn insert_text(&mut self, text: &str) -> bool {
        if text.is_empty() {
            return false;
        }

        if text.chars().any(is_whitespace_char) || self.last_action != Some(LastAction::TypeWord) {
            self.push_undo();
        }
        self.last_action = Some(LastAction::TypeWord);
        self.value.insert_str(self.cursor, text);
        self.cursor += text.len();
        true
    }

    pub fn backspace(&mut self) -> bool {
        self.last_action = None;
        let Some(previous) = previous_char_start(&self.value, self.cursor) else {
            return false;
        };
        self.push_undo();
        self.value.replace_range(previous..self.cursor, "");
        self.cursor = previous;
        true
    }

    pub fn delete_forward(&mut self) -> bool {
        self.last_action = None;
        let Some(next) = next_char_end(&self.value, self.cursor) else {
            return false;
        };
        self.push_undo();
        self.value.replace_range(self.cursor..next, "");
        true
    }

    pub fn delete_to_line_start(&mut self) -> bool {
        if self.cursor == 0 {
            return false;
        }
        self.push_undo();
        let deleted = self.value[..self.cursor].to_string();
        self.kill_ring.push(
            &deleted,
            KillRingPushOptions {
                prepend: true,
                accumulate: self.last_action == Some(LastAction::Kill),
            },
        );
        self.value.replace_range(..self.cursor, "");
        self.cursor = 0;
        self.last_action = Some(LastAction::Kill);
        true
    }

    pub fn delete_to_line_end(&mut self) -> bool {
        if self.cursor >= self.value.len() {
            return false;
        }
        self.push_undo();
        let deleted = self.value[self.cursor..].to_string();
        self.kill_ring.push(
            &deleted,
            KillRingPushOptions {
                prepend: false,
                accumulate: self.last_action == Some(LastAction::Kill),
            },
        );
        self.value.truncate(self.cursor);
        self.last_action = Some(LastAction::Kill);
        true
    }

    pub fn delete_word_backward(&mut self) -> bool {
        if self.cursor == 0 {
            return false;
        }
        let was_kill = self.last_action == Some(LastAction::Kill);
        self.push_undo();
        let old_cursor = self.cursor;
        self.move_word_backward();
        let delete_from = self.cursor;
        self.cursor = old_cursor;

        let deleted = self.value[delete_from..self.cursor].to_string();
        self.kill_ring.push(
            &deleted,
            KillRingPushOptions {
                prepend: true,
                accumulate: was_kill,
            },
        );
        self.value.replace_range(delete_from..self.cursor, "");
        self.cursor = delete_from;
        self.last_action = Some(LastAction::Kill);
        true
    }

    pub fn delete_word_forward(&mut self) -> bool {
        if self.cursor >= self.value.len() {
            return false;
        }
        let was_kill = self.last_action == Some(LastAction::Kill);
        self.push_undo();
        let old_cursor = self.cursor;
        self.move_word_forward();
        let delete_to = self.cursor;
        self.cursor = old_cursor;

        let deleted = self.value[self.cursor..delete_to].to_string();
        self.kill_ring.push(
            &deleted,
            KillRingPushOptions {
                prepend: false,
                accumulate: was_kill,
            },
        );
        self.value.replace_range(self.cursor..delete_to, "");
        self.last_action = Some(LastAction::Kill);
        true
    }

    pub fn yank(&mut self) -> bool {
        let Some(text) = self.kill_ring.peek().map(str::to_string) else {
            return false;
        };
        self.push_undo();
        self.value.insert_str(self.cursor, &text);
        self.cursor += text.len();
        self.last_action = Some(LastAction::Yank);
        true
    }

    pub fn yank_pop(&mut self) -> bool {
        if self.last_action != Some(LastAction::Yank) || self.kill_ring.len() <= 1 {
            return false;
        }

        let previous_text = self.kill_ring.peek().unwrap_or("").to_string();
        let Some(start) = self.cursor.checked_sub(previous_text.len()) else {
            return false;
        };
        if !self.value.is_char_boundary(start) || !self.value.is_char_boundary(self.cursor) {
            return false;
        }

        self.push_undo();
        self.value.replace_range(start..self.cursor, "");
        self.cursor = start;
        self.kill_ring.rotate();

        let text = self.kill_ring.peek().unwrap_or("").to_string();
        self.value.insert_str(self.cursor, &text);
        self.cursor += text.len();
        self.last_action = Some(LastAction::Yank);
        true
    }

    pub fn undo(&mut self) -> bool {
        let Some(snapshot) = self.undo_stack.pop() else {
            return false;
        };
        self.value = snapshot.value;
        self.cursor = snapshot.cursor;
        self.last_action = None;
        true
    }

    pub fn move_left(&mut self) {
        self.last_action = None;
        if let Some(previous) = previous_char_start(&self.value, self.cursor) {
            self.cursor = previous;
        }
    }

    pub fn move_right(&mut self) {
        self.last_action = None;
        if let Some(next) = next_char_end(&self.value, self.cursor) {
            self.cursor = next;
        }
    }

    pub fn move_to_start(&mut self) {
        self.last_action = None;
        self.cursor = 0;
    }

    pub fn move_to_end(&mut self) {
        self.last_action = None;
        self.cursor = self.value.len();
    }

    pub fn move_word_backward(&mut self) {
        if self.cursor == 0 {
            return;
        }

        self.last_action = None;
        while let Some((start, ch)) = previous_char(&self.value, self.cursor) {
            if !is_whitespace_char(ch) {
                break;
            }
            self.cursor = start;
        }

        let Some((_, first)) = previous_char(&self.value, self.cursor) else {
            return;
        };
        let skip_punctuation = is_punctuation_char(first);
        while let Some((start, ch)) = previous_char(&self.value, self.cursor) {
            let in_run = if skip_punctuation {
                is_punctuation_char(ch)
            } else {
                !is_whitespace_char(ch) && !is_punctuation_char(ch)
            };
            if !in_run {
                break;
            }
            self.cursor = start;
        }
    }

    pub fn move_word_forward(&mut self) {
        if self.cursor >= self.value.len() {
            return;
        }

        self.last_action = None;
        while let Some((end, ch)) = next_char(&self.value, self.cursor) {
            if !is_whitespace_char(ch) {
                break;
            }
            self.cursor = end;
        }

        let Some((_, first)) = next_char(&self.value, self.cursor) else {
            return;
        };
        let skip_punctuation = is_punctuation_char(first);
        while let Some((end, ch)) = next_char(&self.value, self.cursor) {
            let in_run = if skip_punctuation {
                is_punctuation_char(ch)
            } else {
                !is_whitespace_char(ch) && !is_punctuation_char(ch)
            };
            if !in_run {
                break;
            }
            self.cursor = end;
        }
    }

    pub fn render(&self, width: usize) -> Vec<String> {
        let prompt_width = visible_width(&self.prompt);
        if width <= prompt_width {
            return vec![self.prompt.clone()];
        }

        let available_width = width - prompt_width;
        let showing_placeholder = self.value.is_empty() && self.placeholder.is_some();
        let placeholder_display;
        let display_text = if showing_placeholder {
            placeholder_display = format!(" {}", self.placeholder.as_deref().unwrap_or(""));
            placeholder_display.as_str()
        } else {
            &self.value
        };
        let display_cursor = if showing_placeholder { 0 } else { self.cursor };

        let total_width = visible_width(display_text);
        let (visible_text, cursor_display) = if total_width < available_width {
            (display_text.to_string(), display_cursor)
        } else {
            let scroll_width = if display_cursor == display_text.len() {
                available_width.saturating_sub(1)
            } else {
                available_width
            };
            let cursor_col = visible_width(&display_text[..display_cursor]);
            if scroll_width > 0 {
                let half_width = scroll_width / 2;
                let start_col = if cursor_col < half_width {
                    0
                } else if cursor_col > total_width.saturating_sub(half_width) {
                    total_width.saturating_sub(scroll_width)
                } else {
                    cursor_col.saturating_sub(half_width)
                };
                let visible_text = slice_by_column(display_text, start_col, scroll_width, true);
                let before_cursor = slice_by_column(
                    display_text,
                    start_col,
                    cursor_col.saturating_sub(start_col),
                    true,
                );
                (visible_text, before_cursor.len())
            } else {
                (String::new(), 0)
            }
        };

        let cursor_display = floor_char_boundary(&visible_text, cursor_display);
        let before_cursor = &visible_text[..cursor_display];
        let (at_cursor, after_cursor_start) = next_char(&visible_text, cursor_display)
            .map_or((" ".to_string(), cursor_display), |(end, ch)| {
                (ch.to_string(), end)
            });
        let after_cursor = &visible_text[after_cursor_start..];
        let marker = if self.focused { CURSOR_MARKER } else { "" };
        let cursor_char = format!("\x1b[7m{at_cursor}\x1b[27m");
        let text_with_cursor = format!("{before_cursor}{marker}{cursor_char}{after_cursor}");
        let visual_length = visible_width(&text_with_cursor);
        let padding = " ".repeat(available_width.saturating_sub(visual_length));

        vec![format!("{}{text_with_cursor}{padding}", self.prompt)]
    }

    fn push_undo(&mut self) {
        self.undo_stack.push(&InputState {
            value: self.value.clone(),
            cursor: self.cursor,
        });
    }

    fn handle_paste(&mut self, pasted_text: &str) -> bool {
        self.last_action = None;
        self.push_undo();
        let clean_text = pasted_text
            .replace("\r\n", "")
            .replace(['\r', '\n'], "")
            .replace('\t', "    ");
        if clean_text.is_empty() {
            return false;
        }
        self.value.insert_str(self.cursor, &clean_text);
        self.cursor += clean_text.len();
        true
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct InputKeyAction {
    cancel: bool,
    undo: bool,
    submit: bool,
    delete_backward: bool,
    delete_forward: bool,
    delete_word_backward: bool,
    delete_word_forward: bool,
    delete_to_line_start: bool,
    delete_to_line_end: bool,
    yank: bool,
    yank_pop: bool,
    cursor_left: bool,
    cursor_right: bool,
    cursor_line_start: bool,
    cursor_line_end: bool,
    cursor_word_left: bool,
    cursor_word_right: bool,
}

fn changed_event(changed: bool, value: &str) -> Vec<InputEvent> {
    if changed {
        vec![InputEvent::Changed(value.to_string())]
    } else {
        Vec::new()
    }
}

fn is_printable_text(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|ch| {
            let code = ch as u32;
            code >= 32 && code != 0x7f && !(0x80..=0x9f).contains(&code)
        })
}

fn floor_char_boundary(value: &str, index: usize) -> usize {
    let mut index = index.min(value.len());
    while index > 0 && !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn previous_char_start(value: &str, index: usize) -> Option<usize> {
    let index = floor_char_boundary(value, index);
    value[..index]
        .char_indices()
        .next_back()
        .map(|(start, _)| start)
}

fn previous_char(value: &str, index: usize) -> Option<(usize, char)> {
    let index = floor_char_boundary(value, index);
    value[..index].char_indices().next_back()
}

fn next_char_end(value: &str, index: usize) -> Option<usize> {
    let index = floor_char_boundary(value, index);
    value[index..]
        .chars()
        .next()
        .map(|ch| index + ch.len_utf8())
}

fn next_char(value: &str, index: usize) -> Option<(usize, char)> {
    let index = floor_char_boundary(value, index);
    value[index..]
        .chars()
        .next()
        .map(|ch| (index + ch.len_utf8(), ch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_inserts_deletes_and_clamps_cursor_to_char_boundary() {
        let mut input = Input::with_value("aé");
        input.set_cursor(2);

        assert_eq!(input.cursor(), 1);
        input.move_to_end();
        assert!(input.backspace());

        assert_eq!(input.value(), "a");
        assert_eq!(input.cursor(), 1);
        assert!(!input.delete_forward());

        assert!(input.insert_text("bc"));
        input.move_left();
        assert!(input.insert_text("X"));
        assert_eq!(input.value(), "abXc");
        assert_eq!(input.cursor(), 3);
    }

    #[test]
    fn input_key_handling_uses_existing_keybindings_for_movement_and_backspace() {
        let mut input = Input::with_value("abc");

        assert_eq!(input.handle_input("\u{1b}[D"), Vec::<InputEvent>::new());
        assert_eq!(input.cursor(), 2);
        assert_eq!(
            input.handle_input("\u{7f}"),
            vec![InputEvent::Changed("ac".to_string())]
        );
        assert_eq!(input.value(), "ac");
        assert_eq!(input.cursor(), 1);
    }

    #[test]
    fn input_word_movement_and_word_delete_follow_whitespace_and_punctuation_runs() {
        let mut input = Input::with_value("alpha, beta");

        input.move_word_backward();
        assert_eq!(input.cursor(), "alpha, ".len());
        assert!(input.delete_word_backward());
        assert_eq!(input.value(), "alphabeta");
        assert_eq!(input.cursor(), "alpha".len());

        let mut forward = Input::with_value("alpha, beta");
        forward.move_to_start();
        forward.move_word_forward();
        assert_eq!(forward.cursor(), "alpha".len());
    }

    #[test]
    fn input_submit_cancel_and_undo_return_events_without_terminal_callbacks() {
        let mut input = Input::new();

        assert_eq!(
            input.handle_input("abc"),
            vec![InputEvent::Changed("abc".to_string())]
        );
        assert_eq!(
            input.handle_input("\u{1f}"),
            vec![InputEvent::Changed(String::new())]
        );
        assert_eq!(input.handle_input("\u{1b}"), vec![InputEvent::Cancelled]);
        assert_eq!(
            input.handle_input("\r"),
            vec![InputEvent::Submitted(String::new())]
        );
    }

    #[test]
    fn input_bracketed_paste_cleans_newlines_and_tabs() {
        let mut input = Input::new();

        let events = input.handle_input("\x1b[200~a\nb\tc\x1b[201~");

        assert_eq!(events, vec![InputEvent::Changed("ab    c".to_string())]);
        assert_eq!(input.value(), "ab    c");
        assert_eq!(input.cursor(), "ab    c".len());
    }

    #[test]
    fn input_kill_yank_and_yank_pop_use_kill_ring() {
        let mut input = Input::with_value("one two three");

        input.set_cursor("one ".len());
        assert!(input.delete_word_forward());
        assert_eq!(input.value(), "one  three");
        input.move_to_end();
        assert!(input.yank());
        assert_eq!(input.value(), "one  threetwo");

        input.set_cursor("one".len());
        assert!(input.delete_to_line_end());
        assert_eq!(input.value(), "one");
        assert!(input.yank());
        assert_eq!(input.value(), "one  threetwo");
        assert!(input.yank_pop());
        assert_eq!(input.value(), "onetwo");
    }

    #[test]
    fn input_render_pads_prompt_cursor_and_placeholder_to_width() {
        let mut input = Input::with_placeholder("hint");
        input.set_focused(true);

        let lines = input.render(10);

        assert_eq!(lines.len(), 1);
        assert!(lines[0].starts_with("> "));
        assert!(lines[0].contains(CURSOR_MARKER));
        assert!(lines[0].contains("hint"));
        assert_eq!(visible_width(&lines[0]), 10);
    }

    #[test]
    fn input_render_scrolls_to_keep_cursor_visible() {
        let input = Input::with_value("abcdefghijklmnopqrstuvwxyz");

        let line = input.render(10).remove(0);

        assert!(line.contains("tuvwxyz"));
        assert_eq!(visible_width(&line), 10);
    }
}
