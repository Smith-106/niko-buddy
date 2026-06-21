// Module: decision_gate - A7 decision gates for quality gating (Wave 2-4)
//
// Each gate represents a quality checkpoint with mechanical (rule-engine)
// and semantic (LLM-based) findings. The dual-layer inspection model follows
// ANL-004-C17: mechanical first, semantic second.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::novel::types::Finding;

/// The type of quality gate being evaluated.
/// Order reflects priority: Consistency (P0) > AntiAi (P1) > Quality (P2).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum GateType {
    Consistency,
    AntiAi,
    Quality,
}

/// The current status of a decision gate evaluation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GateStatus {
    Pending,
    Passed,
    Failed,
    Warning,
}

/// A single decision gate in the A7 status schema.
///
/// Each gate collects findings from two independent inspection layers:
/// - `mechanical_findings`: deterministic, rule-based checks (zero遗漏)
/// - `semantic_findings`: LLM-based checks for deeper patterns
///
/// The gate retries up to `max_retry` times before reporting final failure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecisionGate {
    pub gate_type: GateType,
    pub mechanical_findings: Vec<Finding>,
    pub semantic_findings: Vec<Finding>,
    pub retry_count: u32,
    pub max_retry: u32,
    pub status: GateStatus,
}

impl DecisionGate {
    /// Create a default gate for a given type with Pending status,
    /// no findings, and max_retry = 3.
    pub fn new(gate_type: GateType) -> Self {
        Self {
            gate_type,
            mechanical_findings: Vec::new(),
            semantic_findings: Vec::new(),
            retry_count: 0,
            max_retry: 3,
            status: GateStatus::Pending,
        }
    }

    /// Produce the standard set of three default gates for a new session:
    /// "consistency", "anti_ai", "quality".
    pub fn default_gates() -> HashMap<String, DecisionGate> {
        let mut gates = HashMap::new();
        gates.insert(
            "consistency".to_string(),
            DecisionGate::new(GateType::Consistency),
        );
        gates.insert(
            "anti_ai".to_string(),
            DecisionGate::new(GateType::AntiAi),
        );
        gates.insert(
            "quality".to_string(),
            DecisionGate::new(GateType::Quality),
        );
        gates
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_gates_has_three_entries() {
        let gates = DecisionGate::default_gates();
        assert_eq!(gates.len(), 3);
        assert!(gates.contains_key("consistency"));
        assert!(gates.contains_key("anti_ai"));
        assert!(gates.contains_key("quality"));
    }

    #[test]
    fn new_gate_is_pending_with_max_retry_3() {
        let gate = DecisionGate::new(GateType::Consistency);
        assert_eq!(gate.status, GateStatus::Pending);
        assert_eq!(gate.retry_count, 0);
        assert_eq!(gate.max_retry, 3);
        assert!(gate.mechanical_findings.is_empty());
        assert!(gate.semantic_findings.is_empty());
    }

    #[test]
    fn gate_type_serializes_to_snake_case() {
        let json = serde_json::to_string(&GateType::AntiAi).unwrap();
        assert_eq!(json, "\"anti_ai\"");
    }

    #[test]
    fn gate_status_roundtrips_json() {
        let original = GateStatus::Failed;
        let json = serde_json::to_string(&original).unwrap();
        let restored: GateStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(original, restored);
    }
}
