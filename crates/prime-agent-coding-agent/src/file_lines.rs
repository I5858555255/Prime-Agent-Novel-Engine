use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

const DEFAULT_MAX_BYTES: usize = 64 * 1024;
const CHUNK_SIZE: usize = 1024;

pub fn read_first_line_sync(path: impl AsRef<Path>) -> io::Result<Option<String>> {
    read_first_line_with_max_bytes(path, DEFAULT_MAX_BYTES)
}

pub fn read_first_line_with_max_bytes(
    path: impl AsRef<Path>,
    max_bytes: usize,
) -> io::Result<Option<String>> {
    let mut file = File::open(path)?;
    let mut chunks = Vec::new();
    let mut position = 0;
    let mut buffer = [0_u8; CHUNK_SIZE];

    while position < max_bytes {
        let bytes_to_read = buffer.len().min(max_bytes - position);
        let bytes_read = file.read(&mut buffer[..bytes_to_read])?;
        if bytes_read == 0 {
            break;
        }

        let chunk = &buffer[..bytes_read];
        if let Some(newline_index) = chunk.iter().position(|byte| *byte == b'\n') {
            chunks.extend_from_slice(&chunk[..newline_index]);
            return Ok(Some(trim_trailing_carriage_return(
                String::from_utf8_lossy(&chunks).into_owned(),
            )));
        }

        chunks.extend_from_slice(chunk);
        position += bytes_read;
    }

    if chunks.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trim_trailing_carriage_return(
            String::from_utf8_lossy(&chunks).into_owned(),
        )))
    }
}

fn trim_trailing_carriage_return(mut value: String) -> String {
    if value.ends_with('\r') {
        value.pop();
    }
    value
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
        let dir = std::env::temp_dir().join(format!(
            "prime-agent-file-lines-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn returns_undefined_equivalent_for_empty_files() {
        let path = temp_file("empty.txt", b"");

        assert_eq!(read_first_line_sync(path).unwrap(), None);
    }

    #[test]
    fn returns_the_first_line_without_the_newline() {
        let path = temp_file("lines.txt", b"alpha\nbeta\n");

        assert_eq!(
            read_first_line_sync(path).unwrap(),
            Some("alpha".to_string())
        );
    }

    #[test]
    fn strips_a_trailing_carriage_return_before_newline() {
        let path = temp_file("crlf.txt", b"alpha\r\nbeta\r\n");

        assert_eq!(
            read_first_line_sync(path).unwrap(),
            Some("alpha".to_string())
        );
    }

    #[test]
    fn reads_until_max_bytes_when_there_is_no_newline() {
        let path = temp_file("long.txt", b"abcdef");

        assert_eq!(
            read_first_line_with_max_bytes(path, 3).unwrap(),
            Some("abc".to_string())
        );
    }

    #[test]
    fn replaces_invalid_utf8_like_buffer_to_string_utf8() {
        let path = temp_file("invalid.bin", &[0xff, b'\n']);

        assert_eq!(
            read_first_line_sync(path).unwrap(),
            Some("\u{fffd}".to_string())
        );
    }
}
