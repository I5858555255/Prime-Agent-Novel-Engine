use crate::render_cache::VersionedRenderCache;
use crate::utils::{apply_background_to_line, visible_width, wrap_text_with_ansi};

pub type TextBackgroundFn = fn(&str) -> String;

#[derive(Clone)]
pub struct Text {
    text: String,
    padding_x: usize,
    padding_y: usize,
    custom_bg_fn: Option<TextBackgroundFn>,
    version: u64,
    cache: VersionedRenderCache,
}

impl Default for Text {
    fn default() -> Self {
        Self::new("", 1, 1)
    }
}

impl std::fmt::Debug for Text {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Text")
            .field("text", &self.text)
            .field("padding_x", &self.padding_x)
            .field("padding_y", &self.padding_y)
            .field("custom_bg_fn", &self.custom_bg_fn.is_some())
            .field("version", &self.version)
            .field("cache", &self.cache)
            .finish()
    }
}

impl Text {
    pub fn new(text: impl Into<String>, padding_x: usize, padding_y: usize) -> Self {
        Self {
            text: text.into(),
            padding_x,
            padding_y,
            custom_bg_fn: None,
            version: 0,
            cache: VersionedRenderCache::new(),
        }
    }

    pub fn with_custom_bg_fn(
        text: impl Into<String>,
        padding_x: usize,
        padding_y: usize,
        custom_bg_fn: TextBackgroundFn,
    ) -> Self {
        let mut text = Self::new(text, padding_x, padding_y);
        text.custom_bg_fn = Some(custom_bg_fn);
        text
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

    pub fn has_custom_bg_fn(&self) -> bool {
        self.custom_bg_fn.is_some()
    }

    pub fn set_text(&mut self, text: impl Into<String>) {
        self.text = text.into();
        self.mark_dirty();
    }

    pub fn set_padding_x(&mut self, padding_x: usize) {
        self.padding_x = padding_x;
        self.mark_dirty();
    }

    pub fn set_padding_y(&mut self, padding_y: usize) {
        self.padding_y = padding_y;
        self.mark_dirty();
    }

    pub fn set_padding(&mut self, padding_x: usize, padding_y: usize) {
        self.padding_x = padding_x;
        self.padding_y = padding_y;
        self.mark_dirty();
    }

    pub fn set_custom_bg_fn(&mut self, custom_bg_fn: Option<TextBackgroundFn>) {
        self.custom_bg_fn = custom_bg_fn;
        self.mark_dirty();
    }

    pub fn invalidate(&mut self) {
        self.cache.invalidate();
    }

    pub fn cached_lines(&self, width: usize) -> Option<&[String]> {
        self.cache.get(width, self.version)
    }

    pub fn render(&mut self, width: usize) -> Vec<String> {
        self.render_cached(width).to_vec()
    }

    pub fn render_cached(&mut self, width: usize) -> &[String] {
        if self.cache.get(width, self.version).is_none() {
            let lines = self.render_lines(width);
            self.cache.set(width, self.version, lines);
        }

        self.cache
            .get(width, self.version)
            .expect("render cache should contain the rendered text")
    }

    /// Renders with a caller-provided background function without storing it or using the cache.
    ///
    /// Use `set_custom_bg_fn` when a non-capturing function pointer should be part of the
    /// component state and cached with the rest of the render output.
    pub fn render_with_background<F>(&self, width: usize, bg_fn: F) -> Vec<String>
    where
        F: Fn(&str) -> String,
    {
        self.render_lines_with_background(width, Some(&bg_fn))
    }

    fn mark_dirty(&mut self) {
        self.version = self.version.wrapping_add(1);
        self.cache.invalidate();
    }

    fn render_lines(&self, width: usize) -> Vec<String> {
        match self.custom_bg_fn {
            Some(bg_fn) => self.render_lines_with_background(width, Some(&bg_fn)),
            None => self.render_lines_with_background(width, None),
        }
    }

    fn render_lines_with_background(
        &self,
        width: usize,
        bg_fn: Option<&dyn Fn(&str) -> String>,
    ) -> Vec<String> {
        if self.text.trim().is_empty() {
            return Vec::new();
        }

        let normalized_text = self.text.replace('\t', "   ");
        let content_width = width
            .saturating_sub(self.padding_x.saturating_mul(2))
            .max(1);
        let wrapped_lines = wrap_text_with_ansi(&normalized_text, content_width);

        let left_margin = " ".repeat(self.padding_x);
        let right_margin = " ".repeat(self.padding_x);
        let mut result = Vec::new();

        let empty_line = " ".repeat(width);
        for _ in 0..self.padding_y {
            result.push(pad_and_background(&empty_line, width, bg_fn));
        }

        for line in wrapped_lines {
            let line_with_margins = format!("{left_margin}{line}{right_margin}");
            result.push(pad_and_background(&line_with_margins, width, bg_fn));
        }

        for _ in 0..self.padding_y {
            result.push(pad_and_background(&empty_line, width, bg_fn));
        }

        if result.is_empty() {
            vec![String::new()]
        } else {
            result
        }
    }
}

fn pad_and_background(line: &str, width: usize, bg_fn: Option<&dyn Fn(&str) -> String>) -> String {
    match bg_fn {
        Some(bg_fn) => apply_background_to_line(line, width, |padded| bg_fn(padded)),
        None => {
            let padding_needed = width.saturating_sub(visible_width(line));
            format!("{line}{}", " ".repeat(padding_needed))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::visible_width;

    fn bracket_background(text: &str) -> String {
        format!("[{text}]")
    }

    #[test]
    fn empty_text_renders_no_lines() {
        let mut text = Text::new("", 1, 1);

        assert_eq!(text.render(20), Vec::<String>::new());
        assert_eq!(text.cached_lines(20), Some(&[][..]));
    }

    #[test]
    fn whitespace_only_text_renders_no_lines() {
        let mut text = Text::new(" \n\t ", 1, 1);

        assert_eq!(text.render(20), Vec::<String>::new());
    }

    #[test]
    fn normalizes_tabs_to_three_spaces_before_rendering() {
        let mut text = Text::new("a\tb", 0, 0);
        let lines = text.render(10);

        assert_eq!(lines, vec!["a   b     ".to_string()]);
        assert!(!lines[0].contains('\t'));
        assert_eq!(visible_width(&lines[0]), 10);
    }

    #[test]
    fn wraps_and_pads_lines_to_requested_width() {
        let mut text = Text::new("alpha beta gamma", 1, 1);
        let lines = text.render(12);

        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0], " ".repeat(12));
        assert_eq!(lines[1], " alpha beta ");
        assert_eq!(lines[2], " gamma      ");
        assert_eq!(lines[3], " ".repeat(12));
        for line in lines {
            assert_eq!(visible_width(&line), 12);
        }
    }

    #[test]
    fn cache_is_observable_and_invalidated() {
        let mut text = Text::new("hello", 0, 0);

        assert!(text.cached_lines(10).is_none());
        assert_eq!(text.render(10), vec!["hello     ".to_string()]);
        assert_eq!(text.cached_lines(10), Some(&["hello     ".to_string()][..]));

        text.invalidate();
        assert!(text.cached_lines(10).is_none());

        assert_eq!(text.render(10), vec!["hello     ".to_string()]);
        text.set_text("bye");
        assert!(text.cached_lines(10).is_none());
        assert_eq!(text.render(10), vec!["bye       ".to_string()]);
    }

    #[test]
    fn applies_stored_background_function_and_caches_result() {
        let mut text = Text::with_custom_bg_fn("hi", 1, 0, bracket_background);

        assert_eq!(text.render(6), vec!["[ hi   ]".to_string()]);
        assert_eq!(text.cached_lines(6), Some(&["[ hi   ]".to_string()][..]));
    }

    #[test]
    fn render_with_background_does_not_replace_stored_background() {
        let text = Text::new("hi", 1, 0);

        assert_eq!(
            text.render_with_background(6, |line| format!("({line})")),
            vec!["( hi   )".to_string()]
        );
        assert!(!text.has_custom_bg_fn());
    }
}
