pub fn sanitize_surrogates(text: &str) -> String {
    text.to_string()
}

pub fn sanitize_surrogate_code_units(units: &[u16]) -> Vec<u16> {
    let mut sanitized = Vec::with_capacity(units.len());
    let mut index = 0;

    while index < units.len() {
        let unit = units[index];

        if is_high_surrogate(unit) {
            if let Some(next) = units.get(index + 1)
                && is_low_surrogate(*next)
            {
                sanitized.push(unit);
                sanitized.push(*next);
                index += 2;
                continue;
            }
            index += 1;
            continue;
        }

        if is_low_surrogate(unit) {
            index += 1;
            continue;
        }

        sanitized.push(unit);
        index += 1;
    }

    sanitized
}

pub fn sanitize_surrogate_code_units_to_string(units: &[u16]) -> String {
    String::from_utf16(&sanitize_surrogate_code_units(units))
        .expect("sanitizing removes invalid surrogate sequences")
}

const fn is_high_surrogate(unit: u16) -> bool {
    unit >= 0xd800 && unit <= 0xdbff
}

const fn is_low_surrogate(unit: u16) -> bool {
    unit >= 0xdc00 && unit <= 0xdfff
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_rust_strings_are_already_sanitized() {
        let text = "Hello 🙈 World";

        assert_eq!(sanitize_surrogates(text), text);
    }

    #[test]
    fn preserves_valid_surrogate_pairs() {
        let units = "Hello 🙈 World".encode_utf16().collect::<Vec<_>>();

        assert_eq!(
            sanitize_surrogate_code_units_to_string(&units),
            "Hello 🙈 World"
        );
        assert_eq!(sanitize_surrogate_code_units(&units), units);
    }

    #[test]
    fn removes_unpaired_high_surrogates() {
        let units = [
            b'T' as u16,
            b'e' as u16,
            b'x' as u16,
            b't' as u16,
            b' ' as u16,
            0xd83d,
            b' ' as u16,
            b'h' as u16,
            b'e' as u16,
            b'r' as u16,
            b'e' as u16,
        ];

        assert_eq!(
            sanitize_surrogate_code_units_to_string(&units),
            "Text  here"
        );
    }

    #[test]
    fn removes_unpaired_low_surrogates() {
        let units = [
            b'T' as u16,
            b'e' as u16,
            b'x' as u16,
            b't' as u16,
            b' ' as u16,
            0xde48,
            b' ' as u16,
            b'h' as u16,
            b'e' as u16,
            b'r' as u16,
            b'e' as u16,
        ];

        assert_eq!(
            sanitize_surrogate_code_units_to_string(&units),
            "Text  here"
        );
    }

    #[test]
    fn removes_high_surrogate_not_followed_by_low_surrogate() {
        let units = [b'a' as u16, 0xd83d, b'b' as u16, 0xde48, b'c' as u16];

        assert_eq!(sanitize_surrogate_code_units_to_string(&units), "abc");
    }
}
