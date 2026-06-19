#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueMode {
    All,
    OneAtATime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingMessageQueue<T> {
    mode: QueueMode,
    messages: Vec<T>,
}

impl<T> PendingMessageQueue<T> {
    pub fn new(mode: QueueMode) -> Self {
        Self {
            mode,
            messages: Vec::new(),
        }
    }

    pub fn mode(&self) -> QueueMode {
        self.mode
    }

    pub fn set_mode(&mut self, mode: QueueMode) {
        self.mode = mode;
    }

    pub fn enqueue(&mut self, message: T) {
        self.messages.push(message);
    }

    pub fn has_items(&self) -> bool {
        !self.messages.is_empty()
    }

    pub fn len(&self) -> usize {
        self.messages.len()
    }

    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    pub fn drain(&mut self) -> Vec<T> {
        match self.mode {
            QueueMode::All => self.messages.drain(..).collect(),
            QueueMode::OneAtATime => {
                if self.messages.is_empty() {
                    Vec::new()
                } else {
                    vec![self.messages.remove(0)]
                }
            }
        }
    }

    pub fn clear(&mut self) {
        self.messages.clear();
    }

    pub fn remove_where<F>(&mut self, mut predicate: F) -> Vec<T>
    where
        F: FnMut(&T) -> bool,
    {
        let mut removed = Vec::new();
        let mut retained = Vec::new();

        for message in self.messages.drain(..) {
            if predicate(&message) {
                removed.push(message);
            } else {
                retained.push(message);
            }
        }

        self.messages = retained;
        removed
    }
}

impl<T> Default for PendingMessageQueue<T> {
    fn default() -> Self {
        Self::new(QueueMode::OneAtATime)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_mode_drains_everything() {
        let mut queue = PendingMessageQueue::new(QueueMode::All);
        queue.enqueue("a");
        queue.enqueue("b");

        assert_eq!(queue.drain(), vec!["a", "b"]);
        assert!(queue.is_empty());
    }

    #[test]
    fn one_at_a_time_mode_drains_single_item_in_order() {
        let mut queue = PendingMessageQueue::new(QueueMode::OneAtATime);
        queue.enqueue("a");
        queue.enqueue("b");

        assert_eq!(queue.drain(), vec!["a"]);
        assert_eq!(queue.drain(), vec!["b"]);
        assert!(queue.drain().is_empty());
    }

    #[test]
    fn remove_where_returns_removed_items_and_retains_order() {
        let mut queue = PendingMessageQueue::new(QueueMode::All);
        queue.enqueue(1);
        queue.enqueue(2);
        queue.enqueue(3);
        queue.enqueue(4);

        let removed = queue.remove_where(|value| value % 2 == 0);

        assert_eq!(removed, vec![2, 4]);
        assert_eq!(queue.drain(), vec![1, 3]);
    }

    #[test]
    fn clear_removes_pending_items() {
        let mut queue = PendingMessageQueue::default();
        queue.enqueue("a");

        queue.clear();

        assert!(!queue.has_items());
    }
}
