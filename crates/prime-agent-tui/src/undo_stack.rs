#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UndoStack<S> {
    stack: Vec<S>,
}

impl<S> Default for UndoStack<S> {
    fn default() -> Self {
        Self { stack: Vec::new() }
    }
}

impl<S> UndoStack<S>
where
    S: Clone,
{
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, state: &S) {
        self.stack.push(state.clone());
    }

    pub fn pop(&mut self) -> Option<S> {
        self.stack.pop()
    }

    pub fn clear(&mut self) {
        self.stack.clear();
    }

    pub fn len(&self) -> usize {
        self.stack.len()
    }

    pub fn is_empty(&self) -> bool {
        self.stack.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct EditorSnapshot {
        lines: Vec<String>,
        cursor: (usize, usize),
    }

    #[test]
    fn push_clones_snapshots_so_later_mutations_are_detached() {
        let mut stack = UndoStack::new();
        let mut snapshot = EditorSnapshot {
            lines: vec!["hello".to_string()],
            cursor: (0, 5),
        };

        stack.push(&snapshot);
        snapshot.lines[0].push_str(" world");
        snapshot.cursor = (0, 11);

        assert_eq!(
            stack.pop(),
            Some(EditorSnapshot {
                lines: vec!["hello".to_string()],
                cursor: (0, 5),
            })
        );
    }

    #[test]
    fn pop_returns_most_recent_snapshot() {
        let mut stack = UndoStack::new();
        stack.push(&"first".to_string());
        stack.push(&"second".to_string());

        assert_eq!(stack.len(), 2);
        assert_eq!(stack.pop().as_deref(), Some("second"));
        assert_eq!(stack.pop().as_deref(), Some("first"));
        assert_eq!(stack.pop(), None);
        assert!(stack.is_empty());
    }

    #[test]
    fn clear_removes_all_snapshots() {
        let mut stack = UndoStack::new();
        stack.push(&vec![1, 2, 3]);
        stack.push(&vec![4, 5, 6]);

        stack.clear();

        assert_eq!(stack.len(), 0);
        assert_eq!(stack.pop(), None);
    }
}
