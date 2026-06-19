use std::mem;
use std::string::FromUtf8Error;

use serde::Serialize;

pub fn serialize_json_line<T: Serialize>(value: &T) -> Result<String, serde_json::Error> {
    serde_json::to_string(value).map(|json| format!("{json}\n"))
}

#[derive(Debug, Default)]
pub struct JsonlLineReader {
    pending: Vec<Vec<u8>>,
}

impl JsonlLineReader {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_chunk(&mut self, chunk: impl AsRef<[u8]>) -> Result<Vec<String>, FromUtf8Error> {
        let chunk = chunk.as_ref();
        let mut lines = Vec::new();
        let mut start = 0;

        for (index, byte) in chunk.iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }

            self.emit_from(&chunk[start..index], &mut lines)?;
            start = index + 1;
        }

        if start < chunk.len() {
            self.pending.push(chunk[start..].to_vec());
        }

        Ok(lines)
    }

    pub fn finish(&mut self) -> Result<Vec<String>, FromUtf8Error> {
        if self.pending.is_empty() {
            return Ok(Vec::new());
        }

        let line = self.take_pending_line(Vec::new())?;
        Ok(vec![line])
    }

    fn emit_from(&mut self, segment: &[u8], lines: &mut Vec<String>) -> Result<(), FromUtf8Error> {
        let line = if self.pending.is_empty() {
            line_from_bytes(segment.to_vec())?
        } else {
            self.take_pending_line(segment.to_vec())?
        };
        lines.push(line);
        Ok(())
    }

    fn take_pending_line(&mut self, final_segment: Vec<u8>) -> Result<String, FromUtf8Error> {
        let pending = mem::take(&mut self.pending);
        let len = pending.iter().map(Vec::len).sum::<usize>() + final_segment.len();
        let mut bytes = Vec::with_capacity(len);
        for segment in pending {
            bytes.extend(segment);
        }
        bytes.extend(final_segment);
        line_from_bytes(bytes)
    }
}

fn line_from_bytes(mut bytes: Vec<u8>) -> Result<String, FromUtf8Error> {
    if bytes.ends_with(b"\r") {
        bytes.pop();
    }
    String::from_utf8(bytes)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use serde_json::json;

    use super::*;

    fn read_chunks(chunks: &[&[u8]]) -> Vec<String> {
        let mut reader = JsonlLineReader::new();
        let mut lines = Vec::new();
        for chunk in chunks {
            lines.extend(reader.push_chunk(chunk).unwrap());
        }
        lines.extend(reader.finish().unwrap());
        lines
    }

    #[test]
    fn serializes_strict_jsonl_records_without_escaping_unicode_separators() {
        let line = serialize_json_line(&json!({ "text": "a\u{2028}b\u{2029}c" })).unwrap();

        assert!(line.contains("a\u{2028}b\u{2029}c"));
        assert!(line.ends_with('\n'));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(line.trim()).unwrap(),
            json!({ "text": "a\u{2028}b\u{2029}c" })
        );
    }

    #[test]
    fn splits_on_lf_only_and_preserves_unicode_separators_inside_payloads() {
        let line = serialize_json_line(&json!({ "text": "a\u{2028}b\u{2029}c" })).unwrap();
        let lines = read_chunks(&[line.as_bytes()]);

        assert_eq!(lines.len(), 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&lines[0]).unwrap(),
            json!({ "text": "a\u{2028}b\u{2029}c" })
        );
    }

    #[test]
    fn handles_crlf_delimited_input() {
        let lines = read_chunks(&[b"{\"a\":1}\r\n{\"b\":2}\r\n"]);

        assert_eq!(lines, vec![r#"{"a":1}"#, r#"{"b":2}"#]);
    }

    #[test]
    fn emits_a_final_line_without_trailing_lf() {
        let lines = read_chunks(&[br#"{"a":1}"#]);

        assert_eq!(lines, vec![r#"{"a":1}"#]);
    }

    #[test]
    fn reassembles_a_record_split_across_many_small_chunks() {
        let record = serialize_json_line(&json!({ "text": "x".repeat(5000) })).unwrap();
        let chunks = record
            .as_bytes()
            .chunks(7)
            .map(<[u8]>::to_vec)
            .collect::<Vec<_>>();
        let chunk_refs = chunks.iter().map(Vec::as_slice).collect::<Vec<_>>();
        let lines = read_chunks(&chunk_refs);

        assert_eq!(lines.len(), 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&lines[0]).unwrap(),
            json!({ "text": "x".repeat(5000) })
        );
    }

    #[test]
    fn trims_cr_even_when_crlf_straddles_a_chunk_boundary() {
        let lines = read_chunks(&[&b"{\"a\":1}\r"[..], &b"\n{\"b\":2}\r\n"[..]]);

        assert_eq!(lines, vec![r#"{"a":1}"#, r#"{"b":2}"#]);
    }

    #[test]
    fn emits_empty_lines_for_blank_records() {
        let lines = read_chunks(&[&b"{\"a\":1}\n"[..], &b"\n"[..], &b"{\"b\":2}\n"[..]]);

        assert_eq!(lines, vec![r#"{"a":1}"#, "", r#"{"b":2}"#]);
    }

    #[test]
    fn reassembles_a_multibyte_codepoint_split_across_chunks() {
        let euro = "€".as_bytes();
        let lines = read_chunks(&[
            &b"{\"c\":\""[..],
            &euro[0..1],
            &euro[1..2],
            &euro[2..3],
            &b"\"}\n"[..],
        ]);

        assert_eq!(lines.len(), 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&lines[0]).unwrap(),
            json!({ "c": "€" })
        );
    }

    #[test]
    fn decodes_a_large_single_record_split_into_many_chunks_in_linear_time() {
        let record = serialize_json_line(&json!({ "blob": "y".repeat(8 * 1024 * 1024) })).unwrap();
        let chunks = record
            .as_bytes()
            .chunks(16 * 1024)
            .map(<[u8]>::to_vec)
            .collect::<Vec<_>>();
        let chunk_refs = chunks.iter().map(Vec::as_slice).collect::<Vec<_>>();

        let start = Instant::now();
        let lines = read_chunks(&chunk_refs);
        let elapsed = start.elapsed();

        assert_eq!(lines.len(), 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&lines[0]).unwrap()["blob"]
                .as_str()
                .unwrap()
                .len(),
            8 * 1024 * 1024
        );
        assert!(
            elapsed < Duration::from_secs(1),
            "elapsed {:?} exceeded threshold",
            elapsed
        );
    }
}
