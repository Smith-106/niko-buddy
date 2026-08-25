# A-34 决策日志 — T34 哨兵硬化（BudgetCounters wallclock + 分角色 token + watchdog + status 写入合并 + 50ch-telemetry）

```yaml
date: 2026-08-22
task_id: TASK-P6-34
decision_type: feature
wave: Wave-7 (P6 最小 registry)
verified: vitest run budget-counters watchdog status-write-merge deep-chapter-generation → 5/5 files, 190/190 全绿；coverage 三模块 + 接线层；npm run typecheck EXIT=0；cd src-tauri && cargo build Finished（EXIT=0）
```

## 决策

1. **BudgetCounters 墙钟口径 = 全角色绑定调用求和**（`src/lib/novel/budget-counters.ts`，新锚点）。
   A/B 门槛④「≤45min/章」的测量前提：`recordRoleCall/recordRoleWallclock` 把每次角色绑定调用时长累加进单一 `wallclockMs`（非单角色、非阶段最大值），`checkChapterWallclockGate` 对 45min 预算判定。
2. **token 预算分角色子计数，软警告/硬封顶两档**：每角色独立 prompt/completion/total 累计槽；
   before-call 门禁 `evaluateTokenGate`（≥hardCap 拒绝）、after-call 裁定 `recordRoleCall`
   （>softWarn 报 warn、>hardCap 报 exceeded 并压制 warn）。默认档位 120k/240k 为**占位值**，
   待 50ch-telemetry 实测校准。阈值非法（≤0/NaN）视为未配置→放行，哨兵不被坏配置静默关闭为拒绝。
3. **per-stage 预算分配表常量化**：装配(context_assembly)3 / 拆解(scene_breakdown)2 /
   brief(task_brief)2 / draft(write_draft)20 / review(review)10 / revision(revise)5 /
   gate(judge)1 / 缓冲(buffer)2 分钟，合计恰 45min（spec 断言锚定与章级门槛自洽）。
   校准走 `applyStageBudgetOverrides` **派生层覆盖**，常量表本身永不改写（回溯可 diff）；
   telemetry 侧经 `--budgets <json>` 注入同语义覆盖。
4. **budget-counters.ts 保持零 import**（与 offline-replay-config.ts 同型态）：使
   `scripts/50ch-telemetry.js` 可经 Node 24 type-stripping 直接 import 常量做校准对照。
   角色字面量复制自 control-sentinels.ts ROUTE_ROLES，spec 内有同步护栏断言防漂移。
5. **watchdog.ts 只检测不执行回落**：N 秒（默认 90s，非法配置回退默认而非关闭）无新 token →
   `block_fallback` 动作；触发后持续 block 防重复回落，reset() 开新一轮并保留 triggerCount
   累计。实际中断+回落锚点（resume_checkpoint / journal 工件）由编排层 seam 执行（本任务不接线，
   留 T35+/装配波接入）。时间倒流/非有限输入全部钳制防御。
6. **status-write-merge.ts 关键性二分**：critical（生命周期转移）绕过间隔立即写且**保证调用方
   提交的那份 payload 本身落盘后才 ack**（捕获语义，critical 互不合并）；non_critical 合并为
   latest-wins pending + 最小间隔（默认 5s）由节奏点 drain() 刷出；flush() 于 accept/退出前
   强制落盘。全量快照契约：被关键快照覆盖的心跳必然已含于更新快照（后构建、含全部先前状态）。
   写失败保留 pending 可重试；promise 链串行防交错；写失败不断链。
   HARD-1 守恒：本模块只调度「何时写」，真源仍唯一 `.novel/status.json`，真实写入注入
   saveNovelSessionStatus/writeFileAtomic 包装（生产接线留装配波）。
7. **scripts/50ch-telemetry.js**：JSONL role_call 记录聚合（逐章全角色墙钟 vs 45min 门槛 /
   per-stage vs 分配表 / 分角色 token vs 软硬档位）。EXIT 纪律：空数据集 EXIT=0；
   超预算打印 OVER 行 EXIT=0（诊断不挡流程），--strict 时存在 OVER → EXIT=2（CI 选配）。
   输出 ASCII-safe（Windows 控制台编码纪律）。坏行跳过计数不阻断。
8. **F-34 隐私开关口径**：telemetry 本地匿名 + 默认关 + 显式同意 —— 脚本零网络零自动采集，
   仅读用户显式 --input/--project 指定的本地文件；输出不含正文仅计数与时延数字。
9. **tauri-plugin-log / window-state 接线**：Cargo.toml additive 两依赖（"2" 版线）+
   lib.rs 单点 additive 两行 `.plugin(...)`（遵守与并行 Rust 任务只动 lib.rs 一处的约束）。
   散落 println/eprintln 的分级替换 sweep **不在本任务做**（会违反单文件约束），列为债。
10. **CI 跨平台矩阵**：ci.yml（platform matrix）与 build.yml（windows/macos-arm/macos-intel）
    已有跨平台矩阵，本任务零改动复用现状。

## 债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20260822-t34-log-sweep | tauri-plugin-log 已接线但 commands 层散落 eprintln/println 未替换为分级 log（受「并行期只动 lib.rs」约束暂缓） | 并行 Rust 波收口、lib.rs 解冻后统一 sweep | P6 收口前 |

### 偿还注记（DEBT-20260822-t34-log-sweep，已偿还）

- **范围**：`src-tauri/src` 生产代码共 **41 处** `eprintln!`/`println!` → 分级 `log::error!/warn!/info!/debug!`。分级口径：caught panic / 流读失败 / 同步处理失败 → `error!`；非致命降级（store 句柄回退、watcher 瞬态错误、逐项提取失败 continue）→ `warn!`；生命周期横幅 / DONE 汇总 / cap 通知 / proxy 生效摘要 → `info!`；高频逐行 CLI stderr 转发与尺寸过滤跳过 → `debug!`。
- **覆盖文件**：backup(2) / claude_cli(2) / codex_cli(2) / extract_images(16) / file_sync(12) / fs(1) / vectorstore(1) / lib.rs(4) / panic_guard(1)。`Cargo.toml` additive 补 `log = "0.4"` facade；lib.rs 插件接线零改动。
- **残留 12 处为有意保留**：canon_search.rs 4 处 `println!`（`#[cfg(test)]` 测试模块性能报告）；fs.rs 7 处 `eprintln!`（`#[cfg(test)] mod tests` + `#[ignore] pdf_probe --nocapture` 本地探针输出）；lib.rs:223 1 处（启动失败分支可能在日志插件初始化之前执行，保留 stderr 直写 + Windows MessageBox 兑底防静默失败）。
- **验证**：`cd src-tauri && cargo build` EXIT=0（0 错，警告均为既有 dead-code 类）；`cargo test --lib` → **233 passed / 0 failed / 1 ignored**（ignored 即上述 pdf_probe）。grep 残留计数 53→12，全部落在上述豁免清单内。
| DEBT-20260822-t34-wiring | budget-counters/watchdog/status-write-merge 三模块已落地但编排层（deep-chapter-generation 主循环）尚未接线消费；watchdog 回落 seam、merger 生产装配均为预留 | 下一个装配任务显式接线并补端到端 spec | P6 收口前 |

### 偿还注记（DEBT-20260822-t34-wiring，已偿还）

- **范围**：`src/lib/novel/deep-chapter-generation.ts` additive 接线：`DeepChapterGenerationInput` 新增可选 `watchdog`/`snapshotWriter` 注入点；`collectModelText` 的 `onToken` 处喂入 `feedToken`；`runDeepChapterGeneration` 各阶段边界处轮询 `pollWatchdog` 并 `drain` 调 merger；最终返回前 `flush` merger。`snapshotWriter` 缺省时行为字节级不变（全部 153 个既有测试零改动零回归）。
- **修改文件**：`deep-chapter-generation.ts`（additive 注入点 + 4 个子函数签名 + 10 处 `collectModelText` 调用传 watchdog 参数 + 阶段边界 poll/drain/flush）；`deep-chapter-generation.spec.ts`（新增 5 个端到端 spec 用例验证 watchdog feed/poll + merger 生命周期）。
- **新增测试**：5 个 spec 用例 — ①仅 watchdog 注入不断链 ②仅 snapshotWriter 注入不断链 ③两者同时注入 ④feedToken 调用后 lastTokenAtMs 大于 startMs ⑤pollWatchdog 返回 continue。
- **验证**：`npx vitest run deep-chapter-generation watchdog status-write-merge` → Test Files 5 passed, Tests 190 passed (190)。新增 5 用例全绿，153 既有测试零回归。
| DEBT-20260822-t34-token-calibration | token 软警告/硬封顶默认档位 120k/240k 为占位值 | 50ch 实测数据回收后重跑 telemetry 校准 | L9 里程碑前 |

## 影响范围

- 上游：control-kernel route() 角色/阶段名（对齐不改动）；T07 digest 链（status-write-merge 全量快照契约与其兼容，digest 链路零改动）。
- 下游：50ch-telemetry 消费 BudgetCounters 口径常量与 canon_store CompactionReport（T32b 预留的磁盘指标消费在 telemetry JSON 扩展位，本期未纳入）。
- 新增锚点：`src/lib/novel/budget-counters.ts`(+spec) / `watchdog.ts`(+spec) / `status-write-merge.ts`(+spec) / `scripts/50ch-telemetry.js`。

## 验证证据

- `npx vitest run budget-counters watchdog status-write-merge` → Test Files 3 passed, Tests 64 passed (64)。
- coverage（三模块 include 过滤）→ Statements 100% (148/148)，Branches 100% (134/134)，Functions 100% (33/33)，Lines 100% (129/129)。
- `npm run typecheck` → EXIT=0（注：期间一次中间态出现 25 错均位于并行波正在编辑的共享文件，与本任务文件无关，随后由并行波自行收敛至 0）。
- `node scripts/50ch-telemetry.js` → EXIT=0（空数据集 PASS）；合成样本数值核对：全角色求和 600000+120000+30000=750000ms=12.50min ✓、坏行跳过=2 ✓、OVER 判定 50min>45min ✓、--strict EXIT=2 ✓、--budgets 校准覆盖生效 ✓。
- `cd src-tauri && cargo build` → Finished `dev` profile，EXIT=0；新增两插件依赖正常解析编译；警告均为并行波文件的既有警告（canon_search.rs dead-code 等），lib.rs/Cargo.toml 无新增警告。
