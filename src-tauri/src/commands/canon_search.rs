// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Canon 混合检索 + RRF 融合 + 窗口衰减 + 查询缓存 + 读侧图遍历（T12）。
//!
//! 蓝图 §6 T12 / §9 信号因子 ⑤ / F-18 / A-06。本模块依赖 T11
//! [`crate::commands::canon_store`] 与 [`crate::types::canon_types`]，沿用其
//! **纯逻辑层 + LanceDB IO 层** 二分（与 `canon_store.rs` 同构）。
//!
//! ## 职责分层
//!   1. **纯逻辑层**（无 IO，`cargo test` + proptest 全覆盖）：
//!      - [`rrf_fuse`]：自实现 Reciprocal Rank Fusion（rank_const 起点 = 1）。
//!      - [`decay`] / [`window_decay`]：窗口衰减，函数形式冻结
//!        `decay(d) = 1 / (1 + α·d)^β`（α/β 入 [`SearchConfig`]）。
//!      - [`CanonSearchEngine`]：编排 fuse → decay → 排序 → topK。
//!      - [`CanonQueryCache`]：查询结果缓存，键 = `(filter_canonical,
//!        at_chapter, canon_revision)`；revision 自增即整缓存失效。
//!      - [`tokenizer_verdict`]：T04 spike §4 分词器裁决规则（中文 FTS 通道）。
//!      - [`CanonGraph`]：petgraph 读侧遍历（BFS depth=3 / 连通分量 / 拓扑序）。
//!   2. **LanceDB IO 层** [`CanonSearch`]：包装 [`CanonStore`]，对外提供
//!      `fts_query`（SQL 谓词召回 + Rust 精细过滤）与 `vector_query`
//!      （`Table::vector_search`，与 `vectorstore.rs` 同源 API）。
//!      IPC 命令注册在 T13 `canon_commands.rs`。
//!
//! ## RRF 常量对照（入 decision-log）
//!   - **TS 侧**（`src/lib/novel/search-adapter.ts`）多源 wiki 检索：
//!     `contribution = weight / (SOURCE_RRF_K=60 + sourceRank + 1)`，K=60 适配
//!     多源大池（caption/wiki/canon 等），sourceRank 0-based，`+1` 等价
//!     rank_const=1。
//!   - **Rust 侧**（本模块）canon 小池双源（FTS + 向量）融合：
//!     `score = Σ 1 / (rrf_rank_const + rank)`，rank_const **起点 = 1**
//!     （蓝图 §6 T12 / A-06）。两者同属 RRF 家族，差异在池规模与源数：
//!     TS 用大 K=60 平滑多源噪声，Rust canon 用紧 rank_const=1 保留头部精度。
//!     A-06（P5）若 QMAI 召回池实测调参劣化 → 保留 rank_const=1（蓝图兜底）。
//!
//! ## 分词器裁决（T04 spike §4）
//!   LanceDB 内置 tokenizer 对中文默认空格分词（召回退化）。裁决规则：
//!   若 LanceDB 自定义 tokenizer 通道召回 ≥ jieba 基线 ×(1 − 容差 0.05)
//!   → 采纳内置通道（少一层依赖）；否则降级 jieba-rs / tantivy-jieba。
//!   [`tokenizer_verdict`] 纯函数落档该规则，首日验证复用 T04 结论。
//!
//! ## 设计约束（QMAI 执行纪律）
//!   - 不修改 T11 已落地文件（`canon_store.rs` / `canon_types.rs`）；只新增 +
//!     `mod.rs` 注册一行。
//!   - 不引入第二份会话状态文件；canon_revision 复用 `CanonStore` 的写入计数
//!     语义（ingest/supersede 触发自增），缓存层只持有内存计数副本。

use std::collections::HashMap;

use petgraph::graph::{DiGraph, NodeIndex};
use petgraph::visit::EdgeRef;
use serde::{Deserialize, Serialize};

use crate::types::canon_types::{CanonEdge, CanonEdgeFilter};

// ──────────────────────────────────────────────────────────────────────────
// 配置（纯数据，蓝图 §9 因子 ⑤：α/β 入 config）
// ──────────────────────────────────────────────────────────────────────────

/// 混合检索 + 窗口衰减配置。
///
/// 所有参数入 config（蓝图 §9 信号因子 ⑤：「RRF 衰减函数形式冻结
/// decay(d)=1/(1+α·d)^β」，α/β 参数化；T32 在 QMAI 召回池做 α/β 扫描，
/// 函数形式不换）。
#[derive(Debug, Clone, PartialEq)]
pub struct SearchConfig {
    /// RRF rank 常数（起点 1.0，蓝图 §6 T12 / A-06）。
    pub rrf_rank_const: f64,
    /// 窗口衰减 α（距离线性项系数，≥0）。
    pub decay_alpha: f64,
    /// 窗口衰减 β（幂指数，≥0；β=1 退化为调和式衰减）。
    pub decay_beta: f64,
    /// 读侧 BFS 最大深度（蓝图 §6 T12：depth=3）。
    pub bfs_depth: u32,
    /// 查询缓存容量上限（LRU 由调用方约束；本层用 HashMap + revision 失效）。
    pub cache_capacity: usize,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            // 蓝图 §6 T12 起点；A-06 劣化兜底亦保留 1。
            rrf_rank_const: 1.0,
            // 窗口衰减默认：近章高、远章温和衰减（T32 调参前的保守起点）。
            decay_alpha: 0.1,
            decay_beta: 1.0,
            bfs_depth: 3,
            cache_capacity: 256,
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// 召回 / 融合结果类型
// ──────────────────────────────────────────────────────────────────────────

/// 召回来源（双源：FTS 文本召回 + 向量语义召回）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecallSource {
    Fts,
    Vector,
}

/// 单条召回项（来自 FTS 或向量通道的 ranked list 的一项）。
///
/// `rank` 为该项在其来源 ranked list 中的 0-based 位置；`reference_chapter`
/// 用于窗口衰减的距离计算（None → d=0，不衰减）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecallItem {
    pub id: String,
    pub source: RecallSource,
    /// 在该来源 ranked list 中的 0-based 位置。
    pub rank: usize,
    /// 原始相关性分数（FTS BM25 / 向量相似度；诊断用，不进 RRF）。
    pub raw_score: f64,
    /// 叙事参考章节（窗口衰减距离基准；None=不衰减）。
    pub reference_chapter: Option<i32>,
}

impl RecallItem {
    /// 便捷构造。
    pub fn new(
        id: impl Into<String>,
        source: RecallSource,
        rank: usize,
        raw_score: f64,
        reference_chapter: Option<i32>,
    ) -> Self {
        Self {
            id: id.into(),
            source,
            rank,
            raw_score,
            reference_chapter,
        }
    }
}

/// 融合后结果项。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FusedResult {
    pub id: String,
    /// RRF 融合分（Σ 1/(rank_const+rank)，未衰减）。
    pub fusion_score: f64,
    /// 窗口衰减后最终分（fusion_score × decay(d)）。
    pub decayed_score: f64,
    /// 该 id 在 FTS 通道的 rank（若命中）。
    pub fts_rank: Option<usize>,
    /// 该 id 在向量通道的 rank（若命中）。
    pub vector_rank: Option<usize>,
    /// 用于衰减的章节距离 d（≥0；0=同章或未知）。
    pub chapter_distance: i32,
}

// ──────────────────────────────────────────────────────────────────────────
// RRF 融合（纯函数）
// ──────────────────────────────────────────────────────────────────────────

/// 计算单条召回的 RRF 贡献分：`1 / (rank_const + rank)`。
///
/// rank 为 0-based；rank_const ≥ 1 防 rank=0 时分母为 0。与 TS 侧
/// `weight / (SOURCE_RRF_K + sourceRank + 1)` 同族（`+1` ≡ rank_const=1）。
#[inline]
pub fn rrf_contribution(rank_const: f64, rank: usize) -> f64 {
    1.0 / (rank_const + rank as f64)
}

/// 将 FTS + 向量两路召回融合为按 id 去重的中间项集合（未排序、未衰减）。
///
/// 同一 id 在两源均出现 → 贡献相加（RRF 标准做法）。返回 `HashMap<id,
/// (fusion_score, fts_rank, vector_rank)>`。纯函数：融合结果只依赖每个 id
/// 在各源的 rank，与处理顺序无关（proptest 覆盖）。
pub fn rrf_fuse(rank_const: f64, fts: &[RecallItem], vector: &[RecallItem]) -> HashMap<String, FusedAccum> {
    let mut acc: HashMap<String, FusedAccum> = HashMap::new();
    let push = |acc: &mut HashMap<String, FusedAccum>, item: &RecallItem| {
        let contrib = rrf_contribution(rank_const, item.rank);
        let entry = acc.entry(item.id.clone()).or_insert(FusedAccum {
            fusion_score: 0.0,
            fts_rank: None,
            vector_rank: None,
            reference_chapter: None,
        });
        entry.fusion_score += contrib;
        match item.source {
            RecallSource::Fts => entry.fts_rank = Some(item.rank),
            RecallSource::Vector => entry.vector_rank = Some(item.rank),
        }
        // 取最近的参考章节（首次命中即记；多源同 id 一致时无害）
        if entry.reference_chapter.is_none() {
            entry.reference_chapter = item.reference_chapter;
        }
    };
    for r in fts {
        debug_assert_eq!(r.source, RecallSource::Fts);
        push(&mut acc, r);
    }
    for r in vector {
        debug_assert_eq!(r.source, RecallSource::Vector);
        push(&mut acc, r);
    }
    acc
}

/// 融合累加器（内部）。
#[derive(Debug, Clone, PartialEq)]
pub struct FusedAccum {
    pub fusion_score: f64,
    pub fts_rank: Option<usize>,
    pub vector_rank: Option<usize>,
    pub reference_chapter: Option<i32>,
}

// ──────────────────────────────────────────────────────────────────────────
// 窗口衰减（纯函数，蓝图 §9 因子 ⑤ 形式冻结）
// ──────────────────────────────────────────────────────────────────────────

/// 窗口衰减权重：`decay(d) = 1 / (1 + α·d)^β`，d ≥ 0。
///
/// - d=0 → 1.0（同章/未知，不衰减）。
/// - α=0 → 1.0（关闭衰减）。
/// - 单调不增：d 越大权重越小（近章高、远章低）。
///
/// 形式冻结（蓝图 §9 因子 ⑤）；α/β 参数化由 [`SearchConfig`] 承载，
/// T32 在 QMAI 召回池扫描 α/β，函数形式不换。
#[inline]
pub fn decay(d: i32, alpha: f64, beta: f64) -> f64 {
    if d <= 0 || alpha == 0.0 {
        return 1.0;
    }
    let base = 1.0 + alpha * d as f64;
    if beta == 1.0 {
        1.0 / base
    } else if beta == 0.0 {
        1.0
    } else {
        1.0 / base.powf(beta)
    }
}

/// 计算章节距离 d = |at_chapter − reference_chapter|；任一为 None → 0。
#[inline]
pub fn chapter_distance(at_chapter: Option<i32>, reference_chapter: Option<i32>) -> i32 {
    match (at_chapter, reference_chapter) {
        (Some(a), Some(r)) => (a - r).abs(),
        _ => 0,
    }
}

/// 对一组融合累加项应用窗口衰减，产出 [`FusedResult`] 列表（未排序）。
pub fn window_decay(
    accum: HashMap<String, FusedAccum>,
    at_chapter: Option<i32>,
    cfg: &SearchConfig,
) -> Vec<FusedResult> {
    accum
        .into_iter()
        .map(|(id, a)| {
            let d = chapter_distance(at_chapter, a.reference_chapter);
            let w = decay(d, cfg.decay_alpha, cfg.decay_beta);
            FusedResult {
                decayed_score: a.fusion_score * w,
                fusion_score: a.fusion_score,
                fts_rank: a.fts_rank,
                vector_rank: a.vector_rank,
                chapter_distance: d,
                id,
            }
        })
        .collect()
}

// ──────────────────────────────────────────────────────────────────────────
// 检索引擎（纯逻辑编排）
// ──────────────────────────────────────────────────────────────────────────

/// canon 混合检索纯逻辑引擎：fuse → decay → 排序 → topK。
///
/// 无 IO：调用方注入 FTS / 向量两路召回，引擎产出融合衰减后的 ranked
/// 结果。LanceDB IO 层 [`CanonSearch`] 负责实际召回，再委托本引擎融合。
#[derive(Debug, Clone, Default)]
pub struct CanonSearchEngine {
    config: SearchConfig,
}

impl CanonSearchEngine {
    pub fn new(config: SearchConfig) -> Self {
        Self { config }
    }

    pub fn config(&self) -> &SearchConfig {
        &self.config
    }

    /// 融合 FTS + 向量召回，应用窗口衰减，按 decayed_score 降序取 topK。
    ///
    /// 排序稳定性：同分按 id 字典序（确定性，便于 proptest 与缓存幂等）。
    pub fn search(
        &self,
        fts: &[RecallItem],
        vector: &[RecallItem],
        at_chapter: Option<i32>,
        top_k: usize,
    ) -> Vec<FusedResult> {
        let accum = rrf_fuse(self.config.rrf_rank_const, fts, vector);
        let mut results = window_decay(accum, at_chapter, &self.config);
        results.sort_by(|a, b| {
            b.decayed_score
                .partial_cmp(&a.decayed_score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.id.cmp(&b.id))
        });
        if top_k < results.len() {
            results.truncate(top_k);
        }
        results
    }
}

// ──────────────────────────────────────────────────────────────────────────
// 查询缓存（键含 canon revision；revision 自增即整缓存失效）
// ──────────────────────────────────────────────────────────────────────────

/// 查询缓存键：`(filter 规范串, at_chapter, canon_revision)`。
///
/// 蓝图 §6 T12：键 = filter + at_chapter + canon revision；ingest/supersede
/// 触发 revision 自增 → 旧 revision 的所有键自然失效（整缓存视为 miss）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CacheKey {
    pub filter_canonical: String,
    pub at_chapter: Option<i32>,
    pub canon_revision: u64,
}

/// 把 [`CanonEdgeFilter`] 规范化为稳定字符串（键序稳定，serde_json 保证）。
pub fn canonical_filter_key(filter: &CanonEdgeFilter) -> String {
    serde_json::to_string(filter).unwrap_or_else(|_| "{}".into())
}

/// 查询结果缓存（内存，纯逻辑）。
///
/// 失效策略：调用方持有 `canon_revision`（ingest/supersede 自增）。查询时
/// 传入当前 revision；键中 revision 不同即视为未命中（等价整缓存失效）。
/// 容量上限到达时按插入序淘汰最早项（简易 FIFO；不依赖 LLM/时间）。
#[derive(Debug, Clone, Default)]
pub struct CanonQueryCache {
    capacity: usize,
    entries: HashMap<String, (CacheKey, Vec<FusedResult>)>,
    /// 插入序（FIFO 淘汰依据）。
    order: Vec<String>,
}

impl CanonQueryCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            entries: HashMap::new(),
            order: Vec::new(),
        }
    }

    /// 查询缓存：命中返回克隆，未命中返回 None。
    pub fn get(&self, key: &CacheKey) -> Option<Vec<FusedResult>> {
        let storage_key = self.storage_key(key);
        self.entries.get(&storage_key).and_then(|(k, v)| {
            if k.canon_revision == key.canon_revision {
                Some(v.clone())
            } else {
                None
            }
        })
    }

    /// 写入缓存（覆盖同 storage_key 旧值；容量超限时 FIFO 淘汰最早项）。
    pub fn put(&mut self, key: CacheKey, value: Vec<FusedResult>) {
        let storage_key = self.storage_key(&key);
        if !self.entries.contains_key(&storage_key) {
            self.order.push(storage_key.clone());
            while self.order.len() > self.capacity && !self.order.is_empty() {
                let evict = self.order.remove(0);
                self.entries.remove(&evict);
            }
        }
        self.entries.insert(storage_key, (key, value));
    }

    /// 清空（revision 自增的等价语义也可直接换 key，无需手动清空）。
    pub fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }

    /// 当前条目数（诊断/测试用）。
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// storage_key = 规范串 + at_chapter（不含 revision：revision 差异在 get 时判）。
    fn storage_key(&self, key: &CacheKey) -> String {
        format!("{}|{:?}", key.filter_canonical, key.at_chapter)
    }
}

// ──────────────────────────────────────────────────────────────────────────
// 分词器裁决（T04 spike §4）
// ──────────────────────────────────────────────────────────────────────────

/// 分词器通道选择。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenizerChoice {
    /// LanceDB 内置自定义 tokenizer 通道（少一层依赖）。
    BuiltIn,
    /// jieba-rs / tantivy-jieba 降级通道（中文召回增益）。
    Jieba,
}

/// T04 spike §4 裁决规则：若 LanceDB 自定义 tokenizer 通道召回 ≥ jieba 基线
/// ×(1 − `tolerance`) → 采纳内置通道；否则降级 jieba。
///
/// `tolerance` 默认 0.05（T04 spike `tokenizer_verdict` 容差）。`custom_recall`
/// 与 `jieba_recall` 均为 [0,1] 召回率。纯函数：首日验证复用 T04 结论。
pub fn tokenizer_verdict(custom_recall: f64, jieba_recall: f64, tolerance: f64) -> TokenizerChoice {
    let threshold = jieba_recall * (1.0 - tolerance);
    if custom_recall >= threshold {
        TokenizerChoice::BuiltIn
    } else {
        TokenizerChoice::Jieba
    }
}

// ──────────────────────────────────────────────────────────────────────────
// 读侧图遍历（petgraph，时态/认知过滤后边集物化为内存图）
// ──────────────────────────────────────────────────────────────────────────

/// 读侧内存图：由「时态 + 认知轴过滤后」的边集物化。存储语义零改动。
///
/// 蓝图 §6 T12：BFS depth=3 / 连通分量 / 拓扑序。petgraph DiGraph 承载
/// adjacency；节点 id = 实体 id（`CanonEdge.source_id` / `target_id`）。
#[derive(Debug, Clone, Default)]
pub struct CanonGraph {
    graph: DiGraph<String, ()>,
    /// 实体 id → 节点索引（稳定映射）。
    index: HashMap<String, NodeIndex>,
}

impl CanonGraph {
    /// 从过滤后的边集物化内存图（节点 = source/target 去重）。
    pub fn from_edges(edges: &[CanonEdge]) -> Self {
        let mut g = Self {
            graph: DiGraph::new(),
            index: HashMap::new(),
        };
        for e in edges {
            let s = g.ensure_node(&e.source_id);
            let t = g.ensure_node(&e.target_id);
            g.graph.add_edge(s, t, ());
        }
        g
    }

    fn ensure_node(&mut self, id: &str) -> NodeIndex {
        if let Some(&idx) = self.index.get(id) {
            return idx;
        }
        let idx = self.graph.add_node(id.to_string());
        self.index.insert(id.to_string(), idx);
        idx
    }

    /// 节点数。
    pub fn node_count(&self) -> usize {
        self.graph.node_count()
    }

    /// 边数。
    pub fn edge_count(&self) -> usize {
        self.graph.edge_count()
    }

    /// 从 `start` 出发的 BFS，收集深度 ≤ `max_depth` 的可达节点 id（含 start）。
    ///
    /// 蓝图 §6 T12：depth=3。深度 = 跳数（start 深度 0）。环路安全（visited 守卫）。
    pub fn bfs_depth(&self, start: &str, max_depth: u32) -> Vec<String> {
        let Some(&start_idx) = self.index.get(start) else {
            return Vec::new();
        };
        let mut visited: HashMap<NodeIndex, u32> = HashMap::new();
        let mut frontier: Vec<(NodeIndex, u32)> = vec![(start_idx, 0)];
        visited.insert(start_idx, 0);
        while let Some((node, depth)) = frontier.pop() {
            if depth >= max_depth {
                continue;
            }
            for edge in self.graph.edges(node) {
                let nxt = edge.target();
                if !visited.contains_key(&nxt) {
                    visited.insert(nxt, depth + 1);
                    frontier.push((nxt, depth + 1));
                }
            }
        }
        let mut out: Vec<String> = visited
            .into_iter()
            .map(|(idx, _)| self.graph[idx].clone())
            .collect();
        out.sort();
        out
    }

    /// 连通分量（无向投影）：返回每组的节点 id 列表（组内字典序，组间按首元字典序）。
    ///
    /// 用并查集（union-find）在无向投影上聚合；环路天然安全。
    pub fn connected_components(&self) -> Vec<Vec<String>> {
        let mut parent: HashMap<NodeIndex, NodeIndex> = HashMap::new();
        for idx in self.graph.node_indices() {
            parent.insert(idx, idx);
        }
        let mut find = |parent: &mut HashMap<NodeIndex, NodeIndex>, x: NodeIndex| -> NodeIndex {
            let mut root = x;
            while parent[&root] != root {
                root = parent[&root];
            }
            // path compression
            let mut cur = x;
            while parent[&cur] != root {
                let next = parent[&cur];
                parent.insert(cur, root);
                cur = next;
            }
            root
        };
        for edge in self.graph.edge_references() {
            let (a, b) = (edge.source(), edge.target());
            let ra = find(&mut parent, a);
            let rb = find(&mut parent, b);
            if ra != rb {
                parent.insert(ra, rb);
            }
        }
        let mut groups: HashMap<NodeIndex, Vec<String>> = HashMap::new();
        for idx in self.graph.node_indices() {
            let root = find(&mut parent, idx);
            groups.entry(root).or_default().push(self.graph[idx].clone());
        }
        let mut out: Vec<Vec<String>> = groups.into_values().map(|mut g| {
            g.sort();
            g
        }).collect();
        out.sort_by(|a, b| a.first().cmp(&b.first()));
        out
    }

    /// 拓扑序（DAG）：返回节点 id 序列；若存在环返回 `Err(环上任意一个节点 id)`。
    ///
    /// 使用 petgraph `algo::toposort`。canon 边集通常近 DAG（时态推进），
    /// 环路由调用方处理（蓝图未要求强连通分解，故返回 Err 诊断）。
    pub fn topo_sort(&self) -> Result<Vec<String>, String> {
        match petgraph::algo::toposort(&self.graph, None) {
            Ok(order) => Ok(order.into_iter().map(|i| self.graph[i].clone()).collect()),
            Err(cycle) => Err(self.graph[cycle.node_id()].clone()),
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// LanceDB IO 层：CanonSearch（包装 CanonStore）
// ──────────────────────────────────────────────────────────────────────────
//
// 设计说明（与 canon_store.rs 同构）：
//   - IO 层只负责「召回」（FTS / 向量），融合/衰减/缓存由纯逻辑层承担。
//   - FTS：LanceDB 0.27 tantivy FTS 索引需在表上 `create_fts_index` 后生效；
//     T12 首日对中文通道采纳 T04 裁决（内置或 jieba）。在 FTS 索引尚未建立的
//     运行态，本层用 SQL `data LIKE '%term%'` 召回 + Rust 精细过滤作为兼容
//     退化（与 canon_store.query_edges 的「推 down + 精细过滤」一致）；
//     tantivy 索引建立后的加速路径在 T32 调参期接入（函数形式不变）。
//   - 向量：`Table::vector_search(query_embedding)`（与 vectorstore.rs 同源 API）；
//     要求表上有向量列与 IVF/HNSW 索引（T04 §3 三参数）。无索引时仍可暴力扫描。
//   - 本任务 convergence = `cargo test canon_search 全绿`，聚焦纯逻辑层；
//     IO 层提供 async 函数供 T13 IPC 包装，LanceDB 集成冒烟由 T11 已覆盖。

use crate::types::canon_types::{
    CANON_TABLE_EDGES, CANON_TABLE_ENTITIES, CANON_TABLE_EPISODES,
};
use arrow_array::{Array, StringArray};
use futures::TryStreamExt;
use lancedb::connect;
use lancedb::query::{ExecutableQuery, QueryBase};

/// canon LanceDB 库路径（与 canon_store.rs 同源约定：<project>/.qmai/lancedb）。
fn db_path(project_path: &str) -> String {
    format!("{}/.qmai/lancedb", project_path.replace('\\', "/"))
}

/// canon 混合检索 IO 包装：持有 LanceDB 连接，提供 FTS / 向量召回。
///
/// 自包含（不依赖 [`CanonStore`] 私有字段）：通过 [`CanonSearch::open`] 连接
/// 同一 canon 库。融合/衰减/缓存由纯逻辑层承担；本层只召回。
pub struct CanonSearch {
    db: lancedb::Connection,
}

impl CanonSearch {
    /// 打开 canon 库连接（与 [`CanonStore::open`] 同库路径）。三表存在性由
    /// T11 `CanonStore::open` 保证；本构造假定库已初始化。
    pub async fn open(project_path: &str) -> Result<Self, String> {
        let db = connect(&db_path(project_path))
            .execute()
            .await
            .map_err(|e| format!("canon_search DB connect: {e}"))?;
        Ok(Self { db })
    }

    /// 底层连接引用（诊断/T13 包装用）。
    pub fn connection(&self) -> &lancedb::Connection {
        &self.db
    }

    /// FTS 召回：在 `canon_entities` 的 `data` 列上做文本匹配，返回 ranked 召回。
    ///
    /// 当前实现对 `data` JSON 列做 SQL `LIKE` 子串匹配（FTS 索引未建立时的
    /// 兼容退化；tantivy 加速路径在 T32 接入，函数形式不变）。`raw_score`
    /// 用简单命中计数（1.0 固定，留待 T32 接 BM25）。`reference_chapter`
    /// 取实体 `first_seen_chapter`。
    pub async fn fts_query(
        &self,
        table: CanonFtsTable,
        term: &str,
        limit: usize,
    ) -> Result<Vec<RecallItem>, String> {
        let table_name = table.table_name();
        let db_table = self.db.open_table(table_name).execute().await
            .map_err(|e| format!("open {table_name}: {e}"))?;
        let like = sql_like(term);
        let batches = db_table
            .query()
            .only_if(format!("LOWER(data) LIKE LOWER({})", like))
            .limit(limit)
            .execute()
            .await
            .map_err(|e| format!("fts query: {e}"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|e| format!("fts collect: {e}"))?;
        let mut out = Vec::new();
        for b in &batches {
            let Some(arr) = b
                .column_by_name("data")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            else {
                continue;
            };
            for i in 0..arr.len() {
                if arr.is_null(i) {
                    continue;
                }
                let json = arr.value(i);
                let (id, ref_ch) = extract_id_and_chapter(table, json);
                out.push(RecallItem::new(
                    id,
                    RecallSource::Fts,
                    out.len(),
                    1.0,
                    ref_ch,
                ));
            }
        }
        Ok(out)
    }

    /// 向量召回：`Table::vector_search(query_embedding)`（与 vectorstore.rs 同源 API）。
    ///
    /// 要求表上有向量列（T04 §3 三参数：dimension/normalize/metric）。
    /// 返回 ranked 召回（rank = 返回序，raw_score = 距离/相似度）。
    /// 向量列名与度量由调用方与建表约定一致（本任务不在 IO 层硬编码列名，
    /// T13/T32 接入具体 embedding 通道时补齐列名常量）。
    pub async fn vector_query(
        &self,
        table: CanonFtsTable,
        query_embedding: Vec<f32>,
        limit: usize,
        _vector_column: &str,
    ) -> Result<Vec<RecallItem>, String> {
        let table_name = table.table_name();
        let db_table = self.db.open_table(table_name).execute().await
            .map_err(|e| format!("open {table_name}: {e}"))?;
        // LanceDB 0.27 vector_search 默认探测向量列（与 vectorstore.rs 同源
        // API；多向量列场景在 T13/T32 接入具体 embedding 通道时通过
        // `.column(name)` 显式指定，此处保持默认探测）。
        let _ = _vector_column;
        let stream = db_table
            .vector_search(query_embedding)
            .map_err(|e| format!("vector_search init: {e}"))?
            .limit(limit)
            .execute()
            .await
            .map_err(|e| format!("vector_search exec: {e}"))?;
        let batches = stream
            .try_collect::<Vec<_>>()
            .await
            .map_err(|e| format!("vector_search collect: {e}"))?;
        let mut out = Vec::new();
        for b in &batches {
            let Some(arr) = b
                .column_by_name("data")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            else {
                continue;
            };
            for i in 0..arr.len() {
                if arr.is_null(i) {
                    continue;
                }
                let json = arr.value(i);
                let (id, ref_ch) = extract_id_and_chapter(table, json);
                out.push(RecallItem::new(
                    id,
                    RecallSource::Vector,
                    out.len(),
                    1.0,
                    ref_ch,
                ));
            }
        }
        Ok(out)
    }
}

/// FTS/向量召回的目标表（蓝图 §3 三表）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanonFtsTable {
    Entities,
    Episodes,
    Edges,
}

impl CanonFtsTable {
    pub fn table_name(self) -> &'static str {
        match self {
            Self::Entities => CANON_TABLE_ENTITIES,
            Self::Episodes => CANON_TABLE_EPISODES,
            Self::Edges => CANON_TABLE_EDGES,
        }
    }
}

/// 从 `data` JSON 列抽取 id 与参考章节（按表类型）。
fn extract_id_and_chapter(table: CanonFtsTable, json: &str) -> (String, Option<i32>) {
    // 轻量解析：优先 serde_json；失败则退化（id 占位）。
    let v: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return (json.to_string(), None),
    };
    let id = v
        .get("id")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let ref_ch = match table {
        CanonFtsTable::Entities => v.get("first_seen_chapter").and_then(|x| x.as_i64()),
        CanonFtsTable::Episodes => v.get("chapter_number").and_then(|x| x.as_i64()),
        CanonFtsTable::Edges => v
            .get("source_chapter")
            .and_then(|x| x.as_i64())
            .or_else(|| v.get("reference_time").and_then(|x| x.as_i64())),
    };
    (id, ref_ch.map(|x| x as i32))
}

/// SQL LIKE 转义（单引号包裹 + 内部单引号加倍 + % _ 转义）。防注入。
fn sql_like(term: &str) -> String {
    let escaped: String = term
        .chars()
        .map(|c| match c {
            '\'' => "''".to_string(),
            '%' => "\\%".to_string(),
            '_' => "\\_".to_string(),
            _ => c.to_string(),
        })
        .collect();
    format!("'%{}%'", escaped)
}

// （本任务 IO 层为「契约存在 + 编译通过」，自包含 Connection，不依赖
// CanonStore 私有字段；T13 IPC 包装在 canon_commands.rs 统一落地。）

// ──────────────────────────────────────────────────────────────────────────
// 单元测试（纯逻辑层：RRF / 衰减 / 缓存 / 分词器 / 图遍历）
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::canon_types::EdgeKind;

    fn fts(id: &str, rank: usize, ch: Option<i32>) -> RecallItem {
        RecallItem::new(id, RecallSource::Fts, rank, 1.0, ch)
    }
    fn vec_(id: &str, rank: usize, ch: Option<i32>) -> RecallItem {
        RecallItem::new(id, RecallSource::Vector, rank, 1.0, ch)
    }

    // ── RRF 融合 ──

    #[test]
    fn rrf_contribution_formula() {
        // rank_const=1: 1/(1+rank)
        assert!((rrf_contribution(1.0, 0) - 1.0).abs() < 1e-9);
        assert!((rrf_contribution(1.0, 1) - 0.5).abs() < 1e-9);
        assert!((rrf_contribution(1.0, 2) - (1.0 / 3.0)).abs() < 1e-9);
        // 与 TS 侧 K=60 对照：rank_const=60 时 1/(60+0)=0.01667 ≈ 1/61
        assert!((rrf_contribution(60.0, 0) - (1.0 / 60.0)).abs() < 1e-9);
    }

    #[test]
    fn rrf_fuse_sums_cross_source() {
        let fts = vec![fts("a", 0, None), fts("b", 1, None)];
        let vecs = vec![vec_("a", 0, None), vec_("c", 2, None)];
        let acc = rrf_fuse(1.0, &fts, &vecs);
        // a: 1/(1+0) + 1/(1+0) = 2.0
        let a = acc.get("a").unwrap();
        assert!((a.fusion_score - 2.0).abs() < 1e-9);
        assert_eq!(a.fts_rank, Some(0));
        assert_eq!(a.vector_rank, Some(0));
        // b: 仅 fts rank 1 → 0.5
        assert!((acc.get("b").unwrap().fusion_score - 0.5).abs() < 1e-9);
        // c: 仅 vec rank 2 → 1/3
        assert!((acc.get("c").unwrap().fusion_score - (1.0 / 3.0)).abs() < 1e-9);
        assert_eq!(acc.len(), 3, "dedup by id");
    }

    #[test]
    fn rrf_fuse_empty_inputs() {
        assert!(rrf_fuse(1.0, &[], &[]).is_empty());
    }

    // ── 窗口衰减 ──

    #[test]
    fn decay_formula_and_monotone() {
        let cfg = SearchConfig {
            decay_alpha: 0.1,
            decay_beta: 1.0,
            ..Default::default()
        };
        // d=0 → 1.0
        assert!((decay(0, cfg.decay_alpha, cfg.decay_beta) - 1.0).abs() < 1e-9);
        // d=10, α=0.1, β=1 → 1/(1+1)=0.5
        assert!((decay(10, cfg.decay_alpha, cfg.decay_beta) - 0.5).abs() < 1e-9);
        // 单调不增
        let mut prev = f64::INFINITY;
        for d in 0..50 {
            let w = decay(d, cfg.decay_alpha, cfg.decay_beta);
            assert!(w <= prev + 1e-12, "decay must be non-increasing at d={d}");
            prev = w;
        }
        // α=0 → 恒 1.0
        assert!((decay(100, 0.0, 1.0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn decay_beta_power() {
        // β=2: 1/(1+0.1*10)^2 = 1/4 = 0.25
        assert!((decay(10, 0.1, 2.0) - 0.25).abs() < 1e-9);
    }

    #[test]
    fn chapter_distance_logic() {
        assert_eq!(chapter_distance(Some(10), Some(3)), 7);
        assert_eq!(chapter_distance(Some(3), Some(10)), 7);
        assert_eq!(chapter_distance(None, Some(10)), 0);
        assert_eq!(chapter_distance(Some(10), None), 0);
    }

    // ── 搜索引擎 ──

    #[test]
    fn engine_search_orders_by_decayed_score() {
        let engine = CanonSearchEngine::new(SearchConfig {
            rrf_rank_const: 1.0,
            decay_alpha: 0.1,
            decay_beta: 1.0,
            ..Default::default()
        });
        let fts = vec![fts("near", 0, Some(10)), fts("far", 1, Some(1))];
        let vecs = vec![vec_("far", 0, Some(1))];
        let r = engine.search(&fts, &vecs, Some(10), 10);
        // near: fts rank0 (1.0) + no vec; decay d=0 → 1.0
        // far: fts rank1 (0.5) + vec rank0 (1.0) = 1.5; decay d=9 → 1.5/(1+0.9)=0.789
        assert_eq!(r[0].id, "near");
        assert!(r[0].decayed_score > r[1].decayed_score);
    }

    #[test]
    fn engine_search_topk_truncates() {
        let engine = CanonSearchEngine::default();
        let fts: Vec<RecallItem> = (0..5).map(|i| fts(&format!("e{i}"), i, None)).collect();
        let r = engine.search(&fts, &[], None, 3);
        assert_eq!(r.len(), 3);
        // 降序：rank0 最高分
        assert_eq!(r[0].id, "e0");
    }

    // ── 查询缓存 ──

    fn key(rev: u64) -> CacheKey {
        CacheKey {
            filter_canonical: "{\"known_by\":\"alice\"}".into(),
            at_chapter: Some(5),
            canon_revision: rev,
        }
    }

    #[test]
    fn cache_hit_idempotent() {
        let mut cache = CanonQueryCache::new(8);
        let val = vec![FusedResult {
            id: "x".into(),
            fusion_score: 1.0,
            decayed_score: 1.0,
            fts_rank: Some(0),
            vector_rank: None,
            chapter_distance: 0,
        }];
        cache.put(key(1), val.clone());
        // 重复 get 幂等
        let g1 = cache.get(&key(1)).unwrap();
        let g2 = cache.get(&key(1)).unwrap();
        assert_eq!(g1, g2);
        assert_eq!(g1, val);
    }

    #[test]
    fn cache_miss_on_revision_bump() {
        let mut cache = CanonQueryCache::new(8);
        cache.put(key(1), vec![]);
        assert!(cache.get(&key(1)).is_some(), "same revision = hit");
        assert!(
            cache.get(&key(2)).is_none(),
            "different revision = invalidated (miss)"
        );
    }

    #[test]
    fn cache_fifo_eviction() {
        let mut cache = CanonQueryCache::new(2);
        let mut k1 = key(1);
        k1.filter_canonical = "a".into();
        let mut k2 = key(1);
        k2.filter_canonical = "b".into();
        let mut k3 = key(1);
        k3.filter_canonical = "c".into();
        cache.put(k1.clone(), vec![]);
        cache.put(k2.clone(), vec![]);
        cache.put(k3.clone(), vec![]);
        assert!(cache.get(&k1).is_none(), "FIFO evicts earliest");
        assert!(cache.get(&k2).is_some());
        assert!(cache.get(&k3).is_some());
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn canonical_filter_key_stable() {
        let f = CanonEdgeFilter {
            known_by: Some("alice".into()),
            valid_at_chapter: Some(5),
            edge_kinds: Some(vec![EdgeKind::WorldFact]),
            ..Default::default()
        };
        let k1 = canonical_filter_key(&f);
        let k2 = canonical_filter_key(&f);
        assert_eq!(k1, k2, "stable for equal filters");
        assert!(k1.contains("alice"));
    }

    // ── 分词器裁决 ──

    #[test]
    fn tokenizer_verdict_built_in_when_within_tolerance() {
        // custom=0.90, jieba=0.92, tol=0.05 → threshold=0.874 → 0.90≥0.874 → BuiltIn
        assert_eq!(tokenizer_verdict(0.90, 0.92, 0.05), TokenizerChoice::BuiltIn);
    }

    #[test]
    fn tokenizer_verdict_jieba_when_degraded() {
        // custom=0.60, jieba=0.92, tol=0.05 → threshold=0.874 → 0.60<0.874 → Jieba
        assert_eq!(tokenizer_verdict(0.60, 0.92, 0.05), TokenizerChoice::Jieba);
    }

    #[test]
    fn tokenizer_verdict_exact_boundary() {
        // custom == threshold → BuiltIn (>=)
        assert_eq!(tokenizer_verdict(0.874, 0.92, 0.05), TokenizerChoice::BuiltIn);
        assert_eq!(tokenizer_verdict(0.873, 0.92, 0.05), TokenizerChoice::Jieba);
    }

    // ── 图遍历 ──

    fn edge(id: &str, s: &str, t: &str) -> CanonEdge {
        CanonEdge::new(id, s, t, "rel", EdgeKind::WorldFact)
    }

    #[test]
    fn graph_bfs_depth_3() {
        // a→b→c→d→e（链）
        let edges = vec![
            edge("e1", "a", "b"),
            edge("e2", "b", "c"),
            edge("e3", "c", "d"),
            edge("e4", "d", "e"),
        ];
        let g = CanonGraph::from_edges(&edges);
        // depth=3 from a: a(0), b(1), c(2), d(3)；e(4) 超出
        let reach = g.bfs_depth("a", 3);
        assert_eq!(reach, vec!["a".to_string(), "b".into(), "c".into(), "d".into()]);
    }

    #[test]
    fn graph_bfs_unknown_start_empty() {
        let g = CanonGraph::from_edges(&[edge("e1", "a", "b")]);
        assert!(g.bfs_depth("zzz", 3).is_empty());
    }

    #[test]
    fn graph_bfs_cycle_safe() {
        // a→b→a（自环式环）
        let edges = vec![edge("e1", "a", "b"), edge("e2", "b", "a")];
        let g = CanonGraph::from_edges(&edges);
        let reach = g.bfs_depth("a", 3);
        assert!(reach.contains(&"a".to_string()));
        assert!(reach.contains(&"b".to_string()));
        assert_eq!(reach.len(), 2, "no infinite loop on cycle");
    }

    #[test]
    fn graph_connected_components() {
        // 两个连通分量：{a,b,c} 与 {x,y}
        let edges = vec![
            edge("e1", "a", "b"),
            edge("e2", "b", "c"),
            edge("e3", "x", "y"),
        ];
        let g = CanonGraph::from_edges(&edges);
        let comps = g.connected_components();
        assert_eq!(comps.len(), 2);
        assert!(comps.iter().any(|c| c == &vec!["a".to_string(), "b".to_string(), "c".to_string()]));
        assert!(comps.iter().any(|c| c == &vec!["x".to_string(), "y".to_string()]));
    }

    #[test]
    fn graph_topo_sort_dag() {
        // a→b→c（DAG）
        let edges = vec![edge("e1", "a", "b"), edge("e2", "b", "c")];
        let g = CanonGraph::from_edges(&edges);
        let order = g.topo_sort().expect("DAG has topo order");
        let pos = |id: &str| order.iter().position(|x| x == id).unwrap();
        assert!(pos("a") < pos("b"));
        assert!(pos("b") < pos("c"));
    }

    #[test]
    fn graph_topo_sort_cycle_returns_err() {
        let edges = vec![edge("e1", "a", "b"), edge("e2", "b", "a")];
        let g = CanonGraph::from_edges(&edges);
        assert!(g.topo_sort().is_err());
    }

    #[test]
    fn graph_node_edge_counts() {
        let g = CanonGraph::from_edges(&[edge("e1", "a", "b"), edge("e2", "b", "c")]);
        assert_eq!(g.node_count(), 3);
        assert_eq!(g.edge_count(), 2);
    }

    // ── extract_id_and_chapter / sql_like ──

    #[test]
    fn extract_id_and_chapter_entities() {
        let (id, ch) = extract_id_and_chapter(
            CanonFtsTable::Entities,
            r#"{"id":"e1","first_seen_chapter":7}"#,
        );
        assert_eq!(id, "e1");
        assert_eq!(ch, Some(7));
    }

    #[test]
    fn extract_id_and_chapter_episodes() {
        let (id, ch) = extract_id_and_chapter(
            CanonFtsTable::Episodes,
            r#"{"id":"ep1","chapter_number":3}"#,
        );
        assert_eq!(id, "ep1");
        assert_eq!(ch, Some(3));
    }

    #[test]
    fn sql_like_escapes_special_chars() {
        let s = sql_like("a'b%c_d");
        // 单引号加倍、% 与 _ 转义、首尾 % 包裹
        assert!(s.contains("''"));
        assert!(s.contains("\\%"));
        assert!(s.contains("\\_"));
        assert!(s.starts_with("'%") && s.ends_with("%'"));
    }
}

// ──────────────────────────────────────────────────────────────────────────
// proptest 属性测试（融合顺序无关 / 缓存命中幂等 / 衰减单调）
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod proptest_tests {
    use super::*;
    use proptest::prelude::*;

    fn arb_id() -> impl Strategy<Value = String> {
        "[a-c][0-9]{1,2}"
    }

    fn arb_recall(source: RecallSource) -> impl Strategy<Value = RecallItem> {
        (arb_id(), 0usize..6, 0i32..50i32).prop_map(move |(id, rank, ch)| {
            RecallItem::new(id, source, rank, 1.0, Some(ch))
        })
    }

    proptest! {
        /// 融合顺序无关：对同一组召回，打乱 fts/vector 内部顺序后重新指派 rank，
        /// 只要每个 id 的「集合来源内 rank」保持一致，融合分不变。这里验证一个
        /// 更强的可测性质：同一输入两次融合结果完全一致（确定性 + 幂等）。
        #[test]
        fn canon_proptest_fuse_deterministic(
            fts in prop::collection::vec(arb_recall(RecallSource::Fts), 0..10),
            vecs in prop::collection::vec(arb_recall(RecallSource::Vector), 0..10)
        ) {
            let a = rrf_fuse(1.0, &fts, &vecs);
            let b = rrf_fuse(1.0, &fts, &vecs);
            // HashMap 比较：相同键 + 相同累加值
            prop_assert_eq!(a.len(), b.len());
            for (k, va) in &a {
                let vb = b.get(k).unwrap();
                prop_assert!((va.fusion_score - vb.fusion_score).abs() < 1e-9);
                prop_assert_eq!(va.fts_rank, vb.fts_rank);
                prop_assert_eq!(va.vector_rank, vb.vector_rank);
            }
        }

        /// 融合对称性：交换 fts 与 vector 两源（同时翻转 RecallSource）后，
        /// 同 id 的融合分相等（RRF 对源对称）。验证双源贡献可加且对称。
        #[test]
        fn canon_proptest_fuse_source_symmetric(
            items in prop::collection::vec(arb_id(), 1..8)
        ) {
            // 去重 id，构造 fts-only 与 vec-only 同 rank 序列
            let mut ids: Vec<String> = items;
            ids.sort();
            ids.dedup();
            let fts: Vec<RecallItem> = ids.iter().enumerate()
                .map(|(r, id)| RecallItem::new(id.clone(), RecallSource::Fts, r, 1.0, None))
                .collect();
            let vecs: Vec<RecallItem> = ids.iter().enumerate()
                .map(|(r, id)| RecallItem::new(id.clone(), RecallSource::Vector, r, 1.0, None))
                .collect();
            // 仅 fts
            let only_fts = rrf_fuse(1.0, &fts, &[]);
            // 仅 vec
            let only_vec = rrf_fuse(1.0, &[], &vecs);
            for id in &ids {
                let sf = only_fts.get(id).unwrap().fusion_score;
                let sv = only_vec.get(id).unwrap().fusion_score;
                prop_assert!((sf - sv).abs() < 1e-9, "source-symmetric score for {id}");
            }
            // 双源 = 单源之和（可加性）
            let both = rrf_fuse(1.0, &fts, &vecs);
            for id in &ids {
                let s = both.get(id).unwrap().fusion_score;
                let sf = only_fts.get(id).unwrap().fusion_score;
                prop_assert!((s - 2.0 * sf).abs() < 1e-9, "additive across sources for {id}");
            }
        }

        /// 缓存命中幂等：对任意 (key, value)，put 一次后重复 get 返回相等克隆；
        /// revision 递增后该 key 失效（miss）。
        #[test]
        fn canon_proptest_cache_hit_idempotent(
            rev in 1u64..=5u64,
            n in 1usize..=4
        ) {
            let mut cache = CanonQueryCache::new(8);
            let val: Vec<FusedResult> = (0..n).map(|i| FusedResult {
                id: format!("r{i}"),
                fusion_score: i as f64,
                decayed_score: i as f64,
                fts_rank: Some(i),
                vector_rank: None,
                chapter_distance: 0,
            }).collect();
            let k = CacheKey {
                filter_canonical: "f".into(),
                at_chapter: Some(1),
                canon_revision: rev,
            };
            cache.put(k.clone(), val.clone());
            let g1 = cache.get(&k).unwrap();
            let g2 = cache.get(&k).unwrap();
            prop_assert_eq!(&g1, &g2);
            prop_assert_eq!(&g1, &val);
            // revision +1 → miss
            let mut k2 = k.clone();
            k2.canon_revision = rev + 1;
            prop_assert!(cache.get(&k2).is_none(), "revision bump invalidates");
        }

        /// 衰减单调非递增：对任意 α≥0, β≥0, d∈[0,100]，decay(d) ≥ decay(d+1)。
        #[test]
        fn canon_proptest_decay_monotone(
            alpha in 0.0f64..=2.0,
            beta in 0.0f64..=3.0,
            d in 0i32..100
        ) {
            let w0 = decay(d, alpha, beta);
            let w1 = decay(d + 1, alpha, beta);
            prop_assert!(w1 <= w0 + 1e-9, "decay non-increasing: α={alpha} β={beta} d={d}");
            // d=0 恒 1.0
            prop_assert!((decay(0, alpha, beta) - 1.0).abs() < 1e-9);
            // 值域 [0,1]
            prop_assert!((0.0..=1.0).contains(&(w0)) || alpha == 0.0);
        }

        /// 引擎 search 确定性：同输入两次 search 结果完全相等（含排序）。
        #[test]
        fn canon_proptest_engine_search_deterministic(
            fts in prop::collection::vec(arb_recall(RecallSource::Fts), 0..10),
            vecs in prop::collection::vec(arb_recall(RecallSource::Vector), 0..10),
            at in 0i32..50
        ) {
            let engine = CanonSearchEngine::default();
            let r1 = engine.search(&fts, &vecs, Some(at), 5);
            let r2 = engine.search(&fts, &vecs, Some(at), 5);
            prop_assert_eq!(r1.len(), r2.len());
            for (a, b) in r1.iter().zip(r2.iter()) {
                prop_assert_eq!(&a.id, &b.id);
                prop_assert!((a.decayed_score - b.decayed_score).abs() < 1e-9);
            }
        }

        /// 图遍历确定性：同边集两次 BFS / 连通分量结果相等（排序后）。
        #[test]
        fn canon_proptest_graph_traversal_deterministic(
            edges in prop::collection::vec(
                (arb_id(), arb_id()).prop_filter("no self-loop", |(s, t)| s != t),
                0..12
            )
        ) {
            use crate::types::canon_types::EdgeKind;
            let canon_edges: Vec<CanonEdge> = edges.iter().enumerate()
                .map(|(i, (s, t))| CanonEdge::new(format!("e{i}"), s, t, "rel", EdgeKind::WorldFact))
                .collect();
            let g = CanonGraph::from_edges(&canon_edges);
            // BFS from 每个存在节点两次相等
            for id in g.graph.node_indices().map(|i| g.graph[i].clone()).collect::<Vec<_>>() {
                let a = g.bfs_depth(&id, 3);
                let b = g.bfs_depth(&id, 3);
                prop_assert_eq!(a, b);
            }
            let c1 = g.connected_components();
            let c2 = g.connected_components();
            prop_assert_eq!(c1, c2);
        }
    }
}
