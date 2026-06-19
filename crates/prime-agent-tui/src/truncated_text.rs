use crate::utils::{truncate_to_width, visible_width};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TruncatedText {
    text: String,
    padding_x: usize,
    padding_y: usize,
}

impl TruncatedText {
    pub fn new(text: impl Into<String>, padding_x: usize, padding_y: usize) -> Self {
        Self {
            text: text.into(),
            padding_x,
            padding_y,
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn padding_x(&self) -> usize {
        self.padding_x
    }

    pub fn padding_y(&self) -> usize {
        self.padding_y
    }

    pub fn set_text(&mut self, text: impl Into<String>) {
        self.text = text.into();
    }

    pub fn set_padding_x(&mut self, padding_x: usize) {
        self.padding_x = padding_x;
    }

    pub fn set_padding_y(&mut self, padding_y: usize) {
        self.padding_y = padding_y;
    }

    pub fn set_padding(&mut self, padding_x: usize, padding_y: usize) {
        self.padding_x = padding_x;
        self.padding_y = padding_y;
    }

    pub fn invalidate(&mut self) {}

    pub fn render(&self, width: usize) -> Vec<String> {
        let mut result = Vec::new();
        let empty_line = " ".repeat(width);

        for _ in 0..self.padding_y {
            result.push(empty_line.clone());
        }

        let available_width = width
            .saturating_sub(self.padding_x.saturating_mul(2))
            .max(1);
        let single_line_text = self
            .text
            .split_once('\n')
            .map_or(self.text.as_str(), |(first_line, _)| first_line);
        let display_text = truncate_to_width(single_line_text, available_width, "...", false);

        let left_padding = " ".repeat(self.padding_x);
        let right_padding = " ".repeat(self.padding_x);
        let line_with_padding = format!("{left_padding}{display_text}{right_padding}");

        let padding_needed = width.saturating_sub(visible_width(&line_with_padding));
        result.push(format!("{line_with_padding}{}", " ".repeat(padding_needed)));

        for _ in 0..self.padding_y {
            result.push(empty_line.clone());
        }

        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::visible_width;

    #[test]
    fn empty_text_renders_padded_line() {
        let text = TruncatedText::new("", 1, 0);

        assert_eq!(text.render(8), vec!["        ".to_string()]);
    }

    #[test]
    fn renders_vertical_padding_lines_to_width() {
        let text = TruncatedText::new("Hello", 0, 2);
        let lines = text.render(10);

        assert_eq!(lines.len(), 5);
        for line in lines {
            assert_eq!(visible_width(&line), 10);
        }
    }

    #[test]
    fn truncates_only_the_first_line() {
        let text = TruncatedText::new(
            "This first line is too long for the viewport\nSecond line",
            1,
            0,
        );
        let lines = text.render(18);

        assert_eq!(lines.len(), 1);
        assert_eq!(visible_width(&lines[0]), 18);
        assert!(lines[0].contains("..."));
        assert!(!lines[0].contains("Second"));
    }

    #[test]
    fn preserves_ansi_width_when_padding() {
        let text = TruncatedText::new("\x1b[31mHello\x1b[0m world", 1, 0);
        let lines = text.render(20);

        assert_eq!(lines.len(), 1);
        assert_eq!(visible_width(&lines[0]), 20);
        assert!(lines[0].contains("\x1b[31m"));
        assert!(!lines[0].contains("..."));
    }

    #[test]
    fn truncates_ansi_text_and_resets_before_ellipsis() {
        let text = TruncatedText::new(
            "\x1b[31mThis is a very long red line that will be truncated\x1b[0m",
            1,
            0,
        );
        let lines = text.render(20);

        assert_eq!(visible_width(&lines[0]), 20);
        assert!(lines[0].contains("\x1b[0m..."));
    }
}
