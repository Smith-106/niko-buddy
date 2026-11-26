// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Canon 确定性冲突分类层——M14-2 自 `store.rs` 增量剥离（S4 单轮收敛，fs_archive 模式）。
//!
//! 收容：确定性冲突分类（[`classify_conflict`] + `intervals_overlap`）——
//! 全部确定性、无 IO。`store.rs` 的 `CanonStore::supersede_edges`（IO 层）
//! 写前调用本函数做 graphiti dedupe 语义分类。
//! `store.rs` 经 `pub use` 回引，外部 import 面零变化。

use crate::canon::types::{CanonEdge, ConflictClass, Modality};

// ──────────────────────────────────────────────────────────────────────────
// 53 号报告 P0-2: 确定性冲突语义分类 (graphiti dedupe/contradiction 语义,
// Apache-2.0 借模式; Rust 存储层零 LLM 守 ADR-19, LLM 分类为 TS 侧 advisory)
// ──────────────────────────────────────────────────────────────────────────

/// 确定性冲突分类纯函数 (零 IO, 可 cargo test + proptest)。
/// 判定规则 (宁漏勿误, 歧义一律 Independent 绝不误杀合法剧情):
///  1. digest 非空且存在非自身、未归档、同 digest 且半开有效区间重叠的旧边 → Duplicate
///     (幂等键 graphiti 模式，对全部模态生效);
///  2. 双方均为 `Modality::Assertive`，且非自身、未归档、同 source_id 同 predicate
///     指向不同 target 且半开有效区间重叠 → Contradicted (同事实不同值);
///     非 Assertive 模态（Belief / Hypothesis / Retconned）豁免矛盾判定;
///  3. 其余 → Independent。
pub fn classify_conflict(new_edge: &CanonEdge, existing: &[CanonEdge]) -> ConflictClass {
    // 1. digest 非空且相等 + 半开有效区间重叠 → Duplicate (幂等键 graphiti 模式，全模态生效)。
    //    跳过自身 (e.id == new_edge.id) 与已归档边 (e.archived)，遍历全部同 digest 边避免漏判。
    if !new_edge.digest.is_empty()
        && existing.iter().any(|e| {
            e.id != new_edge.id
                && !e.archived
                && e.digest == new_edge.digest
                && intervals_overlap(e, new_edge)
        })
    {
        return ConflictClass::Duplicate;
    }
    // 2. 同 source_id 同 predicate 指向不同 target + 半开有效区间重叠 → Contradicted
    //    (同事实不同值, 语义矛盾)。仅当双方均为 Assertive 模态时判矛盾；
    //    belief/hypothesis/retconned 非断言模态豁免矛盾判定。
    if new_edge.modality == Modality::Assertive
        && existing.iter().any(|e| {
            e.id != new_edge.id
                && !e.archived
                && e.modality == Modality::Assertive
                && e.source_id == new_edge.source_id
                && e.predicate == new_edge.predicate
                && e.target_id != new_edge.target_id
                && intervals_overlap(e, new_edge)
        })
    {
        return ConflictClass::Contradicted;
    }
    // 3. 其余 → Independent (含全等键同值重复: 由调用方显式意图决定, 不自动拦)。
    ConflictClass::Independent
}

/// 半开有效区间 `[valid_at, invalid_at)` 重叠判定（严格 `<`）：
/// - 退化空区间（`start >= end`）恒返回 `false`；
/// - 未封顶（`invalid_at == None`）视为 `[start, +∞)`；
/// - 相邻区间如 `[1, 5)` 与 `[5, 9)` 不重叠（`5 < 5` 为 `false`）。
fn intervals_overlap(a: &CanonEdge, b: &CanonEdge) -> bool {
    let a_start = a.valid_at.unwrap_or(i32::MIN);
    let b_start = b.valid_at.unwrap_or(i32::MIN);
    if let Some(a_inv) = a.invalid_at {
        if a_start >= a_inv {
            return false;
        }
    }
    if let Some(b_inv) = b.invalid_at {
        if b_start >= b_inv {
            return false;
        }
    }
    match (a.invalid_at, b.invalid_at) {
        // 双方都未封顶 → 均为 [start, +∞) → 必相交
        (None, None) => true,
        // a=[a_start, a_inv), b=[b_start, +∞) → b_start < a_inv
        (Some(a_inv), None) => b_start < a_inv,
        // a=[a_start, +∞), b=[b_start, b_inv) → a_start < b_inv
        (None, Some(b_inv)) => a_start < b_inv,
        // 双方封顶 → a_start < b_inv && b_start < a_inv
        (Some(a_inv), Some(b_inv)) => a_start < b_inv && b_start < a_inv,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canon::types::EdgeKind;

    fn mk_edge(id: &str, tgt: &str, v: Option<i32>, inv: Option<i32>) -> CanonEdge {
        let mut e = CanonEdge::new(id, "src", tgt, "rel", EdgeKind::WorldFact);
        e.valid_at = v;
        e.invalid_at = inv;
        e
    }

    #[test]
    fn half_open_adjacent_and_empty_intervals_do_not_overlap() {
        // [1, 5) 与 [5, 9) 相邻不重叠
        let a = mk_edge("a", "t1", Some(1), Some(5));
        let b = mk_edge("b", "t2", Some(5), Some(9));
        assert!(!intervals_overlap(&a, &b));
        assert!(!intervals_overlap(&b, &a));

        // [1, 5) 与 [5, +∞) 相邻不重叠
        let c = mk_edge("c", "t2", Some(5), None);
        assert!(!intervals_overlap(&a, &c));

        // 退化空区间 [5, 5) 与倒置区间 [6, 4) 恒不重叠
        let empty = mk_edge("empty", "t1", Some(5), Some(5));
        let inverted = mk_edge("inv", "t1", Some(6), Some(4));
        let wide = mk_edge("wide", "t2", Some(1), Some(10));
        let open = mk_edge("open", "t2", None, None);
        assert!(!intervals_overlap(&empty, &wide));
        assert!(!intervals_overlap(&wide, &empty));
        assert!(!intervals_overlap(&empty, &open));
        assert!(!intervals_overlap(&inverted, &wide));
        assert!(!intervals_overlap(&inverted, &open));

        // 正常重叠 [1, 6) 与 [5, 9)
        let d = mk_edge("d", "t1", Some(1), Some(6));
        assert!(intervals_overlap(&d, &b));
    }

    #[test]
    fn classify_conflict_checks_all_digest_edges_and_skips_self_and_archived() {
        // 同 digest 第一条已封顶不重叠、第二条仍有效重叠 → 必须命中 Duplicate（回归 :33 find → any）
        let mut old_capped = mk_edge("e1", "t1", Some(1), Some(5));
        old_capped.digest = "same-digest".into();
        let mut active_dup = mk_edge("e2", "t1", Some(5), None);
        active_dup.digest = "same-digest".into();
        let mut new_e = mk_edge("e3", "t1", Some(6), None);
        new_e.digest = "same-digest".into();
        assert_eq!(
            classify_conflict(&new_e, &[old_capped, active_dup]),
            ConflictClass::Duplicate
        );

        // 跳过自身 id（即使 digest 与 target 均不同/相同）
        let mut self_existing = mk_edge("same-id", "t1", Some(1), None);
        self_existing.digest = "dup".into();
        let mut self_new = mk_edge("same-id", "t2", Some(2), None);
        self_new.digest = "dup".into();
        assert_eq!(
            classify_conflict(&self_new, &[self_existing]),
            ConflictClass::Independent
        );

        // 跳过 archived 边
        let mut archived_dup = mk_edge("arch1", "t2", Some(1), None);
        archived_dup.digest = "dup".into();
        archived_dup.archived = true;
        let mut probe = mk_edge("p1", "t1", Some(2), None);
        probe.digest = "dup".into();
        assert_eq!(
            classify_conflict(&probe, &[archived_dup]),
            ConflictClass::Independent
        );
    }

    #[test]
    fn classify_conflict_exempts_non_assertive_from_contradicted_but_keeps_duplicate() {
        let existing_assertive = mk_edge("e1", "capitalA", Some(1), None);
        let mut new_belief = mk_edge("e2", "capitalB", Some(2), None);
        new_belief.modality = Modality::Belief;
        assert_eq!(
            classify_conflict(&new_belief, std::slice::from_ref(&existing_assertive)),
            ConflictClass::Independent,
            "新边非 Assertive 时豁免矛盾判定"
        );

        let mut existing_hyp = mk_edge("e3", "capitalA", Some(1), None);
        existing_hyp.modality = Modality::Hypothesis;
        let new_assertive = mk_edge("e4", "capitalB", Some(2), None);
        assert_eq!(
            classify_conflict(&new_assertive, &[existing_hyp]),
            ConflictClass::Independent,
            "旧边非 Assertive 时豁免矛盾判定"
        );

        // Duplicate 仍对非 Assertive 模态生效
        let mut belief_a = mk_edge("b1", "capitalA", Some(1), None);
        belief_a.modality = Modality::Belief;
        belief_a.digest = "belief-dup".into();
        let mut belief_b = mk_edge("b2", "capitalA", Some(2), None);
        belief_b.modality = Modality::Belief;
        belief_b.digest = "belief-dup".into();
        assert_eq!(
            classify_conflict(&belief_b, &[belief_a]),
            ConflictClass::Duplicate
        );
    }
}
