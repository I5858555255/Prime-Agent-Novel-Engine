use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::mime::detect_supported_image_mime_type_from_file;
use crate::path_utils::resolve_read_path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessedFiles {
    pub text: String,
    pub images: Vec<ImageAttachment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    #[serde(rename = "type")]
    pub r#type: String,
    pub mime_type: String,
    pub data: String,
}

impl ImageAttachment {
    pub fn new(mime_type: impl Into<String>, data: impl Into<String>) -> Self {
        Self {
            r#type: "image".to_string(),
            mime_type: mime_type.into(),
            data: data.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessFileOptions {
    pub cwd: PathBuf,
}

impl ProcessFileOptions {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self { cwd: cwd.into() }
    }
}

impl Default for ProcessFileOptions {
    fn default() -> Self {
        Self {
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        }
    }
}

#[derive(Debug)]
pub enum FileProcessorError {
    MissingFile { path: PathBuf },
    Metadata { path: PathBuf, source: io::Error },
    Mime { path: PathBuf, source: io::Error },
    ReadFile { path: PathBuf, source: io::Error },
}

impl FileProcessorError {
    pub fn path(&self) -> &Path {
        match self {
            Self::MissingFile { path }
            | Self::Metadata { path, .. }
            | Self::Mime { path, .. }
            | Self::ReadFile { path, .. } => path,
        }
    }
}

impl fmt::Display for FileProcessorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingFile { path } => write!(formatter, "File not found: {}", path.display()),
            Self::Metadata { path, source } => {
                write!(
                    formatter,
                    "Could not inspect file {}: {source}",
                    path.display()
                )
            }
            Self::Mime { path, source } => {
                write!(
                    formatter,
                    "Could not detect file type for {}: {source}",
                    path.display()
                )
            }
            Self::ReadFile { path, source } => {
                write!(
                    formatter,
                    "Could not read file {}: {source}",
                    path.display()
                )
            }
        }
    }
}

impl Error for FileProcessorError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::MissingFile { .. } => None,
            Self::Metadata { source, .. }
            | Self::Mime { source, .. }
            | Self::ReadFile { source, .. } => Some(source),
        }
    }
}

pub fn process_file_arguments<I, S>(
    file_args: I,
    options: ProcessFileOptions,
) -> Result<ProcessedFiles, FileProcessorError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut text = String::new();
    let mut images = Vec::new();

    for file_arg in file_args {
        let absolute_path = resolve_read_path(file_arg.as_ref(), &options.cwd);
        let metadata = match fs::metadata(&absolute_path) {
            Ok(metadata) => metadata,
            Err(source) if source.kind() == io::ErrorKind::NotFound => {
                return Err(FileProcessorError::MissingFile {
                    path: absolute_path,
                });
            }
            Err(source) => {
                return Err(FileProcessorError::Metadata {
                    path: absolute_path,
                    source,
                });
            }
        };

        if metadata.len() == 0 {
            continue;
        }

        let mime_type =
            detect_supported_image_mime_type_from_file(&absolute_path).map_err(|source| {
                FileProcessorError::Mime {
                    path: absolute_path.clone(),
                    source,
                }
            })?;

        if let Some(mime_type) = mime_type {
            let content =
                fs::read(&absolute_path).map_err(|source| FileProcessorError::ReadFile {
                    path: absolute_path.clone(),
                    source,
                })?;
            images.push(ImageAttachment::new(mime_type, encode_base64(&content)));
            text.push_str(&format!(
                "<file name=\"{}\"></file>\n",
                absolute_path.to_string_lossy()
            ));
        } else {
            let content = fs::read_to_string(&absolute_path).map_err(|source| {
                FileProcessorError::ReadFile {
                    path: absolute_path.clone(),
                    source,
                }
            })?;
            text.push_str(&format!(
                "<file name=\"{}\">\n{content}\n</file>\n",
                absolute_path.to_string_lossy()
            ));
        }
    }

    Ok(ProcessedFiles { text, images })
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(bytes.len().div_ceil(3) * 4);

    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);

        result.push(TABLE[(first >> 2) as usize] as char);
        result.push(TABLE[(((first & 0b0000_0011) << 4) | (second >> 4)) as usize] as char);

        if chunk.len() >= 2 {
            result.push(TABLE[(((second & 0b0000_1111) << 2) | (third >> 6)) as usize] as char);
        } else {
            result.push('=');
        }

        if chunk.len() == 3 {
            result.push(TABLE[(third & 0b0011_1111) as usize] as char);
        } else {
            result.push('=');
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> io::Result<Self> {
            let base = std::env::temp_dir();
            let pid = std::process::id();

            for attempt in 0..100 {
                let nanos = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                let path = base.join(format!("file-processor-test-{pid}-{nanos}-{attempt}"));

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

    #[test]
    fn file_processor_wraps_text_files_with_absolute_file_tags() {
        let temp_dir = TempDir::new().unwrap();
        fs::write(temp_dir.path().join("prompt.txt"), "Hello\nworld").unwrap();

        let result = process_file_arguments(
            ["prompt.txt"],
            ProcessFileOptions::new(temp_dir.path().to_path_buf()),
        )
        .unwrap();

        assert_eq!(result.images, Vec::new());
        assert_eq!(
            result.text,
            format!(
                "<file name=\"{}\">\nHello\nworld\n</file>\n",
                temp_dir.path().join("prompt.txt").to_string_lossy()
            )
        );
    }

    #[test]
    fn file_processor_resolves_at_prefixed_paths() {
        let temp_dir = TempDir::new().unwrap();
        fs::write(temp_dir.path().join("prompt.txt"), "content").unwrap();

        let result = process_file_arguments(
            ["@prompt.txt"],
            ProcessFileOptions::new(temp_dir.path().to_path_buf()),
        )
        .unwrap();

        assert!(result.text.contains("content"));
        assert!(
            result.text.contains(
                temp_dir
                    .path()
                    .join("prompt.txt")
                    .to_string_lossy()
                    .as_ref()
            )
        );
    }

    #[test]
    fn file_processor_rejects_missing_files() {
        let temp_dir = TempDir::new().unwrap();

        let err = process_file_arguments(
            ["missing.txt"],
            ProcessFileOptions::new(temp_dir.path().to_path_buf()),
        )
        .unwrap_err();

        assert!(matches!(err, FileProcessorError::MissingFile { .. }));
        assert_eq!(err.path(), temp_dir.path().join("missing.txt"));
    }

    #[test]
    fn file_processor_skips_empty_files() {
        let temp_dir = TempDir::new().unwrap();
        fs::write(temp_dir.path().join("empty.txt"), "").unwrap();
        fs::write(temp_dir.path().join("prompt.txt"), "content").unwrap();

        let result = process_file_arguments(
            ["empty.txt", "prompt.txt"],
            ProcessFileOptions::new(temp_dir.path().to_path_buf()),
        )
        .unwrap();

        assert_eq!(result.images, Vec::new());
        assert_eq!(result.text.matches("<file name=").count(), 1);
        assert!(result.text.contains("content"));
    }

    #[test]
    fn file_processor_detects_supported_images_and_returns_attachments() {
        let temp_dir = TempDir::new().unwrap();
        let png = b"\x89PNG\r\n\x1a\nrest";
        fs::write(temp_dir.path().join("image.png"), png).unwrap();

        let result = process_file_arguments(
            ["image.png"],
            ProcessFileOptions::new(temp_dir.path().to_path_buf()),
        )
        .unwrap();

        assert_eq!(
            result.text,
            format!(
                "<file name=\"{}\"></file>\n",
                temp_dir.path().join("image.png").to_string_lossy()
            )
        );
        assert_eq!(
            result.images,
            vec![ImageAttachment {
                r#type: "image".to_string(),
                mime_type: "image/png".to_string(),
                data: encode_base64(png),
            }]
        );
        assert_eq!(result.images[0].data, "iVBORw0KGgpyZXN0");
    }

    #[test]
    fn file_processor_image_attachment_serializes_with_typescript_fields() {
        let value = serde_json::to_value(ImageAttachment::new("image/png", "base64-data")).unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "type": "image",
                "mimeType": "image/png",
                "data": "base64-data",
            })
        );
    }

    #[test]
    fn file_processor_treats_unsupported_binary_as_text_and_surfaces_utf8_errors() {
        let temp_dir = TempDir::new().unwrap();
        fs::write(temp_dir.path().join("binary.bin"), [0xff, 0xfe, 0xfd]).unwrap();

        let err = process_file_arguments(
            ["binary.bin"],
            ProcessFileOptions::new(temp_dir.path().to_path_buf()),
        )
        .unwrap_err();

        assert!(matches!(err, FileProcessorError::ReadFile { .. }));
    }

    #[test]
    fn file_processor_base64_encoder_matches_standard_padding_cases() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        assert_eq!(encode_base64(b"foob"), "Zm9vYg==");
        assert_eq!(encode_base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(encode_base64(b"foobar"), "Zm9vYmFy");
    }
}
