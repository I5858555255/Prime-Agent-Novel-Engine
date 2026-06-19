#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Spacer {
    lines: usize,
}

impl Default for Spacer {
    fn default() -> Self {
        Self { lines: 1 }
    }
}

impl Spacer {
    pub fn new(lines: usize) -> Self {
        Self { lines }
    }

    pub fn lines(&self) -> usize {
        self.lines
    }

    pub fn set_lines(&mut self, lines: usize) {
        self.lines = lines;
    }

    pub fn invalidate(&mut self) {}

    pub fn render(&self, _width: usize) -> Vec<String> {
        vec![String::new(); self.lines]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_one_empty_line() {
        let spacer = Spacer::default();

        assert_eq!(spacer.lines(), 1);
        assert_eq!(spacer.render(80), vec!["".to_string()]);
    }

    #[test]
    fn renders_configured_number_of_empty_lines() {
        let spacer = Spacer::new(3);

        assert_eq!(
            spacer.render(20),
            vec!["".to_string(), "".to_string(), "".to_string()]
        );
    }

    #[test]
    fn set_lines_updates_rendered_count() {
        let mut spacer = Spacer::new(1);
        spacer.set_lines(2);

        assert_eq!(spacer.lines(), 2);
        assert_eq!(spacer.render(10), vec!["".to_string(), "".to_string()]);
    }

    #[test]
    fn zero_lines_render_empty_vector() {
        let spacer = Spacer::new(0);

        assert_eq!(spacer.render(10), Vec::<String>::new());
    }
}
