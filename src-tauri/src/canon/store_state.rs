// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Canon 存储零 IO 纯函数层——M1-1 自 `store.rs` 增量剥离（S4 单轮收敛，fs_archive 模式）。
//!
//! 收容：LanceDB 路径/`SQL` 转义、Arrow schema ↔ `RecordBatch` 编解码、
//! 审计事件编解码、FNV-1a 事件 id 派生——全部确定性、无 IO。
//! `store.rs` 经 `pub(crate) use` 回引，外部 import 面零变化
//! （外部唯一用到 `crate::canon::store::CanonStore`，原位未动）。

use std::sync::Arc;

use arrow_array::{Array, BooleanArray, Int32Array, Int64Array, RecordBatch, StringArray};
use arrow_schema::{DataType, Field, Schema, SchemaRef};

use crate::canon::types::{CanonEdge, CanonEntity, CanonEpisode, CanonEvent};

pub(crate) fn db_path(project_path: &str) -> String {
    format!("{}/.niko-buddy/lancedb", project_path.replace('\\', "/"))
}

/// 转义为 LanceDB SQL 字符串字面量（单引号包裹，内部单引号加倍）。
/// id/digest 等键值进 filter 前过此函数，防注入。
pub(crate) fn sql_str(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

// ──────────────────────────────────────────────────────────────────────────
// arrow schema（full current = v3；create_table 直接建满）
// ──────────────────────────────────────────────────────────────────────────

pub(crate) fn entities_schema() -> SchemaRef {
    Arc::new(Schema::new(vec![
        Field::new("id", DataType::Utf8, false),
        Field::new("entity_type", DataType::Utf8, false),
        Field::new("canonical_name", DataType::Utf8, false),
        Field::new("first_seen_chapter", DataType::Int32, false),
        Field::new("valid_at", DataType::Int32, true),
        Field::new("invalid_at", DataType::Int32, true),
        Field::new("archived", DataType::Boolean, true),
        Field::new("embedding_model", DataType::Utf8, true),
        Field::new("embedding_version", DataType::Utf8, true),
        Field::new("data", DataType::Utf8, false),
    ]))
}

pub(crate) fn edges_schema() -> SchemaRef {
    Arc::new(Schema::new(vec![
        Field::new("id", DataType::Utf8, false),
        Field::new("source_id", DataType::Utf8, false),
        Field::new("target_id", DataType::Utf8, false),
        Field::new("predicate", DataType::Utf8, false),
        Field::new("edge_kind", DataType::Utf8, false),
        Field::new("valid_at", DataType::Int32, true),
        Field::new("invalid_at", DataType::Int32, true),
        Field::new("reference_time", DataType::Int32, true),
        Field::new("revealed_at", DataType::Int32, true),
        Field::new("confidence", DataType::Float32, true),
        Field::new("source_chapter", DataType::Int32, true),
        Field::new("digest", DataType::Utf8, false),
        Field::new("archived", DataType::Boolean, true),
        Field::new("created_at", DataType::Int64, true),
        Field::new("expired_at", DataType::Int64, true),
        Field::new("data", DataType::Utf8, false),
    ]))
}

pub(crate) fn episodes_schema() -> SchemaRef {
    Arc::new(Schema::new(vec![
        Field::new("id", DataType::Utf8, false),
        Field::new("chapter_number", DataType::Int32, false),
        Field::new("entity_id", DataType::Utf8, false),
        Field::new("narrative_stage", DataType::Utf8, false),
        Field::new("reference_time", DataType::Int32, true),
        Field::new("digest", DataType::Utf8, false),
        Field::new("archived", DataType::Boolean, true),
        Field::new("embedding_model", DataType::Utf8, true),
        Field::new("embedding_version", DataType::Utf8, true),
        Field::new("data", DataType::Utf8, false),
    ]))
}

pub(crate) fn meta_schema() -> SchemaRef {
    Arc::new(Schema::new(vec![
        Field::new("key", DataType::Utf8, false),
        Field::new("value", DataType::Utf8, false),
    ]))
}

// ──────────────────────────────────────────────────────────────────────────
// 行 → arrow RecordBatch（1 行；upsert 用）
// ──────────────────────────────────────────────────────────────────────────

pub(crate) fn opt_str(s: &Option<String>) -> Option<&str> {
    s.as_deref()
}

pub(crate) fn entities_batch(e: &CanonEntity) -> Result<RecordBatch, String> {
    let schema = entities_schema();
    let data = serde_json::to_string(e).map_err(|x| format!("serde: {x}"))?;
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(StringArray::from(vec![Some(e.id.as_str())])),
            Arc::new(StringArray::from(vec![Some(e.entity_type.as_str())])),
            Arc::new(StringArray::from(vec![Some(e.canonical_name.as_str())])),
            Arc::new(Int32Array::from(vec![Some(e.first_seen_chapter)])),
            Arc::new(Int32Array::from(vec![e.valid_at])),
            Arc::new(Int32Array::from(vec![e.invalid_at])),
            Arc::new(BooleanArray::from(vec![Some(e.archived)])),
            Arc::new(StringArray::from(vec![opt_str(&e.embedding_model)])),
            Arc::new(StringArray::from(vec![opt_str(&e.embedding_version)])),
            Arc::new(StringArray::from(vec![Some(data.as_str())])),
        ],
    )
    .map_err(|e| format!("batch: {e}"))
}

pub(crate) fn edges_batch(e: &CanonEdge) -> Result<RecordBatch, String> {
    let schema = edges_schema();
    let data = serde_json::to_string(e).map_err(|x| format!("serde: {x}"))?;
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(StringArray::from(vec![Some(e.id.as_str())])),
            Arc::new(StringArray::from(vec![Some(e.source_id.as_str())])),
            Arc::new(StringArray::from(vec![Some(e.target_id.as_str())])),
            Arc::new(StringArray::from(vec![Some(e.predicate.as_str())])),
            Arc::new(StringArray::from(vec![Some(e.edge_kind.as_str())])),
            Arc::new(Int32Array::from(vec![e.valid_at])),
            Arc::new(Int32Array::from(vec![e.invalid_at])),
            Arc::new(Int32Array::from(vec![e.reference_time])),
            Arc::new(Int32Array::from(vec![e.revealed_at])),
            Arc::new(arrow_array::Float32Array::from(vec![e.confidence])),
            Arc::new(Int32Array::from(vec![e.source_chapter])),
            Arc::new(StringArray::from(vec![Some(e.digest.as_str())])),
            Arc::new(BooleanArray::from(vec![Some(e.archived)])),
            Arc::new(Int64Array::from(vec![e.created_at])),
            Arc::new(Int64Array::from(vec![e.expired_at])),
            Arc::new(StringArray::from(vec![Some(data.as_str())])),
        ],
    )
    .map_err(|e| format!("batch: {e}"))
}

pub(crate) fn episodes_batch(e: &CanonEpisode) -> Result<RecordBatch, String> {
    let schema = episodes_schema();
    let data = serde_json::to_string(e).map_err(|x| format!("serde: {x}"))?;
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(StringArray::from(vec![Some(e.id.as_str())])),
            Arc::new(Int32Array::from(vec![Some(e.chapter_number)])),
            Arc::new(StringArray::from(vec![Some(e.entity_id.as_str())])),
            Arc::new(StringArray::from(vec![Some(e.narrative_stage.as_str())])),
            Arc::new(Int32Array::from(vec![e.reference_time])),
            Arc::new(StringArray::from(vec![Some(e.digest.as_str())])),
            Arc::new(BooleanArray::from(vec![Some(e.archived)])),
            Arc::new(StringArray::from(vec![opt_str(&e.embedding_model)])),
            Arc::new(StringArray::from(vec![opt_str(&e.embedding_version)])),
            Arc::new(StringArray::from(vec![Some(data.as_str())])),
        ],
    )
    .map_err(|e| format!("batch: {e}"))
}

pub(crate) fn meta_batch(key: &str, value: &str) -> Result<RecordBatch, String> {
    let schema = meta_schema();
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(StringArray::from(vec![Some(key)])),
            Arc::new(StringArray::from(vec![Some(value)])),
        ],
    )
    .map_err(|e| format!("batch: {e}"))
}

// ──────────────────────────────────────────────────────────────────────────
// RecordBatch → 结构体（读 `data` 列反序列化）
// ──────────────────────────────────────────────────────────────────────────

pub(crate) fn read_data_column(batch: &RecordBatch) -> Result<Vec<String>, String> {
    let col = batch.column_by_name("data").ok_or("missing data column")?;
    let arr = col
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or("data column not Utf8")?;
    Ok((0..arr.len())
        .map(|i| {
            if arr.is_null(i) {
                String::new()
            } else {
                arr.value(i).to_string()
            }
        })
        .collect())
}

pub(crate) fn read_edges(batches: &[RecordBatch]) -> Result<Vec<CanonEdge>, String> {
    let mut out = Vec::new();
    for b in batches {
        for json in read_data_column(b)? {
            if json.is_empty() {
                continue;
            }
            let e: CanonEdge =
                serde_json::from_str(&json).map_err(|e| format!("deserialize edge: {e}"))?;
            out.push(e);
        }
    }
    Ok(out)
}

pub(crate) fn read_episodes(batches: &[RecordBatch]) -> Result<Vec<CanonEpisode>, String> {
    let mut out = Vec::new();
    for b in batches {
        for json in read_data_column(b)? {
            if json.is_empty() {
                continue;
            }
            let e: CanonEpisode =
                serde_json::from_str(&json).map_err(|e| format!("deserialize episode: {e}"))?;
            out.push(e);
        }
    }
    Ok(out)
}

// ──────────────────────────────────────────────────────────────────────────
// §B events：schema / batch / read（data-JSON 承载，损坏行 Err 传播）
// ──────────────────────────────────────────────────────────────────────────
//
// 设计（选项 Z + ox-alpha）：独立 `canon_events` 物理表，与三表隔离（防爆半径
// F6）。`data` 列承载完整事件 JSON；物理列仅保留审计/溯源标量键。读取时只反
// 序列化 `data` 列。损坏行（非空但非法 JSON / 结构）→ Err 传播（done-when 升格，
// 不照抄 edges 的空串 continue 静默跳过——此处仅空串跳过，非法 JSON 必报错）。

/// §B 审计事件表 arrow schema（v1，零迁移：旧库经 `ensure_table` 自动补建）。
pub(crate) fn events_schema() -> SchemaRef {
    Arc::new(Schema::new(vec![
        Field::new("id", DataType::Utf8, false),
        Field::new("event_type", DataType::Utf8, true),
        Field::new("caused_by", DataType::Utf8, true),
        Field::new("revision", DataType::Int64, true),
        Field::new("cap_chapter", DataType::Int32, true),
        Field::new("occurred_at", DataType::Utf8, true),
        Field::new("data", DataType::Utf8, false),
    ]))
}

/// 事件 → 单行 RecordBatch（data 列承载完整 JSON）。
pub(crate) fn events_batch(e: &CanonEvent) -> Result<RecordBatch, String> {
    let schema = events_schema();
    let data = serde_json::to_string(e).map_err(|x| format!("serde: {x}"))?;
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(StringArray::from(vec![Some(e.event_id.as_str())])),
            Arc::new(StringArray::from(vec![Some(e.event_type.as_str())])),
            Arc::new(StringArray::from(vec![opt_str(&e.caused_by)])),
            Arc::new(Int64Array::from(vec![e.revision.map(|r| r as i64)])),
            Arc::new(Int32Array::from(vec![e.cap_chapter])),
            Arc::new(StringArray::from(vec![Some(e.occurred_at.as_str())])),
            Arc::new(StringArray::from(vec![Some(data.as_str())])),
        ],
    )
    .map_err(|e| format!("batch: {e}"))
}

/// 批量读取审计事件：损坏行 Err 传播（非静默跳过）。
pub(crate) fn read_events(batches: &[RecordBatch]) -> Result<Vec<CanonEvent>, String> {
    let mut out = Vec::new();
    for b in batches {
        for json in read_data_column(b)? {
            if json.is_empty() {
                continue;
            }
            let e: CanonEvent =
                serde_json::from_str(&json).map_err(|e| format!("deserialize event: {e}"))?;
            out.push(e);
        }
    }
    Ok(out)
}

/// FNV-1a 64 位摘要（稳定、确定性，用于事件 id 派生）。
pub(crate) fn fnv1a_64(input: &[u8]) -> String {
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;
    let mut h = OFFSET;
    for &b in input {
        h ^= b as u64;
        h = h.wrapping_mul(PRIME);
    }
    format!("{:016x}", h)
}

/// 服务端派生 event_id：f(project_id, max_revision, payload-hash)。
///
/// payload-hash 覆盖 event_type / old_edge_ids / cap_chapter / new_edge_ids /
/// caused_by（确定性，不含 event_id / occurred_at 等变体），保证「同一逻辑
/// supersede」派生同一 id——query-before-add 幂等基础（done-when #1）。
pub(crate) fn derive_event_id(project_id: &str, revision: u64, ev: &CanonEvent) -> String {
    let payload = format!(
        "{:?}|{:?}|{:?}|{:?}|{:?}",
        ev.event_type, ev.old_edge_ids, ev.cap_chapter, ev.new_edge_ids, ev.caused_by
    );
    let hash = fnv1a_64(payload.as_bytes());
    format!("evt:{}:{}:{}", project_id, revision, hash)
}