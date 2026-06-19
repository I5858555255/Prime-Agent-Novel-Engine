use std::env;

use prime_agent_ai::ContentBlock;

use crate::shell::sanitize_binary_output;

#[derive(Debug, Clone, PartialEq)]
pub struct ToolRenderResultLike<TDetails> {
    pub content: Vec<ContentBlock>,
    pub details: TDetails,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ImageDimensions {
    width_px: u32,
    height_px: u32,
}

pub fn shorten_path(path: &str) -> String {
    let Some(home) = home_dir() else {
        return path.to_owned();
    };
    let home = home.to_string_lossy();

    if path.starts_with(home.as_ref()) {
        format!("~{}", &path[home.len()..])
    } else {
        path.to_owned()
    }
}

pub fn shorten_path_value(path: Option<&serde_json::Value>) -> String {
    path.and_then(serde_json::Value::as_str)
        .map(shorten_path)
        .unwrap_or_default()
}

pub fn r#str(value: Option<&serde_json::Value>) -> Option<String> {
    match value {
        Some(serde_json::Value::String(value)) => Some(value.clone()),
        Some(serde_json::Value::Null) | None => Some(String::new()),
        _ => None,
    }
}

pub fn replace_tabs(text: &str) -> String {
    text.replace('\t', "   ")
}

pub fn normalize_display_text(text: &str) -> String {
    text.replace('\r', "")
}

pub fn get_text_output<TDetails>(
    result: Option<&ToolRenderResultLike<TDetails>>,
    _show_images: bool,
) -> String {
    let Some(result) = result else {
        return String::new();
    };

    let mut output = result
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text, .. } => Some(normalize_display_text(
                &sanitize_binary_output(&strip_ansi(text)),
            )),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");

    let image_indicators = result
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Image { data, mime_type } => {
                // The TypeScript implementation omits this fallback when terminal image rendering
                // is available and showImages is true. This crate does not currently depend on
                // prime-agent-tui, so local rendering behaves like a terminal with no image support.
                Some(image_fallback(
                    mime_type,
                    get_image_dimensions(data, mime_type),
                ))
            }
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");

    if !image_indicators.is_empty() {
        if output.is_empty() {
            output = image_indicators;
        } else {
            output.push('\n');
            output.push_str(&image_indicators);
        }
    }

    output
}

pub fn invalid_arg_text() -> &'static str {
    "[invalid arg]"
}

fn home_dir() -> Option<std::path::PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
}

fn strip_ansi(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            result.push(ch);
            continue;
        }

        match chars.peek().copied() {
            Some('[') => {
                chars.next();
                for code_ch in chars.by_ref() {
                    if ('@'..='~').contains(&code_ch) {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                let mut previous_was_escape = false;
                for code_ch in chars.by_ref() {
                    if code_ch == '\u{7}' || (previous_was_escape && code_ch == '\\') {
                        break;
                    }
                    previous_was_escape = code_ch == '\u{1b}';
                }
            }
            _ => {}
        }
    }

    result
}

fn image_fallback(mime_type: &str, dimensions: Option<ImageDimensions>) -> String {
    let mut parts = vec![format!("[{mime_type}]")];
    if let Some(dimensions) = dimensions {
        parts.push(format!("{}x{}", dimensions.width_px, dimensions.height_px));
    }
    format!("[Image: {}]", parts.join(" "))
}

fn get_image_dimensions(base64_data: &str, mime_type: &str) -> Option<ImageDimensions> {
    let bytes = decode_base64_prefix(base64_data, 64)?;

    match mime_type {
        "image/png" => get_png_dimensions(&bytes),
        "image/gif" => get_gif_dimensions(&bytes),
        _ => None,
    }
}

fn get_png_dimensions(bytes: &[u8]) -> Option<ImageDimensions> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 24 || &bytes[..8] != PNG_SIGNATURE {
        return None;
    }

    Some(ImageDimensions {
        width_px: u32::from_be_bytes(bytes[16..20].try_into().ok()?),
        height_px: u32::from_be_bytes(bytes[20..24].try_into().ok()?),
    })
}

fn get_gif_dimensions(bytes: &[u8]) -> Option<ImageDimensions> {
    if bytes.len() < 10 || (&bytes[..6] != b"GIF87a" && &bytes[..6] != b"GIF89a") {
        return None;
    }

    Some(ImageDimensions {
        width_px: u16::from_le_bytes(bytes[6..8].try_into().ok()?) as u32,
        height_px: u16::from_le_bytes(bytes[8..10].try_into().ok()?) as u32,
    })
}

fn decode_base64_prefix(value: &str, max_decoded_len: usize) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(max_decoded_len);
    let mut chunk = [0_u8; 4];
    let mut chunk_len = 0;

    for byte in value.bytes().filter(|byte| !byte.is_ascii_whitespace()) {
        chunk[chunk_len] = byte;
        chunk_len += 1;

        if chunk_len == 4 {
            push_base64_chunk(&chunk, &mut output)?;
            chunk_len = 0;
            if output.len() >= max_decoded_len {
                output.truncate(max_decoded_len);
                return Some(output);
            }
        }
    }

    if chunk_len > 0 {
        for slot in chunk.iter_mut().skip(chunk_len) {
            *slot = b'=';
        }
        push_base64_chunk(&chunk, &mut output)?;
    }

    output.truncate(max_decoded_len);
    Some(output)
}

fn push_base64_chunk(chunk: &[u8; 4], output: &mut Vec<u8>) -> Option<()> {
    let a = base64_value(chunk[0])?;
    let b = base64_value(chunk[1])?;
    let c = if chunk[2] == b'=' {
        0
    } else {
        base64_value(chunk[2])?
    };
    let d = if chunk[3] == b'=' {
        0
    } else {
        base64_value(chunk[3])?
    };

    output.push((a << 2) | (b >> 4));
    if chunk[2] != b'=' {
        output.push((b << 4) | (c >> 2));
    }
    if chunk[3] != b'=' {
        output.push((c << 6) | d);
    }

    Some(())
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        b'=' => Some(0),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shortens_home_path_and_ignores_non_string_values() {
        let home = home_dir().expect("home dir should be available for test");
        let home = home.to_string_lossy();

        assert_eq!(
            shorten_path(&format!("{home}/work/file.txt")),
            "~/work/file.txt"
        );
        assert_eq!(shorten_path_value(Some(&json!(123))), "");
    }

    #[test]
    fn str_matches_typescript_nullish_and_string_behavior() {
        assert_eq!(r#str(Some(&json!("hello"))), Some("hello".to_owned()));
        assert_eq!(r#str(Some(&serde_json::Value::Null)), Some(String::new()));
        assert_eq!(r#str(None), Some(String::new()));
        assert_eq!(r#str(Some(&json!(false))), None);
    }

    #[test]
    fn normalizes_tabs_and_carriage_returns() {
        assert_eq!(replace_tabs("a\tb\tc"), "a   b   c");
        assert_eq!(normalize_display_text("a\rb\r\nc"), "ab\nc");
    }

    #[test]
    fn get_text_output_sanitizes_text_blocks() {
        let result = ToolRenderResultLike {
            content: vec![
                ContentBlock::text("\u{1b}[31mred\u{1b}[0m\r\nok\u{0}"),
                ContentBlock::text("next"),
            ],
            details: (),
        };

        assert_eq!(get_text_output(Some(&result), false), "red\nok\nnext");
        assert_eq!(get_text_output::<()>(None, false), "");
    }

    #[test]
    fn get_text_output_appends_image_fallbacks_when_images_cannot_render() {
        let result = ToolRenderResultLike {
            content: vec![
                ContentBlock::text("text"),
                ContentBlock::image(
                    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAQAAADZc7J/AAAADElEQVR42mP8z8AARQAFAAH/aSXmAAAAAElFTkSuQmCC",
                    "image/png",
                ),
                ContentBlock::image("unknown", "image/jpeg"),
            ],
            details: (),
        };

        assert_eq!(
            get_text_output(Some(&result), false),
            "text\n[Image: [image/png] 2x3]\n[Image: [image/jpeg]]"
        );
        assert_eq!(
            get_text_output(Some(&result), true),
            "text\n[Image: [image/png] 2x3]\n[Image: [image/jpeg]]"
        );
    }

    #[test]
    fn invalid_arg_text_matches_unstyled_text() {
        assert_eq!(invalid_arg_text(), "[invalid arg]");
    }
}
