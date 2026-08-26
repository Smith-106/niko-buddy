# A-34 决策日志 — T32 canon_search 召回池重调参 + 邻接物化 + 性能基准

```yaml
date: 2026-08-22
task_id: TASK-P5-32
decision_type: 手设参数
wave: Wave-7 (P5 检索重调参)
model: ox-alpha
verified: cargo test canon → 104 passed / 0 failed（基线 87，+17）；cargo build → 0 error；全量 cargo test → 233 passed / 0 failed / 1 ignored
```

## 决策

在 `src-tauri/src/commands/canon_search.rs` additive 实现（T32b 已收口的
`canon_store.rs` 与 `canon_commands.rs` 零触碰）：

1. **窗口衰减 α/β 重调参（形式不换，非照搬 graphiti）**
   - 衰减函数维持蓝图 §9 因子 ⑤ 冻结形式 `decay(d)=1/(1+α·d)^β`；只扫参数，
     不引入指数/半衰期等新形式（ADR-20：提取「调参在自有召回池上做」的
     模式，不照搬其函数族）。
   - A-06 兑现路径：`rrf_rank_const` 保持 1 不入扫参；仅扫窗口衰减。
   - 扫描机制：`RecallCase` + `ndcg_at_k`（分级增益 2^g−1）+
     `sweep_decay_params`（网格 × 全池平均 NDCG@k，平分时 α↑β↑ 确定性裁决）。
   - 调参底座：确定性 QMAI 形态代理池（36 查询 × 60 召回项，长篇编码：
     at_chapter ∈ [100,240]，相关集 = 4 近章事实 gain=2 + 2 远期伏笔回调
     gain=1，FTS 近偏置/向量语义含头部噪声）。真实 LanceDB 召回池接入前
     的代理底座，见下方债条目。
   - **扫描结果（2026-08-22 实测）**：赢家 (α=0.08, β=0.75)，mean NDCG@10
     = **0.9410** vs 调参前 (0.1, 1.0) 的 **0.9358**（top-5 候选密集区
     0.9391–0.9410，均为温和衰减形态）。`SearchConfig::default()` 更新为
     赢家值；绑定测试 `t32_default_config_matches_swept_winner` 强制池/网格
     演化后显式重定默认值而非静默漂移。

2. **图遍历邻接物化**：`CanonGraph::from_edges` 构建时一次预计算排序去重
   邻接表（`adjacency()` 只读快照，孤立节点保证有键），BFS 每跳 O(1) 取
   邻居，不再经 petgraph 边迭代器重复走边；输出语义与原实现一致（既有
   BFS/连通分量/拓扑序测试全绿佐证）。

3. **窗口衰减表纯函数**：`WindowDecayTable::new(alpha, beta, max_distance)`
   预计算权重、O(1) 查询；窗口内与闭式逐点一致（≤1e-12，网格 + proptest
   双覆盖），窗口外钳制边界值（单调尾部近似）。规格验证落
   `canon_search.spec.rs`（经 `#[path]` 注册为 cfg(test) 子模块，不新增
   mod.rs 注册行——改动面收敛在本任务允许的两个文件内）。

4. **性能基准（延迟基线入测试断言）**：
   - `perf_engine_search_latency_baseline`：fuse→decay→sort→topK 全链路，
     200+200 合成召回、top_k=50。实测 ≈350–450 µs/op（debug 构建），预算
     2,000 µs（≈5× 余量，仅拦截量级劣化）。
   - `perf_bfs_adjacency_materialized_baseline`：2,000 节点主链+500 旁路边，
     depth=3 全起点遍历。实测 2,000 次 ≈ 9 ms，预算 500 ms。

## 验证证据

- `cargo test canon`：104 passed / 0 failed（调参前基线 87，新增 17：
  扫描×2、NDCG×1、邻接×1、默认值绑定×1、spec 表验证×8、proptest×2、
  perf×2）。
- `cargo build`：0 error（lib 全量警告均为存量 dead-code 类，未新增）。
- 全量 `cargo test`：233 passed / 0 failed / 1 ignored（无回归）。
- 改动面：`git status` 仅 `src/commands/canon_search.rs`（M） +
  `src/commands/canon_search.spec.rs`（新增）。

## 影响范围

- 上游：T15 影子双写 / T30b 回填产出的 canon 边集（读侧遍历加速，存储零改动）。
- 下游：T25 ContextPack 三源并行的 canon 通道可复用 `WindowDecayTable`
  与物化邻接表；canon_commands.rs IPC 契约不变。

## 债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20260822-t32-proxy-pool | α/β 定稿基于确定性 QMAI 形态代理池（fixture 内嵌于 t32_retune_tests），非真实 LanceDB 召回数据；真实召回分布可能偏移最优参数 | FTS tantivy 索引接入 + 生产项目语料 ≥ N 章可导出召回对时，重跑 sweep 并更新 default + 本条目 | P6 检索收口 / T33 解析点接线前 |
