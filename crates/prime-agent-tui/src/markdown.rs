use crate::latex::latex_to_unicode;
use crate::render_cache::VersionedRenderCache;
use crate::terminal_image::{get_capabilities, hyperlink, is_image_line};
use crate::utils::{apply_background_to_line, visible_width, wrap_text_with_ansi};

pub type MarkdownStyleFn = fn(&str) -> String;
pub type MarkdownHighlightCodeFn = for<'a> fn(&'a str, Option<&'a str>) -> Vec<String>;

#[derive(Debug, Clone, Copy, Default)]
pub struct DefaultTextStyle {
    pub color: Option<MarkdownStyleFn>,
    pub bg_color: Option<MarkdownStyleFn>,
    pub bold: bool,
    pub italic: bool,
    pub strikethrough: bool,
    pub underline: bool,
}

#[derive(Debug, Clone)]
pub struct MarkdownTheme {
    pub heading: MarkdownStyleFn,
    pub link: MarkdownStyleFn,
    pub link_url: MarkdownStyleFn,
    pub code: MarkdownStyleFn,
    pub code_block: MarkdownStyleFn,
    pub code_block_border: MarkdownStyleFn,
    pub quote: MarkdownStyleFn,
    pub quote_border: MarkdownStyleFn,
    pub hr: MarkdownStyleFn,
    pub list_bullet: MarkdownStyleFn,
    pub bold: MarkdownStyleFn,
    pub italic: MarkdownStyleFn,
    pub strikethrough: MarkdownStyleFn,
    pub underline: MarkdownStyleFn,
    pub highlight_code: Option<MarkdownHighlightCodeFn>,
    pub code_block_indent: String,
    pub math: Option<MarkdownStyleFn>,
    pub math_block: Option<MarkdownStyleFn>,
}

impl Default for MarkdownTheme {
    fn default() -> Self {
        Self {
            heading: identity,
            link: identity,
            link_url: identity,
            code: identity,
            code_block: identity,
            code_block_border: identity,
            quote: identity,
            quote_border: identity,
            hr: identity,
            list_bullet: identity,
            bold: ansi_bold,
            italic: ansi_italic,
            strikethrough: ansi_strikethrough,
            underline: ansi_underline,
            highlight_code: None,
            code_block_indent: "  ".to_string(),
            math: None,
            math_block: None,
        }
    }
}

pub struct Markdown {
    text: String,
    padding_x: usize,
    padding_y: usize,
    theme: MarkdownTheme,
    default_text_style: Option<DefaultTextStyle>,
    version: u64,
    cache: VersionedRenderCache,
}

impl Default for Markdown {
    fn default() -> Self {
        Self::with_default_theme("", 1, 1)
    }
}

impl std::fmt::Debug for Markdown {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Markdown")
            .field("text", &self.text)
            .field("padding_x", &self.padding_x)
            .field("padding_y", &self.padding_y)
            .field("theme", &self.theme)
            .field("default_text_style", &self.default_text_style)
            .field("version", &self.version)
            .field("cache", &self.cache)
            .finish()
    }
}

impl Markdown {
    pub fn new(
        text: impl Into<String>,
        padding_x: usize,
        padding_y: usize,
        theme: MarkdownTheme,
        default_text_style: Option<DefaultTextStyle>,
    ) -> Self {
        Self {
            text: text.into(),
            padding_x,
            padding_y,
            theme,
            default_text_style,
            version: 0,
            cache: VersionedRenderCache::new(),
        }
    }

    pub fn with_default_theme(text: impl Into<String>, padding_x: usize, padding_y: usize) -> Self {
        Self::new(text, padding_x, padding_y, MarkdownTheme::default(), None)
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn padding_x(&self) -> usize {
        self.padding_x
    }

    pub fn padding_y(&self) -> usize {
        self.padding_y
    }

    pub fn theme(&self) -> &MarkdownTheme {
        &self.theme
    }

    pub fn default_text_style(&self) -> Option<DefaultTextStyle> {
        self.default_text_style
    }

    pub fn set_text(&mut self, text: impl Into<String>) {
        self.text = text.into();
        self.mark_dirty();
    }

    pub fn set_padding_x(&mut self, padding_x: usize) {
        self.padding_x = padding_x;
        self.mark_dirty();
    }

    pub fn set_padding_y(&mut self, padding_y: usize) {
        self.padding_y = padding_y;
        self.mark_dirty();
    }

    pub fn set_padding(&mut self, padding_x: usize, padding_y: usize) {
        self.padding_x = padding_x;
        self.padding_y = padding_y;
        self.mark_dirty();
    }

    pub fn set_theme(&mut self, theme: MarkdownTheme) {
        self.theme = theme;
        self.mark_dirty();
    }

    pub fn set_default_text_style(&mut self, default_text_style: Option<DefaultTextStyle>) {
        self.default_text_style = default_text_style;
        self.mark_dirty();
    }

    pub fn invalidate(&mut self) {
        self.cache.invalidate();
    }

    pub fn cached_lines(&self, width: usize) -> Option<&[String]> {
        self.cache.get(width, self.version)
    }

    pub fn render(&mut self, width: usize) -> Vec<String> {
        self.render_cached(width).to_vec()
    }

    pub fn render_cached(&mut self, width: usize) -> &[String] {
        if self.cache.get(width, self.version).is_none() {
            let lines = self.render_lines(width);
            self.cache.set(width, self.version, lines);
        }

        self.cache
            .get(width, self.version)
            .expect("render cache should contain rendered markdown")
    }

    fn mark_dirty(&mut self) {
        self.version = self.version.wrapping_add(1);
        self.cache.invalidate();
    }

    fn render_lines(&self, width: usize) -> Vec<String> {
        if self.text.trim().is_empty() {
            return Vec::new();
        }

        let content_width = width
            .saturating_sub(self.padding_x.saturating_mul(2))
            .max(1);
        let normalized_text = self.text.replace('\t', "   ");
        let blocks = parse_blocks(&normalized_text);
        let mut content_lines = Vec::new();

        for (index, block) in blocks.iter().enumerate() {
            let next_kind = blocks.get(index + 1).map(Block::kind);
            content_lines.extend(self.render_block(block, next_kind, width, content_width));
        }

        let bg_fn = self.default_text_style.and_then(|style| style.bg_color);
        let empty_line = " ".repeat(width);
        let mut empty_lines = Vec::new();
        for _ in 0..self.padding_y {
            empty_lines.push(pad_and_background(&empty_line, width, bg_fn));
        }

        let mut result = Vec::with_capacity(empty_lines.len() * 2 + content_lines.len());
        result.extend(empty_lines.iter().cloned());
        result.extend(content_lines);
        result.extend(empty_lines);
        result
    }

    fn render_block(
        &self,
        block: &Block,
        next_kind: Option<BlockKind>,
        width: usize,
        content_width: usize,
    ) -> Vec<String> {
        let token_lines = self.render_token(block, next_kind, content_width, None);
        let left_margin = " ".repeat(self.padding_x);
        let right_margin = " ".repeat(self.padding_x);
        let bg_fn = self.default_text_style.and_then(|style| style.bg_color);
        let mut block_lines = Vec::new();

        for line in token_lines {
            if is_image_line(&line) {
                block_lines.push(line);
                continue;
            }

            for wrapped in wrap_text_with_ansi(&line, content_width) {
                let line_with_margins = format!("{left_margin}{wrapped}{right_margin}");
                block_lines.push(pad_and_background(&line_with_margins, width, bg_fn));
            }
        }

        block_lines
    }

    fn render_token(
        &self,
        block: &Block,
        next_kind: Option<BlockKind>,
        width: usize,
        style_context: Option<&InlineStyleContext<'_>>,
    ) -> Vec<String> {
        match block {
            Block::Heading { level, text } => {
                let heading_style = |value: &str| {
                    if *level == 1 {
                        (self.theme.heading)(
                            (self.theme.bold)(&(self.theme.underline)(value)).as_str(),
                        )
                    } else {
                        (self.theme.heading)((self.theme.bold)(value).as_str())
                    }
                };
                let heading_context = InlineStyleContext {
                    apply_text: &heading_style,
                    style_prefix: style_prefix(&heading_style),
                };
                let heading_text = self.render_inline(text, Some(&heading_context));
                let mut lines = Vec::new();
                if *level >= 3 {
                    let prefix = heading_style(&format!("{} ", "#".repeat(*level)));
                    lines.push(format!("{prefix}{heading_text}"));
                } else {
                    lines.push(heading_text);
                }
                if next_kind.is_some_and(|kind| kind != BlockKind::Space) {
                    lines.push(String::new());
                }
                lines
            }
            Block::Paragraph(text) => {
                let mut lines = vec![self.render_inline(text, style_context)];
                if next_kind.is_some_and(|kind| kind != BlockKind::List && kind != BlockKind::Space)
                {
                    lines.push(String::new());
                }
                lines
            }
            Block::Code { lang, text } => {
                let mut lines = self.render_code_block(text, lang.as_deref());
                if next_kind.is_some_and(|kind| kind != BlockKind::Space) {
                    lines.push(String::new());
                }
                lines
            }
            Block::Math(text) => {
                let mut lines = self.render_math_block(text);
                if next_kind.is_some_and(|kind| kind != BlockKind::Space) {
                    lines.push(String::new());
                }
                lines
            }
            Block::List {
                ordered,
                start,
                items,
            } => self.render_list(*ordered, *start, items, 0, style_context),
            Block::Blockquote(text) => {
                let mut lines = self.render_blockquote(text, width);
                if next_kind.is_some_and(|kind| kind != BlockKind::Space) {
                    lines.push(String::new());
                }
                lines
            }
            Block::Hr => {
                let mut lines = vec![(self.theme.hr)(&"─".repeat(width.min(80)))];
                if next_kind.is_some_and(|kind| kind != BlockKind::Space) {
                    lines.push(String::new());
                }
                lines
            }
            Block::Space => vec![String::new()],
        }
    }

    fn render_inline(&self, text: &str, style_context: Option<&InlineStyleContext<'_>>) -> String {
        match style_context {
            Some(context) => self.render_inline_with_context(text, context),
            None => {
                let apply_default = |value: &str| self.apply_default_style(value);
                let context = InlineStyleContext {
                    apply_text: &apply_default,
                    style_prefix: self.default_style_prefix(),
                };
                self.render_inline_with_context(text, &context)
            }
        }
    }

    fn render_inline_with_context(&self, text: &str, context: &InlineStyleContext<'_>) -> String {
        let mut result = String::new();
        let mut plain_start = 0;
        let mut index = 0;

        while index < text.len() {
            if let Some((raw_len, code_text)) = parse_codespan(&text[index..]) {
                self.push_plain(&mut result, &text[plain_start..index], context);
                result.push_str(&(self.theme.code)(&code_text));
                result.push_str(&context.style_prefix);
                index += raw_len;
                plain_start = index;
                continue;
            }

            if let Some((raw_len, math_text)) = parse_inline_math(&text[index..]) {
                self.push_plain(&mut result, &text[plain_start..index], context);
                let converted = latex_to_unicode(math_text.trim()).replace('\n', " ");
                let math_style = self.theme.math.unwrap_or(self.theme.code);
                result.push_str(&math_style(&converted));
                result.push_str(&context.style_prefix);
                index += raw_len;
                plain_start = index;
                continue;
            }

            if let Some((raw_len, label, url)) = parse_link(&text[index..]) {
                self.push_plain(&mut result, &text[plain_start..index], context);
                let link_text = self.render_inline_with_context(&label, context);
                let styled_link = (self.theme.link)(&(self.theme.underline)(&link_text));
                if get_capabilities().hyperlinks {
                    result.push_str(&hyperlink(&styled_link, &url));
                    result.push_str(&context.style_prefix);
                } else {
                    let comparison_href = url.strip_prefix("mailto:").unwrap_or(&url);
                    if label == url || label == comparison_href {
                        result.push_str(&styled_link);
                    } else {
                        result.push_str(&styled_link);
                        result.push_str(&(self.theme.link_url)(&format!(" ({url})")));
                    }
                    result.push_str(&context.style_prefix);
                }
                index += raw_len;
                plain_start = index;
                continue;
            }

            if let Some((raw_len, inner)) = parse_delimited(&text[index..], "**", "**") {
                self.push_plain(&mut result, &text[plain_start..index], context);
                let content = self.render_inline_with_context(&inner, context);
                result.push_str(&(self.theme.bold)(&content));
                result.push_str(&context.style_prefix);
                index += raw_len;
                plain_start = index;
                continue;
            }

            if let Some((raw_len, inner)) = parse_delimited(&text[index..], "__", "__") {
                self.push_plain(&mut result, &text[plain_start..index], context);
                let content = self.render_inline_with_context(&inner, context);
                result.push_str(&(self.theme.bold)(&content));
                result.push_str(&context.style_prefix);
                index += raw_len;
                plain_start = index;
                continue;
            }

            if let Some((raw_len, inner)) = parse_strikethrough(&text[index..]) {
                self.push_plain(&mut result, &text[plain_start..index], context);
                let content = self.render_inline_with_context(&inner, context);
                result.push_str(&(self.theme.strikethrough)(&content));
                result.push_str(&context.style_prefix);
                index += raw_len;
                plain_start = index;
                continue;
            }

            if let Some((raw_len, inner)) = parse_delimited(&text[index..], "<u>", "</u>") {
                self.push_plain(&mut result, &text[plain_start..index], context);
                let content = self.render_inline_with_context(&inner, context);
                result.push_str(&(self.theme.underline)(&content));
                result.push_str(&context.style_prefix);
                index += raw_len;
                plain_start = index;
                continue;
            }

            if let Some((raw_len, inner)) = parse_emphasis(&text[index..]) {
                self.push_plain(&mut result, &text[plain_start..index], context);
                let content = self.render_inline_with_context(&inner, context);
                result.push_str(&(self.theme.italic)(&content));
                result.push_str(&context.style_prefix);
                index += raw_len;
                plain_start = index;
                continue;
            }

            if text.as_bytes()[index] == b'\\'
                && let Some((_, next)) = next_char(text, index)
                && next < text.len()
            {
                self.push_plain(&mut result, &text[plain_start..index], context);
                let escaped_end = next_char(text, next).map_or(text.len(), |(_, end)| end);
                self.push_plain(&mut result, &text[next..escaped_end], context);
                index = escaped_end;
                plain_start = index;
                continue;
            }

            let Some((_, next)) = next_char(text, index) else {
                break;
            };
            index = next;
        }

        self.push_plain(&mut result, &text[plain_start..], context);
        while !context.style_prefix.is_empty() && result.ends_with(&context.style_prefix) {
            let new_len = result.len() - context.style_prefix.len();
            result.truncate(new_len);
        }
        result
    }

    fn push_plain(&self, result: &mut String, text: &str, context: &InlineStyleContext<'_>) {
        if text.is_empty() {
            return;
        }

        let mut first = true;
        for segment in text.split('\n') {
            if first {
                first = false;
            } else {
                result.push('\n');
            }
            result.push_str(&(context.apply_text)(segment));
        }
    }

    fn apply_default_style(&self, text: &str) -> String {
        let Some(default_text_style) = self.default_text_style else {
            return text.to_string();
        };

        let mut styled = text.to_string();
        if let Some(color) = default_text_style.color {
            styled = color(&styled);
        }
        if default_text_style.bold {
            styled = (self.theme.bold)(&styled);
        }
        if default_text_style.italic {
            styled = (self.theme.italic)(&styled);
        }
        if default_text_style.strikethrough {
            styled = (self.theme.strikethrough)(&styled);
        }
        if default_text_style.underline {
            styled = (self.theme.underline)(&styled);
        }
        styled
    }

    fn default_style_prefix(&self) -> String {
        if self.default_text_style.is_none() {
            return String::new();
        }

        let sentinel = "\0";
        let styled = self.apply_default_style(sentinel);
        styled
            .find(sentinel)
            .map_or_else(String::new, |index| styled[..index].to_string())
    }

    fn render_list(
        &self,
        ordered: bool,
        start: usize,
        items: &[ListItem],
        depth: usize,
        style_context: Option<&InlineStyleContext<'_>>,
    ) -> Vec<String> {
        let mut lines = Vec::new();
        let indent = "  ".repeat(depth);

        for (index, item) in items.iter().enumerate() {
            let bullet = if ordered {
                format!("{}. ", start + index)
            } else {
                "- ".to_string()
            };
            let item_lines = self.render_list_item(item, style_context);

            if item_lines.is_empty() {
                lines.push(format!("{indent}{}", (self.theme.list_bullet)(&bullet)));
                continue;
            }

            lines.push(format!(
                "{indent}{}{}",
                (self.theme.list_bullet)(&bullet),
                item_lines[0]
            ));
            for line in item_lines.iter().skip(1) {
                lines.push(format!("{indent}  {line}"));
            }
        }

        lines
    }

    fn render_list_item(
        &self,
        item: &ListItem,
        style_context: Option<&InlineStyleContext<'_>>,
    ) -> Vec<String> {
        if item.text.trim().is_empty() {
            return Vec::new();
        }

        item.text
            .split('\n')
            .map(|line| self.render_inline(line.trim(), style_context))
            .collect()
    }

    fn render_code_block(&self, text: &str, lang: Option<&str>) -> Vec<String> {
        let rendered_code_lines = if let Some(highlight_code) = self.theme.highlight_code {
            highlight_code(text, lang)
        } else {
            text.split('\n')
                .map(|line| (self.theme.code_block)(line))
                .collect()
        };
        let code_lines = if rendered_code_lines.is_empty() {
            vec![(self.theme.code_block)("")]
        } else {
            rendered_code_lines
        };

        code_lines
            .into_iter()
            .map(|line| format!("{}{line}", self.theme.code_block_indent))
            .collect()
    }

    fn render_math_block(&self, text: &str) -> Vec<String> {
        let style = self.theme.math_block.unwrap_or(self.theme.code_block);
        latex_to_unicode(text)
            .split('\n')
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(|line| format!("{}{}", self.theme.code_block_indent, style(line)))
            .collect()
    }

    fn render_blockquote(&self, text: &str, width: usize) -> Vec<String> {
        let quote_style = |value: &str| (self.theme.quote)(&(self.theme.italic)(value));
        let quote_style_prefix = style_prefix(&quote_style);
        let quote_content_width = width.saturating_sub(2).max(1);
        let quote_apply_text = |value: &str| value.to_string();
        let quote_context = InlineStyleContext {
            apply_text: &quote_apply_text,
            style_prefix: quote_style_prefix.clone(),
        };
        let blocks = parse_blocks(text);
        let mut rendered_quote_lines = Vec::new();

        for (index, block) in blocks.iter().enumerate() {
            let next_kind = blocks.get(index + 1).map(Block::kind);
            rendered_quote_lines.extend(self.render_token(
                block,
                next_kind,
                quote_content_width,
                Some(&quote_context),
            ));
        }

        while rendered_quote_lines.last().is_some_and(String::is_empty) {
            rendered_quote_lines.pop();
        }

        let mut lines = Vec::new();
        for quote_line in rendered_quote_lines {
            let styled_line = if quote_style_prefix.is_empty() {
                quote_style(&quote_line)
            } else {
                quote_style(&quote_line.replace("\x1b[0m", &format!("\x1b[0m{quote_style_prefix}")))
            };
            for wrapped in wrap_text_with_ansi(&styled_line, quote_content_width) {
                lines.push(format!("{}{wrapped}", (self.theme.quote_border)("│ ")));
            }
        }
        lines
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BlockKind {
    Heading,
    Paragraph,
    Code,
    Math,
    List,
    Blockquote,
    Hr,
    Space,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Block {
    Heading {
        level: usize,
        text: String,
    },
    Paragraph(String),
    Code {
        lang: Option<String>,
        text: String,
    },
    Math(String),
    List {
        ordered: bool,
        start: usize,
        items: Vec<ListItem>,
    },
    Blockquote(String),
    Hr,
    Space,
}

impl Block {
    fn kind(&self) -> BlockKind {
        match self {
            Self::Heading { .. } => BlockKind::Heading,
            Self::Paragraph(_) => BlockKind::Paragraph,
            Self::Code { .. } => BlockKind::Code,
            Self::Math(_) => BlockKind::Math,
            Self::List { .. } => BlockKind::List,
            Self::Blockquote(_) => BlockKind::Blockquote,
            Self::Hr => BlockKind::Hr,
            Self::Space => BlockKind::Space,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ListItem {
    text: String,
}

struct InlineStyleContext<'a> {
    apply_text: &'a dyn Fn(&str) -> String,
    style_prefix: String,
}

fn parse_blocks(text: &str) -> Vec<Block> {
    let lines = text.lines().collect::<Vec<_>>();
    let mut blocks = Vec::new();
    let mut index = 0;

    while index < lines.len() {
        let line = lines[index];
        if line.trim().is_empty() {
            while index < lines.len() && lines[index].trim().is_empty() {
                index += 1;
            }
            blocks.push(Block::Space);
            continue;
        }

        if let Some((block, next_index)) = parse_fenced_code(&lines, index) {
            blocks.push(block);
            index = next_index;
            continue;
        }

        if let Some((block, next_index)) = parse_block_math(&lines, index) {
            blocks.push(block);
            index = next_index;
            continue;
        }

        if let Some((level, heading_text)) = parse_heading(line) {
            blocks.push(Block::Heading {
                level,
                text: heading_text,
            });
            index += 1;
            continue;
        }

        if is_horizontal_rule(line) {
            blocks.push(Block::Hr);
            index += 1;
            continue;
        }

        if is_blockquote_line(line) {
            let mut quote_lines = Vec::new();
            while index < lines.len() {
                let current = lines[index];
                if current.trim().is_empty() {
                    quote_lines.push(String::new());
                    index += 1;
                    continue;
                }
                if !is_blockquote_line(current) {
                    break;
                }
                quote_lines.push(strip_blockquote_marker(current).to_string());
                index += 1;
            }
            blocks.push(Block::Blockquote(quote_lines.join("\n")));
            continue;
        }

        if let Some((block, next_index)) = parse_list(&lines, index) {
            blocks.push(block);
            index = next_index;
            continue;
        }

        let mut paragraph_lines = vec![line.trim().to_string()];
        index += 1;
        while index < lines.len() {
            let current = lines[index];
            if current.trim().is_empty()
                || parse_fence_start(current).is_some()
                || starts_block_math(current)
                || parse_heading(current).is_some()
                || is_horizontal_rule(current)
                || is_blockquote_line(current)
                || parse_list_marker(current).is_some()
            {
                break;
            }
            paragraph_lines.push(current.trim().to_string());
            index += 1;
        }
        blocks.push(Block::Paragraph(paragraph_lines.join("\n")));
    }

    blocks
}

fn parse_fenced_code(lines: &[&str], start: usize) -> Option<(Block, usize)> {
    let (marker, lang) = parse_fence_start(lines[start])?;
    let mut code_lines = Vec::new();
    let mut index = start + 1;

    while index < lines.len() {
        let trimmed = lines[index].trim_start();
        if trimmed.starts_with(&marker) && trimmed.chars().all(|ch| ch == marker_char(&marker)) {
            return Some((
                Block::Code {
                    lang,
                    text: code_lines.join("\n"),
                },
                index + 1,
            ));
        }
        code_lines.push(lines[index].to_string());
        index += 1;
    }

    Some((
        Block::Code {
            lang,
            text: code_lines.join("\n"),
        },
        index,
    ))
}

fn parse_fence_start(line: &str) -> Option<(String, Option<String>)> {
    let trimmed = line.trim_start();
    let marker_char = trimmed.chars().next()?;
    if marker_char != '`' && marker_char != '~' {
        return None;
    }

    let count = trimmed.chars().take_while(|ch| *ch == marker_char).count();
    if count < 3 {
        return None;
    }

    let marker = marker_char.to_string().repeat(count);
    let rest = trimmed[marker.len()..].trim();
    let lang = (!rest.is_empty()).then(|| rest.to_string());
    Some((marker, lang))
}

fn marker_char(marker: &str) -> char {
    marker.chars().next().unwrap_or('`')
}

fn parse_block_math(lines: &[&str], start: usize) -> Option<(Block, usize)> {
    let trimmed = lines[start].trim();
    let (open, close) = if trimmed.starts_with("$$") {
        ("$$", "$$")
    } else if trimmed.starts_with("\\[") {
        ("\\[", "\\]")
    } else {
        return None;
    };

    let after_open = trimmed[open.len()..].trim();
    if let Some(before_close) = after_open.strip_suffix(close)
        && !before_close.trim().is_empty()
    {
        return Some((Block::Math(before_close.trim().to_string()), start + 1));
    }

    let mut math_lines = Vec::new();
    if !after_open.is_empty() {
        math_lines.push(after_open.to_string());
    }
    let mut index = start + 1;
    while index < lines.len() {
        let current = lines[index].trim();
        if let Some(close_index) = current.find(close) {
            let before_close = current[..close_index].trim();
            if !before_close.is_empty() {
                math_lines.push(before_close.to_string());
            }
            return Some((Block::Math(math_lines.join("\n")), index + 1));
        }
        math_lines.push(lines[index].trim().to_string());
        index += 1;
    }

    None
}

fn starts_block_math(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("$$") || trimmed.starts_with("\\[")
}

fn parse_heading(line: &str) -> Option<(usize, String)> {
    let trimmed = line.trim_start();
    let level = trimmed.chars().take_while(|ch| *ch == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let after_hashes = &trimmed[level..];
    if !after_hashes.chars().next().is_some_and(char::is_whitespace) {
        return None;
    }

    let mut text = after_hashes.trim().to_string();
    while text.ends_with('#') {
        text.pop();
    }
    Some((level, text.trim_end().to_string()))
}

fn is_horizontal_rule(line: &str) -> bool {
    let trimmed = line.trim();
    let mut marker = None;
    let mut count = 0;

    for ch in trimmed.chars() {
        if ch.is_whitespace() {
            continue;
        }
        if ch != '-' && ch != '_' && ch != '*' {
            return false;
        }
        if marker.is_none() {
            marker = Some(ch);
        }
        if marker != Some(ch) {
            return false;
        }
        count += 1;
    }

    count >= 3
}

fn is_blockquote_line(line: &str) -> bool {
    line.trim_start().starts_with('>')
}

fn strip_blockquote_marker(line: &str) -> &str {
    let trimmed = line.trim_start();
    let without_marker = trimmed.strip_prefix('>').unwrap_or(trimmed);
    without_marker.strip_prefix(' ').unwrap_or(without_marker)
}

fn parse_list(lines: &[&str], start: usize) -> Option<(Block, usize)> {
    let first_marker = parse_list_marker(lines[start])?;
    let mut items = Vec::new();
    let mut current_item = first_marker.content.trim().to_string();
    let mut index = start + 1;

    while index < lines.len() {
        let line = lines[index];
        if line.trim().is_empty() {
            break;
        }

        if let Some(marker) = parse_list_marker(line)
            && marker.indent == first_marker.indent
            && marker.ordered == first_marker.ordered
        {
            items.push(ListItem { text: current_item });
            current_item = marker.content.trim().to_string();
            index += 1;
            continue;
        }

        if leading_spaces(line) > first_marker.indent {
            if !current_item.is_empty() {
                current_item.push('\n');
            }
            current_item.push_str(line.trim());
            index += 1;
            continue;
        }

        break;
    }

    items.push(ListItem { text: current_item });
    Some((
        Block::List {
            ordered: first_marker.ordered,
            start: first_marker.number.unwrap_or(1),
            items,
        },
        index,
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ListMarker<'a> {
    indent: usize,
    ordered: bool,
    number: Option<usize>,
    content: &'a str,
}

fn parse_list_marker(line: &str) -> Option<ListMarker<'_>> {
    let indent = leading_spaces(line);
    let trimmed = &line[indent..];
    let mut chars = trimmed.char_indices();
    let (_, first) = chars.next()?;

    if matches!(first, '-' | '*' | '+') {
        let after_marker = &trimmed[first.len_utf8()..];
        if after_marker.chars().next().is_some_and(char::is_whitespace) {
            return Some(ListMarker {
                indent,
                ordered: false,
                number: None,
                content: after_marker.trim_start(),
            });
        }
        return None;
    }

    if !first.is_ascii_digit() {
        return None;
    }

    let marker_end = trimmed
        .char_indices()
        .find_map(|(index, ch)| (ch == '.').then_some(index))?;
    let number = trimmed[..marker_end].parse::<usize>().ok()?;
    let after_marker = &trimmed[marker_end + 1..];
    if !after_marker.chars().next().is_some_and(char::is_whitespace) {
        return None;
    }

    Some(ListMarker {
        indent,
        ordered: true,
        number: Some(number),
        content: after_marker.trim_start(),
    })
}

fn leading_spaces(line: &str) -> usize {
    line.bytes().take_while(|byte| *byte == b' ').count()
}

fn parse_codespan(text: &str) -> Option<(usize, String)> {
    if !text.starts_with('`') {
        return None;
    }
    let tick_count = text.bytes().take_while(|byte| *byte == b'`').count();
    let marker = "`".repeat(tick_count);
    let search_start = tick_count;
    let close = text[search_start..].find(&marker)? + search_start;
    let raw_content = &text[search_start..close];
    let content = if raw_content.starts_with(' ')
        && raw_content.ends_with(' ')
        && raw_content.len() > 1
        && raw_content.trim().contains(' ')
    {
        raw_content[1..raw_content.len() - 1].to_string()
    } else {
        raw_content.to_string()
    };
    Some((close + tick_count, content))
}

fn parse_inline_math(text: &str) -> Option<(usize, String)> {
    for (open, close) in [("$$", "$$"), ("\\[", "\\]"), ("\\(", "\\)")] {
        if let Some(rest) = text.strip_prefix(open)
            && let Some(close_index) = rest.find(close)
        {
            let content = &rest[..close_index];
            if !content.trim().is_empty() {
                return Some((open.len() + close_index + close.len(), content.to_string()));
            }
        }
    }

    let rest = text.strip_prefix('$')?;
    let first = rest.chars().next()?;
    if first.is_whitespace() || first == '$' {
        return None;
    }
    let close_index = rest.find('$')?;
    let content = &rest[..close_index];
    if content.is_empty() || content.ends_with(char::is_whitespace) {
        return None;
    }
    let raw_len = 1 + close_index + 1;
    if text[raw_len..]
        .chars()
        .next()
        .is_some_and(|ch| ch.is_ascii_digit())
    {
        return None;
    }
    Some((raw_len, content.to_string()))
}

fn parse_link(text: &str) -> Option<(usize, String, String)> {
    let rest = text.strip_prefix('[')?;
    let label_end = find_unescaped(rest, ']')?;
    let label = &rest[..label_end];
    let after_label = &rest[label_end + 1..];
    let after_open = after_label.strip_prefix('(')?;
    let close_index = find_unescaped(after_open, ')')?;
    let destination = after_open[..close_index]
        .split_whitespace()
        .next()
        .unwrap_or_default();
    if destination.is_empty() {
        return None;
    }
    Some((
        1 + label_end + 1 + 1 + close_index + 1,
        label.to_string(),
        destination.to_string(),
    ))
}

fn parse_delimited(text: &str, open: &str, close: &str) -> Option<(usize, String)> {
    let rest = text.strip_prefix(open)?;
    if rest.starts_with(char::is_whitespace) {
        return None;
    }
    let close_index = rest.find(close)?;
    let inner = &rest[..close_index];
    if inner.is_empty() || inner.ends_with(char::is_whitespace) {
        return None;
    }
    Some((open.len() + close_index + close.len(), inner.to_string()))
}

fn parse_strikethrough(text: &str) -> Option<(usize, String)> {
    let (raw_len, inner) = parse_delimited(text, "~~", "~~")?;
    if inner.starts_with('~') || inner.ends_with('~') {
        return None;
    }
    Some((raw_len, inner))
}

fn parse_emphasis(text: &str) -> Option<(usize, String)> {
    if text.starts_with("**") || text.starts_with("__") {
        return None;
    }
    if let Some(parsed) = parse_delimited(text, "*", "*") {
        return Some(parsed);
    }
    parse_delimited(text, "_", "_")
}

fn find_unescaped(text: &str, needle: char) -> Option<usize> {
    let mut escaped = false;
    for (index, ch) in text.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == needle {
            return Some(index);
        }
    }
    None
}

fn style_prefix<F>(style_fn: &F) -> String
where
    F: Fn(&str) -> String,
{
    let sentinel = "\0";
    let styled = style_fn(sentinel);
    styled
        .find(sentinel)
        .map_or_else(String::new, |index| styled[..index].to_string())
}

fn pad_and_background(line: &str, width: usize, bg_fn: Option<MarkdownStyleFn>) -> String {
    match bg_fn {
        Some(bg_fn) => apply_background_to_line(line, width, bg_fn),
        None => {
            let padding_needed = width.saturating_sub(visible_width(line));
            format!("{line}{}", " ".repeat(padding_needed))
        }
    }
}

fn next_char(value: &str, index: usize) -> Option<(char, usize)> {
    let ch = value.get(index..)?.chars().next()?;
    Some((ch, index + ch.len_utf8()))
}

fn identity(text: &str) -> String {
    text.to_string()
}

fn ansi_bold(text: &str) -> String {
    format!("\x1b[1m{text}\x1b[0m")
}

fn ansi_italic(text: &str) -> String {
    format!("\x1b[3m{text}\x1b[0m")
}

fn ansi_strikethrough(text: &str) -> String {
    format!("\x1b[9m{text}\x1b[0m")
}

fn ansi_underline(text: &str) -> String {
    format!("\x1b[4m{text}\x1b[0m")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal_image::{ImageProtocol, TerminalCapabilities, set_capabilities};

    fn tag_h(text: &str) -> String {
        format!("<h>{text}</h>")
    }

    fn tag_link(text: &str) -> String {
        format!("<a>{text}</a>")
    }

    fn tag_link_url(text: &str) -> String {
        format!("<url>{text}</url>")
    }

    fn tag_code(text: &str) -> String {
        format!("<c>{text}</c>")
    }

    fn tag_quote(text: &str) -> String {
        format!("<q>{text}</q>")
    }

    fn tag_quote_border(text: &str) -> String {
        format!("<qb>{text}</qb>")
    }

    fn tag_hr(text: &str) -> String {
        format!("<hr>{text}</hr>")
    }

    fn tag_bullet(text: &str) -> String {
        format!("<b>{text}</b>")
    }

    fn tag_bold(text: &str) -> String {
        format!("<strong>{text}</strong>")
    }

    fn tag_italic(text: &str) -> String {
        format!("<em>{text}</em>")
    }

    fn tag_strike(text: &str) -> String {
        format!("<del>{text}</del>")
    }

    fn tag_under(text: &str) -> String {
        format!("<u>{text}</u>")
    }

    fn red_bg(text: &str) -> String {
        format!("\x1b[41m{text}\x1b[0m")
    }

    fn test_theme() -> MarkdownTheme {
        MarkdownTheme {
            heading: tag_h,
            link: tag_link,
            link_url: tag_link_url,
            code: tag_code,
            code_block: tag_code,
            code_block_border: identity,
            quote: tag_quote,
            quote_border: tag_quote_border,
            hr: tag_hr,
            list_bullet: tag_bullet,
            bold: tag_bold,
            italic: tag_italic,
            strikethrough: tag_strike,
            underline: tag_under,
            highlight_code: None,
            code_block_indent: "  ".to_string(),
            math: Some(tag_code),
            math_block: Some(tag_code),
        }
    }

    #[test]
    fn empty_padding_and_cache_invalidation() {
        let mut markdown = Markdown::with_default_theme("", 1, 1);

        assert_eq!(markdown.render(20), Vec::<String>::new());
        assert_eq!(markdown.cached_lines(20), Some(&[][..]));

        markdown.set_text("hello");
        assert!(markdown.cached_lines(20).is_none());
        assert_eq!(
            markdown.render(8),
            vec![
                "        ".to_string(),
                " hello  ".to_string(),
                "        ".to_string()
            ]
        );
        assert_eq!(
            markdown.cached_lines(8),
            Some(
                &[
                    "        ".to_string(),
                    " hello  ".to_string(),
                    "        ".to_string()
                ][..]
            )
        );

        markdown.invalidate();
        assert!(markdown.cached_lines(8).is_none());
    }

    #[test]
    fn paragraph_wraps_and_adds_padding() {
        let mut markdown = Markdown::with_default_theme("alpha beta gamma", 1, 1);
        let lines = markdown.render(12);

        assert_eq!(
            lines,
            vec![
                " ".repeat(12),
                " alpha beta ".to_string(),
                " gamma      ".to_string(),
                " ".repeat(12),
            ]
        );
        for line in lines {
            assert_eq!(visible_width(&line), 12);
        }
    }

    #[test]
    fn renders_headings_lists_quotes_and_hr() {
        let mut markdown = Markdown::new(
            "### Tools\n- one\n- two\n\n> quoted\n\n---",
            0,
            0,
            test_theme(),
            None,
        );
        let lines = markdown.render(80);

        assert!(
            lines
                .iter()
                .any(|line| line.contains("<h><strong>### </strong></h>"))
        );
        assert!(lines.iter().any(|line| line.contains("<b>- </b>one")));
        assert!(lines.iter().any(|line| line.contains("<qb>│ </qb>")));
        assert!(lines.iter().any(|line| line.contains("<hr>")));
    }

    #[test]
    fn renders_fenced_code_blocks_with_indent() {
        let mut markdown = Markdown::new("```rust\nlet x = 1;\n```", 0, 0, test_theme(), None);
        let lines = markdown.render(80);

        assert_eq!(lines[0].trim_end(), "  <c>let x = 1;</c>");
    }

    #[test]
    fn renders_inline_styles_code_and_links() {
        set_capabilities(TerminalCapabilities {
            images: Some(ImageProtocol::Kitty),
            true_color: true,
            hyperlinks: false,
        });
        let mut markdown = Markdown::new(
            "**bold** *em* ~~gone~~ <u>under</u> `code` [site](https://example.com)",
            0,
            0,
            test_theme(),
            None,
        );
        let output = markdown.render(200).join("\n");

        assert!(output.contains("<strong>bold</strong>"));
        assert!(output.contains("<em>em</em>"));
        assert!(output.contains("<del>gone</del>"));
        assert!(output.contains("<u>under</u>"));
        assert!(output.contains("<c>code</c>"));
        assert!(output.contains("<a><u>site</u></a><url> (https://example.com)</url>"));
    }

    #[test]
    fn converts_inline_and_block_math() {
        let mut markdown = Markdown::new(
            "Inline $\\alpha_1$.\n\n$$\ny_t = \\sum_{k=0}^{W-1} x_k\n$$",
            0,
            0,
            test_theme(),
            None,
        );
        let output = markdown.render(120).join("\n");

        assert!(output.contains("<c>α₁</c>"));
        assert!(output.contains("<c>yₜ = ∑ₖ₌₀ᵂ⁻¹ xₖ</c>"));
    }

    #[test]
    fn normalizes_tabs_to_three_spaces() {
        let mut markdown = Markdown::with_default_theme("a\tb", 0, 0);
        let lines = markdown.render(10);

        assert_eq!(lines, vec!["a   b     ".to_string()]);
        assert!(!lines[0].contains('\t'));
    }

    #[test]
    fn background_padding_extends_to_requested_width() {
        let mut markdown = Markdown::new(
            "hi",
            1,
            1,
            MarkdownTheme::default(),
            Some(DefaultTextStyle {
                bg_color: Some(red_bg),
                ..Default::default()
            }),
        );
        let lines = markdown.render(8);

        assert_eq!(lines.len(), 3);
        for line in lines {
            assert_eq!(visible_width(&line), 8);
            assert!(line.starts_with("\x1b[41m"));
            assert!(line.ends_with("\x1b[0m"));
        }
    }
}
