// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Canon 检索评分纯函数层——M1-2 自 `search.rs` 增量剥离（S4 单轮收敛，fs_archive 模式）。
//!
//! 收容：检索配置 [`SearchConfig`]、召回/融合结果类型（[`RecallSource`] /
//! [`RecallItem`] / [`FusedResult`] / [`FusedAccum`]）、RRF 融合
//! （[`rrf_contribution`] / [`rrf_fuse`]）与窗口衰减（[`decay`] /
//! [`chapter_distance`] / [`window_decay`]）——全部确定性、无 IO。
//! `search.rs` 经 `pub use` 回引，外部 import 面零变化
//! （存活引用由留守的引擎/参数扫/缓存/IO 层持有：`CanonSearchEngine::search` →
//! `rrf_fuse`/`window_decay`，`sweep_decay_params` → 引擎/配置/召回类型，
//! `WindowDecayTable::new` → `decay`，缓存/IO → `FusedResult`/`RecallItem`）。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

// ──────────────────────────────────────────────────────────────────────────
// 配置（纯数据，蓝图 §9 因子 ⑤：α/β 入 config）
// ──────────────────────────────────────────────────────────────────────────

/// 混合检索 + 窗口衰减配置。
///
/// 所有参数入 config（蓝图 §9 信号因子 ⑤：「RRF 衰减函数形式冻结
/// decay(d)=1/(1+α·d)^β」，α/β 参数化；T32 在 Niko Buddy 召回池做 α/β 扫描，
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
            // 窗口衰减默认（T32 重调参定稿，2026-08-22）：Niko Buddy 形态代理池上
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
    // 四-5：读侧加法兼容 camel（rawScore），主名 snake 不变（内部融合数学，零 IPC 写变更）。
    #[serde(alias = "rawScore")]
    pub raw_score: f64,
    /// 叙事参考章节（窗口衰减距离基准；None=不衰减）。
    #[serde(alias = "referenceChapter")]
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
    // 四-5：同上，读侧 camel alias，主名不变。
    #[serde(alias = "fusionScore")]
    pub fusion_score: f64,
    /// 窗口衰减后最终分（fusion_score × decay(d)）。
    #[serde(alias = "decayedScore")]
    pub decayed_score: f64,
    /// 该 id 在 FTS 通道的 rank（若命中）。
    #[serde(alias = "ftsRank")]
    pub fts_rank: Option<usize>,
    /// 该 id 在向量通道的 rank（若命中）。
    #[serde(alias = "vectorRank")]
    pub vector_rank: Option<usize>,
    /// 用于衰减的章节距离 d（≥0；0=同章或未知）。
    #[serde(alias = "chapterDistance")]
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
pub fn rrf_fuse(
    rank_const: f64,
    fts: &[RecallItem],
    vector: &[RecallItem],
) -> HashMap<String, FusedAccum> {
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
/// T32 在 Niko Buddy 召回池扫描 α/β，函数形式不换。
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
