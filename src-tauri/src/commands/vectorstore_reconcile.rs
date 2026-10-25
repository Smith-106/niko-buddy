// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! vectorstore startup-reconcile 纯支撑层——M2-2 自 `vectorstore.rs` 增量剥离（S4 单轮收敛，file_sync_watch 模式）。
//!
//! 收容：reconcile 纯决策（[`ExpectedChunk`] / [`ActualChunk`] / [`ReconcilePlan`] /
//! [`reconcile_chunks`]，零 IO、可单测）与 pending 队列（[`ExpectedChunkInput`] /
//! [`ReconcileReport`] / [`ReconcilePendingEntry`] / digest 幂等入队，`std::fs` 直写）。
//! `vectorstore.rs` 经 `pub` / `pub(crate) use` 回引，外部 import 面零变化
//! （外部引用留守原文件：8 个 Tauri 命令、`run_startup_reconcile`、`scan_actual_chunks` 等 IO 执行层）。

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::vectorstore::ChunkUpsertInput;

/// Identity of one expected chunk.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ExpectedChunk {
    pub page_id: String,
    pub chunk_index: u32,
}

/// Identity of one chunk currently present in the table.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ActualChunk {
    pub page_id: String,
    pub chunk_index: u32,
}

/// Reconciliation plan (pure output; nothing is executed here).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReconcilePlan {
    /// Chunk refs expected in the table but missing → these pages should be
    /// upserted (grouped by page_id before execution).
    pub to_upsert: Vec<ExpectedChunk>,
    /// Pages present in the table but with no matching expected chunk set →
    /// the whole page should be deleted.
    pub to_delete_pages: Vec<String>,
    /// Pages in the expected inventory whose actual content differs from the
    /// expected set (missing chunks, extra stale chunks, or page absent) →
    /// the caller must re-provision the page's full expected set.
    pub to_reupsert_pages: Vec<String>,
    /// Pages that match between expected and actual → no action.
    pub unchanged_pages: Vec<String>,
}

/// Pure reconciliation: expected chunk set vs actual table contents.
///
/// Returns a plan describing what to UPSERT and what to DELETE. It performs
/// no IO and never executes the plan — it only returns the decision, so it
/// is trivially unit-testable.
///
/// Semantics:
///   - Any expected chunk with no matching (page_id, chunk_index) row in the
///     actual set lands in `to_upsert` (its page is under-provisioned).
///   - Any page that appears in the actual table but has no expected chunk at
///     all lands in `to_delete_pages` (it is stale / no longer in the source
///     of truth).
///   - A page whose expected chunk set matches the actual chunk set exactly
///     lands in `unchanged_pages`.
pub fn reconcile_chunks(expected: &[ExpectedChunk], actual: &[ActualChunk]) -> ReconcilePlan {
    let mut plan = ReconcilePlan::default();

    // Indexes of actual chunks by page, plus the full page set seen in actual.
    let actual_by_page: std::collections::HashMap<&str, HashSet<u32>> = {
        let mut m: std::collections::HashMap<&str, HashSet<u32>> = std::collections::HashMap::new();
        for a in actual {
            m.entry(a.page_id.as_str())
                .or_default()
                .insert(a.chunk_index);
        }
        m
    };

    // Group expected chunks by page.
    let mut expected_by_page: std::collections::HashMap<&str, HashSet<u32>> =
        std::collections::HashMap::new();
    for e in expected {
        expected_by_page
            .entry(e.page_id.as_str())
            .or_default()
            .insert(e.chunk_index);
    }

    // Page union (dedupe page ids).
    let mut page_ids: Vec<&str> = expected_by_page
        .keys()
        .chain(actual_by_page.keys())
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    page_ids.sort_unstable();

    for page_id in page_ids {
        let expected_idx = expected_by_page.get(page_id).cloned().unwrap_or_default();
        let actual_idx = actual_by_page.get(page_id).cloned().unwrap_or_default();

        if expected_idx.is_empty() && !actual_idx.is_empty() {
            // Present in table, but nothing expected → delete the page.
            plan.to_delete_pages.push(page_id.to_string());
            continue;
        }
        if expected_idx == actual_idx {
            plan.unchanged_pages.push(page_id.to_string());
            continue;
        }
        // Mismatch (missing and/or extra chunks) → re-provision the page's full
        // expected set. We also emit the individually-missing chunk refs so
        // the caller can add just what's missing when useful.
        plan.to_reupsert_pages.push(page_id.to_string());
        let mut missing: Vec<u32> = expected_idx.difference(&actual_idx).cloned().collect();
        missing.sort_unstable();
        for idx in missing {
            plan.to_upsert.push(ExpectedChunk {
                page_id: page_id.to_string(),
                chunk_index: idx,
            });
        }
    }

    plan
}

/// Full expected chunk payload for the startup reconcile executor. The pure
/// `reconcile_chunks` decides on identities; `run_startup_reconcile` needs
/// the payload (text / heading / embedding) to re-provision pages.
#[derive(Debug, Clone, Deserialize)]
pub struct ExpectedChunkInput {
    pub page_id: String,
    pub chunk_index: u32,
    pub chunk_text: String,
    pub heading_path: String,
    pub embedding: Vec<f32>,
}

pub(crate) fn chunk_input_to_upsert(c: &ExpectedChunkInput) -> ChunkUpsertInput {
    ChunkUpsertInput {
        chunk_index: c.chunk_index,
        chunk_text: c.chunk_text.clone(),
        heading_path: c.heading_path.clone(),
        embedding: c.embedding.clone(),
    }
}

/// Result of one `run_startup_reconcile` execution. Serialized back to the
/// frontend so the rebuild command's tail call can surface the outcome.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ReconcileReport {
    /// Pages re-provisioned atomically (grouped by page_id: delete + add of
    /// the full expected set in one page-scoped transaction).
    pub upserted_pages: Vec<String>,
    /// Stale pages deleted (present in the table, absent from the expected
    /// inventory).
    pub deleted_pages: Vec<String>,
    /// Pages whose expected set already matched the table (no action).
    pub unchanged_pages: Vec<String>,
    /// Pages whose re-provision / delete failed (still drifted; their
    /// reconcile-pending entries are retained for the next run).
    pub failed_pages: Vec<String>,
    /// Pages still diverged after execution (final re-scan).
    pub drifted: usize,
    /// reconcile-pending.jsonl entries consumed by this run (pages now
    /// consistent with the expected inventory).
    pub pending_consumed: usize,
    /// True when no expected inventory was supplied → safe no-op (nothing
    /// was read, written or deleted). Background startup passes rely on this.
    pub skipped: bool,
}

/// Relative path (project-rooted) of the durable pending queue.
const RECONCILE_PENDING_REL_PATH: &str = ".novel/vector-index/reconcile-pending.jsonl";

/// One durable pending entry: a page whose last upsert failed mid-flight
/// (delete succeeded, add failed) and therefore still needs re-provisioning.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReconcilePendingEntry {
    pub page_id: String,
    /// sha256 (hex) over the page's chunk descriptors (index/text/heading);
    /// used to keep the queue idempotent — the same (page_id, digest) is
    /// never enqueued twice.
    pub digest: String,
    /// ISO-8601 UTC timestamp of the failed write (diagnostics only).
    pub ts: String,
}

fn reconcile_pending_path(project_path: &str) -> String {
    let p = project_path.replace('\\', "/");
    format!("{}/{}", p.trim_end_matches('/'), RECONCILE_PENDING_REL_PATH)
}

fn to_hex(bytes: impl AsRef<[u8]>) -> String {
    use std::fmt::Write as _;
    let bytes = bytes.as_ref();
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Content digest of one page's chunk set. Excludes embeddings — they are
/// derived from the text, so the digest identity stays stable across
/// re-embedding (KbGap / OpenKB atomic-write discipline, vector-layer
/// equivalent).
pub(crate) fn chunk_set_digest(page_id: &str, chunks: &[ChunkUpsertInput]) -> String {
    use sha2::{Digest, Sha256};

    let mut hasher = Sha256::new();
    hasher.update(page_id.as_bytes());
    hasher.update(b"\n");
    let mut sorted: Vec<&ChunkUpsertInput> = chunks.iter().collect();
    sorted.sort_by_key(|c| c.chunk_index);
    for c in sorted {
        hasher.update(c.chunk_index.to_string().as_bytes());
        hasher.update(b"\t");
        hasher.update(c.chunk_text.as_bytes());
        hasher.update(b"\t");
        hasher.update(c.heading_path.as_bytes());
        hasher.update(b"\n");
    }
    to_hex(hasher.finalize())
}

/// Read the pending queue. Malformed / stale lines are skipped (the queue
/// must never block or poison the reconcile).
pub(crate) fn read_reconcile_pending(project_path: &str) -> Vec<ReconcilePendingEntry> {
    let path = reconcile_pending_path(project_path);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|l| serde_json::from_str::<ReconcilePendingEntry>(l).ok())
        .collect()
}

/// Rewrite the pending queue; an empty queue removes the file (absence
/// signals "nothing pending").
pub(crate) fn write_reconcile_pending(
    project_path: &str,
    entries: &[ReconcilePendingEntry],
) -> Result<(), String> {
    let path = reconcile_pending_path(project_path);
    if entries.is_empty() {
        match std::fs::remove_file(&path) {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("remove pending file: {e}")),
        }
    } else {
        if let Some(dir) = std::path::Path::new(&path).parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("create pending dir: {e}"))?;
        }
        let mut text = String::new();
        for e in entries {
            text.push_str(
                &serde_json::to_string(e).map_err(|e| format!("serialize pending: {e}"))?,
            );
            text.push('\n');
        }
        std::fs::write(&path, text).map_err(|e| format!("write pending file: {e}"))?;
        Ok(())
    }
}

/// Best-effort append of a pending entry. Idempotent by (page_id, digest): an
/// entry with the same identity already on the queue is not duplicated. Never
/// fails the caller — the original write error stays the only error surfaced.
pub(crate) fn append_reconcile_pending(project_path: &str, page_id: &str, digest: &str) {
    let result = (|| -> Result<(), String> {
        let mut entries = read_reconcile_pending(project_path);
        if entries
            .iter()
            .any(|e| e.page_id == page_id && e.digest == digest)
        {
            return Ok(()); // digest 幂等：同一 (page_id, digest) 不重复入队
        }
        entries.push(ReconcilePendingEntry {
            page_id: page_id.to_string(),
            digest: digest.to_string(),
            ts: chrono::Utc::now().to_rfc3339(),
        });
        write_reconcile_pending(project_path, &entries)
    })();
    if let Err(e) = result {
        // Best-effort queueing: a queue hiccup must never mask the original
        // upsert error or fail the host write path.
        #[cfg(debug_assertions)]
        eprintln!("[vectorstore] reconcile-pending append failed (non-fatal): {e}");
        #[cfg(not(debug_assertions))]
        let _ = e;
    }
}
