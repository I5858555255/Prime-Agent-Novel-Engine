use crate::fuzzy::fuzzy_filter;
use crate::keybindings::get_keybindings;
use crate::utils::{truncate_to_width, visible_width, wrap_text_with_ansi};

pub type SettingsListSelectedStyleFn = fn(&str, bool) -> String;
pub type SettingsListStyleFn = fn(&str) -> String;
pub type SettingsListChangeCallback = std::boxed::Box<dyn FnMut(&str, &str)>;
pub type SettingsListCancelCallback = std::boxed::Box<dyn FnMut()>;
pub type SettingsSubmenuFactory = std::boxed::Box<dyn FnMut(&str) -> SettingsSubmenu>;
pub type SettingsSubmenuRenderCallback = std::boxed::Box<dyn FnMut(usize) -> Vec<String>>;
pub type SettingsSubmenuInputCallback = std::boxed::Box<dyn FnMut(&str) -> SettingsSubmenuResult>;
pub type SettingsSubmenuInvalidateCallback = std::boxed::Box<dyn FnMut()>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsSubmenuResult {
    Continue,
    Close,
    Select(String),
}

pub struct SettingsSubmenu {
    render: SettingsSubmenuRenderCallback,
    handle_input: Option<SettingsSubmenuInputCallback>,
    invalidate: Option<SettingsSubmenuInvalidateCallback>,
}

impl std::fmt::Debug for SettingsSubmenu {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SettingsSubmenu")
            .field("handle_input", &self.handle_input.is_some())
            .field("invalidate", &self.invalidate.is_some())
            .finish_non_exhaustive()
    }
}

impl SettingsSubmenu {
    pub fn new<F>(render: F) -> Self
    where
        F: FnMut(usize) -> Vec<String> + 'static,
    {
        Self {
            render: std::boxed::Box::new(render),
            handle_input: None,
            invalidate: None,
        }
    }

    pub fn with_input<F>(mut self, handle_input: F) -> Self
    where
        F: FnMut(&str) -> SettingsSubmenuResult + 'static,
    {
        self.handle_input = Some(std::boxed::Box::new(handle_input));
        self
    }

    pub fn with_invalidate<F>(mut self, invalidate: F) -> Self
    where
        F: FnMut() + 'static,
    {
        self.invalidate = Some(std::boxed::Box::new(invalidate));
        self
    }

    pub fn render(&mut self, width: usize) -> Vec<String> {
        (self.render)(width)
    }

    pub fn handle_input(&mut self, data: &str) -> SettingsSubmenuResult {
        self.handle_input
            .as_mut()
            .map(|handle_input| handle_input(data))
            .unwrap_or(SettingsSubmenuResult::Continue)
    }

    pub fn invalidate(&mut self) {
        if let Some(invalidate) = self.invalidate.as_mut() {
            invalidate();
        }
    }
}

pub struct SettingItem {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    pub current_value: String,
    pub values: Vec<String>,
    pub submenu: Option<SettingsSubmenuFactory>,
}

impl std::fmt::Debug for SettingItem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SettingItem")
            .field("id", &self.id)
            .field("label", &self.label)
            .field("description", &self.description)
            .field("current_value", &self.current_value)
            .field("values", &self.values)
            .field("submenu", &self.submenu.is_some())
            .finish()
    }
}

impl SettingItem {
    pub fn new(
        id: impl Into<String>,
        label: impl Into<String>,
        current_value: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            description: None,
            current_value: current_value.into(),
            values: Vec::new(),
            submenu: None,
        }
    }

    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn with_values<I, V>(mut self, values: I) -> Self
    where
        I: IntoIterator<Item = V>,
        V: Into<String>,
    {
        self.values = values.into_iter().map(Into::into).collect();
        self
    }

    pub fn with_submenu<F>(mut self, submenu: F) -> Self
    where
        F: FnMut(&str) -> SettingsSubmenu + 'static,
    {
        self.submenu = Some(std::boxed::Box::new(submenu));
        self
    }
}

#[derive(Debug, Clone)]
pub struct SettingsListTheme {
    pub label: SettingsListSelectedStyleFn,
    pub value: SettingsListSelectedStyleFn,
    pub description: SettingsListStyleFn,
    pub cursor: String,
    pub hint: SettingsListStyleFn,
}

impl Default for SettingsListTheme {
    fn default() -> Self {
        Self {
            label: selected_identity,
            value: selected_identity,
            description: identity,
            cursor: "→ ".to_string(),
            hint: identity,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SettingsListOptions {
    pub enable_search: bool,
}

pub struct SettingsList {
    items: Vec<SettingItem>,
    all_indices: Vec<usize>,
    filtered_indices: Vec<usize>,
    selected_index: usize,
    max_visible: usize,
    theme: SettingsListTheme,
    on_change: Option<SettingsListChangeCallback>,
    on_cancel: Option<SettingsListCancelCallback>,
    search_enabled: bool,
    search_query: String,
    submenu: Option<SettingsSubmenu>,
    submenu_item_index: Option<usize>,
}

impl std::fmt::Debug for SettingsList {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SettingsList")
            .field("items", &self.items)
            .field("filtered_indices", &self.filtered_indices)
            .field("selected_index", &self.selected_index)
            .field("max_visible", &self.max_visible)
            .field("theme", &self.theme)
            .field("on_change", &self.on_change.is_some())
            .field("on_cancel", &self.on_cancel.is_some())
            .field("search_enabled", &self.search_enabled)
            .field("search_query", &self.search_query)
            .field("submenu", &self.submenu.is_some())
            .field("submenu_item_index", &self.submenu_item_index)
            .finish()
    }
}

impl SettingsList {
    pub fn new(
        items: Vec<SettingItem>,
        max_visible: usize,
        theme: SettingsListTheme,
        options: SettingsListOptions,
    ) -> Self {
        let all_indices = (0..items.len()).collect::<Vec<_>>();
        Self {
            filtered_indices: all_indices.clone(),
            all_indices,
            items,
            selected_index: 0,
            max_visible,
            theme,
            on_change: None,
            on_cancel: None,
            search_enabled: options.enable_search,
            search_query: String::new(),
            submenu: None,
            submenu_item_index: None,
        }
    }

    pub fn items(&self) -> &[SettingItem] {
        &self.items
    }

    pub fn filtered_indices(&self) -> &[usize] {
        &self.filtered_indices
    }

    pub fn filtered_items(&self) -> Vec<&SettingItem> {
        self.filtered_indices
            .iter()
            .filter_map(|index| self.items.get(*index))
            .collect()
    }

    pub fn selected_index(&self) -> usize {
        self.selected_index
    }

    pub fn selected_item(&self) -> Option<&SettingItem> {
        let item_index = *self.display_indices().get(self.selected_index)?;
        self.items.get(item_index)
    }

    pub fn max_visible(&self) -> usize {
        self.max_visible
    }

    pub fn theme(&self) -> &SettingsListTheme {
        &self.theme
    }

    pub fn search_enabled(&self) -> bool {
        self.search_enabled
    }

    pub fn search_query(&self) -> &str {
        &self.search_query
    }

    pub fn is_submenu_active(&self) -> bool {
        self.submenu.is_some()
    }

    pub fn set_on_change<F>(&mut self, on_change: F)
    where
        F: FnMut(&str, &str) + 'static,
    {
        self.on_change = Some(std::boxed::Box::new(on_change));
    }

    pub fn clear_on_change(&mut self) {
        self.on_change = None;
    }

    pub fn set_on_cancel<F>(&mut self, on_cancel: F)
    where
        F: FnMut() + 'static,
    {
        self.on_cancel = Some(std::boxed::Box::new(on_cancel));
    }

    pub fn clear_on_cancel(&mut self) {
        self.on_cancel = None;
    }

    pub fn set_selected_index(&mut self, selected_index: usize) {
        let len = self.display_indices().len();
        self.selected_index = if len == 0 {
            0
        } else {
            selected_index.min(len - 1)
        };
    }

    pub fn set_max_visible(&mut self, max_visible: usize) {
        self.max_visible = max_visible;
    }

    pub fn set_search_enabled(&mut self, search_enabled: bool) {
        self.search_enabled = search_enabled;
        self.clamp_selection();
    }

    pub fn set_search_query(&mut self, query: impl Into<String>) {
        self.search_query = query.into();
        self.apply_filter();
    }

    pub fn clear_search(&mut self) {
        self.search_query.clear();
        self.apply_filter();
    }

    pub fn update_value(&mut self, id: &str, new_value: impl Into<String>) -> bool {
        let Some(item) = self.items.iter_mut().find(|item| item.id == id) else {
            return false;
        };

        item.current_value = new_value.into();
        true
    }

    pub fn invalidate(&mut self) {
        if let Some(submenu) = self.submenu.as_mut() {
            submenu.invalidate();
        }
    }

    pub fn render(&mut self, width: usize) -> Vec<String> {
        if let Some(submenu) = self.submenu.as_mut() {
            return submenu.render(width);
        }

        self.render_main_list(width)
    }

    pub fn handle_input(&mut self, data: &str) -> bool {
        if self.submenu.is_some() {
            return self.handle_submenu_input(data);
        }

        let (is_up, is_down, is_confirm, is_cancel, is_backspace) = {
            let keybindings = get_keybindings();
            (
                keybindings.matches(data, "tui.select.up"),
                keybindings.matches(data, "tui.select.down"),
                keybindings.matches(data, "tui.select.confirm"),
                keybindings.matches(data, "tui.select.cancel"),
                keybindings.matches(data, "tui.editor.deleteCharBackward"),
            )
        };

        if is_up {
            self.move_selection_up();
            return true;
        }

        if is_down {
            self.move_selection_down();
            return true;
        }

        if is_confirm || data == " " {
            self.activate_item();
            return true;
        }

        if is_cancel {
            if let Some(on_cancel) = self.on_cancel.as_mut() {
                on_cancel();
            }
            return true;
        }

        if self.search_enabled {
            if is_backspace {
                self.search_query.pop();
                self.apply_filter();
                return true;
            }

            return self.append_search_input(data);
        }

        false
    }

    pub fn close_submenu(&mut self) {
        self.submenu = None;
        if let Some(item_index) = self.submenu_item_index.take() {
            self.set_selected_index(item_index);
        }
    }

    pub fn finish_submenu(&mut self, selected_value: Option<String>) {
        if let Some(value) = selected_value
            && let Some(display_index) = self.submenu_item_index
            && let Some(item_index) = self.display_indices().get(display_index).copied()
        {
            self.change_item_value(item_index, value);
        }
        self.close_submenu();
    }

    fn render_main_list(&self, width: usize) -> Vec<String> {
        let mut lines = Vec::new();

        if self.search_enabled {
            lines.push(self.render_search_input(width));
            lines.push(String::new());
        }

        if self.items.is_empty() {
            lines.push((self.theme.hint)("  No settings available"));
            if self.search_enabled {
                self.add_hint_line(&mut lines, width);
            }
            return lines;
        }

        let display_indices = self.display_indices();
        if display_indices.is_empty() {
            lines.push(truncate_to_width(
                &(self.theme.hint)("  No matching settings"),
                width,
                "",
                false,
            ));
            self.add_hint_line(&mut lines, width);
            return lines;
        }

        let visible_limit = self.max_visible.max(1);
        let start_index = self.visible_start_index(display_indices.len(), visible_limit);
        let end_index = start_index
            .saturating_add(visible_limit)
            .min(display_indices.len());
        let max_label_width = self
            .items
            .iter()
            .map(|item| visible_width(&item.label))
            .max()
            .unwrap_or(0)
            .min(30);

        for index in start_index..end_index {
            let Some(item) = display_indices
                .get(index)
                .and_then(|item_index| self.items.get(*item_index))
            else {
                continue;
            };
            lines.push(self.render_item(
                item,
                index == self.selected_index,
                width,
                max_label_width,
            ));
        }

        if start_index > 0 || end_index < display_indices.len() {
            let scroll_text = format!("  ({}/{})", self.selected_index + 1, display_indices.len());
            lines.push((self.theme.hint)(&truncate_to_width(
                &scroll_text,
                width.saturating_sub(2),
                "",
                false,
            )));
        }

        if let Some(selected_item) = display_indices
            .get(self.selected_index)
            .and_then(|item_index| self.items.get(*item_index))
            && let Some(description) = selected_item.description.as_deref()
        {
            lines.push(String::new());
            for line in wrap_text_with_ansi(description, width.saturating_sub(4).max(1)) {
                lines.push((self.theme.description)(&format!("  {line}")));
            }
        }

        self.add_hint_line(&mut lines, width);

        lines
    }

    fn render_item(
        &self,
        item: &SettingItem,
        is_selected: bool,
        width: usize,
        max_label_width: usize,
    ) -> String {
        let prefix = if is_selected {
            self.theme.cursor.as_str()
        } else {
            "  "
        };
        let prefix_width = visible_width(prefix);
        let label_padding = " ".repeat(max_label_width.saturating_sub(visible_width(&item.label)));
        let label_padded = format!("{}{label_padding}", item.label);
        let label_text = (self.theme.label)(&label_padded, is_selected);

        let separator = "  ";
        let used_width = prefix_width + max_label_width + visible_width(separator);
        let value_max_width = width.saturating_sub(used_width).saturating_sub(2);
        let value_text = (self.theme.value)(
            &truncate_to_width(&item.current_value, value_max_width, "", false),
            is_selected,
        );

        truncate_to_width(
            &format!("{prefix}{label_text}{separator}{value_text}"),
            width,
            "",
            false,
        )
    }

    fn render_search_input(&self, width: usize) -> String {
        truncate_to_width(&format!("> {}", self.search_query), width, "", true)
    }

    fn add_hint_line(&self, lines: &mut Vec<String>, width: usize) {
        let hint = if self.search_enabled {
            "  Type to search · Enter/Space to change · Esc to cancel"
        } else {
            "  Enter/Space to change · Esc to cancel"
        };
        lines.push(String::new());
        lines.push(truncate_to_width(
            &(self.theme.hint)(hint),
            width,
            "",
            false,
        ));
    }

    fn display_indices(&self) -> &[usize] {
        if self.search_enabled {
            &self.filtered_indices
        } else {
            &self.all_indices
        }
    }

    fn visible_start_index(&self, item_count: usize, visible_limit: usize) -> usize {
        let centered_start = self.selected_index.saturating_sub(visible_limit / 2);
        let max_start = item_count.saturating_sub(visible_limit);
        centered_start.min(max_start)
    }

    fn move_selection_up(&mut self) {
        let len = self.display_indices().len();
        if len == 0 {
            return;
        }

        self.selected_index = if self.selected_index == 0 {
            len - 1
        } else {
            self.selected_index - 1
        };
    }

    fn move_selection_down(&mut self) {
        let len = self.display_indices().len();
        if len == 0 {
            return;
        }

        self.selected_index = if self.selected_index + 1 >= len {
            0
        } else {
            self.selected_index + 1
        };
    }

    fn activate_item(&mut self) {
        let Some(item_index) = self.display_indices().get(self.selected_index).copied() else {
            return;
        };

        let current_value = self.items[item_index].current_value.clone();
        if let Some(submenu) = self.items[item_index]
            .submenu
            .as_mut()
            .map(|submenu| submenu(&current_value))
        {
            self.submenu_item_index = Some(self.selected_index);
            self.submenu = Some(submenu);
            return;
        }

        if self.items[item_index].values.is_empty() {
            return;
        }

        let next_value = {
            let item = &self.items[item_index];
            let next_index = item
                .values
                .iter()
                .position(|value| value == &item.current_value)
                .map_or(0, |index| (index + 1) % item.values.len());
            item.values[next_index].clone()
        };
        self.change_item_value(item_index, next_value);
    }

    fn change_item_value(&mut self, item_index: usize, new_value: String) {
        let Some(item) = self.items.get_mut(item_index) else {
            return;
        };

        item.current_value = new_value.clone();
        let id = item.id.clone();
        if let Some(on_change) = self.on_change.as_mut() {
            on_change(&id, &new_value);
        }
    }

    fn handle_submenu_input(&mut self, data: &str) -> bool {
        let result = self
            .submenu
            .as_mut()
            .map(|submenu| submenu.handle_input(data))
            .unwrap_or(SettingsSubmenuResult::Continue);

        match result {
            SettingsSubmenuResult::Continue => true,
            SettingsSubmenuResult::Close => {
                self.close_submenu();
                true
            }
            SettingsSubmenuResult::Select(value) => {
                self.finish_submenu(Some(value));
                true
            }
        }
    }

    fn append_search_input(&mut self, data: &str) -> bool {
        let sanitized = data.replace(' ', "");
        if sanitized.is_empty() || sanitized.chars().any(char::is_control) {
            return false;
        }

        self.search_query.push_str(&sanitized);
        self.apply_filter();
        true
    }

    fn apply_filter(&mut self) {
        self.filtered_indices = fuzzy_filter(&self.all_indices, &self.search_query, |index| {
            self.items[*index].label.clone()
        });
        self.selected_index = 0;
    }

    fn clamp_selection(&mut self) {
        let len = self.display_indices().len();
        self.selected_index = if len == 0 {
            0
        } else {
            self.selected_index.min(len - 1)
        };
    }
}

fn identity(text: &str) -> String {
    text.to_string()
}

fn selected_identity(text: &str, _selected: bool) -> String {
    text.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::visible_width;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    fn label(text: &str, selected: bool) -> String {
        if selected {
            format!("<L:{text}>")
        } else {
            text.to_string()
        }
    }

    fn value(text: &str, selected: bool) -> String {
        if selected {
            format!("<V:{text}>")
        } else {
            text.to_string()
        }
    }

    fn description(text: &str) -> String {
        format!("<D:{text}>")
    }

    fn hint(text: &str) -> String {
        format!("<H:{text}>")
    }

    fn theme() -> SettingsListTheme {
        SettingsListTheme {
            label,
            value,
            description,
            cursor: "=>".to_string(),
            hint,
        }
    }

    fn sample_items() -> Vec<SettingItem> {
        vec![
            SettingItem::new("theme", "Theme", "dark")
                .with_description("Color scheme for the interface")
                .with_values(["dark", "light"]),
            SettingItem::new("mode", "Mode", "compact")
                .with_description("Controls density")
                .with_values(["compact", "roomy"]),
            SettingItem::new("notify", "Notifications", "off").with_values(["off", "on"]),
        ]
    }

    #[test]
    fn empty_and_no_match_states_render_hints() {
        let mut empty = SettingsList::new(
            Vec::new(),
            5,
            SettingsListTheme::default(),
            SettingsListOptions::default(),
        );

        assert_eq!(
            empty.render(40),
            vec!["  No settings available".to_string()]
        );

        let mut list = SettingsList::new(
            sample_items(),
            5,
            SettingsListTheme::default(),
            SettingsListOptions {
                enable_search: true,
            },
        );
        list.set_search_query("zzzz");
        let lines = list.render(40);

        assert_eq!(list.filtered_items().len(), 0);
        assert!(
            lines
                .iter()
                .any(|line| line.contains("No matching settings"))
        );
        assert!(lines.iter().any(|line| line.contains("Type to search")));
    }

    #[test]
    fn search_filter_resets_selection_and_can_be_cleared() {
        let mut list = SettingsList::new(
            sample_items(),
            5,
            SettingsListTheme::default(),
            SettingsListOptions {
                enable_search: true,
            },
        );
        list.set_selected_index(2);

        list.set_search_query("mod");

        assert_eq!(list.selected_index(), 0);
        assert_eq!(list.filtered_items().len(), 1);
        assert_eq!(list.selected_item().unwrap().id, "mode");

        list.clear_search();

        assert_eq!(list.selected_index(), 0);
        assert_eq!(list.filtered_items().len(), 3);
        assert_eq!(list.search_query(), "");
    }

    #[test]
    fn renders_values_descriptions_hints_and_search_input() {
        let mut list = SettingsList::new(
            sample_items(),
            5,
            theme(),
            SettingsListOptions {
                enable_search: true,
            },
        );

        let lines = list.render(72);

        assert!(lines[0].starts_with("> "));
        assert!(lines.iter().any(|line| line.contains("=><L:Theme")));
        assert!(lines.iter().any(|line| line.contains("<V:dark>")));
        assert!(
            lines
                .iter()
                .any(|line| line.contains("<D:  Color scheme for the interface>"))
        );
        assert!(lines.iter().any(|line| line.contains("Type to search")));
        for line in lines {
            assert!(visible_width(&line) <= 72);
        }
    }

    #[test]
    fn selection_wraps_with_up_and_down() {
        let mut list = SettingsList::new(
            sample_items(),
            5,
            SettingsListTheme::default(),
            SettingsListOptions::default(),
        );

        assert!(list.handle_input("\x1b[A"));
        assert_eq!(list.selected_item().unwrap().id, "notify");

        assert!(list.handle_input("\x1b[B"));
        assert_eq!(list.selected_item().unwrap().id, "theme");
    }

    #[test]
    fn cycling_values_updates_item_and_calls_change_callback() {
        let changes = Rc::new(RefCell::new(Vec::new()));
        let callback_changes = Rc::clone(&changes);
        let mut list = SettingsList::new(
            vec![SettingItem::new("mode", "Mode", "off").with_values(["off", "on"])],
            5,
            SettingsListTheme::default(),
            SettingsListOptions::default(),
        );
        list.set_on_change(move |id, value| {
            callback_changes
                .borrow_mut()
                .push((id.to_string(), value.to_string()));
        });

        assert!(list.handle_input("\r"));
        assert_eq!(list.items()[0].current_value, "on");
        assert!(list.handle_input(" "));
        assert_eq!(list.items()[0].current_value, "off");
        assert_eq!(
            changes.borrow().as_slice(),
            [
                ("mode".to_string(), "on".to_string()),
                ("mode".to_string(), "off".to_string()),
            ]
        );
    }

    #[test]
    fn cancel_callback_fires() {
        let cancelled = Rc::new(Cell::new(false));
        let callback_cancelled = Rc::clone(&cancelled);
        let mut list = SettingsList::new(
            sample_items(),
            5,
            SettingsListTheme::default(),
            SettingsListOptions::default(),
        );
        list.set_on_cancel(move || callback_cancelled.set(true));

        assert!(list.handle_input("\x1b"));

        assert!(cancelled.get());
    }

    #[test]
    fn scroll_indicator_is_rendered_when_items_overflow() {
        let items = (1..=10)
            .map(|index| {
                SettingItem::new(
                    format!("setting-{index}"),
                    format!("Setting {index}"),
                    format!("value-{index}"),
                )
            })
            .collect::<Vec<_>>();
        let mut list = SettingsList::new(
            items,
            3,
            SettingsListTheme::default(),
            SettingsListOptions::default(),
        );
        list.set_selected_index(5);

        let lines = list.render(60);

        assert!(lines.iter().any(|line| line.contains("Setting 5")));
        assert!(lines.iter().any(|line| line.contains("Setting 6")));
        assert!(lines.iter().any(|line| line.contains("Setting 7")));
        assert!(lines.iter().any(|line| line.contains("  (6/10)")));
    }

    #[test]
    fn submenu_render_input_select_and_cancel_are_supported() {
        let invalidated = Rc::new(Cell::new(false));
        let invalidated_callback = Rc::clone(&invalidated);
        let changes = Rc::new(RefCell::new(Vec::new()));
        let callback_changes = Rc::clone(&changes);
        let mut list = SettingsList::new(
            vec![
                SettingItem::new("editor", "Editor", "vim").with_submenu(move |current| {
                    let rendered_current = current.to_string();
                    let invalidated_callback = Rc::clone(&invalidated_callback);
                    SettingsSubmenu::new(move |width| {
                        vec![truncate_to_width(
                            &format!("submenu:{rendered_current}"),
                            width,
                            "",
                            false,
                        )]
                    })
                    .with_input(|data| {
                        if data == "\r" {
                            SettingsSubmenuResult::Select("emacs".to_string())
                        } else {
                            SettingsSubmenuResult::Close
                        }
                    })
                    .with_invalidate(move || invalidated_callback.set(true))
                }),
            ],
            5,
            SettingsListTheme::default(),
            SettingsListOptions::default(),
        );
        list.set_on_change(move |id, value| {
            callback_changes
                .borrow_mut()
                .push((id.to_string(), value.to_string()));
        });

        assert!(list.handle_input("\r"));
        assert!(list.is_submenu_active());
        assert_eq!(list.render(40), vec!["submenu:vim".to_string()]);

        list.invalidate();
        assert!(invalidated.get());

        assert!(list.handle_input("\r"));
        assert!(!list.is_submenu_active());
        assert_eq!(list.items()[0].current_value, "emacs");
        assert_eq!(
            changes.borrow().as_slice(),
            [("editor".to_string(), "emacs".to_string())]
        );
    }
}
