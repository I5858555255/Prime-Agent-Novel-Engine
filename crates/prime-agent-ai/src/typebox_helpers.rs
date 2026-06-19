use serde_json::{Map, Value};

pub fn string_enum<I, S>(values: I, description: Option<&str>, default: Option<&str>) -> Value
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut schema = Map::new();
    schema.insert("type".to_string(), Value::String("string".to_string()));
    schema.insert(
        "enum".to_string(),
        Value::Array(
            values
                .into_iter()
                .map(|value| Value::String(value.into()))
                .collect(),
        ),
    );

    if let Some(description) = description {
        schema.insert(
            "description".to_string(),
            Value::String(description.to_string()),
        );
    }
    if let Some(default) = default {
        schema.insert("default".to_string(), Value::String(default.to_string()));
    }

    Value::Object(schema)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn creates_a_string_enum_schema() {
        let schema = string_enum(["add", "subtract"], None, None);

        assert_eq!(
            schema,
            json!({
                "type": "string",
                "enum": ["add", "subtract"]
            })
        );
    }

    #[test]
    fn includes_optional_description_and_default() {
        let schema = string_enum(
            ["low", "medium", "high"],
            Some("Reasoning level"),
            Some("medium"),
        );

        assert_eq!(schema["description"], "Reasoning level");
        assert_eq!(schema["default"], "medium");
    }
}
