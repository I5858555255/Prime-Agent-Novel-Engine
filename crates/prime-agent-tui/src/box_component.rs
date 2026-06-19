use crate::utils::{apply_background_to_line, visible_width};

pub type BoxBackgroundFn = fn(&str) -> String;
pub type BoxChildRenderFn = std::boxed::Box<dyn FnMut(usize) -> Vec<String>>;
pub type BoxChildInvalidateFn = std::boxed::Box<dyn FnMut()>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct BoxChildId(u64);

impl BoxChildId {
    pub fn get(self) -> u64 {
        self.0
    }
}

pub struct BoxChild {
    id: BoxChildId,
    render: BoxChildRenderFn,
    invalidate: Option<BoxChildInvalidateFn>,
}

impl std::fmt::Debug for BoxChild {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BoxChild")
            .field("id", &self.id)
            .field("invalidate", &self.invalidate.is_some())
            .finish_non_exhaustive()
    }
}

impl BoxChild {
    pub fn new<F>(render: F) -> Self
    where
        F: FnMut(usize) -> Vec<String> + 'static,
    {
        Self {
            id: BoxChildId(0),
            render: std::boxed::Box::new(render),
            invalidate: None,
        }
    }

    pub fn with_invalidate<F>(mut self, invalidate: F) -> Self
    where
        F: FnMut() + 'static,
    {
        self.invalidate = Some(std::boxed::Box::new(invalidate));
        self
    }

    pub fn id(&self) -> BoxChildId {
        self.id
    }

    fn set_id(&mut self, id: BoxChildId) {
        self.id = id;
    }

    fn render(&mut self, width: usize) -> Vec<String> {
        (self.render)(width)
    }

    fn invalidate(&mut self) {
        if let Some(invalidate) = self.invalidate.as_mut() {
            invalidate();
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoxRenderCache {
    pub child_lines: Vec<String>,
    pub width: usize,
    pub bg_sample: Option<String>,
    pub lines: Vec<String>,
}

#[derive(Debug)]
pub struct BoxComponent {
    children: Vec<BoxChild>,
    padding_x: usize,
    padding_y: usize,
    bg_fn: Option<BoxBackgroundFn>,
    cache: Option<BoxRenderCache>,
    next_child_id: u64,
}

impl Default for BoxComponent {
    fn default() -> Self {
        Self::new(1, 1, None)
    }
}

impl BoxComponent {
    pub fn new(padding_x: usize, padding_y: usize, bg_fn: Option<BoxBackgroundFn>) -> Self {
        Self {
            children: Vec::new(),
            padding_x,
            padding_y,
            bg_fn,
            cache: None,
            next_child_id: 1,
        }
    }

    pub fn children(&self) -> &[BoxChild] {
        &self.children
    }

    pub fn child_count(&self) -> usize {
        self.children.len()
    }

    pub fn padding_x(&self) -> usize {
        self.padding_x
    }

    pub fn padding_y(&self) -> usize {
        self.padding_y
    }

    pub fn has_background(&self) -> bool {
        self.bg_fn.is_some()
    }

    pub fn cached_render(&self) -> Option<&BoxRenderCache> {
        self.cache.as_ref()
    }

    pub fn set_padding_x(&mut self, padding_x: usize) {
        self.padding_x = padding_x;
        self.invalidate_cache();
    }

    pub fn set_padding_y(&mut self, padding_y: usize) {
        self.padding_y = padding_y;
        self.invalidate_cache();
    }

    pub fn set_padding(&mut self, padding_x: usize, padding_y: usize) {
        self.padding_x = padding_x;
        self.padding_y = padding_y;
        self.invalidate_cache();
    }

    pub fn set_bg_fn(&mut self, bg_fn: Option<BoxBackgroundFn>) {
        self.bg_fn = bg_fn;
    }

    pub fn add_child(&mut self, mut child: BoxChild) -> BoxChildId {
        let id = BoxChildId(self.next_child_id);
        self.next_child_id = self.next_child_id.wrapping_add(1).max(1);
        child.set_id(id);
        self.children.push(child);
        self.invalidate_cache();
        id
    }

    pub fn add_render_child<F>(&mut self, render: F) -> BoxChildId
    where
        F: FnMut(usize) -> Vec<String> + 'static,
    {
        self.add_child(BoxChild::new(render))
    }

    pub fn remove_child(&mut self, id: BoxChildId) -> bool {
        let Some(index) = self.children.iter().position(|child| child.id() == id) else {
            return false;
        };

        self.children.remove(index);
        self.invalidate_cache();
        true
    }

    pub fn clear(&mut self) {
        self.children.clear();
        self.invalidate_cache();
    }

    pub fn invalidate(&mut self) {
        self.invalidate_cache();
        for child in &mut self.children {
            child.invalidate();
        }
    }

    pub fn render(&mut self, width: usize) -> Vec<String> {
        if self.children.is_empty() {
            return Vec::new();
        }

        let content_width = width
            .saturating_sub(self.padding_x.saturating_mul(2))
            .max(1);
        let left_padding = " ".repeat(self.padding_x);

        let mut child_lines = Vec::new();
        for child in &mut self.children {
            for line in child.render(content_width) {
                child_lines.push(format!("{left_padding}{line}"));
            }
        }

        if child_lines.is_empty() {
            return Vec::new();
        }

        let bg_sample = self.bg_fn.map(|bg_fn| bg_fn("test"));
        if self.matches_cache(width, &child_lines, bg_sample.as_deref()) {
            return self
                .cache
                .as_ref()
                .expect("box cache should exist after cache match")
                .lines
                .clone();
        }

        let mut lines = Vec::new();
        for _ in 0..self.padding_y {
            lines.push(self.apply_background("", width));
        }
        for line in &child_lines {
            lines.push(self.apply_background(line, width));
        }
        for _ in 0..self.padding_y {
            lines.push(self.apply_background("", width));
        }

        self.cache = Some(BoxRenderCache {
            child_lines,
            width,
            bg_sample,
            lines: lines.clone(),
        });

        lines
    }

    fn invalidate_cache(&mut self) {
        self.cache = None;
    }

    fn matches_cache(&self, width: usize, child_lines: &[String], bg_sample: Option<&str>) -> bool {
        let Some(cache) = &self.cache else {
            return false;
        };

        cache.width == width
            && cache.bg_sample.as_deref() == bg_sample
            && cache.child_lines.len() == child_lines.len()
            && cache
                .child_lines
                .iter()
                .zip(child_lines)
                .all(|(cached, rendered)| cached == rendered)
    }

    fn apply_background(&self, line: &str, width: usize) -> String {
        let padding_needed = width.saturating_sub(visible_width(line));
        let padded = format!("{line}{}", " ".repeat(padding_needed));

        match self.bg_fn {
            Some(bg_fn) => apply_background_to_line(&padded, width, bg_fn),
            None => padded,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::visible_width;
    use std::cell::Cell;
    use std::rc::Rc;

    fn square_background(text: &str) -> String {
        format!("[{text}]")
    }

    fn round_background(text: &str) -> String {
        format!("({text})")
    }

    #[test]
    fn empty_box_renders_no_lines() {
        let mut component = BoxComponent::default();

        assert_eq!(component.render(20), Vec::<String>::new());
        assert!(component.cached_render().is_none());
    }

    #[test]
    fn renders_children_with_padding_and_background() {
        let mut component = BoxComponent::new(2, 1, Some(square_background));
        component.add_render_child(|width| {
            assert_eq!(width, 6);
            vec!["hi".to_string()]
        });

        let lines = component.render(10);

        assert_eq!(
            lines,
            vec![
                "[          ]".to_string(),
                "[  hi      ]".to_string(),
                "[          ]".to_string(),
            ]
        );
        assert_eq!(
            component
                .cached_render()
                .map(|cache| cache.bg_sample.as_deref()),
            Some(Some("[test]"))
        );
        for line in lines {
            assert_eq!(visible_width(&line), 12);
        }
    }

    #[test]
    fn cache_is_keyed_by_child_lines_width_and_background_sample() {
        let mut component = BoxComponent::new(1, 0, Some(square_background));
        component.add_render_child(|_| vec!["one".to_string()]);

        let first = component.render(8);
        let first_cache = component.cached_render().cloned();
        let second = component.render(8);

        assert_eq!(first, second);
        assert_eq!(component.cached_render().cloned(), first_cache);

        component.set_bg_fn(Some(round_background));
        let third = component.render(8);

        assert_ne!(first, third);
        assert_eq!(
            component
                .cached_render()
                .map(|cache| cache.bg_sample.as_deref()),
            Some(Some("(test)"))
        );
    }

    #[test]
    fn child_management_invalidates_cache_and_children() {
        let invalidated = Rc::new(Cell::new(false));
        let invalidated_callback = Rc::clone(&invalidated);
        let mut component = BoxComponent::new(0, 0, None);
        let id = component.add_child(
            BoxChild::new(|_| vec!["child".to_string()])
                .with_invalidate(move || invalidated_callback.set(true)),
        );

        assert_eq!(component.render(10), vec!["child     ".to_string()]);
        assert!(component.cached_render().is_some());

        component.invalidate();
        assert!(invalidated.get());
        assert!(component.cached_render().is_none());

        assert!(component.remove_child(id));
        assert_eq!(component.render(10), Vec::<String>::new());
        assert!(!component.remove_child(id));

        component.add_render_child(|_| vec!["next".to_string()]);
        assert_eq!(component.child_count(), 1);
        component.clear();
        assert_eq!(component.child_count(), 0);
        assert!(component.cached_render().is_none());
    }
}
