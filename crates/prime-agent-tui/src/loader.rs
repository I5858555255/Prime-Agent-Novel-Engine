use crate::text::Text;

pub type LoaderStyleFn = fn(&str) -> String;

pub const DEFAULT_FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
pub const DEFAULT_INTERVAL_MS: u64 = 80;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LoaderIndicatorOptions {
    /// Animation frames. Use an empty vector to hide the indicator.
    pub frames: Option<Vec<String>>,
    /// Frame interval in milliseconds for callers that schedule ticks externally.
    pub interval_ms: Option<u64>,
}

impl LoaderIndicatorOptions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_frames<I, S>(frames: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            frames: Some(frames.into_iter().map(Into::into).collect()),
            interval_ms: None,
        }
    }

    pub fn with_interval_ms(interval_ms: u64) -> Self {
        Self {
            frames: None,
            interval_ms: Some(interval_ms),
        }
    }
}

#[derive(Clone)]
pub struct Loader {
    text: Text,
    frames: Vec<String>,
    interval_ms: u64,
    current_frame: usize,
    animating: bool,
    render_indicator_verbatim: bool,
    spinner_color_fn: LoaderStyleFn,
    message_color_fn: LoaderStyleFn,
    message: String,
}

impl std::fmt::Debug for Loader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Loader")
            .field("text", &self.text)
            .field("frames", &self.frames)
            .field("interval_ms", &self.interval_ms)
            .field("current_frame", &self.current_frame)
            .field("animating", &self.animating)
            .field("render_indicator_verbatim", &self.render_indicator_verbatim)
            .field("message", &self.message)
            .finish()
    }
}

impl Loader {
    pub fn new(
        spinner_color_fn: LoaderStyleFn,
        message_color_fn: LoaderStyleFn,
        message: impl Into<String>,
        indicator: Option<LoaderIndicatorOptions>,
    ) -> Self {
        let mut loader = Self {
            text: Text::new("", 1, 0),
            frames: default_frames(),
            interval_ms: DEFAULT_INTERVAL_MS,
            current_frame: 0,
            animating: false,
            render_indicator_verbatim: false,
            spinner_color_fn,
            message_color_fn,
            message: message.into(),
        };
        loader.set_indicator(indicator);
        loader
    }

    pub fn text_component(&self) -> &Text {
        &self.text
    }

    pub fn text_component_mut(&mut self) -> &mut Text {
        &mut self.text
    }

    pub fn display_text(&self) -> &str {
        self.text.text()
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn frames(&self) -> &[String] {
        &self.frames
    }

    pub fn interval_ms(&self) -> u64 {
        self.interval_ms
    }

    pub fn current_frame_index(&self) -> usize {
        self.current_frame
    }

    pub fn renders_indicator_verbatim(&self) -> bool {
        self.render_indicator_verbatim
    }

    pub fn is_animating(&self) -> bool {
        self.animating
    }

    pub fn render(&mut self, width: usize) -> Vec<String> {
        let mut lines = vec![String::new()];
        lines.extend(self.text.render(width));
        lines
    }

    /// Starts loader animation state and refreshes the display text.
    ///
    /// Unlike the TypeScript component, this Rust port does not spawn an interval timer. Callers
    /// should schedule ticks externally using `interval_ms` and call `tick`/`advance_frame`.
    pub fn start(&mut self) {
        self.update_display();
        self.animating = self.frames.len() > 1;
    }

    pub fn stop(&mut self) {
        self.animating = false;
    }

    pub fn set_message(&mut self, message: impl Into<String>) {
        self.message = message.into();
        self.update_display();
    }

    pub fn set_indicator(&mut self, indicator: Option<LoaderIndicatorOptions>) {
        self.render_indicator_verbatim = indicator.is_some();

        let indicator = indicator.unwrap_or_default();
        self.frames = indicator.frames.unwrap_or_else(default_frames);
        self.interval_ms = match indicator.interval_ms {
            Some(interval_ms) if interval_ms > 0 => interval_ms,
            _ => DEFAULT_INTERVAL_MS,
        };
        self.current_frame = 0;
        self.start();
    }

    pub fn tick(&mut self) -> bool {
        if !self.animating || self.frames.len() <= 1 {
            return false;
        }

        self.current_frame = (self.current_frame + 1) % self.frames.len();
        self.update_display();
        true
    }

    pub fn advance_frame(&mut self) -> bool {
        self.tick()
    }

    pub fn invalidate(&mut self) {
        self.text.invalidate();
    }

    fn update_display(&mut self) {
        let frame = self
            .frames
            .get(self.current_frame)
            .map_or("", String::as_str);
        let rendered_frame = if self.render_indicator_verbatim {
            frame.to_string()
        } else {
            (self.spinner_color_fn)(frame)
        };
        let indicator = if frame.is_empty() {
            String::new()
        } else {
            format!("{rendered_frame} ")
        };
        self.text.set_text(format!(
            "{indicator}{}",
            (self.message_color_fn)(&self.message)
        ));
    }
}

fn default_frames() -> Vec<String> {
    DEFAULT_FRAMES
        .iter()
        .map(|frame| (*frame).to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::visible_width;

    fn spinner(text: &str) -> String {
        format!("<s>{text}</s>")
    }

    fn message(text: &str) -> String {
        format!("<m>{text}</m>")
    }

    #[test]
    fn renders_blank_line_then_text_with_default_colored_indicator() {
        let mut loader = Loader::new(spinner, message, "Loading...", None);

        assert_eq!(loader.current_frame_index(), 0);
        assert_eq!(loader.interval_ms(), DEFAULT_INTERVAL_MS);
        assert!(loader.is_animating());
        assert_eq!(loader.display_text(), "<s>⠋</s> <m>Loading...</m>");

        let lines = loader.render(40);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "");
        assert!(lines[1].starts_with(" <s>⠋</s> <m>Loading...</m>"));
        assert_eq!(visible_width(&lines[1]), 40);
    }

    #[test]
    fn advances_frames_only_while_animating() {
        let mut loader = Loader::new(spinner, message, "Working", None);

        assert!(loader.tick());
        assert_eq!(loader.current_frame_index(), 1);
        assert_eq!(loader.display_text(), "<s>⠙</s> <m>Working</m>");

        loader.stop();
        assert!(!loader.tick());
        assert_eq!(loader.current_frame_index(), 1);

        loader.start();
        assert!(loader.advance_frame());
        assert_eq!(loader.current_frame_index(), 2);
    }

    #[test]
    fn custom_indicator_is_rendered_verbatim_and_resets_frame() {
        let mut loader = Loader::new(
            spinner,
            message,
            "Working",
            Some(LoaderIndicatorOptions {
                frames: Some(vec![".".to_string(), "o".to_string()]),
                interval_ms: Some(25),
            }),
        );

        assert!(loader.renders_indicator_verbatim());
        assert_eq!(loader.interval_ms(), 25);
        assert_eq!(loader.display_text(), ". <m>Working</m>");

        loader.tick();
        assert_eq!(loader.display_text(), "o <m>Working</m>");

        loader.set_indicator(None);
        assert!(!loader.renders_indicator_verbatim());
        assert_eq!(loader.current_frame_index(), 0);
        assert_eq!(loader.display_text(), "<s>⠋</s> <m>Working</m>");
    }

    #[test]
    fn empty_indicator_frames_hide_indicator_and_do_not_animate() {
        let mut loader = Loader::new(
            spinner,
            message,
            "No spinner",
            Some(LoaderIndicatorOptions {
                frames: Some(Vec::new()),
                interval_ms: Some(0),
            }),
        );

        assert_eq!(loader.interval_ms(), DEFAULT_INTERVAL_MS);
        assert!(!loader.is_animating());
        assert!(!loader.tick());
        assert_eq!(loader.display_text(), "<m>No spinner</m>");
    }

    #[test]
    fn set_message_updates_display_even_when_stopped() {
        let mut loader = Loader::new(spinner, message, "Old", None);

        loader.stop();
        loader.set_message("New");

        assert!(!loader.is_animating());
        assert_eq!(loader.display_text(), "<s>⠋</s> <m>New</m>");
    }
}
