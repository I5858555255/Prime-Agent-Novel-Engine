const DISPLAY_ID_LENGTH: usize = 12;

pub fn format_session_display_id(id: &str) -> String {
    match normalize_session_id(id) {
        Some(normalized) => tail_or_all(&normalized, DISPLAY_ID_LENGTH).to_string(),
        None => tail_or_all(id, DISPLAY_ID_LENGTH).to_string(),
    }
}

pub fn matches_session_id_suffix(candidate: &str, suffix: &str) -> bool {
    let Some(normalized_candidate) = normalize_session_id(candidate) else {
        return false;
    };
    let Some(normalized_suffix) = normalize_session_id(suffix) else {
        return false;
    };

    normalized_candidate.ends_with(&normalized_suffix)
}

fn normalize_session_id(id: &str) -> Option<String> {
    let normalized = id.replace('-', "").to_lowercase();
    if normalized.is_empty() || !normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    Some(normalized)
}

fn tail_or_all(value: &str, len: usize) -> &str {
    if value.len() <= len {
        return value;
    }

    let start = value
        .char_indices()
        .map(|(index, _)| index)
        .rev()
        .nth(len - 1)
        .unwrap_or(0);
    &value[start..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compacts_uuid_like_session_ids_to_last_twelve_hex_characters() {
        assert_eq!(
            format_session_display_id("019e71ec-e08a-75a9-b573-fc10e9f8380f"),
            "fc10e9f8380f"
        );
    }

    #[test]
    fn leaves_shorter_active_session_ids_unchanged() {
        assert_eq!(format_session_display_id("1bce5c72"), "1bce5c72");
    }

    #[test]
    fn normalizes_case_and_hyphens_before_formatting() {
        assert_eq!(
            format_session_display_id("019E71EC-E08A-75A9-B573-FC10E9F8380F"),
            "fc10e9f8380f"
        );
    }

    #[test]
    fn falls_back_to_raw_tail_for_non_hex_ids() {
        assert_eq!(
            format_session_display_id("session-name-that-is-long"),
            "that-is-long"
        );
        assert_eq!(format_session_display_id("short-name"), "short-name");
    }

    #[test]
    fn matches_suffixes_with_or_without_hyphens() {
        let session_id = "019e71ec-e08a-75a9-b573-fc10e9f8380f";

        assert!(matches_session_id_suffix(session_id, "fc10e9f8380f"));
        assert!(matches_session_id_suffix(session_id, "e9-f8380f"));
        assert!(matches_session_id_suffix(session_id, "FC10E9F8380F"));
        assert!(!matches_session_id_suffix(session_id, "abcdef"));
    }

    #[test]
    fn refuses_non_hex_candidates_or_suffixes() {
        assert!(!matches_session_id_suffix("not-a-session", "session"));
        assert!(!matches_session_id_suffix(
            "019e71ec-e08a-75a9-b573-fc10e9f8380f",
            "not-hex",
        ));
        assert!(!matches_session_id_suffix(
            "019e71ec-e08a-75a9-b573-fc10e9f8380f",
            "",
        ));
    }
}
