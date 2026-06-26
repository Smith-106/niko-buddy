use crate::novel::decision_gate::{DecisionGateOrchestrator, GateSummary};
use crate::panic_guard::run_guarded_async;
use tauri::{AppHandle, State};

/// Run all decision gates on text.
/// `app_handle` is threaded through to `InstructionFlow` for fix-loop
/// regeneration (ISS-022).
#[tauri::command]
pub async fn run_decision_gates(
    orchestrator: State<'_, DecisionGateOrchestrator>,
    app_handle: AppHandle,
    project_path: String,
    text: String,
) -> Result<GateSummary, String> {
    run_guarded_async("run_decision_gates", async move {
        Ok(orchestrator.run_gates(&text, &project_path, &app_handle).await)
    })
    .await
}
