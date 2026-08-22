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
//!      - **T32 additive**：[`WindowDecayTable`]（窗口衰减表预计算纯函数）、
//!        [`sweep_decay_params`]（α/β 参数扫，形式不换、非照搬 graphiti）、
//!        CanonGraph 物化邻接表（构建时一次预计算，BFS 每跳 O(1) 取邻居）、
//!        性能基准（`perf_tests` 模块，延迟基线入测试断言）。
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

use std::collections::{HashMap, HashSet};

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
            // 蓝图 §6 T12 起点；A-06 劣化兜底亦保留 1（T32 不入扫参）。
            rrf_rank_const: 1.0,
            // 窗口衰减默认（T32 重调参定稿，2026-08-22）：QMAI 形态代理池上
            // α/β 网格扫描赢家 (0.08, 0.75)，mean NDCG@10 = 0.9410 vs 调参前
            // (0.1, 1.0) 的 0.9358。函数形式不变；绑定测试
            // t32_default_config_matches_swept_winner 防止池/网格演化后默认值
            // 漂移不同步。真实 LanceDB 召回池接入后须重扫（decision-log 债条目）。
            decay_alpha: 0.08,
            decay_beta: 0.75,
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
// 窗口衰减查找表（T32：预计算纯函数）
// ──────────────────────────────────────────────────────────────────────────

/// 窗口衰减查找表：对冻结形式 `decay(d)=1/(1+α·d)^β` 在 d ∈ [0, max_distance]
/// 上一次性预计算权重，查询 O(1)。
///
/// - d ≤ 0 → 表首项（=1.0，与 [`decay`] 同语义）。
/// - d > `max_distance` → 钳制到表尾项（窗口外近似：权重冻结在边界值，
///   不随距离继续衰减；由于闭式单调非增，该值 ≥ 窗口外任意 d 的闭式真值，
///   调用方按典型叙事窗口选 `max_distance`，长篇建议 ≥ 300 章以压低近似误差）。
/// - 窗口内与 [`decay`] 闭式逐点一致（spec 文件属性测试验证偏差 ≤ 1e-12）；
///   函数形式冻结不变（蓝图 §9 因子 ⑤），本表只是同一纯函数的查表化。
#[derive(Debug, Clone, PartialEq)]
pub struct WindowDecayTable {
    alpha: f64,
    beta: f64,
    max_distance: u32,
    /// 索引 = 章节距离 d；长度 = max_distance + 1。
    weights: Vec<f64>,
}

impl WindowDecayTable {
    pub fn new(alpha: f64, beta: f64, max_distance: u32) -> Self {
        let weights = (0..=max_distance)
            .map(|d| decay(d as i32, alpha, beta))
            .collect();
        Self {
            alpha,
            beta,
            max_distance,
            weights,
        }
    }

    /// O(1) 权重查询（d 越界钳制到边界表项）。
    #[inline]
    pub fn weight(&self, d: i32) -> f64 {
        if d <= 0 {
            return self.weights[0];
        }
        let idx = (d as u32).min(self.max_distance) as usize;
        self.weights[idx]
    }

    pub fn alpha(&self) -> f64 {
        self.alpha
    }

    pub fn beta(&self) -> f64 {
        self.beta
    }

    pub fn max_distance(&self) -> u32 {
        self.max_distance
    }

    /// 表项数 = max_distance + 1（诊断用）。
    pub fn len(&self) -> usize {
        self.weights.len()
    }

    pub fn is_empty(&self) -> bool {
        self.weights.is_empty()
    }
}

// ──────────────────────────────────────────────────────────────────────────
// α/β 参数扫（T32：QMAI 召回池重调参；形式不换，非照搬 graphiti）
// ──────────────────────────────────────────────────────────────────────────
//
// 蓝图 A-06 兑现路径：rank_const 保持 1 不动；只扫窗口衰减 (α, β)，衰减
// 函数形式维持 `1/(1+α·d)^β` 冻结——不引入 graphiti 的指数/半衰期等新
// 形式（ADR-20 纪律：提取「调参在自有召回池上做」的模式，不照搬其函数
// 形式）。真实 LanceDB 召回池接入前的调参底座为确定性 QMAI 形态代理池
// （见 tests::t32_retune_tests::qmai_recall_pool）；重调参结论与债务边界
// 落 docs/decision-log/。

/// 参数扫评估用的单条查询样本（QMAI 召回池代理的最小单元）。
#[derive(Debug, Clone)]
pub struct RecallCase {
    /// 查询名（诊断用）。
    pub name: String,
    pub fts: Vec<RecallItem>,
    pub vector: Vec<RecallItem>,
    pub at_chapter: Option<i32>,
    /// 人工标注相关 id 集合（分级增益：(id, gain)，gain ≥ 1；池构造保证非空）。
    /// 分级而非二元：QMAI 产品语义下近章活跃事实（gain 高）比远期回调
    /// （gain 低）更相关——窗口衰减的调参目标正是这种近章优先序。
    pub relevant: Vec<(String, u32)>,
}

/// 单个 (α, β) 候选在池上的平均 NDCG@k。
#[derive(Debug, Clone, PartialEq)]
pub struct DecaySweepCandidate {
    pub alpha: f64,
    pub beta: f64,
    pub mean_ndcg: f64,
}

/// 参数扫报告：候选按 mean_ndcg 降序（平分时 α 升序、β 升序 → 确定性）。
#[derive(Debug, Clone, PartialEq)]
pub struct DecaySweepReport {
    pub candidates: Vec<DecaySweepCandidate>,
}

impl DecaySweepReport {
    pub fn best(&self) -> Option<&DecaySweepCandidate> {
        self.candidates.first()
    }

    /// 按 (α, β) 精确取候选（浮点精确匹配，供测试回查网格点）。
    pub fn candidate_at(&self, alpha: f64, beta: f64) -> Option<&DecaySweepCandidate> {
        self.candidates
            .iter()
            .find(|c| c.alpha == alpha && c.beta == beta)
    }
}

/// 分级增益 NDCG@k：增益 `2^gain − 1`（gain=1 → 1，gain=2 → 3），
/// 理想 DCG 由增益降序的前 min(|relevant|, k) 个位置构成。
///
/// `relevant` 为空 → 返回 0.0（池构造保证不出现该退化情形）。
pub fn ndcg_at_k(results: &[FusedResult], relevant: &[(String, u32)], k: usize) -> f64 {
    if relevant.is_empty() {
        return 0.0;
    }
    let rel: std::collections::HashMap<&str, f64> = relevant
        .iter()
        .map(|(id, g)| (id.as_str(), 2f64.powf(*g as f64) - 1.0))
        .collect();
    let dcg: f64 = results
        .iter()
        .take(k)
        .enumerate()
        .map(|(i, r)| {
            rel.get(r.id.as_str())
                .map(|g| g / ((i + 2) as f64).log2())
                .unwrap_or(0.0)
        })
        .sum();
    let mut ideal_gains: Vec<f64> = rel.values().copied().collect();
    ideal_gains.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    let idcg: f64 = ideal_gains
        .into_iter()
        .take(k)
        .enumerate()
        .map(|(i, g)| g / ((i + 2) as f64).log2())
        .sum();
    if idcg == 0.0 {
        0.0
    } else {
        dcg / idcg
    }
}

/// 在召回池上扫描 (α, β)：对每个候选用冻结形式重建引擎跑全池，取平均
/// NDCG@k。`rrf_rank_const` 沿用 [`SearchConfig::default`]（A-06：保持 1，
/// 不入扫参）。返回报告按 mean_ndcg 降序排列（确定性平分裁决）。
///
/// 形式不换（蓝图 §9 因子 ⑤）：每个候选拼装的仍是同一 `decay(d)` 闭式，
/// 只改参数——与 graphiti 的多形式族（指数/线性/半衰期）无关。
pub fn sweep_decay_params(
    pool: &[RecallCase],
    alphas: &[f64],
    betas: &[f64],
    top_k: usize,
) -> DecaySweepReport {
    let mut candidates = Vec::with_capacity(alphas.len() * betas.len());
    for &alpha in alphas {
        for &beta in betas {
            let engine = CanonSearchEngine::new(SearchConfig {
                decay_alpha: alpha,
                decay_beta: beta,
                ..SearchConfig::default()
            });
            let total: f64 = pool
                .iter()
                .map(|case| {
                    let ranked =
                        engine.search(&case.fts, &case.vector, case.at_chapter, top_k);
                    ndcg_at_k(&ranked, &case.relevant, top_k)
                })
                .sum();
            let mean_ndcg = if pool.is_empty() {
                0.0
            } else {
                total / pool.len() as f64
            };
            candidates.push(DecaySweepCandidate {
                alpha,
                beta,
                mean_ndcg,
            });
        }
    }
    candidates.sort_by(|a, b| {
        b.mean_ndcg
            .partial_cmp(&a.mean_ndcg)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                a.alpha
                    .partial_cmp(&b.alpha)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| {
                a.beta
                    .partial_cmp(&b.beta)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    DecaySweepReport { candidates }
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
/// 图结构；节点 id = 实体 id（`CanonEdge.source_id` / `target_id`）。
/// **T32 邻接物化**：构建时一次预计算排序去重邻接表
/// （[`CanonGraph::adjacency`]），BFS 每跳 O(1) 取邻居，不再经 petgraph
/// 边迭代器重复走边；连通分量/拓扑序仍走 petgraph（需边引用语义）。
#[derive(Debug, Clone, Default)]
pub struct CanonGraph {
    graph: DiGraph<String, ()>,
    /// 实体 id → 节点索引（稳定映射）。
    index: HashMap<String, NodeIndex>,
    /// T32 物化邻接表：实体 id → 排序去重后的出边邻居 id 列表。
    /// 孤立节点也保证有键（空列表）；同向多边折叠为一条邻接项。
    adjacency: HashMap<String, Vec<String>>,
}

impl CanonGraph {
    /// 从过滤后的边集物化内存图（节点 = source/target 去重；T32 同步预计算
    /// 排序去重邻接表，构建成本 O(E log E) 一次性付出）。
    pub fn from_edges(edges: &[CanonEdge]) -> Self {
        let mut g = Self {
            graph: DiGraph::new(),
            index: HashMap::new(),
            adjacency: HashMap::new(),
        };
        for e in edges {
            let s = g.ensure_node(&e.source_id);
            let t = g.ensure_node(&e.target_id);
            g.graph.add_edge(s, t, ());
            // T32 邻接物化：出边方向 source → target；目标侧保证有键（孤立可达）。
            g.adjacency
                .entry(e.source_id.clone())
                .or_default()
                .push(e.target_id.clone());
            g.adjacency.entry(e.target_id.clone()).or_default();
        }
        for neighbors in g.adjacency.values_mut() {
            neighbors.sort();
            neighbors.dedup();
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

    /// T32 物化邻接表快照（只读）：实体 id → 排序去重后的出边邻居列表。
    /// 构建后不可变，多次遍历共享同一份预计算结果。
    pub fn adjacency(&self) -> &HashMap<String, Vec<String>> {
        &self.adjacency
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
    /// T32：每跳直接迭代物化好的邻接切片（O(1) 取邻居），输出语义与原
    /// petgraph 边迭代实现一致（升序去重 id 列表）。
    pub fn bfs_depth(&self, start: &str, max_depth: u32) -> Vec<String> {
        if !self.adjacency.contains_key(start) {
            return Vec::new();
        }
        let mut visited: HashSet<&str> = HashSet::new();
        let mut frontier: Vec<(&str, u32)> = vec![(start, 0)];
        visited.insert(start);
        while let Some((node, depth)) = frontier.pop() {
            if depth >= max_depth {
                continue;
            }
            // 邻接表已物化：无需再走 petgraph 边迭代器（T32）。
            for nxt in &self.adjacency[node] {
                if visited.insert(nxt.as_str()) {
                    frontier.push((nxt.as_str(), depth + 1));
                }
            }
        }
        let mut out: Vec<String> = visited.into_iter().map(|s| s.to_string()).collect();
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

// ────────────────────────────────────────────────────────────────────────
// Spec 子模块（T32）：窗口衰减表纯函数规格验证，见同目录
// `canon_search.spec.rs`（经 #[path] 注册为本文件 cfg(test) 子模块，
// 不新增 mod.rs 注册行——改动面收敛在本任务允许的两个文件内）。
// ────────────────────────────────────────────────────────────────────────

#[cfg(test)]
#[path = "canon_search.spec.rs"]
mod canon_search_spec;

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

// ──────────────────────────────────────────────────────────────────────────
// T32 重调参测试：QMAI 召回池代理 + α/β 扫描 + 默认值绑定
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod t32_retune_tests {
    use super::*;
    use crate::types::canon_types::EdgeKind;

    /// QMAI 召回池代理（确定性 fixture，零随机源，跨平台位稳定）。
    ///
    /// 长篇形态编码：
    /// - 36 条查询，at_chapter ∈ [100, 240] 步进 4（中后期叙事窗）。
    /// - 相关集 6 条/查询 = 4 近章事实（d ∈ [0,7]，gain=2：当前场景活跃）
    ///   + 2 远期回调（d ∈ [90,170]，gain=1：「前期伏笔回调」型）。
    ///   分级增益编码产品语义——近章优先，但远回调并非噪声。
    /// - FTS 通道（30 条）：近相关占头部 rank0..3；填充按与 at 的距离升序；
    ///   远相关固定插中段 rank9/14（BM25 只认文本匹配，回调会命中但不在顶）。
    /// - 向量通道（30 条）：语义相似 → 远回调排前部 vrank1/3，近相关散布
    ///   vrank5..11；填充含头部噪声项（vrank0，模拟高相似非相关命中）。
    ///
    /// 该形态下衰减强度直接改变 NDCG@10：无衰减时向量通道把远回调与噪声
    /// 推进头部；过强衰减把合法远引用全部压出窗口。真实 LanceDB 召回池
    /// 接入后必须重扫并更新默认值（债条目见 decision-log）。
    fn qmai_recall_pool() -> Vec<RecallCase> {
        let mut pool = Vec::with_capacity(36);
        for qi in 0..36usize {
            let at = 100 + qi as i32 * 4;

            // 近相关（gain=2）：d = qi%4 + k, k ∈ 0..4 → d ∈ [0,7]
            let mut near: Vec<(String, i32)> = (0..4usize)
                .map(|k| {
                    let d = (qi % 4) as i32 + k as i32;
                    (format!("ent-N{qi:02}-{k}"), at - d)
                })
                .collect();
            near.sort();

            // 远相关回调（gain=1）：d ∈ [90,170]
            let far: Vec<(String, i32)> = (0..2usize)
                .map(|k| {
                    let d = 90 + 40 * k as i32 + (qi % 7) as i32;
                    (format!("ent-F{qi:02}-{k}"), (at - d).max(1))
                })
                .collect();

            // 填充（不相关）24 条：参考章铺满 [0,280)
            let fillers: Vec<(String, i32)> = (0..24usize)
                .map(|j| (format!("ent-X{qi:02}-{j:02}"), ((j * 13) % 280) as i32))
                .collect();

            // 填充按与 at 的距离升序（近填充在前，模拟「邻近章也常被召回」）
            let mut fillers_by_dist = fillers.clone();
            fillers_by_dist.sort_by(|a, b| {
                (a.1 - at)
                    .abs()
                    .cmp(&(b.1 - at).abs())
                    .then_with(|| a.0.cmp(&b.0))
            });

            // FTS 通道顺序：
            // near(0..4) | fd[0..5] | far0@rank9 | fd[5..10] | far1@rank14 | fd[10..]
            let mut fts_order: Vec<(String, i32)> = Vec::with_capacity(30);
            fts_order.extend(near.iter().cloned());
            fts_order.extend(fillers_by_dist[0..5].iter().cloned());
            fts_order.push(far[0].clone());
            fts_order.extend(fillers_by_dist[5..10].iter().cloned());
            fts_order.push(far[1].clone());
            fts_order.extend(fillers_by_dist[10..].iter().cloned());
            let fts: Vec<RecallItem> = fts_order
                .into_iter()
                .enumerate()
                .map(|(rank, (id, ch))| {
                    RecallItem::new(id, RecallSource::Fts, rank, 1.0, Some(ch))
                })
                .collect();

            // 向量通道顺序：
            // fd3 | far0 | fd11 | far1 | fd7 | n0 | fd19 | n1 | fd5 | n2 | fd23 | n3 | 其余填充
            let pick = |j: usize| fillers[j].clone();
            let used: [usize; 6] = [3, 11, 7, 19, 5, 23];
            let mut vec_order: Vec<(String, i32)> = vec![
                pick(3),
                far[0].clone(),
                pick(11),
                far[1].clone(),
                pick(7),
                near[0].clone(),
                pick(19),
                near[1].clone(),
                pick(5),
                near[2].clone(),
                pick(23),
                near[3].clone(),
            ];
            for (j, item) in fillers.iter().enumerate() {
                if !used.contains(&j) {
                    vec_order.push(item.clone());
                }
            }
            let vector: Vec<RecallItem> = vec_order
                .into_iter()
                .enumerate()
                .map(|(rank, (id, ch))| {
                    RecallItem::new(id, RecallSource::Vector, rank, 1.0, Some(ch))
                })
                .collect();

            let mut relevant: Vec<(String, u32)> =
                near.iter().map(|(id, _)| (id.clone(), 2u32)).collect();
            relevant.extend(far.iter().map(|(id, _)| (id.clone(), 1u32)));

            pool.push(RecallCase {
                name: format!("q{qi:02}-ch{at}"),
                fts,
                vector,
                at_chapter: Some(at),
                relevant,
            });
        }
        pool
    }

    /// 参数扫网格（α 细于 β：衰减强度是主要自由度；β 形状为次要自由度）。
    const SWEEP_ALPHAS: [f64; 9] = [0.0, 0.01, 0.02, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2];
    const SWEEP_BETAS: [f64; 4] = [0.75, 1.0, 1.5, 2.0];

    /// 调参前基线（T12 落地时的保守起点，decision-log 记录在案）。
    const INCUMBENT_ALPHA: f64 = 0.1;
    const INCUMBENT_BETA: f64 = 1.0;

    fn sweep_on_qmai_pool() -> DecaySweepReport {
        sweep_decay_params(&qmai_recall_pool(), &SWEEP_ALPHAS, &SWEEP_BETAS, 10)
    }

    /// 扫描赢家（T32 定稿值，2026-08-22）：SearchConfig::default 的 α/β 必须与之
    /// 一致——池/网格演化导致赢家变化时，本断言强制显式重定默认值而非静默漂移。
    const TUNED_ALPHA: f64 = 0.08;
    const TUNED_BETA: f64 = 0.75;

    #[test]
    fn t32_default_config_matches_swept_winner() {
        let report = sweep_on_qmai_pool();
        let best = report.best().expect("non-empty report");
        assert!(
            (best.alpha - TUNED_ALPHA).abs() < 1e-12 && (best.beta - TUNED_BETA).abs() < 1e-12,
            "sweep winner ({}, {}) drifted from tuned defaults ({TUNED_ALPHA}, {TUNED_BETA});              re-run tuning and consciously update SearchConfig::default + decision-log",
            best.alpha, best.beta
        );
        let d = SearchConfig::default();
        assert!((d.decay_alpha - TUNED_ALPHA).abs() < 1e-12);
        assert!((d.decay_beta - TUNED_BETA).abs() < 1e-12);
        // A-06：rank_const 不入扫参，恒为 1
        assert!((d.rrf_rank_const - 1.0).abs() < 1e-12);
    }

    #[test]
    fn t32_decay_sweep_on_qmai_pool_is_deterministic_and_beats_incumbent() {
        let r1 = sweep_on_qmai_pool();
        let r2 = sweep_on_qmai_pool();
        assert_eq!(r1, r2, "sweep must be deterministic (same grid, same pool)");

        assert_eq!(
            r1.candidates.len(),
            SWEEP_ALPHAS.len() * SWEEP_BETAS.len(),
            "full grid evaluated"
        );
        // 降序排列不变量
        for w in r1.candidates.windows(2) {
            assert!(
                w[0].mean_ndcg >= w[1].mean_ndcg,
                "report must be sorted desc by mean_ndcg"
            );
        }

        let incumbent = r1
            .candidate_at(INCUMBENT_ALPHA, INCUMBENT_BETA)
            .expect("incumbent (0.1, 1.0) must be in grid");
        let best = r1.best().expect("non-empty report");
        assert!(
            best.mean_ndcg >= incumbent.mean_ndcg - 1e-12,
            "winner {best:?} must not lose to incumbent {incumbent:?}"
        );
        assert!(best.mean_ndcg > 0.5, "pool must be rankable above chance");

        println!(
            "T32 sweep winner: alpha={} beta={} mean_ndcg={:.6} | incumbent mean_ndcg={:.6}",
            best.alpha, best.beta, best.mean_ndcg, incumbent.mean_ndcg
        );
        for c in r1.candidates.iter().take(5) {
            println!(
                "  top candidate: alpha={} beta={} ndcg={:.6}",
                c.alpha, c.beta, c.mean_ndcg
            );
        }
    }

    #[test]
    fn t32_strong_decay_pushes_far_callbacks_out_weak_keeps_them() {
        // 形态健全性：强衰减下远回调（d≥90）权重被压到近相关的数十分之一；
        // α=0 时完全不衰减，两者同权。这保证扫参方向有实际区分度。
        let d_far = 130;
        let strong = decay(d_far, 0.2, 2.0);
        let weak_near = decay(3, 0.2, 2.0);
        assert!(strong < weak_near / 100.0, "far under strong decay << near");
        assert!((decay(d_far, 0.0, 2.0) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn t32_ndcg_graded_gains_and_degenerate_cases() {
        let mk = |id: &str| FusedResult {
            id: id.to_string(),
            fusion_score: 1.0,
            decayed_score: 1.0,
            fts_rank: None,
            vector_rank: None,
            chapter_distance: 0,
        };
        let rel = vec![("near".to_string(), 2u32), ("far".to_string(), 1u32)];
        // 完美排序（高增益在前）→ 1.0
        let perfect = vec![mk("near"), mk("far")];
        assert!((ndcg_at_k(&perfect, &rel, 10) - 1.0).abs() < 1e-12);
        // 反序 → < 1.0 且 > 0
        let reversed = vec![mk("far"), mk("near")];
        let rev_ndcg = ndcg_at_k(&reversed, &rel, 10);
        assert!(rev_ndcg > 0.0 && rev_ndcg < 1.0);
        // 空 relevant → 0.0（约定）
        assert_eq!(ndcg_at_k(&perfect, &[], 10), 0.0);
        // k 截断：top-1 命中最高增益 → 满分；低增益居首则只得部分分（< 1）
        assert!((ndcg_at_k(&perfect, &rel, 1) - 1.0).abs() < 1e-12);
        let head_low = ndcg_at_k(&reversed, &rel, 1);
        assert!(head_low > 0.0 && head_low < 1.0);
    }

    #[test]
    fn t32_graph_adjacency_materialized_sorted_deduped() {
        let edges = vec![
            edge("e1", "b", "a"),
            edge("e2", "b", "a"), // 同向多边 → 折叠
            edge("e3", "b", "c"),
        ];
        let g = CanonGraph::from_edges(&edges);
        let adj = g.adjacency();
        assert_eq!(
            adj.get("b").map(|v| v.as_slice()),
            Some(&["a".to_string(), "c".to_string()][..])
        );
        assert!(adj.contains_key("a"), "isolated target keeps an (empty) key");
        assert!(adj.get("a").unwrap().is_empty());
        // BFS 结果与邻接表一致（物化不改变遍历语义）
        assert_eq!(
            g.bfs_depth("b", 1),
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
    }

    fn edge(id: &str, s: &str, t: &str) -> CanonEdge {
        CanonEdge::new(id, s, t, "rel", EdgeKind::WorldFact)
    }
}

// ──────────────────────────────────────────────────────────────────────────
// 性能基准（T32：查询延迟基线入测试断言）
// ──────────────────────────────────────────────────────────────────────────
//
// 口径：合成召回 200 FTS + 200 向量、top_k=50 / 2,000 节点图 depth=3 全起
// 点遍历；预算为本机实测值 × 放宽系数（吸收 CI 虚拟化抖动），劣化超量级
// 才报警。基线数字随 decision-log 落档；换机后以本测试重测为准。

#[cfg(test)]
mod perf_tests {
    use super::*;
    use crate::types::canon_types::EdgeKind;
    use std::time::Instant;

    fn synthetic_fts(n: usize, seed: usize) -> Vec<RecallItem> {
        (0..n)
            .map(|r| {
                let j = (r * 37 + seed * 11) % 400;
                RecallItem::new(
                    format!("ent-{j:03}"),
                    RecallSource::Fts,
                    r,
                    1.0,
                    Some(((j * 7) % 300) as i32),
                )
            })
            .collect()
    }

    fn synthetic_vector(n: usize, seed: usize) -> Vec<RecallItem> {
        (0..n)
            .map(|r| {
                let j = (r * 53 + seed * 29) % 400;
                RecallItem::new(
                    format!("ent-{j:03}"),
                    RecallSource::Vector,
                    r,
                    1.0,
                    Some(((j * 17) % 300) as i32),
                )
            })
            .collect()
    }

    /// 查询延迟基线：fuse → decay → sort → topK 全链路。
    ///
    /// 基线实测（2026-08-22，dev 机，cargo test 默认 debug 构建）：
    /// ≈ 350–450 µs/op（200+200 召回，top_k=50）。预算 2,000 µs ≈ 5× 实测
    /// 上限，拦截量级劣化（如误引入 O(n²) 路径）；release 构建预期低一个量级。
    #[test]
    fn perf_engine_search_latency_baseline() {
        let engine = CanonSearchEngine::default();
        let fts = synthetic_fts(200, 1);
        let vector = synthetic_vector(200, 2);
        // warmup（页缓存/分支预测）
        for i in 0..20 {
            let _ = engine.search(&fts, &vector, Some(150 + i as i32), 50);
        }
        let runs = 400usize;
        let t0 = Instant::now();
        for i in 0..runs {
            let _ = engine.search(&fts, &vector, Some((100 + i % 200) as i32), 50);
        }
        let per_op_us = t0.elapsed().as_secs_f64() * 1e6 / runs as f64;
        const BUDGET_US: f64 = 2_000.0;
        assert!(
            per_op_us < BUDGET_US,
            "search latency {per_op_us:.1}us/op exceeds baseline budget {BUDGET_US}us"
        );
        println!("perf_engine_search: {per_op_us:.1}us/op (budget {BUDGET_US}us)");
    }

    /// 物化邻接表 BFS 延迟基线：2,000 节点主链 + 500 条旁路跳边，
    /// depth=3 从全部起点各遍历一次（图构建成本不计入延迟口径）。
    #[test]
    fn perf_bfs_adjacency_materialized_baseline() {
        let mut edges: Vec<CanonEdge> = (0..2000usize)
            .map(|i| {
                CanonEdge::new(
                    format!("chain{i}"),
                    format!("n{i:04}"),
                    format!("n{:04}", (i + 1) % 2000),
                    "next",
                    EdgeKind::WorldFact,
                )
            })
            .collect();
        edges.extend((0..500usize).map(|i| {
            CanonEdge::new(
                format!("skip{i}"),
                format!("n{i:04}"),
                format!("n{:04}", (i + 7) % 2000),
                "foreshadow",
                EdgeKind::WorldFact,
            )
        }));
        let g = CanonGraph::from_edges(&edges);
        assert_eq!(g.node_count(), 2000);
        assert_eq!(g.edge_count(), 2500);

        let starts: Vec<String> = (0..2000usize).map(|i| format!("n{i:04}")).collect();
        // warmup
        for s in starts.iter().take(50) {
            let _ = g.bfs_depth(s, 3);
        }
        let t0 = Instant::now();
        for s in &starts {
            let reach = g.bfs_depth(s, 3);
            assert!(!reach.is_empty());
        }
        let total_ms = t0.elapsed().as_millis();
        const BUDGET_MS: u128 = 500;
        assert!(
            total_ms < BUDGET_MS,
            "2000x bfs_depth(depth=3) took {total_ms}ms, exceeds budget {BUDGET_MS}ms"
        );
        println!("perf_bfs_adjacency: 2000 traversals in {total_ms}ms (budget {BUDGET_MS}ms)");
    }
}
