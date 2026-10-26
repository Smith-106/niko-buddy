// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Canon 确定性冲突分类层——M14-2 自 `store.rs` 增量剥离（S4 单轮收敛，fs_archive 模式）。
//!
//! 收容：确定性冲突分类（[`classify_conflict`] + `intervals_overlap`）——
//! 全部确定性、无 IO。`store.rs` 的 `CanonStore::supersede_edges`（IO 层）
//! 写前调用本函数做 graphiti dedupe 语义分类。
//! `store.rs` 经 `pub use` 回引，外部 import 面零变化。

use crate::canon::types::{CanonEdge, ConflictClass};

// ──────────────────────────────────────────────────────────────────────────
// 53 号报告 P0-2: 确定性冲突语义分类 (graphiti dedupe/contradiction 语义,
// Apache-2.0 借模式; Rust 存储层零 LLM 守 ADR-19, LLM 分类为 TS 侧 advisory)
// ──────────────────────────────────────────────────────────────────────────

/// 确定性冲突分类纯函数 (零 IO, 可 cargo test + proptest)。
/// 判定规则 (宁漏勿误, 歧义一律 Independent 绝不误杀合法剧情):
///  1. digest 非空且相等 + 有效区间重叠 → Duplicate (幂等键 graphiti 模式);
///  2. (source_id, target_id, predicate) 全等 + 有效区间重叠 → Duplicate
///     (同事实重复写入);
///  3. 同 source_id 同 predicate 指向不同 target + 有效区间重叠 → Contradicted
///     (同事实不同值);
///  4. 其余 → Independent。
/// 注: belief/hypothesis 认知模态边 (Modality 非 Assertive) 不参与矛盾判定
/// (落点①: 认知模态与 edge_kind 正交, 不与确定性分类冲突)。
pub fn classify_conflict(new_edge: &CanonEdge, existing: &[CanonEdge]) -> ConflictClass {
    // 1. digest 非空且相等 + 有效区间重叠 → Duplicate (幂等键 graphiti 模式)。
    //    仅 digest 判定重复: supersede 是调用方显式操作 (封顶旧边+插入新边),
    //    同键非 digest 属信任调用方 (宁漏勿误, 绝不误拦合法更正)。
    if !new_edge.digest.is_empty() {
        if let Some(prev) = existing.iter().find(|e| e.digest == new_edge.digest) {
            if intervals_overlap(prev, new_edge) {
                return ConflictClass::Duplicate;
            }
        }
    }
    // 2. 同 source_id 同 predicate 指向不同 target + 有效区间重叠 → Contradicted
    //    (同事实不同值, 语义矛盾)。belief/hypothesis 认知模态边不参与矛盾判定
    //    (落点①: 认知模态与 edge_kind 正交)。
    if existing.iter().any(|e| {
        e.source_id == new_edge.source_id
            && e.predicate == new_edge.predicate
            && e.target_id != new_edge.target_id
            && intervals_overlap(e, new_edge)
    }) {
        return ConflictClass::Contradicted;
    }
    // 3. 其余 → Independent (含全等键同值重复: 由调用方显式意图决定, 不自动拦)。
    ConflictClass::Independent
}

/// 有效区间重叠判定: 未封顶 (invalid_at None) 视为延伸到未来, 与任何起始
/// 不晚于自身的有效区间相交。
fn intervals_overlap(a: &CanonEdge, b: &CanonEdge) -> bool {
    let a_start = a.valid_at.unwrap_or(i32::MIN);
    let b_start = b.valid_at.unwrap_or(i32::MIN);
    match (a.invalid_at, b.invalid_at) {
        // 双方都未封顶 → 均为 [start, ∞) → 必相交 (时间轴单调延续)
        (None, None) => true,
        // a 封顶 b 未封顶: a=[a_start,a_inv], b=[b_start,∞) → b_start ≤ a_inv
        (Some(a_inv), None) => b_start <= a_inv,
        (None, Some(b_inv)) => a_start <= b_inv,
        (Some(a_inv), Some(b_inv)) => a_start <= b_inv && b_start <= a_inv,
    }
}
