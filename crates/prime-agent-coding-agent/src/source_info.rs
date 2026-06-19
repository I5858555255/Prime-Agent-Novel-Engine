use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceScope {
    User,
    Project,
    Temporary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceOrigin {
    Package,
    TopLevel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathMetadata {
    pub source: String,
    pub scope: SourceScope,
    pub origin: SourceOrigin,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub path: String,
    pub source: String,
    pub scope: SourceScope,
    pub origin: SourceOrigin,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
}

pub fn create_source_info(path: impl Into<String>, metadata: PathMetadata) -> SourceInfo {
    SourceInfo {
        path: path.into(),
        source: metadata.source,
        scope: metadata.scope,
        origin: metadata.origin,
        base_dir: metadata.base_dir,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyntheticSourceInfoOptions {
    pub source: String,
    pub scope: Option<SourceScope>,
    pub origin: Option<SourceOrigin>,
    pub base_dir: Option<String>,
}

pub fn create_synthetic_source_info(
    path: impl Into<String>,
    options: SyntheticSourceInfoOptions,
) -> SourceInfo {
    SourceInfo {
        path: path.into(),
        source: options.source,
        scope: options.scope.unwrap_or(SourceScope::Temporary),
        origin: options.origin.unwrap_or(SourceOrigin::TopLevel),
        base_dir: options.base_dir,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn creates_source_info_from_path_metadata() {
        let info = create_source_info(
            "/tmp/pkg",
            PathMetadata {
                source: "marketplace".to_string(),
                scope: SourceScope::User,
                origin: SourceOrigin::Package,
                base_dir: Some("/tmp".to_string()),
            },
        );

        assert_eq!(info.path, "/tmp/pkg");
        assert_eq!(info.source, "marketplace");
        assert_eq!(info.scope, SourceScope::User);
        assert_eq!(info.origin, SourceOrigin::Package);
        assert_eq!(info.base_dir.as_deref(), Some("/tmp"));
    }

    #[test]
    fn synthetic_source_info_defaults_to_temporary_top_level() {
        let info = create_synthetic_source_info(
            "/tmp/generated",
            SyntheticSourceInfoOptions {
                source: "generated".to_string(),
                scope: None,
                origin: None,
                base_dir: None,
            },
        );

        assert_eq!(info.scope, SourceScope::Temporary);
        assert_eq!(info.origin, SourceOrigin::TopLevel);
    }

    #[test]
    fn serializes_with_typescript_field_names() {
        let info = create_source_info(
            "path",
            PathMetadata {
                source: "source".to_string(),
                scope: SourceScope::Project,
                origin: SourceOrigin::TopLevel,
                base_dir: Some("base".to_string()),
            },
        );

        assert_eq!(
            serde_json::to_value(info).unwrap(),
            json!({
                "path": "path",
                "source": "source",
                "scope": "project",
                "origin": "top-level",
                "baseDir": "base"
            })
        );
    }
}
