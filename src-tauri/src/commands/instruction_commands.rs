use crate::novel::intent_router::{IntentRouter, IntentResult, WriteIntent};
use crate::novel::instruction_flow::{InstructionFlow, GenerationDone};
use crate::panic_guard::run_guarded_async;
use tauri::AppHandle;

/// 分类用户输入的写作意图
#[tauri::command]
pub async fn classify_intent(
    input: String,
) -> Result<IntentResult, String> {
    run_guarded_async("classify_intent", async move {
        let router = IntentRouter::new();
        Ok(router.classify(&input))
    })
    .await
}

/// 流式生成（需要 AppHandle 来 emit events）
#[tauri::command]
pub async fn stream_generate(
    app_handle: AppHandle,
    intent: String,
    context_pack: String,
) -> Result<GenerationDone, String> {
    run_guarded_async("stream_generate", async move {
        let write_intent = match intent.as_str() {
            "Continue" | "continue" => WriteIntent::Continue,
            "Rewrite" | "rewrite" => WriteIntent::Rewrite,
            "Setting" | "setting" => WriteIntent::Setting,
            "Dialogue" | "dialogue" => WriteIntent::Dialogue,
            "Scene" | "scene" => WriteIntent::Scene,
            "Query" | "query" => WriteIntent::Query,
            _ => return Err(format!("Unknown intent: {}", intent)),
        };
        let flow = InstructionFlow::new(app_handle);
        let prompt = flow.build_prompt(&write_intent, &context_pack);
        flow.stream_generate(&prompt, &write_intent).await
    })
    .await
}
