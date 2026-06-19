use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::str;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::truncate::{
    DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, TruncationLimit, TruncationOptions, TruncationResult,
    truncate_tail,
};

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OutputAccumulatorOptions {
    pub max_lines: Option<usize>,
    pub max_bytes: Option<usize>,
    pub temp_file_prefix: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OutputSnapshotOptions {
    pub persist_if_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputSnapshot {
    pub content: String,
    pub truncation: TruncationResult,
    pub full_output_path: Option<PathBuf>,
}

#[derive(Debug)]
pub enum OutputAccumulatorError {
    Finished,
    Io(io::Error),
}

pub struct OutputAccumulator {
    max_lines: usize,
    max_bytes: usize,
    max_rolling_bytes: usize,
    temp_file_prefix: String,
    decoder: StreamingUtf8Decoder,
    raw_chunks: Vec<Vec<u8>>,
    tail_text: String,
    tail_bytes: usize,
    tail_starts_at_line_boundary: bool,
    total_raw_bytes: usize,
    total_decoded_bytes: usize,
    total_lines: usize,
    current_line_bytes: usize,
    finished: bool,
    temp_file_path: Option<PathBuf>,
    temp_file: Option<File>,
}

#[derive(Debug, Default)]
struct StreamingUtf8Decoder {
    pending: Vec<u8>,
}

impl fmt::Display for OutputAccumulatorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Finished => formatter.write_str("Cannot append to a finished output accumulator"),
            Self::Io(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for OutputAccumulatorError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Finished => None,
            Self::Io(error) => Some(error),
        }
    }
}

impl From<io::Error> for OutputAccumulatorError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl OutputAccumulator {
    pub fn new(options: OutputAccumulatorOptions) -> Self {
        let max_lines = options.max_lines.unwrap_or(DEFAULT_MAX_LINES);
        let max_bytes = options.max_bytes.unwrap_or(DEFAULT_MAX_BYTES);

        Self {
            max_lines,
            max_bytes,
            max_rolling_bytes: max_bytes.saturating_mul(2).max(1),
            temp_file_prefix: options
                .temp_file_prefix
                .unwrap_or_else(|| "pi-output".to_owned()),
            decoder: StreamingUtf8Decoder::default(),
            raw_chunks: Vec::new(),
            tail_text: String::new(),
            tail_bytes: 0,
            tail_starts_at_line_boundary: true,
            total_raw_bytes: 0,
            total_decoded_bytes: 0,
            total_lines: 1,
            current_line_bytes: 0,
            finished: false,
            temp_file_path: None,
            temp_file: None,
        }
    }

    pub fn append(&mut self, data: &[u8]) -> Result<(), OutputAccumulatorError> {
        if self.finished {
            return Err(OutputAccumulatorError::Finished);
        }

        self.total_raw_bytes += data.len();
        let decoded = self.decoder.decode(data, false);
        self.append_decoded_text(&decoded);

        if self.temp_file.is_some() || self.should_use_temp_file() {
            self.ensure_temp_file()?;
            if let Some(file) = &mut self.temp_file {
                file.write_all(data)?;
            }
        } else if !data.is_empty() {
            self.raw_chunks.push(data.to_vec());
        }

        Ok(())
    }

    pub fn finish(&mut self) -> Result<(), OutputAccumulatorError> {
        if self.finished {
            return Ok(());
        }

        self.finished = true;
        let decoded = self.decoder.decode(&[], true);
        self.append_decoded_text(&decoded);

        if self.should_use_temp_file() {
            self.ensure_temp_file()?;
        }

        Ok(())
    }

    pub fn snapshot(
        &mut self,
        options: OutputSnapshotOptions,
    ) -> Result<OutputSnapshot, OutputAccumulatorError> {
        let tail_truncation = truncate_tail(
            &self.snapshot_text(),
            TruncationOptions {
                max_lines: Some(self.max_lines),
                max_bytes: Some(self.max_bytes),
            },
        );
        let truncated =
            self.total_lines > self.max_lines || self.total_decoded_bytes > self.max_bytes;
        let truncated_by = if truncated {
            tail_truncation
                .truncated_by
                .or(Some(if self.total_decoded_bytes > self.max_bytes {
                    TruncationLimit::Bytes
                } else {
                    TruncationLimit::Lines
                }))
        } else {
            None
        };
        let truncation = TruncationResult {
            content: tail_truncation.content,
            truncated,
            truncated_by,
            total_lines: self.total_lines,
            total_bytes: self.total_decoded_bytes,
            output_lines: tail_truncation.output_lines,
            output_bytes: tail_truncation.output_bytes,
            last_line_partial: tail_truncation.last_line_partial,
            first_line_exceeds_limit: tail_truncation.first_line_exceeds_limit,
            max_lines: self.max_lines,
            max_bytes: self.max_bytes,
        };

        if options.persist_if_truncated && truncation.truncated {
            self.ensure_temp_file()?;
        }

        Ok(OutputSnapshot {
            content: truncation.content.clone(),
            truncation,
            full_output_path: self.temp_file_path.clone(),
        })
    }

    pub fn close_temp_file(&mut self) -> Result<(), OutputAccumulatorError> {
        if let Some(mut file) = self.temp_file.take() {
            file.flush()?;
            file.sync_all()?;
        }

        Ok(())
    }

    pub fn get_last_line_bytes(&self) -> usize {
        self.current_line_bytes
    }

    pub fn full_output_path(&self) -> Option<&PathBuf> {
        self.temp_file_path.as_ref()
    }

    fn append_decoded_text(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }

        let bytes = text.len();
        self.total_decoded_bytes += bytes;
        self.tail_text.push_str(text);
        self.tail_bytes += bytes;

        if self.tail_bytes > self.max_rolling_bytes.saturating_mul(2) {
            self.trim_tail();
        }

        let newlines = text
            .as_bytes()
            .iter()
            .filter(|byte| **byte == b'\n')
            .count();
        if newlines == 0 {
            self.current_line_bytes += bytes;
        } else {
            self.total_lines += newlines;
            let last_newline = text.rfind('\n').expect("newlines counted above");
            self.current_line_bytes = text[last_newline + 1..].len();
        }
    }

    fn trim_tail(&mut self) {
        let bytes = self.tail_text.as_bytes();
        if bytes.len() <= self.max_rolling_bytes {
            self.tail_bytes = bytes.len();
            return;
        }

        let mut start = bytes.len() - self.max_rolling_bytes;
        while start < bytes.len() && (bytes[start] & 0xc0) == 0x80 {
            start += 1;
        }

        self.tail_starts_at_line_boundary = if start == 0 {
            self.tail_starts_at_line_boundary
        } else {
            bytes[start - 1] == b'\n'
        };
        self.tail_text = self.tail_text[start..].to_owned();
        self.tail_bytes = self.tail_text.len();
    }

    fn snapshot_text(&self) -> String {
        if self.tail_starts_at_line_boundary {
            return self.tail_text.clone();
        }

        match self.tail_text.find('\n') {
            Some(first_newline) => self.tail_text[first_newline + 1..].to_owned(),
            None => self.tail_text.clone(),
        }
    }

    fn should_use_temp_file(&self) -> bool {
        self.total_raw_bytes > self.max_bytes
            || self.total_decoded_bytes > self.max_bytes
            || self.total_lines > self.max_lines
    }

    fn ensure_temp_file(&mut self) -> Result<(), OutputAccumulatorError> {
        if self.temp_file_path.is_some() {
            return Ok(());
        }

        let (path, mut file) = create_temp_log_file(&self.temp_file_prefix)?;
        for chunk in &self.raw_chunks {
            file.write_all(chunk)?;
        }
        self.raw_chunks.clear();
        self.temp_file_path = Some(path);
        self.temp_file = Some(file);

        Ok(())
    }
}

impl StreamingUtf8Decoder {
    fn decode(&mut self, data: &[u8], final_chunk: bool) -> String {
        let mut buffer = Vec::with_capacity(self.pending.len() + data.len());
        buffer.extend_from_slice(&self.pending);
        buffer.extend_from_slice(data);
        self.pending.clear();

        let mut output = String::new();
        let mut position = 0usize;

        while position < buffer.len() {
            match str::from_utf8(&buffer[position..]) {
                Ok(valid) => {
                    output.push_str(valid);
                    position = buffer.len();
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        output.push_str(
                            str::from_utf8(&buffer[position..position + valid_up_to])
                                .expect("valid prefix from utf8 error"),
                        );
                        position += valid_up_to;
                    }

                    match error.error_len() {
                        Some(error_len) => {
                            output.push('\u{fffd}');
                            position += error_len;
                        }
                        None if final_chunk => {
                            output.push('\u{fffd}');
                            position = buffer.len();
                        }
                        None => {
                            self.pending.extend_from_slice(&buffer[position..]);
                            position = buffer.len();
                        }
                    }
                }
            }
        }

        output
    }
}

fn create_temp_log_file(prefix: &str) -> io::Result<(PathBuf, File)> {
    let mut last_error = None;

    for _ in 0..100 {
        let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        let file_name = format!(
            "{}-{}-{}-{}.log",
            prefix,
            std::process::id(),
            nanos,
            counter
        );
        let path = std::env::temp_dir().join(file_name);

        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                last_error = Some(error);
            }
            Err(error) => return Err(error),
        }
    }

    Err(last_error.unwrap_or_else(|| {
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "unable to create unique output accumulator temp log",
        )
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(max_lines: usize, max_bytes: usize) -> OutputAccumulatorOptions {
        OutputAccumulatorOptions {
            max_lines: Some(max_lines),
            max_bytes: Some(max_bytes),
            temp_file_prefix: Some(format!("pi-output-test-{}", std::process::id())),
        }
    }

    #[test]
    fn snapshot_reports_line_truncation_metadata() {
        let mut accumulator = OutputAccumulator::new(options(2, 100));
        accumulator.append(b"one\n").unwrap();
        accumulator.append(b"two\nthree").unwrap();

        let snapshot = accumulator
            .snapshot(OutputSnapshotOptions::default())
            .unwrap();

        assert_eq!(snapshot.content, "two\nthree");
        assert!(snapshot.truncation.truncated);
        assert_eq!(
            snapshot.truncation.truncated_by,
            Some(TruncationLimit::Lines)
        );
        assert_eq!(snapshot.truncation.total_lines, 3);
        assert_eq!(snapshot.truncation.total_bytes, "one\ntwo\nthree".len());
        assert_eq!(snapshot.truncation.output_lines, 2);
        assert_eq!(snapshot.truncation.output_bytes, "two\nthree".len());
        assert_eq!(accumulator.get_last_line_bytes(), "three".len());
        assert!(snapshot.full_output_path.is_some());
    }

    #[test]
    fn snapshot_reports_byte_truncation_metadata() {
        let mut accumulator = OutputAccumulator::new(options(10, 5));
        accumulator.append(b"alpha").unwrap();
        accumulator.append(b"beta").unwrap();

        let snapshot = accumulator
            .snapshot(OutputSnapshotOptions::default())
            .unwrap();

        assert_eq!(snapshot.content, "abeta");
        assert!(snapshot.truncation.truncated);
        assert_eq!(
            snapshot.truncation.truncated_by,
            Some(TruncationLimit::Bytes)
        );
        assert_eq!(snapshot.truncation.total_lines, 1);
        assert_eq!(snapshot.truncation.total_bytes, 9);
        assert_eq!(snapshot.truncation.output_bytes, 5);
        assert!(snapshot.truncation.last_line_partial);
    }

    #[test]
    fn decoder_preserves_multibyte_character_across_chunks() {
        let mut accumulator = OutputAccumulator::new(options(10, 100));
        let bytes = "aé\nz".as_bytes();
        accumulator.append(&bytes[..2]).unwrap();
        accumulator.append(&bytes[2..]).unwrap();
        accumulator.finish().unwrap();

        let snapshot = accumulator
            .snapshot(OutputSnapshotOptions::default())
            .unwrap();

        assert_eq!(snapshot.content, "aé\nz");
        assert!(!snapshot.truncation.truncated);
        assert_eq!(snapshot.truncation.total_bytes, "aé\nz".len());
        assert_eq!(accumulator.get_last_line_bytes(), 1);
    }

    #[test]
    fn decoder_replaces_incomplete_final_utf8() {
        let mut accumulator = OutputAccumulator::new(options(10, 100));
        accumulator.append(&[0xe2, 0x82]).unwrap();
        accumulator.finish().unwrap();

        let snapshot = accumulator
            .snapshot(OutputSnapshotOptions::default())
            .unwrap();

        assert_eq!(snapshot.content, "\u{fffd}");
        assert_eq!(snapshot.truncation.total_bytes, "\u{fffd}".len());
    }

    #[test]
    fn creates_and_persists_temp_file_when_requested_for_truncated_output() {
        let mut accumulator = OutputAccumulator::new(options(10, 5));
        accumulator.append(b"abc").unwrap();
        accumulator.append(b"def").unwrap();

        let snapshot = accumulator
            .snapshot(OutputSnapshotOptions {
                persist_if_truncated: true,
            })
            .unwrap();
        accumulator.close_temp_file().unwrap();

        let path = snapshot.full_output_path.expect("temp path");
        let contents = std::fs::read(&path).unwrap();
        assert_eq!(contents, b"abcdef");

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn append_after_finish_returns_error() {
        let mut accumulator = OutputAccumulator::new(OutputAccumulatorOptions::default());
        accumulator.append(b"done").unwrap();
        accumulator.finish().unwrap();

        let error = accumulator.append(b"again").unwrap_err();

        assert!(matches!(error, OutputAccumulatorError::Finished));
        assert_eq!(
            error.to_string(),
            "Cannot append to a finished output accumulator"
        );
    }
}
