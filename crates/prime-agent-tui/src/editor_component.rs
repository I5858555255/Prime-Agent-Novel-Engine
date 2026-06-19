use crate::autocomplete::AutocompleteProvider;
use crate::editor::{EditorEvent, EditorRenderOptions};

pub trait EditorComponent {
    fn render(&mut self, width: usize, options: EditorRenderOptions) -> Vec<String>;

    fn invalidate(&mut self) {}

    fn get_text(&self) -> String;

    fn set_text(&mut self, text: &str) -> Vec<EditorEvent>;

    fn handle_input(&mut self, data: &str) -> Vec<EditorEvent>;

    fn add_to_history(&mut self, _text: &str) {}

    fn insert_text_at_cursor(&mut self, _text: &str) -> Vec<EditorEvent> {
        Vec::new()
    }

    fn get_expanded_text(&self) -> String {
        self.get_text()
    }

    fn set_autocomplete_provider(&mut self, _provider: Box<dyn AutocompleteProvider>) {}

    fn set_padding_x(&mut self, _padding: usize) {}

    fn set_autocomplete_max_visible(&mut self, _max_visible: usize) {}
}
