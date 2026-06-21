use crate::novel::decision_gate::{DecisionGateOrchestrator, GateSummary};
use crate::panic_guard::run_guarded_async;

/// Run all decision gates on text
#[tauri::command]
pub async fn run_decision_gates(
    project_path: String,
    text: String,
) -> Result<GateSummary, String> {
    run_guarded_async("run_decision_gates", async move {
        let orchestrator = DecisionGateOrchestrator::new();
        Ok(orchestrator.run_gates(&text, &project_path))
    })
    .await
}
