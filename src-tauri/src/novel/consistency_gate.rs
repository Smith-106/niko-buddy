use serde::Serialize;
use crate::novel::types::Finding;
use crate::novel::role_cognition_checker::RoleCognitionChecker;
use crate::novel::setting_checker::SettingChecker;

/// Consistency check dimension
#[derive(Debug, Serialize, Clone, PartialEq, Hash, Eq)]
pub enum ConsistencyDimension {
    RoleCognition,    // P0: 角色认知一致性
    Setting,          // P0: 世界观设定一致性
    Causal,           // P1: 因果逻辑 (stub)
    Foreshadowing,    // P1: 伏笔一致性 (stub)
    Timeline,         // P2: 时间线/视角 (stub)
}

/// Result of a consistency gate check
#[derive(Debug, Serialize, Clone)]
pub struct GateResult {
    pub passed: bool,
    pub score: f32,                          // 0-100, higher = more consistent
    pub mechanical_findings: Vec<Finding>,
    pub semantic_findings: Vec<Finding>,
    pub dimension: ConsistencyDimension,
}

/// Main consistency gate orchestrator
pub struct ConsistencyGate {
    role_checker: RoleCognitionChecker,
    setting_checker: SettingChecker,
}

impl ConsistencyGate {
    pub fn new() -> Self {
        ConsistencyGate {
            role_checker: RoleCognitionChecker::new(),
            setting_checker: SettingChecker::new(),
        }
    }

    /// Check text for a specific consistency dimension
    /// Dual-layer: mechanical first, if findings → short-circuit (skip semantic)
    /// If mechanical clean → run semantic layer
    pub fn check(&self, text: &str, dimension: &ConsistencyDimension, project_path: &str) -> GateResult {
        let (mechanical_findings, semantic_findings) = match dimension {
            ConsistencyDimension::RoleCognition => {
                let mechanical = self.role_checker.mechanical_check(text, project_path);
                if !mechanical.is_empty() {
                    // Short-circuit: mechanical found issues, skip semantic
                    (mechanical, vec![])
                } else {
                    // Mechanical clean, run semantic
                    let semantic = self.role_checker.semantic_check(text, project_path);
                    (vec![], semantic)
                }
            }
            ConsistencyDimension::Setting => {
                let mechanical = self.setting_checker.mechanical_check(text, project_path);
                if !mechanical.is_empty() {
                    (mechanical, vec![])
                } else {
                    let semantic = self.setting_checker.semantic_check(text, project_path);
                    (vec![], semantic)
                }
            }
            // P1/P2 stubs - return passed for now
            _ => (vec![], vec![]),
        };

        let all_findings: Vec<&Finding> = mechanical_findings.iter().chain(semantic_findings.iter()).collect();
        let passed = all_findings.is_empty();
        let score = if passed { 100.0 } else {
            // Lower score for more findings
            let deduction = all_findings.len() as f32 * 15.0;
            (100.0 - deduction).max(0.0)
        };

        GateResult {
            passed,
            score,
            mechanical_findings,
            semantic_findings,
            dimension: dimension.clone(),
        }
    }

    /// Check all P0 dimensions
    pub fn check_p0(&self, text: &str, project_path: &str) -> Vec<GateResult> {
        vec![
            self.check(text, &ConsistencyDimension::RoleCognition, project_path),
            self.check(text, &ConsistencyDimension::Setting, project_path),
        ]
    }
}

impl Default for ConsistencyGate {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_consistency_dimension_variants() {
        assert_eq!(ConsistencyDimension::RoleCognition, ConsistencyDimension::RoleCognition);
        assert_eq!(ConsistencyDimension::Setting, ConsistencyDimension::Setting);
    }

    #[test]
    fn test_gate_result_passed_when_no_findings() {
        let result = GateResult {
            passed: true,
            score: 100.0,
            mechanical_findings: vec![],
            semantic_findings: vec![],
            dimension: ConsistencyDimension::RoleCognition,
        };
        assert!(result.passed);
    }

    #[test]
    fn test_consistency_gate_check_p0_returns_two_results() {
        let gate = ConsistencyGate::new();
        let results = gate.check_p0("测试文本", "/tmp/test-project");
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].dimension, ConsistencyDimension::RoleCognition);
        assert_eq!(results[1].dimension, ConsistencyDimension::Setting);
    }
}
