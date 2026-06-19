use crate::keybindings::get_keybindings;
use crate::utils::{truncate_to_width, visible_width};

pub type SelectListStyleFn = fn(&str) -> String;
pub type TruncatePrimaryFn = for<'a> fn(SelectListTruncatePrimaryContext<'a>) -> String;
pub type SelectListItemCallback = Box<dyn FnMut(&SelectItem)>;
pub type SelectListCancelCallback = Box<dyn FnMut()>;

pub const DEFAULT_PRIMARY_COLUMN_WIDTH: usize = 32;
pub const PRIMARY_COLUMN_GAP: usize = 2;
pub const MIN_DESCRIPTION_WIDTH: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectItem {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
}

impl SelectItem {
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

#[derive(Debug, Clone, Copy)]
pub struct SelectListTheme {
    pub selected_prefix: SelectListStyleFn,
    pub selected_text: SelectListStyleFn,
    pub description: SelectListStyleFn,
    pub scroll_info: SelectListStyleFn,
    pub no_match: SelectListStyleFn,
}

impl Default for SelectListTheme {
    fn default() -> Self {
        Self {
            selected_prefix: identity,
            selected_text: identity,
            description: identity,
            scroll_info: identity,
            no_match: identity,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SelectListTruncatePrimaryContext<'a> {
    pub text: &'a str,
    pub max_width: usize,
    pub column_width: usize,
    pub item: &'a SelectItem,
    pub is_selected: bool,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SelectListLayoutOptions {
    pub min_primary_column_width: Option<usize>,
    pub max_primary_column_width: Option<usize>,
    pub truncate_primary: Option<TruncatePrimaryFn>,
}

pub struct SelectList {
    items: Vec<SelectItem>,
    filtered_items: Vec<SelectItem>,
    selected_index: usize,
    max_visible: usize,
    theme: SelectListTheme,
    layout: SelectListLayoutOptions,
    on_select: Option<SelectListItemCallback>,
    on_cancel: Option<SelectListCancelCallback>,
    on_selection_change: Option<SelectListItemCallback>,
}

impl std::fmt::Debug for SelectList {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SelectList")
            .field("items", &self.items)
            .field("filtered_items", &self.filtered_items)
            .field("selected_index", &self.selected_index)
            .field("max_visible", &self.max_visible)
            .field("theme", &self.theme)
            .field("layout", &self.layout)
            .field("on_select", &self.on_select.is_some())
            .field("on_cancel", &self.on_cancel.is_some())
            .field("on_selection_change", &self.on_selection_change.is_some())
            .finish()
    }
}

impl SelectList {
    pub fn new(
        items: Vec<SelectItem>,
        max_visible: usize,
        theme: SelectListTheme,
        layout: SelectListLayoutOptions,
    ) -> Self {
        Self {
            filtered_items: items.clone(),
            items,
            selected_index: 0,
            max_visible,
            theme,
            layout,
            on_select: None,
            on_cancel: None,
            on_selection_change: None,
        }
    }

    pub fn items(&self) -> &[SelectItem] {
        &self.items
    }

    pub fn filtered_items(&self) -> &[SelectItem] {
        &self.filtered_items
    }

    pub fn selected_index(&self) -> usize {
        self.selected_index
    }

    pub fn max_visible(&self) -> usize {
        self.max_visible
    }

    pub fn theme(&self) -> SelectListTheme {
        self.theme
    }

    pub fn layout(&self) -> SelectListLayoutOptions {
        self.layout
    }

    pub fn set_filter(&mut self, filter: &str) {
        let filter = filter.to_lowercase();
        self.filtered_items = self
            .items
            .iter()
            .filter(|item| item.value.to_lowercase().starts_with(&filter))
            .cloned()
            .collect();
        self.selected_index = 0;
    }

    pub fn set_selected_index(&mut self, index: usize) {
        self.selected_index = if self.filtered_items.is_empty() {
            0
        } else {
            index.min(self.filtered_items.len() - 1)
        };
    }

    pub fn set_max_visible(&mut self, max_visible: usize) {
        self.max_visible = max_visible;
    }

    pub fn set_on_select<F>(&mut self, on_select: F)
    where
        F: FnMut(&SelectItem) + 'static,
    {
        self.on_select = Some(Box::new(on_select));
    }

    pub fn clear_on_select(&mut self) {
        self.on_select = None;
    }

    pub fn set_on_cancel<F>(&mut self, on_cancel: F)
    where
        F: FnMut() + 'static,
    {
        self.on_cancel = Some(Box::new(on_cancel));
    }

    pub fn clear_on_cancel(&mut self) {
        self.on_cancel = None;
    }

    pub fn set_on_selection_change<F>(&mut self, on_selection_change: F)
    where
        F: FnMut(&SelectItem) + 'static,
    {
        self.on_selection_change = Some(Box::new(on_selection_change));
    }

    pub fn clear_on_selection_change(&mut self) {
        self.on_selection_change = None;
    }

    pub fn invalidate(&mut self) {}

    pub fn render(&self, width: usize) -> Vec<String> {
        let mut lines = Vec::new();

        if self.filtered_items.is_empty() {
            lines.push((self.theme.no_match)("  No matching commands"));
            return lines;
        }

        let primary_column_width = self.get_primary_column_width();
        let start_index = self.visible_start_index();
        let end_index = start_index
            .saturating_add(self.max_visible)
            .min(self.filtered_items.len());

        for index in start_index..end_index {
            let item = &self.filtered_items[index];
            let is_selected = index == self.selected_index;
            let description_single_line = item
                .description
                .as_ref()
                .map(|description| normalize_to_single_line(description));
            lines.push(self.render_item(
                item,
                is_selected,
                width,
                description_single_line.as_deref(),
                primary_column_width,
            ));
        }

        if start_index > 0 || end_index < self.filtered_items.len() {
            let scroll_text = format!(
                "  ({}/{})",
                self.selected_index + 1,
                self.filtered_items.len()
            );
            lines.push((self.theme.scroll_info)(&truncate_to_width(
                &scroll_text,
                width.saturating_sub(2),
                "",
                false,
            )));
        }

        lines
    }

    pub fn handle_input(&mut self, key_data: &str) -> bool {
        let (is_up, is_down, is_confirm, is_cancel) = {
            let keybindings = get_keybindings();
            (
                keybindings.matches(key_data, "tui.select.up"),
                keybindings.matches(key_data, "tui.select.down"),
                keybindings.matches(key_data, "tui.select.confirm"),
                keybindings.matches(key_data, "tui.select.cancel"),
            )
        };

        if is_up {
            if !self.filtered_items.is_empty() {
                self.selected_index = if self.selected_index == 0 {
                    self.filtered_items.len() - 1
                } else {
                    self.selected_index - 1
                };
                self.notify_selection_change();
            }
            return true;
        }

        if is_down {
            if !self.filtered_items.is_empty() {
                self.selected_index = if self.selected_index + 1 >= self.filtered_items.len() {
                    0
                } else {
                    self.selected_index + 1
                };
                self.notify_selection_change();
            }
            return true;
        }

        if is_confirm {
            if let Some(item) = self.get_selected_item().cloned()
                && let Some(on_select) = self.on_select.as_mut()
            {
                on_select(&item);
            }
            return true;
        }

        if is_cancel {
            if let Some(on_cancel) = self.on_cancel.as_mut() {
                on_cancel();
            }
            return true;
        }

        false
    }

    pub fn get_selected_item(&self) -> Option<&SelectItem> {
        self.filtered_items.get(self.selected_index)
    }

    fn render_item(
        &self,
        item: &SelectItem,
        is_selected: bool,
        width: usize,
        description_single_line: Option<&str>,
        primary_column_width: usize,
    ) -> String {
        let prefix = if is_selected { "→ " } else { "  " };
        let prefix_width = visible_width(prefix);

        if let Some(description_single_line) = description_single_line
            && width > 40
        {
            let effective_primary_column_width = primary_column_width
                .min(width.saturating_sub(prefix_width).saturating_sub(4))
                .max(1);
            let max_primary_width = effective_primary_column_width
                .saturating_sub(PRIMARY_COLUMN_GAP)
                .max(1);
            let truncated_value = self.truncate_primary(
                item,
                is_selected,
                max_primary_width,
                effective_primary_column_width,
            );
            let truncated_value_width = visible_width(&truncated_value);
            let spacing = " ".repeat(
                effective_primary_column_width
                    .saturating_sub(truncated_value_width)
                    .max(1),
            );
            let description_start = prefix_width + truncated_value_width + spacing.len();
            let remaining_width = width.saturating_sub(description_start).saturating_sub(2);

            if remaining_width > MIN_DESCRIPTION_WIDTH {
                let truncated_description =
                    truncate_to_width(description_single_line, remaining_width, "", false);
                if is_selected {
                    return trim_duplicate_trailing_resets(&(self.theme.selected_text)(&format!(
                        "{prefix}{truncated_value}{spacing}{truncated_description}"
                    )));
                }

                let description_text =
                    (self.theme.description)(&format!("{spacing}{truncated_description}"));
                return format!("{prefix}{truncated_value}{description_text}");
            }
        }

        let max_width = width.saturating_sub(prefix_width).saturating_sub(2);
        let truncated_value = self.truncate_primary(item, is_selected, max_width, max_width);
        if is_selected {
            return trim_duplicate_trailing_resets(&(self.theme.selected_text)(&format!(
                "{prefix}{truncated_value}"
            )));
        }

        format!("{prefix}{truncated_value}")
    }

    fn get_primary_column_width(&self) -> usize {
        let (min, max) = self.get_primary_column_bounds();
        let widest_primary = self
            .filtered_items
            .iter()
            .map(|item| visible_width(self.get_display_value(item)) + PRIMARY_COLUMN_GAP)
            .max()
            .unwrap_or(0);

        clamp(widest_primary, min, max)
    }

    fn get_primary_column_bounds(&self) -> (usize, usize) {
        let raw_min = self
            .layout
            .min_primary_column_width
            .or(self.layout.max_primary_column_width)
            .unwrap_or(DEFAULT_PRIMARY_COLUMN_WIDTH);
        let raw_max = self
            .layout
            .max_primary_column_width
            .or(self.layout.min_primary_column_width)
            .unwrap_or(DEFAULT_PRIMARY_COLUMN_WIDTH);

        (raw_min.min(raw_max).max(1), raw_min.max(raw_max).max(1))
    }

    fn truncate_primary(
        &self,
        item: &SelectItem,
        is_selected: bool,
        max_width: usize,
        column_width: usize,
    ) -> String {
        let display_value = self.get_display_value(item);
        let truncated_value = if let Some(truncate_primary) = self.layout.truncate_primary {
            truncate_primary(SelectListTruncatePrimaryContext {
                text: display_value,
                max_width,
                column_width,
                item,
                is_selected,
            })
        } else {
            truncate_to_width(display_value, max_width, "", false)
        };

        truncate_to_width(&truncated_value, max_width, "", false)
    }

    fn get_display_value<'a>(&self, item: &'a SelectItem) -> &'a str {
        if item.label.is_empty() {
            &item.value
        } else {
            &item.label
        }
    }

    fn visible_start_index(&self) -> usize {
        let centered_start = self.selected_index.saturating_sub(self.max_visible / 2);
        let max_start = self.filtered_items.len().saturating_sub(self.max_visible);
        centered_start.min(max_start)
    }

    fn notify_selection_change(&mut self) {
        if let Some(item) = self.get_selected_item().cloned()
            && let Some(on_selection_change) = self.on_selection_change.as_mut()
        {
            on_selection_change(&item);
        }
    }
}

fn identity(text: &str) -> String {
    text.to_string()
}

fn normalize_to_single_line(text: &str) -> String {
    let mut normalized = String::new();
    let mut in_line_break = false;

    for ch in text.chars() {
        if ch == '\r' || ch == '\n' {
            if !in_line_break {
                normalized.push(' ');
                in_line_break = true;
            }
        } else {
            normalized.push(ch);
            in_line_break = false;
        }
    }

    normalized.trim().to_string()
}

fn clamp(value: usize, min: usize, max: usize) -> usize {
    value.max(min).min(max)
}

fn trim_duplicate_trailing_resets(value: &str) -> String {
    let mut trimmed = value.to_string();
    while trimmed.ends_with("\x1b[0m\x1b[0m") {
        let new_len = trimmed.len() - "\x1b[0m".len();
        trimmed.truncate(new_len);
    }
    trimmed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    fn selected_prefix(text: &str) -> String {
        format!("\x1b[36m{text}\x1b[0m")
    }

    fn selected_text(text: &str) -> String {
        format!("\x1b[7m{text}\x1b[0m")
    }

    fn description(text: &str) -> String {
        format!("\x1b[2m{text}\x1b[0m")
    }

    fn scroll_info(text: &str) -> String {
        format!("\x1b[90m{text}\x1b[0m")
    }

    fn no_match(text: &str) -> String {
        format!("\x1b[31m{text}\x1b[0m")
    }

    fn theme() -> SelectListTheme {
        SelectListTheme {
            selected_prefix,
            selected_text,
            description,
            scroll_info,
            no_match,
        }
    }

    fn sample_items() -> Vec<SelectItem> {
        vec![
            SelectItem::new("alpha", "Alpha").with_description("First\ncommand"),
            SelectItem::new("beta", "Beta").with_description("Second command"),
            SelectItem::new("gamma", "Gamma").with_description("Third command"),
        ]
    }

    #[test]
    fn renders_items_with_descriptions_and_selected_text() {
        let list = SelectList::new(
            sample_items(),
            5,
            theme(),
            SelectListLayoutOptions::default(),
        );

        let lines = list.render(60);

        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("\x1b[7m→ Alpha"));
        assert!(lines[0].contains("First command"));
        assert!(lines[1].contains("  Beta"));
        assert!(lines[1].contains("\x1b[2m"));
        for line in lines {
            assert!(visible_width(&line) <= 60);
        }
    }

    #[test]
    fn filter_resets_selection_and_renders_no_match() {
        let mut list = SelectList::new(
            sample_items(),
            5,
            theme(),
            SelectListLayoutOptions::default(),
        );
        list.set_selected_index(2);

        list.set_filter("BE");

        assert_eq!(list.selected_index(), 0);
        assert_eq!(list.filtered_items().len(), 1);
        assert_eq!(list.get_selected_item().unwrap().value, "beta");

        list.set_filter("missing");
        assert_eq!(
            list.render(40),
            vec!["\x1b[31m  No matching commands\x1b[0m".to_string()]
        );
    }

    #[test]
    fn selection_wraps_and_notifies_selection_change() {
        let seen = Rc::new(RefCell::new(Vec::new()));
        let callback_seen = Rc::clone(&seen);
        let mut list = SelectList::new(
            sample_items(),
            5,
            theme(),
            SelectListLayoutOptions::default(),
        );
        list.set_on_selection_change(move |item| {
            callback_seen.borrow_mut().push(item.value.clone())
        });

        assert!(list.handle_input("\x1b[A"));
        assert_eq!(list.get_selected_item().unwrap().value, "gamma");

        assert!(list.handle_input("\x1b[B"));
        assert_eq!(list.get_selected_item().unwrap().value, "alpha");

        assert_eq!(
            seen.borrow().as_slice(),
            ["gamma".to_string(), "alpha".to_string()]
        );
    }

    #[test]
    fn confirm_and_cancel_callbacks_fire() {
        let selected = Rc::new(RefCell::new(Vec::new()));
        let selected_callback = Rc::clone(&selected);
        let cancelled = Rc::new(Cell::new(false));
        let cancel_callback = Rc::clone(&cancelled);
        let mut list = SelectList::new(
            sample_items(),
            5,
            theme(),
            SelectListLayoutOptions::default(),
        );
        list.set_selected_index(1);
        list.set_on_select(move |item| selected_callback.borrow_mut().push(item.value.clone()));
        list.set_on_cancel(move || cancel_callback.set(true));

        assert!(list.handle_input("\r"));
        assert!(list.handle_input("\x1b"));

        assert_eq!(selected.borrow().as_slice(), ["beta".to_string()]);
        assert!(cancelled.get());
    }

    #[test]
    fn render_adds_scroll_info_around_selected_item() {
        let items = (1..=10)
            .map(|index| SelectItem::new(format!("command-{index}"), format!("Command {index}")))
            .collect();
        let mut list = SelectList::new(items, 3, theme(), SelectListLayoutOptions::default());
        list.set_selected_index(5);

        let lines = list.render(50);

        assert_eq!(lines.len(), 4);
        assert!(lines[0].contains("Command 5"));
        assert!(lines[1].contains("→ Command 6"));
        assert!(lines[2].contains("Command 7"));
        assert_eq!(lines[3], "\x1b[90m  (6/10)\x1b[0m");
    }

    #[test]
    fn narrow_render_truncates_primary_text() {
        let list = SelectList::new(
            vec![SelectItem::new("superlongcommand", "SuperLongCommand")],
            5,
            theme(),
            SelectListLayoutOptions::default(),
        );

        let lines = list.render(10);

        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("→ SuperL"));
        assert_eq!(visible_width(&lines[0]), 8);
    }

    #[test]
    fn custom_truncate_primary_is_applied_and_clipped() {
        fn custom_truncate(context: SelectListTruncatePrimaryContext<'_>) -> String {
            format!(
                "{}:{}:{}",
                if context.is_selected {
                    "selected"
                } else {
                    "plain"
                },
                context.column_width,
                context.text
            )
        }

        let list = SelectList::new(
            vec![SelectItem::new("alpha", "Alpha").with_description("Description")],
            5,
            theme(),
            SelectListLayoutOptions {
                min_primary_column_width: Some(8),
                max_primary_column_width: Some(8),
                truncate_primary: Some(custom_truncate),
            },
        );

        let lines = list.render(60);

        assert!(lines[0].contains("→ select"));
        assert!(!lines[0].contains("selected:8:Alpha"));
    }
}
