use std::collections::{HashMap, HashSet};
use std::env;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use prime_agent_ai::{ModelThinkingLevel, Transport};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::config::{CONFIG_DIR_NAME, get_agent_dir};

pub type TransportSetting = Transport;
pub type DefaultThinkingLevel = ModelThinkingLevel;

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reserve_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_recent_tokens: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSummarySettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reserve_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_prompt: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRetrySettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_retries: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_retry_delay_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrySettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_retries: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_delay_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<ProviderRetrySettings>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_images: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_width_cells: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clear_on_shrink: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_terminal_progress: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_resize: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_images: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingBudgetsSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimal: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub low: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub medium: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub high: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_block_indent: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarningSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anthropic_extra_usage: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTracesSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PackageSource {
    Source(String),
    Filtered(PackageSourceFilters),
}

impl PackageSource {
    pub fn source(&self) -> &str {
        match self {
            Self::Source(source) => source,
            Self::Filtered(filters) => &filters.source,
        }
    }
}

impl From<String> for PackageSource {
    fn from(value: String) -> Self {
        Self::Source(value)
    }
}

impl From<&str> for PackageSource {
    fn from(value: &str) -> Self {
        Self::Source(value.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSourceFilters {
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompts: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub themes: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OneAtATimeMode {
    All,
    #[default]
    OneAtATime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TreeFilterMode {
    #[default]
    Default,
    NoTools,
    UserOnly,
    LabeledOnly,
    All,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub onboarding_completed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_thinking_level: Option<DefaultThinkingLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<TransportSetting>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steering_mode: Option<OneAtATimeMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow_up_mode: Option<OneAtATimeMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction: Option<CompactionSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_traces: Option<AgentTracesSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_summary: Option<BranchSummarySettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<RetrySettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hide_thinking_block: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quiet_startup: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_command_prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub npm_command: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub packages: Option<Vec<PackageSource>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompts: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub themes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enable_skill_commands: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enable_builtin_skills: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<TerminalSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<ImageSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled_models: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tree_filter_mode: Option<TreeFilterMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_budgets: Option<ThinkingBudgetsSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editor_padding_x: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autocomplete_max_visible: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_hardware_cursor: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markdown: Option<MarkdownSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warnings: Option<WarningSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_dir: Option<String>,
}

pub fn deep_merge_settings(base: &Settings, overrides: &Settings) -> Settings {
    let mut base_value = settings_to_value(base);
    let overrides_value = settings_to_value(overrides);

    shallow_merge_settings_value(&mut base_value, overrides_value);
    settings_from_value(base_value).unwrap_or_default()
}

fn shallow_merge_settings_value(base: &mut Value, overrides: Value) {
    let (Value::Object(base_map), Value::Object(overrides_map)) = (base, overrides) else {
        return;
    };

    for (key, override_value) in overrides_map {
        match (base_map.get_mut(&key), override_value) {
            (Some(Value::Object(base_nested)), Value::Object(override_nested)) => {
                for (nested_key, nested_value) in override_nested {
                    base_nested.insert(nested_key, nested_value);
                }
            }
            (_, override_value) => {
                base_map.insert(key, override_value);
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SettingsScope {
    Global,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SettingsField {
    OnboardingCompleted,
    DefaultProvider,
    DefaultModel,
    DefaultThinkingLevel,
    Transport,
    SteeringMode,
    FollowUpMode,
    Theme,
    Compaction,
    AgentTraces,
    BranchSummary,
    Retry,
    HideThinkingBlock,
    ShellPath,
    QuietStartup,
    ShellCommandPrefix,
    NpmCommand,
    Packages,
    Extensions,
    Skills,
    Prompts,
    Themes,
    EnableSkillCommands,
    EnableBuiltinSkills,
    Terminal,
    Images,
    EnabledModels,
    TreeFilterMode,
    ThinkingBudgets,
    EditorPaddingX,
    AutocompleteMaxVisible,
    ShowHardwareCursor,
    Markdown,
    Warnings,
    SessionDir,
}

impl SettingsField {
    pub const fn json_key(self) -> &'static str {
        match self {
            Self::OnboardingCompleted => "onboardingCompleted",
            Self::DefaultProvider => "defaultProvider",
            Self::DefaultModel => "defaultModel",
            Self::DefaultThinkingLevel => "defaultThinkingLevel",
            Self::Transport => "transport",
            Self::SteeringMode => "steeringMode",
            Self::FollowUpMode => "followUpMode",
            Self::Theme => "theme",
            Self::Compaction => "compaction",
            Self::AgentTraces => "agentTraces",
            Self::BranchSummary => "branchSummary",
            Self::Retry => "retry",
            Self::HideThinkingBlock => "hideThinkingBlock",
            Self::ShellPath => "shellPath",
            Self::QuietStartup => "quietStartup",
            Self::ShellCommandPrefix => "shellCommandPrefix",
            Self::NpmCommand => "npmCommand",
            Self::Packages => "packages",
            Self::Extensions => "extensions",
            Self::Skills => "skills",
            Self::Prompts => "prompts",
            Self::Themes => "themes",
            Self::EnableSkillCommands => "enableSkillCommands",
            Self::EnableBuiltinSkills => "enableBuiltinSkills",
            Self::Terminal => "terminal",
            Self::Images => "images",
            Self::EnabledModels => "enabledModels",
            Self::TreeFilterMode => "treeFilterMode",
            Self::ThinkingBudgets => "thinkingBudgets",
            Self::EditorPaddingX => "editorPaddingX",
            Self::AutocompleteMaxVisible => "autocompleteMaxVisible",
            Self::ShowHardwareCursor => "showHardwareCursor",
            Self::Markdown => "markdown",
            Self::Warnings => "warnings",
            Self::SessionDir => "sessionDir",
        }
    }
}

#[derive(Debug)]
pub enum SettingsStorageError {
    Io(io::Error),
    Poisoned,
}

impl fmt::Display for SettingsStorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Poisoned => formatter.write_str("settings storage lock poisoned"),
        }
    }
}

impl std::error::Error for SettingsStorageError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Poisoned => None,
        }
    }
}

impl From<io::Error> for SettingsStorageError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

pub trait SettingsStorage: Send + Sync {
    fn read(&self, scope: SettingsScope) -> Result<Option<String>, SettingsStorageError>;
    fn write(&self, scope: SettingsScope, content: &str) -> Result<(), SettingsStorageError>;
}

/// File-backed settings storage.
///
/// The TypeScript implementation uses proper-lockfile. This Rust rewrite keeps
/// the deterministic read/merge/write behavior but intentionally does not
/// implement process-wide file locking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileSettingsStorage {
    global_settings_path: PathBuf,
    project_settings_path: PathBuf,
}

impl FileSettingsStorage {
    pub fn new(cwd: impl AsRef<Path>, agent_dir: impl AsRef<Path>) -> Self {
        Self {
            global_settings_path: agent_dir.as_ref().join("settings.json"),
            project_settings_path: cwd.as_ref().join(CONFIG_DIR_NAME).join("settings.json"),
        }
    }

    pub fn global_settings_path(&self) -> &Path {
        &self.global_settings_path
    }

    pub fn project_settings_path(&self) -> &Path {
        &self.project_settings_path
    }

    fn path_for_scope(&self, scope: SettingsScope) -> &Path {
        match scope {
            SettingsScope::Global => &self.global_settings_path,
            SettingsScope::Project => &self.project_settings_path,
        }
    }
}

impl SettingsStorage for FileSettingsStorage {
    fn read(&self, scope: SettingsScope) -> Result<Option<String>, SettingsStorageError> {
        match fs::read_to_string(self.path_for_scope(scope)) {
            Ok(content) => Ok(Some(content)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn write(&self, scope: SettingsScope, content: &str) -> Result<(), SettingsStorageError> {
        let path = self.path_for_scope(scope);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, content)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Default)]
pub struct InMemorySettingsStorage {
    inner: Arc<Mutex<InMemorySettingsStorageInner>>,
}

#[derive(Debug, Default)]
struct InMemorySettingsStorageInner {
    global: Option<String>,
    project: Option<String>,
}

impl InMemorySettingsStorage {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_global(settings: &Settings) -> Result<Self, SettingsManagerError> {
        let storage = Self::new();
        let content = settings_to_pretty_string(settings)?;
        storage.write(SettingsScope::Global, &content)?;
        Ok(storage)
    }

    pub fn read_scope(&self, scope: SettingsScope) -> Option<String> {
        self.read(scope).ok().flatten()
    }
}

impl SettingsStorage for InMemorySettingsStorage {
    fn read(&self, scope: SettingsScope) -> Result<Option<String>, SettingsStorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|_| SettingsStorageError::Poisoned)?;
        Ok(match scope {
            SettingsScope::Global => storage.global.clone(),
            SettingsScope::Project => storage.project.clone(),
        })
    }

    fn write(&self, scope: SettingsScope, content: &str) -> Result<(), SettingsStorageError> {
        let mut storage = self
            .inner
            .lock()
            .map_err(|_| SettingsStorageError::Poisoned)?;
        match scope {
            SettingsScope::Global => storage.global = Some(content.to_string()),
            SettingsScope::Project => storage.project = Some(content.to_string()),
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum SettingsManagerError {
    Storage(SettingsStorageError),
    Parse(serde_json::Error),
    Serialize(serde_json::Error),
}

impl fmt::Display for SettingsManagerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Storage(error) => write!(formatter, "{error}"),
            Self::Parse(error) => write!(formatter, "{error}"),
            Self::Serialize(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for SettingsManagerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Storage(error) => Some(error),
            Self::Parse(error) => Some(error),
            Self::Serialize(error) => Some(error),
        }
    }
}

impl From<SettingsStorageError> for SettingsManagerError {
    fn from(value: SettingsStorageError) -> Self {
        Self::Storage(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsError {
    pub scope: SettingsScope,
    pub message: String,
}

#[derive(Default)]
pub struct SettingsManager {
    storage: Option<Box<dyn SettingsStorage>>,
    global_settings: Settings,
    project_settings: Settings,
    settings: Settings,
    modified_fields: HashSet<SettingsField>,
    modified_nested_fields: HashMap<SettingsField, HashSet<String>>,
    modified_project_fields: HashSet<SettingsField>,
    modified_project_nested_fields: HashMap<SettingsField, HashSet<String>>,
    global_settings_load_error: Option<String>,
    project_settings_load_error: Option<String>,
    errors: Vec<SettingsError>,
}

impl fmt::Debug for SettingsManager {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SettingsManager")
            .field("global_settings", &self.global_settings)
            .field("project_settings", &self.project_settings)
            .field("settings", &self.settings)
            .field("modified_fields", &self.modified_fields)
            .field("modified_nested_fields", &self.modified_nested_fields)
            .field("modified_project_fields", &self.modified_project_fields)
            .field(
                "modified_project_nested_fields",
                &self.modified_project_nested_fields,
            )
            .field(
                "global_settings_load_error",
                &self.global_settings_load_error,
            )
            .field(
                "project_settings_load_error",
                &self.project_settings_load_error,
            )
            .field("errors", &self.errors)
            .finish()
    }
}

impl SettingsManager {
    pub fn create(cwd: impl AsRef<Path>) -> Self {
        Self::create_with_agent_dir(cwd, get_agent_dir())
    }

    pub fn create_with_agent_dir(cwd: impl AsRef<Path>, agent_dir: impl AsRef<Path>) -> Self {
        Self::from_storage(FileSettingsStorage::new(cwd, agent_dir))
    }

    pub fn from_storage<S>(storage: S) -> Self
    where
        S: SettingsStorage + 'static,
    {
        let global_load = try_load_from_storage(&storage, SettingsScope::Global);
        let project_load = try_load_from_storage(&storage, SettingsScope::Project);

        let mut errors = Vec::new();
        if let Err(error) = &global_load {
            errors.push(SettingsError {
                scope: SettingsScope::Global,
                message: error.to_string(),
            });
        }
        if let Err(error) = &project_load {
            errors.push(SettingsError {
                scope: SettingsScope::Project,
                message: error.to_string(),
            });
        }

        let global_settings = global_load.unwrap_or_default();
        let project_settings = project_load.unwrap_or_default();
        let settings = deep_merge_settings(&global_settings, &project_settings);

        Self {
            storage: Some(Box::new(storage)),
            global_settings,
            project_settings,
            settings,
            modified_fields: HashSet::new(),
            modified_nested_fields: HashMap::new(),
            modified_project_fields: HashSet::new(),
            modified_project_nested_fields: HashMap::new(),
            global_settings_load_error: errors
                .iter()
                .find(|error| error.scope == SettingsScope::Global)
                .map(|error| error.message.clone()),
            project_settings_load_error: errors
                .iter()
                .find(|error| error.scope == SettingsScope::Project)
                .map(|error| error.message.clone()),
            errors,
        }
    }

    pub fn in_memory(settings: Settings) -> Self {
        match InMemorySettingsStorage::with_global(&migrate_settings(settings)) {
            Ok(storage) => Self::from_storage(storage),
            Err(error) => {
                let mut manager = Self::default();
                manager.record_error(SettingsScope::Global, error);
                manager
            }
        }
    }

    pub fn get_settings(&self) -> Settings {
        self.settings.clone()
    }

    pub fn get_global_settings(&self) -> Settings {
        self.global_settings.clone()
    }

    pub fn get_project_settings(&self) -> Settings {
        self.project_settings.clone()
    }

    pub fn global_settings_load_error(&self) -> Option<&str> {
        self.global_settings_load_error.as_deref()
    }

    pub fn project_settings_load_error(&self) -> Option<&str> {
        self.project_settings_load_error.as_deref()
    }

    pub fn reload(&mut self) {
        let (global_load, project_load) = {
            let Some(storage) = self.storage.as_ref() else {
                return;
            };
            (
                try_load_from_storage(storage.as_ref(), SettingsScope::Global),
                try_load_from_storage(storage.as_ref(), SettingsScope::Project),
            )
        };

        match global_load {
            Ok(settings) => {
                self.global_settings = settings;
                self.global_settings_load_error = None;
            }
            Err(error) => {
                self.global_settings_load_error = Some(error.to_string());
                self.record_error(SettingsScope::Global, error);
            }
        }

        self.modified_fields.clear();
        self.modified_nested_fields.clear();
        self.modified_project_fields.clear();
        self.modified_project_nested_fields.clear();

        match project_load {
            Ok(settings) => {
                self.project_settings = settings;
                self.project_settings_load_error = None;
            }
            Err(error) => {
                self.project_settings_load_error = Some(error.to_string());
                self.record_error(SettingsScope::Project, error);
            }
        }

        self.settings = deep_merge_settings(&self.global_settings, &self.project_settings);
    }

    pub fn apply_overrides(&mut self, overrides: &Settings) {
        self.settings = deep_merge_settings(&self.settings, overrides);
    }

    pub fn update_global<F>(&mut self, field: SettingsField, update: F)
    where
        F: FnOnce(&mut Settings),
    {
        update(&mut self.global_settings);
        self.mark_modified(field, None);
        self.save();
    }

    pub fn update_global_nested<F>(
        &mut self,
        field: SettingsField,
        nested_key: impl Into<String>,
        update: F,
    ) where
        F: FnOnce(&mut Settings),
    {
        update(&mut self.global_settings);
        self.mark_modified(field, Some(nested_key.into()));
        self.save();
    }

    pub fn update_project<F>(&mut self, field: SettingsField, update: F)
    where
        F: FnOnce(&mut Settings),
    {
        update(&mut self.project_settings);
        self.mark_project_modified(field, None);
        self.save_project();
    }

    pub fn update_project_nested<F>(
        &mut self,
        field: SettingsField,
        nested_key: impl Into<String>,
        update: F,
    ) where
        F: FnOnce(&mut Settings),
    {
        update(&mut self.project_settings);
        self.mark_project_modified(field, Some(nested_key.into()));
        self.save_project();
    }

    pub fn flush(&mut self) {}

    pub fn drain_errors(&mut self) -> Vec<SettingsError> {
        std::mem::take(&mut self.errors)
    }

    pub fn get_onboarding_completed(&self) -> bool {
        self.settings.onboarding_completed.unwrap_or(false)
    }

    pub fn set_onboarding_completed(&mut self, completed: bool) {
        self.global_settings.onboarding_completed = Some(completed);
        self.mark_modified(SettingsField::OnboardingCompleted, None);
        self.save();
    }

    pub fn get_session_dir(&self) -> Option<String> {
        let session_dir = self.settings.session_dir.as_ref()?;
        if session_dir == "~" {
            return home_dir().map(|path| path.to_string_lossy().into_owned());
        }
        if let Some(rest) = session_dir.strip_prefix("~/") {
            return home_dir().map(|path| path.join(rest).to_string_lossy().into_owned());
        }
        Some(session_dir.clone())
    }

    pub fn get_default_provider(&self) -> Option<String> {
        self.settings.default_provider.clone()
    }

    pub fn get_default_model(&self) -> Option<String> {
        self.settings.default_model.clone()
    }

    pub fn set_default_provider(&mut self, provider: impl Into<String>) {
        self.global_settings.default_provider = Some(provider.into());
        self.mark_modified(SettingsField::DefaultProvider, None);
        self.save();
    }

    pub fn set_default_model(&mut self, model_id: impl Into<String>) {
        self.global_settings.default_model = Some(model_id.into());
        self.mark_modified(SettingsField::DefaultModel, None);
        self.save();
    }

    pub fn set_default_model_and_provider(
        &mut self,
        provider: impl Into<String>,
        model_id: impl Into<String>,
    ) {
        self.global_settings.default_provider = Some(provider.into());
        self.global_settings.default_model = Some(model_id.into());
        self.mark_modified(SettingsField::DefaultProvider, None);
        self.mark_modified(SettingsField::DefaultModel, None);
        self.save();
    }

    pub fn get_steering_mode(&self) -> OneAtATimeMode {
        self.settings.steering_mode.unwrap_or_default()
    }

    pub fn get_queue_mode(&self) -> OneAtATimeMode {
        self.get_steering_mode()
    }

    pub fn set_steering_mode(&mut self, mode: OneAtATimeMode) {
        self.global_settings.steering_mode = Some(mode);
        self.mark_modified(SettingsField::SteeringMode, None);
        self.save();
    }

    pub fn get_follow_up_mode(&self) -> OneAtATimeMode {
        self.settings.follow_up_mode.unwrap_or_default()
    }

    pub fn set_follow_up_mode(&mut self, mode: OneAtATimeMode) {
        self.global_settings.follow_up_mode = Some(mode);
        self.mark_modified(SettingsField::FollowUpMode, None);
        self.save();
    }

    pub fn get_theme(&self) -> Option<String> {
        self.settings.theme.clone()
    }

    pub fn set_theme(&mut self, theme: impl Into<String>) {
        self.global_settings.theme = Some(theme.into());
        self.mark_modified(SettingsField::Theme, None);
        self.save();
    }

    pub fn get_default_thinking_level(&self) -> Option<DefaultThinkingLevel> {
        self.settings.default_thinking_level
    }

    pub fn set_default_thinking_level(&mut self, level: DefaultThinkingLevel) {
        self.global_settings.default_thinking_level = Some(level);
        self.mark_modified(SettingsField::DefaultThinkingLevel, None);
        self.save();
    }

    pub fn get_transport(&self) -> TransportSetting {
        self.settings.transport.unwrap_or(TransportSetting::Auto)
    }

    pub fn set_transport(&mut self, transport: TransportSetting) {
        self.global_settings.transport = Some(transport);
        self.mark_modified(SettingsField::Transport, None);
        self.save();
    }

    pub fn get_compaction_enabled(&self) -> bool {
        self.settings
            .compaction
            .as_ref()
            .and_then(|settings| settings.enabled)
            .unwrap_or(true)
    }

    pub fn set_compaction_enabled(&mut self, enabled: bool) {
        self.global_settings
            .compaction
            .get_or_insert_with(CompactionSettings::default)
            .enabled = Some(enabled);
        self.mark_modified(SettingsField::Compaction, Some("enabled".to_string()));
        self.save();
    }

    pub fn get_agent_traces_enabled(&self) -> bool {
        self.settings
            .agent_traces
            .as_ref()
            .and_then(|settings| settings.enabled)
            .unwrap_or(false)
    }

    pub fn set_agent_traces_enabled(&mut self, enabled: bool) {
        self.global_settings
            .agent_traces
            .get_or_insert_with(AgentTracesSettings::default)
            .enabled = Some(enabled);
        self.mark_modified(SettingsField::AgentTraces, Some("enabled".to_string()));
        self.save();
    }

    pub fn get_compaction_reserve_tokens(&self) -> i64 {
        self.settings
            .compaction
            .as_ref()
            .and_then(|settings| settings.reserve_tokens)
            .unwrap_or(16_384)
    }

    pub fn get_compaction_keep_recent_tokens(&self) -> i64 {
        self.settings
            .compaction
            .as_ref()
            .and_then(|settings| settings.keep_recent_tokens)
            .unwrap_or(20_000)
    }

    pub fn get_compaction_settings(&self) -> CompactionSettingsWithDefaults {
        CompactionSettingsWithDefaults {
            enabled: self.get_compaction_enabled(),
            reserve_tokens: self.get_compaction_reserve_tokens(),
            keep_recent_tokens: self.get_compaction_keep_recent_tokens(),
        }
    }

    pub fn get_branch_summary_settings(&self) -> BranchSummarySettingsWithDefaults {
        BranchSummarySettingsWithDefaults {
            reserve_tokens: self
                .settings
                .branch_summary
                .as_ref()
                .and_then(|settings| settings.reserve_tokens)
                .unwrap_or(16_384),
            skip_prompt: self
                .settings
                .branch_summary
                .as_ref()
                .and_then(|settings| settings.skip_prompt)
                .unwrap_or(false),
        }
    }

    pub fn get_branch_summary_skip_prompt(&self) -> bool {
        self.settings
            .branch_summary
            .as_ref()
            .and_then(|settings| settings.skip_prompt)
            .unwrap_or(false)
    }

    pub fn get_retry_enabled(&self) -> bool {
        self.settings
            .retry
            .as_ref()
            .and_then(|settings| settings.enabled)
            .unwrap_or(true)
    }

    pub fn set_retry_enabled(&mut self, enabled: bool) {
        self.global_settings
            .retry
            .get_or_insert_with(RetrySettings::default)
            .enabled = Some(enabled);
        self.mark_modified(SettingsField::Retry, Some("enabled".to_string()));
        self.save();
    }

    pub fn get_retry_settings(&self) -> RetrySettingsWithDefaults {
        RetrySettingsWithDefaults {
            enabled: self.get_retry_enabled(),
            max_retries: self
                .settings
                .retry
                .as_ref()
                .and_then(|settings| settings.max_retries)
                .unwrap_or(3),
            base_delay_ms: self
                .settings
                .retry
                .as_ref()
                .and_then(|settings| settings.base_delay_ms)
                .unwrap_or(2_000),
        }
    }

    pub fn get_provider_retry_settings(&self) -> ProviderRetrySettingsWithDefaults {
        ProviderRetrySettingsWithDefaults {
            timeout_ms: self
                .settings
                .retry
                .as_ref()
                .and_then(|settings| settings.provider.as_ref())
                .and_then(|settings| settings.timeout_ms),
            max_retries: self
                .settings
                .retry
                .as_ref()
                .and_then(|settings| settings.provider.as_ref())
                .and_then(|settings| settings.max_retries),
            max_retry_delay_ms: self
                .settings
                .retry
                .as_ref()
                .and_then(|settings| settings.provider.as_ref())
                .and_then(|settings| settings.max_retry_delay_ms)
                .unwrap_or(60_000),
        }
    }

    pub fn get_hide_thinking_block(&self) -> bool {
        self.settings.hide_thinking_block.unwrap_or(false)
    }

    pub fn set_hide_thinking_block(&mut self, hide: bool) {
        self.global_settings.hide_thinking_block = Some(hide);
        self.mark_modified(SettingsField::HideThinkingBlock, None);
        self.save();
    }

    pub fn get_shell_path(&self) -> Option<String> {
        self.settings.shell_path.clone()
    }

    pub fn set_shell_path(&mut self, path: Option<String>) {
        self.global_settings.shell_path = path;
        self.mark_modified(SettingsField::ShellPath, None);
        self.save();
    }

    pub fn get_quiet_startup(&self) -> bool {
        self.settings.quiet_startup.unwrap_or(false)
    }

    pub fn set_quiet_startup(&mut self, quiet: bool) {
        self.global_settings.quiet_startup = Some(quiet);
        self.mark_modified(SettingsField::QuietStartup, None);
        self.save();
    }

    pub fn get_shell_command_prefix(&self) -> Option<String> {
        self.settings.shell_command_prefix.clone()
    }

    pub fn set_shell_command_prefix(&mut self, prefix: Option<String>) {
        self.global_settings.shell_command_prefix = prefix;
        self.mark_modified(SettingsField::ShellCommandPrefix, None);
        self.save();
    }

    pub fn get_npm_command(&self) -> Option<Vec<String>> {
        self.settings.npm_command.clone()
    }

    pub fn set_npm_command(&mut self, command: Option<Vec<String>>) {
        self.global_settings.npm_command = command;
        self.mark_modified(SettingsField::NpmCommand, None);
        self.save();
    }

    pub fn get_packages(&self) -> Vec<PackageSource> {
        self.settings.packages.clone().unwrap_or_default()
    }

    pub fn set_packages(&mut self, packages: Vec<PackageSource>) {
        self.global_settings.packages = Some(packages);
        self.mark_modified(SettingsField::Packages, None);
        self.save();
    }

    pub fn set_project_packages(&mut self, packages: Vec<PackageSource>) {
        self.project_settings.packages = Some(packages);
        self.mark_project_modified(SettingsField::Packages, None);
        self.save_project();
    }

    pub fn get_extension_paths(&self) -> Vec<String> {
        self.settings.extensions.clone().unwrap_or_default()
    }

    pub fn set_extension_paths(&mut self, paths: Vec<String>) {
        self.global_settings.extensions = Some(paths);
        self.mark_modified(SettingsField::Extensions, None);
        self.save();
    }

    pub fn set_project_extension_paths(&mut self, paths: Vec<String>) {
        self.project_settings.extensions = Some(paths);
        self.mark_project_modified(SettingsField::Extensions, None);
        self.save_project();
    }

    pub fn get_skill_paths(&self) -> Vec<String> {
        self.settings.skills.clone().unwrap_or_default()
    }

    pub fn set_skill_paths(&mut self, paths: Vec<String>) {
        self.global_settings.skills = Some(paths);
        self.mark_modified(SettingsField::Skills, None);
        self.save();
    }

    pub fn set_project_skill_paths(&mut self, paths: Vec<String>) {
        self.project_settings.skills = Some(paths);
        self.mark_project_modified(SettingsField::Skills, None);
        self.save_project();
    }

    pub fn get_prompt_template_paths(&self) -> Vec<String> {
        self.settings.prompts.clone().unwrap_or_default()
    }

    pub fn set_prompt_template_paths(&mut self, paths: Vec<String>) {
        self.global_settings.prompts = Some(paths);
        self.mark_modified(SettingsField::Prompts, None);
        self.save();
    }

    pub fn set_project_prompt_template_paths(&mut self, paths: Vec<String>) {
        self.project_settings.prompts = Some(paths);
        self.mark_project_modified(SettingsField::Prompts, None);
        self.save_project();
    }

    pub fn get_theme_paths(&self) -> Vec<String> {
        self.settings.themes.clone().unwrap_or_default()
    }

    pub fn set_theme_paths(&mut self, paths: Vec<String>) {
        self.global_settings.themes = Some(paths);
        self.mark_modified(SettingsField::Themes, None);
        self.save();
    }

    pub fn set_project_theme_paths(&mut self, paths: Vec<String>) {
        self.project_settings.themes = Some(paths);
        self.mark_project_modified(SettingsField::Themes, None);
        self.save_project();
    }

    pub fn get_enable_skill_commands(&self) -> bool {
        self.settings.enable_skill_commands.unwrap_or(true)
    }

    pub fn set_enable_skill_commands(&mut self, enabled: bool) {
        self.global_settings.enable_skill_commands = Some(enabled);
        self.mark_modified(SettingsField::EnableSkillCommands, None);
        self.save();
    }

    pub fn get_enable_builtin_skills(&self) -> bool {
        self.settings.enable_builtin_skills.unwrap_or(true)
    }

    pub fn set_enable_builtin_skills(&mut self, enabled: bool) {
        self.global_settings.enable_builtin_skills = Some(enabled);
        self.mark_modified(SettingsField::EnableBuiltinSkills, None);
        self.save();
    }

    pub fn get_thinking_budgets(&self) -> Option<ThinkingBudgetsSettings> {
        self.settings.thinking_budgets.clone()
    }

    pub fn get_show_images(&self) -> bool {
        self.settings
            .terminal
            .as_ref()
            .and_then(|settings| settings.show_images)
            .unwrap_or(true)
    }

    pub fn set_show_images(&mut self, show: bool) {
        self.global_settings
            .terminal
            .get_or_insert_with(TerminalSettings::default)
            .show_images = Some(show);
        self.mark_modified(SettingsField::Terminal, Some("showImages".to_string()));
        self.save();
    }

    pub fn get_image_width_cells(&self) -> i64 {
        self.settings
            .terminal
            .as_ref()
            .and_then(|settings| settings.image_width_cells)
            .unwrap_or(60)
            .max(1)
    }

    pub fn set_image_width_cells(&mut self, width: i64) {
        self.global_settings
            .terminal
            .get_or_insert_with(TerminalSettings::default)
            .image_width_cells = Some(width.max(1));
        self.mark_modified(SettingsField::Terminal, Some("imageWidthCells".to_string()));
        self.save();
    }

    pub fn get_clear_on_shrink(&self) -> bool {
        self.settings
            .terminal
            .as_ref()
            .and_then(|settings| settings.clear_on_shrink)
            .unwrap_or_else(|| env::var("PI_CLEAR_ON_SHRINK").is_ok_and(|value| value == "1"))
    }

    pub fn set_clear_on_shrink(&mut self, enabled: bool) {
        self.global_settings
            .terminal
            .get_or_insert_with(TerminalSettings::default)
            .clear_on_shrink = Some(enabled);
        self.mark_modified(SettingsField::Terminal, Some("clearOnShrink".to_string()));
        self.save();
    }

    pub fn get_show_terminal_progress(&self) -> bool {
        self.settings
            .terminal
            .as_ref()
            .and_then(|settings| settings.show_terminal_progress)
            .unwrap_or(false)
    }

    pub fn set_show_terminal_progress(&mut self, enabled: bool) {
        self.global_settings
            .terminal
            .get_or_insert_with(TerminalSettings::default)
            .show_terminal_progress = Some(enabled);
        self.mark_modified(
            SettingsField::Terminal,
            Some("showTerminalProgress".to_string()),
        );
        self.save();
    }

    pub fn get_image_auto_resize(&self) -> bool {
        self.settings
            .images
            .as_ref()
            .and_then(|settings| settings.auto_resize)
            .unwrap_or(true)
    }

    pub fn set_image_auto_resize(&mut self, enabled: bool) {
        self.global_settings
            .images
            .get_or_insert_with(ImageSettings::default)
            .auto_resize = Some(enabled);
        self.mark_modified(SettingsField::Images, Some("autoResize".to_string()));
        self.save();
    }

    pub fn get_block_images(&self) -> bool {
        self.settings
            .images
            .as_ref()
            .and_then(|settings| settings.block_images)
            .unwrap_or(false)
    }

    pub fn set_block_images(&mut self, blocked: bool) {
        self.global_settings
            .images
            .get_or_insert_with(ImageSettings::default)
            .block_images = Some(blocked);
        self.mark_modified(SettingsField::Images, Some("blockImages".to_string()));
        self.save();
    }

    pub fn get_enabled_models(&self) -> Option<Vec<String>> {
        self.settings.enabled_models.clone()
    }

    pub fn set_enabled_models(&mut self, patterns: Option<Vec<String>>) {
        self.global_settings.enabled_models = patterns;
        self.mark_modified(SettingsField::EnabledModels, None);
        self.save();
    }

    pub fn get_tree_filter_mode(&self) -> TreeFilterMode {
        self.settings.tree_filter_mode.unwrap_or_default()
    }

    pub fn set_tree_filter_mode(&mut self, mode: TreeFilterMode) {
        self.global_settings.tree_filter_mode = Some(mode);
        self.mark_modified(SettingsField::TreeFilterMode, None);
        self.save();
    }

    pub fn get_show_hardware_cursor(&self) -> bool {
        self.settings
            .show_hardware_cursor
            .unwrap_or_else(|| env::var("PI_HARDWARE_CURSOR").is_ok_and(|value| value == "1"))
    }

    pub fn set_show_hardware_cursor(&mut self, enabled: bool) {
        self.global_settings.show_hardware_cursor = Some(enabled);
        self.mark_modified(SettingsField::ShowHardwareCursor, None);
        self.save();
    }

    pub fn get_editor_padding_x(&self) -> i64 {
        self.settings.editor_padding_x.unwrap_or(0)
    }

    pub fn set_editor_padding_x(&mut self, padding: i64) {
        self.global_settings.editor_padding_x = Some(padding.clamp(0, 3));
        self.mark_modified(SettingsField::EditorPaddingX, None);
        self.save();
    }

    pub fn get_autocomplete_max_visible(&self) -> i64 {
        self.settings.autocomplete_max_visible.unwrap_or(5)
    }

    pub fn set_autocomplete_max_visible(&mut self, max_visible: i64) {
        self.global_settings.autocomplete_max_visible = Some(max_visible.clamp(3, 20));
        self.mark_modified(SettingsField::AutocompleteMaxVisible, None);
        self.save();
    }

    pub fn get_code_block_indent(&self) -> String {
        self.settings
            .markdown
            .as_ref()
            .and_then(|settings| settings.code_block_indent.clone())
            .unwrap_or_else(|| "  ".to_string())
    }

    pub fn get_warnings(&self) -> WarningSettings {
        self.settings.warnings.clone().unwrap_or_default()
    }

    pub fn set_warnings(&mut self, warnings: WarningSettings) {
        self.global_settings.warnings = Some(warnings);
        self.mark_modified(SettingsField::Warnings, None);
        self.save();
    }

    fn mark_modified(&mut self, field: SettingsField, nested_key: Option<String>) {
        self.modified_fields.insert(field);
        if let Some(nested_key) = nested_key {
            self.modified_nested_fields
                .entry(field)
                .or_default()
                .insert(nested_key);
        }
    }

    fn mark_project_modified(&mut self, field: SettingsField, nested_key: Option<String>) {
        self.modified_project_fields.insert(field);
        if let Some(nested_key) = nested_key {
            self.modified_project_nested_fields
                .entry(field)
                .or_default()
                .insert(nested_key);
        }
    }

    fn record_error(&mut self, scope: SettingsScope, error: impl fmt::Display) {
        self.errors.push(SettingsError {
            scope,
            message: error.to_string(),
        });
    }

    fn save(&mut self) {
        self.settings = deep_merge_settings(&self.global_settings, &self.project_settings);

        if self.global_settings_load_error.is_some() || self.modified_fields.is_empty() {
            return;
        }

        let snapshot_settings = self.global_settings.clone();
        let modified_fields = self.modified_fields.clone();
        let modified_nested_fields = self.modified_nested_fields.clone();
        match self.persist_scoped_settings(
            SettingsScope::Global,
            &snapshot_settings,
            &modified_fields,
            &modified_nested_fields,
        ) {
            Ok(()) => {
                self.modified_fields.clear();
                self.modified_nested_fields.clear();
            }
            Err(error) => self.record_error(SettingsScope::Global, error),
        }
    }

    fn save_project(&mut self) {
        self.settings = deep_merge_settings(&self.global_settings, &self.project_settings);

        if self.project_settings_load_error.is_some() || self.modified_project_fields.is_empty() {
            return;
        }

        let snapshot_settings = self.project_settings.clone();
        let modified_fields = self.modified_project_fields.clone();
        let modified_nested_fields = self.modified_project_nested_fields.clone();
        match self.persist_scoped_settings(
            SettingsScope::Project,
            &snapshot_settings,
            &modified_fields,
            &modified_nested_fields,
        ) {
            Ok(()) => {
                self.modified_project_fields.clear();
                self.modified_project_nested_fields.clear();
            }
            Err(error) => self.record_error(SettingsScope::Project, error),
        }
    }

    fn persist_scoped_settings(
        &self,
        scope: SettingsScope,
        snapshot_settings: &Settings,
        modified_fields: &HashSet<SettingsField>,
        modified_nested_fields: &HashMap<SettingsField, HashSet<String>>,
    ) -> Result<(), SettingsManagerError> {
        let storage = self
            .storage
            .as_ref()
            .expect("settings manager storage should be initialized");
        let current_file_settings = match storage.read(scope)? {
            Some(current) => parse_settings_content(&current)?,
            None => Settings::default(),
        };

        let mut merged_settings = settings_to_object(&current_file_settings);
        let snapshot = settings_to_object(snapshot_settings);

        for field in modified_fields {
            let key = field.json_key();
            if let Some(nested_modified) = modified_nested_fields.get(field) {
                let mut merged_nested = merged_settings
                    .get(key)
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let snapshot_nested = snapshot.get(key).and_then(Value::as_object);

                for nested_key in nested_modified {
                    if let Some(value) = snapshot_nested.and_then(|nested| nested.get(nested_key)) {
                        merged_nested.insert(nested_key.clone(), value.clone());
                    } else {
                        merged_nested.remove(nested_key);
                    }
                }

                merged_settings.insert(key.to_string(), Value::Object(merged_nested));
            } else if let Some(value) = snapshot.get(key) {
                merged_settings.insert(key.to_string(), value.clone());
            } else {
                merged_settings.remove(key);
            }
        }

        let content = serde_json::to_string_pretty(&Value::Object(merged_settings))
            .map_err(SettingsManagerError::Serialize)?;
        storage.write(scope, &content)?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionSettingsWithDefaults {
    pub enabled: bool,
    pub reserve_tokens: i64,
    pub keep_recent_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchSummarySettingsWithDefaults {
    pub reserve_tokens: i64,
    pub skip_prompt: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetrySettingsWithDefaults {
    pub enabled: bool,
    pub max_retries: i64,
    pub base_delay_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRetrySettingsWithDefaults {
    pub timeout_ms: Option<i64>,
    pub max_retries: Option<i64>,
    pub max_retry_delay_ms: i64,
}

fn try_load_from_storage(
    storage: &dyn SettingsStorage,
    scope: SettingsScope,
) -> Result<Settings, SettingsManagerError> {
    match storage.read(scope)? {
        Some(content) => parse_settings_content(&content),
        None => Ok(Settings::default()),
    }
}

fn parse_settings_content(content: &str) -> Result<Settings, SettingsManagerError> {
    if content.is_empty() {
        return Ok(Settings::default());
    }

    let value = serde_json::from_str(content).map_err(SettingsManagerError::Parse)?;
    settings_from_value(value).map_err(SettingsManagerError::Parse)
}

fn settings_from_value(value: Value) -> Result<Settings, serde_json::Error> {
    serde_json::from_value(migrate_settings_value(value))
}

fn migrate_settings(settings: Settings) -> Settings {
    settings_from_value(settings_to_value(&settings)).unwrap_or(settings)
}

fn migrate_settings_value(mut value: Value) -> Value {
    let Value::Object(settings) = &mut value else {
        return value;
    };

    if settings.contains_key("queueMode")
        && !settings.contains_key("steeringMode")
        && let Some(queue_mode) = settings.remove("queueMode")
    {
        settings.insert("steeringMode".to_string(), queue_mode);
    }

    if !settings.contains_key("transport")
        && let Some(websockets) = settings.get("websockets").and_then(Value::as_bool)
    {
        let transport = if websockets { "websocket" } else { "sse" };
        settings.insert(
            "transport".to_string(),
            Value::String(transport.to_string()),
        );
        settings.remove("websockets");
    }

    if let Some(Value::Object(skills_settings)) = settings.get("skills") {
        let enable_skill_commands = skills_settings.get("enableSkillCommands").cloned();
        let custom_directories = skills_settings.get("customDirectories").cloned();

        if !settings.contains_key("enableSkillCommands")
            && let Some(enable_skill_commands) = enable_skill_commands
        {
            settings.insert("enableSkillCommands".to_string(), enable_skill_commands);
        }

        if let Some(Value::Array(custom_directories)) = custom_directories
            && !custom_directories.is_empty()
        {
            settings.insert("skills".to_string(), Value::Array(custom_directories));
        } else {
            settings.remove("skills");
        }
    }

    if let Some(Value::Object(retry_settings)) = settings.get_mut("retry") {
        if retry_settings
            .get("maxDelayMs")
            .and_then(Value::as_i64)
            .is_some()
        {
            let should_migrate = retry_settings
                .get("provider")
                .and_then(Value::as_object)
                .and_then(|provider| provider.get("maxRetryDelayMs"))
                .is_none_or(Value::is_null);

            if should_migrate {
                let mut provider_settings = retry_settings
                    .get("provider")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                if let Some(max_delay_ms) = retry_settings.get("maxDelayMs").cloned() {
                    provider_settings.insert("maxRetryDelayMs".to_string(), max_delay_ms);
                }
                retry_settings.insert("provider".to_string(), Value::Object(provider_settings));
            }
        }
        retry_settings.remove("maxDelayMs");
    }

    value
}

fn settings_to_value(settings: &Settings) -> Value {
    serde_json::to_value(settings).unwrap_or_else(|_| Value::Object(Map::new()))
}

fn settings_to_object(settings: &Settings) -> Map<String, Value> {
    match settings_to_value(settings) {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn settings_to_pretty_string(settings: &Settings) -> Result<String, SettingsManagerError> {
    serde_json::to_string_pretty(settings).map_err(SettingsManagerError::Serialize)
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .or_else(|| {
            let drive = env::var_os("HOMEDRIVE")?;
            let path = env::var_os("HOMEPATH")?;
            let mut combined = drive;
            combined.push(path);
            Some(combined)
        })
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn settings_manager_deep_merges_global_and_project_settings() {
        let global = Settings {
            theme: Some("dark".to_string()),
            packages: Some(vec![PackageSource::from("npm:global")]),
            compaction: Some(CompactionSettings {
                enabled: Some(true),
                reserve_tokens: Some(100),
                keep_recent_tokens: Some(200),
            }),
            terminal: Some(TerminalSettings {
                show_images: Some(true),
                image_width_cells: Some(80),
                clear_on_shrink: None,
                show_terminal_progress: None,
            }),
            ..Settings::default()
        };
        let project = Settings {
            packages: Some(vec![PackageSource::from("npm:project")]),
            compaction: Some(CompactionSettings {
                enabled: None,
                reserve_tokens: Some(300),
                keep_recent_tokens: None,
            }),
            terminal: Some(TerminalSettings {
                show_images: None,
                image_width_cells: None,
                clear_on_shrink: Some(true),
                show_terminal_progress: None,
            }),
            ..Settings::default()
        };

        let merged = deep_merge_settings(&global, &project);

        assert_eq!(merged.theme.as_deref(), Some("dark"));
        assert_eq!(merged.packages, project.packages);
        assert_eq!(
            merged.compaction,
            Some(CompactionSettings {
                enabled: Some(true),
                reserve_tokens: Some(300),
                keep_recent_tokens: Some(200),
            })
        );
        assert_eq!(
            merged.terminal,
            Some(TerminalSettings {
                show_images: Some(true),
                image_width_cells: Some(80),
                clear_on_shrink: Some(true),
                show_terminal_progress: None,
            })
        );
    }

    #[test]
    fn settings_manager_deep_merge_ignores_none_and_nullish_values_as_representable() {
        let base: Settings = serde_json::from_value(json!({
            "theme": "dark",
            "compaction": {
                "enabled": true,
                "reserveTokens": 100
            }
        }))
        .unwrap();
        let overrides: Settings = serde_json::from_value(json!({
            "theme": null,
            "compaction": {
                "enabled": null
            }
        }))
        .unwrap();

        let merged = deep_merge_settings(&base, &overrides);

        assert_eq!(merged.theme.as_deref(), Some("dark"));
        assert_eq!(
            merged.compaction,
            Some(CompactionSettings {
                enabled: Some(true),
                reserve_tokens: Some(100),
                keep_recent_tokens: None,
            })
        );
    }

    #[test]
    fn settings_manager_package_source_supports_string_and_object_forms() {
        let string_source: PackageSource = serde_json::from_value(json!("npm:pkg")).unwrap();
        assert_eq!(string_source, PackageSource::Source("npm:pkg".to_string()));
        assert_eq!(
            serde_json::to_value(&string_source).unwrap(),
            json!("npm:pkg")
        );

        let object_source: PackageSource = serde_json::from_value(json!({
            "source": "git+ssh://example/repo",
            "extensions": ["ext.ts"],
            "skills": ["skill.md"]
        }))
        .unwrap();

        assert_eq!(
            object_source,
            PackageSource::Filtered(PackageSourceFilters {
                source: "git+ssh://example/repo".to_string(),
                extensions: Some(vec!["ext.ts".to_string()]),
                skills: Some(vec!["skill.md".to_string()]),
                prompts: None,
                themes: None,
            })
        );
        assert_eq!(
            serde_json::to_value(&object_source).unwrap(),
            json!({
                "source": "git+ssh://example/repo",
                "extensions": ["ext.ts"],
                "skills": ["skill.md"]
            })
        );
    }

    #[test]
    fn settings_manager_in_memory_loads_and_saves_settings() {
        let storage = InMemorySettingsStorage::new();
        storage
            .write(
                SettingsScope::Global,
                r#"{
  "theme": "dark",
  "compaction": {
    "enabled": false
  }
}"#,
            )
            .unwrap();

        let mut manager = SettingsManager::from_storage(storage.clone());
        assert_eq!(manager.get_theme().as_deref(), Some("dark"));
        assert!(!manager.get_compaction_enabled());

        manager.set_theme("light");
        manager.flush();

        let saved: Value =
            serde_json::from_str(&storage.read(SettingsScope::Global).unwrap().unwrap()).unwrap();
        assert_eq!(saved["theme"], json!("light"));
        assert_eq!(saved["compaction"]["enabled"], json!(false));
    }

    #[test]
    fn settings_manager_global_and_project_updates_preserve_unmodified_external_changes() {
        let storage = InMemorySettingsStorage::new();
        storage
            .write(
                SettingsScope::Global,
                r#"{
  "theme": "dark",
  "packages": ["npm:old"]
}"#,
            )
            .unwrap();
        storage
            .write(
                SettingsScope::Project,
                r#"{
  "extensions": ["./old-extension.ts"],
  "prompts": ["./old-prompt.md"]
}"#,
            )
            .unwrap();

        let mut manager = SettingsManager::from_storage(storage.clone());

        storage
            .write(
                SettingsScope::Global,
                r#"{
  "theme": "dark",
  "packages": []
}"#,
            )
            .unwrap();
        manager.set_theme("light");

        let saved_global: Value =
            serde_json::from_str(&storage.read(SettingsScope::Global).unwrap().unwrap()).unwrap();
        assert_eq!(saved_global["theme"], json!("light"));
        assert_eq!(saved_global["packages"], json!([]));

        storage
            .write(
                SettingsScope::Project,
                r#"{
  "extensions": ["./old-extension.ts"],
  "prompts": ["./new-prompt.md"]
}"#,
            )
            .unwrap();
        manager.set_project_extension_paths(vec!["./updated-extension.ts".to_string()]);

        let saved_project: Value =
            serde_json::from_str(&storage.read(SettingsScope::Project).unwrap().unwrap()).unwrap();
        assert_eq!(
            saved_project["extensions"],
            json!(["./updated-extension.ts"])
        );
        assert_eq!(saved_project["prompts"], json!(["./new-prompt.md"]));
    }

    #[test]
    fn settings_manager_clears_fields_by_omitting_none_on_save() {
        let storage = InMemorySettingsStorage::new();
        storage
            .write(
                SettingsScope::Global,
                r#"{
  "shellPath": "/bin/zsh",
  "theme": "dark"
}"#,
            )
            .unwrap();

        let mut manager = SettingsManager::from_storage(storage.clone());
        manager.set_shell_path(None);

        let saved: Value =
            serde_json::from_str(&storage.read(SettingsScope::Global).unwrap().unwrap()).unwrap();
        assert!(saved.get("shellPath").is_none());
        assert_eq!(saved["theme"], json!("dark"));
    }

    #[test]
    fn settings_manager_captures_invalid_json_load_errors() {
        let storage = InMemorySettingsStorage::new();
        storage
            .write(SettingsScope::Global, "{ invalid json")
            .unwrap();
        storage
            .write(SettingsScope::Project, r#"{"theme":"project"}"#)
            .unwrap();

        let mut manager = SettingsManager::from_storage(storage);

        assert!(manager.global_settings_load_error().is_some());
        assert!(manager.project_settings_load_error().is_none());
        assert_eq!(manager.get_global_settings(), Settings::default());
        assert_eq!(manager.get_theme().as_deref(), Some("project"));

        let errors = manager.drain_errors();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].scope, SettingsScope::Global);
        assert!(!errors[0].message.is_empty());
    }
}
