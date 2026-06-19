use serde_json::{Map, Number, Value};

use crate::types::{ContentBlock, Tool};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError {
    pub message: String,
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ValidationError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JsonType {
    Number,
    Integer,
    Boolean,
    String,
    Null,
    Array,
    Object,
}

impl JsonType {
    fn from_str(value: &str) -> Option<Self> {
        match value {
            "number" => Some(Self::Number),
            "integer" => Some(Self::Integer),
            "boolean" => Some(Self::Boolean),
            "string" => Some(Self::String),
            "null" => Some(Self::Null),
            "array" => Some(Self::Array),
            "object" => Some(Self::Object),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SchemaError {
    path: Vec<String>,
    message: String,
}

/// Finds a tool by name and validates the tool call arguments against its schema.
pub fn validate_tool_call(
    tools: &[Tool],
    tool_call: &ContentBlock,
) -> Result<Value, ValidationError> {
    let (name, arguments) = tool_call_parts(tool_call)?;
    let tool = tools
        .iter()
        .find(|tool| tool.name == name)
        .ok_or_else(|| ValidationError {
            message: format!("Tool \"{name}\" not found"),
        })?;

    validate_tool_arguments_value(tool, name, arguments)
}

/// Validates a tool call content block against the supplied tool schema.
pub fn validate_tool_arguments(
    tool: &Tool,
    tool_call: &ContentBlock,
) -> Result<Value, ValidationError> {
    let (name, arguments) = tool_call_parts(tool_call)?;
    validate_tool_arguments_value(tool, name, arguments)
}

/// Validates raw tool-call arguments against a tool schema.
///
/// This mirrors the JSON-Schema-compatible portion of the TypeScript TypeBox
/// helper. TypeBox-specific metadata, compiler caching, and custom TypeBox
/// keywords are intentionally outside this Rust API.
pub fn validate_tool_arguments_value(
    tool: &Tool,
    tool_call_name: &str,
    arguments: &Map<String, Value>,
) -> Result<Value, ValidationError> {
    let original_arguments = Value::Object(arguments.clone());
    let coerced = coerce_with_json_schema(original_arguments.clone(), &tool.parameters);

    let errors = validate_schema(&coerced, &tool.parameters, Vec::new());
    if errors.is_empty() {
        return Ok(coerced);
    }

    let error_lines = errors
        .iter()
        .map(|error| {
            format!(
                "  - {}: {}",
                format_validation_path(&error.path),
                error.message
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let received = serde_json::to_string_pretty(&original_arguments)
        .unwrap_or_else(|_| original_arguments.to_string());

    Err(ValidationError {
        message: format!(
            "Validation failed for tool \"{tool_call_name}\":\n{error_lines}\n\nReceived arguments:\n{received}"
        ),
    })
}

fn tool_call_parts(
    tool_call: &ContentBlock,
) -> Result<(&str, &Map<String, Value>), ValidationError> {
    match tool_call {
        ContentBlock::ToolCall {
            name, arguments, ..
        } => Ok((name, arguments)),
        _ => Err(ValidationError {
            message: "Expected toolCall content block".to_string(),
        }),
    }
}

fn get_schema_types(schema: &Value) -> Vec<JsonType> {
    match schema.get("type") {
        Some(Value::String(schema_type)) => JsonType::from_str(schema_type).into_iter().collect(),
        Some(Value::Array(schema_types)) => schema_types
            .iter()
            .filter_map(Value::as_str)
            .filter_map(JsonType::from_str)
            .collect(),
        _ => Vec::new(),
    }
}

fn matches_json_type(value: &Value, schema_type: JsonType) -> bool {
    match schema_type {
        JsonType::Number => value.is_number(),
        JsonType::Integer => is_integer_value(value),
        JsonType::Boolean => value.is_boolean(),
        JsonType::String => value.is_string(),
        JsonType::Null => value.is_null(),
        JsonType::Array => value.is_array(),
        JsonType::Object => value.is_object(),
    }
}

fn coerce_primitive_by_type(value: Value, schema_type: JsonType) -> Value {
    match schema_type {
        JsonType::Number => match value {
            Value::Null => Value::Number(Number::from(0)),
            Value::String(text) if !text.trim().is_empty() => text
                .parse::<f64>()
                .ok()
                .filter(|number| number.is_finite())
                .and_then(Number::from_f64)
                .map(Value::Number)
                .unwrap_or(Value::String(text)),
            Value::Bool(value) => Value::Number(Number::from(if value { 1 } else { 0 })),
            value => value,
        },
        JsonType::Integer => match value {
            Value::Null => Value::Number(Number::from(0)),
            Value::String(text) if !text.trim().is_empty() => text
                .parse::<f64>()
                .ok()
                .filter(|number| is_integer_f64(*number))
                .map(|number| number as i64)
                .map(Number::from)
                .map(Value::Number)
                .unwrap_or(Value::String(text)),
            Value::Bool(value) => Value::Number(Number::from(if value { 1 } else { 0 })),
            value => value,
        },
        JsonType::Boolean => match value {
            Value::Null => Value::Bool(false),
            Value::String(text) if text == "true" => Value::Bool(true),
            Value::String(text) if text == "false" => Value::Bool(false),
            Value::Number(number) if number.as_f64() == Some(1.0) => Value::Bool(true),
            Value::Number(number) if number.as_f64() == Some(0.0) => Value::Bool(false),
            value => value,
        },
        JsonType::String => match value {
            Value::Null => Value::String(String::new()),
            Value::Number(number) => Value::String(number.to_string()),
            Value::Bool(value) => Value::String(value.to_string()),
            value => value,
        },
        JsonType::Null => match value {
            Value::String(text) if text.is_empty() => Value::Null,
            Value::Number(number) if number.as_f64() == Some(0.0) => Value::Null,
            Value::Bool(false) => Value::Null,
            value => value,
        },
        JsonType::Array | JsonType::Object => value,
    }
}

fn coerce_with_union_schema(value: Value, schemas: &[Value]) -> Value {
    for schema in schemas {
        let coerced = coerce_with_json_schema(value.clone(), schema);
        if validate_schema(&coerced, schema, Vec::new()).is_empty() {
            return coerced;
        }
    }

    value
}

fn coerce_with_json_schema(value: Value, schema: &Value) -> Value {
    let mut next_value = value;

    if let Some(all_of) = schema.get("allOf").and_then(Value::as_array) {
        for nested in all_of {
            next_value = coerce_with_json_schema(next_value, nested);
        }
    }

    if let Some(any_of) = schema.get("anyOf").and_then(Value::as_array) {
        next_value = coerce_with_union_schema(next_value, any_of);
    }

    if let Some(one_of) = schema.get("oneOf").and_then(Value::as_array) {
        next_value = coerce_with_union_schema(next_value, one_of);
    }

    let schema_types = get_schema_types(schema);
    let matches_union_member = schema_types.len() > 1
        && schema_types
            .iter()
            .any(|schema_type| matches_json_type(&next_value, *schema_type));
    if !schema_types.is_empty() && !matches_union_member {
        for schema_type in &schema_types {
            let candidate = coerce_primitive_by_type(next_value.clone(), *schema_type);
            if candidate != next_value {
                next_value = candidate;
                break;
            }
        }
    }

    if schema_types.contains(&JsonType::Object)
        && let Value::Object(mut object) = next_value
    {
        apply_schema_object_coercion(&mut object, schema);
        next_value = Value::Object(object);
    }

    if schema_types.contains(&JsonType::Array)
        && let Value::Array(mut array) = next_value
    {
        apply_schema_array_coercion(&mut array, schema);
        next_value = Value::Array(array);
    }

    next_value
}

fn apply_schema_object_coercion(object: &mut Map<String, Value>, schema: &Value) {
    let properties = schema.get("properties").and_then(Value::as_object);
    let defined_keys = properties
        .map(|properties| properties.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();

    if let Some(properties) = properties {
        for (key, property_schema) in properties {
            if let Some(property_value) = object.remove(key) {
                object.insert(
                    key.clone(),
                    coerce_with_json_schema(property_value, property_schema),
                );
            }
        }
    }

    if let Some(additional_schema) = schema
        .get("additionalProperties")
        .and_then(Value::as_object)
    {
        for (key, property_value) in object.clone() {
            if defined_keys.contains(&key) {
                continue;
            }
            object.insert(
                key,
                coerce_with_json_schema(property_value, &Value::Object(additional_schema.clone())),
            );
        }
    }
}

fn is_integer_value(value: &Value) -> bool {
    match value {
        Value::Number(number) => {
            number.as_i64().is_some()
                || number.as_u64().is_some()
                || number.as_f64().map(is_integer_f64).unwrap_or(false)
        }
        _ => false,
    }
}

fn is_integer_f64(number: f64) -> bool {
    number.is_finite()
        && number.fract() == 0.0
        && number >= i64::MIN as f64
        && number <= i64::MAX as f64
}

fn apply_schema_array_coercion(array: &mut [Value], schema: &Value) {
    match schema.get("items") {
        Some(Value::Array(items)) => {
            for (index, item_schema) in items.iter().enumerate() {
                if let Some(item_value) = array.get_mut(index) {
                    *item_value = coerce_with_json_schema(item_value.clone(), item_schema);
                }
            }
        }
        Some(item_schema @ Value::Object(_)) => {
            for item_value in array {
                *item_value = coerce_with_json_schema(item_value.clone(), item_schema);
            }
        }
        _ => {}
    }
}

fn validate_schema(value: &Value, schema: &Value, path: Vec<String>) -> Vec<SchemaError> {
    let mut errors = Vec::new();

    if let Some(all_of) = schema.get("allOf").and_then(Value::as_array) {
        for nested in all_of {
            errors.extend(validate_schema(value, nested, path.clone()));
        }
    }

    if let Some(any_of) = schema.get("anyOf").and_then(Value::as_array)
        && !any_of
            .iter()
            .any(|nested| validate_schema(value, nested, path.clone()).is_empty())
    {
        errors.push(SchemaError {
            path: path.clone(),
            message: "must match a schema in anyOf".to_string(),
        });
    }

    if let Some(one_of) = schema.get("oneOf").and_then(Value::as_array) {
        let match_count = one_of
            .iter()
            .filter(|nested| validate_schema(value, nested, path.clone()).is_empty())
            .count();
        if match_count != 1 {
            errors.push(SchemaError {
                path: path.clone(),
                message: "must match exactly one schema in oneOf".to_string(),
            });
        }
    }

    let schema_types = get_schema_types(schema);
    if !schema_types.is_empty()
        && !schema_types
            .iter()
            .any(|schema_type| matches_json_type(value, *schema_type))
    {
        errors.push(SchemaError {
            path: path.clone(),
            message: expected_type_message(&schema_types),
        });
        return errors;
    }

    if schema_types.contains(&JsonType::Object)
        && let Value::Object(object) = value
    {
        errors.extend(validate_object(object, schema, path.clone()));
    }

    if schema_types.contains(&JsonType::Array)
        && let Value::Array(array) = value
    {
        errors.extend(validate_array(array, schema, path));
    }

    errors
}

fn validate_object(
    object: &Map<String, Value>,
    schema: &Value,
    path: Vec<String>,
) -> Vec<SchemaError> {
    let mut errors = Vec::new();

    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for property in required.iter().filter_map(Value::as_str) {
            if !object.contains_key(property) {
                let mut property_path = path.clone();
                property_path.push(property.to_string());
                errors.push(SchemaError {
                    path: property_path,
                    message: "is required".to_string(),
                });
            }
        }
    }

    let properties = schema.get("properties").and_then(Value::as_object);
    if let Some(properties) = properties {
        for (key, property_schema) in properties {
            if let Some(property_value) = object.get(key) {
                let mut property_path = path.clone();
                property_path.push(key.clone());
                errors.extend(validate_schema(
                    property_value,
                    property_schema,
                    property_path,
                ));
            }
        }
    }

    match schema.get("additionalProperties") {
        Some(Value::Bool(false)) => {
            for key in object.keys() {
                if properties.is_some_and(|properties| properties.contains_key(key)) {
                    continue;
                }
                let mut property_path = path.clone();
                property_path.push(key.clone());
                errors.push(SchemaError {
                    path: property_path,
                    message: "must not have additional properties".to_string(),
                });
            }
        }
        Some(additional_schema @ Value::Object(_)) => {
            for (key, property_value) in object {
                if properties.is_some_and(|properties| properties.contains_key(key)) {
                    continue;
                }
                let mut property_path = path.clone();
                property_path.push(key.clone());
                errors.extend(validate_schema(
                    property_value,
                    additional_schema,
                    property_path,
                ));
            }
        }
        _ => {}
    }

    errors
}

fn validate_array(array: &[Value], schema: &Value, path: Vec<String>) -> Vec<SchemaError> {
    let mut errors = Vec::new();

    match schema.get("items") {
        Some(Value::Array(items)) => {
            for (index, item_schema) in items.iter().enumerate() {
                if let Some(item_value) = array.get(index) {
                    let mut item_path = path.clone();
                    item_path.push(index.to_string());
                    errors.extend(validate_schema(item_value, item_schema, item_path));
                }
            }
        }
        Some(item_schema @ Value::Object(_)) => {
            for (index, item_value) in array.iter().enumerate() {
                let mut item_path = path.clone();
                item_path.push(index.to_string());
                errors.extend(validate_schema(item_value, item_schema, item_path));
            }
        }
        _ => {}
    }

    errors
}

fn expected_type_message(schema_types: &[JsonType]) -> String {
    let expected = schema_types
        .iter()
        .map(|schema_type| match schema_type {
            JsonType::Number => "number",
            JsonType::Integer => "integer",
            JsonType::Boolean => "boolean",
            JsonType::String => "string",
            JsonType::Null => "null",
            JsonType::Array => "array",
            JsonType::Object => "object",
        })
        .collect::<Vec<_>>()
        .join(" or ");

    format!("expected {expected}")
}

fn format_validation_path(path: &[String]) -> String {
    if path.is_empty() {
        "root".to_string()
    } else {
        path.join(".")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool(parameters: Value) -> Tool {
        Tool {
            name: "echo".to_string(),
            description: "Echo tool".to_string(),
            parameters,
        }
    }

    fn call(arguments: Map<String, Value>) -> ContentBlock {
        ContentBlock::ToolCall {
            id: "tool-1".to_string(),
            name: "echo".to_string(),
            arguments,
            thought_signature: None,
        }
    }

    #[test]
    fn validates_successful_arguments_with_coercion() {
        let tool = tool(json!({
            "type": "object",
            "properties": {
                "count": { "type": "number" },
                "enabled": { "type": "boolean" }
            },
            "required": ["count", "enabled"]
        }));
        let arguments = json!({ "count": "42", "enabled": "true" })
            .as_object()
            .unwrap()
            .clone();

        let validated = validate_tool_arguments(&tool, &call(arguments)).unwrap();

        assert_eq!(validated, json!({ "count": 42.0, "enabled": true }));
    }

    #[test]
    fn rejects_missing_and_incorrect_fields() {
        let tool = tool(json!({
            "type": "object",
            "properties": {
                "count": { "type": "integer" },
                "label": { "type": "string" }
            },
            "required": ["count", "label"]
        }));
        let arguments = json!({ "count": "42.1" }).as_object().unwrap().clone();

        let error = validate_tool_arguments(&tool, &call(arguments)).unwrap_err();

        assert!(
            error
                .message
                .contains("Validation failed for tool \"echo\"")
        );
        assert!(error.message.contains("  - count: expected integer"));
        assert!(error.message.contains("  - label: is required"));
        assert!(error.message.contains("Received arguments:"));
    }

    #[test]
    fn validates_arrays_and_objects() {
        let tool = tool(json!({
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": { "type": "string" },
                            "quantity": { "type": "integer" }
                        },
                        "required": ["name", "quantity"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["items"]
        }));
        let arguments = json!({
            "items": [
                { "name": "pencil", "quantity": "3" },
                { "name": 12, "quantity": true }
            ]
        })
        .as_object()
        .unwrap()
        .clone();

        let validated = validate_tool_arguments(&tool, &call(arguments)).unwrap();

        assert_eq!(
            validated,
            json!({
                "items": [
                    { "name": "pencil", "quantity": 3 },
                    { "name": "12", "quantity": 1 }
                ]
            })
        );
    }

    #[test]
    fn reports_error_message_shape_with_paths_and_original_arguments() {
        let tool = tool(json!({
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": { "type": "object", "properties": { "ok": { "type": "boolean" } } }
                }
            },
            "required": ["items"]
        }));
        let arguments = json!({ "items": [{ "ok": "yes" }] })
            .as_object()
            .unwrap()
            .clone();

        let error = validate_tool_arguments(&tool, &call(arguments)).unwrap_err();

        assert!(
            error
                .message
                .starts_with("Validation failed for tool \"echo\":\n")
        );
        assert!(error.message.contains("  - items.0.ok: expected boolean"));
        assert!(error.message.contains("\n\nReceived arguments:\n{"));
        assert!(error.message.contains("\"ok\": \"yes\""));
    }

    #[test]
    fn finds_tool_by_name() {
        let tools = vec![tool(json!({
            "type": "object",
            "properties": { "value": { "type": "string" } },
            "required": ["value"]
        }))];
        let arguments = json!({ "value": true }).as_object().unwrap().clone();

        let validated = validate_tool_call(&tools, &call(arguments)).unwrap();

        assert_eq!(validated, json!({ "value": "true" }));
    }
}
