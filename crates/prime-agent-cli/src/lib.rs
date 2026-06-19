use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{self, BufRead, IsTerminal, Read, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use prime_agent_ai::{
    ContentBlock, Context, Message, Model, ModelInput, ModelPricing, ModelRegistry,
    SimpleStreamOptions, StreamOptions, UserContent, UserMessage, complete_simple,
    get_supported_thinking_levels,
};
use prime_agent_coding_agent::{
    Args, AuthStorage, DiagnosticType, ListModels, Mode,
    format_no_api_key_found_message_with_docs_path,
    format_no_model_selected_message_with_docs_path, parse_args, resolve_model_scope_from_models,
    serialize_json_line,
};
use prime_agent_tui::{
    DISABLE_BRACKETED_PASTE_SEQUENCE, ENABLE_BRACKETED_PASTE_SEQUENCE, INPUT_CURSOR_MARKER, Input,
    InputEvent, StdinBuffer, StdinEvent, TerminalDimensions, TerminalSizeInputs,
    clear_screen_sequence, hide_cursor_sequence, resolve_terminal_dimensions, set_title_sequence,
    show_cursor_sequence, truncate_to_width, visible_width,
};
use serde_json::json;

#[cfg(unix)]
use std::os::fd::AsRawFd;

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

pub fn run_tui_from_stdio() -> i32 {
    let stdin = io::stdin();
    let stdout = io::stdout();
    if stdin.is_terminal() && stdout.is_terminal() {
        return match run_tui(stdin, stdout) {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("prime-agent-rust TUI error: {error}");
                1
            }
        };
    }

    run_interactive_from_stdio()
}

pub fn run_interactive_from_stdio() -> i32 {
    match run_interactive(io::stdin().lock(), io::stdout().lock()) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("prime-agent-rust interactive error: {error}");
            1
        }
    }
}

pub fn run_tui(mut stdin: io::Stdin, mut stdout: io::Stdout) -> io::Result<()> {
    #[cfg(unix)]
    let stdout_fd = Some(stdout.as_raw_fd());
    #[cfg(not(unix))]
    let stdout_fd = None;

    let raw_mode = RawModeGuard::enable(&stdin)?;
    write!(
        stdout,
        "{}{}{}{}",
        set_title_sequence("prime-agent-rust"),
        ENABLE_BRACKETED_PASTE_SEQUENCE,
        hide_cursor_sequence(),
        clear_screen_sequence()
    )?;
    stdout.flush()?;

    let result = run_tui_loop(&mut stdin, &mut stdout, || terminal_dimensions(stdout_fd));

    write!(
        stdout,
        "{}{}{}{}",
        DISABLE_BRACKETED_PASTE_SEQUENCE,
        show_cursor_sequence(),
        clear_screen_sequence(),
        set_title_sequence("prime-agent-rust")
    )?;
    stdout.flush()?;
    drop(raw_mode);

    result
}

fn run_tui_loop<R, W>(
    input_reader: &mut R,
    output: &mut W,
    mut dimensions: impl FnMut() -> TerminalDimensions,
) -> io::Result<()>
where
    R: Read,
    W: Write,
{
    let models = bundled_models();
    let mut selected_model = default_interactive_model(&models)
        .expect("bundled faux model should always be available")
        .clone();
    let mut transcript = vec![TranscriptLine::system(format!(
        "Native Rust TUI ready. Model {}/{}.",
        selected_model.provider, selected_model.id
    ))];
    let mut input = Input::with_placeholder("send a prompt or type /help");
    input.set_prompt("> ");
    input.set_focused(true);
    let mut stdin_buffer = StdinBuffer::new();
    render_tui_frame(output, dimensions(), &selected_model, &transcript, &input)?;

    let mut buffer = [0_u8; 256];
    loop {
        let count = input_reader.read(&mut buffer)?;
        if count == 0 {
            return Ok(());
        }

        let events = stdin_buffer.process_bytes(&buffer[..count]);
        for event in events {
            let data = match event {
                StdinEvent::Data(data) => data,
                StdinEvent::Paste(paste) => {
                    format!("\x1b[200~{paste}\x1b[201~")
                }
            };

            if data == "\u{3}" || (data == "\u{4}" && input.value().is_empty()) {
                transcript.push(TranscriptLine::system("Exiting."));
                render_tui_frame(output, dimensions(), &selected_model, &transcript, &input)?;
                return Ok(());
            }

            for input_event in input.handle_input(&data) {
                match input_event {
                    InputEvent::Changed(_) => {}
                    InputEvent::Cancelled => {
                        transcript.push(TranscriptLine::system("Exiting."));
                        render_tui_frame(
                            output,
                            dimensions(),
                            &selected_model,
                            &transcript,
                            &input,
                        )?;
                        return Ok(());
                    }
                    InputEvent::Submitted(text) => {
                        let text = text.trim().to_string();
                        input.set_value("");
                        if text.is_empty() {
                            continue;
                        }
                        if handle_tui_submission(
                            &text,
                            &models,
                            &mut selected_model,
                            &mut transcript,
                        ) {
                            render_tui_frame(
                                output,
                                dimensions(),
                                &selected_model,
                                &transcript,
                                &input,
                            )?;
                            return Ok(());
                        }
                    }
                }
            }
        }

        render_tui_frame(output, dimensions(), &selected_model, &transcript, &input)?;
    }
}

pub fn run_interactive<R, W>(mut input: R, mut output: W) -> io::Result<()>
where
    R: BufRead,
    W: Write,
{
    let models = bundled_models();
    let mut selected_model = default_interactive_model(&models)
        .expect("bundled faux model should always be available")
        .clone();

    writeln!(output, "prime-agent-rust {VERSION}")?;
    writeln!(
        output,
        "model: {}/{}",
        selected_model.provider, selected_model.id
    )?;
    writeln!(
        output,
        "Type /help for commands, /models to list models, or /exit to quit."
    )?;

    loop {
        write!(output, "prime-agent-rust> ")?;
        output.flush()?;

        let mut line = String::new();
        if input.read_line(&mut line)? == 0 {
            writeln!(output)?;
            return Ok(());
        }

        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(command) = line.strip_prefix('/') {
            if handle_interactive_command(command, &models, &mut selected_model, &mut output)? {
                return Ok(());
            }
            continue;
        }

        match run_native_turn(&selected_model, line, false, None, true) {
            Ok(response) => writeln!(output, "assistant> {response}")?,
            Err(message) => writeln!(output, "{message}")?,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TranscriptLine {
    role: &'static str,
    text: String,
}

impl TranscriptLine {
    fn system(text: impl Into<String>) -> Self {
        Self {
            role: "system",
            text: text.into(),
        }
    }

    fn user(text: impl Into<String>) -> Self {
        Self {
            role: "user",
            text: text.into(),
        }
    }

    fn assistant(text: impl Into<String>) -> Self {
        Self {
            role: "assistant",
            text: text.into(),
        }
    }
}

fn handle_tui_submission(
    text: &str,
    models: &[Model],
    selected_model: &mut Model,
    transcript: &mut Vec<TranscriptLine>,
) -> bool {
    if let Some(command) = text.strip_prefix('/') {
        return handle_tui_command(command, models, selected_model, transcript);
    }

    transcript.push(TranscriptLine::user(text));
    match run_native_turn(selected_model, text, false, None, true) {
        Ok(response) => transcript.push(TranscriptLine::assistant(response)),
        Err(message) => transcript.push(TranscriptLine::system(message)),
    }
    false
}

fn handle_tui_command(
    command: &str,
    models: &[Model],
    selected_model: &mut Model,
    transcript: &mut Vec<TranscriptLine>,
) -> bool {
    let mut parts = command.splitn(2, char::is_whitespace);
    let name = parts.next().unwrap_or_default();
    let argument = parts.next().unwrap_or_default().trim();

    match name {
        "exit" | "quit" | "q" => {
            transcript.push(TranscriptLine::system("Exiting."));
            true
        }
        "help" | "h" => {
            transcript.push(TranscriptLine::system(
                "Commands: /help, /models [query], /model [pattern], /clear, /exit",
            ));
            false
        }
        "models" => {
            let list = if argument.is_empty() {
                ListModels::All(true)
            } else {
                ListModels::Search(argument.to_string())
            };
            for line in list_models_text(&list, models).lines() {
                transcript.push(TranscriptLine::system(line));
            }
            false
        }
        "model" => {
            if argument.is_empty() {
                transcript.push(TranscriptLine::system(format!(
                    "model: {}/{}",
                    selected_model.provider, selected_model.id
                )));
                return false;
            }

            match resolve_model_scope_from_models(&[argument], models)
                .scoped_models
                .first()
                .map(|scoped| scoped.model)
            {
                Some(model) => {
                    *selected_model = model.clone();
                    transcript.push(TranscriptLine::system(format!(
                        "model: {}/{}",
                        selected_model.provider, selected_model.id
                    )));
                }
                None => {
                    transcript.push(TranscriptLine::system(format!(
                        "No models match pattern \"{argument}\""
                    )));
                }
            }
            false
        }
        "clear" => {
            transcript.clear();
            transcript.push(TranscriptLine::system("Cleared."));
            false
        }
        _ => {
            transcript.push(TranscriptLine::system(format!("Unknown command: /{name}")));
            false
        }
    }
}

fn render_tui_frame<W>(
    output: &mut W,
    dimensions: TerminalDimensions,
    selected_model: &Model,
    transcript: &[TranscriptLine],
    input: &Input,
) -> io::Result<()>
where
    W: Write,
{
    let width = usize::from(dimensions.columns.max(20));
    let rows = usize::from(dimensions.rows.max(8));
    let input_lines = input
        .render(width)
        .into_iter()
        .map(|line| line.replace(INPUT_CURSOR_MARKER, ""))
        .collect::<Vec<_>>();
    let header = format!(
        " prime-agent-rust {VERSION}  {}/{} ",
        selected_model.provider, selected_model.id
    );
    let help = " /help /models /model /clear /exit ";
    let reserved_rows = 4 + input_lines.len();
    let transcript_rows = rows.saturating_sub(reserved_rows).max(1);

    let mut transcript_render_lines = Vec::new();
    for line in transcript {
        let prefix = match line.role {
            "user" => "you",
            "assistant" => "assistant",
            _ => "system",
        };
        for wrapped in wrap_plain(&format!("{prefix}> {}", line.text), width) {
            transcript_render_lines.push(wrapped);
        }
    }
    let start = transcript_render_lines
        .len()
        .saturating_sub(transcript_rows);

    write!(output, "{}", clear_screen_sequence())?;
    writeln!(output, "\x1b[7m{}\x1b[27m", pad_or_truncate(&header, width))?;
    writeln!(output, "{}", pad_or_truncate(help, width))?;
    writeln!(output, "{}", "-".repeat(width))?;

    let visible = &transcript_render_lines[start..];
    for line in visible {
        writeln!(output, "{}", pad_or_truncate(line, width))?;
    }
    for _ in visible.len()..transcript_rows {
        writeln!(output)?;
    }

    writeln!(output, "{}", "-".repeat(width))?;
    for line in input_lines {
        writeln!(output, "{}", pad_or_truncate(&line, width))?;
    }
    output.flush()
}

fn wrap_plain(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![String::new()];
    }

    let mut lines = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        let word_width = visible_width(word);
        let current_width = visible_width(&current);
        if current.is_empty() {
            current.push_str(word);
        } else if current_width + 1 + word_width <= width {
            current.push(' ');
            current.push_str(word);
        } else {
            lines.push(current);
            current = word.to_string();
        }
    }

    if current.is_empty() {
        lines.push(String::new());
    } else {
        lines.push(current);
    }
    lines
}

fn pad_or_truncate(text: &str, width: usize) -> String {
    let truncated = truncate_to_width(text, width, "", false);
    let padding = width.saturating_sub(visible_width(&truncated));
    format!("{truncated}{}", " ".repeat(padding))
}

fn terminal_dimensions(stdout_fd: Option<i32>) -> TerminalDimensions {
    let stdout_size = stdout_fd.and_then(terminal_size_from_fd);
    resolve_terminal_dimensions(TerminalSizeInputs {
        stdout_columns: stdout_size.map(|size| size.columns),
        stdout_rows: stdout_size.map(|size| size.rows),
        env_columns: env::var("COLUMNS").ok().as_deref(),
        env_lines: env::var("LINES").ok().as_deref(),
    })
}

#[cfg(unix)]
fn terminal_size_from_fd(fd: i32) -> Option<TerminalDimensions> {
    let mut size = libc::winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let result = unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut size) };
    (result == 0 && size.ws_col > 0 && size.ws_row > 0).then_some(TerminalDimensions {
        columns: size.ws_col,
        rows: size.ws_row,
    })
}

#[cfg(not(unix))]
fn terminal_size_from_fd(_: i32) -> Option<TerminalDimensions> {
    None
}

struct RawModeGuard {
    #[cfg(unix)]
    fd: i32,
    #[cfg(unix)]
    original: libc::termios,
}

impl RawModeGuard {
    fn enable(stdin: &io::Stdin) -> io::Result<Self> {
        #[cfg(unix)]
        {
            let fd = stdin.as_raw_fd();
            let mut original = unsafe { std::mem::zeroed::<libc::termios>() };
            if unsafe { libc::tcgetattr(fd, &mut original) } != 0 {
                return Err(io::Error::last_os_error());
            }
            let mut raw = original;
            unsafe {
                libc::cfmakeraw(&mut raw);
            }
            if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) } != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self { fd, original })
        }

        #[cfg(not(unix))]
        {
            let _ = stdin;
            Ok(Self {})
        }
    }
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            let _ = libc::tcsetattr(self.fd, libc::TCSANOW, &self.original);
        }
    }
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
        return CliOutput::err(join_warning_and_error(&warnings, &errors.join("\n")));
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

    if args.print == Some(true) || !args.messages.is_empty() || !args.file_args.is_empty() {
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
        stderr: ensure_trailing_newline(join_warning_and_error(&warnings, &help_text())),
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

    let response = run_native_turn(
        model,
        &prompt,
        args.offline == Some(true),
        args.api_key.as_deref(),
        args.no_env != Some(true),
    )?;
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
        .or_else(|| args.provider.is_none().then_some(FAUX_MODEL_ID))
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

fn find_model_or_default<'a>(pattern: &str, models: &'a [Model]) -> Option<&'a Model> {
    resolve_model_scope_from_models(&[pattern], models)
        .scoped_models
        .first()
        .map(|scoped| scoped.model)
}

fn default_interactive_model(models: &[Model]) -> Option<&Model> {
    let mut auth_storage = AuthStorage::create(None, None);
    models
        .iter()
        .find(|model| {
            model.provider != FAUX_PROVIDER
                && is_native_stream_model(model)
                && auth_storage.get_api_key(&model.provider).is_some()
        })
        .or_else(|| find_model_or_default(FAUX_MODEL_ID, models))
}

fn is_native_stream_model(model: &Model) -> bool {
    matches!(
        model.api.as_str(),
        "openai-completions" | "openai-responses"
    )
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

fn run_native_turn(
    model: &Model,
    prompt: &str,
    offline: bool,
    api_key: Option<&str>,
    allow_env: bool,
) -> Result<String, String> {
    if model.provider == FAUX_PROVIDER {
        return Ok(faux_response(prompt));
    }

    if offline {
        return Err(format!(
            "Provider {} is unavailable in --offline mode. Use /model {FAUX_PROVIDER}/{FAUX_MODEL_ID} for a native offline smoke test.",
            model.provider
        ));
    }

    let auth = resolve_auth(model, api_key, allow_env).ok_or_else(|| {
        format_no_api_key_found_message_with_docs_path(&model.provider, DEFAULT_DOCS_PATH)
    })?;
    let context = Context {
        system_prompt: None,
        messages: vec![Message::User(UserMessage {
            content: UserContent::Text(prompt.to_string()),
            timestamp: current_timestamp_millis(),
        })],
        tools: None,
    };
    let options = SimpleStreamOptions {
        stream: StreamOptions {
            api_key: Some(auth.api_key),
            headers: auth.headers,
            ..StreamOptions::default()
        },
        reasoning: None,
        thinking_budgets: None,
    };
    let message = complete_simple(model, &context, Some(&options))
        .map_err(|error| format!("Native Rust provider error for {}: {error}", model.provider))?;
    if let Some(error_message) = message.error_message {
        return Err(error_message);
    }
    let text = assistant_text(&message.content);
    if text.trim().is_empty() {
        Err(format!(
            "Native Rust provider returned no text for {}.",
            model.provider
        ))
    } else {
        Ok(text)
    }
}

struct NativeAuth {
    api_key: String,
    headers: Option<HashMap<String, String>>,
}

fn resolve_auth(
    model: &Model,
    explicit: Option<&str>,
    allow_auth_sources: bool,
) -> Option<NativeAuth> {
    if let Some(api_key) = explicit.filter(|api_key| !api_key.trim().is_empty()) {
        return Some(NativeAuth {
            api_key: api_key.to_string(),
            headers: None,
        });
    }

    if !allow_auth_sources {
        return None;
    }

    let mut auth_storage = AuthStorage::create(None, None);
    let api_key = auth_storage.get_api_key(&model.provider)?;
    let headers = auth_storage
        .get_provider_headers(&model.provider)
        .map(|headers| headers.into_iter().collect::<HashMap<_, _>>());
    Some(NativeAuth { api_key, headers })
}

fn assistant_text(content: &[ContentBlock]) -> String {
    content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn current_timestamp_millis() -> i64 {
    let Ok(duration) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return 0;
    };
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

fn handle_interactive_command<W>(
    command: &str,
    models: &[Model],
    selected_model: &mut Model,
    output: &mut W,
) -> io::Result<bool>
where
    W: Write,
{
    let mut parts = command.splitn(2, char::is_whitespace);
    let name = parts.next().unwrap_or_default();
    let argument = parts.next().unwrap_or_default().trim();

    match name {
        "exit" | "quit" | "q" => {
            writeln!(output, "bye")?;
            Ok(true)
        }
        "help" | "h" => {
            write!(output, "{}", interactive_help_text())?;
            Ok(false)
        }
        "models" => {
            let list = if argument.is_empty() {
                ListModels::All(true)
            } else {
                ListModels::Search(argument.to_string())
            };
            write!(output, "{}", list_models_text(&list, models))?;
            Ok(false)
        }
        "model" => {
            if argument.is_empty() {
                writeln!(
                    output,
                    "model: {}/{}",
                    selected_model.provider, selected_model.id
                )?;
                return Ok(false);
            }

            match resolve_model_scope_from_models(&[argument], models)
                .scoped_models
                .first()
                .map(|scoped| scoped.model)
            {
                Some(model) => {
                    *selected_model = model.clone();
                    writeln!(
                        output,
                        "model: {}/{}",
                        selected_model.provider, selected_model.id
                    )?;
                }
                None => {
                    writeln!(output, "No models match pattern \"{argument}\"")?;
                }
            }
            Ok(false)
        }
        "clear" => {
            writeln!(output, "cleared")?;
            Ok(false)
        }
        _ => {
            writeln!(output, "Unknown command: /{name}")?;
            Ok(false)
        }
    }
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
            "openai-completions",
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
        base_url: default_base_url(provider, api).to_string(),
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

fn default_base_url(provider: &str, api: &str) -> &'static str {
    match (provider, api) {
        ("prime-inference", "openai-completions") => "https://api.pinference.ai/api/v1",
        ("openai", "openai-completions" | "openai-responses") => "https://api.openai.com/v1",
        _ => "",
    }
}

fn help_text() -> String {
    format!(
        "prime-agent-rust {VERSION}\n\nUSAGE:\n  prime-agent-rust                         Start native interactive mode\n  prime-agent-rust [OPTIONS] [-p <PROMPT>] [@file ...]\n  prime-agent-rust daemon --help\n\nOPTIONS:\n  -h, --help                 Show this help\n  -v, --version              Show version\n  -p, --print <PROMPT>       Run one native print-mode turn\n      --mode <text|json|rpc> Output mode for print turns\n      --provider <NAME>      Select provider\n      --model <MODEL>        Select model id or provider/model\n      --models <PATTERNS>    Select model scope; first match is used in print mode\n      --thinking <LEVEL>     off|minimal|low|medium|high|xhigh\n      --list-models [QUERY]  List bundled native model metadata\n      --offline              Disallow remote providers\n      --no-env               Do not read stored or ambient provider API keys\n      --no-session           Accepted for CLI parity\n      --no-tools             Accepted for CLI parity\n\nNATIVE SMOKE TEST:\n  prime-agent-rust --provider {FAUX_PROVIDER} --model {FAUX_MODEL_ID} --no-session --no-tools -p \"hello\"\n"
    )
}

fn interactive_help_text() -> String {
    "commands:\n  /help              Show this help\n  /models [query]    List native bundled models\n  /model [pattern]   Show or select model\n  /clear             Clear native conversation state\n  /exit              Quit\n".to_string()
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
    fn interactive_mode_handles_prompt_model_listing_and_exit() {
        let mut output = Vec::new();

        run_interactive(
            "/model faux-rust/faux-rust-model\nhello\n/models faux\n/exit\n".as_bytes(),
            &mut output,
        )
        .unwrap();

        let output = String::from_utf8(output).unwrap();
        assert!(output.contains("prime-agent-rust 0.1.7"));
        assert!(output.contains("model: faux-rust/faux-rust-model"));
        assert!(output.contains("assistant> faux-rust-ok: hello"));
        assert!(output.contains("faux-rust/faux-rust-model"));
        assert!(output.contains("bye"));
    }

    #[test]
    fn interactive_model_command_reports_remote_provider_limit_without_typescript_fallback() {
        let mut output = Vec::new();

        run_interactive("/model openai/gpt-4o\n/exit\n".as_bytes(), &mut output).unwrap();

        let output = String::from_utf8(output).unwrap();
        assert!(output.contains("model: openai/gpt-4o"));
        assert!(output.contains("bye"));
    }

    #[test]
    fn tui_loop_renders_prompt_response_models_and_exit() {
        let mut input = std::io::Cursor::new(
            b"/model faux-rust/faux-rust-model\rhello\r/models faux\r/exit\r".to_vec(),
        );
        let mut output = Vec::new();

        run_tui_loop(&mut input, &mut output, || TerminalDimensions {
            columns: 80,
            rows: 20,
        })
        .unwrap();

        let output = String::from_utf8(output).unwrap();
        assert!(output.contains("prime-agent-rust 0.1.7"));
        assert!(output.contains("assistant> faux-rust-ok: hello"));
        assert!(output.contains("faux-rust/faux-rust-model"));
        assert!(output.contains("system> Exiting."));
    }

    #[test]
    fn tui_loop_exits_on_ctrl_c() {
        let mut input = std::io::Cursor::new(vec![3]);
        let mut output = Vec::new();

        run_tui_loop(&mut input, &mut output, || TerminalDimensions {
            columns: 80,
            rows: 12,
        })
        .unwrap();

        let output = String::from_utf8(output).unwrap();
        assert!(output.contains("system> Exiting."));
    }

    #[test]
    fn tui_loop_ctrl_d_with_text_does_not_exit() {
        let mut input =
            std::io::Cursor::new(b"/model faux-rust/faux-rust-model\rabc\x04\r/exit\r".to_vec());
        let mut output = Vec::new();

        run_tui_loop(&mut input, &mut output, || TerminalDimensions {
            columns: 80,
            rows: 12,
        })
        .unwrap();

        let output = String::from_utf8(output).unwrap();
        assert!(output.contains("assistant> faux-rust-ok: abc"));
        assert!(output.contains("system> Exiting."));
    }

    #[test]
    fn print_defaults_to_native_faux_provider() {
        let output = run(["-p", "hello"]);

        assert_eq!(output.exit_code, 0);
        assert_eq!(output.stdout, "faux-rust-ok: hello\n");
        assert!(output.stderr.is_empty());
    }

    #[test]
    fn positional_prompt_runs_one_native_turn() {
        let output = run(["hello"]);

        assert_eq!(output.exit_code, 0);
        assert_eq!(output.stdout, "faux-rust-ok: hello\n");
        assert!(output.stderr.is_empty());
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
    fn provider_without_model_reports_no_model_selected() {
        let output = run(["--provider", "openai", "-p", "hello"]);

        assert_eq!(output.exit_code, 1);
        assert!(output.stderr.contains("No model selected."));
        assert!(!output.stderr.contains("openai/faux-rust-model"));
    }

    #[test]
    fn parse_errors_preserve_parse_warnings() {
        let output = run(["--thinking", "extreme", "-z"]);

        assert_eq!(output.exit_code, 1);
        assert!(output.stderr.contains("Invalid thinking level \"extreme\""));
        assert!(output.stderr.contains("Unknown option: -z"));
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
