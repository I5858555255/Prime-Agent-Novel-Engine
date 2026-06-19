use std::collections::{BTreeMap, HashMap};
use std::env;
use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use prime_agent_ai::{
    OAuthApiKeyError, OAuthCredentials, OAuthProviderId, OAuthProviderInterface, find_env_keys,
    get_env_api_key, get_oauth_api_key_if_fresh, get_oauth_providers,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::config::get_auth_path;
use crate::resolve_config_value::resolve_config_value;

pub const PRIME_INFERENCE_PROVIDER_ID: &str = "prime-inference";
pub const PRIME_INFERENCE_PROVIDER_NAME: &str = "Prime Inference";
pub const PRIME_AGENT_TRACES_PROVIDER_ID: &str = "prime-agent-traces";
pub const PRIME_AGENT_TRACES_PROVIDER_NAME: &str = "Prime Agent Traces";

const DEFAULT_PRIME_API_BASE_URL: &str = "https://api.primeintellect.ai";
const DEFAULT_PRIME_FRONTEND_URL: &str = "https://app.primeintellect.ai";
const DEFAULT_PRIME_INFERENCE_URL: &str = "https://api.pinference.ai/api/v1";

type EnvKeyFinder = dyn Fn(&str) -> Option<Vec<String>> + Send + Sync;
type EnvApiKeyResolver = dyn Fn(&str) -> Option<String> + Send + Sync;
type EnvVarResolver = dyn Fn(&str) -> Option<String> + Send + Sync;
type FallbackResolver = dyn Fn(&str) -> Option<String> + Send + Sync;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimeTeamCredential {
    pub team_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

pub type PrimeTeam = PrimeTeamCredential;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyCredential {
    pub key: String,
    #[serde(
        default,
        deserialize_with = "deserialize_nullable_option",
        serialize_with = "serialize_nullable_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub prime_team: Option<Option<PrimeTeamCredential>>,
}

impl ApiKeyCredential {
    pub fn new(key: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            prime_team: None,
        }
    }

    pub fn with_prime_team(
        key: impl Into<String>,
        prime_team: Option<Option<PrimeTeamCredential>>,
    ) -> Self {
        Self {
            key: key.into(),
            prime_team,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCredential {
    pub refresh: String,
    pub access: String,
    pub expires: i64,
    #[serde(default, flatten, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

impl OAuthCredential {
    pub fn new(credentials: OAuthCredentials) -> Self {
        credentials.into()
    }

    pub fn to_oauth_credentials(&self) -> OAuthCredentials {
        OAuthCredentials {
            refresh: self.refresh.clone(),
            access: self.access.clone(),
            expires: self.expires,
            extra: self.extra.clone(),
        }
    }
}

impl From<OAuthCredentials> for OAuthCredential {
    fn from(value: OAuthCredentials) -> Self {
        Self {
            refresh: value.refresh,
            access: value.access,
            expires: value.expires,
            extra: value.extra,
        }
    }
}

impl From<OAuthCredential> for OAuthCredentials {
    fn from(value: OAuthCredential) -> Self {
        Self {
            refresh: value.refresh,
            access: value.access,
            expires: value.expires,
            extra: value.extra,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AuthCredential {
    #[serde(rename = "api_key")]
    ApiKey(ApiKeyCredential),
    #[serde(rename = "oauth")]
    OAuth(OAuthCredential),
}

impl AuthCredential {
    pub fn api_key(key: impl Into<String>) -> Self {
        Self::ApiKey(ApiKeyCredential::new(key))
    }

    pub fn api_key_with_prime_team(
        key: impl Into<String>,
        prime_team: Option<Option<PrimeTeamCredential>>,
    ) -> Self {
        Self::ApiKey(ApiKeyCredential::with_prime_team(key, prime_team))
    }

    pub fn oauth(credentials: OAuthCredentials) -> Self {
        Self::OAuth(OAuthCredential::new(credentials))
    }

    pub fn as_api_key(&self) -> Option<&ApiKeyCredential> {
        match self {
            Self::ApiKey(credential) => Some(credential),
            Self::OAuth(_) => None,
        }
    }

    pub fn as_oauth(&self) -> Option<&OAuthCredential> {
        match self {
            Self::ApiKey(_) => None,
            Self::OAuth(credential) => Some(credential),
        }
    }
}

pub type AuthStorageData = BTreeMap<String, AuthCredential>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthStatusSource {
    Stored,
    Runtime,
    Environment,
    PrimeCli,
    Fallback,
    ModelsJsonKey,
    ModelsJsonCommand,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub configured: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<AuthStatusSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

impl AuthStatus {
    pub fn unconfigured() -> Self {
        Self {
            configured: false,
            source: None,
            label: None,
        }
    }

    pub fn with_source(
        configured: bool,
        source: AuthStatusSource,
        label: Option<impl Into<String>>,
    ) -> Self {
        Self {
            configured,
            source: Some(source),
            label: label.map(Into::into),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GetApiKeyOptions {
    pub include_fallback: bool,
}

impl Default for GetApiKeyOptions {
    fn default() -> Self {
        Self {
            include_fallback: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AuthStorageOptions {
    pub prime_cli_config_path: Option<PathBuf>,
    pub use_prime_cli_config: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrimeCliConfig {
    pub api_key: Option<String>,
    pub base_url: String,
    pub frontend_url: String,
    pub inference_url: String,
    pub path: PathBuf,
    pub team_id: Option<String>,
    pub team_name: Option<String>,
    pub team_role: Option<String>,
    pub team_id_from_env: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthStorageError {
    message: String,
}

impl AuthStorageError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    fn poisoned(name: &str) -> Self {
        Self::new(format!("{name} lock poisoned"))
    }
}

impl fmt::Display for AuthStorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for AuthStorageError {}

impl From<io::Error> for AuthStorageError {
    fn from(value: io::Error) -> Self {
        Self::new(value.to_string())
    }
}

impl From<serde_json::Error> for AuthStorageError {
    fn from(value: serde_json::Error) -> Self {
        Self::new(value.to_string())
    }
}

pub trait AuthStorageBackend: Send + Sync {
    fn read(&self) -> Result<Option<String>, AuthStorageError>;
    fn write(&self, content: &str) -> Result<(), AuthStorageError>;
}

/// File-backed auth storage.
///
/// The TypeScript implementation wraps file reads and writes in proper-lockfile.
/// This Rust port preserves deterministic read/merge/write behavior and best
/// effort private file permissions, but intentionally does not implement
/// process-wide file locking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileAuthStorageBackend {
    auth_path: PathBuf,
}

impl FileAuthStorageBackend {
    pub fn new(auth_path: impl Into<PathBuf>) -> Self {
        Self {
            auth_path: auth_path.into(),
        }
    }

    pub fn auth_path(&self) -> &Path {
        &self.auth_path
    }

    fn ensure_parent_dir(&self) -> Result<(), AuthStorageError> {
        let Some(parent) = self.auth_path.parent() else {
            return Ok(());
        };
        if parent.as_os_str().is_empty() {
            return Ok(());
        }
        fs::create_dir_all(parent)?;
        Ok(())
    }

    fn ensure_file_exists(&self) -> Result<(), AuthStorageError> {
        if !self.auth_path.exists() {
            fs::write(&self.auth_path, "{}")?;
            set_file_private(&self.auth_path);
        }
        Ok(())
    }
}

impl Default for FileAuthStorageBackend {
    fn default() -> Self {
        Self::new(get_auth_path())
    }
}

impl AuthStorageBackend for FileAuthStorageBackend {
    fn read(&self) -> Result<Option<String>, AuthStorageError> {
        self.ensure_parent_dir()?;
        self.ensure_file_exists()?;
        Ok(Some(fs::read_to_string(&self.auth_path)?))
    }

    fn write(&self, content: &str) -> Result<(), AuthStorageError> {
        self.ensure_parent_dir()?;
        fs::write(&self.auth_path, content)?;
        set_file_private(&self.auth_path);
        Ok(())
    }
}

#[derive(Debug, Clone, Default)]
pub struct InMemoryAuthStorageBackend {
    inner: Arc<Mutex<Option<String>>>,
}

impl InMemoryAuthStorageBackend {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_content(content: impl Into<String>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Some(content.into()))),
        }
    }

    pub fn read_value(&self) -> Result<Option<String>, AuthStorageError> {
        self.read()
    }
}

impl AuthStorageBackend for InMemoryAuthStorageBackend {
    fn read(&self) -> Result<Option<String>, AuthStorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|_| AuthStorageError::poisoned("auth storage"))?;
        Ok(storage.clone())
    }

    fn write(&self, content: &str) -> Result<(), AuthStorageError> {
        *self
            .inner
            .lock()
            .map_err(|_| AuthStorageError::poisoned("auth storage"))? = Some(content.to_string());
        Ok(())
    }
}

pub struct AuthStorage {
    storage: Box<dyn AuthStorageBackend>,
    options: AuthStorageOptions,
    data: AuthStorageData,
    runtime_overrides: HashMap<String, String>,
    fallback_resolver: Option<Box<FallbackResolver>>,
    load_error: Option<AuthStorageError>,
    errors: Vec<AuthStorageError>,
    prime_cli_config_cache: Option<PrimeCliConfig>,
    prime_cli_config_cache_loaded: bool,
    env_key_finder: Box<EnvKeyFinder>,
    env_api_key_resolver: Box<EnvApiKeyResolver>,
    prime_env_resolver: Box<EnvVarResolver>,
}

impl AuthStorage {
    pub fn create(auth_path: Option<PathBuf>, options: Option<AuthStorageOptions>) -> Self {
        let use_default_prime_cli_config = auth_path.is_none();
        let auth_options = options.unwrap_or(AuthStorageOptions {
            prime_cli_config_path: None,
            use_prime_cli_config: use_default_prime_cli_config,
        });
        let path = auth_path.unwrap_or_else(get_auth_path);
        Self::from_storage(FileAuthStorageBackend::new(path), auth_options)
    }

    pub fn from_storage<S>(storage: S, options: AuthStorageOptions) -> Self
    where
        S: AuthStorageBackend + 'static,
    {
        let mut auth_storage = Self {
            storage: Box::new(storage),
            options,
            data: AuthStorageData::new(),
            runtime_overrides: HashMap::new(),
            fallback_resolver: None,
            load_error: None,
            errors: Vec::new(),
            prime_cli_config_cache: None,
            prime_cli_config_cache_loaded: false,
            env_key_finder: Box::new(find_env_keys),
            env_api_key_resolver: Box::new(get_env_api_key),
            prime_env_resolver: Box::new(|key| env::var(key).ok()),
        };
        auth_storage.reload();
        auth_storage
    }

    pub fn in_memory(data: AuthStorageData) -> Self {
        Self::in_memory_with_options(data, AuthStorageOptions::default())
    }

    pub fn in_memory_with_options(data: AuthStorageData, options: AuthStorageOptions) -> Self {
        let storage = InMemoryAuthStorageBackend::new();
        let content =
            storage_data_to_pretty_string(&data).expect("auth storage data should serialize");
        storage
            .write(&content)
            .expect("in-memory auth storage should write");
        Self::from_storage(storage, options)
    }

    pub fn set_runtime_api_key(&mut self, provider: impl Into<String>, api_key: impl Into<String>) {
        self.runtime_overrides
            .insert(provider.into(), api_key.into());
    }

    pub fn remove_runtime_api_key(&mut self, provider: &str) {
        self.runtime_overrides.remove(provider);
    }

    pub fn set_fallback_resolver<F>(&mut self, resolver: F)
    where
        F: Fn(&str) -> Option<String> + Send + Sync + 'static,
    {
        self.fallback_resolver = Some(Box::new(resolver));
    }

    pub fn clear_fallback_resolver(&mut self) {
        self.fallback_resolver = None;
    }

    pub fn reload(&mut self) {
        self.prime_cli_config_cache = None;
        self.prime_cli_config_cache_loaded = false;

        match self
            .storage
            .read()
            .and_then(|content| parse_storage_data(content.as_deref()))
        {
            Ok(data) => {
                self.data = data;
                self.load_error = None;
            }
            Err(error) => {
                self.load_error = Some(error.clone());
                self.record_error(error);
            }
        }
    }

    pub fn load_error(&self) -> Option<&AuthStorageError> {
        self.load_error.as_ref()
    }

    pub fn get(&self, provider: &str) -> Option<&AuthCredential> {
        self.data.get(provider)
    }

    pub fn set(&mut self, provider: impl Into<String>, credential: AuthCredential) {
        let provider = provider.into();
        self.data.insert(provider.clone(), credential.clone());
        self.persist_provider_change(&provider, Some(credential));
    }

    pub fn remove(&mut self, provider: &str) {
        self.data.remove(provider);
        self.persist_provider_change(provider, None);
    }

    pub fn list(&self) -> Vec<String> {
        self.data.keys().cloned().collect()
    }

    pub fn has(&self, provider: &str) -> bool {
        self.data.contains_key(provider)
    }

    pub fn has_auth(&mut self, provider: &str) -> bool {
        self.runtime_overrides.contains_key(provider)
            || self.data.contains_key(provider)
            || (self.env_api_key_resolver)(provider).is_some()
            || self.get_prime_cli_api_key(provider).is_some()
            || self
                .fallback_resolver
                .as_ref()
                .and_then(|resolver| resolver(provider))
                .is_some_and(|value| !value.is_empty())
    }

    pub fn get_auth_status(&mut self, provider: &str) -> AuthStatus {
        if self.data.contains_key(provider) {
            return AuthStatus::with_source(true, AuthStatusSource::Stored, None::<String>);
        }

        if self.runtime_overrides.contains_key(provider) {
            return AuthStatus::with_source(false, AuthStatusSource::Runtime, Some("--api-key"));
        }

        if let Some(label) =
            (self.env_key_finder)(provider).and_then(|keys| keys.into_iter().next())
        {
            return AuthStatus::with_source(false, AuthStatusSource::Environment, Some(label));
        }

        if self.get_prime_cli_api_key(provider).is_some() {
            return AuthStatus::with_source(false, AuthStatusSource::PrimeCli, Some("Prime CLI"));
        }

        if self
            .fallback_resolver
            .as_ref()
            .and_then(|resolver| resolver(provider))
            .is_some_and(|value| !value.is_empty())
        {
            return AuthStatus::with_source(
                false,
                AuthStatusSource::Fallback,
                Some("custom provider config"),
            );
        }

        AuthStatus::unconfigured()
    }

    pub fn get_all(&self) -> AuthStorageData {
        self.data.clone()
    }

    pub fn drain_errors(&mut self) -> Vec<AuthStorageError> {
        std::mem::take(&mut self.errors)
    }

    pub fn logout(&mut self, provider: &str) {
        self.remove(provider);
    }

    pub fn set_oauth_credentials(
        &mut self,
        provider_id: impl Into<String>,
        credentials: OAuthCredentials,
    ) {
        self.set(provider_id, AuthCredential::oauth(credentials));
    }

    pub fn get_api_key(&mut self, provider_id: &str) -> Option<String> {
        self.get_api_key_with_options(provider_id, GetApiKeyOptions::default())
    }

    pub fn get_api_key_with_options(
        &mut self,
        provider_id: &str,
        options: GetApiKeyOptions,
    ) -> Option<String> {
        if let Some(runtime_key) = self
            .runtime_overrides
            .get(provider_id)
            .filter(|value| !value.is_empty())
        {
            return Some(runtime_key.clone());
        }

        match self.data.get(provider_id).cloned() {
            Some(AuthCredential::ApiKey(credential)) => {
                return resolve_config_value(&credential.key);
            }
            Some(AuthCredential::OAuth(credential)) => {
                if let Some(api_key) = fresh_oauth_api_key(provider_id, &credential) {
                    return Some(api_key);
                }
            }
            None => {}
        }

        if let Some(env_key) = (self.env_api_key_resolver)(provider_id) {
            return Some(env_key);
        }

        if let Some(prime_cli_key) = self.get_prime_cli_api_key(provider_id) {
            return Some(prime_cli_key);
        }

        if options.include_fallback {
            return self
                .fallback_resolver
                .as_ref()
                .and_then(|resolver| resolver(provider_id));
        }

        None
    }

    pub fn get_oauth_providers(&self) -> Vec<OAuthProviderInterface> {
        get_oauth_providers()
    }

    pub fn set_prime_inference_team_selection(&mut self, team: Option<PrimeTeam>) {
        let Some(AuthCredential::ApiKey(mut credential)) =
            self.data.get(PRIME_INFERENCE_PROVIDER_ID).cloned()
        else {
            return;
        };

        credential.prime_team = Some(team.map(to_prime_team_credential));
        self.set(
            PRIME_INFERENCE_PROVIDER_ID,
            AuthCredential::ApiKey(credential),
        );
    }

    pub fn get_prime_inference_team_selection(&self) -> Option<Option<PrimeTeamCredential>> {
        match self.data.get(PRIME_INFERENCE_PROVIDER_ID) {
            Some(AuthCredential::ApiKey(credential)) => credential.prime_team.clone(),
            _ => None,
        }
    }

    pub fn get_provider_headers(&mut self, provider_id: &str) -> Option<BTreeMap<String, String>> {
        if provider_id != PRIME_INFERENCE_PROVIDER_ID {
            return None;
        }

        let prime_cli_config = self.get_prime_cli_config(provider_id);
        if let Some(config) = &prime_cli_config
            && config.team_id_from_env
        {
            return config
                .team_id
                .as_ref()
                .filter(|team_id| !team_id.is_empty())
                .map(|team_id| prime_team_header(team_id.clone()));
        }

        if let Some(AuthCredential::ApiKey(credential)) = self.data.get(provider_id) {
            match &credential.prime_team {
                Some(None) => return None,
                Some(Some(team)) if !team.team_id.is_empty() => {
                    return Some(prime_team_header(team.team_id.clone()));
                }
                Some(Some(_)) | None => {}
            }
        }

        prime_cli_config
            .and_then(|config| config.team_id)
            .filter(|team_id| !team_id.is_empty())
            .map(prime_team_header)
    }

    fn persist_provider_change(&mut self, provider: &str, credential: Option<AuthCredential>) {
        if self.load_error.is_some() {
            return;
        }

        let result = self
            .storage
            .read()
            .and_then(|content| parse_storage_data(content.as_deref()))
            .and_then(|mut current_data| {
                if let Some(credential) = credential {
                    current_data.insert(provider.to_string(), credential);
                } else {
                    current_data.remove(provider);
                }
                storage_data_to_pretty_string(&current_data)
            })
            .and_then(|content| self.storage.write(&content));

        if let Err(error) = result {
            self.record_error(error);
        }
    }

    fn record_error(&mut self, error: AuthStorageError) {
        self.errors.push(error);
    }

    fn get_prime_cli_config(&mut self, provider_id: &str) -> Option<PrimeCliConfig> {
        if provider_id != PRIME_INFERENCE_PROVIDER_ID {
            return None;
        }
        if !self.options.use_prime_cli_config && self.options.prime_cli_config_path.is_none() {
            return None;
        }
        if !self.prime_cli_config_cache_loaded {
            self.prime_cli_config_cache = Some(load_prime_cli_config_with_env(
                self.options.prime_cli_config_path.as_deref(),
                |key| (self.prime_env_resolver)(key),
            ));
            self.prime_cli_config_cache_loaded = true;
        }
        self.prime_cli_config_cache.clone()
    }

    fn get_prime_cli_api_key(&mut self, provider_id: &str) -> Option<String> {
        self.get_prime_cli_config(provider_id)
            .and_then(|config| config.api_key)
    }
}

pub fn default_prime_cli_config_path() -> PathBuf {
    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".prime")
        .join("config.json")
}

pub fn load_prime_cli_config(config_path: Option<&Path>) -> PrimeCliConfig {
    load_prime_cli_config_with_env(config_path, |key| env::var(key).ok())
}

fn load_prime_cli_config_with_env<F>(config_path: Option<&Path>, env_lookup: F) -> PrimeCliConfig
where
    F: Fn(&str) -> Option<String>,
{
    let path = config_path
        .map(Path::to_path_buf)
        .unwrap_or_else(default_prime_cli_config_path);
    let data = read_prime_cli_config_data(&path);
    let team_id_from_env = string_env("PRIME_TEAM_ID", &env_lookup);
    let team_id = team_id_from_env
        .clone()
        .or_else(|| string_field(&data, "team_id"));

    let api_key = string_field(&data, "api_key");
    let team_name = team_id_from_env
        .is_none()
        .then(|| string_field(&data, "team_name"))
        .flatten();
    let team_role = team_id_from_env
        .is_none()
        .then(|| string_field(&data, "team_role"))
        .flatten();

    PrimeCliConfig {
        api_key,
        base_url: normalize_base_url(string_field(&data, "base_url").as_deref()),
        frontend_url: normalize_url(
            string_field(&data, "frontend_url").as_deref(),
            DEFAULT_PRIME_FRONTEND_URL,
        ),
        inference_url: normalize_url(
            string_field(&data, "inference_url").as_deref(),
            DEFAULT_PRIME_INFERENCE_URL,
        ),
        path,
        team_id,
        team_name,
        team_role,
        team_id_from_env: team_id_from_env.is_some(),
    }
}

fn parse_storage_data(content: Option<&str>) -> Result<AuthStorageData, AuthStorageError> {
    let Some(content) = content else {
        return Ok(AuthStorageData::new());
    };
    if content.is_empty() {
        return Ok(AuthStorageData::new());
    }
    serde_json::from_str(content).map_err(Into::into)
}

fn storage_data_to_pretty_string(data: &AuthStorageData) -> Result<String, AuthStorageError> {
    serde_json::to_string_pretty(data).map_err(Into::into)
}

fn fresh_oauth_api_key(provider_id: &str, credential: &OAuthCredential) -> Option<String> {
    let mut credentials = HashMap::<OAuthProviderId, OAuthCredentials>::new();
    credentials.insert(provider_id.to_string(), credential.to_oauth_credentials());

    match get_oauth_api_key_if_fresh(provider_id, &credentials, current_time_ms()) {
        Ok(Some(result)) => Some(result.api_key),
        Ok(None)
        | Err(OAuthApiKeyError::UnknownProvider { .. })
        | Err(OAuthApiKeyError::ExpiredCredentials { .. }) => None,
    }
}

fn current_time_ms() -> i64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    i64::try_from(millis).unwrap_or(i64::MAX)
}

fn prime_team_header(team_id: String) -> BTreeMap<String, String> {
    BTreeMap::from([("X-Prime-Team-ID".to_string(), team_id)])
}

fn to_prime_team_credential(team: PrimeTeam) -> PrimeTeamCredential {
    PrimeTeamCredential {
        team_id: team.team_id,
        name: team.name,
        slug: team.slug,
        role: team.role,
        created_at: team.created_at,
    }
}

fn read_prime_cli_config_data(config_path: &Path) -> Map<String, Value> {
    let Ok(content) = fs::read_to_string(config_path) else {
        return Map::new();
    };
    let Ok(Value::Object(data)) = serde_json::from_str::<Value>(&content) else {
        return Map::new();
    };
    data
}

fn string_field(data: &Map<String, Value>, key: &str) -> Option<String> {
    data.get(key)
        .and_then(Value::as_str)
        .and_then(|value| non_empty_trimmed(value.to_string()))
}

fn string_env<F>(name: &str, env_lookup: F) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
{
    env_lookup(name).and_then(non_empty_trimmed)
}

fn non_empty_trimmed(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_base_url(value: Option<&str>) -> String {
    let mut normalized = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_PRIME_API_BASE_URL)
        .trim_end_matches('/')
        .to_string();
    if let Some(without_api_v1) = normalized.strip_suffix("/api/v1") {
        normalized = without_api_v1.to_string();
    }
    normalized
}

fn normalize_url(value: Option<&str>, fallback: &str) -> String {
    value
        .unwrap_or(fallback)
        .trim()
        .trim_end_matches('/')
        .to_string()
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

fn deserialize_nullable_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

fn serialize_nullable_option<S, T>(
    value: &Option<Option<T>>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
    T: Serialize,
{
    match value {
        Some(Some(inner)) => inner.serialize(serializer),
        Some(None) | None => serializer.serialize_none(),
    }
}

#[cfg(unix)]
fn set_file_private(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_file_private(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Debug)]
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(prefix: &str) -> io::Result<Self> {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = env::temp_dir().join(format!(
                "prime-agent-{prefix}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&path)?;
            Ok(Self { path })
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn auth_storage_with_empty_env<S>(storage: S, options: AuthStorageOptions) -> AuthStorage
    where
        S: AuthStorageBackend + 'static,
    {
        let mut auth_storage = AuthStorage::from_storage(storage, options);
        auth_storage.env_key_finder = Box::new(|_| None);
        auth_storage.env_api_key_resolver = Box::new(|_| None);
        auth_storage.prime_env_resolver = Box::new(|_| None);
        auth_storage
    }

    #[test]
    fn auth_storage_api_key_and_oauth_credentials_serialize_with_typescript_tags() {
        let api_key_value = json!({
            "type": "api_key",
            "key": "agent-key",
            "primeTeam": {
                "teamId": "team-1",
                "name": "Research",
                "slug": "research",
                "role": "admin",
                "createdAt": "2026-06-18T00:00:00Z"
            }
        });
        let api_key: AuthCredential = serde_json::from_value(api_key_value.clone()).unwrap();

        assert_eq!(serde_json::to_value(&api_key).unwrap(), api_key_value);
        assert_eq!(
            api_key.as_api_key().unwrap().prime_team,
            Some(Some(PrimeTeamCredential {
                team_id: "team-1".to_string(),
                name: "Research".to_string(),
                slug: Some("research".to_string()),
                role: Some("admin".to_string()),
                created_at: Some("2026-06-18T00:00:00Z".to_string()),
            }))
        );

        let personal_value = json!({
            "type": "api_key",
            "key": "agent-key",
            "primeTeam": null
        });
        let personal: AuthCredential = serde_json::from_value(personal_value.clone()).unwrap();

        assert_eq!(
            personal.as_api_key().unwrap().prime_team,
            Some(None),
            "present null primeTeam must stay distinguishable from an omitted field"
        );
        assert_eq!(serde_json::to_value(&personal).unwrap(), personal_value);

        let oauth_value = json!({
            "type": "oauth",
            "refresh": "refresh-token",
            "access": "access-token",
            "expires": 1_800_000_000_000_i64,
            "enterpriseUrl": "github.example.com"
        });
        let oauth: AuthCredential = serde_json::from_value(oauth_value.clone()).unwrap();

        assert_eq!(oauth.as_oauth().unwrap().access, "access-token");
        assert_eq!(serde_json::to_value(&oauth).unwrap(), oauth_value);
    }

    #[test]
    fn auth_storage_in_memory_loads_saves_and_removes_credentials() {
        let mut initial_data = AuthStorageData::new();
        initial_data.insert("openai".to_string(), AuthCredential::api_key("openai-key"));
        let mut auth_storage = AuthStorage::in_memory(initial_data);

        assert!(auth_storage.has("openai"));
        assert_eq!(auth_storage.list(), vec!["openai".to_string()]);

        auth_storage.set("anthropic", AuthCredential::api_key("anthropic-key"));
        assert_eq!(
            auth_storage.get_api_key("anthropic"),
            Some("anthropic-key".to_string())
        );

        auth_storage.remove("openai");
        assert!(!auth_storage.has("openai"));
        assert_eq!(auth_storage.list(), vec!["anthropic".to_string()]);
    }

    #[test]
    fn auth_storage_in_memory_backend_persists_set_and_remove() {
        let storage = InMemoryAuthStorageBackend::new();
        let mut auth_storage =
            auth_storage_with_empty_env(storage.clone(), AuthStorageOptions::default());

        auth_storage.set("anthropic", AuthCredential::api_key("anthropic-key"));
        let saved: Value = serde_json::from_str(&storage.read().unwrap().unwrap()).unwrap();
        assert_eq!(saved["anthropic"]["type"], json!("api_key"));
        assert_eq!(saved["anthropic"]["key"], json!("anthropic-key"));

        auth_storage.remove("anthropic");
        let saved: Value = serde_json::from_str(&storage.read().unwrap().unwrap()).unwrap();
        assert!(saved.get("anthropic").is_none());
    }

    #[test]
    fn auth_storage_runtime_override_takes_precedence_and_can_be_removed() {
        let mut data = AuthStorageData::new();
        data.insert(
            "anthropic".to_string(),
            AuthCredential::api_key("stored-key"),
        );
        let mut auth_storage = AuthStorage::in_memory(data);

        auth_storage.set_runtime_api_key("anthropic", "runtime-key");
        assert_eq!(
            auth_storage.get_api_key("anthropic"),
            Some("runtime-key".to_string())
        );

        auth_storage.remove_runtime_api_key("anthropic");
        assert_eq!(
            auth_storage.get_api_key("anthropic"),
            Some("stored-key".to_string())
        );
    }

    #[test]
    fn auth_storage_fallback_runs_after_environment_and_prime_cli_sources() {
        let temp_dir = TempDir::new("auth-storage-prime-cli").unwrap();
        let prime_config_path = temp_dir.path().join("prime-config.json");
        fs::write(
            &prime_config_path,
            r#"{"api_key":"prime-cli-key","team_id":"cli-team"}"#,
        )
        .unwrap();
        let options = AuthStorageOptions {
            prime_cli_config_path: Some(prime_config_path),
            use_prime_cli_config: true,
        };
        let mut auth_storage =
            AuthStorage::from_storage(InMemoryAuthStorageBackend::new(), options);
        auth_storage.env_key_finder = Box::new(|provider| {
            (provider == "anthropic").then(|| vec!["ANTHROPIC_API_KEY".to_string()])
        });
        auth_storage.env_api_key_resolver =
            Box::new(|provider| (provider == "anthropic").then(|| "env-anthropic-key".to_string()));
        auth_storage.prime_env_resolver = Box::new(|_| None);
        auth_storage.set_fallback_resolver(|provider| match provider {
            "anthropic" => Some("fallback-anthropic-key".to_string()),
            "prime-inference" => Some("fallback-prime-key".to_string()),
            "custom-provider" => Some("fallback-custom-key".to_string()),
            _ => None,
        });

        assert_eq!(
            auth_storage.get_api_key("anthropic"),
            Some("env-anthropic-key".to_string())
        );
        assert_eq!(
            auth_storage.get_auth_status("anthropic"),
            AuthStatus::with_source(
                false,
                AuthStatusSource::Environment,
                Some("ANTHROPIC_API_KEY")
            )
        );

        assert_eq!(
            auth_storage.get_api_key("prime-inference"),
            Some("prime-cli-key".to_string())
        );
        assert_eq!(
            auth_storage.get_auth_status("prime-inference"),
            AuthStatus::with_source(false, AuthStatusSource::PrimeCli, Some("Prime CLI"))
        );

        assert_eq!(
            auth_storage.get_api_key("custom-provider"),
            Some("fallback-custom-key".to_string())
        );
        assert_eq!(
            auth_storage.get_api_key_with_options(
                "custom-provider",
                GetApiKeyOptions {
                    include_fallback: false,
                },
            ),
            None
        );
        assert_eq!(
            auth_storage.get_auth_status("custom-provider"),
            AuthStatus::with_source(
                false,
                AuthStatusSource::Fallback,
                Some("custom provider config")
            )
        );
    }

    #[test]
    fn auth_storage_auth_status_labels_do_not_expose_credential_values() {
        let mut data = AuthStorageData::new();
        data.insert(
            "anthropic".to_string(),
            AuthCredential::api_key("secret-api-key"),
        );
        let mut auth_storage = AuthStorage::in_memory(data);

        assert_eq!(
            auth_storage.get_auth_status("anthropic"),
            AuthStatus::with_source(true, AuthStatusSource::Stored, None::<String>)
        );
        let status_json =
            serde_json::to_string(&auth_storage.get_auth_status("anthropic")).unwrap();
        assert!(!status_json.contains("secret-api-key"));
    }

    #[test]
    fn auth_storage_malformed_json_load_errors_are_recorded_without_overwriting_storage() {
        let storage = InMemoryAuthStorageBackend::with_content(
            r#"{"anthropic":{"type":"api_key","key":"anthropic-key"}}"#,
        );
        let mut auth_storage =
            auth_storage_with_empty_env(storage.clone(), AuthStorageOptions::default());
        assert!(auth_storage.has("anthropic"));

        storage.write("{invalid-json").unwrap();
        auth_storage.reload();

        assert!(auth_storage.load_error().is_some());
        assert!(auth_storage.has("anthropic"));
        let errors = auth_storage.drain_errors();
        assert_eq!(errors.len(), 1);
        assert!(!errors[0].message().is_empty());

        auth_storage.set("openai", AuthCredential::api_key("openai-key"));
        assert_eq!(storage.read().unwrap().unwrap(), "{invalid-json");
    }

    #[test]
    fn auth_storage_oauth_get_api_key_uses_fresh_access_token_without_refresh() {
        let mut data = AuthStorageData::new();
        data.insert(
            "anthropic".to_string(),
            AuthCredential::oauth(OAuthCredentials {
                refresh: "refresh-token".to_string(),
                access: "access-token".to_string(),
                expires: current_time_ms() + 60_000,
                extra: Map::new(),
            }),
        );
        let mut auth_storage = AuthStorage::in_memory(data);

        assert_eq!(
            auth_storage.get_api_key("anthropic"),
            Some("access-token".to_string())
        );
    }

    #[test]
    fn auth_storage_prime_inference_team_headers_preserve_null_and_fallback_states() {
        let temp_dir = TempDir::new("auth-storage-team").unwrap();
        let prime_config_path = temp_dir.path().join("prime-config.json");
        fs::write(
            &prime_config_path,
            r#"{"api_key":"prime-cli-key","team_id":"cli-team"}"#,
        )
        .unwrap();
        let options = AuthStorageOptions {
            prime_cli_config_path: Some(prime_config_path),
            use_prime_cli_config: true,
        };
        let mut data = AuthStorageData::new();
        data.insert(
            PRIME_INFERENCE_PROVIDER_ID.to_string(),
            AuthCredential::api_key_with_prime_team("agent-key", Some(None)),
        );
        let mut auth_storage = AuthStorage::in_memory_with_options(data, options);
        auth_storage.prime_env_resolver = Box::new(|_| None);

        assert_eq!(
            auth_storage.get_provider_headers(PRIME_INFERENCE_PROVIDER_ID),
            None
        );
        assert_eq!(
            auth_storage.get_prime_inference_team_selection(),
            Some(None)
        );

        auth_storage.set_prime_inference_team_selection(Some(PrimeTeamCredential {
            team_id: "team-1".to_string(),
            name: "Research".to_string(),
            slug: Some("research".to_string()),
            role: Some("admin".to_string()),
            created_at: None,
        }));
        assert_eq!(
            auth_storage.get_provider_headers(PRIME_INFERENCE_PROVIDER_ID),
            Some(prime_team_header("team-1".to_string()))
        );
    }

    #[cfg(unix)]
    #[test]
    fn auth_storage_file_backend_creates_private_auth_file_on_unix() {
        use std::os::unix::fs::PermissionsExt;

        let temp_dir = TempDir::new("auth-storage-file").unwrap();
        let auth_path = temp_dir.path().join("nested").join("auth.json");
        let _auth_storage = auth_storage_with_empty_env(
            FileAuthStorageBackend::new(auth_path.clone()),
            AuthStorageOptions::default(),
        );

        assert_eq!(fs::read_to_string(&auth_path).unwrap(), "{}");
        let mode = fs::metadata(&auth_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
