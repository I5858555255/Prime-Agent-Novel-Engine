#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnsiCode {
    pub code: String,
    pub length: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextSlice {
    pub text: String,
    pub width: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedSegments {
    pub before: String,
    pub before_width: usize,
    pub after: String,
    pub after_width: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Osc8Terminator {
    Bel,
    St,
}

impl Osc8Terminator {
    fn as_str(self) -> &'static str {
        match self {
            Self::Bel => "\x07",
            Self::St => "\x1b\\",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ActiveHyperlink {
    params: String,
    url: String,
    terminator: Osc8Terminator,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct AnsiCodeTracker {
    bold: bool,
    dim: bool,
    italic: bool,
    underline: bool,
    blink: bool,
    inverse: bool,
    hidden: bool,
    strikethrough: bool,
    fg_color: Option<String>,
    bg_color: Option<String>,
    active_hyperlink: Option<ActiveHyperlink>,
}

impl AnsiCodeTracker {
    fn process(&mut self, ansi_code: &str) {
        if let Some(hyperlink) = parse_osc8_hyperlink(ansi_code) {
            self.active_hyperlink = hyperlink;
            return;
        }

        if !ansi_code.ends_with('m') {
            return;
        }

        let Some(params) = ansi_code
            .strip_prefix("\x1b[")
            .and_then(|code| code.strip_suffix('m'))
        else {
            return;
        };

        if params.is_empty() || params == "0" {
            self.reset();
            return;
        }

        let parts = params.split(';').collect::<Vec<_>>();
        let mut i = 0;
        while i < parts.len() {
            let Ok(code) = parts[i].parse::<u16>() else {
                i += 1;
                continue;
            };

            if code == 38 || code == 48 {
                if parts.get(i + 1) == Some(&"5") && parts.get(i + 2).is_some() {
                    let color_code = format!("{};{};{}", parts[i], parts[i + 1], parts[i + 2]);
                    if code == 38 {
                        self.fg_color = Some(color_code);
                    } else {
                        self.bg_color = Some(color_code);
                    }
                    i += 3;
                    continue;
                }

                if parts.get(i + 1) == Some(&"2") && parts.get(i + 4).is_some() {
                    let color_code = format!(
                        "{};{};{};{};{}",
                        parts[i],
                        parts[i + 1],
                        parts[i + 2],
                        parts[i + 3],
                        parts[i + 4]
                    );
                    if code == 38 {
                        self.fg_color = Some(color_code);
                    } else {
                        self.bg_color = Some(color_code);
                    }
                    i += 5;
                    continue;
                }
            }

            match code {
                0 => self.reset(),
                1 => self.bold = true,
                2 => self.dim = true,
                3 => self.italic = true,
                4 => self.underline = true,
                5 => self.blink = true,
                7 => self.inverse = true,
                8 => self.hidden = true,
                9 => self.strikethrough = true,
                21 => self.bold = false,
                22 => {
                    self.bold = false;
                    self.dim = false;
                }
                23 => self.italic = false,
                24 => self.underline = false,
                25 => self.blink = false,
                27 => self.inverse = false,
                28 => self.hidden = false,
                29 => self.strikethrough = false,
                39 => self.fg_color = None,
                49 => self.bg_color = None,
                30..=37 | 90..=97 => self.fg_color = Some(code.to_string()),
                40..=47 | 100..=107 => self.bg_color = Some(code.to_string()),
                _ => {}
            }
            i += 1;
        }
    }

    fn reset(&mut self) {
        self.bold = false;
        self.dim = false;
        self.italic = false;
        self.underline = false;
        self.blink = false;
        self.inverse = false;
        self.hidden = false;
        self.strikethrough = false;
        self.fg_color = None;
        self.bg_color = None;
        // SGR reset intentionally does not close OSC 8 hyperlinks.
    }

    fn clear(&mut self) {
        self.reset();
        self.active_hyperlink = None;
    }

    fn get_active_codes(&self) -> String {
        let mut codes = Vec::new();
        if self.bold {
            codes.push("1".to_string());
        }
        if self.dim {
            codes.push("2".to_string());
        }
        if self.italic {
            codes.push("3".to_string());
        }
        if self.underline {
            codes.push("4".to_string());
        }
        if self.blink {
            codes.push("5".to_string());
        }
        if self.inverse {
            codes.push("7".to_string());
        }
        if self.hidden {
            codes.push("8".to_string());
        }
        if self.strikethrough {
            codes.push("9".to_string());
        }
        if let Some(fg_color) = &self.fg_color {
            codes.push(fg_color.clone());
        }
        if let Some(bg_color) = &self.bg_color {
            codes.push(bg_color.clone());
        }

        let mut result = if codes.is_empty() {
            String::new()
        } else {
            format!("\x1b[{}m", codes.join(";"))
        };

        if let Some(hyperlink) = &self.active_hyperlink {
            result.push_str(&format_osc8_hyperlink(hyperlink));
        }

        result
    }

    fn get_line_end_reset(&self) -> String {
        let mut result = String::new();
        if self.underline {
            result.push_str("\x1b[24m");
        }
        if let Some(hyperlink) = &self.active_hyperlink {
            result.push_str(&format_osc8_close(hyperlink.terminator));
        }
        result
    }
}

fn parse_osc8_hyperlink(ansi_code: &str) -> Option<Option<ActiveHyperlink>> {
    if !ansi_code.starts_with("\x1b]8;") {
        return None;
    }

    let terminator = if ansi_code.ends_with('\x07') {
        Osc8Terminator::Bel
    } else {
        Osc8Terminator::St
    };
    let terminator_len = match terminator {
        Osc8Terminator::Bel => 1,
        Osc8Terminator::St => 2,
    };
    if ansi_code.len() < 4 + terminator_len {
        return None;
    }

    let body = &ansi_code[4..ansi_code.len() - terminator_len];
    let separator_index = body.find(';')?;
    let params = &body[..separator_index];
    let url = &body[separator_index + 1..];
    if url.is_empty() {
        return Some(None);
    }

    Some(Some(ActiveHyperlink {
        params: params.to_string(),
        url: url.to_string(),
        terminator,
    }))
}

fn format_osc8_hyperlink(hyperlink: &ActiveHyperlink) -> String {
    format!(
        "\x1b]8;{};{}{}",
        hyperlink.params,
        hyperlink.url,
        hyperlink.terminator.as_str()
    )
}

fn format_osc8_close(terminator: Osc8Terminator) -> String {
    format!("\x1b]8;;{}", terminator.as_str())
}

fn is_printable_ascii(value: &str) -> bool {
    value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

fn next_char(value: &str, index: usize) -> Option<(char, usize)> {
    let ch = value.get(index..)?.chars().next()?;
    Some((ch, index + ch.len_utf8()))
}

fn next_grapheme_end(value: &str, start: usize) -> usize {
    let Some((first, mut end)) = next_char(value, start) else {
        return start;
    };

    if first == '\r'
        && let Some(('\n', next)) = next_char(value, end)
    {
        return next;
    }

    if is_regional_indicator(first) {
        if let Some((next, next_end)) = next_char(value, end)
            && is_regional_indicator(next)
        {
            return next_end;
        }
        return end;
    }

    while let Some((ch, next)) = next_char(value, end) {
        if is_combining_mark(ch)
            || is_variation_selector(ch)
            || is_emoji_modifier(ch)
            || ch == '\u{20e3}'
        {
            end = next;
            continue;
        }

        if ch == '\u{200d}' {
            end = next;
            if let Some((_, after_joiner)) = next_char(value, end) {
                end = after_joiner;
                while let Some((joined_mark, mark_end)) = next_char(value, end) {
                    if is_combining_mark(joined_mark)
                        || is_variation_selector(joined_mark)
                        || is_emoji_modifier(joined_mark)
                    {
                        end = mark_end;
                    } else {
                        break;
                    }
                }
            }
            continue;
        }

        break;
    }

    end
}

fn grapheme_width(segment: &str) -> usize {
    if segment.is_empty() || segment.chars().all(is_zero_width_char) {
        return 0;
    }

    if is_emoji_cluster(segment) {
        return 2;
    }

    segment.chars().map(char_width).sum()
}

fn char_width(ch: char) -> usize {
    let cp = ch as u32;
    if is_zero_width_char(ch) {
        0
    } else if cp == 0x0e33 || cp == 0x0eb3 {
        1
    } else if is_regional_indicator(ch) || is_emoji_wide(cp) || is_wide_east_asian(cp) {
        2
    } else {
        1
    }
}

fn is_emoji_cluster(segment: &str) -> bool {
    let mut chars = segment.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    let first_cp = first as u32;
    is_regional_indicator(first)
        || is_emoji_wide(first_cp)
        || segment.contains('\u{fe0f}')
        || segment.contains('\u{200d}')
        || segment.chars().any(is_emoji_modifier)
}

fn is_zero_width_char(ch: char) -> bool {
    let cp = ch as u32;
    cp <= 0x1f
        || (0x7f..=0x9f).contains(&cp)
        || is_combining_mark(ch)
        || is_variation_selector(ch)
        || cp == 0x00ad
        || (0x061c..=0x061c).contains(&cp)
        || (0x180b..=0x180f).contains(&cp)
        || (0x200b..=0x200f).contains(&cp)
        || (0x202a..=0x202e).contains(&cp)
        || (0x2060..=0x206f).contains(&cp)
        || (0xfeff..=0xfeff).contains(&cp)
        || (0xe0000..=0xe0fff).contains(&cp)
}

fn is_combining_mark(ch: char) -> bool {
    let cp = ch as u32;
    matches!(
        cp,
        0x0300..=0x036f
            | 0x0483..=0x0489
            | 0x0591..=0x05bd
            | 0x05bf
            | 0x05c1..=0x05c2
            | 0x05c4..=0x05c5
            | 0x05c7
            | 0x0610..=0x061a
            | 0x064b..=0x065f
            | 0x0670
            | 0x06d6..=0x06dc
            | 0x06df..=0x06e4
            | 0x06e7..=0x06e8
            | 0x06ea..=0x06ed
            | 0x0711
            | 0x0730..=0x074a
            | 0x07a6..=0x07b0
            | 0x07eb..=0x07f3
            | 0x0816..=0x0819
            | 0x081b..=0x0823
            | 0x0825..=0x0827
            | 0x0829..=0x082d
            | 0x0859..=0x085b
            | 0x08d3..=0x08e1
            | 0x08e3..=0x0903
            | 0x093a
            | 0x093c
            | 0x0941..=0x0948
            | 0x094d
            | 0x0951..=0x0957
            | 0x0962..=0x0963
            | 0x0981
            | 0x09bc
            | 0x09c1..=0x09c4
            | 0x09cd
            | 0x09e2..=0x09e3
            | 0x0a01..=0x0a02
            | 0x0a3c
            | 0x0a41..=0x0a42
            | 0x0a47..=0x0a48
            | 0x0a4b..=0x0a4d
            | 0x0a51
            | 0x0a70..=0x0a71
            | 0x0a75
            | 0x0a81..=0x0a82
            | 0x0abc
            | 0x0ac1..=0x0ac5
            | 0x0ac7..=0x0ac8
            | 0x0acd
            | 0x0ae2..=0x0ae3
            | 0x0afa..=0x0aff
            | 0x0b01
            | 0x0b3c
            | 0x0b3f
            | 0x0b41..=0x0b44
            | 0x0b4d
            | 0x0b55..=0x0b56
            | 0x0b62..=0x0b63
            | 0x0b82
            | 0x0bc0
            | 0x0bcd
            | 0x0c00
            | 0x0c04
            | 0x0c3e..=0x0c40
            | 0x0c46..=0x0c48
            | 0x0c4a..=0x0c4d
            | 0x0c55..=0x0c56
            | 0x0c62..=0x0c63
            | 0x0c81
            | 0x0cbc
            | 0x0cbf
            | 0x0cc6
            | 0x0ccc..=0x0ccd
            | 0x0ce2..=0x0ce3
            | 0x0d00..=0x0d01
            | 0x0d3b..=0x0d3c
            | 0x0d41..=0x0d44
            | 0x0d4d
            | 0x0d62..=0x0d63
            | 0x0d81
            | 0x0dca
            | 0x0dd2..=0x0dd4
            | 0x0dd6
            | 0x0e31
            | 0x0e34..=0x0e3a
            | 0x0e47..=0x0e4e
            | 0x0eb1
            | 0x0eb4..=0x0ebc
            | 0x0ec8..=0x0ecd
            | 0x0f18..=0x0f19
            | 0x0f35
            | 0x0f37
            | 0x0f39
            | 0x0f71..=0x0f7e
            | 0x0f80..=0x0f84
            | 0x0f86..=0x0f87
            | 0x0f8d..=0x0f97
            | 0x0f99..=0x0fbc
            | 0x0fc6
            | 0x102d..=0x1030
            | 0x1032..=0x1037
            | 0x1039..=0x103a
            | 0x103d..=0x103e
            | 0x1058..=0x1059
            | 0x105e..=0x1060
            | 0x1071..=0x1074
            | 0x1082
            | 0x1085..=0x1086
            | 0x108d
            | 0x109d
            | 0x135d..=0x135f
            | 0x1712..=0x1714
            | 0x1732..=0x1734
            | 0x1752..=0x1753
            | 0x1772..=0x1773
            | 0x17b4..=0x17b5
            | 0x17b7..=0x17bd
            | 0x17c6
            | 0x17c9..=0x17d3
            | 0x17dd
            | 0x180b..=0x180d
            | 0x1885..=0x1886
            | 0x18a9
            | 0x1920..=0x1922
            | 0x1927..=0x1928
            | 0x1932
            | 0x1939..=0x193b
            | 0x1a17..=0x1a18
            | 0x1a1b
            | 0x1a56
            | 0x1a58..=0x1a5e
            | 0x1a60
            | 0x1a62
            | 0x1a65..=0x1a6c
            | 0x1a73..=0x1a7c
            | 0x1a7f
            | 0x1ab0..=0x1aff
            | 0x1b00..=0x1b03
            | 0x1b34
            | 0x1b36..=0x1b3a
            | 0x1b3c
            | 0x1b42
            | 0x1b6b..=0x1b73
            | 0x1b80..=0x1b81
            | 0x1ba2..=0x1ba5
            | 0x1ba8..=0x1ba9
            | 0x1bab..=0x1bad
            | 0x1be6
            | 0x1be8..=0x1be9
            | 0x1bed
            | 0x1bef..=0x1bf1
            | 0x1c2c..=0x1c33
            | 0x1c36..=0x1c37
            | 0x1cd0..=0x1cd2
            | 0x1cd4..=0x1ce0
            | 0x1ce2..=0x1ce8
            | 0x1ced
            | 0x1cf4
            | 0x1cf8..=0x1cf9
            | 0x1dc0..=0x1dff
            | 0x20d0..=0x20ff
            | 0x2cef..=0x2cf1
            | 0x2d7f
            | 0x2de0..=0x2dff
            | 0x302a..=0x302f
            | 0x3099..=0x309a
            | 0xa66f
            | 0xa674..=0xa67d
            | 0xa69e..=0xa69f
            | 0xa6f0..=0xa6f1
            | 0xa802
            | 0xa806
            | 0xa80b
            | 0xa825..=0xa826
            | 0xa8c4
            | 0xa8e0..=0xa8f1
            | 0xa8ff
            | 0xa926..=0xa92d
            | 0xa947..=0xa951
            | 0xa980..=0xa982
            | 0xa9b3
            | 0xa9b6..=0xa9b9
            | 0xa9bc
            | 0xa9e5
            | 0xaa29..=0xaa2e
            | 0xaa31..=0xaa32
            | 0xaa35..=0xaa36
            | 0xaa43
            | 0xaa4c
            | 0xaa7c
            | 0xaab0
            | 0xaab2..=0xaab4
            | 0xaab7..=0xaab8
            | 0xaabe..=0xaabf
            | 0xaac1
            | 0xaaec..=0xaaed
            | 0xaaf6
            | 0xabe5
            | 0xabe8
            | 0xabed
            | 0xfb1e
            | 0xfe20..=0xfe2f
    )
}

fn is_variation_selector(ch: char) -> bool {
    let cp = ch as u32;
    (0xfe00..=0xfe0f).contains(&cp) || (0xe0100..=0xe01ef).contains(&cp)
}

fn is_emoji_modifier(ch: char) -> bool {
    let cp = ch as u32;
    (0x1f3fb..=0x1f3ff).contains(&cp)
}

fn is_regional_indicator(ch: char) -> bool {
    let cp = ch as u32;
    (0x1f1e6..=0x1f1ff).contains(&cp)
}

fn is_emoji_wide(cp: u32) -> bool {
    matches!(
        cp,
        0x1f000..=0x1faff | 0x2300..=0x23ff | 0x2600..=0x27bf | 0x2b50..=0x2b55
    )
}

fn is_wide_east_asian(cp: u32) -> bool {
    matches!(
        cp,
        0x1100..=0x115f
            | 0x2329..=0x232a
            | 0x2e80..=0xa4cf
            | 0xac00..=0xd7a3
            | 0xf900..=0xfaff
            | 0xfe10..=0xfe19
            | 0xfe30..=0xfe6f
            | 0xff00..=0xff60
            | 0xffe0..=0xffe6
            | 0x20000..=0x3fffd
    ) && cp != 0x303f
}

fn push_graphemes_from_text_portion(mut text: &str, output: &mut Vec<WordSegment>) {
    while !text.is_empty() {
        let end = next_grapheme_end(text, 0);
        output.push(WordSegment::Grapheme(text[..end].to_string()));
        text = &text[end..];
    }
}

fn update_tracker_from_text(text: &str, tracker: &mut AnsiCodeTracker) {
    let mut i = 0;
    while i < text.len() {
        if let Some(ansi) = extract_ansi_code(text, i) {
            tracker.process(&ansi.code);
            i += ansi.length;
        } else if let Some((_, next)) = next_char(text, i) {
            i = next;
        } else {
            break;
        }
    }
}

fn split_into_tokens_with_ansi(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut pending_ansi = String::new();
    let mut in_whitespace = false;
    let mut i = 0;

    while i < text.len() {
        if let Some(ansi) = extract_ansi_code(text, i) {
            pending_ansi.push_str(&ansi.code);
            i += ansi.length;
            continue;
        }

        let Some((ch, next)) = next_char(text, i) else {
            break;
        };
        let char_is_space = ch == ' ';

        if char_is_space != in_whitespace && !current.is_empty() {
            tokens.push(current);
            current = String::new();
        }

        if !pending_ansi.is_empty() {
            current.push_str(&pending_ansi);
            pending_ansi.clear();
        }

        in_whitespace = char_is_space;
        current.push(ch);
        i = next;
    }

    if !pending_ansi.is_empty() {
        current.push_str(&pending_ansi);
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

enum WordSegment {
    Ansi(String),
    Grapheme(String),
}

fn break_long_word(word: &str, width: usize, tracker: &mut AnsiCodeTracker) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current_line = tracker.get_active_codes();
    let mut current_width = 0;
    let mut segments = Vec::new();
    let mut i = 0;

    while i < word.len() {
        if let Some(ansi) = extract_ansi_code(word, i) {
            segments.push(WordSegment::Ansi(ansi.code));
            i += ansi.length;
        } else {
            let mut end = i;
            while end < word.len() {
                if extract_ansi_code(word, end).is_some() {
                    break;
                }
                let Some((_, next)) = next_char(word, end) else {
                    break;
                };
                end = next;
            }
            push_graphemes_from_text_portion(&word[i..end], &mut segments);
            i = end;
        }
    }

    for segment in segments {
        match segment {
            WordSegment::Ansi(code) => {
                current_line.push_str(&code);
                tracker.process(&code);
            }
            WordSegment::Grapheme(grapheme) => {
                if grapheme.is_empty() {
                    continue;
                }

                let width_for_grapheme = visible_width(&grapheme);
                if current_width + width_for_grapheme > width {
                    let line_end_reset = tracker.get_line_end_reset();
                    if !line_end_reset.is_empty() {
                        current_line.push_str(&line_end_reset);
                    }
                    lines.push(current_line);
                    current_line = tracker.get_active_codes();
                    current_width = 0;
                }

                current_line.push_str(&grapheme);
                current_width += width_for_grapheme;
            }
        }
    }

    if !current_line.is_empty() {
        lines.push(current_line);
    }

    if lines.is_empty() {
        vec![String::new()]
    } else {
        lines
    }
}

fn wrap_single_line(line: &str, width: usize) -> Vec<String> {
    if line.is_empty() {
        return vec![String::new()];
    }

    if width == 0 {
        return vec![String::new()];
    }

    let visible_length = visible_width(line);
    if visible_length <= width {
        return vec![line.to_string()];
    }

    let mut wrapped = Vec::new();
    let mut tracker = AnsiCodeTracker::default();
    let tokens = split_into_tokens_with_ansi(line);
    let mut current_line = String::new();
    let mut current_visible_length = 0;

    for token in tokens {
        let token_visible_length = visible_width(&token);
        let is_whitespace = token.trim().is_empty();

        if token_visible_length > width && !is_whitespace {
            if !current_line.is_empty() {
                let line_end_reset = tracker.get_line_end_reset();
                if !line_end_reset.is_empty() {
                    current_line.push_str(&line_end_reset);
                }
                wrapped.push(current_line);
                current_line = String::new();
            }

            let broken = break_long_word(&token, width, &mut tracker);
            if let Some((last, leading)) = broken.split_last() {
                wrapped.extend(leading.iter().cloned());
                current_line = last.clone();
                current_visible_length = visible_width(&current_line);
            }
            continue;
        }

        let total_needed = current_visible_length + token_visible_length;
        if total_needed > width && current_visible_length > 0 {
            let mut line_to_wrap = current_line.trim_end().to_string();
            let line_end_reset = tracker.get_line_end_reset();
            if !line_end_reset.is_empty() {
                line_to_wrap.push_str(&line_end_reset);
            }
            wrapped.push(line_to_wrap);

            if is_whitespace {
                current_line = tracker.get_active_codes();
                current_visible_length = 0;
            } else {
                current_line = tracker.get_active_codes();
                current_line.push_str(&token);
                current_visible_length = token_visible_length;
            }
        } else {
            current_line.push_str(&token);
            current_visible_length += token_visible_length;
        }

        update_tracker_from_text(&token, &mut tracker);
    }

    if !current_line.is_empty() {
        wrapped.push(current_line);
    }

    if wrapped.is_empty() {
        vec![String::new()]
    } else {
        wrapped
            .into_iter()
            .map(|line| line.trim_end().to_string())
            .collect()
    }
}

fn truncate_fragment_to_width(text: &str, max_width: usize) -> TextSlice {
    if max_width == 0 || text.is_empty() {
        return TextSlice {
            text: String::new(),
            width: 0,
        };
    }

    if is_printable_ascii(text) {
        let clipped = text[..text.len().min(max_width)].to_string();
        let width = clipped.len();
        return TextSlice {
            text: clipped,
            width,
        };
    }

    let has_ansi = text.contains('\x1b');
    let has_tabs = text.contains('\t');
    if !has_ansi && !has_tabs {
        let mut result = String::new();
        let mut width = 0;
        let mut i = 0;
        while i < text.len() {
            let end = next_grapheme_end(text, i);
            let segment = &text[i..end];
            let segment_width = grapheme_width(segment);
            if width + segment_width > max_width {
                break;
            }
            result.push_str(segment);
            width += segment_width;
            i = end;
        }
        return TextSlice {
            text: result,
            width,
        };
    }

    let mut result = String::new();
    let mut width = 0;
    let mut i = 0;
    let mut pending_ansi = String::new();

    while i < text.len() {
        if let Some(ansi) = extract_ansi_code(text, i) {
            pending_ansi.push_str(&ansi.code);
            i += ansi.length;
            continue;
        }

        if text.as_bytes()[i] == b'\t' {
            if width + 3 > max_width {
                break;
            }
            if !pending_ansi.is_empty() {
                result.push_str(&pending_ansi);
                pending_ansi.clear();
            }
            result.push('\t');
            width += 3;
            i += 1;
            continue;
        }

        let mut end = i;
        while end < text.len() && text.as_bytes()[end] != b'\t' {
            if extract_ansi_code(text, end).is_some() {
                break;
            }
            let Some((_, next)) = next_char(text, end) else {
                break;
            };
            end = next;
        }

        let mut segment_start = i;
        while segment_start < end {
            let segment_end = next_grapheme_end(text, segment_start);
            let segment = &text[segment_start..segment_end];
            let segment_width = grapheme_width(segment);
            if width + segment_width > max_width {
                return TextSlice {
                    text: result,
                    width,
                };
            }
            if !pending_ansi.is_empty() {
                result.push_str(&pending_ansi);
                pending_ansi.clear();
            }
            result.push_str(segment);
            width += segment_width;
            segment_start = segment_end;
        }
        i = end;
    }

    TextSlice {
        text: result,
        width,
    }
}

fn finalize_truncated_result(
    prefix: &str,
    prefix_width: usize,
    ellipsis: &str,
    ellipsis_width: usize,
    max_width: usize,
    pad: bool,
) -> String {
    let reset = "\x1b[0m";
    let visible_width = prefix_width + ellipsis_width;
    let mut result = if ellipsis.is_empty() {
        format!("{prefix}{reset}")
    } else {
        format!("{prefix}{reset}{ellipsis}{reset}")
    };

    if pad {
        result.push_str(&" ".repeat(max_width.saturating_sub(visible_width)));
    }
    result
}

pub fn extract_ansi_code(value: &str, pos: usize) -> Option<AnsiCode> {
    let bytes = value.as_bytes();
    if pos >= bytes.len() || bytes[pos] != 0x1b {
        return None;
    }

    let next = *bytes.get(pos + 1)?;
    if next == b'[' {
        let mut j = pos + 2;
        while j < bytes.len() && !matches!(bytes[j], b'm' | b'G' | b'K' | b'H' | b'J') {
            j += 1;
        }
        if j < bytes.len() {
            return Some(AnsiCode {
                code: value[pos..j + 1].to_string(),
                length: j + 1 - pos,
            });
        }
        return None;
    }

    if next == b']' || next == b'_' {
        let mut j = pos + 2;
        while j < bytes.len() {
            if bytes[j] == 0x07 {
                return Some(AnsiCode {
                    code: value[pos..j + 1].to_string(),
                    length: j + 1 - pos,
                });
            }
            if bytes[j] == 0x1b && bytes.get(j + 1) == Some(&b'\\') {
                return Some(AnsiCode {
                    code: value[pos..j + 2].to_string(),
                    length: j + 2 - pos,
                });
            }
            j += 1;
        }
        return None;
    }

    None
}

pub fn visible_width(value: &str) -> usize {
    if value.is_empty() {
        return 0;
    }

    if is_printable_ascii(value) {
        return value.len();
    }

    let mut width = 0;
    let mut i = 0;
    while i < value.len() {
        if let Some(ansi) = extract_ansi_code(value, i) {
            i += ansi.length;
            continue;
        }

        let Some((ch, next)) = next_char(value, i) else {
            break;
        };
        if ch == '\t' {
            width += 3;
            i = next;
            continue;
        }

        let end = next_grapheme_end(value, i);
        width += grapheme_width(&value[i..end]);
        i = end;
    }

    width
}

pub fn normalize_terminal_output(value: &str) -> String {
    if !value.contains(['\u{0e33}', '\u{0eb3}', '\t']) {
        return value.to_string();
    }

    let mut normalized = String::new();
    for ch in value.chars() {
        match ch {
            '\u{0e33}' => normalized.push_str("\u{0e4d}\u{0e32}"),
            '\u{0eb3}' => normalized.push_str("\u{0ecd}\u{0eb2}"),
            '\t' => normalized.push_str("   "),
            _ => normalized.push(ch),
        }
    }
    normalized
}

pub fn wrap_text_with_ansi(text: &str, width: usize) -> Vec<String> {
    if text.is_empty() {
        return vec![String::new()];
    }

    let input_lines = text.split('\n').collect::<Vec<_>>();
    let mut result = Vec::new();
    let mut tracker = AnsiCodeTracker::default();

    for input_line in input_lines {
        let prefix = if result.is_empty() {
            String::new()
        } else {
            tracker.get_active_codes()
        };
        let line = format!("{prefix}{input_line}");
        result.extend(wrap_single_line(&line, width));
        update_tracker_from_text(input_line, &mut tracker);
    }

    if result.is_empty() {
        vec![String::new()]
    } else {
        result
    }
}

pub fn is_whitespace_char(ch: char) -> bool {
    ch.is_whitespace()
}

pub fn is_punctuation_char(ch: char) -> bool {
    matches!(
        ch,
        '(' | ')'
            | '{'
            | '}'
            | '['
            | ']'
            | '<'
            | '>'
            | '.'
            | ','
            | ';'
            | ':'
            | '\''
            | '"'
            | '!'
            | '?'
            | '+'
            | '-'
            | '='
            | '*'
            | '/'
            | '\\'
            | '|'
            | '&'
            | '%'
            | '^'
            | '$'
            | '#'
            | '@'
            | '~'
            | '`'
    )
}

pub fn apply_background_to_line<F>(line: &str, width: usize, bg_fn: F) -> String
where
    F: FnOnce(&str) -> String,
{
    let visible_len = visible_width(line);
    let padding_needed = width.saturating_sub(visible_len);
    let with_padding = format!("{line}{}", " ".repeat(padding_needed));
    bg_fn(&with_padding)
}

pub fn truncate_to_width(text: &str, max_width: usize, ellipsis: &str, pad: bool) -> String {
    if max_width == 0 {
        return String::new();
    }

    if text.is_empty() {
        return if pad {
            " ".repeat(max_width)
        } else {
            String::new()
        };
    }

    let ellipsis_width = visible_width(ellipsis);
    if ellipsis_width >= max_width {
        let text_width = visible_width(text);
        if text_width <= max_width {
            return if pad {
                format!("{text}{}", " ".repeat(max_width - text_width))
            } else {
                text.to_string()
            };
        }

        let clipped_ellipsis = truncate_fragment_to_width(ellipsis, max_width);
        if clipped_ellipsis.width == 0 {
            return if pad {
                " ".repeat(max_width)
            } else {
                String::new()
            };
        }
        return finalize_truncated_result(
            "",
            0,
            &clipped_ellipsis.text,
            clipped_ellipsis.width,
            max_width,
            pad,
        );
    }

    if is_printable_ascii(text) {
        if text.len() <= max_width {
            return if pad {
                format!("{text}{}", " ".repeat(max_width - text.len()))
            } else {
                text.to_string()
            };
        }
        let target_width = max_width - ellipsis_width;
        return finalize_truncated_result(
            &text[..target_width],
            target_width,
            ellipsis,
            ellipsis_width,
            max_width,
            pad,
        );
    }

    let target_width = max_width - ellipsis_width;
    let mut result = String::new();
    let mut pending_ansi = String::new();
    let mut visible_so_far = 0;
    let mut kept_width = 0;
    let mut keep_contiguous_prefix = true;
    let mut overflowed = false;
    let exhausted_input;
    let has_ansi = text.contains('\x1b');
    let has_tabs = text.contains('\t');

    if !has_ansi && !has_tabs {
        let mut i = 0;
        while i < text.len() {
            let end = next_grapheme_end(text, i);
            let segment = &text[i..end];
            let width = grapheme_width(segment);
            if keep_contiguous_prefix && kept_width + width <= target_width {
                result.push_str(segment);
                kept_width += width;
            } else {
                keep_contiguous_prefix = false;
            }
            visible_so_far += width;
            if visible_so_far > max_width {
                overflowed = true;
                break;
            }
            i = end;
        }
        exhausted_input = !overflowed;
    } else {
        let mut i = 0;
        while i < text.len() {
            if let Some(ansi) = extract_ansi_code(text, i) {
                pending_ansi.push_str(&ansi.code);
                i += ansi.length;
                continue;
            }

            if text.as_bytes()[i] == b'\t' {
                if keep_contiguous_prefix && kept_width + 3 <= target_width {
                    if !pending_ansi.is_empty() {
                        result.push_str(&pending_ansi);
                        pending_ansi.clear();
                    }
                    result.push('\t');
                    kept_width += 3;
                } else {
                    keep_contiguous_prefix = false;
                    pending_ansi.clear();
                }
                visible_so_far += 3;
                if visible_so_far > max_width {
                    overflowed = true;
                    break;
                }
                i += 1;
                continue;
            }

            let mut end = i;
            while end < text.len() && text.as_bytes()[end] != b'\t' {
                if extract_ansi_code(text, end).is_some() {
                    break;
                }
                let Some((_, next)) = next_char(text, end) else {
                    break;
                };
                end = next;
            }

            let mut segment_start = i;
            while segment_start < end {
                let segment_end = next_grapheme_end(text, segment_start);
                let segment = &text[segment_start..segment_end];
                let width = grapheme_width(segment);
                if keep_contiguous_prefix && kept_width + width <= target_width {
                    if !pending_ansi.is_empty() {
                        result.push_str(&pending_ansi);
                        pending_ansi.clear();
                    }
                    result.push_str(segment);
                    kept_width += width;
                } else {
                    keep_contiguous_prefix = false;
                    pending_ansi.clear();
                }

                visible_so_far += width;
                if visible_so_far > max_width {
                    overflowed = true;
                    break;
                }
                segment_start = segment_end;
            }
            if overflowed {
                break;
            }
            i = end;
        }
        exhausted_input = i >= text.len();
    }

    if !overflowed && exhausted_input {
        return if pad {
            format!(
                "{text}{}",
                " ".repeat(max_width.saturating_sub(visible_so_far))
            )
        } else {
            text.to_string()
        };
    }

    finalize_truncated_result(
        &result,
        kept_width,
        ellipsis,
        ellipsis_width,
        max_width,
        pad,
    )
}

pub fn truncate_to_width_default(text: &str, max_width: usize) -> String {
    truncate_to_width(text, max_width, "...", false)
}

pub fn slice_by_column(line: &str, start_col: usize, length: usize, strict: bool) -> String {
    slice_with_width(line, start_col, length, strict).text
}

pub fn slice_with_width(line: &str, start_col: usize, length: usize, strict: bool) -> TextSlice {
    if length == 0 {
        return TextSlice {
            text: String::new(),
            width: 0,
        };
    }

    let end_col = start_col.saturating_add(length);
    let mut result = String::new();
    let mut result_width = 0;
    let mut current_col = 0;
    let mut i = 0;
    let mut pending_ansi = String::new();

    while i < line.len() {
        if let Some(ansi) = extract_ansi_code(line, i) {
            if current_col >= start_col && current_col < end_col {
                result.push_str(&ansi.code);
            } else if current_col < start_col {
                pending_ansi.push_str(&ansi.code);
            }
            i += ansi.length;
            continue;
        }

        let mut text_end = i;
        while text_end < line.len() && extract_ansi_code(line, text_end).is_none() {
            let Some((_, next)) = next_char(line, text_end) else {
                break;
            };
            text_end = next;
        }

        let mut segment_start = i;
        while segment_start < text_end {
            let segment_end = next_grapheme_end(line, segment_start);
            let segment = &line[segment_start..segment_end];
            let width = grapheme_width(segment);
            let in_range = current_col >= start_col && current_col < end_col;
            let fits = !strict || current_col + width <= end_col;
            if in_range && fits {
                if !pending_ansi.is_empty() {
                    result.push_str(&pending_ansi);
                    pending_ansi.clear();
                }
                result.push_str(segment);
                result_width += width;
            }
            current_col += width;
            if current_col >= end_col {
                break;
            }
            segment_start = segment_end;
        }

        i = text_end;
        if current_col >= end_col {
            break;
        }
    }

    TextSlice {
        text: result,
        width: result_width,
    }
}

pub fn extract_segments(
    line: &str,
    before_end: usize,
    after_start: usize,
    after_len: usize,
    strict_after: bool,
) -> ExtractedSegments {
    let mut before = String::new();
    let mut before_width = 0;
    let mut after = String::new();
    let mut after_width = 0;
    let mut current_col = 0;
    let mut i = 0;
    let mut pending_ansi_before = String::new();
    let mut after_started = false;
    let after_end = after_start.saturating_add(after_len);
    let mut tracker = AnsiCodeTracker::default();
    tracker.clear();

    while i < line.len() {
        if let Some(ansi) = extract_ansi_code(line, i) {
            tracker.process(&ansi.code);
            if current_col < before_end {
                pending_ansi_before.push_str(&ansi.code);
            } else if current_col >= after_start && current_col < after_end && after_started {
                after.push_str(&ansi.code);
            }
            i += ansi.length;
            continue;
        }

        let mut text_end = i;
        while text_end < line.len() && extract_ansi_code(line, text_end).is_none() {
            let Some((_, next)) = next_char(line, text_end) else {
                break;
            };
            text_end = next;
        }

        let mut segment_start = i;
        while segment_start < text_end {
            let segment_end = next_grapheme_end(line, segment_start);
            let segment = &line[segment_start..segment_end];
            let width = grapheme_width(segment);

            if current_col < before_end {
                if !pending_ansi_before.is_empty() {
                    before.push_str(&pending_ansi_before);
                    pending_ansi_before.clear();
                }
                before.push_str(segment);
                before_width += width;
            } else if current_col >= after_start && current_col < after_end {
                let fits = !strict_after || current_col + width <= after_end;
                if fits {
                    if !after_started {
                        after.push_str(&tracker.get_active_codes());
                        after_started = true;
                    }
                    after.push_str(segment);
                    after_width += width;
                }
            }

            current_col += width;
            let done = if after_len == 0 {
                current_col >= before_end
            } else {
                current_col >= after_end
            };
            if done {
                break;
            }
            segment_start = segment_end;
        }

        i = text_end;
        let done = if after_len == 0 {
            current_col >= before_end
        } else {
            current_col >= after_end
        };
        if done {
            break;
        }
    }

    ExtractedSegments {
        before,
        before_width,
        after,
        after_width,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_keeps_output_within_width_for_large_unicode_input() {
        let text = "\u{1f642}\u{754c}".repeat(100_000);
        let truncated = truncate_to_width(&text, 40, "\u{2026}", false);

        assert!(visible_width(&truncated) <= 40);
        assert!(truncated.ends_with("\u{2026}\x1b[0m"));
    }

    #[test]
    fn truncate_preserves_ansi_styling_and_resets_ellipsis() {
        let text = format!("\x1b[31m{}\x1b[0m", "hello ".repeat(1000));
        let truncated = truncate_to_width(&text, 20, "\u{2026}", false);

        assert!(visible_width(&truncated) <= 20);
        assert!(truncated.contains("\x1b[31m"));
        assert!(truncated.ends_with("\x1b[0m\u{2026}\x1b[0m"));
    }

    #[test]
    fn truncate_handles_malformed_ansi_escape_prefixes_without_hanging() {
        let text = format!("abc\x1bnot-ansi {}", "\u{1f642}".repeat(1000));
        let truncated = truncate_to_width(&text, 20, "\u{2026}", false);

        assert!(visible_width(&truncated) <= 20);
    }

    #[test]
    fn truncate_clips_wide_ellipsis_safely_and_brackets_it_with_resets() {
        assert_eq!(truncate_to_width("abcdef", 1, "\u{1f642}", false), "");
        assert_eq!(
            truncate_to_width("abcdef", 2, "\u{1f642}", false),
            "\x1b[0m\u{1f642}\x1b[0m"
        );
        assert!(visible_width(&truncate_to_width("abcdef", 2, "\u{1f642}", false)) <= 2);
    }

    #[test]
    fn truncate_returns_original_when_it_already_fits_even_if_ellipsis_is_too_wide() {
        assert_eq!(truncate_to_width("a", 2, "\u{1f642}", false), "a");
        assert_eq!(
            truncate_to_width("\u{754c}", 2, "\u{1f642}", false),
            "\u{754c}"
        );
    }

    #[test]
    fn truncate_pads_truncated_output_to_requested_width() {
        let truncated = truncate_to_width(
            "\u{1f642}\u{754c}\u{1f642}\u{754c}\u{1f642}\u{754c}",
            8,
            "\u{2026}",
            true,
        );

        assert_eq!(visible_width(&truncated), 8);
    }

    #[test]
    fn truncate_adds_trailing_reset_without_ellipsis() {
        let truncated =
            truncate_to_width(&format!("\x1b[31m{}", "hello".repeat(100)), 10, "", false);

        assert!(visible_width(&truncated) <= 10);
        assert!(truncated.ends_with("\x1b[0m"));
    }

    #[test]
    fn truncate_keeps_contiguous_prefix_instead_of_resuming_after_wide_grapheme() {
        let truncated = truncate_to_width("\u{1f642}\t\u{754c} \x1b_abc\x07", 7, "\u{2026}", true);

        assert_eq!(truncated, "\u{1f642}\t\x1b[0m\u{2026}\x1b[0m ");
    }

    #[test]
    fn visible_width_counts_tabs_and_skips_ansi_inline() {
        assert_eq!(visible_width("\t\x1b[31m\u{754c}\x1b[0m"), 5);
    }

    #[test]
    fn visible_width_keeps_thai_and_lao_am_clusters_at_normal_cell_width() {
        assert_eq!(visible_width("\u{0e33}"), 1);
        assert_eq!(visible_width("\u{0eb3}"), 1);
        assert_eq!(visible_width("\u{0e01}\u{0e33}"), 2);
        assert_eq!(visible_width("\u{0e81}\u{0eb3}"), 2);
    }

    #[test]
    fn normalize_thai_and_lao_am_vowels_only_for_terminal_output() {
        assert_eq!(normalize_terminal_output("\u{0e33}"), "\u{0e4d}\u{0e32}");
        assert_eq!(normalize_terminal_output("\u{0eb3}"), "\u{0ecd}\u{0eb2}");
        assert_eq!(
            visible_width(&normalize_terminal_output("\u{0e33}abc")),
            visible_width("\u{0e33}abc")
        );
        assert_eq!(
            visible_width(&normalize_terminal_output("\u{0eb3}abc")),
            visible_width("\u{0eb3}abc")
        );
    }

    #[test]
    fn wrap_does_not_apply_underline_before_styled_text() {
        let underline_on = "\x1b[4m";
        let underline_off = "\x1b[24m";
        let url = "https://example.com/very/long/path/that/will/wrap";
        let text = format!("read this thread {underline_on}{url}{underline_off}");

        let wrapped = wrap_text_with_ansi(&text, 40);

        assert_eq!(wrapped[0], "read this thread");
        assert!(wrapped[1].starts_with(underline_on));
        assert!(wrapped[1].contains("https://"));
    }

    #[test]
    fn wrap_does_not_have_whitespace_before_underline_reset_code() {
        let underline_on = "\x1b[4m";
        let underline_off = "\x1b[24m";
        let text = format!("{underline_on}underlined text here {underline_off}more");

        let wrapped = wrap_text_with_ansi(&text, 18);

        assert!(!wrapped[0].contains(&format!(" {underline_off}")));
    }

    #[test]
    fn wrap_does_not_bleed_underline_to_padding() {
        let underline_on = "\x1b[4m";
        let underline_off = "\x1b[24m";
        let url = "https://example.com/very/long/path/that/will/definitely/wrap";
        let text = format!("prefix {underline_on}{url}{underline_off} suffix");

        let wrapped = wrap_text_with_ansi(&text, 30);

        for line in wrapped.iter().take(wrapped.len().saturating_sub(1)).skip(1) {
            if line.contains(underline_on) {
                assert!(line.ends_with(underline_off));
                assert!(!line.ends_with("\x1b[0m"));
            }
        }
    }

    #[test]
    fn wrap_preserves_background_color_across_wrapped_lines_without_full_reset() {
        let bg_blue = "\x1b[44m";
        let reset = "\x1b[0m";
        let text = format!("{bg_blue}hello world this is blue background text{reset}");

        let wrapped = wrap_text_with_ansi(&text, 15);

        for line in &wrapped {
            assert!(line.contains(bg_blue));
        }
        for line in wrapped.iter().take(wrapped.len().saturating_sub(1)) {
            assert!(!line.ends_with("\x1b[0m"));
        }
    }

    #[test]
    fn wrap_resets_underline_but_preserves_background() {
        let underline_on = "\x1b[4m";
        let underline_off = "\x1b[24m";
        let reset = "\x1b[0m";
        let text = format!(
            "\x1b[41mprefix {underline_on}UNDERLINED_CONTENT_THAT_WRAPS{underline_off} suffix{reset}"
        );

        let wrapped = wrap_text_with_ansi(&text, 20);

        for line in &wrapped {
            let has_bg_color =
                line.contains("[41m") || line.contains(";41m") || line.contains("[41;");
            assert!(has_bg_color);
        }

        for line in wrapped.iter().take(wrapped.len().saturating_sub(1)) {
            if (line.contains("[4m") || line.contains("[4;") || line.contains(";4m"))
                && !line.contains(underline_off)
            {
                assert!(line.ends_with(underline_off));
                assert!(!line.ends_with("\x1b[0m"));
            }
        }
    }

    #[test]
    fn wrap_plain_text_correctly() {
        let wrapped = wrap_text_with_ansi("hello world this is a test", 10);

        assert!(wrapped.len() > 1);
        for line in wrapped {
            assert!(visible_width(&line) <= 10);
        }
    }

    #[test]
    fn visible_width_ignores_osc_133_semantic_markers() {
        assert_eq!(visible_width("\x1b]133;A\x07hello\x1b]133;B\x07"), 5);
    }

    #[test]
    fn visible_width_ignores_osc_sequences_terminated_with_st() {
        assert_eq!(visible_width("\x1b]133;A\x1b\\hello\x1b]133;B\x1b\\"), 5);
    }

    #[test]
    fn visible_width_treats_isolated_regional_indicators_as_width_two() {
        assert_eq!(visible_width("\u{1f1e8}"), 2);
        assert_eq!(visible_width("\u{1f1e8}\u{1f1f3}"), 2);
    }

    #[test]
    fn wrap_truncates_trailing_whitespace_that_exceeds_width() {
        let wrapped = wrap_text_with_ansi("  ", 1);

        assert!(visible_width(&wrapped[0]) <= 1);
    }

    #[test]
    fn wrap_preserves_color_codes_across_wraps() {
        let red = "\x1b[31m";
        let reset = "\x1b[0m";
        let text = format!("{red}hello world this is red{reset}");

        let wrapped = wrap_text_with_ansi(&text, 10);

        for line in wrapped.iter().skip(1) {
            assert!(line.starts_with(red));
        }
        for line in wrapped.iter().take(wrapped.len().saturating_sub(1)) {
            assert!(!line.ends_with("\x1b[0m"));
        }
    }

    #[test]
    fn wrap_reemits_osc8_open_at_start_of_continuation_lines() {
        let url = "https://example.com";
        let open = format!("\x1b]8;;{url}\x1b\\");
        let input = format!("{open}0123456789\x1b]8;;\x1b\\");
        let lines = wrap_text_with_ansi(&input, 6);

        for line in lines {
            if visible_width(&line) > 0 {
                assert!(
                    line.starts_with(&open) || line.contains(&open),
                    "line {:?} has visible text but no OSC 8 re-open",
                    line
                );
            }
        }
    }

    #[test]
    fn wrap_closes_osc8_before_each_line_break() {
        let url = "https://example.com";
        let open = format!("\x1b]8;;{url}\x1b\\");
        let input = format!("{open}0123456789\x1b]8;;\x1b\\");
        let lines = wrap_text_with_ansi(&input, 6);

        for line in lines.iter().take(lines.len().saturating_sub(1)) {
            if line.contains(&open) {
                assert!(
                    line.ends_with("\x1b]8;;\x1b\\"),
                    "non-final line {:?} is inside a hyperlink but does not close it",
                    line
                );
            }
        }
    }

    #[test]
    fn wrap_preserves_bel_terminators_for_oauth_style_hyperlinks() {
        let url = format!("https://example.com/oauth/{}", "a".repeat(32));
        let open_bel = format!("\x1b]8;;{url}\x07");
        let open_st = format!("\x1b]8;;{url}\x1b\\");
        let input = format!("{open_bel}{url}\x1b]8;;\x07");
        let lines = wrap_text_with_ansi(&input, 20);

        assert!(lines.len() > 1);
        for line in &lines {
            assert!(
                line.contains(&open_bel),
                "line {:?} does not reopen the hyperlink with BEL",
                line
            );
            assert!(
                !line.contains(&open_st),
                "line {:?} reopens the hyperlink with ST",
                line
            );
        }
        for line in lines.iter().take(lines.len().saturating_sub(1)) {
            assert!(
                line.ends_with("\x1b]8;;\x07"),
                "line {:?} does not close the hyperlink with BEL",
                line
            );
        }
    }

    #[test]
    fn wrap_does_not_emit_osc8_sequences_on_lines_outside_hyperlink() {
        let url = "https://example.com";
        let input = format!("before \x1b]8;;{url}\x1b\\link\x1b]8;;\x1b\\ after");
        let lines = wrap_text_with_ansi(&input, 80);

        assert_eq!(lines.len(), 1);
        let open = format!("\x1b]8;;{url}\x1b\\");
        assert_eq!(lines[0].matches(&open).count(), 1);
        assert_eq!(lines[0].matches("\x1b]8;;\x1b\\").count(), 1);
    }
}
