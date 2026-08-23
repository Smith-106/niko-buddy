// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Studio Contributors
//! T04 LanceDB 0.27 FTS spike — 独立实验文件（**不进 mod.rs**）。
//!
//! 目标（蓝图 §6 T04 / A-01.5）：
//!   1. 验证 tantivy FTS 与向量列同表共存（LanceDB 0.27 内置 FTS 索引）。
//!   2. chunk 粒度消融：句 / 段 / 混合召回对比。
//!   3. 嵌入选型判据：中文友好本地模型 100-500MB 档、维度/归一化/度量三参数入 DDL。
//!   4. 分词器矩阵：tantivy-jieba / jieba-rs 为首选基线（词表 5-10MB），
//!      实测 LanceDB 自定义 tokenizer 通道后裁决。
//!
//! 本文件是 spike 实验代码，不注册到 lib.rs / mod.rs，不进入产品主链。
//! 结论与裁决见 `docs/p0/lancedb-fts-spike.md`。

use std::collections::HashMap;

/// 分词粒度枚举（chunk 粒度消融实验的三种形态）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkGranularity {
    /// 按句切分（短 chunk，召回精度高、上下文少）
    Sentence,
    /// 按段切分（中 chunk，召回与上下文平衡）
    Paragraph,
    /// 句段混合（长 chunk 内嵌句索引，召回与上下文兼顾）
    Mixed,
}

impl ChunkGranularity {
    pub fn label(self) -> &'static str {
        match self {
            Self::Sentence => "sentence",
            Self::Paragraph => "paragraph",
            Self::Mixed => "mixed",
        }
    }
}

/// 一次 FTS 召回实验的观测结果。
#[derive(Debug, Clone)]
pub struct FtsObservation {
    pub granularity: ChunkGranularity,
    /// 召回率（命中相关文档数 / 相关文档总数），[0,1]
    pub recall: f32,
    /// 平均检索延迟（毫秒）
    pub latency_ms: f32,
    /// 索引体积（MB）
    pub index_mb: f32,
}

/// 分词器候选（分词器矩阵实验）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TokenizerCandidate {
    /// tantivy-jieba（首选基线，词表 5-10MB）
    TantivyJieba,
    /// jieba-rs（备选基线）
    JiebaRs,
    /// LanceDB 内置默认 tokenizer（英文空格分词，中文退化为整句）
    LanceDbDefault,
}

impl TokenizerCandidate {
    pub fn label(self) -> &'static str {
        match self {
            Self::TantivyJieba => "tantivy-jieba",
            Self::JiebaRs => "jieba-rs",
            Self::LanceDbDefault => "lancedb-default",
        }
    }
}

/// 嵌入选型判据（蓝图 §8）：中文友好本地模型 100-500MB 档。
///
/// 三参数入 DDL（T11 canon DDL 采纳）：
///   - dimension：向量维度（如 768 / 1024）
///   - normalize：是否 L2 归一化（余弦相似度前提）
///   - metric：距离度量（L2 / Cosine / Dot）
#[derive(Debug, Clone)]
pub struct EmbeddingProfile {
    pub model_name: String,
    pub dimension: u32,
    pub normalize: bool,
    pub metric: String,
    pub model_version: String,
}

impl EmbeddingProfile {
    /// 中文友好本地模型 100-500MB 档的推荐候选（spike 阶段默认值）。
    pub fn recommended() -> Self {
        Self {
            model_name: "bge-small-zh-v1.5".to_string(),
            dimension: 512,
            normalize: true,
            metric: "cosine".to_string(),
            model_version: "v1.5".to_string(),
        }
    }
}

/// 纯算术 FTS 召回评分（ADR-19 机械层零 LLM：本模块无 IO / LLM 调用）。
///
/// 综合分 = 0.6 * recall + 0.4 * latency_penalty，
/// latency_penalty = clamp(1 - latency_ms / 1000, 0, 1)。
pub fn fts_score(obs: &FtsObservation) -> f32 {
    let latency_penalty = (1.0 - obs.latency_ms / 1000.0).clamp(0.0, 1.0);
    0.6 * obs.recall + 0.4 * latency_penalty
}

/// 分词器矩阵裁决：给定各候选的召回率，返回最优候选。
///
/// 裁决规则（蓝图 §9）：首选 tantivy-jieba / jieba-rs（词表 5-10MB）；
/// 若 LanceDB 自定义 tokenizer 通道实测可用且召回不劣于 jieba 基线，
/// 则采纳 LanceDB 内置通道（少一层依赖）。
pub fn tokenizer_verdict(recall_by_candidate: &HashMap<TokenizerCandidate, f32>) -> TokenizerCandidate {
    let jieba_best = recall_by_candidate
        .get(&TokenizerCandidate::TantivyJieba)
        .copied()
        .unwrap_or(0.0)
        .max(
            recall_by_candidate
                .get(&TokenizerCandidate::JiebaRs)
                .copied()
                .unwrap_or(0.0),
        );
    let lancedb_default = recall_by_candidate
        .get(&TokenizerCandidate::LanceDbDefault)
        .copied()
        .unwrap_or(0.0);
    if lancedb_default >= jieba_best - 0.05 {
        TokenizerCandidate::LanceDbDefault
    } else {
        TokenizerCandidate::TantivyJieba
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_granularity_labels() {
        assert_eq!(ChunkGranularity::Sentence.label(), "sentence");
        assert_eq!(ChunkGranularity::Paragraph.label(), "paragraph");
        assert_eq!(ChunkGranularity::Mixed.label(), "mixed");
    }

    #[test]
    fn fts_score_weights_recall_over_latency() {
        let good = FtsObservation {
            granularity: ChunkGranularity::Mixed,
            recall: 0.9,
            latency_ms: 50.0,
            index_mb: 12.0,
        };
        let bad = FtsObservation {
            granularity: ChunkGranularity::Sentence,
            recall: 0.4,
            latency_ms: 800.0,
            index_mb: 8.0,
        };
        assert!(fts_score(&good) > fts_score(&bad));
        // 满分边界：recall=1 + latency=0 → 1.0
        let perfect = FtsObservation {
            granularity: ChunkGranularity::Mixed,
            recall: 1.0,
            latency_ms: 0.0,
            index_mb: 10.0,
        };
        assert!((fts_score(&perfect) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn tokenizer_verdict_prefers_jieba_when_lancedb_default_weak() {
        let mut m = HashMap::new();
        m.insert(TokenizerCandidate::TantivyJieba, 0.85);
        m.insert(TokenizerCandidate::JiebaRs, 0.82);
        m.insert(TokenizerCandidate::LanceDbDefault, 0.30);
        assert_eq!(
            tokenizer_verdict(&m),
            TokenizerCandidate::TantivyJieba
        );
    }

    #[test]
    fn tokenizer_verdict_accepts_lancedb_default_when_within_tolerance() {
        let mut m = HashMap::new();
        m.insert(TokenizerCandidate::TantivyJieba, 0.85);
        m.insert(TokenizerCandidate::LanceDbDefault, 0.82);
        assert_eq!(
            tokenizer_verdict(&m),
            TokenizerCandidate::LanceDbDefault
        );
    }

    #[test]
    fn embedding_profile_recommended_is_chinese_friendly() {
        let p = EmbeddingProfile::recommended();
        assert_eq!(p.model_name, "bge-small-zh-v1.5");
        assert_eq!(p.dimension, 512);
        assert!(p.normalize);
        assert_eq!(p.metric, "cosine");
    }
}
