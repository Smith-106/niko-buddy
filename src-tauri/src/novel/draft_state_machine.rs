use serde::{Deserialize, Serialize};

/// P13 Draft-first 草稿状态 (Rust mirror of TS DraftStatus enum)
/// serde rename_all = "snake_case" 确保 Rust 枚举序列化为小写，
/// 与 TS 侧 DraftStatus.Ready = "ready" 等小写字符串值对齐
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DraftStatus {
    Pending,
    Ready,
    Accepted,
    Rejected,
    Superseded,
}

impl Default for DraftStatus {
    fn default() -> Self {
        DraftStatus::Pending
    }
}

impl std::fmt::Display for DraftStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DraftStatus::Pending => write!(f, "pending"),
            DraftStatus::Ready => write!(f, "ready"),
            DraftStatus::Accepted => write!(f, "accepted"),
            DraftStatus::Rejected => write!(f, "rejected"),
            DraftStatus::Superseded => write!(f, "superseded"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_draft_status_default_is_pending() {
        assert_eq!(DraftStatus::default(), DraftStatus::Pending);
    }

    #[test]
    fn test_draft_status_display() {
        assert_eq!(DraftStatus::Pending.to_string(), "pending");
        assert_eq!(DraftStatus::Ready.to_string(), "ready");
        assert_eq!(DraftStatus::Accepted.to_string(), "accepted");
        assert_eq!(DraftStatus::Rejected.to_string(), "rejected");
        assert_eq!(DraftStatus::Superseded.to_string(), "superseded");
    }

    #[test]
    fn test_draft_status_serialization() {
        let status = DraftStatus::Ready;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"ready\"", "DraftStatus should serialize as snake_case to match TS enum values");
        let deserialized: DraftStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, DraftStatus::Ready);
        // Verify all variants serialize to lowercase matching TS DraftStatus enum values
        assert_eq!(serde_json::to_string(&DraftStatus::Pending).unwrap(), "\"pending\"");
        assert_eq!(serde_json::to_string(&DraftStatus::Accepted).unwrap(), "\"accepted\"");
        assert_eq!(serde_json::to_string(&DraftStatus::Rejected).unwrap(), "\"rejected\"");
        assert_eq!(serde_json::to_string(&DraftStatus::Superseded).unwrap(), "\"superseded\"");
    }
}
