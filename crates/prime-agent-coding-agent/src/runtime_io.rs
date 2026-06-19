use std::collections::HashMap;
use std::fmt;
use std::io::{self, Write};
use std::panic::{self, AssertUnwindSafe};
use std::sync::{Arc, Mutex};

type Handler<T> = dyn Fn(T) -> EventHandlerResult + Send + Sync + 'static;

pub type EventHandlerResult = Result<(), EventHandlerError>;

#[derive(Debug)]
pub struct EventHandlerError {
    message: String,
}

impl EventHandlerError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for EventHandlerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for EventHandlerError {}

struct HandlerEntry<T> {
    id: u64,
    handler: Arc<Handler<T>>,
}

impl<T> Clone for HandlerEntry<T> {
    fn clone(&self) -> Self {
        Self {
            id: self.id,
            handler: Arc::clone(&self.handler),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventHandlerFailure {
    pub channel: String,
    pub handler_id: u64,
    pub kind: EventHandlerFailureKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventHandlerFailureKind {
    Error(String),
    Panic,
}

struct EventBusState<T> {
    next_id: u64,
    handlers: HashMap<String, Vec<HandlerEntry<T>>>,
}

impl<T> Default for EventBusState<T> {
    fn default() -> Self {
        Self {
            next_id: 1,
            handlers: HashMap::new(),
        }
    }
}

pub struct EventBus<T> {
    state: Arc<Mutex<EventBusState<T>>>,
}

impl<T> Clone for EventBus<T> {
    fn clone(&self) -> Self {
        Self {
            state: Arc::clone(&self.state),
        }
    }
}

impl<T> Default for EventBus<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> EventBus<T> {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(EventBusState::default())),
        }
    }

    pub fn on(
        &self,
        channel: impl Into<String>,
        handler: impl Fn(T) -> EventHandlerResult + Send + Sync + 'static,
    ) -> EventSubscription<T> {
        let channel = channel.into();
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        let id = state.next_id;
        state.next_id += 1;
        state
            .handlers
            .entry(channel.clone())
            .or_default()
            .push(HandlerEntry {
                id,
                handler: Arc::new(handler),
            });

        EventSubscription {
            bus: self.clone(),
            channel,
            id,
        }
    }

    pub fn unsubscribe(&self, channel: &str, handler_id: u64) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        let Some(handlers) = state.handlers.get_mut(channel) else {
            return false;
        };

        let before = handlers.len();
        handlers.retain(|entry| entry.id != handler_id);
        let removed = handlers.len() != before;
        if handlers.is_empty() {
            state.handlers.remove(channel);
        }
        removed
    }

    pub fn clear(&self) {
        self.state
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .handlers
            .clear();
    }
}

impl<T: Clone> EventBus<T> {
    pub fn emit(&self, channel: &str, data: T) -> Vec<EventHandlerFailure> {
        let handlers = {
            let state = self.state.lock().unwrap_or_else(|err| err.into_inner());
            state.handlers.get(channel).cloned().unwrap_or_default()
        };

        let mut failures = Vec::new();
        for entry in handlers {
            let result = panic::catch_unwind(AssertUnwindSafe(|| (entry.handler)(data.clone())));
            match result {
                Ok(Ok(())) => {}
                Ok(Err(err)) => failures.push(EventHandlerFailure {
                    channel: channel.to_string(),
                    handler_id: entry.id,
                    kind: EventHandlerFailureKind::Error(err.to_string()),
                }),
                Err(_) => failures.push(EventHandlerFailure {
                    channel: channel.to_string(),
                    handler_id: entry.id,
                    kind: EventHandlerFailureKind::Panic,
                }),
            }
        }
        failures
    }
}

pub struct EventSubscription<T> {
    bus: EventBus<T>,
    channel: String,
    id: u64,
}

impl<T> EventSubscription<T> {
    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn channel(&self) -> &str {
        &self.channel
    }

    pub fn unsubscribe(&self) -> bool {
        self.bus.unsubscribe(&self.channel, self.id)
    }
}

#[derive(Debug)]
pub struct OutputGuard<W: Write, E: Write> {
    stdout: W,
    stderr: E,
    stdout_taken_over: bool,
}

impl<W: Write, E: Write> OutputGuard<W, E> {
    pub fn new(stdout: W, stderr: E) -> Self {
        Self {
            stdout,
            stderr,
            stdout_taken_over: false,
        }
    }

    pub fn take_over_stdout(&mut self) {
        self.stdout_taken_over = true;
    }

    pub fn restore_stdout(&mut self) {
        self.stdout_taken_over = false;
    }

    pub fn is_stdout_taken_over(&self) -> bool {
        self.stdout_taken_over
    }

    pub fn write_stdout(&mut self, text: impl AsRef<str>) -> io::Result<()> {
        if self.stdout_taken_over {
            self.stderr.write_all(text.as_ref().as_bytes())
        } else {
            self.stdout.write_all(text.as_ref().as_bytes())
        }
    }

    pub fn write_stderr(&mut self, text: impl AsRef<str>) -> io::Result<()> {
        self.stderr.write_all(text.as_ref().as_bytes())
    }

    pub fn write_raw_stdout(&mut self, text: impl AsRef<str>) -> io::Result<()> {
        self.stdout.write_all(text.as_ref().as_bytes())
    }

    pub fn flush_raw_stdout(&mut self) -> io::Result<()> {
        self.stdout.flush()
    }

    pub fn flush_stderr(&mut self) -> io::Result<()> {
        self.stderr.flush()
    }

    pub fn writers(&self) -> (&W, &E) {
        (&self.stdout, &self.stderr)
    }

    pub fn writers_mut(&mut self) -> (&mut W, &mut E) {
        (&mut self.stdout, &mut self.stderr)
    }

    pub fn into_writers(self) -> (W, E) {
        (self.stdout, self.stderr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes_to_string(bytes: Vec<u8>) -> String {
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn event_bus_emits_to_matching_channel_in_registration_order() {
        let bus = EventBus::<String>::new();
        let seen = Arc::new(Mutex::new(Vec::new()));

        {
            let seen = Arc::clone(&seen);
            bus.on("status", move |value| {
                seen.lock().unwrap().push(format!("first:{value}"));
                Ok(())
            });
        }
        {
            let seen = Arc::clone(&seen);
            bus.on("status", move |value| {
                seen.lock().unwrap().push(format!("second:{value}"));
                Ok(())
            });
        }
        bus.on("other", |_| panic!("wrong channel"));

        let failures = bus.emit("status", "ready".to_string());

        assert!(failures.is_empty());
        assert_eq!(
            *seen.lock().unwrap(),
            vec!["first:ready".to_string(), "second:ready".to_string()]
        );
    }

    #[test]
    fn event_bus_subscription_can_unsubscribe_handler() {
        let bus = EventBus::<usize>::new();
        let seen = Arc::new(Mutex::new(Vec::new()));

        let subscription = {
            let seen = Arc::clone(&seen);
            bus.on("tick", move |value| {
                seen.lock().unwrap().push(value);
                Ok(())
            })
        };

        assert_eq!(subscription.channel(), "tick");
        assert!(subscription.unsubscribe());
        assert!(!subscription.unsubscribe());

        assert!(bus.emit("tick", 1).is_empty());
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn event_bus_clear_removes_all_handlers() {
        let bus = EventBus::<usize>::new();
        let seen = Arc::new(Mutex::new(0));

        {
            let seen = Arc::clone(&seen);
            bus.on("tick", move |value| {
                *seen.lock().unwrap() += value;
                Ok(())
            });
        }

        bus.clear();
        bus.emit("tick", 10);

        assert_eq!(*seen.lock().unwrap(), 0);
    }

    #[test]
    fn event_bus_handler_errors_and_panics_do_not_poison_future_emits() {
        let bus = EventBus::<usize>::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let old_hook = panic::take_hook();
        panic::set_hook(Box::new(|_| {}));

        bus.on("tick", |_| Err(EventHandlerError::new("boom")));
        bus.on("tick", |_| panic!("handler panic"));
        {
            let seen = Arc::clone(&seen);
            bus.on("tick", move |value| {
                seen.lock().unwrap().push(value);
                Ok(())
            });
        }

        let failures = bus.emit("tick", 1);
        assert_eq!(failures.len(), 2);
        assert_eq!(
            failures[0].kind,
            EventHandlerFailureKind::Error("boom".to_string())
        );
        assert_eq!(failures[1].kind, EventHandlerFailureKind::Panic);

        let failures = bus.emit("tick", 2);
        assert_eq!(failures.len(), 2);
        assert_eq!(*seen.lock().unwrap(), vec![1, 2]);

        panic::set_hook(old_hook);
    }

    #[test]
    fn output_guard_routes_stdout_to_stderr_while_taken_over() {
        let mut guard = OutputGuard::new(Vec::new(), Vec::new());

        guard.write_stdout("before").unwrap();
        guard.take_over_stdout();
        guard.write_stdout("redirected").unwrap();
        guard.write_stderr(":err").unwrap();
        guard.write_raw_stdout(":raw").unwrap();
        guard.restore_stdout();
        guard.write_stdout(":after").unwrap();

        let (stdout, stderr) = guard.into_writers();
        assert_eq!(bytes_to_string(stdout), "before:raw:after");
        assert_eq!(bytes_to_string(stderr), "redirected:err");
    }

    #[test]
    fn output_guard_takeover_and_restore_are_idempotent() {
        let mut guard = OutputGuard::new(Vec::new(), Vec::new());

        assert!(!guard.is_stdout_taken_over());
        guard.restore_stdout();
        assert!(!guard.is_stdout_taken_over());

        guard.take_over_stdout();
        guard.take_over_stdout();
        assert!(guard.is_stdout_taken_over());

        guard.restore_stdout();
        guard.restore_stdout();
        assert!(!guard.is_stdout_taken_over());
    }

    #[test]
    fn output_guard_flushes_raw_stdout() {
        let mut guard = OutputGuard::new(Vec::new(), Vec::new());

        guard.write_raw_stdout("raw").unwrap();
        guard.flush_raw_stdout().unwrap();

        let (stdout, stderr) = guard.into_writers();
        assert_eq!(bytes_to_string(stdout), "raw");
        assert!(stderr.is_empty());
    }
}
