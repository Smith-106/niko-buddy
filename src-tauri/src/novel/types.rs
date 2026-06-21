// Module: types - Shared types for novel module (Wave 2-4)

use serde::{Deserialize, Serialize};

/// A single finding from a mechanical or semantic check.
/// Shared by status_schema, slop_scorer, consistency_gate, etc.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Finding {
    pub severity: String,
    pub description: String,
    pub location: Option<String>,
    pub suggestion: Option<String>,
}
