// Module: status_schema - A7 session status contract (Wave 2-4)
//
// StatusSchema is the single source of truth for a novel-writing session's
// runtime state. It lives at .novel/status.json in the project directory
// and is read/written via Tauri commands.
//
// Design notes:
//   - schema_version is fixed at "1" for the current implementation
//   - session_id follows the pattern "novel-YYYYMMDD-HHMMSS"
//   - decision_gates contains three default gates (consistency/anti_ai/quality)
//   - boundary_contract and execution_criteria are JSON values to allow
//     flexible schema evolution without Rust struct changes

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::novel::decision_gate::DecisionGate;

/// Overall status of a novel-writing session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Running,
    Completed,
    Paused,
    Blocked,
}

/// The top-level status document for a novel-writing session (A7).
///
/// This struct is the single source of truth for session state, persisted
/// at `.novel/status.json`. The `decision_gates` field implements the
/// dual-layer quality gating model (mechanical + semantic).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusSchema {
    /// Schema version identifier. Must be "1" for this implementation.
    pub schema_version: String,
    /// Unique session identifier matching pattern: novel-YYYYMMDD-HHMMSS
    pub session_id: String,
    /// ISO 8601 timestamp of session creation.
    pub created_at: String,
    /// ISO 8601 timestamp of last update.
    pub updated_at: String,
    /// Source that produced this status (e.g., "qmai", "niko-studio").
    pub source: String,
    /// Current session status.
    pub status: SessionStatus,
    /// Index of the currently active step in task_decomposition, if any.
    pub active_step_index: Option<usize>,
    /// Boundary contract defining scope limits for this session.
    pub boundary_contract: serde_json::Value,
    /// Execution criteria for this session.
    pub execution_criteria: Vec<serde_json::Value>,
    /// Task decomposition steps for this session.
    pub task_decomposition: Vec<serde_json::Value>,
    /// Decision gates keyed by name ("consistency", "anti_ai", "quality").
    pub decision_gates: HashMap<String, DecisionGate>,
    /// Draft state, if a draft is in progress.
    pub draft: Option<serde_json::Value>,
    /// Snapshot of memory state for this session.
    pub memory_snapshot: Option<serde_json::Value>,
}

impl StatusSchema {
    /// Create a new StatusSchema with the given session_id and source,
    /// default decision gates, and Running status.
    pub fn new(session_id: String, source: String) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            schema_version: "1".to_string(),
            session_id,
            created_at: now.clone(),
            updated_at: now,
            source,
            status: SessionStatus::Running,
            active_step_index: None,
            boundary_contract: serde_json::Value::Null,
            execution_criteria: Vec::new(),
            task_decomposition: Vec::new(),
            decision_gates: DecisionGate::default_gates(),
            draft: None,
            memory_snapshot: None,
        }
    }

    /// Validate that the schema_version is "1" and session_id matches
    /// the pattern `novel-YYYYMMDD-HHMMSS`.
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != "1" {
            return Err(format!(
                "Unsupported schema_version: expected \"1\", got \"{}\"",
                self.schema_version
            ));
        }

        // session_id must match novel-YYYYMMDD-HHMMSS
        let re = regex::Regex::new(r"^novel-\d{8}-\d{6}$").unwrap();
        if !re.is_match(&self.session_id) {
            return Err(format!(
                "Invalid session_id: must match pattern novel-YYYYMMDD-HHMMSS, got \"{}\"",
                self.session_id
            ));
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_status_has_schema_version_1() {
        let schema = StatusSchema::new(
            "novel-20260622-143000".to_string(),
            "qmai".to_string(),
        );
        assert_eq!(schema.schema_version, "1");
    }

    #[test]
    fn new_status_is_running() {
        let schema = StatusSchema::new(
            "novel-20260622-143000".to_string(),
            "qmai".to_string(),
        );
        assert_eq!(schema.status, SessionStatus::Running);
    }

    #[test]
    fn new_status_has_three_default_gates() {
        let schema = StatusSchema::new(
            "novel-20260622-143000".to_string(),
            "qmai".to_string(),
        );
        assert_eq!(schema.decision_gates.len(), 3);
        assert!(schema.decision_gates.contains_key("consistency"));
        assert!(schema.decision_gates.contains_key("anti_ai"));
        assert!(schema.decision_gates.contains_key("quality"));
    }

    #[test]
    fn validate_accepts_correct_session_id() {
        let schema = StatusSchema::new(
            "novel-20260622-143000".to_string(),
            "qmai".to_string(),
        );
        assert!(schema.validate().is_ok());
    }

    #[test]
    fn validate_rejects_bad_schema_version() {
        let mut schema = StatusSchema::new(
            "novel-20260622-143000".to_string(),
            "qmai".to_string(),
        );
        schema.schema_version = "2".to_string();
        assert!(schema.validate().is_err());
        let err = schema.validate().unwrap_err();
        assert!(err.contains("schema_version"));
    }

    #[test]
    fn validate_rejects_bad_session_id() {
        let schema = StatusSchema::new(
            "bad-id".to_string(),
            "qmai".to_string(),
        );
        assert!(schema.validate().is_err());
        let err = schema.validate().unwrap_err();
        assert!(err.contains("session_id"));
    }

    #[test]
    fn session_status_serializes_to_snake_case() {
        let json = serde_json::to_string(&SessionStatus::Running).unwrap();
        assert_eq!(json, "\"running\"");
    }

    #[test]
    fn status_schema_roundtrips_json() {
        let original = StatusSchema::new(
            "novel-20260622-143000".to_string(),
            "qmai".to_string(),
        );
        let json = serde_json::to_string(&original).unwrap();
        let restored: StatusSchema = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.schema_version, original.schema_version);
        assert_eq!(restored.session_id, original.session_id);
        assert_eq!(restored.source, original.source);
        assert_eq!(restored.decision_gates.len(), 3);
    }
}
