use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

pub const FILE_TYPE_SNIFF_BYTES: usize = 4100;

pub fn detect_supported_image_mime_type_from_file(
    path: impl AsRef<Path>,
) -> io::Result<Option<&'static str>> {
    let mut file = File::open(path)?;
    let mut buffer = vec![0_u8; FILE_TYPE_SNIFF_BYTES];
    let bytes_read = file.read(&mut buffer)?;
    if bytes_read == 0 {
        return Ok(None);
    }

    Ok(detect_supported_image_mime_type_from_buffer(
        &buffer[..bytes_read],
    ))
}

pub fn detect_supported_image_mime_type_from_buffer(buffer: &[u8]) -> Option<&'static str> {
    if is_jpeg(buffer) {
        Some("image/jpeg")
    } else if is_png(buffer) {
        Some("image/png")
    } else if is_gif(buffer) {
        Some("image/gif")
    } else if is_webp(buffer) {
        Some("image/webp")
    } else {
        None
    }
}

fn is_jpeg(buffer: &[u8]) -> bool {
    buffer.starts_with(&[0xff, 0xd8, 0xff])
}

fn is_png(buffer: &[u8]) -> bool {
    buffer.starts_with(b"\x89PNG\r\n\x1a\n")
}

fn is_gif(buffer: &[u8]) -> bool {
    buffer.starts_with(b"GIF87a") || buffer.starts_with(b"GIF89a")
}

fn is_webp(buffer: &[u8]) -> bool {
    buffer.len() >= 12 && buffer.starts_with(b"RIFF") && &buffer[8..12] == b"WEBP"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_file(name: &str, contents: &[u8]) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("prime-agent-mime-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn detects_supported_image_signatures() {
        assert_eq!(
            detect_supported_image_mime_type_from_buffer(&[0xff, 0xd8, 0xff, 0xe0]),
            Some("image/jpeg")
        );
        assert_eq!(
            detect_supported_image_mime_type_from_buffer(b"\x89PNG\r\n\x1a\nrest"),
            Some("image/png")
        );
        assert_eq!(
            detect_supported_image_mime_type_from_buffer(b"GIF89a..."),
            Some("image/gif")
        );
        assert_eq!(
            detect_supported_image_mime_type_from_buffer(b"RIFFxxxxWEBPVP8 "),
            Some("image/webp")
        );
    }

    #[test]
    fn rejects_empty_or_unsupported_buffers() {
        assert_eq!(detect_supported_image_mime_type_from_buffer(b""), None);
        assert_eq!(
            detect_supported_image_mime_type_from_buffer(b"%PDF-1.7"),
            None
        );
        assert_eq!(
            detect_supported_image_mime_type_from_buffer(b"RIFFxxxxWAVE"),
            None
        );
    }

    #[test]
    fn reads_a_file_and_returns_null_equivalent_for_empty_files() {
        let path = temp_file("empty.bin", b"");

        assert_eq!(
            detect_supported_image_mime_type_from_file(path).unwrap(),
            None
        );
    }

    #[test]
    fn reads_a_file_and_detects_a_supported_image_type() {
        let path = temp_file("image.png", b"\x89PNG\r\n\x1a\nrest");

        assert_eq!(
            detect_supported_image_mime_type_from_file(path).unwrap(),
            Some("image/png")
        );
    }
}
