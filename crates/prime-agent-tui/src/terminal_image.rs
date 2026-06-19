use std::sync::{
    Mutex, OnceLock,
    atomic::{AtomicU32, Ordering},
};

use base64::{Engine as _, engine::general_purpose};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageProtocol {
    Kitty,
    ITerm2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalCapabilities {
    pub images: Option<ImageProtocol>,
    pub true_color: bool,
    pub hyperlinks: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellDimensions {
    pub width_px: u32,
    pub height_px: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageDimensions {
    pub width_px: u32,
    pub height_px: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ImageRenderOptions {
    pub max_width_cells: Option<u32>,
    pub max_height_cells: Option<u32>,
    pub preserve_aspect_ratio: Option<bool>,
    pub image_id: Option<u32>,
    pub move_cursor: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageRender {
    pub sequence: String,
    pub rows: u32,
    pub image_id: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct KittyImageOptions {
    pub columns: Option<u32>,
    pub rows: Option<u32>,
    pub image_id: Option<u32>,
    pub move_cursor: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ITerm2ImageOptions {
    pub width: Option<String>,
    pub height: Option<String>,
    pub name: Option<String>,
    pub preserve_aspect_ratio: Option<bool>,
    pub inline: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TerminalEnvironment {
    pub term_program: Option<String>,
    pub term: Option<String>,
    pub color_term: Option<String>,
    pub tmux: Option<String>,
    pub kitty_window_id: Option<String>,
    pub ghostty_resources_dir: Option<String>,
    pub wezterm_pane: Option<String>,
    pub iterm_session_id: Option<String>,
}

const KITTY_PREFIX: &str = "\u{1b}_G";
const ITERM2_PREFIX: &str = "\u{1b}]1337;File=";
const DEFAULT_CELL_DIMENSIONS: CellDimensions = CellDimensions {
    width_px: 9,
    height_px: 18,
};

static CACHED_CAPABILITIES: OnceLock<Mutex<Option<TerminalCapabilities>>> = OnceLock::new();
static CELL_DIMENSIONS: OnceLock<Mutex<CellDimensions>> = OnceLock::new();
static NEXT_IMAGE_ID: AtomicU32 = AtomicU32::new(1);

fn capabilities_cell() -> &'static Mutex<Option<TerminalCapabilities>> {
    CACHED_CAPABILITIES.get_or_init(|| Mutex::new(None))
}

fn cell_dimensions_cell() -> &'static Mutex<CellDimensions> {
    CELL_DIMENSIONS.get_or_init(|| Mutex::new(DEFAULT_CELL_DIMENSIONS))
}

fn env_is_set(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|item| !item.is_empty())
}

fn is_true_color(color_term: &str) -> bool {
    matches!(color_term, "truecolor" | "24bit")
}

fn decode_base64(base64_data: &str) -> Option<Vec<u8>> {
    general_purpose::STANDARD.decode(base64_data).ok()
}

fn read_u16_be(data: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes([
        *data.get(offset)?,
        *data.get(offset + 1)?,
    ]))
}

fn read_u16_le(data: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes([
        *data.get(offset)?,
        *data.get(offset + 1)?,
    ]))
}

fn read_u32_be(data: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes([
        *data.get(offset)?,
        *data.get(offset + 1)?,
        *data.get(offset + 2)?,
        *data.get(offset + 3)?,
    ]))
}

fn read_u32_le(data: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *data.get(offset)?,
        *data.get(offset + 1)?,
        *data.get(offset + 2)?,
        *data.get(offset + 3)?,
    ]))
}

fn read_u24_le(data: &[u8], offset: usize) -> Option<u32> {
    Some(
        *data.get(offset)? as u32
            | ((*data.get(offset + 1)? as u32) << 8)
            | ((*data.get(offset + 2)? as u32) << 16),
    )
}

impl TerminalEnvironment {
    pub fn from_current_env() -> Self {
        Self {
            term_program: std::env::var("TERM_PROGRAM").ok(),
            term: std::env::var("TERM").ok(),
            color_term: std::env::var("COLORTERM").ok(),
            tmux: std::env::var("TMUX").ok(),
            kitty_window_id: std::env::var("KITTY_WINDOW_ID").ok(),
            ghostty_resources_dir: std::env::var("GHOSTTY_RESOURCES_DIR").ok(),
            wezterm_pane: std::env::var("WEZTERM_PANE").ok(),
            iterm_session_id: std::env::var("ITERM_SESSION_ID").ok(),
        }
    }
}

pub fn get_cell_dimensions() -> CellDimensions {
    *cell_dimensions_cell()
        .lock()
        .expect("cell dimensions mutex poisoned")
}

pub fn set_cell_dimensions(dims: CellDimensions) {
    *cell_dimensions_cell()
        .lock()
        .expect("cell dimensions mutex poisoned") = dims;
}

pub fn detect_capabilities_from_env(env: &TerminalEnvironment) -> TerminalCapabilities {
    let term_program = env
        .term_program
        .as_deref()
        .unwrap_or_default()
        .to_lowercase();
    let term = env.term.as_deref().unwrap_or_default().to_lowercase();
    let color_term = env.color_term.as_deref().unwrap_or_default().to_lowercase();

    let true_color = is_true_color(&color_term);
    let in_tmux_or_screen =
        env_is_set(&env.tmux) || term.starts_with("tmux") || term.starts_with("screen");
    if in_tmux_or_screen {
        return TerminalCapabilities {
            images: None,
            true_color,
            hyperlinks: false,
        };
    }

    if env_is_set(&env.kitty_window_id) || term_program == "kitty" {
        return TerminalCapabilities {
            images: Some(ImageProtocol::Kitty),
            true_color: true,
            hyperlinks: true,
        };
    }

    if term_program == "ghostty"
        || term.contains("ghostty")
        || env_is_set(&env.ghostty_resources_dir)
    {
        return TerminalCapabilities {
            images: Some(ImageProtocol::Kitty),
            true_color: true,
            hyperlinks: true,
        };
    }

    if env_is_set(&env.wezterm_pane) || term_program == "wezterm" {
        return TerminalCapabilities {
            images: Some(ImageProtocol::Kitty),
            true_color: true,
            hyperlinks: true,
        };
    }

    if env_is_set(&env.iterm_session_id) || term_program == "iterm.app" {
        return TerminalCapabilities {
            images: Some(ImageProtocol::ITerm2),
            true_color: true,
            hyperlinks: true,
        };
    }

    if term_program == "vscode" || term_program == "alacritty" {
        return TerminalCapabilities {
            images: None,
            true_color: true,
            hyperlinks: true,
        };
    }

    TerminalCapabilities {
        images: None,
        true_color,
        hyperlinks: false,
    }
}

pub fn detect_capabilities() -> TerminalCapabilities {
    detect_capabilities_from_env(&TerminalEnvironment::from_current_env())
}

pub fn get_capabilities() -> TerminalCapabilities {
    let mut cached = capabilities_cell()
        .lock()
        .expect("terminal capabilities mutex poisoned");
    if let Some(capabilities) = *cached {
        return capabilities;
    }

    let capabilities = detect_capabilities();
    *cached = Some(capabilities);
    capabilities
}

pub fn reset_capabilities_cache() {
    *capabilities_cell()
        .lock()
        .expect("terminal capabilities mutex poisoned") = None;
}

pub fn set_capabilities(caps: TerminalCapabilities) {
    *capabilities_cell()
        .lock()
        .expect("terminal capabilities mutex poisoned") = Some(caps);
}

pub fn is_image_line(line: &str) -> bool {
    line.starts_with(KITTY_PREFIX)
        || line.starts_with(ITERM2_PREFIX)
        || line.contains(KITTY_PREFIX)
        || line.contains(ITERM2_PREFIX)
}

pub fn allocate_image_id() -> u32 {
    let id = NEXT_IMAGE_ID.fetch_add(1, Ordering::Relaxed);
    if id == 0 {
        NEXT_IMAGE_ID.store(1, Ordering::Relaxed);
        1
    } else {
        id
    }
}

pub fn encode_kitty(base64_data: &str, options: KittyImageOptions) -> String {
    const CHUNK_SIZE: usize = 4096;

    let mut params = vec!["a=T".to_string(), "f=100".to_string(), "q=2".to_string()];

    if options.move_cursor == Some(false) {
        params.push("C=1".to_string());
    }
    if let Some(columns) = options.columns {
        params.push(format!("c={columns}"));
    }
    if let Some(rows) = options.rows {
        params.push(format!("r={rows}"));
    }
    if let Some(image_id) = options.image_id {
        params.push(format!("i={image_id}"));
    }

    if base64_data.len() <= CHUNK_SIZE {
        return format!("\u{1b}_G{};{}\u{1b}\\", params.join(","), base64_data);
    }

    let mut chunks = Vec::new();
    let mut offset = 0;
    let mut is_first = true;

    while offset < base64_data.len() {
        let end = (offset + CHUNK_SIZE).min(base64_data.len());
        let chunk = &base64_data[offset..end];
        let is_last = end >= base64_data.len();

        if is_first {
            chunks.push(format!(
                "\u{1b}_G{},m=1;{}\u{1b}\\",
                params.join(","),
                chunk
            ));
            is_first = false;
        } else if is_last {
            chunks.push(format!("\u{1b}_Gm=0;{chunk}\u{1b}\\"));
        } else {
            chunks.push(format!("\u{1b}_Gm=1;{chunk}\u{1b}\\"));
        }

        offset = end;
    }

    chunks.join("")
}

pub fn delete_kitty_image(image_id: u32) -> String {
    format!("\u{1b}_Ga=d,d=I,i={image_id},q=2\u{1b}\\")
}

pub fn delete_all_kitty_images() -> String {
    "\u{1b}_Ga=d,d=A,q=2\u{1b}\\".to_string()
}

pub fn encode_iterm2(base64_data: &str, options: ITerm2ImageOptions) -> String {
    let mut params = vec![format!(
        "inline={}",
        if options.inline == Some(false) { 0 } else { 1 }
    )];

    if let Some(width) = options.width {
        params.push(format!("width={width}"));
    }
    if let Some(height) = options.height {
        params.push(format!("height={height}"));
    }
    if let Some(name) = options.name {
        let name_base64 = general_purpose::STANDARD.encode(name);
        params.push(format!("name={name_base64}"));
    }
    if options.preserve_aspect_ratio == Some(false) {
        params.push("preserveAspectRatio=0".to_string());
    }

    format!("\u{1b}]1337;File={}:{}\u{7}", params.join(";"), base64_data)
}

pub fn calculate_image_rows(
    image_dimensions: ImageDimensions,
    target_width_cells: u32,
    cell_dimensions: CellDimensions,
) -> u32 {
    let target_width_px = target_width_cells * cell_dimensions.width_px;
    let scale = target_width_px as f64 / image_dimensions.width_px as f64;
    let scaled_height_px = image_dimensions.height_px as f64 * scale;
    ((scaled_height_px / cell_dimensions.height_px as f64).ceil() as u32).max(1)
}

pub fn get_png_dimensions(base64_data: &str) -> Option<ImageDimensions> {
    let buffer = decode_base64(base64_data)?;

    if buffer.len() < 24 {
        return None;
    }

    if buffer[0..4] != [0x89, 0x50, 0x4e, 0x47] {
        return None;
    }

    Some(ImageDimensions {
        width_px: read_u32_be(&buffer, 16)?,
        height_px: read_u32_be(&buffer, 20)?,
    })
}

pub fn get_jpeg_dimensions(base64_data: &str) -> Option<ImageDimensions> {
    let buffer = decode_base64(base64_data)?;

    if buffer.len() < 2 || buffer[0] != 0xff || buffer[1] != 0xd8 {
        return None;
    }

    let mut offset = 2;
    while offset < buffer.len().saturating_sub(9) {
        if buffer[offset] != 0xff {
            offset += 1;
            continue;
        }

        let marker = buffer[offset + 1];
        if (0xc0..=0xc2).contains(&marker) {
            return Some(ImageDimensions {
                height_px: read_u16_be(&buffer, offset + 5)? as u32,
                width_px: read_u16_be(&buffer, offset + 7)? as u32,
            });
        }

        if offset + 3 >= buffer.len() {
            return None;
        }

        let length = read_u16_be(&buffer, offset + 2)? as usize;
        if length < 2 {
            return None;
        }
        offset += 2 + length;
    }

    None
}

pub fn get_gif_dimensions(base64_data: &str) -> Option<ImageDimensions> {
    let buffer = decode_base64(base64_data)?;

    if buffer.len() < 10 {
        return None;
    }

    if &buffer[0..6] != b"GIF87a" && &buffer[0..6] != b"GIF89a" {
        return None;
    }

    Some(ImageDimensions {
        width_px: read_u16_le(&buffer, 6)? as u32,
        height_px: read_u16_le(&buffer, 8)? as u32,
    })
}

pub fn get_webp_dimensions(base64_data: &str) -> Option<ImageDimensions> {
    let buffer = decode_base64(base64_data)?;

    if buffer.len() < 30 {
        return None;
    }

    if &buffer[0..4] != b"RIFF" || &buffer[8..12] != b"WEBP" {
        return None;
    }

    match &buffer[12..16] {
        b"VP8 " => Some(ImageDimensions {
            width_px: (read_u16_le(&buffer, 26)? & 0x3fff) as u32,
            height_px: (read_u16_le(&buffer, 28)? & 0x3fff) as u32,
        }),
        b"VP8L" => {
            if buffer.len() < 25 {
                return None;
            }
            let bits = read_u32_le(&buffer, 21)?;
            Some(ImageDimensions {
                width_px: (bits & 0x3fff) + 1,
                height_px: ((bits >> 14) & 0x3fff) + 1,
            })
        }
        b"VP8X" => Some(ImageDimensions {
            width_px: read_u24_le(&buffer, 24)? + 1,
            height_px: read_u24_le(&buffer, 27)? + 1,
        }),
        _ => None,
    }
}

pub fn get_image_dimensions(base64_data: &str, mime_type: &str) -> Option<ImageDimensions> {
    match mime_type {
        "image/png" => get_png_dimensions(base64_data),
        "image/jpeg" => get_jpeg_dimensions(base64_data),
        "image/gif" => get_gif_dimensions(base64_data),
        "image/webp" => get_webp_dimensions(base64_data),
        _ => None,
    }
}

pub fn render_image(
    base64_data: &str,
    image_dimensions: ImageDimensions,
    options: ImageRenderOptions,
) -> Option<ImageRender> {
    let caps = get_capabilities();
    let image_protocol = caps.images?;
    let max_width = options.max_width_cells.unwrap_or(80);
    let rows = calculate_image_rows(image_dimensions, max_width, get_cell_dimensions());

    match image_protocol {
        ImageProtocol::Kitty => Some(ImageRender {
            sequence: encode_kitty(
                base64_data,
                KittyImageOptions {
                    columns: Some(max_width),
                    rows: Some(rows),
                    image_id: options.image_id,
                    move_cursor: options.move_cursor,
                },
            ),
            rows,
            image_id: options.image_id,
        }),
        ImageProtocol::ITerm2 => Some(ImageRender {
            sequence: encode_iterm2(
                base64_data,
                ITerm2ImageOptions {
                    width: Some(max_width.to_string()),
                    height: Some("auto".to_string()),
                    preserve_aspect_ratio: Some(options.preserve_aspect_ratio.unwrap_or(true)),
                    ..Default::default()
                },
            ),
            rows,
            image_id: None,
        }),
    }
}

pub fn hyperlink(text: &str, url: &str) -> String {
    format!("\u{1b}]8;;{url}\u{1b}\\{text}\u{1b}]8;;\u{1b}\\")
}

pub fn image_fallback(
    mime_type: &str,
    dimensions: Option<ImageDimensions>,
    filename: Option<&str>,
) -> String {
    let mut parts = Vec::new();
    if let Some(filename) = filename {
        parts.push(filename.to_string());
    }
    parts.push(format!("[{mime_type}]"));
    if let Some(dimensions) = dimensions {
        parts.push(format!("{}x{}", dimensions.width_px, dimensions.height_px));
    }
    format!("[Image: {}]", parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn env(overrides: &[(&str, &str)]) -> TerminalEnvironment {
        let mut env = TerminalEnvironment::default();
        for (key, value) in overrides {
            match *key {
                "TERM" => env.term = Some((*value).to_string()),
                "TERM_PROGRAM" => env.term_program = Some((*value).to_string()),
                "COLORTERM" => env.color_term = Some((*value).to_string()),
                "TMUX" => env.tmux = Some((*value).to_string()),
                "KITTY_WINDOW_ID" => env.kitty_window_id = Some((*value).to_string()),
                "GHOSTTY_RESOURCES_DIR" => env.ghostty_resources_dir = Some((*value).to_string()),
                "WEZTERM_PANE" => env.wezterm_pane = Some((*value).to_string()),
                "ITERM_SESSION_ID" => env.iterm_session_id = Some((*value).to_string()),
                _ => panic!("unsupported test env key {key}"),
            }
        }
        env
    }

    fn encode(bytes: &[u8]) -> String {
        general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn detects_image_escape_sequences_anywhere_in_line() {
        assert!(is_image_line(
            "\u{1b}]1337;File=size=100,100;inline=1:data\u{7}"
        ));
        assert!(is_image_line(
            "Some text \u{1b}]1337;File=size=100,100;inline=1:data\u{7} more text"
        ));
        assert!(is_image_line("Output: \u{1b}_Ga=T,f=100;data\u{1b}\\"));
        assert!(is_image_line(&format!(
            "Text before \u{1b}_Ga=T,f=100{} text after",
            "A".repeat(300_000)
        )));
    }

    #[test]
    fn does_not_detect_non_image_lines() {
        assert!(!is_image_line("plain text"));
        assert!(!is_image_line("\u{1b}[31mred\u{1b}[0m"));
        assert!(!is_image_line("/path/to/File_1337_backup/image.jpg"));
        assert!(!is_image_line("./_G_test_file.txt"));
    }

    #[test]
    fn detects_terminal_capabilities_from_environment() {
        assert_eq!(
            detect_capabilities_from_env(&TerminalEnvironment::default()),
            TerminalCapabilities {
                images: None,
                true_color: false,
                hyperlinks: false,
            }
        );
        assert_eq!(
            detect_capabilities_from_env(&env(&[
                ("TMUX", "/tmp/tmux-1000/default,1234,0"),
                ("TERM_PROGRAM", "ghostty"),
            ])),
            TerminalCapabilities {
                images: None,
                true_color: false,
                hyperlinks: false,
            }
        );
        assert_eq!(
            detect_capabilities_from_env(&env(&[("TERM", "screen-256color")])),
            TerminalCapabilities {
                images: None,
                true_color: false,
                hyperlinks: false,
            }
        );
        assert_eq!(
            detect_capabilities_from_env(&env(&[("TERM_PROGRAM", "ghostty")])),
            TerminalCapabilities {
                images: Some(ImageProtocol::Kitty),
                true_color: true,
                hyperlinks: true,
            }
        );
        assert_eq!(
            detect_capabilities_from_env(&env(&[("KITTY_WINDOW_ID", "1")])),
            TerminalCapabilities {
                images: Some(ImageProtocol::Kitty),
                true_color: true,
                hyperlinks: true,
            }
        );
        assert_eq!(
            detect_capabilities_from_env(&env(&[("TERM_PROGRAM", "iterm.app")])),
            TerminalCapabilities {
                images: Some(ImageProtocol::ITerm2),
                true_color: true,
                hyperlinks: true,
            }
        );
        assert!(detect_capabilities_from_env(&env(&[("TERM_PROGRAM", "vscode")])).hyperlinks);
    }

    #[test]
    fn encodes_kitty_images_and_delete_commands() {
        let sequence = encode_kitty(
            "AAAA",
            KittyImageOptions {
                columns: Some(2),
                rows: Some(2),
                move_cursor: Some(false),
                ..Default::default()
            },
        );
        assert!(sequence.starts_with("\u{1b}_Ga=T,f=100,q=2,C=1,c=2,r=2;"));
        assert_eq!(delete_kitty_image(42), "\u{1b}_Ga=d,d=I,i=42,q=2\u{1b}\\");
        assert_eq!(delete_all_kitty_images(), "\u{1b}_Ga=d,d=A,q=2\u{1b}\\");
    }

    #[test]
    fn chunks_large_kitty_images() {
        let data = "A".repeat(4097);
        let sequence = encode_kitty(&data, KittyImageOptions::default());
        assert!(sequence.starts_with("\u{1b}_Ga=T,f=100,q=2,m=1;"));
        assert!(sequence.ends_with(&format!("\u{1b}_Gm=0;{}\u{1b}\\", "A")));
    }

    #[test]
    fn encodes_iterm2_images() {
        let sequence = encode_iterm2(
            "AAAA",
            ITerm2ImageOptions {
                width: Some("10".to_string()),
                height: Some("auto".to_string()),
                name: Some("image.png".to_string()),
                preserve_aspect_ratio: Some(false),
                inline: Some(true),
            },
        );
        assert_eq!(
            sequence,
            "\u{1b}]1337;File=inline=1;width=10;height=auto;name=aW1hZ2UucG5n;preserveAspectRatio=0:AAAA\u{7}"
        );
    }

    #[test]
    fn calculates_rows_from_cell_dimensions() {
        assert_eq!(
            calculate_image_rows(
                ImageDimensions {
                    width_px: 20,
                    height_px: 20,
                },
                2,
                CellDimensions {
                    width_px: 10,
                    height_px: 10,
                },
            ),
            2
        );
    }

    #[test]
    fn parses_png_dimensions() {
        let mut bytes = vec![0; 24];
        bytes[0..4].copy_from_slice(&[0x89, 0x50, 0x4e, 0x47]);
        bytes[16..20].copy_from_slice(&800_u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&600_u32.to_be_bytes());

        assert_eq!(
            get_png_dimensions(&encode(&bytes)),
            Some(ImageDimensions {
                width_px: 800,
                height_px: 600,
            })
        );
        assert_eq!(get_png_dimensions("not base64"), None);
    }

    #[test]
    fn parses_jpeg_dimensions() {
        let bytes = [
            0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02,
            0x58, 0x03, 0x20, 0x03,
        ];
        assert_eq!(
            get_jpeg_dimensions(&encode(&bytes)),
            Some(ImageDimensions {
                width_px: 800,
                height_px: 600,
            })
        );
    }

    #[test]
    fn parses_gif_dimensions() {
        let bytes = [b'G', b'I', b'F', b'8', b'9', b'a', 0x20, 0x03, 0x58, 0x02];
        assert_eq!(
            get_gif_dimensions(&encode(&bytes)),
            Some(ImageDimensions {
                width_px: 800,
                height_px: 600,
            })
        );
    }

    #[test]
    fn parses_webp_vp8x_dimensions() {
        let mut bytes = vec![0; 30];
        bytes[0..4].copy_from_slice(b"RIFF");
        bytes[8..12].copy_from_slice(b"WEBP");
        bytes[12..16].copy_from_slice(b"VP8X");
        bytes[24..27].copy_from_slice(&799_u32.to_le_bytes()[0..3]);
        bytes[27..30].copy_from_slice(&599_u32.to_le_bytes()[0..3]);

        assert_eq!(
            get_webp_dimensions(&encode(&bytes)),
            Some(ImageDimensions {
                width_px: 800,
                height_px: 600,
            })
        );
    }

    #[test]
    fn dispatches_image_dimensions_by_mime_type() {
        let mut bytes = vec![0; 24];
        bytes[0..4].copy_from_slice(&[0x89, 0x50, 0x4e, 0x47]);
        bytes[16..20].copy_from_slice(&1_u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&2_u32.to_be_bytes());

        assert_eq!(
            get_image_dimensions(&encode(&bytes), "image/png"),
            Some(ImageDimensions {
                width_px: 1,
                height_px: 2,
            })
        );
        assert_eq!(get_image_dimensions(&encode(&bytes), "image/bmp"), None);
    }

    #[test]
    fn renders_images_for_selected_protocol() {
        let _guard = TEST_LOCK.lock().expect("test lock poisoned");
        set_capabilities(TerminalCapabilities {
            images: Some(ImageProtocol::Kitty),
            true_color: true,
            hyperlinks: true,
        });
        set_cell_dimensions(CellDimensions {
            width_px: 10,
            height_px: 10,
        });

        let result = render_image(
            "AAAA",
            ImageDimensions {
                width_px: 20,
                height_px: 20,
            },
            ImageRenderOptions {
                max_width_cells: Some(2),
                move_cursor: Some(false),
                ..Default::default()
            },
        )
        .expect("kitty image should render");
        assert!(result.sequence.contains(",C=1,"));
        assert_eq!(result.rows, 2);

        set_capabilities(TerminalCapabilities {
            images: None,
            true_color: true,
            hyperlinks: true,
        });
        assert!(
            render_image(
                "AAAA",
                ImageDimensions {
                    width_px: 20,
                    height_px: 20,
                },
                ImageRenderOptions::default(),
            )
            .is_none()
        );

        reset_capabilities_cache();
        set_cell_dimensions(DEFAULT_CELL_DIMENSIONS);
    }

    #[test]
    fn wraps_hyperlinks_and_formats_image_fallbacks() {
        assert_eq!(
            hyperlink("click me", "https://example.com"),
            "\u{1b}]8;;https://example.com\u{1b}\\click me\u{1b}]8;;\u{1b}\\"
        );
        assert_eq!(
            image_fallback(
                "image/png",
                Some(ImageDimensions {
                    width_px: 800,
                    height_px: 600,
                }),
                Some("diagram.png"),
            ),
            "[Image: diagram.png [image/png] 800x600]"
        );
    }
}
