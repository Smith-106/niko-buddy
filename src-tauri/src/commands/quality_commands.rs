use crate::novel::slop_scorer::{SlopScorer, SlopReport};
use crate::novel::chapter_guardrails::{ChapterGuardrails, GuardResult};
use crate::panic_guard::run_guarded_async;

/// Score text for AI slop patterns
#[tauri::command]
pub async fn slop_score(
    _project_path: String,
    text: String,
) -> Result<SlopReport, String> {
    run_guarded_async("slop_score", async move {
        let scorer = SlopScorer::new();
        Ok(scorer.apply(&text))
    })
    .await
}

/// Check text against ChapterGuardrails
#[tauri::command]
pub async fn guardrails_check(
    _project_path: String,
    text: String,
    threshold: Option<f32>,
) -> Result<GuardResult, String> {
    run_guarded_async("guardrails_check", async move {
        let guardrails = ChapterGuardrails::new(threshold.unwrap_or(45.0));
        Ok(guardrails.check(&text))
    })
    .await
}
