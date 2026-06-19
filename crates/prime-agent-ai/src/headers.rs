use std::collections::BTreeMap;

pub fn headers_to_record<I, K, V>(headers: I) -> BTreeMap<String, String>
where
    I: IntoIterator<Item = (K, V)>,
    K: Into<String>,
    V: Into<String>,
{
    headers
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_header_pairs_to_a_record() {
        let record = headers_to_record([
            ("content-type", "application/json"),
            ("authorization", "Bearer token"),
        ]);

        assert_eq!(record["content-type"], "application/json");
        assert_eq!(record["authorization"], "Bearer token");
    }

    #[test]
    fn later_duplicate_header_values_win_like_object_assignment() {
        let record = headers_to_record([("x-test", "first"), ("x-test", "second")]);

        assert_eq!(record["x-test"], "second");
    }
}
