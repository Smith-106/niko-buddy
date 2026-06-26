use crate::novel::slop_scorer::{SlopScorer, SlopReport};
use crate::novel::chapter_guardrails::{ChapterGuardrails, GuardResult};
use crate::panic_guard::run_guarded_async;
use tauri::State;

/// Score text for AI slop patterns
#[tauri::command]
pub async fn slop_score(
    scorer: State<'_, SlopScorer>,
    text: String,
) -> Result<SlopReport, String> {
    run_guarded_async("slop_score", async move {
        Ok(scorer.apply(&text))
    })
    .await
}

/// Check text against ChapterGuardrails
#[tauri::command]
pub async fn guardrails_check(
    guardrails: State<'_, ChapterGuardrails>,
    text: String,
    threshold: Option<f32>,
) -> Result<GuardResult, String> {
    run_guarded_async("guardrails_check", async move {
        let checker = if let Some(t) = threshold {
            // Custom threshold: create a temporary instance
            ChapterGuardrails::new(t)
        } else {
            // Use the managed (default 45.0) singleton
            (*guardrails).clone()
        };
        Ok(checker.check(&text))
    })
    .await
}
