use serde::Serialize;
use std::collections::HashMap;

/// 用户写作意图类型
#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum WriteIntent {
    Continue,    // 续写/继续
    Rewrite,     // 改写/重写
    Setting,     // 设定/世界观
    Dialogue,    // 对话
    Scene,       // 场景描写
    Query,       // 查询/解释
}

/// 意图分类结果
#[derive(Debug, Clone, Serialize)]
pub struct IntentResult {
    pub intent: WriteIntent,
    pub confidence: f32,
    pub suggested_params: HashMap<String, String>,
}

/// 关键词-意图匹配规则
struct IntentRule {
    keywords: Vec<&'static str>,
    intent: WriteIntent,
    confidence: f32,
    default_params: HashMap<String, String>,
}

/// 意图路由器（关键词匹配，零 LLM 调用）
pub struct IntentRouter {
    rules: Vec<IntentRule>,
}

impl IntentRouter {
    pub fn new() -> Self {
        let rules = vec![
            IntentRule {
                keywords: vec!["续写", "继续", "接着写", "接着", "往下写", "next", "continue"],
                intent: WriteIntent::Continue,
                confidence: 0.85,
                default_params: HashMap::from([
                    ("mode".into(), "continue".into()),
                ]),
            },
            IntentRule {
                keywords: vec!["改写", "重写", "修改", "润色", "rewrite", "revise", "polish"],
                intent: WriteIntent::Rewrite,
                confidence: 0.80,
                default_params: HashMap::from([
                    ("mode".into(), "rewrite".into()),
                ]),
            },
            IntentRule {
                keywords: vec!["设定", "世界观", "背景", "规则", "setting", "world", "config"],
                intent: WriteIntent::Setting,
                confidence: 0.80,
                default_params: HashMap::from([
                    ("mode".into(), "setting".into()),
                ]),
            },
            IntentRule {
                keywords: vec!["对话", "说话", "聊天", "谈话", "dialogue", "conversation", "talk"],
                intent: WriteIntent::Dialogue,
                confidence: 0.75,
                default_params: HashMap::from([
                    ("mode".into(), "dialogue".into()),
                ]),
            },
            IntentRule {
                keywords: vec!["场景", "描写", "描绘", "环境", "scene", "describe"],
                intent: WriteIntent::Scene,
                confidence: 0.75,
                default_params: HashMap::from([
                    ("mode".into(), "scene".into()),
                ]),
            },
            IntentRule {
                keywords: vec!["为什么", "查询", "解释", "原因", "怎么", "how", "why", "explain"],
                intent: WriteIntent::Query,
                confidence: 0.70,
                default_params: HashMap::from([
                    ("mode".into(), "query".into()),
                ]),
            },
        ];
        IntentRouter { rules }
    }

    /// 分类用户输入的写作意图
    /// 使用最长关键词匹配 + 多关键词加分策略
    pub fn classify(&self, input: &str) -> IntentResult {
        let input_lower = input.to_lowercase();
        let mut best_intent: Option<WriteIntent> = None;
        let mut best_confidence: f32 = 0.0;
        let mut best_params: HashMap<String, String> = HashMap::new();

        for rule in &self.rules {
            let mut match_count = 0;
            let mut longest_match_len = 0;
            for kw in &rule.keywords {
                if input_lower.contains(kw) {
                    match_count += 1;
                    longest_match_len = longest_match_len.max(kw.len());
                }
            }
            if match_count == 0 {
                continue;
            }
            // 加分: 多个关键词命中 + 长关键词命中
            let boost = (match_count - 1) as f32 * 0.05 + longest_match_len as f32 * 0.01;
            let adjusted_confidence = (rule.confidence + boost).min(1.0);

            if adjusted_confidence > best_confidence {
                best_confidence = adjusted_confidence;
                best_intent = Some(rule.intent.clone());
                best_params = rule.default_params.clone();
            }
        }

        match best_intent {
            Some(intent) => IntentResult {
                intent,
                confidence: best_confidence,
                suggested_params: best_params,
            },
            None => IntentResult {
                intent: WriteIntent::Continue,
                confidence: 0.3,
                suggested_params: HashMap::from([
                    ("mode".into(), "continue".into()),
                ]),
            },
        }
    }
}

impl Default for IntentRouter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_continue() {
        let router = IntentRouter::new();
        let result = router.classify("续写下一章");
        assert_eq!(result.intent, WriteIntent::Continue);
        assert!(result.confidence > 0.8, "confidence should be > 0.8, got {}", result.confidence);
    }

    #[test]
    fn test_classify_rewrite() {
        let router = IntentRouter::new();
        let result = router.classify("改写这段话");
        assert_eq!(result.intent, WriteIntent::Rewrite);
        assert!(result.confidence > 0.7);
    }

    #[test]
    fn test_classify_setting() {
        let router = IntentRouter::new();
        let result = router.classify("查看角色设定");
        assert_eq!(result.intent, WriteIntent::Setting);
    }

    #[test]
    fn test_classify_dialogue() {
        let router = IntentRouter::new();
        let result = router.classify("写一段对话");
        assert_eq!(result.intent, WriteIntent::Dialogue);
    }

    #[test]
    fn test_classify_scene() {
        let router = IntentRouter::new();
        let result = router.classify("描写场景");
        assert_eq!(result.intent, WriteIntent::Scene);
    }

    #[test]
    fn test_classify_query() {
        let router = IntentRouter::new();
        let result = router.classify("这个角色为什么要这样做");
        assert_eq!(result.intent, WriteIntent::Query);
    }

    #[test]
    fn test_classify_unknown_defaults_to_continue() {
        let router = IntentRouter::new();
        let result = router.classify("随便写点东西吧");
        assert_eq!(result.intent, WriteIntent::Continue);
        assert!(result.confidence < 0.5, "unknown input should have low confidence");
    }

    #[test]
    fn test_multiple_keyword_boost() {
        let router = IntentRouter::new();
        let result = router.classify("续写接着写继续");
        assert_eq!(result.intent, WriteIntent::Continue);
        assert!(result.confidence > 0.9, "multiple keyword hits should boost confidence");
    }
}
