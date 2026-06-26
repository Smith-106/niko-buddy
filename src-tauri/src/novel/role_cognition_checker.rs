use crate::novel::types::Finding;

/// Role cognition consistency checker (P0 dimension)
/// Mechanical: regex-based contradiction detection
/// Semantic: reserved for LLM-based behavioral consistency check (stub)
#[derive(Clone)]
pub struct RoleCognitionChecker {
    /// Patterns that indicate contradiction in character knowledge
    contradiction_patterns: Vec<(String, String)>,  // (pattern, description)
}

impl RoleCognitionChecker {
    pub fn new() -> Self {
        let patterns = vec![
            (r"不知道.*?却知道".into(), "角色同时不知道和知道同一件事".into()),
            (r"完全不了解.*?却.*?熟悉".into(), "角色对同一领域同时不了解和熟悉".into()),
            (r"第一次.*?见.*?之前.*?见过".into(), "角色对同一事物既是第一次见又之前见过".into()),
        ];
        RoleCognitionChecker { contradiction_patterns: patterns }
    }

    /// Mechanical layer: regex-based detection of character knowledge contradictions
    /// Zero LLM cost - fast pattern matching
    pub fn mechanical_check(&self, text: &str, _project_path: &str) -> Vec<Finding> {
        let mut findings = Vec::new();

        // Check for contradiction patterns
        for (pattern, description) in &self.contradiction_patterns {
            if let Ok(re) = regex::Regex::new(pattern) {
                for mat in re.find_iter(text) {
                    findings.push(Finding {
                        severity: "critical".into(),
                        description: description.clone(),
                        location: Some(format!("offset {}", mat.start())),
                        suggestion: Some("检查角色认知是否一致——角色不能同时知道和不知道同一件事".into()),
                    });
                }
            }
        }

        // Check for excessive knowledge scope changes within a paragraph
        // Pattern: character name + "知道" or "了解" followed by contradictory scope
        if let Ok(re) = regex::Regex::new(r"(他|她|它|他们)(?:对|关于|在).+?(?:一无所知|完全不了解|毫不知情).+?(?:却|但|竟然).+?(?:知道|了解|熟悉|明白)") {
            for mat in re.find_iter(text) {
                findings.push(Finding {
                    severity: "critical".into(),
                    description: "角色认知矛盾：同一段落内既不知情又知情".into(),
                    location: Some(format!("offset {}", mat.start())),
                    suggestion: Some("修正角色认知状态——确保知道/不知道的边界一致".into()),
                });
            }
        }

        findings
    }

    /// Semantic layer: LLM-based behavioral consistency check
    /// STUB: returns empty findings (will be implemented with LLM integration)
    pub fn semantic_check(&self, _text: &str, _project_path: &str) -> Vec<Finding> {
        // TODO: Implement LLM-based semantic check
        // 1. Retrieve character facts from LanceDB (vector_search)
        // 2. Construct prompt with character facts + text excerpt
        // 3. Ask LLM: "Does this character action align with their established cognition?"
        // 4. Parse LLM response into Findings
        vec![]
    }
}

impl Default for RoleCognitionChecker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mechanical_detects_contradiction() {
        let checker = RoleCognitionChecker::new();
        let text = "他不知道这件事，却知道其中的关键细节。";
        let findings = checker.mechanical_check(text, "/tmp/test");
        assert!(!findings.is_empty(), "Should detect knowledge contradiction");
    }

    #[test]
    fn test_mechanical_clean_text_no_findings() {
        let checker = RoleCognitionChecker::new();
        let text = "他对这件事完全不了解。他决定去调查一下。";
        let findings = checker.mechanical_check(text, "/tmp/test");
        assert!(findings.is_empty(), "Clean text should have no findings");
    }

    #[test]
    fn test_semantic_check_returns_empty_stub() {
        let checker = RoleCognitionChecker::new();
        let findings = checker.semantic_check("any text", "/tmp/test");
        assert!(findings.is_empty(), "Semantic check is stub, should return empty");
    }
}
