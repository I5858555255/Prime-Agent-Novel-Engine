#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct KillRingPushOptions {
    pub prepend: bool,
    pub accumulate: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct KillRing {
    ring: Vec<String>,
}

impl KillRing {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, text: &str, options: KillRingPushOptions) {
        if text.is_empty() {
            return;
        }

        if options.accumulate
            && let Some(last) = self.ring.last_mut()
        {
            if options.prepend {
                let mut combined = String::with_capacity(text.len() + last.len());
                combined.push_str(text);
                combined.push_str(last);
                *last = combined;
            } else {
                last.push_str(text);
            }
            return;
        }

        self.ring.push(text.to_string());
    }

    pub fn peek(&self) -> Option<&str> {
        self.ring.last().map(String::as_str)
    }

    pub fn rotate(&mut self) {
        if self.ring.len() <= 1 {
            return;
        }

        let last = self.ring.pop().expect("ring length checked");
        self.ring.insert(0, last);
    }

    pub fn len(&self) -> usize {
        self.ring.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ring.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(prepend: bool, accumulate: bool) -> KillRingPushOptions {
        KillRingPushOptions {
            prepend,
            accumulate,
        }
    }

    #[test]
    fn new_ring_is_empty() {
        let ring = KillRing::new();

        assert_eq!(ring.len(), 0);
        assert!(ring.is_empty());
        assert_eq!(ring.peek(), None);
    }

    #[test]
    fn empty_push_is_ignored() {
        let mut ring = KillRing::new();

        ring.push("", options(false, false));

        assert!(ring.is_empty());
        assert_eq!(ring.peek(), None);
    }

    #[test]
    fn push_stores_entries_and_peek_returns_most_recent() {
        let mut ring = KillRing::new();

        ring.push("first", options(false, false));
        ring.push("second", options(false, false));

        assert_eq!(ring.len(), 2);
        assert_eq!(ring.peek(), Some("second"));
    }

    #[test]
    fn accumulate_without_an_existing_entry_pushes_a_new_entry() {
        let mut ring = KillRing::new();

        ring.push("first", options(true, true));

        assert_eq!(ring.len(), 1);
        assert_eq!(ring.peek(), Some("first"));
    }

    #[test]
    fn backward_kills_prepend_when_accumulating() {
        let mut ring = KillRing::new();

        ring.push("three", options(true, false));
        ring.push("two ", options(true, true));
        ring.push("one ", options(true, true));

        assert_eq!(ring.len(), 1);
        assert_eq!(ring.peek(), Some("one two three"));
    }

    #[test]
    fn forward_kills_append_when_accumulating() {
        let mut ring = KillRing::new();

        ring.push("hello", options(false, false));
        ring.push(" world", options(false, true));
        ring.push(" test", options(false, true));

        assert_eq!(ring.len(), 1);
        assert_eq!(ring.peek(), Some("hello world test"));
    }

    #[test]
    fn non_accumulating_push_starts_a_separate_entry() {
        let mut ring = KillRing::new();

        ring.push("baz", options(true, false));
        ring.push("x", options(true, false));

        assert_eq!(ring.len(), 2);
        assert_eq!(ring.peek(), Some("x"));

        ring.rotate();

        assert_eq!(ring.peek(), Some("baz"));
    }

    #[test]
    fn rotate_is_noop_for_empty_and_single_entry_rings() {
        let mut empty = KillRing::new();
        empty.rotate();
        assert!(empty.is_empty());
        assert_eq!(empty.peek(), None);

        let mut single = KillRing::new();
        single.push("only", options(false, false));
        single.rotate();
        assert_eq!(single.len(), 1);
        assert_eq!(single.peek(), Some("only"));
    }

    #[test]
    fn rotate_cycles_through_entries_from_newest_to_oldest() {
        let mut ring = KillRing::new();

        ring.push("first", options(false, false));
        ring.push("second", options(false, false));
        ring.push("third", options(false, false));

        assert_eq!(ring.peek(), Some("third"));

        ring.rotate();
        assert_eq!(ring.peek(), Some("second"));

        ring.rotate();
        assert_eq!(ring.peek(), Some("first"));

        ring.rotate();
        assert_eq!(ring.peek(), Some("third"));
    }

    #[test]
    fn rotation_persists_for_future_peeks() {
        let mut ring = KillRing::new();

        ring.push("first", options(false, false));
        ring.push("second", options(false, false));
        ring.push("third", options(false, false));

        ring.rotate();

        assert_eq!(ring.peek(), Some("second"));
    }
}
