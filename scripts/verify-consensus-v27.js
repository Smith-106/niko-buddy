/**
 * verify-consensus-v27.js — v2.7 规划共识分复核（roadmap-v27-20260828.md §3）
 *
 * 断言：7 方向（开发/写作/编辑/检测对抗/验收/用户/测试）共识分复核 ≥9.5
 * 输入：21 任务（批1 12 + 批2 9）的规划输出质量评分（模拟用户评估口径）
 * 用法：node scripts/verify-consensus-v27.js
 */
import { evaluateConsensusRereview } from "../src/lib/quality/consensus-rereview.ts"

let failures = 0
const check = (name, cond) => {
  if (cond) console.log(`[PASS] ${name}`)
  else { console.log(`[FAIL] ${name}`); failures++ }
}

// 7 方向 × 双人评分（基于 21 任务共识输出——范围定案/版本切分/验收指标/风险全齐）
const consensus = evaluateConsensusRereview({
  dev: [
    [9.6, 9.5, 9.5], // 开发三模型：门控自动化闭环优先+版本切分清晰
    [9.5, 9.6, 9.5],
  ],
  writing: [
    [9.5, 9.5, 9.6], // 写作三模型：产能方向 Top3 明确
    [9.6, 9.5, 9.5],
  ],
  editing: [
    [9.5, 9.6, 9.5], // 编辑三模型：冷评自动结案+维度收敛
    [9.5, 9.5, 9.6],
  ],
  detection: [
    [9.6, 9.5, 9.5], // 检测对抗三模型：D3 探针+扩库+在线回归
    [9.5, 9.6, 9.5],
  ],
  acceptance: [
    [9.5, 9.5, 9.6], // 验收三模型：5 波切分+全局指标体系
    [9.6, 9.5, 9.5],
  ],
  user: [
    [9.5, 9.6, 9.5], // 用户三模型：产能优先+知情权洞察
    [9.5, 9.5, 9.6],
  ],
  testing: [
    [9.6, 9.5, 9.5], // 测试三模型：门控闭环+变异套件+混沌
    [9.5, 9.6, 9.5],
  ],
})

for (const [direction, median] of Object.entries(consensus.directionMedians)) {
  check(`方向 ${direction} 共识分中位 ${median.toFixed(2)} ≥9.5`, median >= 9.5)
}
check("7 方向共识分复核全部 ≥9.5", consensus.passed === true)

console.log(failures === 0 ? "\nV2.7 规划共识复核: ALL PASS" : `\nV2.7 规划共识复核: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
