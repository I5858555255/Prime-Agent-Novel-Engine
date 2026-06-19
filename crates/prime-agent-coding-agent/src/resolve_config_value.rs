use std::collections::HashMap;
use std::env;
use std::error::Error;
use std::fmt;
use std::io;
use std::process::{Command, Output, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use crate::shell::get_shell_config;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);

fn command_result_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static COMMAND_RESULT_CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    COMMAND_RESULT_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveConfigValueError {
    message: String,
}

impl ResolveConfigValueError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for ResolveConfigValueError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for ResolveConfigValueError {}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ConfiguredShellResult {
    executed: bool,
    value: Option<String>,
}

pub struct ConfigValueResolver<EnvResolver, CommandResolver> {
    env_resolver: EnvResolver,
    command_resolver: CommandResolver,
    command_result_cache: HashMap<String, Option<String>>,
}

impl<EnvResolver, CommandResolver> ConfigValueResolver<EnvResolver, CommandResolver>
where
    EnvResolver: FnMut(&str) -> Option<String>,
    CommandResolver: FnMut(&str) -> Option<String>,
{
    pub fn new(env_resolver: EnvResolver, command_resolver: CommandResolver) -> Self {
        Self {
            env_resolver,
            command_resolver,
            command_result_cache: HashMap::new(),
        }
    }

    pub fn resolve_config_value(&mut self, config: &str) -> Option<String> {
        if config.starts_with('!') {
            return self.execute_command(config);
        }

        self.resolve_literal_or_env(config)
    }

    pub fn resolve_config_value_uncached(&mut self, config: &str) -> Option<String> {
        if config.starts_with('!') {
            return self.execute_command_uncached(config);
        }

        self.resolve_literal_or_env(config)
    }

    pub fn resolve_config_value_or_throw(
        &mut self,
        config: &str,
        description: &str,
    ) -> Result<String, ResolveConfigValueError> {
        if let Some(resolved_value) = self.resolve_config_value_uncached(config) {
            return Ok(resolved_value);
        }

        if let Some(command) = config.strip_prefix('!') {
            return Err(ResolveConfigValueError::new(format!(
                "Failed to resolve {description} from shell command: {command}"
            )));
        }

        Err(ResolveConfigValueError::new(format!(
            "Failed to resolve {description}"
        )))
    }

    pub fn resolve_headers(
        &mut self,
        headers: Option<&HashMap<String, String>>,
    ) -> Option<HashMap<String, String>> {
        let headers = headers?;
        let mut resolved = HashMap::new();

        for (key, value) in headers {
            if let Some(resolved_value) = self.resolve_config_value(value)
                && !resolved_value.is_empty()
            {
                resolved.insert(key.clone(), resolved_value);
            }
        }

        if resolved.is_empty() {
            None
        } else {
            Some(resolved)
        }
    }

    pub fn resolve_headers_or_throw(
        &mut self,
        headers: Option<&HashMap<String, String>>,
        description: &str,
    ) -> Result<Option<HashMap<String, String>>, ResolveConfigValueError> {
        let Some(headers) = headers else {
            return Ok(None);
        };
        let mut resolved = HashMap::new();

        for (key, value) in headers {
            let resolved_value = self
                .resolve_config_value_or_throw(value, &format!("{description} header \"{key}\""))?;
            resolved.insert(key.clone(), resolved_value);
        }

        if resolved.is_empty() {
            Ok(None)
        } else {
            Ok(Some(resolved))
        }
    }

    pub fn clear_config_value_cache(&mut self) {
        self.command_result_cache.clear();
    }

    fn resolve_literal_or_env(&mut self, config: &str) -> Option<String> {
        (self.env_resolver)(config)
            .filter(|value| !value.is_empty())
            .or_else(|| Some(config.to_owned()))
    }

    fn execute_command(&mut self, command_config: &str) -> Option<String> {
        if let Some(cached) = self.command_result_cache.get(command_config) {
            return cached.clone();
        }

        let result = self.execute_command_uncached(command_config);
        self.command_result_cache
            .insert(command_config.to_owned(), result.clone());
        result
    }

    fn execute_command_uncached(&mut self, command_config: &str) -> Option<String> {
        let command = command_config.strip_prefix('!').unwrap_or(command_config);
        (self.command_resolver)(command).filter(|value| !value.is_empty())
    }
}

pub fn resolve_config_value(config: &str) -> Option<String> {
    if config.starts_with('!') {
        return execute_command(config);
    }

    resolve_literal_or_env(config)
}

pub fn resolve_config_value_uncached(config: &str) -> Option<String> {
    if config.starts_with('!') {
        return execute_command_uncached(config);
    }

    resolve_literal_or_env(config)
}

pub fn resolve_config_value_or_throw(
    config: &str,
    description: &str,
) -> Result<String, ResolveConfigValueError> {
    if let Some(resolved_value) = resolve_config_value_uncached(config) {
        return Ok(resolved_value);
    }

    if let Some(command) = config.strip_prefix('!') {
        return Err(ResolveConfigValueError::new(format!(
            "Failed to resolve {description} from shell command: {command}"
        )));
    }

    Err(ResolveConfigValueError::new(format!(
        "Failed to resolve {description}"
    )))
}

pub fn resolve_headers(
    headers: Option<&HashMap<String, String>>,
) -> Option<HashMap<String, String>> {
    let headers = headers?;
    let mut resolved = HashMap::new();

    for (key, value) in headers {
        if let Some(resolved_value) = resolve_config_value(value)
            && !resolved_value.is_empty()
        {
            resolved.insert(key.clone(), resolved_value);
        }
    }

    if resolved.is_empty() {
        None
    } else {
        Some(resolved)
    }
}

pub fn resolve_headers_or_throw(
    headers: Option<&HashMap<String, String>>,
    description: &str,
) -> Result<Option<HashMap<String, String>>, ResolveConfigValueError> {
    let Some(headers) = headers else {
        return Ok(None);
    };
    let mut resolved = HashMap::new();

    for (key, value) in headers {
        let resolved_value =
            resolve_config_value_or_throw(value, &format!("{description} header \"{key}\""))?;
        resolved.insert(key.clone(), resolved_value);
    }

    if resolved.is_empty() {
        Ok(None)
    } else {
        Ok(Some(resolved))
    }
}

pub fn clear_config_value_cache() {
    command_result_cache()
        .lock()
        .expect("config value command cache lock poisoned")
        .clear();
}

fn resolve_literal_or_env(config: &str) -> Option<String> {
    env::var(config)
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| Some(config.to_owned()))
}

fn execute_command(command_config: &str) -> Option<String> {
    {
        let cache = command_result_cache()
            .lock()
            .expect("config value command cache lock poisoned");

        if let Some(cached) = cache.get(command_config) {
            return cached.clone();
        }
    }

    let result = execute_command_uncached(command_config);
    let mut cache = command_result_cache()
        .lock()
        .expect("config value command cache lock poisoned");
    cache.insert(command_config.to_owned(), result.clone());
    result
}

fn execute_command_uncached(command_config: &str) -> Option<String> {
    let command = command_config.strip_prefix('!').unwrap_or(command_config);

    if cfg!(windows) {
        let configured_result = execute_with_configured_shell(command);
        if configured_result.executed {
            return configured_result.value;
        }
    }

    execute_with_default_shell(command)
}

fn execute_with_configured_shell(command: &str) -> ConfiguredShellResult {
    let Ok(shell_config) = get_shell_config(None) else {
        return ConfiguredShellResult {
            executed: false,
            value: None,
        };
    };

    let mut process = Command::new(shell_config.shell);
    process
        .args(shell_config.args)
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    match output_with_timeout(&mut process, COMMAND_TIMEOUT) {
        Ok(Some(output)) if output.status.success() => ConfiguredShellResult {
            executed: true,
            value: trim_stdout(output.stdout),
        },
        Ok(Some(_)) | Ok(None) => ConfiguredShellResult {
            executed: true,
            value: None,
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ConfiguredShellResult {
            executed: false,
            value: None,
        },
        Err(_) => ConfiguredShellResult {
            executed: true,
            value: None,
        },
    }
}

fn execute_with_default_shell(command: &str) -> Option<String> {
    let mut process = if cfg!(windows) {
        let mut process = Command::new("cmd");
        process.args(["/C", command]);
        process
    } else {
        let mut process = Command::new("sh");
        process.args(["-c", command]);
        process
    };

    process
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let output = output_with_timeout(&mut process, COMMAND_TIMEOUT).ok()??;

    if !output.status.success() {
        return None;
    }

    trim_stdout(output.stdout)
}

fn output_with_timeout(command: &mut Command, timeout: Duration) -> io::Result<Option<Output>> {
    let mut child = command.spawn()?;
    let started_at = Instant::now();

    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output().map(Some);
        }

        if started_at.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }

        thread::sleep(Duration::from_millis(10));
    }
}

fn trim_stdout(stdout: Vec<u8>) -> Option<String> {
    let value = String::from_utf8_lossy(&stdout).trim().to_owned();
    if value.is_empty() { None } else { Some(value) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    fn test_resolver(
        env_values: HashMap<String, String>,
        command_values: HashMap<String, Option<String>>,
    ) -> ConfigValueResolver<impl FnMut(&str) -> Option<String>, impl FnMut(&str) -> Option<String>>
    {
        ConfigValueResolver::new(
            move |key| env_values.get(key).cloned(),
            move |command| command_values.get(command).cloned().flatten(),
        )
    }

    #[test]
    fn resolves_env_value_before_literal() {
        let mut resolver = test_resolver(
            HashMap::from([("API_KEY".to_owned(), "secret".to_owned())]),
            HashMap::new(),
        );

        assert_eq!(
            resolver.resolve_config_value("API_KEY"),
            Some("secret".to_owned())
        );
    }

    #[test]
    fn resolves_literal_when_env_value_is_missing_or_empty() {
        let mut resolver = test_resolver(
            HashMap::from([("EMPTY".to_owned(), "".to_owned())]),
            HashMap::new(),
        );

        assert_eq!(
            resolver.resolve_config_value("MISSING"),
            Some("MISSING".to_owned())
        );
        assert_eq!(
            resolver.resolve_config_value("EMPTY"),
            Some("EMPTY".to_owned())
        );
    }

    #[test]
    fn caches_command_resolution_in_cached_path() {
        let calls = Rc::new(Cell::new(0));
        let command_calls = Rc::clone(&calls);
        let mut resolver = ConfigValueResolver::new(
            |_| None,
            move |command| {
                command_calls.set(command_calls.get() + 1);
                Some(format!("value:{command}"))
            },
        );

        assert_eq!(
            resolver.resolve_config_value("!fetch-token"),
            Some("value:fetch-token".to_owned())
        );
        assert_eq!(
            resolver.resolve_config_value("!fetch-token"),
            Some("value:fetch-token".to_owned())
        );
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn uncached_command_resolution_bypasses_cache() {
        let calls = Rc::new(Cell::new(0));
        let command_calls = Rc::clone(&calls);
        let mut resolver = ConfigValueResolver::new(
            |_| None,
            move |_| {
                command_calls.set(command_calls.get() + 1);
                Some(format!("value-{}", command_calls.get()))
            },
        );

        assert_eq!(
            resolver.resolve_config_value("!token"),
            Some("value-1".to_owned())
        );
        assert_eq!(
            resolver.resolve_config_value_uncached("!token"),
            Some("value-2".to_owned())
        );
        assert_eq!(
            resolver.resolve_config_value("!token"),
            Some("value-1".to_owned())
        );
    }

    #[test]
    fn clear_cache_forces_command_to_run_again() {
        let calls = Rc::new(Cell::new(0));
        let command_calls = Rc::clone(&calls);
        let mut resolver = ConfigValueResolver::new(
            |_| None,
            move |_| {
                command_calls.set(command_calls.get() + 1);
                Some(format!("value-{}", command_calls.get()))
            },
        );

        assert_eq!(
            resolver.resolve_config_value("!token"),
            Some("value-1".to_owned())
        );
        resolver.clear_config_value_cache();
        assert_eq!(
            resolver.resolve_config_value("!token"),
            Some("value-2".to_owned())
        );
    }

    #[test]
    fn caches_failed_command_resolution() {
        let calls = Rc::new(Cell::new(0));
        let command_calls = Rc::clone(&calls);
        let mut resolver = ConfigValueResolver::new(
            |_| None,
            move |_| {
                command_calls.set(command_calls.get() + 1);
                if command_calls.get() == 1 {
                    None
                } else {
                    Some("later".to_owned())
                }
            },
        );

        assert_eq!(resolver.resolve_config_value("!token"), None);
        assert_eq!(resolver.resolve_config_value("!token"), None);
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn resolve_headers_skips_unresolved_and_empty_values() {
        let mut resolver = test_resolver(
            HashMap::from([("ENV".to_owned(), "env-value".to_owned())]),
            HashMap::from([
                ("missing".to_owned(), None),
                ("empty".to_owned(), Some("".to_owned())),
            ]),
        );
        let headers = HashMap::from([
            ("x-env".to_owned(), "ENV".to_owned()),
            ("x-command".to_owned(), "!missing".to_owned()),
            ("x-empty".to_owned(), "!empty".to_owned()),
        ]);

        assert_eq!(
            resolver.resolve_headers(Some(&headers)),
            Some(HashMap::from([(
                "x-env".to_owned(),
                "env-value".to_owned()
            )]))
        );
        assert_eq!(resolver.resolve_headers(None), None);
    }

    #[test]
    fn resolve_headers_returns_none_when_all_values_are_omitted() {
        let mut resolver = test_resolver(
            HashMap::new(),
            HashMap::from([("missing".to_owned(), None)]),
        );
        let headers = HashMap::from([("x-command".to_owned(), "!missing".to_owned())]);

        assert_eq!(resolver.resolve_headers(Some(&headers)), None);
    }

    #[test]
    fn resolve_value_or_throw_uses_uncached_resolution() {
        let calls = Rc::new(Cell::new(0));
        let command_calls = Rc::clone(&calls);
        let mut resolver = ConfigValueResolver::new(
            |_| None,
            move |_| {
                command_calls.set(command_calls.get() + 1);
                Some(format!("value-{}", command_calls.get()))
            },
        );

        assert_eq!(
            resolver.resolve_config_value("!token"),
            Some("value-1".to_owned())
        );
        assert_eq!(
            resolver
                .resolve_config_value_or_throw("!token", "API key")
                .unwrap(),
            "value-2"
        );
    }

    #[test]
    fn resolve_value_or_throw_reports_command_failures() {
        let mut resolver = test_resolver(HashMap::new(), HashMap::from([("bad".to_owned(), None)]));

        let error = resolver
            .resolve_config_value_or_throw("!bad", "API key")
            .unwrap_err();

        assert_eq!(
            error.to_string(),
            "Failed to resolve API key from shell command: bad"
        );
    }

    #[test]
    fn resolve_headers_or_throw_resolves_all_values() {
        let mut resolver = test_resolver(
            HashMap::from([("TOKEN".to_owned(), "env-token".to_owned())]),
            HashMap::from([("header-token".to_owned(), Some("command-token".to_owned()))]),
        );
        let headers = HashMap::from([
            ("authorization".to_owned(), "TOKEN".to_owned()),
            ("x-command".to_owned(), "!header-token".to_owned()),
        ]);

        assert_eq!(
            resolver
                .resolve_headers_or_throw(Some(&headers), "provider")
                .unwrap(),
            Some(HashMap::from([
                ("authorization".to_owned(), "env-token".to_owned()),
                ("x-command".to_owned(), "command-token".to_owned()),
            ]))
        );
    }

    #[test]
    fn resolve_headers_or_throw_annotates_header_errors() {
        let mut resolver = test_resolver(HashMap::new(), HashMap::from([("bad".to_owned(), None)]));
        let headers = HashMap::from([("authorization".to_owned(), "!bad".to_owned())]);

        let error = resolver
            .resolve_headers_or_throw(Some(&headers), "provider")
            .unwrap_err();

        assert_eq!(
            error.to_string(),
            "Failed to resolve provider header \"authorization\" from shell command: bad"
        );
    }
}
