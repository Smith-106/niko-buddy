use crate::novel::consistency_gate::{ConsistencyGate, ConsistencyDimension, GateResult};
use crate::panic_guard::run_guarded_async;

/// Check text for consistency in a specific dimension
#[tauri::command]
pub async fn consistency_check(
    project_path: String,
    text: String,
    dimension: String,
) -> Result<GateResult, String> {
    run_guarded_async("consistency_check", async move {
        let gate = ConsistencyGate::new();
        let dim = match dimension.as_str() {
            "role_cognition" => ConsistencyDimension::RoleCognition,
            "setting" => ConsistencyDimension::Setting,
            "causal" => ConsistencyDimension::Causal,
            "foreshadowing" => ConsistencyDimension::Foreshadowing,
            "timeline" => ConsistencyDimension::Timeline,
            _ => return Err(format!("Unknown consistency dimension: {}", dimension)),
        };
        Ok(gate.check(&text, &dim, &project_path))
    })
    .await
}

/// Check all P0 consistency dimensions
#[tauri::command]
pub async fn consistency_check_p0(
    project_path: String,
    text: String,
) -> Result<Vec<GateResult>, String> {
    run_guarded_async("consistency_check_p0", async move {
        let gate = ConsistencyGate::new();
        Ok(gate.check_p0(&text, &project_path))
    })
    .await
}
