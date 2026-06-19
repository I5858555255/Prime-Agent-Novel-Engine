use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frontmatter::parse_frontmatter;
use crate::source_info::{
    SourceInfo, SourceOrigin, SourceScope, SyntheticSourceInfoOptions, create_synthetic_source_info,
};

pub const CONFIG_DIR_NAME: &str = ".prime/agent";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplate {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
    pub content: String,
    pub source_info: SourceInfo,
    pub file_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadPromptTemplatesOptions {
    pub cwd: PathBuf,
    pub agent_dir: PathBuf,
    pub prompt_paths: Vec<String>,
    pub include_defaults: bool,
}

pub fn parse_command_args(args_string: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quote = None;

    for ch in args_string.chars() {
        if let Some(quote) = in_quote {
            if ch == quote {
                in_quote = None;
            } else {
                current.push(ch);
            }
        } else if ch == '"' || ch == '\'' {
            in_quote = Some(ch);
        } else if ch == ' ' || ch == '\t' {
            if !current.is_empty() {
                args.push(std::mem::take(&mut current));
            }
        } else {
            current.push(ch);
        }
    }

    if !current.is_empty() {
        args.push(current);
    }

    args
}

pub fn substitute_args<S: AsRef<str>>(content: &str, args: &[S]) -> String {
    let all_args = join_args(args);
    let mut result = String::with_capacity(content.len() + all_args.len());
    let mut index = 0;
    let bytes = content.as_bytes();

    while index < content.len() {
        if bytes[index] == b'$' {
            if let Some((replacement, next_index)) = positional_replacement(content, index, args) {
                result.push_str(&replacement);
                index = next_index;
                continue;
            }

            if let Some((replacement, next_index)) = slice_replacement(content, index, args) {
                result.push_str(&replacement);
                index = next_index;
                continue;
            }

            if content[index..].starts_with("$ARGUMENTS") {
                result.push_str(&all_args);
                index += "$ARGUMENTS".len();
                continue;
            }

            if content[index..].starts_with("$@") {
                result.push_str(&all_args);
                index += "$@".len();
                continue;
            }
        }

        let ch = content[index..]
            .chars()
            .next()
            .expect("index should be on a character boundary");
        result.push(ch);
        index += ch.len_utf8();
    }

    result
}

fn positional_replacement<S: AsRef<str>>(
    content: &str,
    index: usize,
    args: &[S],
) -> Option<(String, usize)> {
    let bytes = content.as_bytes();
    let mut end = index + 1;

    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }

    if end == index + 1 {
        return None;
    }

    let replacement = content[index + 1..end]
        .parse::<usize>()
        .ok()
        .and_then(|num| num.checked_sub(1))
        .and_then(|arg_index| args.get(arg_index))
        .map(|arg| arg.as_ref().to_owned())
        .unwrap_or_default();

    Some((replacement, end))
}

fn slice_replacement<S: AsRef<str>>(
    content: &str,
    index: usize,
    args: &[S],
) -> Option<(String, usize)> {
    const PREFIX: &str = "${@:";

    if !content[index..].starts_with(PREFIX) {
        return None;
    }

    let bytes = content.as_bytes();
    let mut cursor = index + PREFIX.len();
    let start_digits = cursor;
    while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
        cursor += 1;
    }
    if cursor == start_digits {
        return None;
    }

    let start = content[start_digits..cursor]
        .parse::<usize>()
        .unwrap_or(usize::MAX);
    let mut length = None;

    if cursor < bytes.len() && bytes[cursor] == b':' {
        cursor += 1;
        let length_digits = cursor;
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
            cursor += 1;
        }
        if cursor == length_digits {
            return None;
        }
        length = Some(
            content[length_digits..cursor]
                .parse::<usize>()
                .unwrap_or(usize::MAX),
        );
    }

    if cursor >= bytes.len() || bytes[cursor] != b'}' {
        return None;
    }

    let start_index = start.saturating_sub(1);
    let replacement = if start_index >= args.len() {
        String::new()
    } else {
        let end_index = length
            .map(|len| start_index.saturating_add(len).min(args.len()))
            .unwrap_or(args.len());
        join_args(&args[start_index..end_index])
    };

    Some((replacement, cursor + 1))
}

fn join_args<S: AsRef<str>>(args: &[S]) -> String {
    let mut joined = String::new();
    for (index, arg) in args.iter().enumerate() {
        if index > 0 {
            joined.push(' ');
        }
        joined.push_str(arg.as_ref());
    }
    joined
}

pub fn normalize_prompt_path(input: &str) -> PathBuf {
    let trimmed = input.trim();

    if trimmed == "~" {
        return home_dir().unwrap_or_else(|| PathBuf::from(trimmed));
    }

    if let Some(rest) = trimmed.strip_prefix("~/")
        && let Some(home) = home_dir()
    {
        return normalize_lexically(home.join(rest));
    }

    if let Some(rest) = trimmed.strip_prefix('~')
        && let Some(home) = home_dir()
    {
        return normalize_lexically(home.join(rest));
    }

    PathBuf::from(trimmed)
}

pub fn resolve_prompt_path(path: &str, cwd: impl AsRef<Path>) -> PathBuf {
    let normalized = normalize_prompt_path(path);
    if normalized.is_absolute() {
        normalized
    } else {
        normalize_lexically(resolve_base(cwd.as_ref()).join(normalized))
    }
}

pub fn load_prompt_templates(options: LoadPromptTemplatesOptions) -> Vec<PromptTemplate> {
    let resolved_cwd = options.cwd;
    let resolved_agent_dir = options.agent_dir;
    let prompt_paths = options.prompt_paths;
    let include_defaults = options.include_defaults;

    let mut templates = Vec::new();
    let global_prompts_dir = if resolved_agent_dir.as_os_str().is_empty() {
        resolved_agent_dir.clone()
    } else {
        resolved_agent_dir.join("prompts")
    };
    let project_prompts_dir = normalize_lexically(
        resolve_base(&resolved_cwd)
            .join(CONFIG_DIR_NAME)
            .join("prompts"),
    );

    if include_defaults {
        templates.extend(load_templates_from_dir(
            &global_prompts_dir,
            &global_prompts_dir,
            &project_prompts_dir,
        ));
        templates.extend(load_templates_from_dir(
            &project_prompts_dir,
            &global_prompts_dir,
            &project_prompts_dir,
        ));
    }

    for raw_path in prompt_paths {
        let resolved_path = resolve_prompt_path(&raw_path, &resolved_cwd);
        if !resolved_path.exists() {
            continue;
        }

        let Ok(metadata) = fs::metadata(&resolved_path) else {
            continue;
        };

        if metadata.is_dir() {
            templates.extend(load_templates_from_dir(
                &resolved_path,
                &global_prompts_dir,
                &project_prompts_dir,
            ));
        } else if metadata.is_file() && has_markdown_extension(&resolved_path) {
            let source_info =
                source_info_for_path(&resolved_path, &global_prompts_dir, &project_prompts_dir);
            if let Some(template) = load_template_from_file(&resolved_path, source_info) {
                templates.push(template);
            }
        }
    }

    templates
}

pub fn expand_prompt_template(text: &str, templates: &[PromptTemplate]) -> String {
    let Some(rest) = text.strip_prefix('/') else {
        return text.to_owned();
    };

    let (template_name, args_string) = match rest.find(' ') {
        Some(space_index) => (&rest[..space_index], &rest[space_index + 1..]),
        None => (rest, ""),
    };

    let Some(template) = templates
        .iter()
        .find(|template| template.name == template_name)
    else {
        return text.to_owned();
    };

    let args = parse_command_args(args_string);
    substitute_args(&template.content, &args)
}

fn load_templates_from_dir(
    dir: &Path,
    global_prompts_dir: &Path,
    project_prompts_dir: &Path,
) -> Vec<PromptTemplate> {
    let mut templates = Vec::new();
    if !dir.exists() {
        return templates;
    }

    let Ok(entries) = fs::read_dir(dir) else {
        return templates;
    };

    for entry in entries.flatten() {
        let full_path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        let is_file = if file_type.is_file() {
            true
        } else if file_type.is_symlink() {
            match fs::metadata(&full_path) {
                Ok(metadata) => metadata.is_file(),
                Err(_) => false,
            }
        } else {
            false
        };

        if is_file && has_markdown_extension(&full_path) {
            let source_info =
                source_info_for_path(&full_path, global_prompts_dir, project_prompts_dir);
            if let Some(template) = load_template_from_file(&full_path, source_info) {
                templates.push(template);
            }
        }
    }

    templates
}

fn load_template_from_file(file_path: &Path, source_info: SourceInfo) -> Option<PromptTemplate> {
    let raw_content = fs::read(file_path).ok()?;
    let raw_content = String::from_utf8_lossy(&raw_content);
    let parsed = parse_frontmatter(&raw_content).ok()?;
    let name = template_name(file_path)?;
    let description = description_from_frontmatter(&parsed.frontmatter)
        .unwrap_or_else(|| description_from_body(&parsed.body).unwrap_or_default());

    Some(PromptTemplate {
        name,
        description,
        argument_hint: string_frontmatter_field(&parsed.frontmatter, "argument-hint")
            .filter(|value| !value.is_empty()),
        content: parsed.body,
        source_info,
        file_path: file_path.to_string_lossy().into_owned(),
    })
}

fn description_from_frontmatter(frontmatter: &Value) -> Option<String> {
    string_frontmatter_field(frontmatter, "description").filter(|value| !value.is_empty())
}

fn description_from_body(body: &str) -> Option<String> {
    let first_line = body.lines().find(|line| !line.trim().is_empty())?;
    let mut description: String = first_line.chars().take(60).collect();
    if first_line.chars().count() > 60 {
        description.push_str("...");
    }
    Some(description)
}

fn string_frontmatter_field(frontmatter: &Value, key: &str) -> Option<String> {
    frontmatter
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn template_name(file_path: &Path) -> Option<String> {
    let file_name = file_path.file_name()?.to_string_lossy();
    Some(
        file_name
            .strip_suffix(".md")
            .unwrap_or(file_name.as_ref())
            .to_owned(),
    )
}

fn has_markdown_extension(file_path: &Path) -> bool {
    file_path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".md"))
}

fn source_info_for_path(
    path: &Path,
    global_prompts_dir: &Path,
    project_prompts_dir: &Path,
) -> SourceInfo {
    let (scope, base_dir) = if is_under_path(path, global_prompts_dir) {
        (Some(SourceScope::User), global_prompts_dir.to_path_buf())
    } else if is_under_path(path, project_prompts_dir) {
        (
            Some(SourceScope::Project),
            project_prompts_dir.to_path_buf(),
        )
    } else {
        (None, source_base_dir(path))
    };

    create_synthetic_source_info(
        path.to_string_lossy().into_owned(),
        SyntheticSourceInfoOptions {
            source: "local".to_string(),
            scope,
            origin: Some(SourceOrigin::TopLevel),
            base_dir: Some(base_dir.to_string_lossy().into_owned()),
        },
    )
}

fn source_base_dir(path: &Path) -> PathBuf {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => path.to_path_buf(),
        _ => path.parent().unwrap_or_else(|| Path::new("")).to_path_buf(),
    }
}

fn is_under_path(target: &Path, root: &Path) -> bool {
    let normalized_target = resolve_base(target);
    let normalized_root = resolve_base(root);
    normalized_target == normalized_root || normalized_target.starts_with(&normalized_root)
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

fn resolve_base(path: &Path) -> PathBuf {
    if path.is_absolute() {
        normalize_lexically(path.to_path_buf())
    } else {
        normalize_lexically(
            env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path),
        )
    }
}

fn normalize_lexically(path: PathBuf) -> PathBuf {
    let is_absolute = path.is_absolute();
    let mut normalized = PathBuf::new();

    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() && !is_absolute {
                    normalized.push("..");
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }

    if normalized.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        normalized
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(name: &str) -> io::Result<Self> {
            let base = env::temp_dir();
            let pid = std::process::id();

            for attempt in 0..100 {
                let nanos = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                let path = base.join(format!(
                    "prime-agent-prompt-templates-{name}-{pid}-{nanos}-{attempt}"
                ));

                match fs::create_dir(&path) {
                    Ok(()) => return Ok(Self { path }),
                    Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(err) => return Err(err),
                }
            }

            Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "could not create unique temp dir",
            ))
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

    fn write_file(path: impl AsRef<Path>, content: &str) {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn load_for_test(
        cwd: impl AsRef<Path>,
        agent_dir: impl AsRef<Path>,
        prompt_paths: Vec<String>,
        include_defaults: bool,
    ) -> Vec<PromptTemplate> {
        load_prompt_templates(LoadPromptTemplatesOptions {
            cwd: cwd.as_ref().to_path_buf(),
            agent_dir: agent_dir.as_ref().to_path_buf(),
            prompt_paths,
            include_defaults,
        })
    }

    fn names(mut templates: Vec<PromptTemplate>) -> Vec<String> {
        templates.sort_by(|a, b| a.name.cmp(&b.name));
        templates
            .into_iter()
            .map(|template| template.name)
            .collect()
    }

    #[test]
    fn parse_command_args_handles_quotes_spacing_and_literals() {
        assert_eq!(parse_command_args("a b c"), ["a", "b", "c"]);
        assert_eq!(
            parse_command_args("\"first arg\" second"),
            ["first arg", "second"]
        );
        assert_eq!(
            parse_command_args("'first arg' second"),
            ["first arg", "second"]
        );
        assert_eq!(
            parse_command_args("\"double\" 'single' \"double again\""),
            ["double", "single", "double again"]
        );
        assert_eq!(parse_command_args(""), Vec::<String>::new());
        assert_eq!(parse_command_args("a  b\tc   "), ["a", "b", "c"]);
        assert_eq!(parse_command_args("\"\" \" \""), [" "]);
        assert_eq!(
            parse_command_args("$100 @user #tag"),
            ["$100", "@user", "#tag"]
        );
        assert_eq!(
            parse_command_args("日本語 🎉 café"),
            ["日本語", "🎉", "café"]
        );
        assert_eq!(
            parse_command_args("\"line1\nline2\" second"),
            ["line1\nline2", "second"]
        );
        assert_eq!(
            parse_command_args("\"quoted \\\"text\\\"\""),
            ["quoted \\text\\"]
        );
    }

    #[test]
    fn substitute_args_replaces_placeholders_and_keeps_args_literal() {
        let args = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        assert_eq!(substitute_args("Test: $ARGUMENTS", &args), "Test: a b c");
        assert_eq!(substitute_args("Test: $@", &args), "Test: a b c");
        assert_eq!(substitute_args("$1 $2 $3", &args), "a b c");
        assert_eq!(substitute_args("$1$2", &args), "ab");
        assert_eq!(substitute_args("$1 $2 $3 $4 $5", &args[..2]), "a b   ");
        assert_eq!(substitute_args("$0", &args), "");
        assert_eq!(substitute_args("$1.5", &args), "a.5");
        assert_eq!(substitute_args("pre$ARGUMENTS", &args), "prea b c");
        assert_eq!(substitute_args("pre$@", &args), "prea b c");
        assert_eq!(substitute_args("$A $$ $ $ARGS", &args), "$A $$ $ $ARGS");
        let no_args: Vec<String> = Vec::new();
        assert_eq!(substitute_args("Price: \\$100", &no_args), "Price: \\");

        let literal_args = vec![
            "$1".to_string(),
            "$@".to_string(),
            "$ARGUMENTS".to_string(),
            "${@:2}".to_string(),
        ];
        assert_eq!(
            substitute_args("$ARGUMENTS", &literal_args),
            "$1 $@ $ARGUMENTS ${@:2}"
        );
        assert_eq!(substitute_args("$1", &literal_args), "$1");
        assert_eq!(substitute_args("$2", &literal_args), "$@");
    }

    #[test]
    fn substitute_args_supports_bash_style_slices() {
        let args = vec!["a", "b", "c", "d"]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();

        assert_eq!(substitute_args("${@:2}", &args), "b c d");
        assert_eq!(substitute_args("${@:1}", &args), "a b c d");
        assert_eq!(substitute_args("${@:3}", &args), "c d");
        assert_eq!(substitute_args("${@:2:2}", &args), "b c");
        assert_eq!(substitute_args("${@:3:1}", &args), "c");
        assert_eq!(substitute_args("${@:99}", &args), "");
        assert_eq!(substitute_args("${@:2:0}", &args), "");
        assert_eq!(substitute_args("${@:2:99}", &args), "b c d");
        assert_eq!(substitute_args("${@:2} vs $@", &args), "b c d vs a b c d");
        assert_eq!(substitute_args("${@:0}", &args), "a b c d");
        assert_eq!(
            substitute_args("prefix${@:2}suffix", &args),
            "prefixb c dsuffix"
        );
    }

    #[test]
    fn load_prompt_templates_reads_frontmatter_and_fallback_description() {
        let temp_dir = TempDir::new("frontmatter").unwrap();
        let prompts_dir = temp_dir.path().join("prompts");
        write_file(
            prompts_dir.join("review.md"),
            "---\ndescription: Review PRs from URLs\nargument-hint: \"<PR-URL>\"\n---\nYou are given $@",
        );
        write_file(
            prompts_dir.join("empty-hint.md"),
            "---\ndescription: Empty hint\nargument-hint: \"\"\n---\nDo something",
        );
        write_file(
            prompts_dir.join("fallback.md"),
            "   This first non-empty body line is intentionally much longer than sixty characters.\nSecond",
        );

        let templates = load_for_test(
            temp_dir.path(),
            temp_dir.path().join("agent"),
            vec![prompts_dir.to_string_lossy().into_owned()],
            false,
        );

        let review = templates
            .iter()
            .find(|template| template.name == "review")
            .unwrap();
        assert_eq!(review.description, "Review PRs from URLs");
        assert_eq!(review.argument_hint.as_deref(), Some("<PR-URL>"));
        assert_eq!(review.content, "You are given $@");

        let empty_hint = templates
            .iter()
            .find(|template| template.name == "empty-hint")
            .unwrap();
        assert_eq!(empty_hint.argument_hint, None);

        let fallback = templates
            .iter()
            .find(|template| template.name == "fallback")
            .unwrap();
        assert_eq!(
            fallback.description,
            "   This first non-empty body line is intentionally much long..."
        );
    }

    #[test]
    fn load_prompt_templates_loads_defaults_and_explicit_paths() {
        let temp_dir = TempDir::new("defaults").unwrap();
        let cwd = temp_dir.path().join("project");
        let agent_dir = temp_dir.path().join("agent");
        let global_prompts_dir = agent_dir.join("prompts");
        let project_prompts_dir = cwd.join(CONFIG_DIR_NAME).join("prompts");
        let explicit_dir = temp_dir.path().join("explicit");
        let explicit_file = temp_dir.path().join("single.md");

        write_file(global_prompts_dir.join("global.md"), "Global prompt");
        write_file(project_prompts_dir.join("project.md"), "Project prompt");
        write_file(explicit_dir.join("dir-template.md"), "Directory prompt");
        write_file(&explicit_file, "Single prompt");
        write_file(
            explicit_dir.join("nested").join("ignored.md"),
            "Nested prompt",
        );
        write_file(explicit_dir.join("ignored.txt"), "Not markdown");

        let templates = load_for_test(
            &cwd,
            &agent_dir,
            vec![
                explicit_dir.to_string_lossy().into_owned(),
                explicit_file.to_string_lossy().into_owned(),
                temp_dir
                    .path()
                    .join("missing")
                    .to_string_lossy()
                    .into_owned(),
            ],
            true,
        );

        assert_eq!(
            names(templates.clone()),
            ["dir-template", "global", "project", "single"]
        );

        let global = templates
            .iter()
            .find(|template| template.name == "global")
            .unwrap();
        let global_base_dir = global_prompts_dir.to_string_lossy().into_owned();
        assert_eq!(global.source_info.scope, SourceScope::User);
        assert_eq!(
            global.source_info.base_dir.as_deref(),
            Some(global_base_dir.as_str())
        );

        let project = templates
            .iter()
            .find(|template| template.name == "project")
            .unwrap();
        let project_base_dir = project_prompts_dir.to_string_lossy().into_owned();
        assert_eq!(project.source_info.scope, SourceScope::Project);
        assert_eq!(
            project.source_info.base_dir.as_deref(),
            Some(project_base_dir.as_str())
        );

        let explicit = templates
            .iter()
            .find(|template| template.name == "single")
            .unwrap();
        let explicit_base_dir = temp_dir.path().to_string_lossy().into_owned();
        assert_eq!(explicit.source_info.scope, SourceScope::Temporary);
        assert_eq!(
            explicit.source_info.base_dir.as_deref(),
            Some(explicit_base_dir.as_str())
        );
    }

    #[test]
    fn resolve_prompt_path_trims_expands_home_and_resolves_relative_paths() {
        let temp_dir = TempDir::new("resolve").unwrap();
        let cwd = temp_dir.path().join("cwd");

        assert_eq!(
            resolve_prompt_path(" prompts/../template.md ", &cwd),
            cwd.join("template.md")
        );
        assert!(normalize_prompt_path("~").is_absolute());
        assert!(normalize_prompt_path("~/prompts").is_absolute());
    }

    #[cfg(unix)]
    #[test]
    fn load_prompt_templates_follows_file_symlinks_and_skips_broken_symlinks() {
        use std::os::unix::fs::symlink;

        let temp_dir = TempDir::new("symlinks").unwrap();
        let prompts_dir = temp_dir.path().join("prompts");
        fs::create_dir_all(&prompts_dir).unwrap();
        let target = prompts_dir.join("target.md");
        let link = prompts_dir.join("link.md");
        let broken = prompts_dir.join("broken.md");
        let non_md_link = prompts_dir.join("not-markdown");

        write_file(&target, "Target prompt");
        symlink(&target, &link).unwrap();
        symlink(prompts_dir.join("missing.md"), &broken).unwrap();
        symlink(&target, &non_md_link).unwrap();

        let templates = load_for_test(
            temp_dir.path(),
            temp_dir.path().join("agent"),
            vec![prompts_dir.to_string_lossy().into_owned()],
            false,
        );

        assert_eq!(names(templates), ["link", "target"]);
    }

    #[test]
    fn expand_prompt_template_expands_matching_slash_command_only() {
        let template = PromptTemplate {
            name: "deploy".to_string(),
            description: "Deploy".to_string(),
            argument_hint: None,
            content: "Deploy $1 with ${@:2}".to_string(),
            source_info: create_synthetic_source_info(
                "/tmp/deploy.md",
                SyntheticSourceInfoOptions {
                    source: "local".to_string(),
                    scope: None,
                    origin: None,
                    base_dir: None,
                },
            ),
            file_path: "/tmp/deploy.md".to_string(),
        };

        assert_eq!(
            expand_prompt_template(
                "/deploy api \"blue green\"",
                std::slice::from_ref(&template)
            ),
            "Deploy api with blue green"
        );
        assert_eq!(
            expand_prompt_template("/unknown api", std::slice::from_ref(&template)),
            "/unknown api"
        );
        assert_eq!(
            expand_prompt_template("deploy api", &[template]),
            "deploy api"
        );
    }
}
