use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;

/// A single slop detection rule
#[derive(Debug, Clone)]
pub struct SlopRule {
    pub category: String,
    pub regex: Regex,
    pub weight: f32,
    pub description: String,
}

/// Result of applying SlopScorer to text
#[derive(Debug, Serialize, Clone)]
pub struct SlopFinding {
    pub category: String,
    pub count: usize,
    pub weight: f32,
    pub description: String,
    pub matches: Vec<String>, // first 5 match excerpts
}

/// Full slop report
#[derive(Debug, Serialize, Clone)]
pub struct SlopReport {
    pub score: f32, // 0-100, higher = more AI-slop
    pub findings: Vec<SlopFinding>,
    pub category_breakdown: HashMap<String, f32>,
}

pub struct SlopScorer {
    rules: Vec<SlopRule>,
}

impl SlopScorer {
    pub fn new() -> Self {
        let rules = Self::build_rules();
        SlopScorer { rules }
    }

    fn build_rules() -> Vec<SlopRule> {
        // 14 categories matching anti_ai_rules.rs SLOP_CATEGORIES
        vec![
            // 2.1 过渡词过度使用
            SlopRule {
                category: "transition_overuse".into(),
                regex: Regex::new(r"(?:然而|不过|但是|因此|因而|值得注意的是|与此同时|尽管如此|基于这个原因|在某种层面上|换句话说|总的来说|总而言之)").unwrap(),
                weight: 8.0,
                description: "过渡词过度使用".into(),
            },
            // 2.2 解释性旁白
            SlopRule {
                category: "explanatory_aside".into(),
                regex: Regex::new(r"(?:因为|毕竟|之所以)").unwrap(),
                weight: 7.0,
                description: "解释性旁白".into(),
            },
            // 2.3 动作描写过度完整
            SlopRule {
                category: "overcomplete_action".into(),
                regex: Regex::new(r"(?:伸手|从.*里掏出|从.*中取出|朝着.*的方向走了过去)").unwrap(),
                weight: 5.0,
                description: "动作描写过度完整".into(),
            },
            // 2.4 情感标签化
            SlopRule {
                category: "emotion_labeling".into(),
                regex: Regex::new(r"(?:感到一阵|心里充满了|非常惊讶|感到深深的|充满了感动)").unwrap(),
                weight: 9.0,
                description: "情感标签化".into(),
            },
            // 2.5 因果链过度完整
            SlopRule {
                category: "overcomplete_causality".into(),
                regex: Regex::new(r"(?:因为.*所以|由于.*因此|之所以.*是因为)").unwrap(),
                weight: 6.0,
                description: "因果链过度完整".into(),
            },
            // 2.6 全方位观察综合征
            SlopRule {
                category: "panoramic_scan".into(),
                regex: Regex::new(r"(?:有.*?)?(?:、).*?(?:、).*?(?:、)").unwrap(),
                weight: 4.0,
                description: "全方位观察综合征".into(),
            },
            // 2.7 每段必推进 - heuristic via sentence length uniformity
            SlopRule {
                category: "relentless_progression".into(),
                regex: Regex::new(r"").unwrap(), // heuristic, not regex-based
                weight: 4.0,
                description: "每段必推进综合征".into(),
            },
            // 2.8 标准答案式结尾
            SlopRule {
                category: "summary_ending".into(),
                regex: Regex::new(r"(?:这就是.*之处|终于还是来了|不管怎么样.*都得|这意味着|也就是说|确实如此|没错[。，])").unwrap(),
                weight: 7.0,
                description: "标准答案式结尾".into(),
            },
            // 2.9 多余时间副词
            SlopRule {
                category: "temporal_adverb".into(),
                regex: Regex::new(r"(?:正在|正准备|刚要|刚准备)").unwrap(),
                weight: 5.0,
                description: "多余时间副词".into(),
            },
            // 2.10 身份重复标签
            SlopRule {
                category: "identity_retag".into(),
                regex: Regex::new(r"(?:作为|身为|作为一名).*的").unwrap(),
                weight: 5.0,
                description: "身份重复标签".into(),
            },
            // 2.11 重复强调缺失 - heuristic
            SlopRule {
                category: "repetition_absence".into(),
                regex: Regex::new(r"").unwrap(), // heuristic
                weight: 4.0,
                description: "重复强调缺失".into(),
            },
            // 2.12 AI指纹词污染
            SlopRule {
                category: "ai_fingerprint".into(),
                regex: Regex::new(r"(?:赋能|抓手|底层逻辑|全方位|凸显|彰显|加持|助力)").unwrap(),
                weight: 9.0,
                description: "AI指纹词污染".into(),
            },
            // 2.13 动词同质化（进行病）
            SlopRule {
                category: "verb_homogenization".into(),
                regex: Regex::new(r"(?:进行|实施|做出|采取|获得提升|产生怀疑|做出选择|进行评估)").unwrap(),
                weight: 6.0,
                description: "动词同质化".into(),
            },
            // 2.14 判定式短句
            SlopRule {
                category: "judgment_shortcut".into(),
                regex: Regex::new(r"(?:不是.*(?:是|而是)|不是.*[。，]是|也就是说|换句话说|这意味着|这说明)").unwrap(),
                weight: 8.0,
                description: "判定式短句和自问自答".into(),
            },
        ]
    }

    /// Apply all rules to text, return weighted score 0-100
    pub fn apply(&self, text: &str) -> SlopReport {
        let mut findings: Vec<SlopFinding> = Vec::new();
        let mut category_breakdown: HashMap<String, f32> = HashMap::new();
        let total_weight: f32 = self.rules.iter().map(|r| r.weight).sum();

        for rule in &self.rules {
            if rule.regex.as_str().is_empty() {
                // Heuristic rules - skip regex, compute differently
                let heuristic_score = self.compute_heuristic(&rule.category, text);
                if heuristic_score > 0.0 {
                    category_breakdown.insert(rule.category.clone(), heuristic_score);
                    findings.push(SlopFinding {
                        category: rule.category.clone(),
                        count: 1, // heuristic flag
                        weight: rule.weight,
                        description: rule.description.clone(),
                        matches: vec!["[heuristic detection]".into()],
                    });
                }
                continue;
            }

            let matches: Vec<&str> = rule.regex.find_iter(text).map(|m| m.as_str()).take(5).collect();
            let count = if matches.is_empty() {
                0
            } else {
                rule.regex.find_iter(text).count()
            };

            if count > 0 {
                let weighted = (count as f32).ln_1p() * rule.weight;
                category_breakdown.insert(rule.category.clone(), weighted);
                findings.push(SlopFinding {
                    category: rule.category.clone(),
                    count,
                    weight: rule.weight,
                    description: rule.description.clone(),
                    matches: matches.iter().map(|s| s.to_string()).collect(),
                });
            }
        }

        let raw_score: f32 = category_breakdown.values().sum();
        // Normalize to 0-100: raw_score / total_weight * scaling_factor
        let score = (raw_score / total_weight * 100.0).min(100.0);

        SlopReport {
            score,
            findings,
            category_breakdown,
        }
    }

    /// Heuristic detection for non-regex rules
    fn compute_heuristic(&self, category: &str, text: &str) -> f32 {
        match category {
            "relentless_progression" => {
                // Check if all paragraphs have similar structure (high uniformity = AI-like)
                let paragraphs: Vec<&str> = text.split("\n\n").filter(|p| !p.trim().is_empty()).collect();
                if paragraphs.len() < 3 {
                    return 0.0;
                }
                let lengths: Vec<usize> = paragraphs.iter().map(|p| p.len()).collect();
                let avg = lengths.iter().sum::<usize>() as f32 / lengths.len() as f32;
                let variance: f32 = lengths.iter().map(|l| (*l as f32 - avg).powi(2)).sum::<f32>()
                    / lengths.len() as f32;
                let std_dev = variance.sqrt();
                let cv = if avg > 0.0 { std_dev / avg } else { 0.0 };
                // Low coefficient of variation = too uniform = AI-like
                if cv < 0.2 {
                    3.0
                } else if cv < 0.3 {
                    1.5
                } else {
                    0.0
                }
            }
            "repetition_absence" => {
                // Check if text lacks any repeated words (human writing has natural repetition)
                let has_repetition = text.contains("沉默。沉默")
                    || text.contains("笑了笑")
                    || text.contains("点点头")
                    || text.contains("看了看");
                if has_repetition {
                    0.0
                } else {
                    2.0
                }
            }
            _ => 0.0,
        }
    }
}

impl Default for SlopScorer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slop_scorer_detects_ai_fingerprint() {
        let scorer = SlopScorer::new();
        let text = "这个系统的底层逻辑是通过赋能用户来实现闭环。";
        let report = scorer.apply(text);
        assert!(report.score > 0.0, "Should detect AI fingerprint words");
        assert!(report.findings.iter().any(|f| f.category == "ai_fingerprint"));
    }

    #[test]
    fn test_slop_scorer_detects_emotion_labeling() {
        let scorer = SlopScorer::new();
        let text = "他感到一阵深深的恐惧。她心里充满了感动。";
        let report = scorer.apply(text);
        assert!(report.findings.iter().any(|f| f.category == "emotion_labeling"));
    }

    #[test]
    fn test_slop_scorer_clean_text_low_score() {
        let scorer = SlopScorer::new();
        let text = "他笑了笑。沉默。沉默。烟从指缝间漏出来，风一吹就散了。";
        let report = scorer.apply(text);
        assert!(
            report.score < 20.0,
            "Clean human prose should score low, got {}",
            report.score
        );
    }

    #[test]
    fn test_slop_scorer_ai_text_high_score() {
        let scorer = SlopScorer::new();
        let text = "值得注意的是，这个系统的底层逻辑是通过赋能用户来实现闭环。然而，由于因此他感到一阵深深的恐惧。他伸手从桌上拿起杯子，送到嘴边喝了一口。换句话说，这意味着一切都在进行迭代。";
        let report = scorer.apply(text);
        assert!(
            report.score > 40.0,
            "Heavy AI slop should score high, got {}",
            report.score
        );
    }

    #[test]
    fn test_guardrails_passes_good_prose() {
        use crate::novel::chapter_guardrails::ChapterGuardrails;
        let guardrails = ChapterGuardrails::new(45.0);
        let text = "他笑了笑。沉默。沉默。烟从指缝间漏出来。";
        let result = guardrails.check(text);
        assert!(result.passed, "Good prose should pass guardrails");
    }

    #[test]
    fn test_guardrails_fails_slop_text() {
        use crate::novel::chapter_guardrails::ChapterGuardrails;
        let guardrails = ChapterGuardrails::new(45.0);
        let text = "值得注意的是，这个系统的底层逻辑是通过赋能用户来实现闭环。然而，由于因此他感到一阵深深的恐惧。他伸手从桌上拿起杯子，送到嘴边喝了一口。换句话说，这意味着一切都在进行迭代。作为社区工作者的他，正准备实施救援。";
        let result = guardrails.check(text);
        assert!(!result.passed, "Slop text should fail guardrails, score was {}", result.score);
    }

    #[test]
    fn test_auto_suggest_generates_suggestions() {
        use crate::novel::chapter_guardrails::ChapterGuardrails;
        let guardrails = ChapterGuardrails::new(0.0); // threshold 0 = everything fails
        let text = "赋能 底层逻辑 他感到一阵恐惧。";
        let result = guardrails.check(text);
        assert!(
            !result.suggestions.is_empty(),
            "Should generate suggestions for failing text"
        );
    }

    #[test]
    fn test_category_breakdown_has_entries() {
        let scorer = SlopScorer::new();
        let text = "赋能 底层逻辑 抓手 因此然而";
        let report = scorer.apply(text);
        assert!(
            !report.category_breakdown.is_empty(),
            "Should have category breakdown entries"
        );
    }
}
