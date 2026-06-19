use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicUsize, Ordering},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgb {
    pub r: i32,
    pub g: i32,
    pub b: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DefaultTerminalColors {
    pub foreground: Rgb,
    pub background: Rgb,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalBackgroundKind {
    Dark,
    Light,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalColorMode {
    TrueColor,
    Color256,
    Ansi16,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OscColorKind {
    Foreground,
    Background,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OscColorResponse {
    pub kind: OscColorKind,
    pub rgb: Rgb,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnsiColor {
    Hex(String),
    Index(u8),
    Empty,
}

pub const QUERY_DEFAULT_FOREGROUND: &str = "\u{1b}]10;?\u{1b}\\";
pub const QUERY_DEFAULT_BACKGROUND: &str = "\u{1b}]11;?\u{1b}\\";

const CUBE_VALUES: [i32; 6] = [0, 95, 135, 175, 215, 255];

type Listener = Arc<dyn Fn() + Send + Sync + 'static>;

static DEFAULT_TERMINAL_COLORS: OnceLock<Mutex<Option<DefaultTerminalColors>>> = OnceLock::new();
static DEFAULT_COLOR_LISTENERS: OnceLock<Mutex<Vec<(usize, Listener)>>> = OnceLock::new();
static NEXT_LISTENER_ID: AtomicUsize = AtomicUsize::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DefaultTerminalColorListener {
    id: usize,
}

impl DefaultTerminalColorListener {
    pub fn remove(self) {
        remove_default_terminal_color_listener(self.id);
    }
}

fn colors_cell() -> &'static Mutex<Option<DefaultTerminalColors>> {
    DEFAULT_TERMINAL_COLORS.get_or_init(|| Mutex::new(None))
}

fn listeners_cell() -> &'static Mutex<Vec<(usize, Listener)>> {
    DEFAULT_COLOR_LISTENERS.get_or_init(|| Mutex::new(Vec::new()))
}

fn clamp_channel(value: f64) -> i32 {
    value.round().clamp(0.0, 255.0) as i32
}

fn normalize_hex_channel(value: &str) -> Option<i32> {
    if !(2..=4).contains(&value.len()) || !value.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }

    let parsed = i32::from_str_radix(value, 16).ok()?;
    if value.len() <= 2 {
        return Some(parsed);
    }

    let max = 16_i32.pow(value.len() as u32) - 1;
    Some(((parsed as f64 / max as f64) * 255.0).round() as i32)
}

fn parse_rgb_payload(payload: &str) -> Option<Rgb> {
    if let Some(rest) = payload.strip_prefix("rgb:") {
        let parts = rest.split('/').collect::<Vec<_>>();
        if parts.len() != 3 {
            return None;
        }

        return Some(Rgb {
            r: normalize_hex_channel(parts[0])?,
            g: normalize_hex_channel(parts[1])?,
            b: normalize_hex_channel(parts[2])?,
        });
    }

    let hex = payload.strip_prefix('#').unwrap_or(payload);
    if hex.len() != 6 || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }

    Some(Rgb {
        r: i32::from_str_radix(&hex[0..2], 16).ok()?,
        g: i32::from_str_radix(&hex[2..4], 16).ok()?,
        b: i32::from_str_radix(&hex[4..6], 16).ok()?,
    })
}

fn color_distance(a: Rgb, b: Rgb) -> f64 {
    let dr = (a.r - b.r) as f64;
    let dg = (a.g - b.g) as f64;
    let db = (a.b - b.b) as f64;
    dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114
}

fn find_closest_index(value: i32, values: &[i32]) -> usize {
    let mut min_dist = i32::MAX;
    let mut min_index = 0;

    for (index, item) in values.iter().enumerate() {
        let dist = (value - item).abs();
        if dist < min_dist {
            min_dist = dist;
            min_index = index;
        }
    }

    min_index
}

fn gray_values() -> [i32; 24] {
    std::array::from_fn(|index| 8 + index as i32 * 10)
}

fn notify_default_color_listeners() {
    let listeners = listeners_cell()
        .lock()
        .expect("default color listener mutex poisoned")
        .iter()
        .map(|(_, listener)| Arc::clone(listener))
        .collect::<Vec<_>>();

    for listener in listeners {
        listener();
    }
}

fn remove_default_terminal_color_listener(id: usize) {
    let mut listeners = listeners_cell()
        .lock()
        .expect("default color listener mutex poisoned");
    listeners.retain(|(listener_id, _)| *listener_id != id);
}

pub fn rgb_to_hex(rgb: Rgb) -> String {
    format!(
        "#{:02x}{:02x}{:02x}",
        clamp_channel(rgb.r as f64),
        clamp_channel(rgb.g as f64),
        clamp_channel(rgb.b as f64)
    )
}

pub fn is_light_color(rgb: Rgb) -> bool {
    0.299 * rgb.r as f64 + 0.587 * rgb.g as f64 + 0.114 * rgb.b as f64 > 128.0
}

pub fn blend_color(top: Rgb, bottom: Rgb, alpha: f64) -> Rgb {
    let clamped_alpha = alpha.clamp(0.0, 1.0);
    Rgb {
        r: clamp_channel(top.r as f64 * clamped_alpha + bottom.r as f64 * (1.0 - clamped_alpha)),
        g: clamp_channel(top.g as f64 * clamped_alpha + bottom.g as f64 * (1.0 - clamped_alpha)),
        b: clamp_channel(top.b as f64 * clamped_alpha + bottom.b as f64 * (1.0 - clamped_alpha)),
    }
}

pub fn rgb_to_256(rgb: Rgb) -> u8 {
    let r_index = find_closest_index(rgb.r, &CUBE_VALUES);
    let g_index = find_closest_index(rgb.g, &CUBE_VALUES);
    let b_index = find_closest_index(rgb.b, &CUBE_VALUES);
    let cube_rgb = Rgb {
        r: CUBE_VALUES[r_index],
        g: CUBE_VALUES[g_index],
        b: CUBE_VALUES[b_index],
    };
    let cube_index = 16 + 36 * r_index + 6 * g_index + b_index;
    let cube_dist = color_distance(rgb, cube_rgb);

    let gray = (0.299 * rgb.r as f64 + 0.587 * rgb.g as f64 + 0.114 * rgb.b as f64).round() as i32;
    let gray_values = gray_values();
    let gray_index = find_closest_index(gray, &gray_values);
    let gray_value = gray_values[gray_index];
    let gray_rgb = Rgb {
        r: gray_value,
        g: gray_value,
        b: gray_value,
    };
    let ansi_gray_index = 232 + gray_index;
    let gray_dist = color_distance(rgb, gray_rgb);

    let max_channel = rgb.r.max(rgb.g).max(rgb.b);
    let min_channel = rgb.r.min(rgb.g).min(rgb.b);
    if max_channel - min_channel < 10 && gray_dist < cube_dist {
        return ansi_gray_index as u8;
    }

    cube_index as u8
}

pub fn best_ansi_color(rgb: Rgb, mode: TerminalColorMode) -> AnsiColor {
    match mode {
        TerminalColorMode::TrueColor => AnsiColor::Hex(rgb_to_hex(rgb)),
        TerminalColorMode::Color256 => AnsiColor::Index(rgb_to_256(rgb)),
        TerminalColorMode::Ansi16 | TerminalColorMode::Unknown => AnsiColor::Empty,
    }
}

pub fn parse_osc_color_response(sequence: &str) -> Option<OscColorResponse> {
    let rest = sequence.strip_prefix("\u{1b}]")?;
    let payload = rest
        .strip_suffix('\u{7}')
        .or_else(|| rest.strip_suffix("\u{1b}\\"))?;
    let (code, color_payload) = payload.split_once(';')?;
    if color_payload.contains(['\u{7}', '\u{1b}']) {
        return None;
    }

    let kind = match code {
        "10" => OscColorKind::Foreground,
        "11" => OscColorKind::Background,
        _ => return None,
    };

    Some(OscColorResponse {
        kind,
        rgb: parse_rgb_payload(color_payload)?,
    })
}

pub fn detect_background_from_color_fg_bg(value: Option<&str>) -> Option<TerminalBackgroundKind> {
    let value = value?;
    let parts = value.split(';').collect::<Vec<_>>();
    if parts.len() < 2 {
        return None;
    }

    let bg = parts[1].parse::<i32>().ok()?;
    if bg < 8 {
        Some(TerminalBackgroundKind::Dark)
    } else {
        Some(TerminalBackgroundKind::Light)
    }
}

pub fn get_default_terminal_colors() -> Option<DefaultTerminalColors> {
    *colors_cell()
        .lock()
        .expect("default terminal color mutex poisoned")
}

pub fn set_default_terminal_colors(colors: Option<DefaultTerminalColors>) {
    *colors_cell()
        .lock()
        .expect("default terminal color mutex poisoned") = colors;
    notify_default_color_listeners();
}

pub fn clear_default_terminal_colors() {
    set_default_terminal_colors(None);
}

pub fn get_terminal_background_kind() -> Option<TerminalBackgroundKind> {
    if let Some(colors) = get_default_terminal_colors() {
        return Some(if is_light_color(colors.background) {
            TerminalBackgroundKind::Light
        } else {
            TerminalBackgroundKind::Dark
        });
    }

    let color_fg_bg = std::env::var("COLORFGBG").ok();
    detect_background_from_color_fg_bg(color_fg_bg.as_deref())
}

pub fn on_default_terminal_colors_change<F>(listener: F) -> DefaultTerminalColorListener
where
    F: Fn() + Send + Sync + 'static,
{
    let id = NEXT_LISTENER_ID.fetch_add(1, Ordering::Relaxed);
    listeners_cell()
        .lock()
        .expect("default color listener mutex poisoned")
        .push((id, Arc::new(listener)));
    DefaultTerminalColorListener { id }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn parses_osc_10_11_rgb_responses_with_st_or_bel_terminators() {
        assert_eq!(
            parse_osc_color_response("\u{1b}]10;rgb:ffff/8000/0000\u{1b}\\"),
            Some(OscColorResponse {
                kind: OscColorKind::Foreground,
                rgb: Rgb {
                    r: 255,
                    g: 128,
                    b: 0
                },
            })
        );
        assert_eq!(
            parse_osc_color_response("\u{1b}]10;rgb:fff/800/000\u{1b}\\"),
            Some(OscColorResponse {
                kind: OscColorKind::Foreground,
                rgb: Rgb {
                    r: 255,
                    g: 128,
                    b: 0
                },
            })
        );
        assert_eq!(
            parse_osc_color_response("\u{1b}]11;rgb:00/5f/87\u{7}"),
            Some(OscColorResponse {
                kind: OscColorKind::Background,
                rgb: Rgb {
                    r: 0,
                    g: 95,
                    b: 135
                },
            })
        );
    }

    #[test]
    fn parses_hex_osc_color_payloads() {
        assert_eq!(
            parse_osc_color_response("\u{1b}]11;#005f87\u{7}"),
            Some(OscColorResponse {
                kind: OscColorKind::Background,
                rgb: Rgb {
                    r: 0,
                    g: 95,
                    b: 135
                },
            })
        );
        assert_eq!(
            parse_osc_color_response("\u{1b}]10;005f87\u{1b}\\"),
            Some(OscColorResponse {
                kind: OscColorKind::Foreground,
                rgb: Rgb {
                    r: 0,
                    g: 95,
                    b: 135
                },
            })
        );
    }

    #[test]
    fn ignores_invalid_osc_color_responses() {
        assert_eq!(
            parse_osc_color_response("\u{1b}]12;rgb:ffff/ffff/ffff\u{1b}\\"),
            None
        );
        assert_eq!(
            parse_osc_color_response("\u{1b}]11;not-a-color\u{1b}\\"),
            None
        );
        assert_eq!(
            parse_osc_color_response("\u{1b}]11;rgb:ff/not/00\u{1b}\\"),
            None
        );
    }

    #[test]
    fn classifies_lightness_and_blends_colors() {
        assert!(is_light_color(Rgb {
            r: 255,
            g: 255,
            b: 255,
        }));
        assert!(!is_light_color(Rgb { r: 0, g: 0, b: 0 }));
        assert_eq!(
            blend_color(
                Rgb {
                    r: 255,
                    g: 255,
                    b: 255,
                },
                Rgb { r: 0, g: 0, b: 0 },
                0.12
            ),
            Rgb {
                r: 31,
                g: 31,
                b: 31,
            }
        );
        assert_eq!(
            blend_color(
                Rgb { r: 0, g: 0, b: 0 },
                Rgb {
                    r: 255,
                    g: 255,
                    b: 255,
                },
                0.04
            ),
            Rgb {
                r: 245,
                g: 245,
                b: 245,
            }
        );
    }

    #[test]
    fn maps_rgb_colors_to_truecolor_and_256_color_values() {
        let teal = Rgb {
            r: 0,
            g: 95,
            b: 135,
        };
        assert_eq!(rgb_to_hex(teal), "#005f87");
        assert_eq!(rgb_to_256(teal), 24);
        assert_eq!(
            best_ansi_color(teal, TerminalColorMode::TrueColor),
            AnsiColor::Hex("#005f87".to_string())
        );
        assert_eq!(
            best_ansi_color(teal, TerminalColorMode::Color256),
            AnsiColor::Index(24)
        );
        assert_eq!(
            best_ansi_color(teal, TerminalColorMode::Ansi16),
            AnsiColor::Empty
        );
    }

    #[test]
    fn detects_background_from_colorfgbg() {
        assert_eq!(
            detect_background_from_color_fg_bg(Some("0;15")),
            Some(TerminalBackgroundKind::Light)
        );
        assert_eq!(
            detect_background_from_color_fg_bg(Some("15;0")),
            Some(TerminalBackgroundKind::Dark)
        );
        assert_eq!(detect_background_from_color_fg_bg(Some("invalid")), None);
        assert_eq!(detect_background_from_color_fg_bg(None), None);
    }

    #[test]
    fn uses_probed_background_before_colorfgbg_fallback() {
        let _guard = TEST_LOCK.lock().expect("test lock poisoned");
        clear_default_terminal_colors();
        assert_eq!(get_default_terminal_colors(), None);

        set_default_terminal_colors(Some(DefaultTerminalColors {
            foreground: Rgb {
                r: 255,
                g: 255,
                b: 255,
            },
            background: Rgb { r: 0, g: 0, b: 0 },
        }));

        assert_eq!(
            get_terminal_background_kind(),
            Some(TerminalBackgroundKind::Dark)
        );
        clear_default_terminal_colors();
    }

    #[test]
    fn notifies_and_removes_default_color_listeners() {
        let _guard = TEST_LOCK.lock().expect("test lock poisoned");
        clear_default_terminal_colors();

        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_listener = Arc::clone(&calls);
        let listener = on_default_terminal_colors_change(move || {
            calls_for_listener.fetch_add(1, Ordering::SeqCst);
        });

        set_default_terminal_colors(Some(DefaultTerminalColors {
            foreground: Rgb {
                r: 255,
                g: 255,
                b: 255,
            },
            background: Rgb { r: 0, g: 0, b: 0 },
        }));
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        listener.remove();
        clear_default_terminal_colors();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
