const ESC: &str = "\u{1b}";
const BRACKETED_PASTE_START: &str = "\u{1b}[200~";
const BRACKETED_PASTE_END: &str = "\u{1b}[201~";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StdinEvent {
    Data(String),
    Paste(String),
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct StdinBuffer {
    buffer: String,
    paste_mode: bool,
    paste_buffer: String,
    pending_kitty_printable_codepoint: Option<u32>,
}

impl StdinBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn process_str(&mut self, data: &str) -> Vec<StdinEvent> {
        if data.is_empty() && self.buffer.is_empty() {
            return vec![self.emit_data_sequence("")];
        }

        self.buffer.push_str(data);
        self.drain_buffer()
    }

    pub fn process_bytes(&mut self, data: &[u8]) -> Vec<StdinEvent> {
        if data.len() == 1 && data[0] > 127 {
            let converted = format!("{ESC}{}", char::from(data[0] - 128));
            return self.process_str(&converted);
        }

        self.process_str(&String::from_utf8_lossy(data))
    }

    pub fn flush(&mut self) -> Vec<String> {
        if self.buffer.is_empty() {
            return Vec::new();
        }

        let sequence = std::mem::take(&mut self.buffer);
        self.pending_kitty_printable_codepoint = None;
        vec![sequence]
    }

    pub fn clear(&mut self) {
        self.buffer.clear();
        self.paste_mode = false;
        self.paste_buffer.clear();
        self.pending_kitty_printable_codepoint = None;
    }

    pub fn buffer(&self) -> &str {
        &self.buffer
    }

    pub fn paste_buffer(&self) -> &str {
        &self.paste_buffer
    }

    pub fn is_paste_mode(&self) -> bool {
        self.paste_mode
    }

    fn drain_buffer(&mut self) -> Vec<StdinEvent> {
        let mut events = Vec::new();

        if self.paste_mode {
            self.paste_buffer.push_str(&self.buffer);
            self.buffer.clear();
            self.finish_paste_if_complete(&mut events);
            return events;
        }

        if let Some(start_index) = self.buffer.find(BRACKETED_PASTE_START) {
            if start_index > 0 {
                let before_paste = self.buffer[..start_index].to_string();
                let result = extract_complete_sequences(&before_paste);
                for sequence in result.sequences {
                    if let Some(event) = self.maybe_emit_data_sequence(&sequence) {
                        events.push(event);
                    }
                }
            }

            self.pending_kitty_printable_codepoint = None;
            let paste_content_start = start_index + BRACKETED_PASTE_START.len();
            self.paste_buffer = self.buffer[paste_content_start..].to_string();
            self.buffer.clear();
            self.paste_mode = true;
            self.finish_paste_if_complete(&mut events);
            return events;
        }

        let result = extract_complete_sequences(&self.buffer);
        self.buffer = result.remainder;
        for sequence in result.sequences {
            if let Some(event) = self.maybe_emit_data_sequence(&sequence) {
                events.push(event);
            }
        }

        events
    }

    fn finish_paste_if_complete(&mut self, events: &mut Vec<StdinEvent>) {
        let Some(end_index) = self.paste_buffer.find(BRACKETED_PASTE_END) else {
            return;
        };

        let pasted_content = self.paste_buffer[..end_index].to_string();
        let remaining_start = end_index + BRACKETED_PASTE_END.len();
        let remaining = self.paste_buffer[remaining_start..].to_string();

        self.paste_mode = false;
        self.paste_buffer.clear();
        self.pending_kitty_printable_codepoint = None;

        events.push(StdinEvent::Paste(pasted_content));

        if !remaining.is_empty() {
            events.extend(self.process_str(&remaining));
        }
    }

    fn emit_data_sequence(&mut self, sequence: &str) -> StdinEvent {
        self.maybe_emit_data_sequence(sequence)
            .unwrap_or_else(|| StdinEvent::Data(String::new()))
    }

    fn maybe_emit_data_sequence(&mut self, sequence: &str) -> Option<StdinEvent> {
        let mut chars = sequence.chars();
        let raw_codepoint = chars
            .next()
            .map(|ch| ch as u32)
            .filter(|_| chars.next().is_none());

        if raw_codepoint.is_some() && raw_codepoint == self.pending_kitty_printable_codepoint {
            self.pending_kitty_printable_codepoint = None;
            return None;
        }

        self.pending_kitty_printable_codepoint =
            parse_unmodified_kitty_printable_codepoint(sequence);
        Some(StdinEvent::Data(sequence.to_string()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SequenceStatus {
    Complete,
    Incomplete,
    NotEscape,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExtractResult {
    sequences: Vec<String>,
    remainder: String,
}

fn is_complete_sequence(data: &str) -> SequenceStatus {
    if !data.starts_with(ESC) {
        return SequenceStatus::NotEscape;
    }

    if data.chars().count() == 1 {
        return SequenceStatus::Incomplete;
    }

    let after_esc = &data[ESC.len()..];

    if after_esc.starts_with('[') {
        if after_esc.starts_with("[M") {
            return if data.chars().count() >= 6 {
                SequenceStatus::Complete
            } else {
                SequenceStatus::Incomplete
            };
        }
        return is_complete_csi_sequence(data);
    }

    if after_esc.starts_with(']') {
        return is_complete_st_terminated_sequence(data, "\u{1b}]");
    }

    if after_esc.starts_with('P') {
        return is_complete_st_terminated_sequence(data, "\u{1b}P");
    }

    if after_esc.starts_with('_') {
        return is_complete_st_terminated_sequence(data, "\u{1b}_");
    }

    if after_esc.starts_with('O') {
        return if after_esc.chars().count() >= 2 {
            SequenceStatus::Complete
        } else {
            SequenceStatus::Incomplete
        };
    }

    if after_esc.chars().count() == 1 {
        return SequenceStatus::Complete;
    }

    SequenceStatus::Complete
}

fn is_complete_csi_sequence(data: &str) -> SequenceStatus {
    if !data.starts_with("\u{1b}[") {
        return SequenceStatus::Complete;
    }

    if data.chars().count() < 3 {
        return SequenceStatus::Incomplete;
    }

    let payload = &data["\u{1b}[".len()..];
    let Some(last_char) = payload.chars().last() else {
        return SequenceStatus::Incomplete;
    };

    if !('@'..='~').contains(&last_char) {
        return SequenceStatus::Incomplete;
    }

    if payload.starts_with('<') {
        if is_complete_sgr_mouse_payload(payload) {
            return SequenceStatus::Complete;
        }

        return SequenceStatus::Incomplete;
    }

    SequenceStatus::Complete
}

fn is_complete_sgr_mouse_payload(payload: &str) -> bool {
    let Some(last_char) = payload.chars().last() else {
        return false;
    };
    if last_char != 'M' && last_char != 'm' {
        return false;
    }

    let body = &payload[1..payload.len() - last_char.len_utf8()];
    let parts = body.split(';').collect::<Vec<_>>();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
}

fn is_complete_st_terminated_sequence(data: &str, prefix: &str) -> SequenceStatus {
    if !data.starts_with(prefix) {
        return SequenceStatus::Complete;
    }

    if data.ends_with("\u{1b}\\") || data.ends_with('\u{7}') {
        SequenceStatus::Complete
    } else {
        SequenceStatus::Incomplete
    }
}

fn parse_unmodified_kitty_printable_codepoint(sequence: &str) -> Option<u32> {
    let payload = sequence.strip_prefix("\u{1b}[")?.strip_suffix('u')?;
    let segments = payload.split(':').collect::<Vec<_>>();
    if !(1..=3).contains(&segments.len()) {
        return None;
    }
    if segments[0].is_empty() || !segments[0].chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    if segments
        .iter()
        .skip(1)
        .any(|segment| !segment.is_empty() && !segment.chars().all(|ch| ch.is_ascii_digit()))
    {
        return None;
    }

    let codepoint = segments[0].parse::<u32>().ok()?;
    (codepoint >= 32).then_some(codepoint)
}

fn extract_complete_sequences(buffer: &str) -> ExtractResult {
    let mut sequences = Vec::new();
    let mut pos = 0;

    while pos < buffer.len() {
        let remaining = &buffer[pos..];

        if remaining.starts_with(ESC) {
            let mut seq_end_chars = 1;
            let remaining_chars = remaining.chars().count();

            while seq_end_chars <= remaining_chars {
                let end_byte = byte_index_after_chars(remaining, seq_end_chars);
                let candidate = &remaining[..end_byte];

                match is_complete_sequence(candidate) {
                    SequenceStatus::Complete => {
                        sequences.push(candidate.to_string());
                        pos += end_byte;
                        break;
                    }
                    SequenceStatus::Incomplete => {
                        seq_end_chars += 1;
                    }
                    SequenceStatus::NotEscape => {
                        sequences.push(candidate.to_string());
                        pos += end_byte;
                        break;
                    }
                }
            }

            if seq_end_chars > remaining_chars {
                return ExtractResult {
                    sequences,
                    remainder: remaining.to_string(),
                };
            }
        } else {
            let ch = remaining.chars().next().expect("remaining is non-empty");
            sequences.push(ch.to_string());
            pos += ch.len_utf8();
        }
    }

    ExtractResult {
        sequences,
        remainder: String::new(),
    }
}

fn byte_index_after_chars(value: &str, char_count: usize) -> usize {
    if char_count == 0 {
        return 0;
    }

    value
        .char_indices()
        .nth(char_count)
        .map(|(index, _)| index)
        .unwrap_or(value.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_events(events: Vec<StdinEvent>) -> Vec<String> {
        events
            .into_iter()
            .filter_map(|event| match event {
                StdinEvent::Data(data) => Some(data),
                StdinEvent::Paste(_) => None,
            })
            .collect()
    }

    fn paste_events(events: Vec<StdinEvent>) -> Vec<String> {
        events
            .into_iter()
            .filter_map(|event| match event {
                StdinEvent::Data(_) => None,
                StdinEvent::Paste(data) => Some(data),
            })
            .collect()
    }

    #[test]
    fn regular_characters_emit_immediately() {
        let mut buffer = StdinBuffer::new();

        assert_eq!(data_events(buffer.process_str("abc")), vec!["a", "b", "c"]);
        assert_eq!(
            data_events(buffer.process_str(" 世界")),
            vec![" ", "世", "界"]
        );
    }

    #[test]
    fn complete_escape_sequences_emit_as_units() {
        let mut buffer = StdinBuffer::new();

        assert_eq!(
            data_events(buffer.process_str("\u{1b}[<35;20;5m")),
            vec!["\u{1b}[<35;20;5m"]
        );
        assert_eq!(
            data_events(buffer.process_str("\u{1b}[A")),
            vec!["\u{1b}[A"]
        );
        assert_eq!(
            data_events(buffer.process_str("\u{1b}[11~")),
            vec!["\u{1b}[11~"]
        );
        assert_eq!(data_events(buffer.process_str("\u{1b}a")), vec!["\u{1b}a"]);
        assert_eq!(
            data_events(buffer.process_str("\u{1b}OA")),
            vec!["\u{1b}OA"]
        );
    }

    #[test]
    fn partial_escape_sequences_buffer_until_complete_or_flushed() {
        let mut buffer = StdinBuffer::new();

        assert!(buffer.process_str("\u{1b}").is_empty());
        assert_eq!(buffer.buffer(), "\u{1b}");
        assert!(buffer.process_str("[<35").is_empty());
        assert_eq!(buffer.buffer(), "\u{1b}[<35");
        assert_eq!(
            data_events(buffer.process_str(";20;5m")),
            vec!["\u{1b}[<35;20;5m"]
        );
        assert_eq!(buffer.buffer(), "");

        assert!(buffer.process_str("\u{1b}[<35").is_empty());
        assert_eq!(buffer.flush(), vec!["\u{1b}[<35"]);
        assert_eq!(buffer.buffer(), "");
    }

    #[test]
    fn mixed_content_splits_plain_characters_and_escape_sequences() {
        let mut buffer = StdinBuffer::new();

        assert_eq!(
            data_events(buffer.process_str("abc\u{1b}[A")),
            vec!["a", "b", "c", "\u{1b}[A"]
        );
        assert_eq!(
            data_events(buffer.process_str("\u{1b}[Aabc")),
            vec!["\u{1b}[A", "a", "b", "c"]
        );
        assert_eq!(
            data_events(buffer.process_str("\u{1b}[A\u{1b}[B\u{1b}[C")),
            vec!["\u{1b}[A", "\u{1b}[B", "\u{1b}[C"]
        );
    }

    #[test]
    fn kitty_csi_u_events_and_duplicate_printable_suppression() {
        let mut buffer = StdinBuffer::new();

        assert_eq!(
            data_events(buffer.process_str("\u{1b}[97u\u{1b}[97;1:3u")),
            vec!["\u{1b}[97u", "\u{1b}[97;1:3u"]
        );
        assert_eq!(
            data_events(buffer.process_str("\u{1b}[224uà")),
            vec!["\u{1b}[224u"]
        );
        assert_eq!(
            data_events(buffer.process_str("\u{1b}[64u")),
            vec!["\u{1b}[64u"]
        );
        assert!(buffer.process_str("@").is_empty());
        assert_eq!(
            data_events(buffer.process_str("\u{1b}[97ub")),
            vec!["\u{1b}[97u", "b"]
        );
        assert_eq!(
            data_events(buffer.process_str("\u{1b}[64;3u@")),
            vec!["\u{1b}[64;3u", "@"]
        );
    }

    #[test]
    fn mouse_sequences_include_sgr_and_old_style_forms() {
        let mut buffer = StdinBuffer::new();

        assert_eq!(
            data_events(buffer.process_str("\u{1b}[<35;1;1m\u{1b}[<35;2;2m")),
            vec!["\u{1b}[<35;1;1m", "\u{1b}[<35;2;2m"]
        );
        assert_eq!(
            data_events(buffer.process_str("\u{1b}[M abc")),
            vec!["\u{1b}[M ab", "c"]
        );

        let mut split = StdinBuffer::new();
        assert!(split.process_str("\u{1b}[M").is_empty());
        assert_eq!(split.buffer(), "\u{1b}[M");
        assert!(split.process_str(" a").is_empty());
        assert_eq!(split.buffer(), "\u{1b}[M a");
        assert_eq!(data_events(split.process_str("b")), vec!["\u{1b}[M ab"]);
    }

    #[test]
    fn handles_empty_input_and_byte_input_conversion() {
        let mut buffer = StdinBuffer::new();

        assert_eq!(data_events(buffer.process_str("")), vec![""]);
        assert_eq!(
            data_events(buffer.process_bytes(b"\x1b[A")),
            vec!["\u{1b}[A"]
        );
        assert_eq!(data_events(buffer.process_bytes(&[0xE1])), vec!["\u{1b}a"]);
    }

    #[test]
    fn bracketed_paste_emits_paste_events_and_resumes_data_events() {
        let mut buffer = StdinBuffer::new();

        assert_eq!(
            paste_events(buffer.process_str("\u{1b}[200~hello world\u{1b}[201~")),
            vec!["hello world"]
        );
        assert!(buffer.process_str("\u{1b}[200~hello ").is_empty());
        assert!(buffer.is_paste_mode());
        assert_eq!(
            paste_events(buffer.process_str("world\u{1b}[201~")),
            vec!["hello world"]
        );

        let events = buffer.process_str("a\u{1b}[200~pasted\u{1b}[201~b");
        assert_eq!(
            events,
            vec![
                StdinEvent::Data("a".to_string()),
                StdinEvent::Paste("pasted".to_string()),
                StdinEvent::Data("b".to_string()),
            ]
        );
    }

    #[test]
    fn clear_resets_buffer_paste_mode_and_pending_kitty_state() {
        let mut buffer = StdinBuffer::new();

        assert!(buffer.process_str("\u{1b}[<35").is_empty());
        assert_eq!(buffer.buffer(), "\u{1b}[<35");
        buffer.clear();
        assert_eq!(buffer.buffer(), "");

        assert!(buffer.process_str("\u{1b}[200~hello").is_empty());
        assert!(buffer.is_paste_mode());
        buffer.clear();
        assert!(!buffer.is_paste_mode());
        assert_eq!(buffer.paste_buffer(), "");

        assert_eq!(
            data_events(buffer.process_str("\u{1b}[64u")),
            vec!["\u{1b}[64u"]
        );
        buffer.clear();
        assert_eq!(data_events(buffer.process_str("@")), vec!["@"]);
    }

    #[test]
    fn st_terminated_control_sequences_wait_for_terminator() {
        let mut buffer = StdinBuffer::new();

        assert!(buffer.process_str("\u{1b}]10;rgb:ffff").is_empty());
        assert_eq!(
            data_events(buffer.process_str("\u{1b}\\")),
            vec!["\u{1b}]10;rgb:ffff\u{1b}\\"]
        );
        assert_eq!(
            data_events(buffer.process_str("\u{1b}P>|version\u{1b}\\")),
            vec!["\u{1b}P>|version\u{1b}\\"]
        );
        assert_eq!(
            data_events(buffer.process_str("\u{1b}_GOK\u{1b}\\")),
            vec!["\u{1b}_GOK\u{1b}\\"]
        );
    }
}
