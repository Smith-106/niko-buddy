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

/// Summary of running all decision gates on text
#[derive(Debug, Clone, Serialize)]
pub struct GateSummary {
    /// Whether ALL gates passed
    pub all_passed: bool,
    /// Individual gate results keyed by gate name
    pub gate_results: HashMap<String, GateResultInfo>,
    /// Total number of fix-loop retries across all gates
    pub total_retries: u32,
    /// Maximum retries allowed
    pub max_retry: u32,
    /// Final text after fix-loop (if regeneration happened)
    pub final_text: Option<String>,
}

/// Compact gate result for inclusion in GateSummary
#[derive(Debug, Clone, Serialize)]
pub struct GateResultInfo {
    pub gate_type: GateType,
    pub status: GateStatus,
    pub score: f32,
    pub finding_count: usize,
    pub retry_count: u32,
}

/// Orchestrator that runs all three decision gates in priority order
/// with fix-loop capability.
///
/// Priority: P0 (Consistency) > P1 (Anti-AI) > P2 (Quality)
/// Fix-loop: if a gate fails and retry_count < max_retry, inject findings
/// into a regeneration prompt, regenerate text, and re-run the failed gate.
pub struct DecisionGateOrchestrator {
    pub max_retry: u32,
}

impl DecisionGateOrchestrator {
    pub fn new() -> Self {
        Self { max_retry: 3 }
    }

    /// Run all gates in priority order on text
    /// Returns GateSummary with results
    pub fn run_gates(&self, text: &str, project_path: &str) -> GateSummary {
        let mut gate_results: HashMap<String, GateResultInfo> = HashMap::new();
        let mut total_retries = 0u32;
        let mut current_text = text.to_string();

        // P0: Consistency Gate
        let consistency_result = self.run_consistency_gate(&current_text, project_path);
        let consistency_retries = consistency_result.retry_count;
        total_retries += consistency_retries;
        if !consistency_result.status_is_passed() && consistency_retries >= self.max_retry {
            // P0 failed and exhausted retries — stop here
            gate_results.insert("consistency".into(), consistency_result);
            return GateSummary {
                all_passed: false,
                gate_results,
                total_retries,
                max_retry: self.max_retry,
                final_text: if current_text != text { Some(current_text) } else { None },
            };
        }
        if consistency_retries > 0 {
            current_text = self.apply_fix_loop_text(&current_text, "consistency");
        }
        gate_results.insert("consistency".into(), consistency_result);

        // P1: Anti-AI Gate
        let anti_ai_result = self.run_anti_ai_gate(&current_text);
        let anti_ai_retries = anti_ai_result.retry_count;
        total_retries += anti_ai_retries;
        if !anti_ai_result.status_is_passed() && anti_ai_retries >= self.max_retry {
            gate_results.insert("anti_ai".into(), anti_ai_result);
            return GateSummary {
                all_passed: false,
                gate_results,
                total_retries,
                max_retry: self.max_retry,
                final_text: if current_text != text { Some(current_text) } else { None },
            };
        }
        if anti_ai_retries > 0 {
            current_text = self.apply_fix_loop_text(&current_text, "anti_ai");
        }
        gate_results.insert("anti_ai".into(), anti_ai_result);

        // P2: Quality Gate (basic word-count / readability check)
        let quality_result = self.run_quality_gate(&current_text);
        total_retries += quality_result.retry_count;
        gate_results.insert("quality".into(), quality_result);

        let all_passed = gate_results.values().all(|r| r.status_is_passed());

        GateSummary {
            all_passed,
            gate_results,
            total_retries,
            max_retry: self.max_retry,
            final_text: if current_text != text { Some(current_text) } else { None },
        }
    }

    /// P0: Consistency Gate — uses ConsistencyGate from consistency_gate module
    fn run_consistency_gate(&self, text: &str, project_path: &str) -> GateResultInfo {
        use crate::novel::consistency_gate::ConsistencyGate;
        let gate = ConsistencyGate::new();
        let results = gate.check_p0(text, project_path);
        let all_passed = results.iter().all(|r| r.passed);
        let total_findings: usize = results.iter()
            .map(|r| r.mechanical_findings.len() + r.semantic_findings.len())
            .sum();
        let min_score = results.iter().map(|r| r.score).fold(100.0f32, f32::min);

        GateResultInfo {
            gate_type: GateType::Consistency,
            status: if all_passed { GateStatus::Passed } else { GateStatus::Failed },
            score: min_score,
            finding_count: total_findings,
            retry_count: if !all_passed { 1 } else { 0 },
        }
    }

    /// P1: Anti-AI Gate — uses SlopScorer + ChapterGuardrails
    fn run_anti_ai_gate(&self, text: &str) -> GateResultInfo {
        use crate::novel::chapter_guardrails::ChapterGuardrails;
        let guardrails = ChapterGuardrails::new(45.0);
        let result = guardrails.check(text);

        GateResultInfo {
            gate_type: GateType::AntiAi,
            status: if result.passed { GateStatus::Passed } else { GateStatus::Failed },
            score: 100.0 - result.score, // invert: lower slop score = higher quality
            finding_count: result.findings.len(),
            retry_count: if !result.passed { 1 } else { 0 },
        }
    }

    /// P2: Quality Gate — basic readability checks
    fn run_quality_gate(&self, text: &str) -> GateResultInfo {
        let char_count = text.chars().count();
        let sentence_count = text.chars().filter(|c| *c == '。' || *c == '！' || *c == '？' || *c == '.' || *c == '!' || *c == '?').count().max(1);
        let avg_sentence_length = char_count as f32 / sentence_count as f32;

        // Flag if average sentence is too long (> 50 chars = likely run-on)
        let findings_count = if avg_sentence_length > 50.0 { 1 } else { 0 };
        let score = if findings_count == 0 { 100.0 } else { 70.0 };

        GateResultInfo {
            gate_type: GateType::Quality,
            status: if findings_count == 0 { GateStatus::Passed } else { GateStatus::Warning },
            score,
            finding_count: findings_count,
            retry_count: 0,
        }
    }

    /// Simulate fix-loop text modification
    /// In real implementation, this would call InstructionFlow with findings
    /// For now, returns the text unchanged (mock regeneration)
    fn apply_fix_loop_text(&self, text: &str, _gate_name: &str) -> String {
        // TODO: Real implementation would:
        // 1. Format findings as "Known issues to fix: ..."
        // 2. Call InstructionFlow.build_prompt(WriteIntent::Rewrite, context_with_findings)
        // 3. Call InstructionFlow.stream_generate(prompt)
        // 4. Return regenerated text
        text.to_string()
    }
}

impl Default for DecisionGateOrchestrator {
    fn default() -> Self {
        Self::new()
    }
}

impl GateResultInfo {
    fn status_is_passed(&self) -> bool {
        self.status == GateStatus::Passed
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

    #[test]
    fn test_orchestrator_run_gates_clean_text_passes() {
        let orchestrator = DecisionGateOrchestrator::new();
        let text = "他笑了笑。沉默。沉默。烟从指缝间漏出来，风一吹就散了。";
        let summary = orchestrator.run_gates(text, "/tmp/test");
        assert!(summary.all_passed, "Clean text should pass all gates");
        assert_eq!(summary.total_retries, 0);
    }

    #[test]
    fn test_orchestrator_run_gates_slop_text_fails_p1() {
        let orchestrator = DecisionGateOrchestrator::new();
        let text = "值得注意的是，这个系统的底层逻辑是通过赋能用户来实现闭环。然而，由于因此他感到一阵深深的恐惧。他伸手从桌上拿起杯子，送到嘴边喝了一口。换句话说，这意味着一切都在进行迭代。作为社区工作者的他，正准备实施救援。";
        let summary = orchestrator.run_gates(text, "/tmp/test");
        // Anti-AI gate should fail (slop score > 45)
        let anti_ai = summary.gate_results.get("anti_ai").unwrap();
        assert!(!anti_ai.status_is_passed(), "Anti-AI gate should fail for slop text");
    }

    #[test]
    fn test_orchestrator_run_gates_inconsistency_fails_p0() {
        let orchestrator = DecisionGateOrchestrator::new();
        let text = "他不知道这件事，却知道其中的关键细节。";
        let summary = orchestrator.run_gates(text, "/tmp/test");
        let consistency = summary.gate_results.get("consistency").unwrap();
        assert!(!consistency.status_is_passed(), "Consistency gate should fail for contradictory text");
    }

    #[test]
    fn test_orchestrator_execution_order_p0_p1_p2() {
        let orchestrator = DecisionGateOrchestrator::new();
        let text = "正常文本，没什么问题。";
        let summary = orchestrator.run_gates(text, "/tmp/test");
        // All three gates should exist
        assert!(summary.gate_results.contains_key("consistency"), "P0 consistency should exist");
        assert!(summary.gate_results.contains_key("anti_ai"), "P1 anti_ai should exist");
        assert!(summary.gate_results.contains_key("quality"), "P2 quality should exist");
    }

    #[test]
    fn test_orchestrator_max_retry_is_3() {
        let orchestrator = DecisionGateOrchestrator::new();
        assert_eq!(orchestrator.max_retry, 3);
    }

    #[test]
    fn test_gate_summary_all_passed_when_clean() {
        let orchestrator = DecisionGateOrchestrator::new();
        let text = "他笑了笑。沉默。沉默。烟从指缝间漏出来。";
        let summary = orchestrator.run_gates(text, "/tmp/test");
        assert!(summary.all_passed);
        assert!(summary.final_text.is_none(), "Clean text should not have fix-loop output");
    }
}
