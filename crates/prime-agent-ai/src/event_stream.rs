use crate::types::{AssistantMessage, AssistantMessageEvent};
use std::collections::VecDeque;
use std::error::Error;
use std::fmt;
use std::sync::Arc;

type IsComplete<T> = dyn Fn(&T) -> bool + Send + Sync + 'static;
type ExtractResult<T, R> = dyn Fn(&T) -> R + Send + Sync + 'static;

pub type EventStreamResult<T> = Result<T, EventStreamError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventStreamError {
    NoTerminalEvent,
    EndedWithoutResult,
}

impl fmt::Display for EventStreamError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoTerminalEvent => f.write_str("stream has no terminal result yet"),
            Self::EndedWithoutResult => f.write_str("stream ended without a result"),
        }
    }
}

impl Error for EventStreamError {}

pub struct EventStream<T, R = T> {
    queue: VecDeque<T>,
    done: bool,
    result: Option<R>,
    is_complete: Arc<IsComplete<T>>,
    extract_result: Arc<ExtractResult<T, R>>,
}

impl<T, R> EventStream<T, R> {
    pub fn new(
        is_complete: impl Fn(&T) -> bool + Send + Sync + 'static,
        extract_result: impl Fn(&T) -> R + Send + Sync + 'static,
    ) -> Self {
        Self {
            queue: VecDeque::new(),
            done: false,
            result: None,
            is_complete: Arc::new(is_complete),
            extract_result: Arc::new(extract_result),
        }
    }

    pub fn push(&mut self, event: T) {
        if self.done {
            return;
        }

        if (self.is_complete)(&event) {
            self.done = true;
            if self.result.is_none() {
                self.result = Some((self.extract_result)(&event));
            }
        }

        self.queue.push_back(event);
    }

    pub fn end(&mut self, result: Option<R>) {
        self.done = true;
        if self.result.is_none() {
            self.result = result;
        }
    }

    pub fn next_event(&mut self) -> Option<T> {
        self.queue.pop_front()
    }

    pub fn pending_len(&self) -> usize {
        self.queue.len()
    }

    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    pub fn is_done(&self) -> bool {
        self.done
    }
}

impl<T, R: Clone> EventStream<T, R> {
    pub fn result(&self) -> EventStreamResult<R> {
        if let Some(result) = &self.result {
            Ok(result.clone())
        } else if self.done {
            Err(EventStreamError::EndedWithoutResult)
        } else {
            Err(EventStreamError::NoTerminalEvent)
        }
    }
}

impl<T, R> Iterator for EventStream<T, R> {
    type Item = T;

    fn next(&mut self) -> Option<Self::Item> {
        self.next_event()
    }
}

impl<T: Clone, R: Clone> Clone for EventStream<T, R> {
    fn clone(&self) -> Self {
        Self {
            queue: self.queue.clone(),
            done: self.done,
            result: self.result.clone(),
            is_complete: Arc::clone(&self.is_complete),
            extract_result: Arc::clone(&self.extract_result),
        }
    }
}

impl<T: fmt::Debug, R: fmt::Debug> fmt::Debug for EventStream<T, R> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EventStream")
            .field("queue", &self.queue)
            .field("done", &self.done)
            .field("result", &self.result)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone)]
pub struct AssistantMessageEventStream {
    inner: EventStream<AssistantMessageEvent, AssistantMessage>,
}

impl AssistantMessageEventStream {
    pub fn new() -> Self {
        Self {
            inner: EventStream::new(
                |event| {
                    matches!(
                        event,
                        AssistantMessageEvent::Done { .. } | AssistantMessageEvent::Error { .. }
                    )
                },
                |event| match event {
                    AssistantMessageEvent::Done { message }
                    | AssistantMessageEvent::Error { message } => message.clone(),
                    _ => unreachable!(
                        "assistant message result can only be extracted from terminal events"
                    ),
                },
            ),
        }
    }

    pub fn push(&mut self, event: AssistantMessageEvent) {
        self.inner.push(event);
    }

    pub fn end(&mut self, result: Option<AssistantMessage>) {
        self.inner.end(result);
    }

    pub fn result(&self) -> EventStreamResult<AssistantMessage> {
        self.inner.result()
    }

    pub fn next_event(&mut self) -> Option<AssistantMessageEvent> {
        self.inner.next_event()
    }

    pub fn pending_len(&self) -> usize {
        self.inner.pending_len()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    pub fn is_done(&self) -> bool {
        self.inner.is_done()
    }
}

impl Default for AssistantMessageEventStream {
    fn default() -> Self {
        Self::new()
    }
}

impl Iterator for AssistantMessageEventStream {
    type Item = AssistantMessageEvent;

    fn next(&mut self) -> Option<Self::Item> {
        self.next_event()
    }
}

pub fn create_assistant_message_event_stream() -> AssistantMessageEventStream {
    AssistantMessageEventStream::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AssistantMessageEvent, ContentBlock, Cost, StopReason, Usage};

    fn assistant_message(api: &str, text: &str) -> AssistantMessage {
        AssistantMessage {
            content: vec![ContentBlock::text(text)],
            api: api.to_string(),
            provider: "test".to_string(),
            model: "model-id".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage {
                cost: Cost::default(),
                ..Usage::default()
            },
            stop_reason: StopReason::Stop,
            error_message: None,
            timestamp: 42,
        }
    }

    #[test]
    fn event_stream_queues_events_before_consumer_and_extracts_terminal_result() {
        let mut stream = EventStream::new(|event: &i32| *event == 3, |event| *event * 10);

        stream.push(1);
        stream.push(2);
        stream.push(3);

        assert!(stream.is_done());
        assert_eq!(stream.result().unwrap(), 30);
        assert_eq!(stream.collect::<Vec<_>>(), vec![1, 2, 3]);
    }

    #[test]
    fn event_stream_ignores_pushes_after_completion() {
        let mut stream = EventStream::new(|event: &i32| *event == 2, |event| *event);

        stream.push(1);
        stream.push(2);
        stream.push(3);

        assert_eq!(stream.result().unwrap(), 2);
        assert_eq!(stream.collect::<Vec<_>>(), vec![1, 2]);
    }

    #[test]
    fn event_stream_end_sets_optional_result_without_clearing_queue() {
        let mut stream = EventStream::new(|event: &i32| *event == 9, |event| *event);

        stream.push(1);
        stream.end(Some(7));

        assert!(stream.is_done());
        assert_eq!(stream.result().unwrap(), 7);
        assert_eq!(stream.collect::<Vec<_>>(), vec![1]);
    }

    #[test]
    fn event_stream_reports_missing_result_after_plain_end() {
        let mut stream = EventStream::new(|event: &i32| *event == 9, |event| *event);

        stream.end(None);

        assert_eq!(stream.result(), Err(EventStreamError::EndedWithoutResult));
    }

    #[test]
    fn assistant_message_event_stream_extracts_done_and_factory_matches_constructor() {
        let message = assistant_message("test-api", "done");
        let mut stream = create_assistant_message_event_stream();

        stream.push(AssistantMessageEvent::Done {
            message: message.clone(),
        });

        assert!(stream.is_done());
        assert_eq!(stream.result().unwrap(), message);
        assert!(AssistantMessageEventStream::new().is_empty());
    }
}
