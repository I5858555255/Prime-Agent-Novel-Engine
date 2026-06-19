use prime_agent_ai::event_stream::{EventStream, EventStreamResult};

use crate::{AgentEvent, AgentMessage};

#[derive(Debug, Clone)]
pub struct AgentEventStream {
    inner: EventStream<AgentEvent, Vec<AgentMessage>>,
}

impl AgentEventStream {
    pub fn new() -> Self {
        Self {
            inner: EventStream::new(
                |event| matches!(event, AgentEvent::AgentEnd { .. }),
                |event| match event {
                    AgentEvent::AgentEnd { messages } => messages.clone(),
                    _ => unreachable!("agent stream result can only be extracted from agent_end"),
                },
            ),
        }
    }

    pub fn push(&mut self, event: AgentEvent) {
        self.inner.push(event);
    }

    pub fn end(&mut self, result: Option<Vec<AgentMessage>>) {
        self.inner.end(result);
    }

    pub fn result(&self) -> EventStreamResult<Vec<AgentMessage>> {
        self.inner.result()
    }

    pub fn next_event(&mut self) -> Option<AgentEvent> {
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

impl Default for AgentEventStream {
    fn default() -> Self {
        Self::new()
    }
}

impl Iterator for AgentEventStream {
    type Item = AgentEvent;

    fn next(&mut self) -> Option<Self::Item> {
        self.next_event()
    }
}

pub fn create_agent_event_stream() -> AgentEventStream {
    AgentEventStream::new()
}

#[cfg(test)]
mod tests {
    use prime_agent_ai::event_stream::EventStreamError;

    use super::*;
    use crate::state::text_user_message;

    #[test]
    fn agent_event_stream_extracts_messages_from_agent_end() {
        let message = text_user_message("hello", 1);
        let mut stream = AgentEventStream::new();

        stream.push(AgentEvent::AgentStart);
        stream.push(AgentEvent::AgentEnd {
            messages: vec![message.clone()],
        });
        stream.push(AgentEvent::TurnStart);

        assert!(stream.is_done());
        assert_eq!(stream.result().unwrap(), vec![message]);
        assert_eq!(stream.collect::<Vec<_>>().len(), 2);
    }

    #[test]
    fn agent_event_stream_reports_missing_terminal_result() {
        let mut stream = AgentEventStream::new();

        assert_eq!(stream.result(), Err(EventStreamError::NoTerminalEvent));
        stream.push(AgentEvent::AgentStart);
        stream.end(None);

        assert_eq!(stream.result(), Err(EventStreamError::EndedWithoutResult));
    }

    #[test]
    fn create_agent_event_stream_returns_empty_stream() {
        let stream = create_agent_event_stream();

        assert!(stream.is_empty());
        assert!(!stream.is_done());
    }
}
