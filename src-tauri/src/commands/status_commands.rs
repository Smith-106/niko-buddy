// Module: status_commands - Tauri commands for reading/writing A7 status.json

use std::path::PathBuf;

use crate::novel::status_schema::StatusSchema;
use crate::panic_guard::run_guarded_async;

/// Resolve the path to `.novel/status.json` within the project directory.
fn status_json_path(project_path: &str) -> PathBuf {
    let mut path = PathBuf::from(project_path);
    path.push(".novel");
    path.push("status.json");
    path
}

/// Read the current session status from `.novel/status.json`.
///
/// Returns the parsed `StatusSchema`. If the file does not exist, returns
/// an error so the frontend can decide whether to create a new session.
#[tauri::command]
pub async fn status_read(project_path: String) -> Result<StatusSchema, String> {
    run_guarded_async("status_read", async move {
        let path = status_json_path(&project_path);

        if !path.exists() {
            return Err(format!(
                "status.json not found at {}",
                path.display()
            ));
        }

        let content = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| format!("Failed to read status.json: {e}"))?;

        let schema: StatusSchema = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse status.json: {e}"))?;

        Ok(schema)
    })
    .await
}

/// Write a session status to `.novel/status.json`.
///
/// Validates the schema before writing. Creates the `.novel/` directory
/// if it does not exist. The `updated_at` field is automatically set to
/// the current UTC timestamp before persisting.
#[tauri::command]
pub async fn status_write(project_path: String, mut schema: StatusSchema) -> Result<(), String> {
    run_guarded_async("status_write", async move {
        // Validate before any I/O
        schema.validate()?;

        // Auto-update the timestamp
        schema.updated_at = chrono::Utc::now().to_rfc3339();

        let path = status_json_path(&project_path);

        // Ensure .novel/ directory exists
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create .novel directory: {e}"))?;
        }

        let json = serde_json::to_string_pretty(&schema)
            .map_err(|e| format!("Failed to serialize status: {e}"))?;

        tokio::fs::write(&path, json)
            .await
            .map_err(|e| format!("Failed to write status.json: {e}"))?;

        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::novel::status_schema::SessionStatus;

    fn tmp_project() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!("qmai-status-test-{}-{}", ts, id));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[tokio::test]
    async fn write_then_read_roundtrip() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        let schema = StatusSchema::new(
            "novel-20260622-143000".to_string(),
            "test".to_string(),
        );

        status_write(pp.clone(), schema.clone())
            .await
            .unwrap();

        let read_back = status_read(pp).await.unwrap();
        assert_eq!(read_back.schema_version, "1");
        assert_eq!(read_back.session_id, "novel-20260622-143000");
        assert_eq!(read_back.source, "test");
        assert_eq!(read_back.status, SessionStatus::Running);
        assert_eq!(read_back.decision_gates.len(), 3);
    }

    #[tokio::test]
    async fn read_missing_file_returns_error() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        let result = status_read(pp).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[tokio::test]
    async fn write_validates_schema_version() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        let mut bad = StatusSchema::new(
            "novel-20260622-143000".to_string(),
            "test".to_string(),
        );
        bad.schema_version = "99".to_string();

        let result = status_write(pp, bad).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("schema_version"));
    }

    #[tokio::test]
    async fn write_validates_session_id() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        let bad = StatusSchema::new(
            "invalid-id".to_string(),
            "test".to_string(),
        );

        let result = status_write(pp, bad).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("session_id"));
    }

    #[tokio::test]
    async fn write_creates_novel_directory() {
        let p = tmp_project().join("subdir");
        std::fs::create_dir_all(&p).unwrap();
        let pp = p.to_string_lossy().to_string();

        let schema = StatusSchema::new(
            "novel-20260622-143000".to_string(),
            "test".to_string(),
        );

        status_write(pp, schema).await.unwrap();

        assert!(p.join(".novel").exists());
        assert!(p.join(".novel/status.json").exists());
    }
}
