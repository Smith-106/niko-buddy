use crate::novel::intent_router::WriteIntent;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// 根据意图类型 + 上下文构建 prompt (纯函数，无需 AppHandle)
pub fn build_intent_prompt(intent: &WriteIntent, context_pack: &str) -> String {
    let intent_template = match intent {
        WriteIntent::Continue => {
            "你是一个专业的小说续写助手。请根据以下上下文信息，续写下一章节内容。保持人物性格一致，剧情逻辑连贯。\n\n上下文：\n{context}\n\n请续写："
        }
        WriteIntent::Rewrite => {
            "你是一个专业的小说改写助手。请根据以下上下文信息，改写指定内容。保持核心含义不变，提升表达质量。\n\n上下文：\n{context}\n\n请改写："
        }
        WriteIntent::Setting => {
            "你是一个专业的小说设定助手。请根据以下上下文信息，完善或补充世界观设定。保持与已有设定一致。\n\n上下文：\n{context}\n\n请提供设定内容："
        }
        WriteIntent::Dialogue => {
            "你是一个专业的小说对话助手。请根据以下上下文信息，创作符合人物性格的对话内容。对话应自然、有张力。\n\n上下文：\n{context}\n\n请写对话："
        }
        WriteIntent::Scene => {
            "你是一个专业的小说场景描写助手。请根据以下上下文信息，描写场景。运用五感，避免AI式全景扫描。\n\n上下文：\n{context}\n\n请描写场景："
        }
        WriteIntent::Query => {
            "你是一个专业的小说分析助手。请根据以下上下文信息，回答问题。回答应准确、有据。\n\n上下文：\n{context}\n\n请回答："
        }
    };

    intent_template.replace("{context}", context_pack)
}

/// 流式生成 token 事件 payload
#[derive(Debug, Clone, Serialize)]
pub struct TokenChunk {
    pub token: String,
    pub index: u32,
}

/// 生成完成事件 payload
#[derive(Debug, Clone, Serialize)]
pub struct GenerationDone {
    pub total_tokens: u32,
    pub intent: String,
}

/// 指令流式生成器
/// 将意图路由结果 + context 组装为流式生成 prompt
/// 通过 Tauri event 流式输出 token 到前端
pub struct InstructionFlow {
    app_handle: AppHandle,
}

impl InstructionFlow {
    pub fn new(app_handle: AppHandle) -> Self {
        InstructionFlow { app_handle }
    }

    /// 构建意图 prompt (委托给纯函数)
    pub fn build_prompt(&self, intent: &WriteIntent, context_pack: &str) -> String {
        build_intent_prompt(intent, context_pack)
    }

    /// 流式生成：将 prompt 发送到 LLM 并通过 Tauri event 逐 token 输出
    ///
    /// STUB 实现: 使用 mock 输出模拟流式生成
    /// 实际实现需要接入 LLM provider API
    pub async fn stream_generate(&self, prompt: &str, intent: &WriteIntent) -> Result<GenerationDone, String> {
        let intent_str = match intent {
            WriteIntent::Continue => "Continue",
            WriteIntent::Rewrite => "Rewrite",
            WriteIntent::Setting => "Setting",
            WriteIntent::Dialogue => "Dialogue",
            WriteIntent::Scene => "Scene",
            WriteIntent::Query => "Query",
        };

        // Mock: 逐 token 发送 prompt 前 100 字符
        // 实际实现: 调用 LLM API，逐 token 接收并 emit
        let mock_tokens: Vec<String> = prompt
            .chars()
            .take(100)
            .collect::<Vec<char>>()
            .chunks(2)
            .map(|chunk| chunk.iter().collect())
            .collect();

        let mut total_tokens = 0u32;
        for (idx, token) in mock_tokens.iter().enumerate() {
            self.app_handle
                .emit("generation-token", TokenChunk {
                    token: token.clone(),
                    index: idx as u32,
                })
                .map_err(|e| format!("Failed to emit token: {}", e))?;
            total_tokens += 1;
        }

        let done = GenerationDone {
            total_tokens,
            intent: intent_str.to_string(),
        };
        self.app_handle
            .emit("generation-done", &done)
            .map_err(|e| format!("Failed to emit done: {}", e))?;

        Ok(done)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_intent_prompt_continue() {
        let prompt = build_intent_prompt(&WriteIntent::Continue, "这是上下文内容");
        assert!(prompt.contains("续写"), "Continue prompt should contain 续写");
        assert!(prompt.contains("这是上下文内容"), "Prompt should contain context");
    }

    #[test]
    fn test_build_intent_prompt_rewrite() {
        let prompt = build_intent_prompt(&WriteIntent::Rewrite, "改写上下文");
        assert!(prompt.contains("改写"), "Rewrite prompt should contain 改写");
    }

    #[test]
    fn test_build_intent_prompt_dialogue() {
        let prompt = build_intent_prompt(&WriteIntent::Dialogue, "对话上下文");
        assert!(prompt.contains("对话"), "Dialogue prompt should contain 对话");
    }

    #[test]
    fn test_all_intents_include_context() {
        let context = "角色A在宫殿中遇到了角色B";
        for intent in [
            WriteIntent::Continue,
            WriteIntent::Rewrite,
            WriteIntent::Setting,
            WriteIntent::Dialogue,
            WriteIntent::Scene,
            WriteIntent::Query,
        ] {
            let prompt = build_intent_prompt(&intent, context);
            assert!(prompt.contains(context), "All prompt templates should include context pack");
        }
    }
}
