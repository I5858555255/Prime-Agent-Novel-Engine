use std::sync::{Mutex, MutexGuard, OnceLock};

use crate::keys::matches_key;

pub type KeyId = String;
pub type Keybinding = String;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeybindingKeys {
    One(KeyId),
    Many(Vec<KeyId>),
}

impl KeybindingKeys {
    pub fn one(key: impl Into<KeyId>) -> Self {
        Self::One(key.into())
    }

    pub fn many<I, K>(keys: I) -> Self
    where
        I: IntoIterator<Item = K>,
        K: Into<KeyId>,
    {
        Self::Many(keys.into_iter().map(Into::into).collect())
    }

    pub fn as_vec(&self) -> Vec<KeyId> {
        match self {
            Self::One(key) => vec![key.clone()],
            Self::Many(keys) => keys.clone(),
        }
    }

    fn normalized(&self) -> Vec<KeyId> {
        match self {
            Self::One(key) => normalize_key_iter(std::iter::once(key.as_str())),
            Self::Many(keys) => normalize_key_iter(keys.iter().map(String::as_str)),
        }
    }

    fn from_resolved(keys: Vec<KeyId>) -> Self {
        if keys.len() == 1 {
            let mut keys = keys;
            Self::One(keys.remove(0))
        } else {
            Self::Many(keys)
        }
    }
}

impl From<&str> for KeybindingKeys {
    fn from(value: &str) -> Self {
        Self::one(value)
    }
}

impl From<String> for KeybindingKeys {
    fn from(value: String) -> Self {
        Self::one(value)
    }
}

impl<K> From<Vec<K>> for KeybindingKeys
where
    K: Into<KeyId>,
{
    fn from(value: Vec<K>) -> Self {
        Self::many(value)
    }
}

impl<K, const N: usize> From<[K; N]> for KeybindingKeys
where
    K: Into<KeyId>,
{
    fn from(value: [K; N]) -> Self {
        Self::many(value)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeybindingsConfig {
    entries: Vec<(Keybinding, Option<KeybindingKeys>)>,
}

impl KeybindingsConfig {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_pairs<I, K, V>(pairs: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<Keybinding>,
        V: Into<KeybindingKeys>,
    {
        let mut config = Self::new();
        for (keybinding, keys) in pairs {
            config.set(keybinding, keys);
        }
        config
    }

    pub fn from_optional_pairs<I, K>(pairs: I) -> Self
    where
        I: IntoIterator<Item = (K, Option<KeybindingKeys>)>,
        K: Into<Keybinding>,
    {
        let mut config = Self::new();
        for (keybinding, keys) in pairs {
            config.set_optional(keybinding, keys);
        }
        config
    }

    pub fn entries(&self) -> &[(Keybinding, Option<KeybindingKeys>)] {
        &self.entries
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, Option<&KeybindingKeys>)> {
        self.entries
            .iter()
            .map(|(keybinding, keys)| (keybinding.as_str(), keys.as_ref()))
    }

    pub fn get(&self, keybinding: &str) -> Option<Option<&KeybindingKeys>> {
        self.entries
            .iter()
            .find(|(id, _)| id == keybinding)
            .map(|(_, keys)| keys.as_ref())
    }

    pub fn set<K, V>(&mut self, keybinding: K, keys: V)
    where
        K: Into<Keybinding>,
        V: Into<KeybindingKeys>,
    {
        self.set_optional(keybinding, Some(keys.into()));
    }

    pub fn set_undefined<K>(&mut self, keybinding: K)
    where
        K: Into<Keybinding>,
    {
        self.set_optional(keybinding, None);
    }

    pub fn set_optional<K>(&mut self, keybinding: K, keys: Option<KeybindingKeys>)
    where
        K: Into<Keybinding>,
    {
        let keybinding = keybinding.into();
        if let Some((_, existing_keys)) = self.entries.iter_mut().find(|(id, _)| id == &keybinding)
        {
            *existing_keys = keys;
        } else {
            self.entries.push((keybinding, keys));
        }
    }
}

impl<K, V, const N: usize> From<[(K, V); N]> for KeybindingsConfig
where
    K: Into<Keybinding>,
    V: Into<KeybindingKeys>,
{
    fn from(value: [(K, V); N]) -> Self {
        Self::from_pairs(value)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeybindingDefinition {
    pub default_keys: &'static [&'static str],
    pub description: Option<&'static str>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeybindingDefinitions {
    entries: Vec<(Keybinding, KeybindingDefinition)>,
}

impl KeybindingDefinitions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_static(entries: &'static [(&'static str, KeybindingDefinition)]) -> Self {
        Self {
            entries: entries
                .iter()
                .map(|(keybinding, definition)| ((*keybinding).to_string(), *definition))
                .collect(),
        }
    }

    pub fn from_entries<I, K>(entries: I) -> Self
    where
        I: IntoIterator<Item = (K, KeybindingDefinition)>,
        K: Into<Keybinding>,
    {
        Self {
            entries: entries
                .into_iter()
                .map(|(keybinding, definition)| (keybinding.into(), definition))
                .collect(),
        }
    }

    pub fn entries(&self) -> &[(Keybinding, KeybindingDefinition)] {
        &self.entries
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &KeybindingDefinition)> {
        self.entries
            .iter()
            .map(|(keybinding, definition)| (keybinding.as_str(), definition))
    }

    pub fn contains(&self, keybinding: &str) -> bool {
        self.entries.iter().any(|(id, _)| id == keybinding)
    }

    pub fn get(&self, keybinding: &str) -> Option<&KeybindingDefinition> {
        self.entries
            .iter()
            .find(|(id, _)| id == keybinding)
            .map(|(_, definition)| definition)
    }
}

impl From<&'static [(&'static str, KeybindingDefinition)]> for KeybindingDefinitions {
    fn from(value: &'static [(&'static str, KeybindingDefinition)]) -> Self {
        Self::from_static(value)
    }
}

impl<K> From<Vec<(K, KeybindingDefinition)>> for KeybindingDefinitions
where
    K: Into<Keybinding>,
{
    fn from(value: Vec<(K, KeybindingDefinition)>) -> Self {
        Self::from_entries(value)
    }
}

pub const TUI_KEYBINDINGS: &[(&str, KeybindingDefinition)] = &[
    (
        "tui.editor.cursorUp",
        KeybindingDefinition {
            default_keys: &["up"],
            description: Some("Move cursor up"),
        },
    ),
    (
        "tui.editor.cursorDown",
        KeybindingDefinition {
            default_keys: &["down"],
            description: Some("Move cursor down"),
        },
    ),
    (
        "tui.editor.cursorLeft",
        KeybindingDefinition {
            default_keys: &["left", "ctrl+b"],
            description: Some("Move cursor left"),
        },
    ),
    (
        "tui.editor.cursorRight",
        KeybindingDefinition {
            default_keys: &["right", "ctrl+f"],
            description: Some("Move cursor right"),
        },
    ),
    (
        "tui.editor.cursorWordLeft",
        KeybindingDefinition {
            default_keys: &["alt+left", "ctrl+left", "alt+b"],
            description: Some("Move cursor word left"),
        },
    ),
    (
        "tui.editor.cursorWordRight",
        KeybindingDefinition {
            default_keys: &["alt+right", "ctrl+right", "alt+f"],
            description: Some("Move cursor word right"),
        },
    ),
    (
        "tui.editor.cursorLineStart",
        KeybindingDefinition {
            default_keys: &["home", "ctrl+a"],
            description: Some("Move to line start"),
        },
    ),
    (
        "tui.editor.cursorLineEnd",
        KeybindingDefinition {
            default_keys: &["end", "ctrl+e"],
            description: Some("Move to line end"),
        },
    ),
    (
        "tui.editor.jumpForward",
        KeybindingDefinition {
            default_keys: &["ctrl+]"],
            description: Some("Jump forward to character"),
        },
    ),
    (
        "tui.editor.jumpBackward",
        KeybindingDefinition {
            default_keys: &["ctrl+alt+]"],
            description: Some("Jump backward to character"),
        },
    ),
    (
        "tui.editor.pageUp",
        KeybindingDefinition {
            default_keys: &["pageUp"],
            description: Some("Page up"),
        },
    ),
    (
        "tui.editor.pageDown",
        KeybindingDefinition {
            default_keys: &["pageDown"],
            description: Some("Page down"),
        },
    ),
    (
        "tui.editor.deleteCharBackward",
        KeybindingDefinition {
            default_keys: &["backspace"],
            description: Some("Delete character backward"),
        },
    ),
    (
        "tui.editor.deleteCharForward",
        KeybindingDefinition {
            default_keys: &["delete", "ctrl+d"],
            description: Some("Delete character forward"),
        },
    ),
    (
        "tui.editor.deleteWordBackward",
        KeybindingDefinition {
            default_keys: &["ctrl+w", "alt+backspace"],
            description: Some("Delete word backward"),
        },
    ),
    (
        "tui.editor.deleteWordForward",
        KeybindingDefinition {
            default_keys: &["alt+d", "alt+delete"],
            description: Some("Delete word forward"),
        },
    ),
    (
        "tui.editor.deleteToLineStart",
        KeybindingDefinition {
            default_keys: &["ctrl+u"],
            description: Some("Delete to line start"),
        },
    ),
    (
        "tui.editor.deleteToLineEnd",
        KeybindingDefinition {
            default_keys: &["ctrl+k"],
            description: Some("Delete to line end"),
        },
    ),
    (
        "tui.editor.yank",
        KeybindingDefinition {
            default_keys: &["ctrl+y"],
            description: Some("Yank"),
        },
    ),
    (
        "tui.editor.yankPop",
        KeybindingDefinition {
            default_keys: &["alt+y"],
            description: Some("Yank pop"),
        },
    ),
    (
        "tui.editor.undo",
        KeybindingDefinition {
            default_keys: &["ctrl+-"],
            description: Some("Undo"),
        },
    ),
    (
        "tui.input.newLine",
        KeybindingDefinition {
            default_keys: &["shift+enter"],
            description: Some("Insert newline"),
        },
    ),
    (
        "tui.input.submit",
        KeybindingDefinition {
            default_keys: &["enter"],
            description: Some("Submit input"),
        },
    ),
    (
        "tui.input.tab",
        KeybindingDefinition {
            default_keys: &["tab"],
            description: Some("Tab / autocomplete"),
        },
    ),
    (
        "tui.input.copy",
        KeybindingDefinition {
            default_keys: &["ctrl+c"],
            description: Some("Copy selection"),
        },
    ),
    (
        "tui.select.up",
        KeybindingDefinition {
            default_keys: &["up"],
            description: Some("Move selection up"),
        },
    ),
    (
        "tui.select.down",
        KeybindingDefinition {
            default_keys: &["down"],
            description: Some("Move selection down"),
        },
    ),
    (
        "tui.select.pageUp",
        KeybindingDefinition {
            default_keys: &["pageUp"],
            description: Some("Selection page up"),
        },
    ),
    (
        "tui.select.pageDown",
        KeybindingDefinition {
            default_keys: &["pageDown"],
            description: Some("Selection page down"),
        },
    ),
    (
        "tui.select.confirm",
        KeybindingDefinition {
            default_keys: &["enter"],
            description: Some("Confirm selection"),
        },
    ),
    (
        "tui.select.cancel",
        KeybindingDefinition {
            default_keys: &["escape", "ctrl+c"],
            description: Some("Cancel selection"),
        },
    ),
];

pub fn tui_keybinding_definitions() -> KeybindingDefinitions {
    KeybindingDefinitions::from_static(TUI_KEYBINDINGS)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeybindingConflict {
    pub key: KeyId,
    pub keybindings: Vec<Keybinding>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeybindingsManager {
    definitions: KeybindingDefinitions,
    user_bindings: KeybindingsConfig,
    keys_by_id: Vec<(Keybinding, Vec<KeyId>)>,
    conflicts: Vec<KeybindingConflict>,
}

impl KeybindingsManager {
    pub fn new<D, U>(definitions: D, user_bindings: U) -> Self
    where
        D: Into<KeybindingDefinitions>,
        U: Into<KeybindingsConfig>,
    {
        let mut manager = Self {
            definitions: definitions.into(),
            user_bindings: user_bindings.into(),
            keys_by_id: Vec::new(),
            conflicts: Vec::new(),
        };
        manager.rebuild();
        manager
    }

    pub fn with_tui_defaults<U>(user_bindings: U) -> Self
    where
        U: Into<KeybindingsConfig>,
    {
        Self::new(tui_keybinding_definitions(), user_bindings)
    }

    fn rebuild(&mut self) {
        self.keys_by_id.clear();
        self.conflicts.clear();

        let mut user_claims: Vec<KeybindingConflict> = Vec::new();
        for (keybinding, keys) in self.user_bindings.iter() {
            if !self.definitions.contains(keybinding) {
                continue;
            }

            for key in normalize_optional_keys(keys) {
                add_user_claim(&mut user_claims, key, keybinding);
            }
        }

        self.conflicts = user_claims
            .into_iter()
            .filter(|claim| claim.keybindings.len() > 1)
            .collect();

        for (id, definition) in self.definitions.iter() {
            let keys = match self.user_bindings.get(id) {
                Some(Some(user_keys)) => user_keys.normalized(),
                _ => normalize_key_iter(definition.default_keys.iter().copied()),
            };
            self.keys_by_id.push((id.to_string(), keys));
        }
    }

    pub fn matches(&self, data: &str, keybinding: &str) -> bool {
        self.keys_by_id
            .iter()
            .find(|(id, _)| id == keybinding)
            .map(|(_, keys)| keys.iter().any(|key| matches_key(data, key)))
            .unwrap_or(false)
    }

    pub fn get_keys(&self, keybinding: &str) -> Vec<KeyId> {
        self.keys_by_id
            .iter()
            .find(|(id, _)| id == keybinding)
            .map(|(_, keys)| keys.clone())
            .unwrap_or_default()
    }

    pub fn get_definition(&self, keybinding: &str) -> Option<&KeybindingDefinition> {
        self.definitions.get(keybinding)
    }

    pub fn get_conflicts(&self) -> Vec<KeybindingConflict> {
        self.conflicts.clone()
    }

    pub fn set_user_bindings<U>(&mut self, user_bindings: U)
    where
        U: Into<KeybindingsConfig>,
    {
        self.user_bindings = user_bindings.into();
        self.rebuild();
    }

    pub fn get_user_bindings(&self) -> KeybindingsConfig {
        self.user_bindings.clone()
    }

    pub fn get_resolved_bindings(&self) -> KeybindingsConfig {
        let mut resolved = KeybindingsConfig::new();
        for (id, _) in self.definitions.iter() {
            resolved.set_optional(id, Some(KeybindingKeys::from_resolved(self.get_keys(id))));
        }
        resolved
    }
}

impl Default for KeybindingsManager {
    fn default() -> Self {
        Self::with_tui_defaults(KeybindingsConfig::new())
    }
}

static GLOBAL_KEYBINDINGS: OnceLock<Mutex<KeybindingsManager>> = OnceLock::new();

fn global_keybindings_cell() -> &'static Mutex<KeybindingsManager> {
    GLOBAL_KEYBINDINGS.get_or_init(|| Mutex::new(KeybindingsManager::default()))
}

pub fn set_keybindings(keybindings: KeybindingsManager) {
    *global_keybindings_cell()
        .lock()
        .expect("global keybindings mutex poisoned") = keybindings;
}

pub fn get_keybindings() -> MutexGuard<'static, KeybindingsManager> {
    global_keybindings_cell()
        .lock()
        .expect("global keybindings mutex poisoned")
}

fn normalize_optional_keys(keys: Option<&KeybindingKeys>) -> Vec<KeyId> {
    keys.map(KeybindingKeys::normalized).unwrap_or_default()
}

fn normalize_key_iter<'a, I>(keys: I) -> Vec<KeyId>
where
    I: IntoIterator<Item = &'a str>,
{
    let mut result = Vec::new();
    for key in keys {
        if !result.iter().any(|seen| seen == key) {
            result.push(key.to_string());
        }
    }
    result
}

fn add_user_claim(claims: &mut Vec<KeybindingConflict>, key: KeyId, keybinding: &str) {
    if let Some(claim) = claims.iter_mut().find(|claim| claim.key == key) {
        if !claim
            .keybindings
            .iter()
            .any(|existing| existing == keybinding)
        {
            claim.keybindings.push(keybinding.to_string());
        }
    } else {
        claims.push(KeybindingConflict {
            key,
            keybindings: vec![keybinding.to_string()],
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys<const N: usize>(items: [&str; N]) -> Vec<KeyId> {
        items.into_iter().map(String::from).collect()
    }

    #[test]
    fn does_not_evict_selector_confirm_when_input_submit_is_rebound() {
        let keybindings =
            KeybindingsManager::with_tui_defaults([("tui.input.submit", ["enter", "ctrl+enter"])]);

        assert_eq!(
            keybindings.get_keys("tui.input.submit"),
            keys(["enter", "ctrl+enter"])
        );
        assert_eq!(keybindings.get_keys("tui.select.confirm"), keys(["enter"]));
    }

    #[test]
    fn does_not_evict_cursor_bindings_when_another_action_reuses_the_same_key() {
        let keybindings =
            KeybindingsManager::with_tui_defaults([("tui.select.up", ["up", "ctrl+p"])]);

        assert_eq!(
            keybindings.get_keys("tui.select.up"),
            keys(["up", "ctrl+p"])
        );
        assert_eq!(keybindings.get_keys("tui.editor.cursorUp"), keys(["up"]));
    }

    #[test]
    fn still_reports_direct_user_binding_conflicts_without_evicting_defaults() {
        let keybindings = KeybindingsManager::with_tui_defaults([
            ("tui.input.submit", "ctrl+x"),
            ("tui.select.confirm", "ctrl+x"),
        ]);

        assert_eq!(
            keybindings.get_conflicts(),
            vec![KeybindingConflict {
                key: "ctrl+x".to_string(),
                keybindings: keys(["tui.input.submit", "tui.select.confirm"]),
            }]
        );
        assert_eq!(
            keybindings.get_keys("tui.editor.cursorLeft"),
            keys(["left", "ctrl+b"])
        );
    }

    #[test]
    fn dedupes_keys_without_reordering_first_occurrences() {
        let keybindings = KeybindingsManager::with_tui_defaults([(
            "tui.input.submit",
            ["enter", "ctrl+enter", "enter", "ctrl+enter"],
        )]);

        assert_eq!(
            keybindings.get_keys("tui.input.submit"),
            keys(["enter", "ctrl+enter"])
        );
    }

    #[test]
    fn matches_default_and_user_rebound_keys() {
        let keybindings =
            KeybindingsManager::with_tui_defaults([("tui.input.submit", ["ctrl+enter"])]);

        assert!(keybindings.matches("\u{1b}[13;5u", "tui.input.submit"));
        assert!(!keybindings.matches("\r", "tui.input.submit"));
        assert!(keybindings.matches("\r", "tui.select.confirm"));
        assert!(!keybindings.matches("\r", "missing.binding"));
    }

    #[test]
    fn resolved_bindings_preserve_definition_order_and_scalar_shape_for_single_keys() {
        let keybindings =
            KeybindingsManager::with_tui_defaults([("tui.input.submit", ["enter", "ctrl+enter"])]);
        let resolved = keybindings.get_resolved_bindings();

        let first_ids = resolved
            .entries()
            .iter()
            .take(3)
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            first_ids,
            vec![
                "tui.editor.cursorUp",
                "tui.editor.cursorDown",
                "tui.editor.cursorLeft"
            ]
        );
        assert_eq!(
            resolved.get("tui.input.submit"),
            Some(Some(&KeybindingKeys::many(["enter", "ctrl+enter"])))
        );
        assert_eq!(
            resolved.get("tui.select.confirm"),
            Some(Some(&KeybindingKeys::one("enter")))
        );
    }

    #[test]
    fn global_keybindings_can_be_replaced() {
        let manager = KeybindingsManager::with_tui_defaults([("tui.input.submit", ["ctrl+enter"])]);

        set_keybindings(manager);

        let global = get_keybindings();
        assert_eq!(global.get_keys("tui.input.submit"), keys(["ctrl+enter"]));
    }
}
