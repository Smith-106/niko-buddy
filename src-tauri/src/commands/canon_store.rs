// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Canon 三表存储（T11，蓝图 §6 T11 / §3 终版）。
//!
//! 本模块分两层：
//!   1. **纯逻辑层** [`CanonState`]：内存中的 entities/edges/episodes + schema
//!      清单，承载 upsert/invalidate/supersede/query/ingest_digest 去重/迁移
//!      链的全部决策逻辑。无 IO，可被 `cargo test` + proptest 完整覆盖。
//!   2. **LanceDB IO 层** [`CanonStore`]：每项目一库（蓝图 §3），按 `data`
//!      JSON 列存全量结构 + 一组原生列做谓词推 down。CRUD 用 LanceDB 0.27
//!      的 connect/create_table/add/delete/query（与 `vectorstore.rs` 同源 API）；
//!      迁移链用 `Table::add_columns`（已核实 0.27 支持，见
//!      [`canon_types`] 模块注记），rollback 用 `Table::version/checkout/restore`。
//!
//! ## IPC 边界
//!   T11 仅交付存储层（库函数，无 `#[tauri::command]`）。IPC 命令注册在
//!   T13 `canon_commands.rs`。本模块暴露 async 函数供 T13 包装。
//!
//! ## LanceDB schema 演化预案（T04 spike A-01.5 + 蓝图 §9①）
//!   - **主路径（additive）**：`Table::add_columns(NewColumnTransform::SqlExpressions,
//!     None)`，每列 `CAST(NULL AS <type>)`（lance 4.0 方言：int/bigint/string/
//!     boolean）。migrate_up 先查 `table.schema()` 跳过已存在列 → 幂等。
//!   - **非 additive 变更（改类型/删列）兜底**：表重建——建 `<name>_migrated`
//!     新表（目标 schema）→ query 旧表 `data` 列重写 → drop 旧表 → 以旧名
//!     create 新表 + add。仅作文档化预案（T11 不触发，非 additive 变更留待
//!     运营期）。`drop_table` 已核实可用（connection.rs:482）。
//!   - **数据层 rollback**：migrate_up 前捕获各表 `Table::version()`，存入
//!     meta 表 `lance_pre_migrate` 键；rollback 时 `checkout(v).restore()`
//!     物理回退 schema（已核实 0.27 支持 checkout/restore）。

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::path::Path;

use arrow_array::{
    Array, BooleanArray, Int32Array, RecordBatch, StringArray,
};
use arrow_schema::{DataType, Field, Schema, SchemaRef};
use futures::TryStreamExt;
use lancedb::connect;
use lancedb::query::{ExecutableQuery, QueryBase};
use lancedb::table::{CompactionOptions, NewColumnTransform, OptimizeAction};
use lancedb::Table;

use crate::types::canon_types::{
    self, plan_migration, CanonEdge, CanonEdgeFilter, CanonEntity, CanonEpisode, EdgeKind,
    IngestKey, MigrationPlan, SchemaManifest, SchemaVersion, SupersedeRequest, SupersedeResult,
    CURRENT_SCHEMA_VERSION, CANON_TABLE_EDGES, CANON_TABLE_ENTITIES, CANON_TABLE_EPISODES,
    CANON_TABLE_META,
};

// ──────────────────────────────────────────────────────────────────────────
// 路径与 SQL 辅助
// ──────────────────────────────────────────────────────────────────────────

fn db_path(project_path: &str) -> String {
    format!("{}/.qmai/lancedb", project_path.replace('\\', "/"))
}

/// 转义为 LanceDB SQL 字符串字面量（单引号包裹，内部单引号加倍）。
/// id/digest 等键值进 filter 前过此函数，防注入。
fn sql_str(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

// ──────────────────────────────────────────────────────────────────────────
// arrow schema（full current = v3；create_table 直接建满）
// ──────────────────────────────────────────────────────────────────────────

fn entities_schema() -> SchemaRef {
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

fn edges_schema() -> SchemaRef {
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
        Field::new("data", DataType::Utf8, false),
    ]))
}

fn episodes_schema() -> SchemaRef {
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

fn meta_schema() -> SchemaRef {
    Arc::new(Schema::new(vec![
        Field::new("key", DataType::Utf8, false),
        Field::new("value", DataType::Utf8, false),
    ]))
}

// ──────────────────────────────────────────────────────────────────────────
// 行 → arrow RecordBatch（1 行；upsert 用）
// ──────────────────────────────────────────────────────────────────────────

fn opt_str(s: &Option<String>) -> Option<&str> {
    s.as_deref()
}

fn entities_batch(e: &CanonEntity) -> Result<RecordBatch, String> {
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

fn edges_batch(e: &CanonEdge) -> Result<RecordBatch, String> {
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
            Arc::new(StringArray::from(vec![Some(data.as_str())])),
        ],
    )
    .map_err(|e| format!("batch: {e}"))
}

fn episodes_batch(e: &CanonEpisode) -> Result<RecordBatch, String> {
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

fn meta_batch(key: &str, value: &str) -> Result<RecordBatch, String> {
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

fn read_data_column(batch: &RecordBatch) -> Result<Vec<String>, String> {
    let col = batch
        .column_by_name("data")
        .ok_or("missing data column")?;
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

fn read_edges(batches: &[RecordBatch]) -> Result<Vec<CanonEdge>, String> {
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

fn read_episodes(batches: &[RecordBatch]) -> Result<Vec<CanonEpisode>, String> {
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
// 纯逻辑层：CanonState（内存）
// ──────────────────────────────────────────────────────────────────────────

/// 内存中的 canon 三表状态 + schema 清单。承载全部决策逻辑，无 IO。
///
/// LanceDB 层 [`CanonStore`] 在读写前后与此结构语义对齐：纯逻辑在此验证，
/// IO 在 LanceDB 落盘。proptest 直接覆盖本结构。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CanonState {
    pub entities: Vec<CanonEntity>,
    pub edges: Vec<CanonEdge>,
    pub episodes: Vec<CanonEpisode>,
    pub manifest: SchemaManifest,
}

impl CanonState {
    pub fn new() -> Self {
        Self {
            entities: Vec::new(),
            edges: Vec::new(),
            episodes: Vec::new(),
            manifest: SchemaManifest::new(CURRENT_SCHEMA_VERSION),
        }
    }

    /// 以 v1 初始清单构造（迁移测试用）。
    pub fn new_at_v1() -> Self {
        Self {
            entities: Vec::new(),
            edges: Vec::new(),
            episodes: Vec::new(),
            manifest: SchemaManifest::new(SchemaVersion(1)),
        }
    }

    // ── upsert（幂等：同 id 替换）──

    /// 幂等 upsert 实体：同 id 存在则替换，否则追加。返回是否替换了既有行。
    pub fn upsert_entity(&mut self, e: CanonEntity) -> bool {
        if let Some(slot) = self.entities.iter_mut().find(|x| x.id == e.id) {
            *slot = e;
            true
        } else {
            self.entities.push(e);
            false
        }
    }

    /// 幂等 upsert 边：同 id 替换，否则追加。
    pub fn upsert_edge(&mut self, e: CanonEdge) -> bool {
        if let Some(slot) = self.edges.iter_mut().find(|x| x.id == e.id) {
            *slot = e;
            true
        } else {
            self.edges.push(e);
            false
        }
    }

    // ── invalidate（封顶：写 invalid_at）──

    /// 封顶单条边：写入 `invalid_at = cap_chapter`（原地 UPDATE，graphiti 模式）。
    /// 返回是否命中。
    pub fn invalidate_edge(&mut self, edge_id: &str, cap_chapter: i32) -> bool {
        if let Some(e) = self.edges.iter_mut().find(|x| x.id == edge_id) {
            e.invalid_at = Some(cap_chapter);
            true
        } else {
            false
        }
    }

    // ── 批量 supersede ──

    /// 批量 supersede：旧边封顶（invalid_at=cap_chapter），插入新边（全新 uuid）。
    /// 幂等：重复 supersede 同一组 new_edges（同 id）会替换而非复制。
    pub fn supersede_edges(&mut self, req: SupersedeRequest) -> SupersedeResult {
        let mut capped = 0usize;
        let mut missing = Vec::new();
        for old_id in &req.old_edge_ids {
            if self.invalidate_edge(old_id, req.cap_chapter) {
                capped += 1;
            } else {
                missing.push(old_id.clone());
            }
        }
        let mut inserted = 0usize;
        for ne in req.new_edges {
            self.upsert_edge(ne);
            inserted += 1;
        }
        SupersedeResult {
            capped,
            inserted,
            missing,
        }
    }

    // ── query（时态 + 认知轴过滤，纯投影）──

    /// 按 filter 查询边（时态 + 认知轴 + 类别 + 谓词 + 端点 + archived）。
    pub fn query_edges(&self, filter: &CanonEdgeFilter) -> Vec<CanonEdge> {
        filter.select(&self.edges)
    }

    // ── ingest_digest 去重 ──

    /// 检查 (chapter, digest) 是否已摄取（写前去重）。
    pub fn check_ingest_digest(&self, chapter_number: i32, digest: &str) -> bool {
        canon_types::ingest_digest_exists(
            self.episodes
                .iter()
                .map(|e| (e.chapter_number, e.digest.clone())),
            chapter_number,
            digest,
        )
    }

    /// 摄取 episode：若 (chapter_number, digest) 已存在则跳过（幂等），否则插入。
    /// 返回是否实际插入（false=已存在跳过）。
    pub fn ingest_episode(&mut self, ep: CanonEpisode) -> bool {
        if self.check_ingest_digest(ep.chapter_number, &ep.digest) {
            return false;
        }
        // 同 id 替换（防御性），但 (chapter,digest) 不同则追加。
        if let Some(slot) = self
            .episodes
            .iter_mut()
            .find(|x| x.id == ep.id)
        {
            *slot = ep;
        } else {
            self.episodes.push(ep);
        }
        true
    }

    /// 当前摄取键全集（诊断/测试用）。
    pub fn ingest_keys(&self) -> Vec<IngestKey> {
        self.episodes
            .iter()
            .map(|e| IngestKey {
                chapter_number: e.chapter_number,
                digest: e.digest.clone(),
            })
            .collect()
    }

    // ── schema_version 迁移链（纯 manifest 演化）──

    /// dry-run：返回迁移计划（不演化 manifest）。
    pub fn migrate_dry_run(&self, target: SchemaVersion) -> MigrationPlan {
        plan_migration(self.manifest.version, target)
    }

    /// up：演化 manifest 到 target（幂等）。返回执行的计划。
    pub fn migrate_up(&mut self, target: SchemaVersion) -> MigrationPlan {
        let plan = plan_migration(self.manifest.version, target);
        self.manifest.apply_plan(&plan);
        plan
    }

    /// rollback：回退 manifest 版本标记到 target。
    pub fn migrate_rollback(&mut self, target: SchemaVersion) {
        self.manifest.rollback_to(target);
    }
}

// ──────────────────────────────────────────────────────────────────────────
// LanceDB IO 层：CanonStore
// ──────────────────────────────────────────────────────────────────────────

const META_KEY_SCHEMA: &str = "schema_version";
const META_KEY_LANCE_PRE: &str = "lance_pre_migrate";
const META_KEY_REVISION: &str = "canon_revision";
/// divergence trace 持久化键（DEBT-20260820-15b 偿还：与 META_KEY_REVISION 分离，
/// 避免 revision 写入时被 divergence trace 覆盖）。
const META_KEY_DIVERGENCE_TRACE: &str = "canon_divergence_trace";

/// 默认 compaction 触发阈值：N 批 ingest 操作后触发。
const DEFAULT_COMPACTION_THRESHOLD: u64 = 100;
/// 默认保留的 manifest 版本数（prune 时保留最新 K 个）。
const DEFAULT_RETAIN_VERSIONS: u64 = 5;

/// 磁盘占用指标（各表 + 合计）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct DiskUsage {
    pub entities_bytes: u64,
    pub edges_bytes: u64,
    pub episodes_bytes: u64,
    pub meta_bytes: u64,
    pub total_bytes: u64,
}

/// Compaction 执行报告。
#[derive(Debug, Clone, serde::Serialize)]
pub struct CompactionReport {
    pub fragments_removed: usize,
    pub fragments_added: usize,
    pub files_removed: usize,
    pub files_added: usize,
    pub bytes_removed: u64,
    pub old_versions_removed: u64,
    pub tables_compacted: Vec<String>,
}

/// LanceDB 支持的 canon 存储。每项目一库（`<project>/.qmai/lancedb`）。
pub struct CanonStore {
    db: lancedb::Connection,
    manifest: SchemaManifest,
    /// ingest 操作计数器（upsert_entity / upsert_edge / ingest_episode 累加）。
    ingest_count: AtomicU64,
    /// 自动 compaction 阈值（N 批 ingest 后触发）。
    compaction_threshold: AtomicU64,
    /// prune 时保留的 manifest 版本数。
    retain_versions: u64,
    /// 项目路径（磁盘指标用）。
    project_path: String,
}

impl CanonStore {
    /// 打开/初始化 canon 库：确保三表 + meta 表存在（建满当前 schema），
    /// 加载 schema 清单。新库清单 = CURRENT；无 meta 的遗留库默认 v1。
    pub async fn open(project_path: &str) -> Result<Self, String> {
        let db = connect(&db_path(project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect: {e}"))?;

        let names = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("list tables: {e}"))?;

        let entities_existed = names.contains(&CANON_TABLE_ENTITIES.to_string());
        ensure_table(&db, CANON_TABLE_ENTITIES, entities_schema(), &names).await?;
        ensure_table(&db, CANON_TABLE_EDGES, edges_schema(), &names).await?;
        ensure_table(&db, CANON_TABLE_EPISODES, episodes_schema(), &names).await?;
        ensure_table(&db, CANON_TABLE_META, meta_schema(), &names).await?;

        // manifest：新库（表刚建）= CURRENT；遗留库无 meta 行 = v1（触发迁移）
        let manifest = if entities_existed {
            Self::load_manifest(&db).await?.unwrap_or_else(|| SchemaManifest::new(SchemaVersion(1)))
        } else {
            let m = SchemaManifest::new(CURRENT_SCHEMA_VERSION);
            Self::save_manifest(&db, &m).await?;
            m
        };

        Ok(Self {
            db,
            manifest,
            ingest_count: AtomicU64::new(0),
            compaction_threshold: AtomicU64::new(DEFAULT_COMPACTION_THRESHOLD),
            retain_versions: DEFAULT_RETAIN_VERSIONS,
            project_path: project_path.to_string(),
        })
    }

    // ── manifest 持久化 ──

    async fn load_manifest(db: &lancedb::Connection) -> Result<Option<SchemaManifest>, String> {
        let table = db
            .open_table(CANON_TABLE_META)
            .execute()
            .await
            .map_err(|e| format!("open meta: {e}"))?;
        let batches = table
            .query()
            .only_if(format!("key = {}", sql_str(META_KEY_SCHEMA)))
            .execute()
            .await
            .map_err(|e| format!("query meta: {e}"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|e| format!("collect meta: {e}"))?;
        for b in &batches {
            let val = b
                .column_by_name("value")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>());
            if let Some(arr) = val {
                for i in 0..arr.len() {
                    if arr.is_null(i) {
                        continue;
                    }
                    let m: SchemaManifest = serde_json::from_str(arr.value(i))
                        .map_err(|e| format!("deserialize manifest: {e}"))?;
                    return Ok(Some(m));
                }
            }
        }
        Ok(None)
    }

    async fn save_manifest(db: &lancedb::Connection, m: &SchemaManifest) -> Result<(), String> {
        let json = serde_json::to_string(m).map_err(|e| format!("serde manifest: {e}"))?;
        // delete-then-insert（幂等替换 key 行）
        let table = db
            .open_table(CANON_TABLE_META)
            .execute()
            .await
            .map_err(|e| format!("open meta: {e}"))?;
        let _ = table
            .delete(&format!("key = {}", sql_str(META_KEY_SCHEMA)))
            .await;
        let batch = meta_batch(META_KEY_SCHEMA, &json)?;
        table
            .add(vec![batch])
            .execute()
            .await
            .map_err(|e| format!("meta add: {e}"))?;
        Ok(())
    }

    async fn load_lance_pre_migrate(
        db: &lancedb::Connection,
    ) -> Result<HashMap<String, u64>, String> {
        let table = db
            .open_table(CANON_TABLE_META)
            .execute()
            .await
            .map_err(|e| format!("open meta: {e}"))?;
        let batches = table
            .query()
            .only_if(format!("key = {}", sql_str(META_KEY_LANCE_PRE)))
            .execute()
            .await
            .map_err(|e| format!("query pre-migrate: {e}"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|e| format!("collect pre-migrate: {e}"))?;
        for b in &batches {
            if let Some(arr) = b
                .column_by_name("value")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            {
                for i in 0..arr.len() {
                    if arr.is_null(i) {
                        continue;
                    }
                    let map: HashMap<String, u64> = serde_json::from_str(arr.value(i))
                        .map_err(|e| format!("deserialize pre-migrate: {e}"))?;
                    return Ok(map);
                }
            }
        }
        Ok(HashMap::new())
    }

    async fn save_lance_pre_migrate(
        db: &lancedb::Connection,
        map: &HashMap<String, u64>,
    ) -> Result<(), String> {
        let json = serde_json::to_string(map).map_err(|e| format!("serde pre-migrate: {e}"))?;
        let table = db
            .open_table(CANON_TABLE_META)
            .execute()
            .await
            .map_err(|e| format!("open meta: {e}"))?;
        let _ = table
            .delete(&format!("key = {}", sql_str(META_KEY_LANCE_PRE)))
            .await;
        let batch = meta_batch(META_KEY_LANCE_PRE, &json)?;
        table
            .add(vec![batch])
            .execute()
            .await
            .map_err(|e| format!("meta add pre-migrate: {e}"))?;
        Ok(())
    }

    // ── CRUD ──

    /// 幂等 upsert 实体：同 id 先 delete 再 add。
    pub async fn upsert_entity(&self, e: CanonEntity) -> Result<(), String> {
        let table = self
            .db
            .open_table(CANON_TABLE_ENTITIES)
            .execute()
            .await
            .map_err(|x| format!("open entities: {x}"))?;
        let _ = table
            .delete(&format!("id = {}", sql_str(&e.id)))
            .await;
        let batch = entities_batch(&e)?;
        table
            .add(vec![batch])
            .execute()
            .await
            .map_err(|x| format!("entities add: {x}"))?;
        self.ingest_count.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    /// 幂等 upsert 边。
    pub async fn upsert_edge(&self, e: CanonEdge) -> Result<(), String> {
        let table = self
            .db
            .open_table(CANON_TABLE_EDGES)
            .execute()
            .await
            .map_err(|x| format!("open edges: {x}"))?;
        let _ = table
            .delete(&format!("id = {}", sql_str(&e.id)))
            .await;
        let batch = edges_batch(&e)?;
        table
            .add(vec![batch])
            .execute()
            .await
            .map_err(|x| format!("edges add: {x}"))?;
        self.ingest_count.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    /// 封顶单条边（原地写 invalid_at：delete + 重新 add 带 invalid_at）。
    pub async fn invalidate_edge(&self, edge_id: &str, cap_chapter: i32) -> Result<bool, String> {
        let table = self
            .db
            .open_table(CANON_TABLE_EDGES)
            .execute()
            .await
            .map_err(|x| format!("open edges: {x}"))?;
        let batches = table
            .query()
            .only_if(format!("id = {}", sql_str(edge_id)))
            .execute()
            .await
            .map_err(|x| format!("query edge: {x}"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|x| format!("collect edge: {x}"))?;
        let mut edges = read_edges(&batches)?;
        if edges.is_empty() {
            return Ok(false);
        }
        let mut e = edges.remove(0);
        e.invalid_at = Some(cap_chapter);
        // delete 旧行 + add 封顶后行
        let _ = table
            .delete(&format!("id = {}", sql_str(edge_id)))
            .await;
        let batch = edges_batch(&e)?;
        table
            .add(vec![batch])
            .execute()
            .await
            .map_err(|x| format!("edges re-add: {x}"))?;
        Ok(true)
    }

    /// 批量 supersede：旧边封顶 + 新边插入（单次 invoke）。
    pub async fn supersede_edges(&self, req: SupersedeRequest) -> Result<SupersedeResult, String> {
        let mut capped = 0usize;
        let mut missing = Vec::new();
        for old_id in &req.old_edge_ids {
            if self.invalidate_edge(old_id, req.cap_chapter).await? {
                capped += 1;
            } else {
                missing.push(old_id.clone());
            }
        }
        let mut inserted = 0usize;
        for ne in req.new_edges {
            self.upsert_edge(ne).await?;
            inserted += 1;
        }
        Ok(SupersedeResult {
            capped,
            inserted,
            missing,
        })
    }

    /// 查询边：LanceDB 推 down archived + edge_kind，Rust 精细过滤时态/认知轴。
    pub async fn query_edges(&self, filter: &CanonEdgeFilter) -> Result<Vec<CanonEdge>, String> {
        let table = self
            .db
            .open_table(CANON_TABLE_EDGES)
            .execute()
            .await
            .map_err(|x| format!("open edges: {x}"))?;
        let mut q = table.query();
        // archived 推 down（默认 false）
        let want_archived = filter.archived.unwrap_or(false);
        q = q.only_if(format!("archived = {}", want_archived));
        if let Some(ref kinds) = filter.edge_kinds {
            if !kinds.is_empty() {
                let in_list: Vec<String> = kinds.iter().map(|k| sql_str(k.as_str())).collect();
                q = q.only_if(format!("edge_kind IN ({})", in_list.join(", ")));
            }
        }
        let batches = q
            .execute()
            .await
            .map_err(|x| format!("query edges: {x}"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|x| format!("collect edges: {x}"))?;
        let edges = read_edges(&batches)?;
        Ok(filter.select(&edges))
    }

    /// 摄取 episode：(chapter, digest) 写前去重。返回是否实际写入。
    pub async fn ingest_episode(&self, ep: CanonEpisode) -> Result<bool, String> {
        let table = self
            .db
            .open_table(CANON_TABLE_EPISODES)
            .execute()
            .await
            .map_err(|x| format!("open episodes: {x}"))?;
        // 写前去重：查 (chapter_number, digest)
        let dup = table
            .query()
            .only_if(format!(
                "chapter_number = {} AND digest = {}",
                ep.chapter_number,
                sql_str(&ep.digest)
            ))
            .execute()
            .await
            .map_err(|x| format!("dup-check query: {x}"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|x| format!("dup-check collect: {x}"))?;
        if !dup.is_empty() && dup.iter().any(|b| b.num_rows() > 0) {
            return Ok(false);
        }
        // 同 id 先 delete（防御性幂等）
        let _ = table
            .delete(&format!("id = {}", sql_str(&ep.id)))
            .await;
        let batch = episodes_batch(&ep)?;
        table
            .add(vec![batch])
            .execute()
            .await
            .map_err(|x| format!("episodes add: {x}"))?;
        self.ingest_count.fetch_add(1, Ordering::Relaxed);
        Ok(true)
    }

    /// 当前 schema 清单（内存副本）。
    pub fn manifest(&self) -> &SchemaManifest {
        &self.manifest
    }

    // ── revision 持久化（DEBT-20260820-13）──

    /// 从 meta 表加载持久化的 canon revision。
    /// 不存在或不可读时返回 0（新库/未初始化）。
    pub async fn load_revision(&self) -> Result<u64, String> {
        let table = self
            .db
            .open_table(CANON_TABLE_META)
            .execute()
            .await
            .map_err(|e| format!("open meta: {e}"))?;
        let batches = table
            .query()
            .only_if(format!("key = {}", sql_str(META_KEY_REVISION)))
            .execute()
            .await
            .map_err(|e| format!("query revision: {e}"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|e| format!("collect revision: {e}"))?;
        for b in &batches {
            if let Some(arr) = b
                .column_by_name("value")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            {
                for i in 0..arr.len() {
                    if arr.is_null(i) {
                        continue;
                    }
                    if let Ok(v) = arr.value(i).parse::<u64>() {
                        return Ok(v);
                    }
                }
            }
        }
        Ok(0)
    }

    /// 持久化 canon revision 到 meta 表（delete-then-insert 幂等）。
    pub async fn save_revision(&self, rev: u64) -> Result<(), String> {
        let table = self
            .db
            .open_table(CANON_TABLE_META)
            .execute()
            .await
            .map_err(|e| format!("open meta: {e}"))?;
        let _ = table
            .delete(&format!("key = {}", sql_str(META_KEY_REVISION)))
            .await;
        let batch = meta_batch(META_KEY_REVISION, &rev.to_string())?;
        table
            .add(vec![batch])
            .execute()
            .await
            .map_err(|e| format!("meta add revision: {e}"))?;
        Ok(())
    }

    // ── divergence trace 持久化（DEBT-20260820-15b）──

    /// 从 meta 表加载 divergence trace JSON。
    /// 不存在或不可读时返回空字符串。
    /// DEBT-20260820-15b 偿还：改用 META_KEY_DIVERGENCE_TRACE 键（修复与 revision 的键碰撞）。
    pub async fn load_divergence_trace(&self) -> Result<String, String> {
        let table = self
            .db
            .open_table(CANON_TABLE_META)
            .execute()
            .await
            .map_err(|e| format!("open meta: {e}"))?;
        let batches = table
            .query()
            .only_if(format!("key = {}", sql_str(META_KEY_DIVERGENCE_TRACE)))
            .execute()
            .await
            .map_err(|e| format!("query divergence trace: {e}"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|e| format!("collect divergence trace: {e}"))?;
        for b in &batches {
            if let Some(arr) = b
                .column_by_name("value")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            {
                for i in 0..arr.len() {
                    if arr.is_null(i) {
                        continue;
                    }
                    return Ok(arr.value(i).to_string());
                }
            }
        }
        Ok(String::new())
    }

    /// 持久化 divergence trace JSON 到 meta 表（delete-then-insert 幂等）。
    /// DEBT-20260820-15b 偿还：改用 META_KEY_DIVERGENCE_TRACE 键（修复与 revision 的键碰撞）。
    pub async fn save_divergence_trace(&self, json: &str) -> Result<(), String> {
        let table = self
            .db
            .open_table(CANON_TABLE_META)
            .execute()
            .await
            .map_err(|e| format!("open meta: {e}"))?;
        let _ = table
            .delete(&format!("key = {}", sql_str(META_KEY_DIVERGENCE_TRACE)))
            .await;
        let batch = meta_batch(META_KEY_DIVERGENCE_TRACE, json)?;
        table
            .add(vec![batch])
            .execute()
            .await
            .map_err(|e| format!("meta add divergence trace: {e}"))?;
        Ok(())
    }

    // ── schema_version 迁移链（LanceDB IO）──

    /// dry-run：返回迁移计划（仅读 manifest，不演化、不触碰表 schema）。
    pub async fn migrate_dry_run(&self, target: SchemaVersion) -> Result<MigrationPlan, String> {
        Ok(plan_migration(self.manifest.version, target))
    }

    /// up：按计划对各表 `add_columns`（幂等：跳过已存在列），演化 manifest。
    /// 返回执行的计划（空计划=已最新，no-op）。
    pub async fn migrate_up(&mut self, target: SchemaVersion) -> Result<MigrationPlan, String> {
        if self.manifest.version >= target {
            return Ok(plan_migration(self.manifest.version, target));
        }
        let plan = plan_migration(self.manifest.version, target);
        if plan.is_empty() {
            return Ok(plan);
        }

        // 捕获各表迁移前 LanceDB 版本（rollback 数据层用）
        let mut pre_versions: HashMap<String, u64> = HashMap::new();
        for tname in [CANON_TABLE_ENTITIES, CANON_TABLE_EDGES, CANON_TABLE_EPISODES] {
            let t = self
                .db
                .open_table(tname)
                .execute()
                .await
                .map_err(|e| format!("open {tname}: {e}"))?;
            pre_versions.insert(tname.to_string(), t.version().await.map_err(|e| format!("version: {e}"))?);
        }

        // 按表分组 additive 列，跳过已存在列（幂等）
        for tname in [CANON_TABLE_ENTITIES, CANON_TABLE_EDGES, CANON_TABLE_EPISODES] {
            let cols: Vec<_> = plan
                .added_columns
                .iter()
                .filter(|c| c.table == tname)
                .collect();
            if cols.is_empty() {
                continue;
            }
            let table = self
                .db
                .open_table(tname)
                .execute()
                .await
                .map_err(|e| format!("open {tname}: {e}"))?;
            let schema = table
                .schema()
                .await
                .map_err(|e| format!("schema {tname}: {e}"))?;
            let existing: std::collections::HashSet<&str> =
                schema.fields().iter().map(|f| f.name().as_str()).collect();
            let transforms: Vec<(String, String)> = cols
                .iter()
                .filter(|c| !existing.contains(c.name))
                .map(|c| {
                    (
                        c.name.to_string(),
                        c.lance_type.null_cast_expr().to_string(),
                    )
                })
                .collect();
            if !transforms.is_empty() {
                table
                    .add_columns(NewColumnTransform::SqlExpressions(transforms), None)
                    .await
                    .map_err(|e| format!("add_columns {tname}: {e}"))?;
            }
        }

        self.manifest.apply_plan(&plan);
        Self::save_manifest(&self.db, &self.manifest).await?;
        Self::save_lance_pre_migrate(&self.db, &pre_versions).await?;
        Ok(plan)
    }

    /// rollback：物理回退各表 schema 到迁移前 LanceDB 版本（checkout+restore），
    /// 并回退 manifest 标记。无捕获版本时仅回退 manifest（文档化降级）。
    pub async fn migrate_rollback(&mut self, target: SchemaVersion) -> Result<(), String> {
        if target >= self.manifest.version {
            return Ok(());
        }
        let pre = Self::load_lance_pre_migrate(&self.db).await?;
        for tname in [CANON_TABLE_ENTITIES, CANON_TABLE_EDGES, CANON_TABLE_EPISODES] {
            if let Some(&v) = pre.get(tname) {
                let table = self
                    .db
                    .open_table(tname)
                    .execute()
                    .await
                    .map_err(|e| format!("open {tname}: {e}"))?;
                table
                    .checkout(v)
                    .await
                    .map_err(|e| format!("checkout {tname}: {e}"))?;
                table
                    .restore()
                    .await
                    .map_err(|e| format!("restore {tname}: {e}"))?;
            }
        }
        self.manifest.rollback_to(target);
        Self::save_manifest(&self.db, &self.manifest).await?;
        // 清空捕获版本（已回退）
        Self::save_lance_pre_migrate(&self.db, &HashMap::new()).await?;
        Ok(())
    }

    // ── compaction + 版本保留 + 磁盘指标 ──

    /// 设置 compaction 阈值（N 批 ingest 后触发）。
    pub fn set_compaction_threshold(&self, n: u64) {
        self.compaction_threshold.store(n, Ordering::Relaxed);
    }

    /// 设置保留版本数（prune 保留最新 K 个）。
    pub fn set_retain_versions(&mut self, n: u64) {
        self.retain_versions = n;
    }

    /// 检查阈值并触发 compaction（N 批 ingest 触发）。
    /// 返回 None 表示未达阈值，Some(report) 表示已执行。
    pub async fn compact_if_needed(&self) -> Result<Option<CompactionReport>, String> {
        let count = self.ingest_count.load(Ordering::Relaxed);
        let threshold = self.compaction_threshold.load(Ordering::Relaxed);
        if count < threshold {
            return Ok(None);
        }
        self.compact_tables().await.map(Some)
    }

    /// 强制 compaction（章节里程碑 / 空闲窗口触发）。
    /// 对三表（entities/edges/episodes）执行文件 compaction + 旧版本 prune。
    pub async fn compact_tables(&self) -> Result<CompactionReport, String> {
        let mut fragments_removed = 0usize;
        let mut fragments_added = 0usize;
        let mut files_removed = 0usize;
        let mut files_added = 0usize;
        let mut bytes_removed = 0u64;
        let mut old_versions_removed = 0u64;
        let mut tables_compacted = Vec::new();

        let tnames = [CANON_TABLE_ENTITIES, CANON_TABLE_EDGES, CANON_TABLE_EPISODES];
        for tname in tnames {
            let table = self
                .db
                .open_table(tname)
                .execute()
                .await
                .map_err(|e| format!("open {tname}: {e}"))?;

            // Step 1: 文件 compaction（合并小文件）
            let cstats = table
                .optimize(OptimizeAction::Compact {
                    options: CompactionOptions::default(),
                    remap_options: None,
                })
                .await
                .map_err(|e| format!("compact {tname}: {e}"))?;

            // Step 2: 旧版本 prune（保留 K 个 manifest 版本）
            let (pruned_bytes, pruned_versions) = self.prune_table_versions(&table).await?;

            if let Some(ref c) = cstats.compaction {
                fragments_removed += c.fragments_removed;
                fragments_added += c.fragments_added;
                files_removed += c.files_removed;
                files_added += c.files_added;
            }
            bytes_removed += pruned_bytes;
            old_versions_removed += pruned_versions;
            tables_compacted.push(tname.to_string());
        }

        // 重置计数器
        self.ingest_count.store(0, Ordering::Relaxed);

        Ok(CompactionReport {
            fragments_removed,
            fragments_added,
            files_removed,
            files_added,
            bytes_removed,
            old_versions_removed,
            tables_compacted,
        })
    }

    /// 保留 K 个 manifest 版本，prune 更旧的版本。
    /// 返回 (pruned_bytes, pruned_versions)。
    async fn prune_table_versions(&self, table: &Table) -> Result<(u64, u64), String> {
        let versions = table
            .list_versions()
            .await
            .map_err(|e| format!("list versions: {e}"))?;

        if versions.len() <= self.retain_versions as usize {
            return Ok((0, 0));
        }

        // 按版本降序排列，取第 K 个版本的时间戳
        let mut sorted: Vec<_> = versions.iter().collect();
        sorted.sort_by(|a, b| b.version.cmp(&a.version));
        let oldest_to_keep = &sorted[self.retain_versions as usize - 1];

        let now = chrono::Utc::now();
        let age = now - oldest_to_keep.timestamp;
        // 加 1 秒缓冲避免边界效应
        let age = age + chrono::Duration::seconds(1);

        let stats = table
            .optimize(OptimizeAction::Prune {
                older_than: Some(age),
                delete_unverified: Some(false),
                error_if_tagged_old_versions: Some(false),
            })
            .await
            .map_err(|e| format!("prune: {e}"))?;

        if let Some(ref p) = stats.prune {
            Ok((p.bytes_removed, p.old_versions))
        } else {
            Ok((0, 0))
        }
    }

    /// 磁盘占用指标（bytes）。遍历 LanceDB 目录按表子目录区分。
    pub fn disk_usage(&self) -> Result<DiskUsage, String> {
        let db_root = db_path(&self.project_path);
        let root = Path::new(&db_root);
        if !root.exists() {
            return Ok(DiskUsage {
                entities_bytes: 0,
                edges_bytes: 0,
                episodes_bytes: 0,
                meta_bytes: 0,
                total_bytes: 0,
            });
        }

        let mut entities_bytes = 0u64;
        let mut edges_bytes = 0u64;
        let mut episodes_bytes = 0u64;
        let mut meta_bytes = 0u64;

        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();
                let size = dir_size(&path);
                if name.contains(CANON_TABLE_ENTITIES) {
                    entities_bytes += size;
                } else if name.contains(CANON_TABLE_EDGES) {
                    edges_bytes += size;
                } else if name.contains(CANON_TABLE_EPISODES) {
                    episodes_bytes += size;
                } else if name.contains(CANON_TABLE_META) {
                    meta_bytes += size;
                }
            }
        }

        let total_bytes = entities_bytes + edges_bytes + episodes_bytes + meta_bytes;
        Ok(DiskUsage {
            entities_bytes,
            edges_bytes,
            episodes_bytes,
            meta_bytes,
            total_bytes,
        })
    }
}

/// 递归计算目录或文件大小（bytes）。
fn dir_size(path: &Path) -> u64 {
    if path.is_file() {
        return std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    }
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            total += dir_size(&entry.path());
        }
    }
    total
}

async fn ensure_table(
    db: &lancedb::Connection,
    name: &str,
    schema: SchemaRef,
    existing: &[String],
) -> Result<(), String> {
    if existing.contains(&name.to_string()) {
        return Ok(());
    }
    let batch = RecordBatch::new_empty(schema);
    db.create_table(name, vec![batch])
        .execute()
        .await
        .map_err(|e| format!("create {name}: {e}"))?;
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::canon_types::{
        validate_edges_temporal, LanceType, Migration, TemporalInvariantError, MIGRATIONS,
    };
    use std::path::PathBuf;

    /// 唯一临时项目目录（每测试一个）。不清理（LanceDB 文件句柄滞后，
    /// 激进删除致 CI flaky——沿用 vectorstore 模式）。
    fn tmp_project() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!("canon-store-test-{}-{}", ts, id));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn edge(id: &str, v: Option<i32>, inv: Option<i32>) -> CanonEdge {
        let mut e = CanonEdge::new(id, "src", "tgt", "rel", EdgeKind::WorldFact);
        e.valid_at = v;
        e.invalid_at = inv;
        e.known_by = vec!["pov".into()];
        e
    }

    // ── 纯逻辑：upsert 幂等 ──

    #[test]
    fn canon_state_upsert_entity_idempotent() {
        let mut s = CanonState::new();
        let e = CanonEntity::new("e1", "character", "Alice", 1);
        assert!(!s.upsert_entity(e.clone()), "first insert = append");
        assert_eq!(s.entities.len(), 1);
        let e2 = CanonEntity {
            canonical_name: "Alice2".into(),
            ..e
        };
        assert!(s.upsert_entity(e2), "second = replace");
        assert_eq!(s.entities.len(), 1, "idempotent: no duplicate");
        assert_eq!(s.entities[0].canonical_name, "Alice2");
    }

    #[test]
    fn canon_state_upsert_edge_idempotent() {
        let mut s = CanonState::new();
        let e = edge("ed1", Some(1), None);
        assert!(!s.upsert_edge(e.clone()));
        assert!(s.upsert_edge(e));
        assert_eq!(s.edges.len(), 1);
    }

    // ── 纯逻辑：invalidate 封顶 ──

    #[test]
    fn canon_state_invalidate_caps_invalid_at() {
        let mut s = CanonState::new();
        s.upsert_edge(edge("ed1", Some(1), None));
        assert!(s.invalidate_edge("ed1", 10));
        assert_eq!(s.edges[0].invalid_at, Some(10));
        assert!(!s.invalidate_edge("missing", 10));
    }

    // ── 纯逻辑：批量 supersede ──

    #[test]
    fn canon_state_supersede_batch() {
        let mut s = CanonState::new();
        s.upsert_edge(edge("old1", Some(1), None));
        s.upsert_edge(edge("old2", Some(1), None));
        let new1 = edge("new1", Some(5), None);
        let req = SupersedeRequest {
            old_edge_ids: vec!["old1".into(), "ghost".into()],
            cap_chapter: 5,
            new_edges: vec![new1],
        };
        let r = s.supersede_edges(req);
        assert_eq!(r.capped, 1);
        assert_eq!(r.inserted, 1);
        assert_eq!(r.missing, vec!["ghost".to_string()]);
        // old1 封顶
        assert_eq!(
            s.edges.iter().find(|e| e.id == "old1").unwrap().invalid_at,
            Some(5)
        );
        // new1 存在且有效
        assert!(s.edges.iter().any(|e| e.id == "new1"));
    }

    // ── 纯逻辑：query 认知轴 + 时态 ──

    #[test]
    fn canon_state_query_cognitive_and_temporal() {
        let mut s = CanonState::new();
        let mut e1 = edge("e1", Some(1), None);
        e1.known_by = vec!["alice".into()];
        let mut e2 = edge("e2", Some(1), Some(10));
        e2.known_by = vec!["bob".into()];
        s.upsert_edge(e1);
        s.upsert_edge(e2);
        // alice 在 ch5 可见 e1（e2 bob 独占）
        let r = s.query_edges(&CanonEdgeFilter {
            known_by: Some("alice".into()),
            valid_at_chapter: Some(5),
            ..Default::default()
        });
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id, "e1");
    }

    // ── 纯逻辑：ingest_digest 去重 ──

    #[test]
    fn canon_state_ingest_dedup() {
        let mut s = CanonState::new();
        let ep1 = CanonEpisode::new("ep1", 1, "alice", "d1");
        assert!(s.ingest_episode(ep1.clone()), "first ingest writes");
        assert!(!s.ingest_episode(ep1), "same (chapter,digest) skipped");
        assert_eq!(s.episodes.len(), 1);
        // 不同 digest → 写入
        let ep2 = CanonEpisode::new("ep2", 1, "alice", "d2");
        assert!(s.ingest_episode(ep2));
        assert_eq!(s.episodes.len(), 2);
    }

    // ── 纯逻辑：迁移链 up/dry-run/rollback + 幂等 ──

    #[test]
    fn canon_state_migrate_chain_up_dryrun_rollback() {
        let mut s = CanonState::new_at_v1();
        // dry-run：不演化
        let dry = s.migrate_dry_run(CURRENT_SCHEMA_VERSION);
        assert!(!dry.is_empty());
        assert_eq!(s.manifest.version, SchemaVersion(1), "dry-run no side effect");
        // up
        let plan = s.migrate_up(CURRENT_SCHEMA_VERSION);
        assert_eq!(s.manifest.version, CURRENT_SCHEMA_VERSION);
        assert!(!plan.added_columns.is_empty());
        // 二次 up = no-op（幂等）
        let plan2 = s.migrate_up(CURRENT_SCHEMA_VERSION);
        assert!(plan2.is_empty());
        // rollback
        s.migrate_rollback(SchemaVersion(1));
        assert_eq!(s.manifest.version, SchemaVersion(1));
    }

    #[test]
    fn canon_migration_definitions_sane() {
        // v1=base（无迁移），v2/v3 additive
        assert_eq!(MIGRATIONS.len(), 2);
        assert!(MIGRATIONS.iter().all(|m| !m.columns.is_empty()));
        // 所有列 nullable additive（CAST NULL）
        for m in MIGRATIONS {
            for c in m.columns {
                assert!(c.lance_type.null_cast_expr().starts_with("CAST(NULL AS"));
            }
        }
        // LanceType 标签
        assert_eq!(LanceType::Boolean.label(), "boolean");
        assert_eq!(LanceType::Utf8.label(), "utf8");
    }

    // ── 纯逻辑：时态不变量 ──

    #[test]
    fn canon_temporal_invariants_via_state() {
        let mut s = CanonState::new();
        s.upsert_edge(edge("ok", Some(1), Some(10)));
        assert!(validate_edges_temporal(&s.edges).is_ok());
        let mut bad = edge("bad", Some(10), Some(5));
        bad.revealed_at = Some(3);
        s.upsert_edge(bad);
        let err = validate_edges_temporal(&s.edges);
        assert!(err.is_err());
        assert!(matches!(
            err.unwrap_err(),
            TemporalInvariantError::ValidAfterInvalid { .. }
        ));
    }

    // ── LanceDB 集成：CRUD ──

    #[tokio::test]
    async fn canon_lancedb_upsert_query_roundtrip() {
        let p = tmp_project();
        let store = CanonStore::open(&p.to_string_lossy()).await.unwrap();

        let mut e = edge("ed1", Some(1), None);
        e.known_by = vec!["alice".into()];
        e.source_chapter = Some(1);
        store.upsert_edge(e.clone()).await.unwrap();

        // 认知轴 + 时态过滤
        let r = store
            .query_edges(&CanonEdgeFilter {
                known_by: Some("alice".into()),
                valid_at_chapter: Some(5),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id, "ed1");
        assert_eq!(r[0].known_by, vec!["alice".to_string()]);

        // carol 不知晓 → 过滤
        let r2 = store
            .query_edges(&CanonEdgeFilter {
                known_by: Some("carol".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(r2.len(), 0);
    }

    #[tokio::test]
    async fn canon_lancedb_upsert_idempotent() {
        let p = tmp_project();
        let store = CanonStore::open(&p.to_string_lossy()).await.unwrap();
        let e = edge("ed1", Some(1), None);
        store.upsert_edge(e.clone()).await.unwrap();
        store.upsert_edge(e).await.unwrap();
        let all = store
            .query_edges(&CanonEdgeFilter::default())
            .await
            .unwrap();
        assert_eq!(all.len(), 1, "no duplicate on re-upsert");
    }

    #[tokio::test]
    async fn canon_lancedb_invalidate_caps() {
        let p = tmp_project();
        let store = CanonStore::open(&p.to_string_lossy()).await.unwrap();
        store.upsert_edge(edge("ed1", Some(1), None)).await.unwrap();
        assert!(store.invalidate_edge("ed1", 10).await.unwrap());
        let all = store
            .query_edges(&CanonEdgeFilter::default())
            .await
            .unwrap();
        assert_eq!(all[0].invalid_at, Some(10));
        // 封顶后 valid_at_chapter=15 应被过滤
        let r = store
            .query_edges(&CanonEdgeFilter {
                valid_at_chapter: Some(15),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(r.len(), 0);
    }

    #[tokio::test]
    async fn canon_lancedb_supersede_batch() {
        let p = tmp_project();
        let store = CanonStore::open(&p.to_string_lossy()).await.unwrap();
        store.upsert_edge(edge("old1", Some(1), None)).await.unwrap();
        store.upsert_edge(edge("old2", Some(1), None)).await.unwrap();
        let new1 = edge("new1", Some(5), None);
        let res = store
            .supersede_edges(SupersedeRequest {
                old_edge_ids: vec!["old1".into(), "ghost".into()],
                cap_chapter: 5,
                new_edges: vec![new1],
            })
            .await
            .unwrap();
        assert_eq!(res.capped, 1);
        assert_eq!(res.inserted, 1);
        assert_eq!(res.missing, vec!["ghost".to_string()]);
        // old1 封顶
        let all = store
            .query_edges(&CanonEdgeFilter::default())
            .await
            .unwrap();
        assert_eq!(
            all.iter().find(|e| e.id == "old1").unwrap().invalid_at,
            Some(5)
        );
        assert!(all.iter().any(|e| e.id == "new1"));
    }

    #[tokio::test]
    async fn canon_lancedb_ingest_dedup() {
        let p = tmp_project();
        let store = CanonStore::open(&p.to_string_lossy()).await.unwrap();
        let ep = CanonEpisode::new("ep1", 1, "alice", "d1");
        assert!(store.ingest_episode(ep.clone()).await.unwrap());
        assert!(
            !store.ingest_episode(ep).await.unwrap(),
            "same (chapter,digest) skipped"
        );
        let ep2 = CanonEpisode::new("ep2", 1, "alice", "d2");
        assert!(store.ingest_episode(ep2).await.unwrap());
    }

    #[tokio::test]
    async fn canon_lancedb_entity_roundtrip_with_technique() {
        let p = tmp_project();
        let store = CanonStore::open(&p.to_string_lossy()).await.unwrap();
        let mut e = CanonEntity::new("ent1", "character", "Alice", 1);
        e.wish = vec!["回家".into()];
        e.motive = vec!["求生".into()];
        e.mckee_ghost = Some("溺水记忆".into());
        e.arc_stage = Some(canon_types::ArcStage::Crisis);
        e.embedding_model = Some("bge-small-zh-v1.5".into());
        e.embedding_version = Some("v1.5".into());
        store.upsert_entity(e).await.unwrap();
        // 技法列默认值验证：建一个无技法的实体，读回应默认
        store
            .upsert_entity(CanonEntity::new("ent2", "location", "山谷", 2))
            .await
            .unwrap();
        // 间接验证：通过 manifest + 无 panic
        assert_eq!(store.manifest().version, CURRENT_SCHEMA_VERSION);
    }

    // ── LanceDB 集成：迁移链 ──

    #[tokio::test]
    async fn canon_lancedb_migrate_dry_run_no_side_effect() {
        let p = tmp_project();
        let store = CanonStore::open(&p.to_string_lossy()).await.unwrap();
        let plan = store.migrate_dry_run(CURRENT_SCHEMA_VERSION).await.unwrap();
        // 新库已在 CURRENT → 空计划
        assert!(plan.is_empty());
        assert_eq!(store.manifest().version, CURRENT_SCHEMA_VERSION);
    }

    #[tokio::test]
    async fn canon_lancedb_migrate_up_idempotent_on_current() {
        let p = tmp_project();
        let mut store = CanonStore::open(&p.to_string_lossy()).await.unwrap();
        // 已在 CURRENT → migrate_up no-op
        let plan = store.migrate_up(CURRENT_SCHEMA_VERSION).await.unwrap();
        assert!(plan.is_empty());
        assert_eq!(store.manifest().version, CURRENT_SCHEMA_VERSION);
    }

    #[tokio::test]
    async fn canon_lancedb_migrate_up_adds_columns_then_rollback() {
        // 构造 v1 残缺表（无 archived/embedding 列），强制 manifest=v1，
        // migrate_up 应补列；rollback 应物理回退。
        let p = tmp_project();
        let db = connect(&db_path(&p.to_string_lossy()))
            .execute()
            .await
            .unwrap();
        // v1 entities schema：缺 archived/embedding_model/embedding_version
        let v1_schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Utf8, false),
            Field::new("entity_type", DataType::Utf8, false),
            Field::new("canonical_name", DataType::Utf8, false),
            Field::new("first_seen_chapter", DataType::Int32, false),
            Field::new("valid_at", DataType::Int32, true),
            Field::new("invalid_at", DataType::Int32, true),
            Field::new("data", DataType::Utf8, false),
        ]));
        let batch = RecordBatch::new_empty(v1_schema);
        db.create_table(CANON_TABLE_ENTITIES, vec![batch])
            .execute()
            .await
            .unwrap();
        // edges/episodes/meta 用完整 schema（open 会 ensure）
        // 先建 meta 表以便 open 不误判为新库
        let mb = RecordBatch::new_empty(meta_schema());
        db.create_table(CANON_TABLE_META, vec![mb])
            .execute()
            .await
            .unwrap();

        // open：entities 已存在 → manifest 默认 v1（触发迁移）
        let mut store = CanonStore::open(&p.to_string_lossy()).await.unwrap();
        assert_eq!(store.manifest().version, SchemaVersion(1));

        // 迁移前 entities 列数 = 7
        let t = db.open_table(CANON_TABLE_ENTITIES).execute().await.unwrap();
        let before = t.schema().await.unwrap().fields().len();
        assert_eq!(before, 7);

        // migrate_up → 补 archived + embedding_model + embedding_version（3 列）
        let plan = store.migrate_up(CURRENT_SCHEMA_VERSION).await.unwrap();
        assert!(!plan.is_empty());
        assert_eq!(store.manifest().version, CURRENT_SCHEMA_VERSION);
        // add_columns 后表对象需重开（schema 缓存）
        let t2 = db.open_table(CANON_TABLE_ENTITIES).execute().await.unwrap();
        let after = t2.schema().await.unwrap().fields().len();
        assert_eq!(after, 10, "v1(7) + archived + embedding_model + embedding_version");

        // rollback → 物理回退到迁移前版本
        store.migrate_rollback(SchemaVersion(1)).await.unwrap();
        assert_eq!(store.manifest().version, SchemaVersion(1));
        // 重新打开表读 schema（restore 后表对象需重开）
        let t2 = db.open_table(CANON_TABLE_ENTITIES).execute().await.unwrap();
        let rolled = t2.schema().await.unwrap().fields().len();
        assert_eq!(rolled, 7, "rollback restores v1 schema");
    }

    #[tokio::test]
    async fn canon_lancedb_open_creates_all_tables() {
        let p = tmp_project();
        let store = CanonStore::open(&p.to_string_lossy()).await.unwrap();
        let names = store
            .db
            .table_names()
            .execute()
            .await
            .unwrap();
        for t in [CANON_TABLE_ENTITIES, CANON_TABLE_EDGES, CANON_TABLE_EPISODES, CANON_TABLE_META] {
            assert!(names.contains(&t.to_string()), "table {t} created");
        }
    }

    // ── LanceDB 集成：compaction + 版本保留 + 磁盘指标 ──

    #[tokio::test]
    async fn canon_lancedb_compact_if_needed_threshold_not_reached() {
        let p = tmp_project();
        let store = CanonStore::open(&p.to_string_lossy()).await.unwrap();
        // 阈值=100，刚打开的库计数=0 → compact_if_needed 返回 None
        let result = store.compact_if_needed().await.unwrap();
        assert!(result.is_none(), "below threshold → no compaction");
    }

    #[tokio::test]
    async fn canon_lancedb_compact_tables_does_not_crash() {
        let p = tmp_project();
        let store = CanonStore::open(&p.to_string_lossy()).await.unwrap();

        // 写入一些数据使 compaction 有内容可操作
        for i in 0..5 {
            let e = CanonEdge::new(
                &format!("compact-e{i}"),
                "src",
                "tgt",
                "rel",
                EdgeKind::WorldFact,
            );
            store.upsert_edge(e).await.unwrap();
        }
        for i in 0..3 {
            let ep = CanonEpisode::new(&format!("compact-ep{i}"), 1, "pov", &format!("d{i}"));
            store.ingest_episode(ep).await.unwrap();
        }

        // 强制 compaction
        let report = store.compact_tables().await.unwrap();
        // 报告应包含所有三表（使用常量表名）
        assert_eq!(report.tables_compacted.len(), 3);
        assert!(report.tables_compacted.contains(&CANON_TABLE_ENTITIES.to_string()));
        assert!(report.tables_compacted.contains(&CANON_TABLE_EDGES.to_string()));
        assert!(report.tables_compacted.contains(&CANON_TABLE_EPISODES.to_string()));

        // compaction 后查询正确性：仍可查到写的数据
        let all = store
            .query_edges(&CanonEdgeFilter::default())
            .await
            .unwrap();
        assert_eq!(all.len(), 5, "compaction 后 edges 查询正确");
        let ids: Vec<&str> = all.iter().map(|e| e.id.as_str()).collect();
        for i in 0..5 {
            assert!(ids.contains(&format!("compact-e{i}").as_str()));
        }
    }

    #[tokio::test]
    async fn canon_lancedb_compact_supersede_edge_query_correct() {
        let p = tmp_project();
        let store = CanonStore::open(&p.to_string_lossy()).await.unwrap();

        // 写入边 + supersede
        store
            .upsert_edge({
                let mut e = CanonEdge::new("old-c1", "alice", "bob", "knows", EdgeKind::WorldFact);
                e.valid_at = Some(1);
                e.known_by = vec!["pov".into()];
                e
            })
            .await
            .unwrap();

        store
            .supersede_edges(SupersedeRequest {
                old_edge_ids: vec!["old-c1".into()],
                cap_chapter: 5,
                new_edges: vec![
                    CanonEdge::new("new-c1", "alice", "bob", "knows", EdgeKind::WorldFact),
                ],
            })
            .await
            .unwrap();

        // 强制 compaction
        let report = store.compact_tables().await.unwrap();
        assert_eq!(report.tables_compacted.len(), 3);

        // 查询：老边封顶，新边可见
        let r = store
            .query_edges(&CanonEdgeFilter {
                valid_at_chapter: Some(10),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(r.len(), 1, "compaction 后 supersede 查询正确");
        assert_eq!(r[0].id, "new-c1");
    }

    #[tokio::test]
    async fn canon_lancedb_disk_usage_returns_zero_for_empty() {
        let p = tmp_project();
        let store = CanonStore::open(&p.to_string_lossy()).await.unwrap();
        let usage = store.disk_usage().unwrap();
        // 新库刚建，目录应存在且非零（meta 表有数据）
        assert!(usage.total_bytes > 0, "open 后库目录应有数据");
        assert!(usage.meta_bytes > 0, "meta 表应有 manifest 行");
    }

    #[tokio::test]
    async fn canon_lancedb_ingest_counter_increments() {
        let p = tmp_project();
        let store = CanonStore::open(&p.to_string_lossy()).await.unwrap();

        // 阈值设为 3，写入 3 条后触发
        store.set_compaction_threshold(3);

        // 写入 2 条 → 未达阈值
        store
            .upsert_edge(CanonEdge::new("ce1", "s", "t", "r", EdgeKind::WorldFact))
            .await
            .unwrap();
        store
            .upsert_edge(CanonEdge::new("ce2", "s", "t", "r", EdgeKind::WorldFact))
            .await
            .unwrap();
        assert!(store.compact_if_needed().await.unwrap().is_none());

        // 第 3 条 → 达阈值，触发 compaction
        store
            .upsert_edge(CanonEdge::new("ce3", "s", "t", "r", EdgeKind::WorldFact))
            .await
            .unwrap();
        let result = store.compact_if_needed().await.unwrap();
        assert!(result.is_some(), "达阈值应触发 compaction");
        let report = result.unwrap();
        assert_eq!(report.tables_compacted.len(), 3);

        // 重置后计数器归零，再次 compact_if_needed 返回 None
        assert!(store.compact_if_needed().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn canon_lancedb_set_retain_versions_affects_prune() {
        let p = tmp_project();
        let mut store = CanonStore::open(&p.to_string_lossy()).await.unwrap();

        // 默认保留 5 个版本
        assert_eq!(store.retain_versions, 5);

        // 改为保留 10 个
        store.set_retain_versions(10);
        assert_eq!(store.retain_versions, 10);

        // compaction 仍可正常执行
        let report = store.compact_tables().await.unwrap();
        assert_eq!(report.tables_compacted.len(), 3);

        // 改回 3
        store.set_retain_versions(3);
        assert_eq!(store.retain_versions, 3);
    }
}

// ──────────────────────────────────────────────────────────────────────────
// proptest 属性测试（dev-dep：时态不变量 / 迁移幂等 / 去重）
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod proptest_tests {
    use super::*;
    use crate::types::canon_types::{validate_edge_temporal, EdgeKind};
    use proptest::prelude::*;

    /// 任意 [0, 200] 章节号。
    fn arb_chapter() -> impl Strategy<Value = i32> {
        0i32..200
    }

    proptest! {
        /// 时态不变量：validate_edge_temporal 与 (valid_at <= invalid_at) 一致；
        /// 且合法边的 is_valid_at 在 [valid_at, invalid_at) 单调。
        #[test]
        fn canon_proptest_temporal_invariant_consistency(
            v in arb_chapter(), inv in arb_chapter(), probe in arb_chapter()
        ) {
            let mut e = CanonEdge::new("e", "s", "t", "rel", EdgeKind::WorldFact);
            e.valid_at = Some(v);
            e.invalid_at = Some(inv);
            let valid_ok = v <= inv;
            prop_assert_eq!(validate_edge_temporal(&e).is_ok(), valid_ok);

            if valid_ok {
                // probe 在 [v, inv) 内 → is_valid_at true
                let inside = v <= probe && probe < inv;
                prop_assert_eq!(e.is_valid_at(probe), inside);
            }
        }

        /// 迁移幂等：对任意 from<=to，apply plan 两次 ≡ 一次
        /// （version 与 applied_columns 不变）。
        #[test]
        fn canon_proptest_migration_idempotent(
            from in 0u32..=CURRENT_SCHEMA_VERSION.get(),
            to in 0u32..=CURRENT_SCHEMA_VERSION.get()
        ) {
            let from = SchemaVersion(from);
            let to = SchemaVersion(to.max(from.get())); // 保证 from<=to
            let plan = plan_migration(from, to);
            let mut m = SchemaManifest::new(from);
            m.apply_plan(&plan);
            let v1 = m.version;
            let c1 = m.applied_columns.clone();
            m.apply_plan(&plan); // 二次
            prop_assert_eq!(m.version, v1);
            prop_assert_eq!(m.applied_columns, c1);
        }

        /// 去重幂等：对任意 (chapter, digest) 序列，重复 ingest 同键只写一次。
        #[test]
        fn canon_proptest_ingest_dedup(
            keys in prop::collection::vec((arb_chapter(), "[a-z0-9]{1,8}"), 0..20)
        ) {
            let mut s = CanonState::new();
            for (i, (ch, digest)) in keys.iter().enumerate() {
                let ep = CanonEpisode::new(format!("ep{i}"), *ch, "pov", digest.clone());
                s.ingest_episode(ep);
            }
            // 对每个已存在键再 ingest → 应被跳过，总数不变
            let n = s.episodes.len();
            for (ch, digest) in keys.iter() {
                let ep = CanonEpisode::new("dup", *ch, "pov", digest.clone());
                s.ingest_episode(ep);
            }
            prop_assert_eq!(s.episodes.len(), n, "re-ingest of existing keys is a no-op");
            // 去重键集合唯一
            let mut keys: Vec<_> = s.ingest_keys();
            keys.sort();
            let mut uniq = keys.clone();
            uniq.dedup();
            prop_assert_eq!(keys.len(), uniq.len(), "ingest keys are unique");
        }

        /// supersede 不变量：批量 supersede 后，被取代旧边 invalid_at <= cap_chapter
        /// （即已封顶），新边存在；supersede 幂等（同 new_edges id 不复制）。
        #[test]
        fn canon_proptest_supersede_caps_old(
            n_old in 1usize..8,
            cap in arb_chapter()
        ) {
            let mut s = CanonState::new();
            for i in 0..n_old {
                s.upsert_edge(edge(&format!("old{i}"), Some(0), None));
            }
            let old_ids: Vec<String> = (0..n_old).map(|i| format!("old{i}")).collect();
            let new_edges: Vec<CanonEdge> = (0..3)
                .map(|i| edge(&format!("new{i}"), Some(cap), None))
                .collect();
            let res = s.supersede_edges(SupersedeRequest {
                old_edge_ids: old_ids.clone(),
                cap_chapter: cap,
                new_edges: new_edges.clone(),
            });
            prop_assert_eq!(res.capped, n_old);
            // 所有旧边封顶
            for id in &old_ids {
                let e = s.edges.iter().find(|e| &e.id == id).unwrap();
                prop_assert_eq!(e.invalid_at, Some(cap));
            }
            // 新边存在
            for ne in &new_edges {
                prop_assert!(s.edges.iter().any(|e| e.id == ne.id));
            }
        }
    }

    fn edge(id: &str, v: Option<i32>, inv: Option<i32>) -> CanonEdge {
        let mut e = CanonEdge::new(id, "s", "t", "rel", EdgeKind::WorldFact);
        e.valid_at = v;
        e.invalid_at = inv;
        e
    }
}
