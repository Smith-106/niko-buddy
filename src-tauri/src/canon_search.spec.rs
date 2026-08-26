// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! T32 spec — 窗口衰减表纯函数规格验证（任务要求：入 spec 验证）。
//!
//! 本文件经 [`super::canon_search`] 内 `#[path = "canon_search.spec.rs"]`
//! 注册为其 `cfg(test)` 子模块，不新增 `mod.rs` 注册行（改动面收敛在
//! T32 允许的两个文件内）。只承载 [`WindowDecayTable`] 与窗口衰减纯函数
//! 的规格级验证：
//!
//! - **表 ≡ 闭式**：查表结果与冻结形式 `decay(d)=1/(1+α·d)^β` 逐点一致
//!   （偏差 ≤ 1e-12；网格 + proptest 双覆盖）。
//! - **单调性**：全表非递增。
//! - **边界**：d=0 恒 1.0；α=0 恒 1.0；越界钳制到边界表项且不再增大。
//! - **引擎一致性**：融合分 × 表权重 ≡ 引擎 `window_decay` 输出的
//!   decayed_score。

use super::*;

// ── 表 ≡ 闭式 ──

#[test]
fn spec_decay_table_matches_closed_form_grid() {
    for &alpha in &[0.0f64, 0.01, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0] {
        for &beta in &[0.0f64, 0.25, 0.75, 1.0, 1.5, 2.0, 3.0] {
            let table = WindowDecayTable::new(alpha, beta, 200);
            for d in 0..=200i32 {
                let w_table = table.weight(d);
                let w_closed = decay(d, alpha, beta);
                assert!(
                    (w_table - w_closed).abs() <= 1e-12,
                    "table≠closed-form at α={alpha} β={beta} d={d}: {w_table} vs {w_closed}"
                );
            }
        }
    }
}

#[test]
fn spec_decay_table_monotone_over_full_range() {
    let table = WindowDecayTable::new(0.07, 1.25, 300);
    let mut prev = f64::INFINITY;
    for d in -10i32..=400 {
        let w = table.weight(d);
        assert!(w <= prev + 1e-15, "non-increasing violated at d={d}");
        prev = w;
    }
}

#[test]
fn spec_decay_table_d0_identity_for_all_params() {
    for &alpha in &[0.0f64, 0.05, 0.5, 3.0] {
        for &beta in &[0.5f64, 1.0, 2.0] {
            let table = WindowDecayTable::new(alpha, beta, 100);
            assert!((table.weight(0) - 1.0).abs() < 1e-12);
            // 负距离与 d=0 同语义（与 decay 一致）
            assert!((table.weight(-7) - 1.0).abs() < 1e-12);
        }
    }
}

#[test]
fn spec_decay_table_alpha_zero_constant_one() {
    let table = WindowDecayTable::new(0.0, 1.7, 64);
    for d in [0, 1, 17, 63, 64, 65, 10_000] {
        assert!((table.weight(d) - 1.0).abs() < 1e-12, "α=0 → weight 1.0 at d={d}");
    }
}

#[test]
fn spec_decay_table_clamps_beyond_window_without_increase() {
    let max_d = 120u32;
    let table = WindowDecayTable::new(0.03, 1.5, max_d);
    let boundary = table.weight(max_d as i32);
    for d in [max_d as i32 + 1, max_d as i32 + 50, i32::MAX / 2] {
        assert!(
            (table.weight(d) - boundary).abs() < 1e-15,
            "beyond-window clamps to boundary at d={d}"
        );
    }
    assert!(boundary <= table.weight(max_d as i32 - 1) + 1e-15);
}

#[test]
fn spec_decay_table_zero_max_distance_single_entry() {
    let table = WindowDecayTable::new(0.1, 1.0, 0);
    assert_eq!(table.len(), 1);
    assert!((table.weight(0) - 1.0).abs() < 1e-12);
    // clamp 到唯一表项（d=0 权重）
    assert!((table.weight(500) - 1.0).abs() < 1e-12);
}

#[test]
fn spec_decay_table_metadata_accessors_roundtrip() {
    let (a, b, m) = (0.13f64, 0.8f64, 42u32);
    let t = WindowDecayTable::new(a, b, m);
    assert_eq!(t.alpha(), a);
    assert_eq!(t.beta(), b);
    assert_eq!(t.max_distance(), m);
    assert_eq!(t.len(), (m + 1) as usize);
    assert!(!t.is_empty());
}

/// 引擎一致性：对任意融合累加项，`fusion_score × table.weight(d)` 与
/// 引擎 `window_decay` 的 decayed_score 相等（同一纯函数的两种载体）。
#[test]
fn spec_decay_table_consistent_with_engine_window_decay() {
    let cfg = SearchConfig {
        decay_alpha: 0.04,
        decay_beta: 1.2,
        ..SearchConfig::default()
    };
    let table = WindowDecayTable::new(cfg.decay_alpha, cfg.decay_beta, 400);
    let fts: Vec<RecallItem> = (0..6usize)
        .map(|r| {
            RecallItem::new(
                format!("s{r}"),
                RecallSource::Fts,
                r * 2,
                1.0,
                Some(r as i32 * 37),
            )
        })
        .collect();
    let vector: Vec<RecallItem> = (0..6usize)
        .map(|r| {
            RecallItem::new(
                format!("s{}", 5 - r),
                RecallSource::Vector,
                r,
                1.0,
                Some((5 - r) as i32 * 37),
            )
        })
        .collect();
    let accum = rrf_fuse(cfg.rrf_rank_const, &fts, &vector);
    let results = window_decay(accum.clone(), Some(150), &cfg);
    for r in &results {
        let a = &accum[&r.id];
        let expected = a.fusion_score * table.weight(r.chapter_distance);
        assert!(
            (expected - r.decayed_score).abs() < 1e-12,
            "engine vs table mismatch for {}: {expected} vs {}",
            r.id,
            r.decayed_score
        );
    }
}

// ── proptest：表 ≡ 闭式（连续参数域） ──

#[cfg(test)]
mod proptests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        /// 对任意 α ∈ [0,4]、β ∈ [0,4]、d ∈ [-50,300]（窗口内）：查表 ≡ 闭式
        /// （≤1e-12），且值域落在 [0,1]（衰减不放大）。窗口外钳制语义由
        /// 单调性属性 + clamp 单测覆盖（设计如此：越界取边界权重，非逐点闭式）。
        #[test]
        fn canon_spec_proptest_table_equivalence(
            alpha in 0.0f64..=4.0,
            beta in 0.0f64..=4.0,
            d in -50i32..=300
        ) {
            let table = WindowDecayTable::new(alpha, beta, 300);
            let wt = table.weight(d);
            let wc = decay(d, alpha, beta);
            prop_assert!((wt - wc).abs() <= 1e-12, "α={alpha} β={beta} d={d}");
            prop_assert!((0.0..=1.0).contains(&wt), "weight in [0,1]");
        }

        /// 单调非递增（含越界钳制段）：任意 α、β 下 weight(d+1) ≤ weight(d)。
        #[test]
        fn canon_spec_proptest_table_monotone(
            alpha in 0.0f64..=4.0,
            beta in 0.0f64..=4.0,
            d in -20i32..=350
        ) {
            let table = WindowDecayTable::new(alpha, beta, 300);
            prop_assert!(table.weight(d + 1) <= table.weight(d) + 1e-15,
                "monotone at α={alpha} β={beta} d={d}");
        }
    }
}
