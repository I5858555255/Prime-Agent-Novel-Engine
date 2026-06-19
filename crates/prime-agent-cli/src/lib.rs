use std::env;
use std::fs;
use std::path::Path;

use prime_agent_ai::{
    Model, ModelInput, ModelPricing, ModelRegistry, get_env_api_key, get_supported_thinking_levels,
};
use prime_agent_coding_agent::{
    Args, DiagnosticType, ListModels, Mode, format_no_api_key_found_message_with_docs_path,
    format_no_model_selected_message_with_docs_path, parse_args, resolve_model_scope_from_models,
    serialize_json_line,
};
use serde_json::json;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_DOCS_PATH: &str = "docs";
const FAUX_PROVIDER: &str = "faux-rust";
const FAUX_MODEL_ID: &str = "faux-rust-model";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl CliOutput {
    fn ok(stdout: impl Into<String>) -> Self {
        Self {
            exit_code: 0,
            stdout: stdout.into(),
            stderr: String::new(),
        }
    }

    fn err(stderr: impl Into<String>) -> Self {
        Self {
            exit_code: 1,
            stdout: String::new(),
            stderr: ensure_trailing_newline(stderr.into()),
        }
    }
}

pub fn run_from_env() -> CliOutput {
    run(env::args().skip(1))
}

pub fn run<I, S>(argv: I) -> CliOutput
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let argv = argv.into_iter().map(Into::into).collect::<Vec<_>>();

    if argv.first().is_some_and(|arg| arg == "daemon") {
        return run_daemon_command(&argv[1..]);
    }

    let args = parse_args(argv);
    let warnings = args
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.kind == DiagnosticType::Warning)
        .map(|diagnostic| diagnostic.message.as_str())
        .collect::<Vec<_>>();
    let errors = args
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.kind == DiagnosticType::Error)
        .map(|diagnostic| diagnostic.message.as_str())
        .collect::<Vec<_>>();

    if !errors.is_empty() {
        return CliOutput::err(errors.join("\n"));
    }

    if args.help == Some(true) {
        return CliOutput {
            exit_code: 0,
            stdout: help_text(),
            stderr: warning_text(&warnings),
        };
    }

    if args.version == Some(true) {
        return CliOutput {
            exit_code: 0,
            stdout: format!("{VERSION}\n"),
            stderr: warning_text(&warnings),
        };
    }

    if let Some(list_models) = &args.list_models {
        return CliOutput {
            exit_code: 0,
            stdout: list_models_text(list_models, &bundled_models()),
            stderr: warning_text(&warnings),
        };
    }

    if args.print == Some(true) {
        return match run_print(&args) {
            Ok(stdout) => CliOutput {
                exit_code: 0,
                stdout,
                stderr: warning_text(&warnings),
            },
            Err(message) => CliOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: ensure_trailing_newline(join_warning_and_error(&warnings, &message)),
            },
        };
    }

    CliOutput {
        exit_code: 1,
        stdout: String::new(),
        stderr: ensure_trailing_newline(join_warning_and_error(
            &warnings,
            "Interactive TUI mode is not implemented in the native Rust CLI yet. Use -p/--print for the ported native execution path.",
        )),
    }
}

fn run_daemon_command(args: &[String]) -> CliOutput {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        return CliOutput::ok(daemon_help_text());
    }

    CliOutput::err(
        "Native Rust daemon commands are not implemented yet. This binary does not delegate to the TypeScript daemon.",
    )
}

fn run_print(args: &Args) -> Result<String, String> {
    let models = bundled_models();
    let Some(model) = select_model(args, &models)? else {
        return Err(format_no_model_selected_message_with_docs_path(
            DEFAULT_DOCS_PATH,
        ));
    };

    let prompt = read_prompt(args)?;
    if prompt.trim().is_empty() {
        return Err(
            "No prompt provided. Pass a prompt after -p/--print or as a positional argument."
                .to_string(),
        );
    }

    if model.provider != FAUX_PROVIDER {
        if args.offline == Some(true) {
            return Err(format!(
                "Provider {} is unavailable in --offline mode. Use --provider {FAUX_PROVIDER} --model {FAUX_MODEL_ID} for a native offline smoke test.",
                model.provider
            ));
        }

        let has_api_key = args
            .api_key
            .as_deref()
            .is_some_and(|key| !key.trim().is_empty())
            || (args.no_env != Some(true) && get_env_api_key(&model.provider).is_some());
        if !has_api_key {
            return Err(format_no_api_key_found_message_with_docs_path(
                &model.provider,
                DEFAULT_DOCS_PATH,
            ));
        }

        return Err(format!(
            "Native Rust provider streaming is not implemented yet for {}. This binary did not fall back to TypeScript.",
            model.provider
        ));
    }

    let response = faux_response(&prompt);
    match args.mode.unwrap_or(Mode::Text) {
        Mode::Text | Mode::Daemon => Ok(format!("{response}\n")),
        Mode::Json | Mode::Rpc => jsonl_response(args, model, &prompt, &response),
    }
}

fn select_model<'a>(args: &Args, models: &'a [Model]) -> Result<Option<&'a Model>, String> {
    let Some(model_pattern) = args
        .model
        .as_deref()
        .or_else(|| (args.provider.as_deref() == Some(FAUX_PROVIDER)).then_some(FAUX_MODEL_ID))
        .or_else(|| {
            args.models
                .as_ref()
                .and_then(|patterns| patterns.iter().find(|pattern| !pattern.trim().is_empty()))
                .map(String::as_str)
        })
    else {
        return Ok(None);
    };

    let pattern = if let Some(provider) = args.provider.as_deref() {
        if model_pattern.contains('/') {
            model_pattern.to_string()
        } else {
            format!("{provider}/{model_pattern}")
        }
    } else {
        model_pattern.to_string()
    };

    let resolved = resolve_model_scope_from_models(&[pattern.as_str()], models);
    if let Some(warning) = resolved.warnings.first() {
        return Err(warning.clone());
    }

    Ok(resolved.scoped_models.first().map(|scoped| scoped.model))
}

fn read_prompt(args: &Args) -> Result<String, String> {
    let mut parts = args.messages.clone();
    for file_arg in &args.file_args {
        let path = Path::new(file_arg);
        let content = fs::read_to_string(path)
            .map_err(|error| format!("Failed to read @{}: {error}", path.display()))?;
        parts.push(content);
    }
    Ok(parts.join("\n"))
}

fn faux_response(prompt: &str) -> String {
    format!("faux-rust-ok: {}", prompt.trim())
}

fn jsonl_response(
    args: &Args,
    model: &Model,
    prompt: &str,
    response: &str,
) -> Result<String, String> {
    let records = [
        json!({
            "type": "agent_start",
            "mode": args.mode.unwrap_or(Mode::Json).as_str(),
            "model": {
                "provider": model.provider,
                "id": model.id,
                "api": model.api,
            },
        }),
        json!({
            "type": "message",
            "role": "user",
            "content": prompt,
        }),
        json!({
            "type": "message",
            "role": "assistant",
            "content": response,
        }),
        json!({
            "type": "agent_end",
            "stopReason": "end_turn",
        }),
    ];

    let mut output = String::new();
    for record in records {
        output.push_str(
            &serialize_json_line(&record)
                .map_err(|error| format!("Failed to serialize JSONL output: {error}"))?,
        );
    }
    Ok(output)
}

fn list_models_text(list_models: &ListModels, models: &[Model]) -> String {
    let query = match list_models {
        ListModels::All(_) => None,
        ListModels::Search(query) => Some(query.to_lowercase()),
    };

    let lines = models
        .iter()
        .filter(|model| {
            query.as_ref().is_none_or(|query| {
                format!("{}/{} {}", model.provider, model.id, model.name)
                    .to_lowercase()
                    .contains(query)
            })
        })
        .map(|model| {
            let thinking = get_supported_thinking_levels(model)
                .into_iter()
                .map(|level| level.as_str())
                .collect::<Vec<_>>()
                .join(",");
            format!(
                "{}/{}\t{}\tapi={}\tcontext={}\tthinking={}",
                model.provider, model.id, model.name, model.api, model.context_window, thinking
            )
        })
        .collect::<Vec<_>>();

    if lines.is_empty() {
        "No models found.\n".to_string()
    } else {
        format!("{}\n", lines.join("\n"))
    }
}

fn bundled_models() -> Vec<Model> {
    let mut registry = ModelRegistry::new();
    registry.insert_provider(
        FAUX_PROVIDER,
        vec![model(
            FAUX_PROVIDER,
            FAUX_MODEL_ID,
            "Faux Rust Model",
            "faux",
            false,
            128_000,
            4_096,
        )],
    );
    registry.insert_provider(
        "prime-inference",
        vec![model(
            "prime-inference",
            "z-ai/glm-5.1",
            "GLM 5.1",
            "openai-compatible",
            true,
            128_000,
            16_384,
        )],
    );
    registry.insert_provider(
        "openai",
        vec![
            model(
                "openai",
                "gpt-5.2",
                "GPT-5.2",
                "openai-responses",
                true,
                400_000,
                128_000,
            ),
            model(
                "openai",
                "gpt-4o",
                "GPT-4o",
                "openai-responses",
                false,
                128_000,
                16_384,
            ),
        ],
    );
    registry.insert_provider(
        "anthropic",
        vec![model(
            "anthropic",
            "claude-sonnet-4.5",
            "Claude Sonnet 4.5",
            "anthropic",
            true,
            200_000,
            64_000,
        )],
    );
    registry.insert_provider(
        "google",
        vec![model(
            "google",
            "gemini-2.5-pro",
            "Gemini 2.5 Pro",
            "google",
            true,
            1_000_000,
            64_000,
        )],
    );

    registry
        .get_providers()
        .into_iter()
        .flat_map(|provider| registry.get_models(provider).into_iter().cloned())
        .collect()
}

fn model(
    provider: &str,
    id: &str,
    name: &str,
    api: &str,
    reasoning: bool,
    context_window: u64,
    max_tokens: u64,
) -> Model {
    Model {
        id: id.to_string(),
        name: name.to_string(),
        api: api.to_string(),
        provider: provider.to_string(),
        base_url: String::new(),
        reasoning,
        thinking_level_map: None,
        input: vec![ModelInput::Text],
        cost: ModelPricing::default(),
        context_window,
        max_tokens,
        headers: None,
        compat: None,
    }
}

fn help_text() -> String {
    format!(
        "prime-agent-rust {VERSION}\n\nUSAGE:\n  prime-agent-rust [OPTIONS] [-p <PROMPT>] [@file ...]\n  prime-agent-rust daemon --help\n\nOPTIONS:\n  -h, --help                 Show this help\n  -v, --version              Show version\n  -p, --print <PROMPT>       Run one native print-mode turn\n      --mode <text|json|rpc> Output mode for print turns\n      --provider <NAME>      Select provider\n      --model <MODEL>        Select model id or provider/model\n      --models <PATTERNS>    Accepted for CLI parity; print mode uses --model\n      --thinking <LEVEL>     off|minimal|low|medium|high|xhigh\n      --list-models [QUERY]  List bundled native model metadata\n      --offline              Disallow remote providers\n      --no-env               Do not read provider API keys from the environment\n      --no-session           Accepted for CLI parity\n      --no-tools             Accepted for CLI parity\n\nNATIVE SMOKE TEST:\n  prime-agent-rust --provider {FAUX_PROVIDER} --model {FAUX_MODEL_ID} --no-session --no-tools -p \"hello\"\n"
    )
}

fn daemon_help_text() -> String {
    "prime-agent-rust daemon\n\nUSAGE:\n  prime-agent-rust daemon --help\n\nNative Rust daemon commands are not implemented yet and this binary does not delegate to TypeScript.\n".to_string()
}

fn warning_text(warnings: &[&str]) -> String {
    if warnings.is_empty() {
        String::new()
    } else {
        ensure_trailing_newline(warnings.join("\n"))
    }
}

fn join_warning_and_error(warnings: &[&str], error: &str) -> String {
    if warnings.is_empty() {
        error.to_string()
    } else {
        format!("{}\n{error}", warnings.join("\n"))
    }
}

fn ensure_trailing_newline(mut value: String) -> String {
    if !value.ends_with('\n') {
        value.push('\n');
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_prints_workspace_version() {
        let output = run(["--version"]);

        assert_eq!(output.exit_code, 0);
        assert_eq!(output.stdout, "0.1.7\n");
        assert!(output.stderr.is_empty());
    }

    #[test]
    fn list_models_supports_search() {
        let output = run(["--list-models", "faux"]);

        assert_eq!(output.exit_code, 0);
        assert!(output.stdout.contains("faux-rust/faux-rust-model"));
        assert!(!output.stdout.contains("openai/gpt-4o"));
    }

    #[test]
    fn print_text_mode_uses_native_faux_provider() {
        let output = run([
            "--provider",
            "faux-rust",
            "--model",
            "faux-rust-model",
            "--no-session",
            "--no-tools",
            "-p",
            "hello",
        ]);

        assert_eq!(output.exit_code, 0);
        assert_eq!(output.stdout, "faux-rust-ok: hello\n");
        assert!(output.stderr.is_empty());
    }

    #[test]
    fn print_json_mode_emits_jsonl() {
        let output = run([
            "--provider",
            "faux-rust",
            "--model",
            "faux-rust-model",
            "--mode",
            "json",
            "-p",
            "hello",
        ]);

        assert_eq!(output.exit_code, 0);
        let lines = output.stdout.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 4);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(lines[2]).unwrap()["content"],
            "faux-rust-ok: hello"
        );
    }

    #[test]
    fn no_env_prevents_remote_provider_key_lookup() {
        let output = run([
            "--provider",
            "openai",
            "--model",
            "gpt-4o",
            "--no-env",
            "-p",
            "hello",
        ]);

        assert_eq!(output.exit_code, 1);
        assert!(output.stderr.contains("No API key found for openai."));
    }

    #[test]
    fn print_mode_accepts_models_scope_for_cli_parity() {
        let output = run([
            "--models",
            "faux-rust/*",
            "--no-session",
            "--no-tools",
            "-p",
            "hello",
        ]);

        assert_eq!(output.exit_code, 0);
        assert_eq!(output.stdout, "faux-rust-ok: hello\n");
    }

    #[test]
    fn daemon_help_does_not_delegate_to_typescript() {
        let output = run(["daemon", "--help"]);

        assert_eq!(output.exit_code, 0);
        assert!(output.stdout.contains("does not delegate to TypeScript"));
    }
}
