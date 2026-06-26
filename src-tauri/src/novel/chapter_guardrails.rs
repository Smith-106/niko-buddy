use serde::Serialize;
use crate::novel::slop_scorer::{SlopScorer, SlopFinding};

/// Suggestion for fixing a slop finding
#[derive(Debug, Serialize, Clone)]
pub struct Suggestion {
    pub category: String,
    pub severity: String,
    pub description: String,
    pub action: String,
}

/// Result of guardrails check
#[derive(Debug, Serialize, Clone)]
pub struct GuardResult {
    pub passed: bool,
    pub score: f32,
    pub findings: Vec<SlopFinding>,
    pub suggestions: Vec<Suggestion>,
}

#[derive(Debug, Clone)]
pub struct ChapterGuardrails {
    pub threshold: f32,
    scorer: SlopScorer,
}

impl ChapterGuardrails {
    pub fn new(threshold: f32) -> Self {
        ChapterGuardrails {
            threshold,
            scorer: SlopScorer::new(),
        }
    }

    /// Check text against guardrails threshold
    pub fn check(&self, text: &str) -> GuardResult {
        let report = self.scorer.apply(text);
        let passed = report.score < self.threshold;
        let suggestions = if !passed {
            self.auto_suggest(&report.findings)
        } else {
            vec![]
        };

        GuardResult {
            passed,
            score: report.score,
            findings: report.findings,
            suggestions,
        }
    }

    /// Generate rewrite suggestions from findings
    pub fn auto_suggest(&self, findings: &[SlopFinding]) -> Vec<Suggestion> {
        let mut suggestions = Vec::new();
        for finding in findings {
            let suggestion = match finding.category.as_str() {
                "transition_overuse" => Suggestion {
                    category: finding.category.clone(),
                    severity: "major".into(),
                    description: "过渡词过度使用".into(),
                    action: "删除多余过渡词，一段话最多保留一个；连续两段以'不过''但是''然而'开头需修改".into(),
                },
                "explanatory_aside" => Suggestion {
                    category: finding.category.clone(),
                    severity: "major".into(),
                    description: "解释性旁白".into(),
                    action: "删除'因为'解释句，读者能从上下文推断的不需要写明".into(),
                },
                "emotion_labeling" => Suggestion {
                    category: finding.category.clone(),
                    severity: "critical".into(),
                    description: "情感标签化".into(),
                    action: "将心理感受替换为身体反应：恐惧→手心出汗，感动→鼻子一酸，惊讶→愣住".into(),
                },
                "ai_fingerprint" => Suggestion {
                    category: finding.category.clone(),
                    severity: "critical".into(),
                    description: "AI指纹词污染".into(),
                    action: "替换AI指纹词：赋能→绝不用，抓手→绝不用，底层逻辑→绝不用；迭代→升级，闭环→收尾".into(),
                },
                "judgment_shortcut" => Suggestion {
                    category: finding.category.clone(),
                    severity: "critical".into(),
                    description: "判定式短句".into(),
                    action: "删除'不是X，是Y'结构，改用可感知细节：声音持续、气味来源、手感变化、物件破损".into(),
                },
                "verb_homogenization" => Suggestion {
                    category: finding.category.clone(),
                    severity: "major".into(),
                    description: "动词同质化".into(),
                    action: "将万能动词替换为具体动词：进行搜索→翻了一遍，实施救援→把人拉出来，做出回应→回了一句".into(),
                },
                "summary_ending" => Suggestion {
                    category: finding.category.clone(),
                    severity: "major".into(),
                    description: "标准答案式结尾".into(),
                    action: "删除段落末尾的总结句，正文说清楚就不需要盖章确认".into(),
                },
                _ => Suggestion {
                    category: finding.category.clone(),
                    severity: "minor".into(),
                    description: finding.description.clone(),
                    action: format!("检查并修正{}问题", finding.description),
                },
            };
            suggestions.push(suggestion);
        }
        suggestions
    }
}

impl Default for ChapterGuardrails {
    fn default() -> Self {
        Self::new(45.0)
    }
}
