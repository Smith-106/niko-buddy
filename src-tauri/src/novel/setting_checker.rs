use crate::novel::types::Finding;

/// Setting/Worldview consistency checker (P0 dimension)
/// Mechanical: detects setting violations via keyword patterns
/// Semantic: reserved for LLM-based internal logic check (stub)
pub struct SettingChecker {
    /// Era-specific violation patterns
    era_violations: Vec<(String, String)>,  // (pattern, description)
}

impl SettingChecker {
    pub fn new() -> Self {
        // Common era violations for Chinese web novels
        let violations = vec![
            (r"(?:古代|古代背景|封建|朝代).+?(?:手机|电脑|网络|互联网|微信|电子邮件)".into(), "古代背景出现现代科技".into()),
            (r"(?:修仙|仙侠|修真).+?(?:基因|DNA|量子|纳米|粒子|辐射)".into(), "修仙背景出现现代科学概念".into()),
            (r"(?:末日|废土|末世).+?(?:信用卡|银行|超市购物|网购|外卖)".into(), "末日背景出现正常社会消费".into()),
        ];
        SettingChecker { era_violations: violations }
    }

    /// Mechanical layer: pattern-based setting violation detection
    pub fn mechanical_check(&self, text: &str, _project_path: &str) -> Vec<Finding> {
        let mut findings = Vec::new();

        for (pattern, description) in &self.era_violations {
            if let Ok(re) = regex::Regex::new(pattern) {
                for mat in re.find_iter(text) {
                    findings.push(Finding {
                        severity: "critical".into(),
                        description: description.clone(),
                        location: Some(format!("offset {}", mat.start())),
                        suggestion: Some("检查世界观设定——此场景中的物品/概念不应出现在当前时代背景".into()),
                    });
                }
            }
        }

        // Check for AI-typical generic setting descriptions
        if let Ok(re) = regex::Regex::new(r"(?:房间里有一张床.*?衣柜|街道两旁是各种.*?店铺.*?行人来来往往|四周是一片.*?景象)") {
            for mat in re.find_iter(text) {
                findings.push(Finding {
                    severity: "warning".into(),
                    description: "AI式全景扫描描写".into(),
                    location: Some(format!("offset {}", mat.start())),
                    suggestion: Some("只写角色当前会注意到的2-3个特征，不要做全景扫描".into()),
                });
            }
        }

        findings
    }

    /// Semantic layer: LLM-based setting logic check
    /// STUB: returns empty findings (will be implemented with LLM integration)
    pub fn semantic_check(&self, _text: &str, _project_path: &str) -> Vec<Finding> {
        // TODO: Implement LLM-based semantic check
        // 1. Load setting dictionary from .novel/settings.json
        // 2. Construct prompt with setting rules + text excerpt
        // 3. Ask LLM: "Does this scene respect the established world rules?"
        // 4. Parse LLM response into Findings
        vec![]
    }
}

impl Default for SettingChecker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mechanical_detects_era_violation() {
        let checker = SettingChecker::new();
        let text = "在古代背景的京城，他拿出手机给朋友发了微信。";
        let findings = checker.mechanical_check(text, "/tmp/test");
        assert!(!findings.is_empty(), "Should detect era violation (ancient + phone)");
    }

    #[test]
    fn test_mechanical_clean_setting_no_findings() {
        let checker = SettingChecker::new();
        let text = "他在京城的大街上走着，两旁是茶楼和布庄。";
        let findings = checker.mechanical_check(text, "/tmp/test");
        assert!(findings.is_empty(), "Clean setting text should have no findings");
    }

    #[test]
    fn test_semantic_check_returns_empty_stub() {
        let checker = SettingChecker::new();
        let findings = checker.semantic_check("any text", "/tmp/test");
        assert!(findings.is_empty(), "Semantic check is stub, should return empty");
    }
}
