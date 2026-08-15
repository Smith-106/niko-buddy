use arrow_array::{
    ArrayRef, FixedSizeListArray, Float32Array, RecordBatch, StringArray, UInt32Array,
};
use arrow_schema::{DataType, Field, Schema};
use lancedb::connect;
use lancedb::query::{ExecutableQuery, QueryBase};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::panic_guard::run_guarded_async;

/// v1 per-page result (legacy — kept so pre-0.3.11 projects still load).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VectorSearchResult {
    pub page_id: String,
    pub score: f32,
}

/// v2 per-chunk result. Surfaces the matching chunk's text + heading path
/// so the chat UI can show "matched in this section" and aggregators on
/// the TS side can group by page_id.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChunkSearchResult {
    pub chunk_id: String,
    pub page_id: String,
    pub chunk_index: u32,
    pub chunk_text: String,
    pub heading_path: String,
    pub score: f32,
}

/// Input row for `vector_upsert_chunks`. TypeScript side owns the
/// chunk_index / chunk_text / heading_path; the Rust side is purely
/// storage. `chunk_id` is always derived as `${page_id}#${chunk_index}`
/// so we don't trust a client-supplied id.
#[derive(Debug, Deserialize)]
pub struct ChunkUpsertInput {
    pub chunk_index: u32,
    pub chunk_text: String,
    pub heading_path: String,
    pub embedding: Vec<f32>,
}

fn db_path(project_path: &str) -> String {
    format!("{}/.qmai/lancedb", project_path.replace('\\', "/"))
}

/// v1 (legacy) table name. One row per page.
const TABLE_V1: &str = "wiki_vectors";
/// v2 (current) table name. One row per CHUNK — a page is typically
/// represented by multiple rows sharing the same `page_id`.
const TABLE_V2: &str = "wiki_chunks_v2";

/// Validate page_id to prevent filter injection
fn validate_page_id(page_id: &str) -> Result<(), String> {
    if page_id.is_empty() || page_id.len() > 256 {
        return Err("Invalid page_id: empty or too long".to_string());
    }
    // Only allow alphanumeric, hyphens, underscores, dots
    if !page_id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(format!(
            "Invalid page_id: contains disallowed characters: {}",
            page_id
        ));
    }
    Ok(())
}

fn make_schema(dim: i32) -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("page_id", DataType::Utf8, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), dim),
            false,
        ),
    ]))
}

fn make_batch(
    schema: Arc<Schema>,
    page_id: &str,
    embedding: Vec<f32>,
    dim: i32,
) -> Result<RecordBatch, String> {
    let ids: ArrayRef = Arc::new(StringArray::from(vec![page_id]));
    let values = Float32Array::from(embedding);
    let vector: ArrayRef = Arc::new(FixedSizeListArray::new(
        Arc::new(Field::new("item", DataType::Float32, true)),
        dim,
        Arc::new(values),
        None,
    ));
    RecordBatch::try_new(schema, vec![ids, vector]).map_err(|e| format!("Batch error: {e}"))
}

/// Upsert a page embedding into LanceDB
pub async fn do_vector_upsert(
    project_path: String,
    page_id: String,
    embedding: Vec<f32>,
) -> Result<(), String> {
    validate_page_id(&page_id)?;

    let db = connect(&db_path(&project_path))
        .execute()
        .await
        .map_err(|e| format!("DB connect error: {e}"))?;

    let dim = embedding.len() as i32;
    let schema = make_schema(dim);
    let batch = make_batch(schema.clone(), &page_id, embedding, dim)?;
    let data = vec![batch];

    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if tables.contains(&TABLE_V1.to_string()) {
        let table = db
            .open_table(TABLE_V1)
            .execute()
            .await
            .map_err(|e| format!("Open table error: {e}"))?;

        // Delete existing entry then add new one
        if let Err(e) = table.delete(&format!("page_id = '{}'", page_id)).await {
            eprintln!(
                "[vectorstore] Warning: delete before upsert failed for '{}': {}",
                page_id, e
            );
        }

        table
            .add(data)
            .execute()
            .await
            .map_err(|e| format!("Add error: {e}"))?;
    } else {
        db.create_table(TABLE_V1, data)
            .execute()
            .await
            .map_err(|e| format!("Create table error: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn vector_upsert(
    project_path: String,
    page_id: String,
    embedding: Vec<f32>,
) -> Result<(), String> {
    run_guarded_async(
        "vector_upsert",
        do_vector_upsert(project_path, page_id, embedding),
    )
    .await
}

/// Search for similar pages by embedding vector
pub async fn do_vector_search(
    project_path: String,
    query_embedding: Vec<f32>,
    top_k: usize,
) -> Result<Vec<VectorSearchResult>, String> {
    let db = connect(&db_path(&project_path))
        .execute()
        .await
        .map_err(|e| format!("DB connect error: {e}"))?;

    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if !tables.contains(&TABLE_V1.to_string()) {
        return Ok(vec![]);
    }

    let table = db
        .open_table(TABLE_V1)
        .execute()
        .await
        .map_err(|e| format!("Open table error: {e}"))?;

    let results_stream = table
        .vector_search(query_embedding)
        .map_err(|e| format!("Search error: {e}"))?
        .limit(top_k)
        .execute()
        .await
        .map_err(|e| format!("Execute search error: {e}"))?;

    let mut search_results = Vec::new();

    use futures::TryStreamExt;
    let batches: Vec<RecordBatch> = results_stream
        .try_collect()
        .await
        .map_err(|e| format!("Collect error: {e}"))?;

    for batch in &batches {
        let ids = batch
            .column_by_name("page_id")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            .ok_or("Missing page_id column")?;

        let distances = batch
            .column_by_name("_distance")
            .and_then(|c| c.as_any().downcast_ref::<Float32Array>())
            .ok_or("Missing _distance column")?;

        for i in 0..batch.num_rows() {
            let page_id = ids.value(i).to_string();
            let distance = distances.value(i);
            let score = 1.0 / (1.0 + distance);
            search_results.push(VectorSearchResult { page_id, score });
        }
    }

    Ok(search_results)
}

#[tauri::command]
pub async fn vector_search(
    project_path: String,
    query_embedding: Vec<f32>,
    top_k: usize,
) -> Result<Vec<VectorSearchResult>, String> {
    run_guarded_async(
        "vector_search",
        do_vector_search(project_path, query_embedding, top_k),
    )
    .await
}

/// Delete a page from the vector index
pub async fn do_vector_delete(project_path: String, page_id: String) -> Result<(), String> {
    validate_page_id(&page_id)?;

    let db = connect(&db_path(&project_path))
        .execute()
        .await
        .map_err(|e| format!("DB connect error: {e}"))?;

    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if !tables.contains(&TABLE_V1.to_string()) {
        return Ok(());
    }

    let table = db
        .open_table(TABLE_V1)
        .execute()
        .await
        .map_err(|e| format!("Open table error: {e}"))?;

    table
        .delete(&format!("page_id = '{}'", page_id))
        .await
        .map_err(|e| format!("Delete error: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn vector_delete(project_path: String, page_id: String) -> Result<(), String> {
    run_guarded_async("vector_delete", do_vector_delete(project_path, page_id)).await
}

/// Get count of indexed vectors
pub async fn do_vector_count(project_path: String) -> Result<usize, String> {
    let db = connect(&db_path(&project_path))
        .execute()
        .await
        .map_err(|e| format!("DB connect error: {e}"))?;

    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if !tables.contains(&TABLE_V1.to_string()) {
        return Ok(0);
    }

    let table = db
        .open_table(TABLE_V1)
        .execute()
        .await
        .map_err(|e| format!("Open table error: {e}"))?;

    let count = table
        .count_rows(None)
        .await
        .map_err(|e| format!("Count error: {e}"))?;

    Ok(count)
}

#[tauri::command]
pub async fn vector_count(project_path: String) -> Result<usize, String> {
    run_guarded_async("vector_count", do_vector_count(project_path)).await
}

// ──────────────────────────────────────────────────────────────────────────
// v2 chunk-level vector store
//
// Each row is one CHUNK of a wiki page. Multiple rows per page are the
// common case. The v2 schema:
//
//   chunk_id      Utf8       "${page_id}#${chunk_index}"   (debug-only; we
//                                                          never filter on
//                                                          this — all
//                                                          mutations scope
//                                                          by page_id)
//   page_id       Utf8       which page this chunk belongs to
//   chunk_index   UInt32     0-based position within the page
//   chunk_text    Utf8       raw chunk content (for UI re-ranking + showing
//                            "matched in this section")
//   heading_path  Utf8       breadcrumb ("## A > ### B") — empty string when
//                            the chunk lives above any heading
//   vector        FixedSizeList<Float32, dim>
//
// Upsert semantics: we DELETE every row with the target page_id and then
// ADD all the new chunks in one batch. Chunk indexes may shift when a
// page is re-ingested (content shrinks / grows / re-splits), so we never
// try to match-and-update by chunk_id — the clean-slate replace is both
// simpler and always correct.
//
// Search returns top-K CHUNKS. The TS layer aggregates to per-page scores
// (max + weighted tail) for the existing page-oriented retrieval API,
// plus exposes the chunk metadata for a future "matched in X section" UI.
// ──────────────────────────────────────────────────────────────────────────

fn validate_page_id_for_v2(page_id: &str) -> Result<(), String> {
    if page_id.is_empty() || page_id.len() > 256 {
        return Err("Invalid page_id: empty or too long".to_string());
    }
    if !page_id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(format!(
            "Invalid page_id: contains disallowed characters: {}",
            page_id
        ));
    }
    Ok(())
}

fn make_schema_v2(dim: i32) -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("chunk_id", DataType::Utf8, false),
        Field::new("page_id", DataType::Utf8, false),
        Field::new("chunk_index", DataType::UInt32, false),
        Field::new("chunk_text", DataType::Utf8, false),
        Field::new("heading_path", DataType::Utf8, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), dim),
            false,
        ),
    ]))
}

fn make_batch_v2(
    schema: Arc<Schema>,
    page_id: &str,
    chunks: &[ChunkUpsertInput],
    dim: i32,
) -> Result<RecordBatch, String> {
    let mut chunk_ids: Vec<String> = Vec::with_capacity(chunks.len());
    let mut page_ids: Vec<String> = Vec::with_capacity(chunks.len());
    let mut indexes: Vec<u32> = Vec::with_capacity(chunks.len());
    let mut texts: Vec<String> = Vec::with_capacity(chunks.len());
    let mut heading_paths: Vec<String> = Vec::with_capacity(chunks.len());
    let mut flat_vectors: Vec<f32> = Vec::with_capacity(chunks.len() * dim as usize);

    for c in chunks {
        if c.embedding.len() as i32 != dim {
            return Err(format!(
                "Chunk #{} has embedding dim {} but batch dim is {}",
                c.chunk_index,
                c.embedding.len(),
                dim
            ));
        }
        chunk_ids.push(format!("{}#{}", page_id, c.chunk_index));
        page_ids.push(page_id.to_string());
        indexes.push(c.chunk_index);
        texts.push(c.chunk_text.clone());
        heading_paths.push(c.heading_path.clone());
        flat_vectors.extend_from_slice(&c.embedding);
    }

    let chunk_ids_arr: ArrayRef = Arc::new(StringArray::from(chunk_ids));
    let page_ids_arr: ArrayRef = Arc::new(StringArray::from(page_ids));
    let indexes_arr: ArrayRef = Arc::new(UInt32Array::from(indexes));
    let texts_arr: ArrayRef = Arc::new(StringArray::from(texts));
    let heading_paths_arr: ArrayRef = Arc::new(StringArray::from(heading_paths));

    let values = Float32Array::from(flat_vectors);
    let vector_arr: ArrayRef = Arc::new(FixedSizeListArray::new(
        Arc::new(Field::new("item", DataType::Float32, true)),
        dim,
        Arc::new(values),
        None,
    ));

    RecordBatch::try_new(
        schema,
        vec![
            chunk_ids_arr,
            page_ids_arr,
            indexes_arr,
            texts_arr,
            heading_paths_arr,
            vector_arr,
        ],
    )
    .map_err(|e| format!("Batch error: {e}"))
}

/// Upsert a batch of chunks for a single page. Existing chunks for this
/// page are deleted first so the on-disk state reflects the latest split.
/// An empty `chunks` argument is a no-op — it does NOT clear the page's
/// existing index (for that, call `vector_delete_page` explicitly), so
/// transient ingest failures don't nuke previously-good embeddings.
pub async fn do_vector_upsert_chunks(
    project_path: String,
    page_id: String,
    chunks: Vec<ChunkUpsertInput>,
) -> Result<(), String> {
    validate_page_id_for_v2(&page_id)?;

    if chunks.is_empty() {
        return Ok(());
    }

    let dim = chunks[0].embedding.len() as i32;
    if dim == 0 {
        return Err("Chunk #0 has empty embedding".to_string());
    }

    let db = connect(&db_path(&project_path))
        .execute()
        .await
        .map_err(|e| format!("DB connect error: {e}"))?;

    let schema = make_schema_v2(dim);
    let batch = make_batch_v2(schema.clone(), &page_id, &chunks, dim)?;
    let data = vec![batch];

    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if tables.contains(&TABLE_V2.to_string()) {
        let table = db
            .open_table(TABLE_V2)
            .execute()
            .await
            .map_err(|e| format!("Open table error: {e}"))?;

        if let Err(e) = table.delete(&format!("page_id = '{}'", page_id)).await {
            eprintln!(
                "[vectorstore v2] Warning: delete before upsert failed for page '{}': {}",
                page_id, e
            );
        }

        table
            .add(data)
            .execute()
            .await
            .map_err(|e| format!("Add error: {e}"))?;
    } else {
        db.create_table(TABLE_V2, data)
            .execute()
            .await
            .map_err(|e| format!("Create table error: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn vector_upsert_chunks(
    project_path: String,
    page_id: String,
    chunks: Vec<ChunkUpsertInput>,
) -> Result<(), String> {
    run_guarded_async(
        "vector_upsert_chunks",
        do_vector_upsert_chunks(project_path, page_id, chunks),
    )
    .await
}

/// Top-K chunk search. Returns every matching chunk's metadata + score
/// (1 / (1 + distance), matching v1's convention for drop-in replacement
/// at the TS layer). TS is responsible for grouping by page_id.
pub async fn do_vector_search_chunks(
    project_path: String,
    query_embedding: Vec<f32>,
    top_k: usize,
) -> Result<Vec<ChunkSearchResult>, String> {
    let db = connect(&db_path(&project_path))
        .execute()
        .await
        .map_err(|e| format!("DB connect error: {e}"))?;

    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if !tables.contains(&TABLE_V2.to_string()) {
        return Ok(vec![]);
    }

    let table = db
        .open_table(TABLE_V2)
        .execute()
        .await
        .map_err(|e| format!("Open table error: {e}"))?;

    let results_stream = table
        .vector_search(query_embedding)
        .map_err(|e| format!("Search error: {e}"))?
        .limit(top_k)
        .execute()
        .await
        .map_err(|e| format!("Execute search error: {e}"))?;

    use futures::TryStreamExt;
    let batches: Vec<RecordBatch> = results_stream
        .try_collect()
        .await
        .map_err(|e| format!("Collect error: {e}"))?;

    let mut out: Vec<ChunkSearchResult> = Vec::new();
    for batch in &batches {
        let chunk_ids = batch
            .column_by_name("chunk_id")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            .ok_or("Missing chunk_id column")?;
        let page_ids = batch
            .column_by_name("page_id")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            .ok_or("Missing page_id column")?;
        let chunk_indexes = batch
            .column_by_name("chunk_index")
            .and_then(|c| c.as_any().downcast_ref::<UInt32Array>())
            .ok_or("Missing chunk_index column")?;
        let chunk_texts = batch
            .column_by_name("chunk_text")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            .ok_or("Missing chunk_text column")?;
        let heading_paths = batch
            .column_by_name("heading_path")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            .ok_or("Missing heading_path column")?;
        let distances = batch
            .column_by_name("_distance")
            .and_then(|c| c.as_any().downcast_ref::<Float32Array>())
            .ok_or("Missing _distance column")?;

        for i in 0..batch.num_rows() {
            let distance = distances.value(i);
            out.push(ChunkSearchResult {
                chunk_id: chunk_ids.value(i).to_string(),
                page_id: page_ids.value(i).to_string(),
                chunk_index: chunk_indexes.value(i),
                chunk_text: chunk_texts.value(i).to_string(),
                heading_path: heading_paths.value(i).to_string(),
                score: 1.0 / (1.0 + distance),
            });
        }
    }

    Ok(out)
}

#[tauri::command]
pub async fn vector_search_chunks(
    project_path: String,
    query_embedding: Vec<f32>,
    top_k: usize,
) -> Result<Vec<ChunkSearchResult>, String> {
    run_guarded_async(
        "vector_search_chunks",
        do_vector_search_chunks(project_path, query_embedding, top_k),
    )
    .await
}

/// Delete every chunk belonging to a page. Used when a source document
/// is removed, or before a full re-embed of a page whose content shrank.
pub async fn do_vector_delete_page(project_path: String, page_id: String) -> Result<(), String> {
    validate_page_id_for_v2(&page_id)?;

    let db = connect(&db_path(&project_path))
        .execute()
        .await
        .map_err(|e| format!("DB connect error: {e}"))?;

    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if !tables.contains(&TABLE_V2.to_string()) {
        return Ok(());
    }

    let table = db
        .open_table(TABLE_V2)
        .execute()
        .await
        .map_err(|e| format!("Open table error: {e}"))?;

    table
        .delete(&format!("page_id = '{}'", page_id))
        .await
        .map_err(|e| format!("Delete error: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn vector_delete_page(project_path: String, page_id: String) -> Result<(), String> {
    run_guarded_async(
        "vector_delete_page",
        do_vector_delete_page(project_path, page_id),
    )
    .await
}

/// Total chunk count in the v2 table (not pages — chunks). Useful for
/// "vector index has N chunks" status text.
pub async fn do_vector_count_chunks(project_path: String) -> Result<usize, String> {
    let db = connect(&db_path(&project_path))
        .execute()
        .await
        .map_err(|e| format!("DB connect error: {e}"))?;

    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if !tables.contains(&TABLE_V2.to_string()) {
        return Ok(0);
    }

    let table = db
        .open_table(TABLE_V2)
        .execute()
        .await
        .map_err(|e| format!("Open table error: {e}"))?;

    let count = table
        .count_rows(None)
        .await
        .map_err(|e| format!("Count error: {e}"))?;

    Ok(count)
}

#[tauri::command]
pub async fn vector_count_chunks(project_path: String) -> Result<usize, String> {
    run_guarded_async("vector_count_chunks", do_vector_count_chunks(project_path)).await
}

/// Report whether the legacy per-page v1 table exists with any rows —
/// the TS layer uses this to show a one-time "re-index to v2" prompt in
/// Settings → Embedding after upgrading. Returns 0 when v1 is absent or
/// empty; otherwise returns the row count.
pub async fn do_vector_legacy_row_count(project_path: String) -> Result<usize, String> {
    let db = connect(&db_path(&project_path))
        .execute()
        .await
        .map_err(|e| format!("DB connect error: {e}"))?;

    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if !tables.contains(&TABLE_V1.to_string()) {
        return Ok(0);
    }

    let table = db
        .open_table(TABLE_V1)
        .execute()
        .await
        .map_err(|e| format!("Open table error: {e}"))?;

    let count = table
        .count_rows(None)
        .await
        .map_err(|e| format!("Count error: {e}"))?;

    Ok(count)
}

#[tauri::command]
pub async fn vector_legacy_row_count(project_path: String) -> Result<usize, String> {
    run_guarded_async(
        "vector_legacy_row_count",
        do_vector_legacy_row_count(project_path),
    )
    .await
}

/// Drop the legacy v1 table entirely. Called from Settings → Embedding
/// after the user has re-indexed into v2 so the orphaned v1 table stops
/// taking disk space. No-op if v1 isn't present.
pub async fn do_vector_drop_legacy(project_path: String) -> Result<(), String> {
    let db = connect(&db_path(&project_path))
        .execute()
        .await
        .map_err(|e| format!("DB connect error: {e}"))?;

    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if !tables.contains(&TABLE_V1.to_string()) {
        return Ok(());
    }

    // LanceDB 0.27's drop_table takes (name, namespace) — we keep
    // the default namespace by passing an empty slice.
    db.drop_table(TABLE_V1, &[])
        .await
        .map_err(|e| format!("Drop table error: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn vector_drop_legacy(project_path: String) -> Result<(), String> {
    run_guarded_async("vector_drop_legacy", do_vector_drop_legacy(project_path)).await
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
//
// These exercise the pure data-shape and upsert/search/delete contracts
// of the v2 chunk store against a throwaway LanceDB instance per test.
// The goal is to catch schema drift and misbehaving batch construction
// early — they are NOT end-to-end tests of the embedding pipeline
// (that lives on the TS side).
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests_v2 {
    use super::*;
    use std::path::PathBuf;

    /// Unique temp project dir per test. `tokio::test` runs tests in
    /// parallel threads so wall-clock nanoseconds aren't sufficient — a
    /// process-wide atomic counter guarantees uniqueness even when two
    /// tests call this at the same tick. Not cleaned up on purpose:
    /// LanceDB's internal file handles can linger briefly after `drop`
    /// and aggressive removal introduces flaky failures on CI.
    fn tmp_project() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!("llm-wiki-vtest-{}-{}", ts, id));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// Deterministic toy embedding of fixed dim. Different seeds produce
    /// different vectors so nearest-neighbour ordering is stable but
    /// non-trivial.
    fn fake_embedding(seed: u32, dim: usize) -> Vec<f32> {
        (0..dim)
            .map(|i| {
                let x = ((seed.wrapping_mul(2654435761)) ^ (i as u32)) as f32;
                (x / u32::MAX as f32).sin()
            })
            .collect()
    }

    fn make_chunks(page_id: &str, n: u32, dim: usize) -> Vec<ChunkUpsertInput> {
        (0..n)
            .map(|i| ChunkUpsertInput {
                chunk_index: i,
                chunk_text: format!("{} chunk {}", page_id, i),
                heading_path: format!("## Heading {}", i),
                embedding: fake_embedding(i, dim),
            })
            .collect()
    }

    #[tokio::test]
    async fn v2_upsert_then_count() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        let chunks = make_chunks("my-page", 3, 16);
        vector_upsert_chunks(pp.clone(), "my-page".into(), chunks)
            .await
            .unwrap();

        let count = vector_count_chunks(pp.clone()).await.unwrap();
        assert_eq!(count, 3);
    }

    #[tokio::test]
    async fn v2_upsert_replaces_existing_chunks_for_page() {
        // First insert 5 chunks, then re-upsert 2 — the final count
        // should be 2, not 7 (old rows deleted before insert).
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 5, 16))
            .await
            .unwrap();
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 5);

        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 2, 16))
            .await
            .unwrap();
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn v2_different_pages_coexist() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 3, 16))
            .await
            .unwrap();
        vector_upsert_chunks(pp.clone(), "page-b".into(), make_chunks("page-b", 4, 16))
            .await
            .unwrap();

        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 7);
    }

    #[tokio::test]
    async fn v2_delete_page_removes_only_its_chunks() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 3, 16))
            .await
            .unwrap();
        vector_upsert_chunks(pp.clone(), "page-b".into(), make_chunks("page-b", 2, 16))
            .await
            .unwrap();
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 5);

        vector_delete_page(pp.clone(), "page-a".into())
            .await
            .unwrap();
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn v2_search_returns_chunks_with_metadata() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 3, 16))
            .await
            .unwrap();

        let query = fake_embedding(1, 16);
        let results = vector_search_chunks(pp.clone(), query, 10).await.unwrap();
        assert!(!results.is_empty());
        // Every result should carry page_id, chunk_id, chunk_text, heading_path.
        for r in &results {
            assert_eq!(r.page_id, "page-a");
            assert!(r.chunk_id.starts_with("page-a#"));
            assert!(r.chunk_text.contains("chunk"));
            assert!(r.heading_path.starts_with("## Heading"));
        }
    }

    #[tokio::test]
    async fn v2_empty_upsert_is_a_noop_not_an_error() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // Upserting [] should succeed and NOT wipe existing rows — this
        // is the "transient ingest failure shouldn't nuke index" contract.
        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 3, 16))
            .await
            .unwrap();
        vector_upsert_chunks(pp.clone(), "page-a".into(), vec![])
            .await
            .unwrap();

        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 3);
    }

    #[tokio::test]
    async fn v2_search_on_missing_table_returns_empty() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        let query = fake_embedding(1, 16);
        let results = vector_search_chunks(pp, query, 10).await.unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn v2_count_on_missing_table_returns_zero() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        assert_eq!(vector_count_chunks(pp).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn v2_delete_page_is_idempotent() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // Delete on missing table: ok.
        vector_delete_page(pp.clone(), "never-existed".into())
            .await
            .unwrap();

        // Insert + delete + delete again: ok.
        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 2, 16))
            .await
            .unwrap();
        vector_delete_page(pp.clone(), "page-a".into())
            .await
            .unwrap();
        vector_delete_page(pp.clone(), "page-a".into())
            .await
            .unwrap();

        assert_eq!(vector_count_chunks(pp).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn v2_rejects_mismatched_embedding_dimensions() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // First chunk sets dim=16; second chunk has dim=8 → should error.
        let bad = vec![
            ChunkUpsertInput {
                chunk_index: 0,
                chunk_text: "ok".into(),
                heading_path: "".into(),
                embedding: fake_embedding(0, 16),
            },
            ChunkUpsertInput {
                chunk_index: 1,
                chunk_text: "bad".into(),
                heading_path: "".into(),
                embedding: fake_embedding(1, 8),
            },
        ];
        let result = vector_upsert_chunks(pp, "page-a".into(), bad).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_lowercase().contains("dim"));
    }

    #[tokio::test]
    async fn v2_rejects_invalid_page_id() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // Quote would be a SQL-injection footgun for the delete filter.
        let result = vector_upsert_chunks(pp, "bad'; DROP".into(), make_chunks("x", 1, 16)).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn legacy_row_count_returns_zero_when_absent() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // v1 table doesn't exist in a fresh temp project.
        assert_eq!(vector_legacy_row_count(pp).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn legacy_row_count_sees_v1_rows() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // Populate v1 via the legacy vector_upsert.
        vector_upsert(pp.clone(), "old-page".into(), fake_embedding(0, 16))
            .await
            .unwrap();

        let count = vector_legacy_row_count(pp.clone()).await.unwrap();
        assert_eq!(count, 1);

        // v2 count is untouched.
        assert_eq!(vector_count_chunks(pp).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn drop_legacy_removes_v1_but_leaves_v2() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert(pp.clone(), "old-page".into(), fake_embedding(0, 16))
            .await
            .unwrap();
        vector_upsert_chunks(
            pp.clone(),
            "new-page".into(),
            make_chunks("new-page", 2, 16),
        )
        .await
        .unwrap();

        assert_eq!(vector_legacy_row_count(pp.clone()).await.unwrap(), 1);
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 2);

        vector_drop_legacy(pp.clone()).await.unwrap();

        assert_eq!(vector_legacy_row_count(pp.clone()).await.unwrap(), 0);
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn drop_legacy_is_noop_when_v1_missing() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // Should just return Ok(()), not error.
        vector_drop_legacy(pp).await.unwrap();
    }
}

// ============================================================================
// S1c hybrid_search: mem0 score_and_rank 多信号融合 (roadmap S1 P1 机械层 · R02)
//
// 思路 (reference/mem0/mem0/utils/scoring.py, 只读借鉴, 非整仓迁移):
//   combined = (semantic + bm25 + entity_boost) / max_possible
//   - semantic 阈值前置门控: 低于 threshold 直接排除 (即使 BM25/entity 能拉高)
//   - max_possible 按激活信号自适应: 仅语义=1.0 / +BM25=2.0 / +entity=2.5
// 本命令为纯 Rust 加性融合器: 输入各信号分数, 输出融合排序。语义检索仍由
// vector_search_chunks 执行, BM25 分数由 TS 侧 (或后续 lexical 层) 提供 —
// Rust 侧只做融合裁决, 不改现有 vector_search/vector_search_chunks。
// ============================================================================

/// 单条多信号输入 (来自调用方: TS 侧收集语义+BM25+实体信号)。
#[derive(Debug, Deserialize)]
pub struct HybridSearchInput {
    /// 唯一 id (chunk_id 或 page_id, 由调用方决定语义)
    pub id: String,
    /// 语义相似度分数 (0-1, 由 vector_search_chunks score 提供)
    pub semantic_score: f32,
    /// BM25 关键词分数 (0-1, 归一化后; 无 BM25 信号时传 0)
    pub bm25_score: f32,
    /// 实体 boost (0-1, 命中查询实体时加性提升; 无实体信号时传 0)
    pub entity_boost: f32,
}

/// 融合排序结果。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HybridSearchResult {
    pub id: String,
    /// 融合后分数 0-1 (combined / max_possible)
    pub score: f32,
    /// 语义信号是否激活 (供审计)
    pub semantic_used: bool,
    /// BM25 信号是否激活
    pub bm25_used: bool,
    /// 实体信号是否激活
    pub entity_used: bool,
}

/// mem0 风格 sigmoid 归一化 BM25 (query 长度自适应 midpoint)。
/// 参考 mem0 get_bm25_params: 短 query 用低 midpoint, 长 query 用高 midpoint。
fn bm25_sigmoid(score: f32, midpoint: f32, steepness: f32) -> f32 {
    let x = score / midpoint;
    let e = (steepness * (1.0 - x)).exp();
    1.0 / (1.0 + e)
}

/// 自适应 max_possible: 按激活信号数计算 (mem0: 语义=1.0/+BM25=2.0/+entity=2.5)。
fn adaptive_max_possible(semantic_active: bool, bm25_active: bool, entity_active: bool) -> f32 {
    match (semantic_active, bm25_active, entity_active) {
        (true, false, false) => 1.0,
        (true, true, false) => 2.0,
        (true, false, true) => 2.0,
        (true, true, true) => 2.5,
        (false, true, false) => 1.0,
        (false, true, true) => 1.5,
        (false, false, true) => 1.0,
        (false, false, false) => 1.0,
    }
}

/// mem0 score_and_rank 中文适配版: 语义+BM25+实体加性融合 + 阈值前置门控。
///
/// 参数:
///   - inputs: 候选集合 (每项含 semantic/bm25/entity 三信号)
///   - semantic_threshold: 语义前置门控阈值 (低于此直接排除, 默认 0.0 = 不启用)
///   - bm25_midpoint: BM25 sigmoid 中点 (query 长度自适应, 默认 5.0)
///   - top_k: 返回条数
///
/// 语义阈值前置门控 (mem0): 语义分数低于 threshold 的候选直接排除 —
/// 即使 BM25/entity 能拉高, 防止关键词噪声污染语义不相关的项。
pub fn score_and_rank(
    inputs: &[HybridSearchInput],
    semantic_threshold: f32,
    bm25_midpoint: f32,
    top_k: usize,
) -> Vec<HybridSearchResult> {
    let mut results: Vec<HybridSearchResult> = Vec::new();

    for input in inputs {
        // 阈值前置门控
        if semantic_threshold > 0.0 && input.semantic_score < semantic_threshold {
            continue;
        }

        // 信号激活判定 (mem0: 非零即激活, BM25 额外要求 > 0.05 防噪声)
        let semantic_active = input.semantic_score > 0.0;
        let bm25_active = input.bm25_score > 0.05;
        let entity_active = input.entity_boost > 0.0;

        let max_possible = adaptive_max_possible(semantic_active, bm25_active, entity_active);

        // BM25 sigmoid 归一 (mem0 normalize_bm25)
        let bm25_norm = if bm25_active {
            bm25_sigmoid(input.bm25_score, bm25_midpoint, 3.0)
        } else {
            0.0
        };

        // 加性融合
        let combined = input.semantic_score + bm25_norm + input.entity_boost;
        let score = (combined / max_possible).clamp(0.0, 1.0);

        results.push(HybridSearchResult {
            id: input.id.clone(),
            score,
            semantic_used: semantic_active,
            bm25_used: bm25_active,
            entity_used: entity_active,
        });
    }

    // 按融合分数降序
    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(top_k);
    results
}

/// RRF (Reciprocal Rank Fusion) 兼容降级: 当 TS 侧只有排序无分数时,
/// 用倒数排名融合替代加性融合。保留此函数供调用方选择 (RRF 参数兼容旧排序)。
/// rrf_k 默认 60 (标准 RRF 常量)。
pub fn rrf_fuse(rankings: &[Vec<String>], top_k: usize, rrf_k: f32) -> Vec<HybridSearchResult> {
    use std::collections::HashMap;
    let mut scores: HashMap<String, f32> = HashMap::new();
    for ranking in rankings {
        for (rank, id) in ranking.iter().enumerate() {
            let entry = scores.entry(id.clone()).or_insert(0.0);
            *entry += 1.0 / (rrf_k + (rank as f32) + 1.0);
        }
    }
    let mut results: Vec<HybridSearchResult> = scores
        .into_iter()
        .map(|(id, score)| HybridSearchResult {
            score: (score / (rankings.len() as f32).max(1.0)).clamp(0.0, 1.0),
            semantic_used: true,
            bm25_used: rankings.len() > 1,
            entity_used: false,
            id,
        })
        .collect();
    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(top_k);
    results
}

#[tauri::command]
pub async fn hybrid_search(
    inputs: Vec<HybridSearchInput>,
    semantic_threshold: Option<f32>,
    bm25_midpoint: Option<f32>,
    top_k: usize,
) -> Result<Vec<HybridSearchResult>, String> {
    run_guarded_async(
        "hybrid_search",
        async move {
            Ok(score_and_rank(
                &inputs,
                semantic_threshold.unwrap_or(0.0),
                bm25_midpoint.unwrap_or(5.0),
                top_k,
            ))
        },
    )
    .await
}

#[cfg(test)]
mod tests_hybrid_search {
    use super::*;

    // S1c: hybrid_search score_and_rank 多信号融合 (mem0 思路)
    #[test]
    fn score_and_rank_fuses_signals_with_adaptive_max() {
        let inputs = vec![
            HybridSearchInput { id: "a".into(), semantic_score: 0.8, bm25_score: 0.0, entity_boost: 0.0 },
            HybridSearchInput { id: "b".into(), semantic_score: 0.7, bm25_score: 0.6, entity_boost: 0.0 },
            HybridSearchInput { id: "c".into(), semantic_score: 0.9, bm25_score: 0.5, entity_boost: 0.4 },
        ];
        let ranked = score_and_rank(&inputs, 0.0, 5.0, 3);
        assert_eq!(ranked.len(), 3);
        // a: 仅语义 0.8/1.0 = 0.8 最高; c: (0.9 + bm25sig + 0.4)/2.5 ≈ 0.55 次之;
        // b: (0.7 + bm25sig)/2.0 ≈ 0.38 最低 — 多信号融合不掩盖强语义信号
        assert_eq!(ranked[0].id, "a");
        assert_eq!(ranked[1].id, "c");
        assert_eq!(ranked[2].id, "b");
        assert!(ranked[0].score <= 1.0 && ranked[0].score > 0.5);
    }

    #[test]
    fn score_and_rank_semantic_threshold_gates_out_low_semantics() {
        let inputs = vec![
            HybridSearchInput { id: "good".into(), semantic_score: 0.9, bm25_score: 0.0, entity_boost: 0.0 },
            // 语义低但 BM25 高 — 阈值前置门控应排除
            HybridSearchInput { id: "noise".into(), semantic_score: 0.1, bm25_score: 0.9, entity_boost: 0.8 },
        ];
        let ranked = score_and_rank(&inputs, 0.5, 5.0, 2);
        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0].id, "good");
    }

    #[test]
    fn score_and_rank_top_k_truncates() {
        let inputs: Vec<HybridSearchInput> = (0..5)
            .map(|i| HybridSearchInput { id: format!("id-{i}"), semantic_score: 0.5 + (i as f32) * 0.1, bm25_score: 0.0, entity_boost: 0.0 })
            .collect();
        let ranked = score_and_rank(&inputs, 0.0, 5.0, 2);
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].id, "id-4");
    }

    #[test]
    fn rrf_fuse_merges_rankings() {
        let r1 = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let r2 = vec!["b".to_string(), "d".to_string(), "e".to_string()];
        let fused = rrf_fuse(&[r1, r2], 3, 60.0);
        // b 在两个列表中都在第 2 位: 1/61 + 1/61 = 2/61 ≈ 0.0328 (最高)
        // a 在第 1 位 + 不在 r2: 1/61 ≈ 0.0164 (次之)
        assert_eq!(fused[0].id, "b");
        assert_eq!(fused[1].id, "a");
    }
}
