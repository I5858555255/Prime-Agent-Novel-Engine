use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use crate::keybindings::get_keybindings;
use crate::loader::{Loader, LoaderIndicatorOptions, LoaderStyleFn};

#[derive(Debug, Clone, Default)]
pub struct CancellationFlag {
    aborted: Arc<AtomicBool>,
}

impl CancellationFlag {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn abort(&self) {
        self.aborted.store(true, Ordering::SeqCst);
    }

    pub fn aborted(&self) -> bool {
        self.aborted.load(Ordering::SeqCst)
    }
}

pub struct CancellableLoader {
    loader: Loader,
    cancellation: CancellationFlag,
    on_abort: Option<Box<dyn FnMut()>>,
}

impl std::fmt::Debug for CancellableLoader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CancellableLoader")
            .field("loader", &self.loader)
            .field("cancellation", &self.cancellation)
            .field("on_abort", &self.on_abort.is_some())
            .finish()
    }
}

impl CancellableLoader {
    pub fn new(
        spinner_color_fn: LoaderStyleFn,
        message_color_fn: LoaderStyleFn,
        message: impl Into<String>,
        indicator: Option<LoaderIndicatorOptions>,
    ) -> Self {
        Self::from_loader(Loader::new(
            spinner_color_fn,
            message_color_fn,
            message,
            indicator,
        ))
    }

    pub fn from_loader(loader: Loader) -> Self {
        Self {
            loader,
            cancellation: CancellationFlag::new(),
            on_abort: None,
        }
    }

    pub fn loader(&self) -> &Loader {
        &self.loader
    }

    pub fn loader_mut(&mut self) -> &mut Loader {
        &mut self.loader
    }

    pub fn cancellation_flag(&self) -> CancellationFlag {
        self.cancellation.clone()
    }

    pub fn aborted(&self) -> bool {
        self.cancellation.aborted()
    }

    pub fn set_on_abort<F>(&mut self, on_abort: F)
    where
        F: FnMut() + 'static,
    {
        self.on_abort = Some(Box::new(on_abort));
    }

    pub fn clear_on_abort(&mut self) {
        self.on_abort = None;
    }

    pub fn handle_input(&mut self, data: &str) -> bool {
        let should_abort = {
            let keybindings = get_keybindings();
            keybindings.matches(data, "tui.select.cancel")
        };

        if !should_abort {
            return false;
        }

        self.cancellation.abort();
        if let Some(on_abort) = self.on_abort.as_mut() {
            on_abort();
        }
        true
    }

    pub fn dispose(&mut self) {
        self.loader.stop();
    }

    pub fn render(&mut self, width: usize) -> Vec<String> {
        self.loader.render(width)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    fn identity(text: &str) -> String {
        text.to_string()
    }

    #[test]
    fn cancel_key_sets_flag_and_invokes_callback() {
        let calls = Rc::new(Cell::new(0));
        let callback_calls = Rc::clone(&calls);
        let mut loader = CancellableLoader::new(identity, identity, "Working", None);
        loader.set_on_abort(move || callback_calls.set(callback_calls.get() + 1));

        assert!(!loader.aborted());
        assert!(loader.handle_input("\x1b"));
        assert!(loader.aborted());
        assert_eq!(calls.get(), 1);

        assert!(loader.handle_input("\x1b"));
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn non_cancel_key_is_ignored() {
        let mut loader = CancellableLoader::new(identity, identity, "Working", None);

        assert!(!loader.handle_input("\r"));
        assert!(!loader.aborted());
    }

    #[test]
    fn cloned_cancellation_flag_observes_abort() {
        let mut loader = CancellableLoader::new(identity, identity, "Working", None);
        let flag = loader.cancellation_flag();

        assert!(!flag.aborted());
        loader.handle_input("\x1b");

        assert!(flag.aborted());
    }

    #[test]
    fn dispose_stops_loader_animation() {
        let mut loader = CancellableLoader::new(identity, identity, "Working", None);

        assert!(loader.loader().is_animating());
        loader.dispose();

        assert!(!loader.loader().is_animating());
    }
}
