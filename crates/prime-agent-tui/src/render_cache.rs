#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct VersionedRenderCache {
    cached_width: Option<usize>,
    cached_version: Option<u64>,
    cached_lines: Option<Vec<String>>,
}

impl VersionedRenderCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, width: usize, version: u64) -> Option<&[String]> {
        if self.cached_width == Some(width) && self.cached_version == Some(version) {
            return self.cached_lines.as_deref();
        }
        None
    }

    pub fn set(&mut self, width: usize, version: u64, lines: Vec<String>) -> &[String] {
        self.cached_width = Some(width);
        self.cached_version = Some(version);
        self.cached_lines = Some(lines);
        self.cached_lines.as_deref().expect("cache just set")
    }

    pub fn invalidate(&mut self) {
        self.cached_width = None;
        self.cached_version = None;
        self.cached_lines = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_cached_lines_for_matching_width_and_version() {
        let mut cache = VersionedRenderCache::new();
        cache.set(80, 3, vec!["one".to_string(), "two".to_string()]);

        assert_eq!(
            cache.get(80, 3),
            Some(&["one".to_string(), "two".to_string()][..])
        );
    }

    #[test]
    fn misses_when_width_or_version_differs() {
        let mut cache = VersionedRenderCache::new();
        cache.set(80, 3, vec!["line".to_string()]);

        assert_eq!(cache.get(79, 3), None);
        assert_eq!(cache.get(80, 4), None);
    }

    #[test]
    fn set_replaces_existing_entry_and_returns_it() {
        let mut cache = VersionedRenderCache::new();
        cache.set(80, 3, vec!["old".to_string()]);

        let returned = cache.set(100, 4, vec!["new".to_string()]);

        assert_eq!(returned, &["new".to_string()][..]);
        assert_eq!(cache.get(80, 3), None);
        assert_eq!(cache.get(100, 4), Some(&["new".to_string()][..]));
    }

    #[test]
    fn invalidate_clears_cached_entry() {
        let mut cache = VersionedRenderCache::new();
        cache.set(80, 3, vec!["line".to_string()]);

        cache.invalidate();

        assert_eq!(cache.get(80, 3), None);
    }
}
