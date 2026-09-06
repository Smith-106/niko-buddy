#!/usr/bin/env node
// rebuild-process-memory-migration.mjs — P2-IMP-03 一次性全量 rebuild migration
//
// 背景：rebuildFromCommittedSnapshot 此前只 fold emotional_arc/resource_ledger/
// subplot_board，缺 encounter_matrix/chapter_summaries/particle_ledger 三 fold。
// P2-IMP-03 已补齐三 fold（与 computeTruthFoldDrift 重放形态一致），但历史库的
// 三类 store 可能停留在旧（恒空/漂移）状态。本脚本触发一次全量 rebuild，把三类
// store 从 committed snapshot 序列确定性重建，消除历史漂移跳变。
//
// 运行方式（需项目 TS 运行时；npm dev 无 tsx，故走应用侧 rebuild 路径）：
//   1) 在 Niko Buddy 应用内对该小说目录执行一次「还原最新快照」——restoreSnapshotHistory
//      内部调用 rebuildDerivedMemoryFromSnapshots，现已 fold 全部 9 类投影。
//   2) 或在 vitest 上下文运行（resolve `@/` alias）：
//        import { rebuildDerivedMemoryFromSnapshots } from "@/lib/novel/mod"
//        await rebuildDerivedMemoryFromSnapshots("<小说目录>")
//
// 程序化调用（TS runner 可用时）：
//   rebuildDerivedMemoryFromSnapshots(projectPath)  // 全量重建 9 类过程库投影
//
// 验收：重建后跑 computeTruthFoldDrift，9 类全部 drifted=false（drift=0）。
//
// 注：本脚本不直接 import TS（@/ alias 需 vite-node/tsx）。它作为运维流程锚点与
// 校验清单；实际触发走应用 rebuild 路径或 vitest 上下文，避免重复实现 fold 逻辑。

console.log(`[P2-IMP-03 migration] 全量 rebuild 过程库投影（9 类）。
  途径 A：应用内「还原最新快照」（restoreSnapshotHistory → rebuildDerivedMemoryFromSnapshots）。
  途径 B：vitest/tsx 上下文调用 rebuildDerivedMemoryFromSnapshots("<小说目录>")。
  校验：computeTruthFoldDrift 返回 9 类全部 drifted=false。
详见 QMAI/src/lib/novel/chapter-ingest.ts :: rebuildFromCommittedSnapshot。`);
process.exit(0);
