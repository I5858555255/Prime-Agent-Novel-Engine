use std::sync::atomic::{AtomicBool, Ordering};

const MODIFIER_SHIFT: i32 = 1;
const MODIFIER_ALT: i32 = 2;
const MODIFIER_CTRL: i32 = 4;
const MODIFIER_SUPER: i32 = 8;
const LOCK_MASK: i32 = 64 + 128;

const CODEPOINT_ESCAPE: i32 = 27;
const CODEPOINT_TAB: i32 = 9;
const CODEPOINT_ENTER: i32 = 13;
const CODEPOINT_SPACE: i32 = 32;
const CODEPOINT_BACKSPACE: i32 = 127;
const CODEPOINT_KP_ENTER: i32 = 57414;

const ARROW_UP: i32 = -1;
const ARROW_DOWN: i32 = -2;
const ARROW_RIGHT: i32 = -3;
const ARROW_LEFT: i32 = -4;

const FUNC_DELETE: i32 = -10;
const FUNC_INSERT: i32 = -11;
const FUNC_PAGE_UP: i32 = -12;
const FUNC_PAGE_DOWN: i32 = -13;
const FUNC_HOME: i32 = -14;
const FUNC_END: i32 = -15;

static KITTY_PROTOCOL_ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyEventType {
    Press,
    Repeat,
    Release,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct KeyEnvironment {
    pub wt_session: Option<String>,
    pub ssh_connection: Option<String>,
    pub ssh_client: Option<String>,
    pub ssh_tty: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ParsedKittySequence {
    codepoint: i32,
    shifted_key: Option<i32>,
    base_layout_key: Option<i32>,
    modifier: i32,
    event_type: KeyEventType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ParsedModifyOtherKeysSequence {
    codepoint: i32,
    modifier: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedKeyId {
    key: String,
    ctrl: bool,
    shift: bool,
    alt: bool,
    super_modifier: bool,
}

impl KeyEnvironment {
    pub fn from_current_env() -> Self {
        Self {
            wt_session: std::env::var("WT_SESSION").ok(),
            ssh_connection: std::env::var("SSH_CONNECTION").ok(),
            ssh_client: std::env::var("SSH_CLIENT").ok(),
            ssh_tty: std::env::var("SSH_TTY").ok(),
        }
    }
}

pub fn set_kitty_protocol_active(active: bool) {
    KITTY_PROTOCOL_ACTIVE.store(active, Ordering::Relaxed);
}

pub fn is_kitty_protocol_active() -> bool {
    KITTY_PROTOCOL_ACTIVE.load(Ordering::Relaxed)
}

pub fn is_key_release(data: &str) -> bool {
    if data.contains("\u{1b}[200~") {
        return false;
    }

    [":3u", ":3~", ":3A", ":3B", ":3C", ":3D", ":3H", ":3F"]
        .iter()
        .any(|pattern| data.contains(pattern))
}

pub fn is_key_repeat(data: &str) -> bool {
    if data.contains("\u{1b}[200~") {
        return false;
    }

    [":2u", ":2~", ":2A", ":2B", ":2C", ":2D", ":2H", ":2F"]
        .iter()
        .any(|pattern| data.contains(pattern))
}

fn env_is_set(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|item| !item.is_empty())
}

fn is_windows_terminal_session(env: &KeyEnvironment) -> bool {
    env_is_set(&env.wt_session)
        && !env_is_set(&env.ssh_connection)
        && !env_is_set(&env.ssh_client)
        && !env_is_set(&env.ssh_tty)
}

fn parse_event_type(value: Option<&str>) -> KeyEventType {
    match value.and_then(|item| item.parse::<i32>().ok()) {
        Some(2) => KeyEventType::Repeat,
        Some(3) => KeyEventType::Release,
        _ => KeyEventType::Press,
    }
}

fn parse_i32(value: &str) -> Option<i32> {
    if value.is_empty() || !value.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    value.parse::<i32>().ok()
}

fn parse_modifier_event(value: Option<&str>) -> Option<(i32, KeyEventType)> {
    let Some(value) = value else {
        return Some((1, KeyEventType::Press));
    };
    let (modifier, event_type) = value
        .split_once(':')
        .map_or((value, None), |(modifier, event)| (modifier, Some(event)));
    Some((parse_i32(modifier)?, parse_event_type(event_type)))
}

fn parse_kitty_sequence(data: &str) -> Option<ParsedKittySequence> {
    let body = data.strip_prefix("\u{1b}[")?.strip_suffix('u')?;
    let (codepoint_part, modifier_part) = body
        .split_once(';')
        .map_or((body, None), |(left, right)| (left, Some(right)));
    let key_parts = codepoint_part.split(':').collect::<Vec<_>>();
    if key_parts.is_empty() || key_parts.len() > 3 {
        return None;
    }

    let codepoint = parse_i32(key_parts[0])?;
    let shifted_key = key_parts
        .get(1)
        .and_then(|value| (!value.is_empty()).then_some(*value))
        .and_then(parse_i32);
    let base_layout_key = key_parts
        .get(2)
        .and_then(|value| (!value.is_empty()).then_some(*value))
        .and_then(parse_i32);
    let (modifier_value, event_type) = parse_modifier_event(modifier_part)?;

    Some(ParsedKittySequence {
        codepoint,
        shifted_key,
        base_layout_key,
        modifier: modifier_value - 1,
        event_type,
    })
    .filter(|_| key_parts[0].chars().all(|ch| ch.is_ascii_digit()))
}

fn parse_modified_csi_tail(data: &str, suffixes: &[char]) -> Option<(i32, KeyEventType, char)> {
    let body = data.strip_prefix("\u{1b}[1;")?;
    let suffix = body.chars().last()?;
    if !suffixes.contains(&suffix) {
        return None;
    }
    let modifier_part = &body[..body.len() - suffix.len_utf8()];
    let (modifier_value, event_type) = parse_modifier_event(Some(modifier_part))?;
    Some((modifier_value, event_type, suffix))
}

fn parse_kitty_non_csi_u_sequence(data: &str) -> Option<ParsedKittySequence> {
    if let Some((modifier_value, event_type, suffix)) =
        parse_modified_csi_tail(data, &['A', 'B', 'C', 'D'])
    {
        let codepoint = match suffix {
            'A' => ARROW_UP,
            'B' => ARROW_DOWN,
            'C' => ARROW_RIGHT,
            'D' => ARROW_LEFT,
            _ => return None,
        };
        return Some(ParsedKittySequence {
            codepoint,
            shifted_key: None,
            base_layout_key: None,
            modifier: modifier_value - 1,
            event_type,
        });
    }

    if let Some(body) = data
        .strip_prefix("\u{1b}[")
        .and_then(|item| item.strip_suffix('~'))
    {
        let (key_num_part, modifier_part) = body
            .split_once(';')
            .map_or((body, None), |(left, right)| (left, Some(right)));
        let key_num = parse_i32(key_num_part)?;
        let codepoint = match key_num {
            2 => FUNC_INSERT,
            3 => FUNC_DELETE,
            5 => FUNC_PAGE_UP,
            6 => FUNC_PAGE_DOWN,
            7 => FUNC_HOME,
            8 => FUNC_END,
            _ => return None,
        };
        let (modifier_value, event_type) = parse_modifier_event(modifier_part)?;
        return Some(ParsedKittySequence {
            codepoint,
            shifted_key: None,
            base_layout_key: None,
            modifier: modifier_value - 1,
            event_type,
        });
    }

    if let Some((modifier_value, event_type, suffix)) = parse_modified_csi_tail(data, &['H', 'F']) {
        return Some(ParsedKittySequence {
            codepoint: if suffix == 'H' { FUNC_HOME } else { FUNC_END },
            shifted_key: None,
            base_layout_key: None,
            modifier: modifier_value - 1,
            event_type,
        });
    }

    None
}

fn parse_any_kitty_sequence(data: &str) -> Option<ParsedKittySequence> {
    parse_kitty_sequence(data).or_else(|| parse_kitty_non_csi_u_sequence(data))
}

fn normalize_kitty_functional_codepoint(codepoint: i32) -> i32 {
    match codepoint {
        57399 => 48,
        57400 => 49,
        57401 => 50,
        57402 => 51,
        57403 => 52,
        57404 => 53,
        57405 => 54,
        57406 => 55,
        57407 => 56,
        57408 => 57,
        57409 => 46,
        57410 => 47,
        57411 => 42,
        57412 => 45,
        57413 => 43,
        57415 => 61,
        57416 => 44,
        57417 => ARROW_LEFT,
        57418 => ARROW_RIGHT,
        57419 => ARROW_UP,
        57420 => ARROW_DOWN,
        57421 => FUNC_PAGE_UP,
        57422 => FUNC_PAGE_DOWN,
        57423 => FUNC_HOME,
        57424 => FUNC_END,
        57425 => FUNC_INSERT,
        57426 => FUNC_DELETE,
        _ => codepoint,
    }
}

fn normalize_shifted_letter_identity_codepoint(codepoint: i32, modifier: i32) -> i32 {
    let effective_modifier = modifier & !LOCK_MASK;
    if effective_modifier & MODIFIER_SHIFT != 0 && (65..=90).contains(&codepoint) {
        codepoint + 32
    } else {
        codepoint
    }
}

fn codepoint_to_string(codepoint: i32) -> Option<String> {
    char::from_u32(codepoint as u32).map(|ch| ch.to_string())
}

fn is_symbol_key(key: &str) -> bool {
    matches!(
        key,
        "`" | "-"
            | "="
            | "["
            | "]"
            | "\\"
            | ";"
            | "'"
            | ","
            | "."
            | "/"
            | "!"
            | "@"
            | "#"
            | "$"
            | "%"
            | "^"
            | "&"
            | "*"
            | "("
            | ")"
            | "_"
            | "+"
            | "|"
            | "~"
            | "{"
            | "}"
            | ":"
            | "<"
            | ">"
            | "?"
    )
}

fn is_known_symbol_codepoint(codepoint: i32) -> bool {
    codepoint_to_string(codepoint).is_some_and(|key| is_symbol_key(&key))
}

fn matches_kitty_sequence(data: &str, expected_codepoint: i32, expected_modifier: i32) -> bool {
    let Some(parsed) = parse_any_kitty_sequence(data) else {
        return false;
    };

    let actual_modifier = parsed.modifier & !LOCK_MASK;
    let expected_modifier = expected_modifier & !LOCK_MASK;
    if actual_modifier != expected_modifier {
        return false;
    }

    let normalized_codepoint = normalize_shifted_letter_identity_codepoint(
        normalize_kitty_functional_codepoint(parsed.codepoint),
        parsed.modifier,
    );
    let normalized_expected_codepoint = normalize_shifted_letter_identity_codepoint(
        normalize_kitty_functional_codepoint(expected_codepoint),
        expected_modifier,
    );

    if normalized_codepoint == normalized_expected_codepoint {
        return true;
    }

    if parsed.base_layout_key == Some(expected_codepoint) {
        let is_latin_letter = (97..=122).contains(&normalized_codepoint);
        let is_known_symbol = is_known_symbol_codepoint(normalized_codepoint);
        if !is_latin_letter && !is_known_symbol {
            return true;
        }
    }

    false
}

fn parse_modify_other_keys_sequence(data: &str) -> Option<ParsedModifyOtherKeysSequence> {
    let body = data.strip_prefix("\u{1b}[27;")?.strip_suffix('~')?;
    let mut parts = body.split(';');
    let modifier_value = parse_i32(parts.next()?)?;
    let codepoint = parse_i32(parts.next()?)?;
    if parts.next().is_some() {
        return None;
    }
    Some(ParsedModifyOtherKeysSequence {
        codepoint,
        modifier: modifier_value - 1,
    })
}

fn matches_modify_other_keys(data: &str, expected_keycode: i32, expected_modifier: i32) -> bool {
    parse_modify_other_keys_sequence(data).is_some_and(|parsed| {
        parsed.codepoint == expected_keycode && parsed.modifier == expected_modifier
    })
}

fn matches_printable_modify_other_keys(
    data: &str,
    expected_keycode: i32,
    expected_modifier: i32,
) -> bool {
    if expected_modifier == 0 {
        return false;
    }
    let Some(parsed) = parse_modify_other_keys_sequence(data) else {
        return false;
    };
    if parsed.modifier != expected_modifier {
        return false;
    }
    normalize_shifted_letter_identity_codepoint(parsed.codepoint, parsed.modifier)
        == normalize_shifted_letter_identity_codepoint(expected_keycode, expected_modifier)
}

fn matches_raw_backspace(data: &str, expected_modifier: i32, env: &KeyEnvironment) -> bool {
    if data == "\u{7f}" {
        return expected_modifier == 0;
    }
    if data != "\u{8}" {
        return false;
    }
    if is_windows_terminal_session(env) {
        expected_modifier == MODIFIER_CTRL
    } else {
        expected_modifier == 0
    }
}

fn raw_ctrl_char(key: &str) -> Option<String> {
    let key = key.to_lowercase();
    let ch = key.chars().next()?;
    let code = ch as u32;
    if key.chars().count() == 1
        && ((97..=122).contains(&code) || matches!(ch, '[' | '\\' | ']' | '_'))
    {
        return char::from_u32(code & 0x1f).map(|ch| ch.to_string());
    }
    if key == "-" {
        return Some("\u{1f}".to_string());
    }
    None
}

fn is_digit_key(key: &str) -> bool {
    key.len() == 1 && key.as_bytes()[0].is_ascii_digit()
}

fn parse_key_id(key_id: &str) -> Option<ParsedKeyId> {
    let lower = key_id.to_lowercase();
    let parts = lower.split('+').collect::<Vec<_>>();
    let key = parts.last().copied()?;
    if key.is_empty() {
        return None;
    }
    Some(ParsedKeyId {
        key: key.to_string(),
        ctrl: parts.contains(&"ctrl"),
        shift: parts.contains(&"shift"),
        alt: parts.contains(&"alt"),
        super_modifier: parts.contains(&"super"),
    })
}

fn matches_legacy_sequence(data: &str, key: &str) -> bool {
    match key {
        "up" => ["\u{1b}[A", "\u{1b}OA"].contains(&data),
        "down" => ["\u{1b}[B", "\u{1b}OB"].contains(&data),
        "right" => ["\u{1b}[C", "\u{1b}OC"].contains(&data),
        "left" => ["\u{1b}[D", "\u{1b}OD"].contains(&data),
        "home" => ["\u{1b}[H", "\u{1b}OH", "\u{1b}[1~", "\u{1b}[7~"].contains(&data),
        "end" => ["\u{1b}[F", "\u{1b}OF", "\u{1b}[4~", "\u{1b}[8~"].contains(&data),
        "insert" => ["\u{1b}[2~"].contains(&data),
        "delete" => ["\u{1b}[3~"].contains(&data),
        "pageup" => ["\u{1b}[5~", "\u{1b}[[5~"].contains(&data),
        "pagedown" => ["\u{1b}[6~", "\u{1b}[[6~"].contains(&data),
        "clear" => ["\u{1b}[E", "\u{1b}OE"].contains(&data),
        "f1" => ["\u{1b}OP", "\u{1b}[11~", "\u{1b}[[A"].contains(&data),
        "f2" => ["\u{1b}OQ", "\u{1b}[12~", "\u{1b}[[B"].contains(&data),
        "f3" => ["\u{1b}OR", "\u{1b}[13~", "\u{1b}[[C"].contains(&data),
        "f4" => ["\u{1b}OS", "\u{1b}[14~", "\u{1b}[[D"].contains(&data),
        "f5" => ["\u{1b}[15~", "\u{1b}[[E"].contains(&data),
        "f6" => ["\u{1b}[17~"].contains(&data),
        "f7" => ["\u{1b}[18~"].contains(&data),
        "f8" => ["\u{1b}[19~"].contains(&data),
        "f9" => ["\u{1b}[20~"].contains(&data),
        "f10" => ["\u{1b}[21~"].contains(&data),
        "f11" => ["\u{1b}[23~"].contains(&data),
        "f12" => ["\u{1b}[24~"].contains(&data),
        _ => false,
    }
}

fn matches_legacy_modifier_sequence(data: &str, key: &str, modifier: i32) -> bool {
    let shift = match key {
        "up" => ["\u{1b}[a"].contains(&data),
        "down" => ["\u{1b}[b"].contains(&data),
        "right" => ["\u{1b}[c"].contains(&data),
        "left" => ["\u{1b}[d"].contains(&data),
        "clear" => ["\u{1b}[e"].contains(&data),
        "insert" => ["\u{1b}[2$"].contains(&data),
        "delete" => ["\u{1b}[3$"].contains(&data),
        "pageup" => ["\u{1b}[5$"].contains(&data),
        "pagedown" => ["\u{1b}[6$"].contains(&data),
        "home" => ["\u{1b}[7$"].contains(&data),
        "end" => ["\u{1b}[8$"].contains(&data),
        _ => false,
    };
    let ctrl = match key {
        "up" => ["\u{1b}Oa"].contains(&data),
        "down" => ["\u{1b}Ob"].contains(&data),
        "right" => ["\u{1b}Oc"].contains(&data),
        "left" => ["\u{1b}Od"].contains(&data),
        "clear" => ["\u{1b}Oe"].contains(&data),
        "insert" => ["\u{1b}[2^"].contains(&data),
        "delete" => ["\u{1b}[3^"].contains(&data),
        "pageup" => ["\u{1b}[5^"].contains(&data),
        "pagedown" => ["\u{1b}[6^"].contains(&data),
        "home" => ["\u{1b}[7^"].contains(&data),
        "end" => ["\u{1b}[8^"].contains(&data),
        _ => false,
    };

    (modifier == MODIFIER_SHIFT && shift) || (modifier == MODIFIER_CTRL && ctrl)
}

fn legacy_sequence_key_id(data: &str) -> Option<&'static str> {
    match data {
        "\u{1b}OA" => Some("up"),
        "\u{1b}OB" => Some("down"),
        "\u{1b}OC" => Some("right"),
        "\u{1b}OD" => Some("left"),
        "\u{1b}OH" => Some("home"),
        "\u{1b}OF" => Some("end"),
        "\u{1b}[E" | "\u{1b}OE" => Some("clear"),
        "\u{1b}Oe" => Some("ctrl+clear"),
        "\u{1b}[e" => Some("shift+clear"),
        "\u{1b}[2~" => Some("insert"),
        "\u{1b}[2$" => Some("shift+insert"),
        "\u{1b}[2^" => Some("ctrl+insert"),
        "\u{1b}[3$" => Some("shift+delete"),
        "\u{1b}[3^" => Some("ctrl+delete"),
        "\u{1b}[[5~" => Some("pageUp"),
        "\u{1b}[[6~" => Some("pageDown"),
        "\u{1b}[a" => Some("shift+up"),
        "\u{1b}[b" => Some("shift+down"),
        "\u{1b}[c" => Some("shift+right"),
        "\u{1b}[d" => Some("shift+left"),
        "\u{1b}Oa" => Some("ctrl+up"),
        "\u{1b}Ob" => Some("ctrl+down"),
        "\u{1b}Oc" => Some("ctrl+right"),
        "\u{1b}Od" => Some("ctrl+left"),
        "\u{1b}[5$" => Some("shift+pageUp"),
        "\u{1b}[6$" => Some("shift+pageDown"),
        "\u{1b}[7$" => Some("shift+home"),
        "\u{1b}[8$" => Some("shift+end"),
        "\u{1b}[5^" => Some("ctrl+pageUp"),
        "\u{1b}[6^" => Some("ctrl+pageDown"),
        "\u{1b}[7^" => Some("ctrl+home"),
        "\u{1b}[8^" => Some("ctrl+end"),
        "\u{1b}OP" | "\u{1b}[11~" | "\u{1b}[[A" => Some("f1"),
        "\u{1b}OQ" | "\u{1b}[12~" | "\u{1b}[[B" => Some("f2"),
        "\u{1b}OR" | "\u{1b}[13~" | "\u{1b}[[C" => Some("f3"),
        "\u{1b}OS" | "\u{1b}[14~" | "\u{1b}[[D" => Some("f4"),
        "\u{1b}[[E" | "\u{1b}[15~" => Some("f5"),
        "\u{1b}[17~" => Some("f6"),
        "\u{1b}[18~" => Some("f7"),
        "\u{1b}[19~" => Some("f8"),
        "\u{1b}[20~" => Some("f9"),
        "\u{1b}[21~" => Some("f10"),
        "\u{1b}[23~" => Some("f11"),
        "\u{1b}[24~" => Some("f12"),
        "\u{1b}b" => Some("alt+left"),
        "\u{1b}f" => Some("alt+right"),
        "\u{1b}p" => Some("alt+up"),
        "\u{1b}n" => Some("alt+down"),
        _ => None,
    }
}

pub fn matches_key(data: &str, key_id: &str) -> bool {
    matches_key_with_env(data, key_id, &KeyEnvironment::from_current_env())
}

pub fn matches_key_with_env(data: &str, key_id: &str, env: &KeyEnvironment) -> bool {
    let Some(parsed) = parse_key_id(key_id) else {
        return false;
    };
    let key = parsed.key;
    let mut modifier = 0;
    if parsed.shift {
        modifier |= MODIFIER_SHIFT;
    }
    if parsed.alt {
        modifier |= MODIFIER_ALT;
    }
    if parsed.ctrl {
        modifier |= MODIFIER_CTRL;
    }
    if parsed.super_modifier {
        modifier |= MODIFIER_SUPER;
    }

    match key.as_str() {
        "escape" | "esc" => {
            modifier == 0
                && (data == "\u{1b}"
                    || matches_kitty_sequence(data, CODEPOINT_ESCAPE, 0)
                    || matches_modify_other_keys(data, CODEPOINT_ESCAPE, 0))
        }
        "space" => {
            if !is_kitty_protocol_active() {
                if modifier == MODIFIER_CTRL && data == "\u{0}" {
                    return true;
                }
                if modifier == MODIFIER_ALT && data == "\u{1b} " {
                    return true;
                }
            }
            if modifier == 0 {
                return data == " "
                    || matches_kitty_sequence(data, CODEPOINT_SPACE, 0)
                    || matches_modify_other_keys(data, CODEPOINT_SPACE, 0);
            }
            matches_kitty_sequence(data, CODEPOINT_SPACE, modifier)
                || matches_modify_other_keys(data, CODEPOINT_SPACE, modifier)
        }
        "tab" => {
            if modifier == MODIFIER_SHIFT {
                return data == "\u{1b}[Z"
                    || matches_kitty_sequence(data, CODEPOINT_TAB, MODIFIER_SHIFT)
                    || matches_modify_other_keys(data, CODEPOINT_TAB, MODIFIER_SHIFT);
            }
            if modifier == 0 {
                return data == "\t" || matches_kitty_sequence(data, CODEPOINT_TAB, 0);
            }
            matches_kitty_sequence(data, CODEPOINT_TAB, modifier)
                || matches_modify_other_keys(data, CODEPOINT_TAB, modifier)
        }
        "enter" | "return" => match modifier {
            MODIFIER_SHIFT => {
                if matches_kitty_sequence(data, CODEPOINT_ENTER, MODIFIER_SHIFT)
                    || matches_kitty_sequence(data, CODEPOINT_KP_ENTER, MODIFIER_SHIFT)
                    || matches_modify_other_keys(data, CODEPOINT_ENTER, MODIFIER_SHIFT)
                {
                    return true;
                }
                is_kitty_protocol_active() && (data == "\u{1b}\r" || data == "\n")
            }
            MODIFIER_ALT => {
                if matches_kitty_sequence(data, CODEPOINT_ENTER, MODIFIER_ALT)
                    || matches_kitty_sequence(data, CODEPOINT_KP_ENTER, MODIFIER_ALT)
                    || matches_modify_other_keys(data, CODEPOINT_ENTER, MODIFIER_ALT)
                {
                    return true;
                }
                !is_kitty_protocol_active() && data == "\u{1b}\r"
            }
            0 => {
                data == "\r"
                    || (!is_kitty_protocol_active() && data == "\n")
                    || data == "\u{1b}OM"
                    || matches_kitty_sequence(data, CODEPOINT_ENTER, 0)
                    || matches_kitty_sequence(data, CODEPOINT_KP_ENTER, 0)
            }
            _ => {
                matches_kitty_sequence(data, CODEPOINT_ENTER, modifier)
                    || matches_kitty_sequence(data, CODEPOINT_KP_ENTER, modifier)
                    || matches_modify_other_keys(data, CODEPOINT_ENTER, modifier)
            }
        },
        "backspace" => match modifier {
            MODIFIER_ALT => {
                data == "\u{1b}\u{7f}"
                    || data == "\u{1b}\u{8}"
                    || matches_kitty_sequence(data, CODEPOINT_BACKSPACE, MODIFIER_ALT)
                    || matches_modify_other_keys(data, CODEPOINT_BACKSPACE, MODIFIER_ALT)
            }
            MODIFIER_CTRL => {
                matches_raw_backspace(data, MODIFIER_CTRL, env)
                    || matches_kitty_sequence(data, CODEPOINT_BACKSPACE, MODIFIER_CTRL)
                    || matches_modify_other_keys(data, CODEPOINT_BACKSPACE, MODIFIER_CTRL)
            }
            0 => {
                matches_raw_backspace(data, 0, env)
                    || matches_kitty_sequence(data, CODEPOINT_BACKSPACE, 0)
                    || matches_modify_other_keys(data, CODEPOINT_BACKSPACE, 0)
            }
            _ => {
                matches_kitty_sequence(data, CODEPOINT_BACKSPACE, modifier)
                    || matches_modify_other_keys(data, CODEPOINT_BACKSPACE, modifier)
            }
        },
        "insert" => {
            if modifier == 0 {
                return matches_legacy_sequence(data, "insert")
                    || matches_kitty_sequence(data, FUNC_INSERT, 0);
            }
            matches_legacy_modifier_sequence(data, "insert", modifier)
                || matches_kitty_sequence(data, FUNC_INSERT, modifier)
        }
        "delete" => {
            if modifier == 0 {
                return matches_legacy_sequence(data, "delete")
                    || matches_kitty_sequence(data, FUNC_DELETE, 0);
            }
            matches_legacy_modifier_sequence(data, "delete", modifier)
                || matches_kitty_sequence(data, FUNC_DELETE, modifier)
        }
        "clear" => {
            if modifier == 0 {
                return matches_legacy_sequence(data, "clear");
            }
            matches_legacy_modifier_sequence(data, "clear", modifier)
        }
        "home" => {
            if modifier == 0 {
                return matches_legacy_sequence(data, "home")
                    || matches_kitty_sequence(data, FUNC_HOME, 0);
            }
            matches_legacy_modifier_sequence(data, "home", modifier)
                || matches_kitty_sequence(data, FUNC_HOME, modifier)
        }
        "end" => {
            if modifier == 0 {
                return matches_legacy_sequence(data, "end")
                    || matches_kitty_sequence(data, FUNC_END, 0);
            }
            matches_legacy_modifier_sequence(data, "end", modifier)
                || matches_kitty_sequence(data, FUNC_END, modifier)
        }
        "pageup" => {
            if modifier == 0 {
                return matches_legacy_sequence(data, "pageup")
                    || matches_kitty_sequence(data, FUNC_PAGE_UP, 0);
            }
            matches_legacy_modifier_sequence(data, "pageup", modifier)
                || matches_kitty_sequence(data, FUNC_PAGE_UP, modifier)
        }
        "pagedown" => {
            if modifier == 0 {
                return matches_legacy_sequence(data, "pagedown")
                    || matches_kitty_sequence(data, FUNC_PAGE_DOWN, 0);
            }
            matches_legacy_modifier_sequence(data, "pagedown", modifier)
                || matches_kitty_sequence(data, FUNC_PAGE_DOWN, modifier)
        }
        "up" => {
            if modifier == MODIFIER_ALT {
                return data == "\u{1b}[1;3A"
                    || data == "\u{1b}p"
                    || matches_kitty_sequence(data, ARROW_UP, MODIFIER_ALT);
            }
            if modifier == 0 {
                return matches_legacy_sequence(data, "up")
                    || matches_kitty_sequence(data, ARROW_UP, 0);
            }
            matches_legacy_modifier_sequence(data, "up", modifier)
                || matches_kitty_sequence(data, ARROW_UP, modifier)
        }
        "down" => {
            if modifier == MODIFIER_ALT {
                return data == "\u{1b}[1;3B"
                    || data == "\u{1b}n"
                    || matches_kitty_sequence(data, ARROW_DOWN, MODIFIER_ALT);
            }
            if modifier == 0 {
                return matches_legacy_sequence(data, "down")
                    || matches_kitty_sequence(data, ARROW_DOWN, 0);
            }
            matches_legacy_modifier_sequence(data, "down", modifier)
                || matches_kitty_sequence(data, ARROW_DOWN, modifier)
        }
        "left" => {
            if modifier == MODIFIER_ALT {
                return data == "\u{1b}[1;3D"
                    || (!is_kitty_protocol_active() && data == "\u{1b}B")
                    || data == "\u{1b}b"
                    || matches_kitty_sequence(data, ARROW_LEFT, MODIFIER_ALT);
            }
            if modifier == MODIFIER_CTRL {
                return data == "\u{1b}[1;5D"
                    || matches_legacy_modifier_sequence(data, "left", MODIFIER_CTRL)
                    || matches_kitty_sequence(data, ARROW_LEFT, MODIFIER_CTRL);
            }
            if modifier == 0 {
                return matches_legacy_sequence(data, "left")
                    || matches_kitty_sequence(data, ARROW_LEFT, 0);
            }
            matches_legacy_modifier_sequence(data, "left", modifier)
                || matches_kitty_sequence(data, ARROW_LEFT, modifier)
        }
        "right" => {
            if modifier == MODIFIER_ALT {
                return data == "\u{1b}[1;3C"
                    || (!is_kitty_protocol_active() && data == "\u{1b}F")
                    || data == "\u{1b}f"
                    || matches_kitty_sequence(data, ARROW_RIGHT, MODIFIER_ALT);
            }
            if modifier == MODIFIER_CTRL {
                return data == "\u{1b}[1;5C"
                    || matches_legacy_modifier_sequence(data, "right", MODIFIER_CTRL)
                    || matches_kitty_sequence(data, ARROW_RIGHT, MODIFIER_CTRL);
            }
            if modifier == 0 {
                return matches_legacy_sequence(data, "right")
                    || matches_kitty_sequence(data, ARROW_RIGHT, 0);
            }
            matches_legacy_modifier_sequence(data, "right", modifier)
                || matches_kitty_sequence(data, ARROW_RIGHT, modifier)
        }
        "f1" | "f2" | "f3" | "f4" | "f5" | "f6" | "f7" | "f8" | "f9" | "f10" | "f11" | "f12" => {
            modifier == 0 && matches_legacy_sequence(data, &key)
        }
        _ => {
            let key_str = key.as_str();
            if key.chars().count() != 1
                || !(("a"..="z").contains(&key_str) || is_digit_key(&key) || is_symbol_key(&key))
            {
                return false;
            }

            let codepoint = key.chars().next().expect("single key") as i32;
            let raw_ctrl = raw_ctrl_char(&key);
            let is_letter = ("a"..="z").contains(&key_str);
            let is_digit = is_digit_key(&key);

            if modifier == MODIFIER_CTRL + MODIFIER_ALT
                && !is_kitty_protocol_active()
                && raw_ctrl
                    .as_deref()
                    .is_some_and(|raw| data == format!("\u{1b}{raw}"))
            {
                return true;
            }

            if modifier == MODIFIER_ALT
                && !is_kitty_protocol_active()
                && (is_letter || is_digit)
                && data == format!("\u{1b}{key}")
            {
                return true;
            }

            if modifier == MODIFIER_CTRL {
                if raw_ctrl.as_deref().is_some_and(|raw| data == raw) {
                    return true;
                }
                return matches_kitty_sequence(data, codepoint, MODIFIER_CTRL)
                    || matches_printable_modify_other_keys(data, codepoint, MODIFIER_CTRL);
            }

            if modifier == MODIFIER_SHIFT + MODIFIER_CTRL {
                return matches_kitty_sequence(data, codepoint, MODIFIER_SHIFT + MODIFIER_CTRL)
                    || matches_printable_modify_other_keys(
                        data,
                        codepoint,
                        MODIFIER_SHIFT + MODIFIER_CTRL,
                    );
            }

            if modifier == MODIFIER_SHIFT {
                if is_letter && data == key.to_uppercase() {
                    return true;
                }
                return matches_kitty_sequence(data, codepoint, MODIFIER_SHIFT)
                    || matches_printable_modify_other_keys(data, codepoint, MODIFIER_SHIFT);
            }

            if modifier != 0 {
                return matches_kitty_sequence(data, codepoint, modifier)
                    || matches_printable_modify_other_keys(data, codepoint, modifier);
            }

            data == key || matches_kitty_sequence(data, codepoint, 0)
        }
    }
}

fn format_key_name_with_modifiers(key_name: &str, modifier: i32) -> Option<String> {
    let effective_modifier = modifier & !LOCK_MASK;
    let supported_modifier_mask = MODIFIER_SHIFT | MODIFIER_CTRL | MODIFIER_ALT | MODIFIER_SUPER;
    if effective_modifier & !supported_modifier_mask != 0 {
        return None;
    }

    let mut mods = Vec::new();
    if effective_modifier & MODIFIER_SHIFT != 0 {
        mods.push("shift");
    }
    if effective_modifier & MODIFIER_CTRL != 0 {
        mods.push("ctrl");
    }
    if effective_modifier & MODIFIER_ALT != 0 {
        mods.push("alt");
    }
    if effective_modifier & MODIFIER_SUPER != 0 {
        mods.push("super");
    }

    if mods.is_empty() {
        Some(key_name.to_string())
    } else {
        Some(format!("{}+{key_name}", mods.join("+")))
    }
}

fn format_parsed_key(
    codepoint: i32,
    modifier: i32,
    base_layout_key: Option<i32>,
) -> Option<String> {
    let normalized_codepoint = normalize_kitty_functional_codepoint(codepoint);
    let identity_codepoint =
        normalize_shifted_letter_identity_codepoint(normalized_codepoint, modifier);

    let is_latin_letter = (97..=122).contains(&identity_codepoint);
    let is_digit = (48..=57).contains(&identity_codepoint);
    let is_known_symbol = is_known_symbol_codepoint(identity_codepoint);
    let effective_codepoint = if is_latin_letter || is_digit || is_known_symbol {
        identity_codepoint
    } else {
        base_layout_key.unwrap_or(identity_codepoint)
    };

    let key_name = match effective_codepoint {
        CODEPOINT_ESCAPE => Some("escape".to_string()),
        CODEPOINT_TAB => Some("tab".to_string()),
        CODEPOINT_ENTER | CODEPOINT_KP_ENTER => Some("enter".to_string()),
        CODEPOINT_SPACE => Some("space".to_string()),
        CODEPOINT_BACKSPACE => Some("backspace".to_string()),
        FUNC_DELETE => Some("delete".to_string()),
        FUNC_INSERT => Some("insert".to_string()),
        FUNC_HOME => Some("home".to_string()),
        FUNC_END => Some("end".to_string()),
        FUNC_PAGE_UP => Some("pageUp".to_string()),
        FUNC_PAGE_DOWN => Some("pageDown".to_string()),
        ARROW_UP => Some("up".to_string()),
        ARROW_DOWN => Some("down".to_string()),
        ARROW_LEFT => Some("left".to_string()),
        ARROW_RIGHT => Some("right".to_string()),
        48..=57 | 97..=122 => codepoint_to_string(effective_codepoint),
        _ if is_known_symbol_codepoint(effective_codepoint) => {
            codepoint_to_string(effective_codepoint)
        }
        _ => None,
    }?;

    format_key_name_with_modifiers(&key_name, modifier)
}

pub fn parse_key(data: &str) -> Option<String> {
    parse_key_with_env(data, &KeyEnvironment::from_current_env())
}

pub fn parse_key_with_env(data: &str, env: &KeyEnvironment) -> Option<String> {
    if let Some(kitty) = parse_any_kitty_sequence(data) {
        return format_parsed_key(kitty.codepoint, kitty.modifier, kitty.base_layout_key);
    }

    if let Some(modify_other_keys) = parse_modify_other_keys_sequence(data) {
        return format_parsed_key(
            modify_other_keys.codepoint,
            modify_other_keys.modifier,
            None,
        );
    }

    if is_kitty_protocol_active() && (data == "\u{1b}\r" || data == "\n") {
        return Some("shift+enter".to_string());
    }

    if let Some(key_id) = legacy_sequence_key_id(data) {
        return Some(key_id.to_string());
    }

    match data {
        "\u{1b}" => return Some("escape".to_string()),
        "\u{1c}" => return Some("ctrl+\\".to_string()),
        "\u{1d}" => return Some("ctrl+]".to_string()),
        "\u{1f}" => return Some("ctrl+-".to_string()),
        "\u{1b}\u{1b}" => return Some("ctrl+alt+[".to_string()),
        "\u{1b}\u{1c}" => return Some("ctrl+alt+\\".to_string()),
        "\u{1b}\u{1d}" => return Some("ctrl+alt+]".to_string()),
        "\u{1b}\u{1f}" => return Some("ctrl+alt+-".to_string()),
        "\t" => return Some("tab".to_string()),
        "\r" | "\u{1b}OM" => return Some("enter".to_string()),
        "\n" if !is_kitty_protocol_active() => return Some("enter".to_string()),
        "\u{0}" => return Some("ctrl+space".to_string()),
        " " => return Some("space".to_string()),
        "\u{7f}" => return Some("backspace".to_string()),
        "\u{8}" => {
            return Some(if is_windows_terminal_session(env) {
                "ctrl+backspace".to_string()
            } else {
                "backspace".to_string()
            });
        }
        "\u{1b}[Z" => return Some("shift+tab".to_string()),
        "\u{1b}\r" if !is_kitty_protocol_active() => return Some("alt+enter".to_string()),
        "\u{1b} " if !is_kitty_protocol_active() => return Some("alt+space".to_string()),
        "\u{1b}\u{7f}" | "\u{1b}\u{8}" => return Some("alt+backspace".to_string()),
        "\u{1b}B" if !is_kitty_protocol_active() => return Some("alt+left".to_string()),
        "\u{1b}F" if !is_kitty_protocol_active() => return Some("alt+right".to_string()),
        "\u{1b}[A" => return Some("up".to_string()),
        "\u{1b}[B" => return Some("down".to_string()),
        "\u{1b}[C" => return Some("right".to_string()),
        "\u{1b}[D" => return Some("left".to_string()),
        "\u{1b}[H" | "\u{1b}OH" => return Some("home".to_string()),
        "\u{1b}[F" | "\u{1b}OF" => return Some("end".to_string()),
        "\u{1b}[3~" => return Some("delete".to_string()),
        "\u{1b}[5~" => return Some("pageUp".to_string()),
        "\u{1b}[6~" => return Some("pageDown".to_string()),
        _ => {}
    }

    let chars = data.chars().collect::<Vec<_>>();
    if !is_kitty_protocol_active() && chars.len() == 2 && chars[0] == '\u{1b}' {
        let code = chars[1] as u32;
        if (1..=26).contains(&code) {
            return char::from_u32(code + 96).map(|ch| format!("ctrl+alt+{ch}"));
        }
        if (97..=122).contains(&code) || (48..=57).contains(&code) {
            return Some(format!("alt+{}", chars[1]));
        }
    }

    if chars.len() == 1 {
        let code = chars[0] as u32;
        if (1..=26).contains(&code) {
            return char::from_u32(code + 96).map(|ch| format!("ctrl+{ch}"));
        }
        if (32..=126).contains(&code) {
            return Some(data.to_string());
        }
    }

    None
}

pub fn decode_kitty_printable(data: &str) -> Option<String> {
    let parsed = parse_kitty_sequence(data)?;
    let modifier = parsed.modifier;
    let allowed_modifiers = MODIFIER_SHIFT | LOCK_MASK;
    if modifier & !allowed_modifiers != 0 {
        return None;
    }
    if modifier & (MODIFIER_ALT | MODIFIER_CTRL) != 0 {
        return None;
    }

    let mut effective_codepoint = parsed.codepoint;
    if modifier & MODIFIER_SHIFT != 0
        && let Some(shifted_key) = parsed.shifted_key
    {
        effective_codepoint = shifted_key;
    }
    effective_codepoint = normalize_kitty_functional_codepoint(effective_codepoint);
    if effective_codepoint < 32 {
        return None;
    }
    codepoint_to_string(effective_codepoint)
}

fn decode_modify_other_keys_printable(data: &str) -> Option<String> {
    let parsed = parse_modify_other_keys_sequence(data)?;
    let modifier = parsed.modifier & !LOCK_MASK;
    if modifier & !MODIFIER_SHIFT != 0 {
        return None;
    }
    if parsed.codepoint < 32 {
        return None;
    }
    codepoint_to_string(parsed.codepoint)
}

pub fn decode_printable_key(data: &str) -> Option<String> {
    decode_kitty_printable(data).or_else(|| decode_modify_other_keys_printable(data))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn reset_kitty() {
        set_kitty_protocol_active(false);
    }

    fn local_windows_terminal_env() -> KeyEnvironment {
        KeyEnvironment {
            wt_session: Some("test-session".to_string()),
            ..Default::default()
        }
    }

    fn ssh_windows_terminal_env() -> KeyEnvironment {
        KeyEnvironment {
            wt_session: Some("test-session".to_string()),
            ssh_connection: Some("1 2 3 4".to_string()),
            ssh_client: Some("1 2 3".to_string()),
            ssh_tty: Some("/dev/pts/1".to_string()),
        }
    }

    #[test]
    fn matches_kitty_alternate_layout_keys() {
        let _guard = TEST_LOCK.lock().expect("test lock poisoned");
        set_kitty_protocol_active(true);

        assert!(matches_key("\u{1b}[1089::99;5u", "ctrl+c"));
        assert!(matches_key("\u{1b}[1074::100;5u", "ctrl+d"));
        assert!(matches_key("\u{1b}[1103::122;5u", "ctrl+z"));
        assert!(matches_key("\u{1b}[1079::112;6u", "ctrl+shift+p"));
        assert!(matches_key("\u{1b}[99;5u", "ctrl+c"));
        assert!(!matches_key("\u{1b}[1089::99;5u", "ctrl+d"));
        assert!(!matches_key("\u{1b}[1089::99;5u", "ctrl+shift+c"));

        reset_kitty();
    }

    #[test]
    fn matches_super_digit_and_keypad_kitty_bindings() {
        let _guard = TEST_LOCK.lock().expect("test lock poisoned");
        set_kitty_protocol_active(true);

        assert!(matches_key("\u{1b}[107;9u", "super+k"));
        assert!(matches_key("\u{1b}[13;9u", "super+enter"));
        assert!(matches_key("\u{1b}[107;13u", "ctrl+super+k"));
        assert!(matches_key("\u{1b}[107;14u", "ctrl+shift+super+k"));
        assert!(!matches_key("\u{1b}[107;13u", "super+k"));
        assert_eq!(parse_key("\u{1b}[107;9u").as_deref(), Some("super+k"));
        assert_eq!(parse_key("\u{1b}[13;9u").as_deref(), Some("super+enter"));
        assert_eq!(parse_key("\u{1b}[107;13u").as_deref(), Some("ctrl+super+k"));
        assert_eq!(
            parse_key("\u{1b}[107;14u").as_deref(),
            Some("shift+ctrl+super+k")
        );

        assert!(matches_key("\u{1b}[49u", "1"));
        assert!(matches_key("\u{1b}[49;5u", "ctrl+1"));
        assert!(!matches_key("\u{1b}[49;5u", "ctrl+2"));
        assert_eq!(parse_key("\u{1b}[49u").as_deref(), Some("1"));
        assert_eq!(parse_key("\u{1b}[49;5u").as_deref(), Some("ctrl+1"));

        assert!(matches_key("\u{1b}[57400u", "1"));
        assert!(matches_key("\u{1b}[57410u", "/"));
        assert!(matches_key("\u{1b}[57417u", "left"));
        assert!(matches_key("\u{1b}[57426u", "delete"));
        assert_eq!(parse_key("\u{1b}[57399u").as_deref(), Some("0"));
        assert_eq!(parse_key("\u{1b}[57409u").as_deref(), Some("."));
        assert_eq!(parse_key("\u{1b}[57413u").as_deref(), Some("+"));
        assert_eq!(parse_key("\u{1b}[57416u").as_deref(), Some(","));
        assert_eq!(parse_key("\u{1b}[57417u").as_deref(), Some("left"));
        assert_eq!(parse_key("\u{1b}[57418u").as_deref(), Some("right"));
        assert_eq!(parse_key("\u{1b}[57419u").as_deref(), Some("up"));
        assert_eq!(parse_key("\u{1b}[57420u").as_deref(), Some("down"));
        assert_eq!(parse_key("\u{1b}[57421u").as_deref(), Some("pageUp"));
        assert_eq!(parse_key("\u{1b}[57422u").as_deref(), Some("pageDown"));
        assert_eq!(parse_key("\u{1b}[57423u").as_deref(), Some("home"));
        assert_eq!(parse_key("\u{1b}[57424u").as_deref(), Some("end"));
        assert_eq!(parse_key("\u{1b}[57425u").as_deref(), Some("insert"));
        assert_eq!(parse_key("\u{1b}[57426u").as_deref(), Some("delete"));

        reset_kitty();
    }

    #[test]
    fn handles_shifted_event_and_layout_authority_rules() {
        let _guard = TEST_LOCK.lock().expect("test lock poisoned");
        set_kitty_protocol_active(true);

        assert!(matches_key("\u{1b}[99:67:99;2u", "shift+c"));
        assert!(matches_key("\u{1b}[1089::99;5:3u", "ctrl+c"));
        assert!(matches_key("\u{1b}[1089:1057:99;6:2u", "ctrl+shift+c"));
        assert!(matches_key("\u{1b}[107::118;5u", "ctrl+k"));
        assert!(!matches_key("\u{1b}[107::118;5u", "ctrl+v"));
        assert!(matches_key("\u{1b}[47::91;5u", "ctrl+/"));
        assert!(!matches_key("\u{1b}[47::91;5u", "ctrl+["));
        assert_eq!(parse_key("\u{1b}[1089::99;5u").as_deref(), Some("ctrl+c"));
        assert_eq!(parse_key("\u{1b}[107::118;5u").as_deref(), Some("ctrl+k"));
        assert_eq!(parse_key("\u{1b}[47::91;5u").as_deref(), Some("ctrl+/"));
        assert_eq!(parse_key("\u{1b}[69;2u").as_deref(), Some("shift+e"));
        assert_eq!(parse_key("\u{1b}[99;17u"), None);

        reset_kitty();
    }

    #[test]
    fn matches_modify_other_keys_sequences() {
        let _guard = TEST_LOCK.lock().expect("test lock poisoned");
        reset_kitty();

        for (sequence, key) in [
            ("\u{1b}[27;5;99~", "ctrl+c"),
            ("\u{1b}[27;5;100~", "ctrl+d"),
            ("\u{1b}[27;5;122~", "ctrl+z"),
            ("\u{1b}[27;5;13~", "ctrl+enter"),
            ("\u{1b}[27;2;13~", "shift+enter"),
            ("\u{1b}[27;3;13~", "alt+enter"),
            ("\u{1b}[27;2;9~", "shift+tab"),
            ("\u{1b}[27;5;9~", "ctrl+tab"),
            ("\u{1b}[27;3;9~", "alt+tab"),
            ("\u{1b}[27;1;127~", "backspace"),
            ("\u{1b}[27;5;127~", "ctrl+backspace"),
            ("\u{1b}[27;3;127~", "alt+backspace"),
            ("\u{1b}[27;1;27~", "escape"),
            ("\u{1b}[27;1;32~", "space"),
            ("\u{1b}[27;5;32~", "ctrl+space"),
            ("\u{1b}[27;5;47~", "ctrl+/"),
            ("\u{1b}[27;5;49~", "ctrl+1"),
            ("\u{1b}[27;2;49~", "shift+1"),
            ("\u{1b}[27;2;69~", "shift+e"),
            ("\u{1b}[27;6;69~", "ctrl+shift+e"),
            ("\u{1b}[104;7u", "ctrl+alt+h"),
            ("\u{1b}[27;7;104~", "ctrl+alt+h"),
        ] {
            assert!(
                matches_key(sequence, key),
                "{sequence:?} should match {key}"
            );
        }

        assert_eq!(parse_key("\u{1b}[27;5;99~").as_deref(), Some("ctrl+c"));
        assert_eq!(parse_key("\u{1b}[27;2;13~").as_deref(), Some("shift+enter"));
        assert_eq!(
            parse_key("\u{1b}[27;6;69~").as_deref(),
            Some("shift+ctrl+e")
        );
    }

    #[test]
    fn matches_legacy_controls_and_backspace_environment_heuristic() {
        let _guard = TEST_LOCK.lock().expect("test lock poisoned");
        reset_kitty();

        assert!(matches_key("\u{3}", "ctrl+c"));
        assert!(matches_key("\u{4}", "ctrl+d"));
        assert!(matches_key("\u{1b}", "escape"));
        assert!(matches_key("\n", "enter"));
        assert_eq!(parse_key("\n").as_deref(), Some("enter"));
        assert!(matches_key("\u{0}", "ctrl+space"));
        assert_eq!(parse_key("\u{0}").as_deref(), Some("ctrl+space"));

        assert!(matches_key("\u{1c}", "ctrl+\\"));
        assert_eq!(parse_key("\u{1c}").as_deref(), Some("ctrl+\\"));
        assert!(matches_key("\u{1d}", "ctrl+]"));
        assert_eq!(parse_key("\u{1d}").as_deref(), Some("ctrl+]"));
        assert!(matches_key("\u{1f}", "ctrl+_"));
        assert!(matches_key("\u{1f}", "ctrl+-"));
        assert_eq!(parse_key("\u{1f}").as_deref(), Some("ctrl+-"));

        assert!(matches_key("\u{1b}\u{1b}", "ctrl+alt+["));
        assert_eq!(parse_key("\u{1b}\u{1b}").as_deref(), Some("ctrl+alt+["));
        assert!(matches_key("\u{1b}\u{1c}", "ctrl+alt+\\"));
        assert_eq!(parse_key("\u{1b}\u{1c}").as_deref(), Some("ctrl+alt+\\"));
        assert!(matches_key("\u{1b}\u{1d}", "ctrl+alt+]"));
        assert_eq!(parse_key("\u{1b}\u{1d}").as_deref(), Some("ctrl+alt+]"));
        assert!(matches_key("\u{1b}\u{1f}", "ctrl+alt+_"));
        assert!(matches_key("\u{1b}\u{1f}", "ctrl+alt+-"));
        assert_eq!(parse_key("\u{1b}\u{1f}").as_deref(), Some("ctrl+alt+-"));

        let default_env = KeyEnvironment::default();
        assert!(matches_key_with_env("\u{7f}", "backspace", &default_env));
        assert!(!matches_key_with_env(
            "\u{7f}",
            "ctrl+backspace",
            &default_env
        ));
        assert_eq!(
            parse_key_with_env("\u{8}", &default_env).as_deref(),
            Some("backspace")
        );
        assert!(matches_key_with_env("\u{8}", "backspace", &default_env));
        assert!(!matches_key_with_env(
            "\u{8}",
            "ctrl+backspace",
            &default_env
        ));
        assert!(matches_key_with_env("\u{8}", "ctrl+h", &default_env));

        let windows = local_windows_terminal_env();
        assert!(matches_key_with_env("\u{8}", "ctrl+backspace", &windows));
        assert!(!matches_key_with_env("\u{8}", "backspace", &windows));
        assert_eq!(
            parse_key_with_env("\u{8}", &windows).as_deref(),
            Some("ctrl+backspace")
        );

        let ssh = ssh_windows_terminal_env();
        assert!(!matches_key_with_env("\u{8}", "ctrl+backspace", &ssh));
        assert!(matches_key_with_env("\u{8}", "backspace", &ssh));
        assert_eq!(
            parse_key_with_env("\u{8}", &ssh).as_deref(),
            Some("backspace")
        );
    }

    #[test]
    fn respects_kitty_active_mode_for_ambiguous_legacy_sequences() {
        let _guard = TEST_LOCK.lock().expect("test lock poisoned");
        reset_kitty();

        assert!(matches_key("\u{1b} ", "alt+space"));
        assert_eq!(parse_key("\u{1b} ").as_deref(), Some("alt+space"));
        assert!(matches_key("\u{1b}\u{8}", "alt+backspace"));
        assert_eq!(parse_key("\u{1b}\u{8}").as_deref(), Some("alt+backspace"));
        assert!(matches_key("\u{1b}\u{3}", "ctrl+alt+c"));
        assert_eq!(parse_key("\u{1b}\u{3}").as_deref(), Some("ctrl+alt+c"));
        assert!(matches_key("\u{1b}B", "alt+left"));
        assert_eq!(parse_key("\u{1b}B").as_deref(), Some("alt+left"));
        assert!(matches_key("\u{1b}F", "alt+right"));
        assert_eq!(parse_key("\u{1b}F").as_deref(), Some("alt+right"));
        assert!(matches_key("\u{1b}a", "alt+a"));
        assert_eq!(parse_key("\u{1b}a").as_deref(), Some("alt+a"));
        assert!(matches_key("\u{1b}1", "alt+1"));
        assert_eq!(parse_key("\u{1b}1").as_deref(), Some("alt+1"));

        set_kitty_protocol_active(true);
        assert!(matches_key("\n", "shift+enter"));
        assert!(!matches_key("\n", "enter"));
        assert_eq!(parse_key("\n").as_deref(), Some("shift+enter"));
        assert!(!matches_key("\u{1b} ", "alt+space"));
        assert_eq!(parse_key("\u{1b} "), None);
        assert!(matches_key("\u{1b}\u{8}", "alt+backspace"));
        assert_eq!(parse_key("\u{1b}\u{8}").as_deref(), Some("alt+backspace"));
        assert!(!matches_key("\u{1b}\u{3}", "ctrl+alt+c"));
        assert_eq!(parse_key("\u{1b}\u{3}"), None);
        assert!(!matches_key("\u{1b}B", "alt+left"));
        assert_eq!(parse_key("\u{1b}B"), None);
        assert!(!matches_key("\u{1b}F", "alt+right"));
        assert_eq!(parse_key("\u{1b}F"), None);
        assert!(!matches_key("\u{1b}a", "alt+a"));
        assert_eq!(parse_key("\u{1b}a"), None);

        reset_kitty();
    }

    #[test]
    fn matches_arrows_function_keys_and_rxvt_modifiers() {
        let _guard = TEST_LOCK.lock().expect("test lock poisoned");
        reset_kitty();

        for (sequence, key) in [
            ("\u{1b}[A", "up"),
            ("\u{1b}[B", "down"),
            ("\u{1b}[C", "right"),
            ("\u{1b}[D", "left"),
            ("\u{1b}OA", "up"),
            ("\u{1b}OB", "down"),
            ("\u{1b}OC", "right"),
            ("\u{1b}OD", "left"),
            ("\u{1b}OH", "home"),
            ("\u{1b}OF", "end"),
            ("\u{1b}OP", "f1"),
            ("\u{1b}[24~", "f12"),
            ("\u{1b}[E", "clear"),
            ("\u{1b}p", "alt+up"),
            ("\u{1b}[1;3A", "alt+up"),
            ("\u{1b}[1;3B", "alt+down"),
            ("\u{1b}[a", "shift+up"),
            ("\u{1b}Oa", "ctrl+up"),
            ("\u{1b}[2$", "shift+insert"),
            ("\u{1b}[2^", "ctrl+insert"),
            ("\u{1b}[7$", "shift+home"),
        ] {
            assert!(
                matches_key(sequence, key),
                "{sequence:?} should match {key}"
            );
        }
        assert!(!matches_key("\u{1b}p", "up"));

        assert_eq!(parse_key("\u{1b}[A").as_deref(), Some("up"));
        assert_eq!(parse_key("\u{1b}OA").as_deref(), Some("up"));
        assert_eq!(parse_key("\u{1b}OP").as_deref(), Some("f1"));
        assert_eq!(parse_key("\u{1b}[24~").as_deref(), Some("f12"));
        assert_eq!(parse_key("\u{1b}[2^").as_deref(), Some("ctrl+insert"));
        assert_eq!(parse_key("\u{1b}p").as_deref(), Some("alt+up"));
        assert_eq!(parse_key("\u{1b}[[5~").as_deref(), Some("pageUp"));
    }

    #[test]
    fn parses_special_and_raw_printable_keys() {
        let _guard = TEST_LOCK.lock().expect("test lock poisoned");
        reset_kitty();

        assert_eq!(parse_key("\u{1b}").as_deref(), Some("escape"));
        assert_eq!(parse_key("\t").as_deref(), Some("tab"));
        assert_eq!(parse_key("\r").as_deref(), Some("enter"));
        assert_eq!(parse_key("\n").as_deref(), Some("enter"));
        assert_eq!(parse_key("\u{0}").as_deref(), Some("ctrl+space"));
        assert_eq!(parse_key(" ").as_deref(), Some("space"));
        assert_eq!(parse_key("1").as_deref(), Some("1"));
        assert!(matches_key("1", "1"));
        assert_eq!(parse_key("\u{3}").as_deref(), Some("ctrl+c"));
        assert_eq!(parse_key("\u{4}").as_deref(), Some("ctrl+d"));
    }

    #[test]
    fn decodes_printable_sequences() {
        assert_eq!(
            decode_kitty_printable("\u{1b}[57399u").as_deref(),
            Some("0")
        );
        assert_eq!(
            decode_kitty_printable("\u{1b}[57400u").as_deref(),
            Some("1")
        );
        assert_eq!(
            decode_kitty_printable("\u{1b}[57409u").as_deref(),
            Some(".")
        );
        assert_eq!(
            decode_kitty_printable("\u{1b}[57410u").as_deref(),
            Some("/")
        );
        assert_eq!(
            decode_kitty_printable("\u{1b}[57411u").as_deref(),
            Some("*")
        );
        assert_eq!(
            decode_kitty_printable("\u{1b}[57412u").as_deref(),
            Some("-")
        );
        assert_eq!(
            decode_kitty_printable("\u{1b}[57413u").as_deref(),
            Some("+")
        );
        assert_eq!(
            decode_kitty_printable("\u{1b}[57415u").as_deref(),
            Some("=")
        );
        assert_eq!(
            decode_kitty_printable("\u{1b}[57416u").as_deref(),
            Some(",")
        );
        assert_eq!(decode_kitty_printable("\u{1b}[57417u"), None);

        assert_eq!(
            decode_printable_key("\u{1b}[27;2;69~").as_deref(),
            Some("E")
        );
        assert_eq!(
            decode_printable_key("\u{1b}[27;2;196~").as_deref(),
            Some("Ä")
        );
        assert_eq!(
            decode_printable_key("\u{1b}[27;2;32~").as_deref(),
            Some(" ")
        );
        assert_eq!(decode_printable_key("\u{1b}[27;2;13~"), None);
        assert_eq!(decode_printable_key("\u{1b}[27;6;69~"), None);
    }

    #[test]
    fn detects_key_release_and_repeat_without_paste_false_positives() {
        assert!(is_key_release("\u{1b}[1089::99;5:3u"));
        assert!(is_key_repeat("\u{1b}[1089::99;5:2u"));
        assert!(!is_key_release("\u{1b}[200~90:62:3F:A5\u{1b}[201~"));
        assert!(!is_key_repeat("\u{1b}[200~90:62:2F:A5\u{1b}[201~"));
    }
}
