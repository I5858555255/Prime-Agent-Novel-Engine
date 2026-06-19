const ANSI_COLORS: [&str; 16] = [
    "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
    "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
];

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct TextStyle {
    fg: Option<String>,
    bg: Option<String>,
    bold: bool,
    dim: bool,
    italic: bool,
    underline: bool,
    inverse: bool,
    strikethrough: bool,
}

impl TextStyle {
    fn reset(&mut self) {
        *self = Self::default();
    }

    fn has_style(&self) -> bool {
        self.fg.is_some()
            || self.bg.is_some()
            || self.bold
            || self.dim
            || self.italic
            || self.underline
            || self.inverse
            || self.strikethrough
    }
}

fn color256_to_hex(index: u32) -> String {
    if index < 16 {
        return ANSI_COLORS[index as usize].to_string();
    }

    if index < 232 {
        let cube_index = index - 16;
        let r = cube_index / 36;
        let g = (cube_index % 36) / 6;
        let b = cube_index % 6;
        return format!(
            "#{:02x}{:02x}{:02x}",
            color_cube_component(r),
            color_cube_component(g),
            color_cube_component(b)
        );
    }

    let gray = 8_u64 + u64::from(index - 232) * 10;
    let gray_hex = format!("{gray:02x}");
    format!("#{gray_hex}{gray_hex}{gray_hex}")
}

fn color_cube_component(value: u32) -> u32 {
    if value == 0 { 0 } else { 55 + value * 40 }
}

fn escape_html(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#039;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

fn style_to_inline_css(style: &TextStyle) -> String {
    let mut parts = Vec::new();
    let mut fg = style.fg.as_deref();
    let mut bg = style.bg.as_deref();

    if style.inverse {
        std::mem::swap(&mut fg, &mut bg);
    }

    if let Some(fg) = fg {
        parts.push(format!("color:{fg}"));
    }
    if let Some(bg) = bg {
        parts.push(format!("background-color:{bg}"));
    }
    if style.bold {
        parts.push("font-weight:bold".to_string());
    }
    if style.dim {
        parts.push("opacity:0.6".to_string());
    }
    if style.italic {
        parts.push("font-style:italic".to_string());
    }

    let mut text_decorations = Vec::new();
    if style.underline {
        text_decorations.push("underline");
    }
    if style.strikethrough {
        text_decorations.push("line-through");
    }
    if !text_decorations.is_empty() {
        parts.push(format!("text-decoration:{}", text_decorations.join(" ")));
    }

    if style.inverse && fg.is_none() && bg.is_none() {
        parts.push("filter:invert(100%)".to_string());
    }

    parts.join(";")
}

fn apply_sgr_codes(params: &[u32], style: &mut TextStyle) {
    let mut i = 0;
    while i < params.len() {
        match params[i] {
            0 => style.reset(),
            1 => style.bold = true,
            2 => style.dim = true,
            3 => style.italic = true,
            4 => style.underline = true,
            7 => style.inverse = true,
            9 => style.strikethrough = true,
            22 => {
                style.bold = false;
                style.dim = false;
            }
            23 => style.italic = false,
            24 => style.underline = false,
            27 => style.inverse = false,
            29 => style.strikethrough = false,
            30..=37 => style.fg = Some(ANSI_COLORS[(params[i] - 30) as usize].to_string()),
            38 => {
                if params.get(i + 1) == Some(&5) && params.len() > i + 2 {
                    style.fg = Some(color256_to_hex(params[i + 2]));
                    i += 2;
                } else if params.get(i + 1) == Some(&2) && params.len() > i + 4 {
                    style.fg = Some(format!(
                        "rgb({},{},{})",
                        params[i + 2],
                        params[i + 3],
                        params[i + 4]
                    ));
                    i += 4;
                }
            }
            39 => style.fg = None,
            40..=47 => style.bg = Some(ANSI_COLORS[(params[i] - 40) as usize].to_string()),
            48 => {
                if params.get(i + 1) == Some(&5) && params.len() > i + 2 {
                    style.bg = Some(color256_to_hex(params[i + 2]));
                    i += 2;
                } else if params.get(i + 1) == Some(&2) && params.len() > i + 4 {
                    style.bg = Some(format!(
                        "rgb({},{},{})",
                        params[i + 2],
                        params[i + 3],
                        params[i + 4]
                    ));
                    i += 4;
                }
            }
            49 => style.bg = None,
            90..=97 => style.fg = Some(ANSI_COLORS[(params[i] - 90 + 8) as usize].to_string()),
            100..=107 => style.bg = Some(ANSI_COLORS[(params[i] - 100 + 8) as usize].to_string()),
            _ => {}
        }

        i += 1;
    }
}

fn parse_sgr_params(params: &str) -> Vec<u32> {
    if params.is_empty() {
        return vec![0];
    }

    params
        .split(';')
        .map(|param| param.parse::<u32>().unwrap_or(0))
        .collect()
}

fn find_sgr_sequence(input: &str, start: usize) -> Option<(usize, usize)> {
    let params_start = start + "\x1b[".len();

    for (offset, ch) in input[params_start..].char_indices() {
        if ch == 'm' {
            return Some((params_start, params_start + offset));
        }

        if ch != ';' && !ch.is_ascii_digit() {
            return None;
        }
    }

    None
}

/// Convert ANSI SGR-escaped text to HTML with inline styles.
pub fn ansi_to_html(text: &str) -> String {
    let mut style = TextStyle::default();
    let mut result = String::new();
    let mut cursor = 0;
    let mut in_span = false;

    while let Some(relative_start) = text[cursor..].find("\x1b[") {
        let start = cursor + relative_start;
        let Some((params_start, params_end)) = find_sgr_sequence(text, start) else {
            result.push_str(&escape_html(&text[cursor..start + 1]));
            cursor = start + 1;
            continue;
        };

        if start > cursor {
            result.push_str(&escape_html(&text[cursor..start]));
        }

        if in_span {
            result.push_str("</span>");
            in_span = false;
        }

        let params = parse_sgr_params(&text[params_start..params_end]);
        apply_sgr_codes(&params, &mut style);

        if style.has_style() {
            result.push_str("<span style=\"");
            result.push_str(&style_to_inline_css(&style));
            result.push_str("\">");
            in_span = true;
        }

        cursor = params_end + 1;
    }

    if cursor < text.len() {
        result.push_str(&escape_html(&text[cursor..]));
    }

    if in_span {
        result.push_str("</span>");
    }

    result
}

/// Convert ANSI-escaped lines to HTML, wrapping each line in a div.
pub fn ansi_lines_to_html<T: AsRef<str>>(lines: &[T]) -> String {
    lines
        .iter()
        .map(|line| {
            let html = ansi_to_html(line.as_ref());
            let content = if html.is_empty() { "&nbsp;" } else { &html };
            format!("<div class=\"ansi-line\">{content}</div>")
        })
        .collect()
}
