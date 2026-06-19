pub const DEFAULT_MAX_LINES: usize = 2000;
pub const DEFAULT_MAX_BYTES: usize = 50 * 1024;
pub const GREP_MAX_LINE_LENGTH: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TruncationLimit {
    Lines,
    Bytes,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TruncationOptions {
    pub max_lines: Option<usize>,
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TruncationResult {
    pub content: String,
    pub truncated: bool,
    pub truncated_by: Option<TruncationLimit>,
    pub total_lines: usize,
    pub total_bytes: usize,
    pub output_lines: usize,
    pub output_bytes: usize,
    pub last_line_partial: bool,
    pub first_line_exceeds_limit: bool,
    pub max_lines: usize,
    pub max_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineTruncation {
    pub text: String,
    pub was_truncated: bool,
}

impl TruncationOptions {
    fn limits(self) -> (usize, usize) {
        (
            self.max_lines.unwrap_or(DEFAULT_MAX_LINES),
            self.max_bytes.unwrap_or(DEFAULT_MAX_BYTES),
        )
    }
}

pub fn format_size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{bytes}B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1}KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

pub fn truncate_head(content: &str, options: TruncationOptions) -> TruncationResult {
    let (max_lines, max_bytes) = options.limits();
    let total_bytes = content.len();
    let lines: Vec<&str> = content.split('\n').collect();
    let total_lines = lines.len();

    if total_lines <= max_lines && total_bytes <= max_bytes {
        return TruncationResult {
            content: content.to_owned(),
            truncated: false,
            truncated_by: None,
            total_lines,
            total_bytes,
            output_lines: total_lines,
            output_bytes: total_bytes,
            last_line_partial: false,
            first_line_exceeds_limit: false,
            max_lines,
            max_bytes,
        };
    }

    if lines.first().map_or(0, |line| line.len()) > max_bytes {
        return TruncationResult {
            content: String::new(),
            truncated: true,
            truncated_by: Some(TruncationLimit::Bytes),
            total_lines,
            total_bytes,
            output_lines: 0,
            output_bytes: 0,
            last_line_partial: false,
            first_line_exceeds_limit: true,
            max_lines,
            max_bytes,
        };
    }

    let mut output_lines = Vec::new();
    let mut output_bytes_count = 0usize;
    let mut truncated_by = TruncationLimit::Lines;

    for (index, line) in lines.iter().enumerate().take(max_lines) {
        let line_bytes = line.len() + usize::from(index > 0);
        if output_bytes_count + line_bytes > max_bytes {
            truncated_by = TruncationLimit::Bytes;
            break;
        }

        output_lines.push(*line);
        output_bytes_count += line_bytes;
    }

    if output_lines.len() >= max_lines && output_bytes_count <= max_bytes {
        truncated_by = TruncationLimit::Lines;
    }

    let output_content = output_lines.join("\n");
    let output_bytes = output_content.len();

    TruncationResult {
        content: output_content,
        truncated: true,
        truncated_by: Some(truncated_by),
        total_lines,
        total_bytes,
        output_lines: output_lines.len(),
        output_bytes,
        last_line_partial: false,
        first_line_exceeds_limit: false,
        max_lines,
        max_bytes,
    }
}

pub fn truncate_tail(content: &str, options: TruncationOptions) -> TruncationResult {
    let (max_lines, max_bytes) = options.limits();
    let total_bytes = content.len();
    let lines: Vec<&str> = content.split('\n').collect();
    let total_lines = lines.len();

    if total_lines <= max_lines && total_bytes <= max_bytes {
        return TruncationResult {
            content: content.to_owned(),
            truncated: false,
            truncated_by: None,
            total_lines,
            total_bytes,
            output_lines: total_lines,
            output_bytes: total_bytes,
            last_line_partial: false,
            first_line_exceeds_limit: false,
            max_lines,
            max_bytes,
        };
    }

    let mut output_lines = Vec::new();
    let mut output_bytes_count = 0usize;
    let mut truncated_by = TruncationLimit::Lines;
    let mut last_line_partial = false;

    for line in lines.iter().rev().take(max_lines) {
        let line_bytes = line.len() + usize::from(!output_lines.is_empty());
        if output_bytes_count + line_bytes > max_bytes {
            truncated_by = TruncationLimit::Bytes;
            if output_lines.is_empty() {
                let truncated_line = truncate_string_to_bytes_from_end(line, max_bytes);
                output_bytes_count = truncated_line.len();
                output_lines.insert(0, truncated_line);
                last_line_partial = true;
            }
            break;
        }

        output_bytes_count += line_bytes;
        output_lines.insert(0, (*line).to_owned());
    }

    if output_lines.len() >= max_lines && output_bytes_count <= max_bytes {
        truncated_by = TruncationLimit::Lines;
    }

    let output_content = output_lines.join("\n");
    let output_bytes = output_content.len();

    TruncationResult {
        content: output_content,
        truncated: true,
        truncated_by: Some(truncated_by),
        total_lines,
        total_bytes,
        output_lines: output_lines.len(),
        output_bytes,
        last_line_partial,
        first_line_exceeds_limit: false,
        max_lines,
        max_bytes,
    }
}

pub fn truncate_line(line: &str, max_chars: usize) -> LineTruncation {
    if line.chars().count() <= max_chars {
        return LineTruncation {
            text: line.to_owned(),
            was_truncated: false,
        };
    }

    let prefix: String = line.chars().take(max_chars).collect();
    LineTruncation {
        text: format!("{prefix}... [truncated]"),
        was_truncated: true,
    }
}

fn truncate_string_to_bytes_from_end(value: &str, max_bytes: usize) -> String {
    let bytes = value.as_bytes();
    if bytes.len() <= max_bytes {
        return value.to_owned();
    }

    let mut start = bytes.len() - max_bytes;
    while start < bytes.len() && (bytes[start] & 0xc0) == 0x80 {
        start += 1;
    }

    value[start..].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(max_lines: usize, max_bytes: usize) -> TruncationOptions {
        TruncationOptions {
            max_lines: Some(max_lines),
            max_bytes: Some(max_bytes),
        }
    }

    #[test]
    fn format_size_matches_tool_units() {
        assert_eq!(format_size(12), "12B");
        assert_eq!(format_size(1536), "1.5KB");
        assert_eq!(format_size(2 * 1024 * 1024), "2.0MB");
    }

    #[test]
    fn truncate_head_respects_line_limit_without_partial_lines() {
        let result = truncate_head("one\ntwo\nthree", options(2, 100));

        assert_eq!(result.content, "one\ntwo");
        assert!(result.truncated);
        assert_eq!(result.truncated_by, Some(TruncationLimit::Lines));
        assert_eq!(result.total_lines, 3);
        assert_eq!(result.output_lines, 2);
        assert!(!result.last_line_partial);
    }

    #[test]
    fn truncate_head_respects_byte_limit_without_partial_lines() {
        let result = truncate_head("alpha\nbeta\ngamma", options(10, 9));

        assert_eq!(result.content, "alpha");
        assert!(result.truncated);
        assert_eq!(result.truncated_by, Some(TruncationLimit::Bytes));
        assert_eq!(result.output_bytes, 5);
        assert!(!result.first_line_exceeds_limit);
    }

    #[test]
    fn truncate_head_reports_first_line_exceeding_byte_limit() {
        let result = truncate_head("abcdef\nnext", options(10, 5));

        assert_eq!(result.content, "");
        assert!(result.truncated);
        assert_eq!(result.truncated_by, Some(TruncationLimit::Bytes));
        assert!(result.first_line_exceeds_limit);
        assert_eq!(result.output_lines, 0);
    }

    #[test]
    fn truncate_tail_keeps_last_lines_by_limit() {
        let result = truncate_tail("one\ntwo\nthree", options(2, 100));

        assert_eq!(result.content, "two\nthree");
        assert!(result.truncated);
        assert_eq!(result.truncated_by, Some(TruncationLimit::Lines));
        assert_eq!(result.output_lines, 2);
    }

    #[test]
    fn truncate_tail_allows_partial_last_line_at_byte_limit() {
        let result = truncate_tail("short\nabcdef", options(10, 3));

        assert_eq!(result.content, "def");
        assert!(result.truncated);
        assert_eq!(result.truncated_by, Some(TruncationLimit::Bytes));
        assert!(result.last_line_partial);
        assert_eq!(result.output_bytes, 3);
    }

    #[test]
    fn truncate_tail_does_not_split_multibyte_utf8() {
        let result = truncate_tail("prefix\nabé", options(10, 1));

        assert_eq!(result.content, "");
        assert!(result.last_line_partial);
        assert_eq!(result.output_bytes, 0);

        let result = truncate_tail("prefix\nabé", options(10, 3));
        assert_eq!(result.content, "bé");
        assert!(result.last_line_partial);
        assert_eq!(result.output_bytes, 3);
    }

    #[test]
    fn truncate_line_adds_grep_suffix() {
        let result = truncate_line("abcdef", 3);

        assert_eq!(result.text, "abc... [truncated]");
        assert!(result.was_truncated);

        let result = truncate_line("ééé", 2);
        assert_eq!(result.text, "éé... [truncated]");
        assert!(result.was_truncated);
    }
}
