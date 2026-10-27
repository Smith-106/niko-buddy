// L9 S2 AB 试改写执行（待 S1 完成 + 通道稳定后运行）：
//
// Arm A：ch2 带原章全文改写；Arm B：ch36 仅 task-brief 改写。
// 流程（Draft-first，绝不自动 accept）：
//   1. 读 S1 deepseek 中位 → resolveResidualCampaignFields（S1 值替换 dim 输入）
//   2. runDeepChapterGeneration 生成 draft（workspace draft 态，不落盘正文）
//   3. draft 文本直送六维 N=5 复测（复用 S1 测量函数，不经过 accept）
//   4. Keep 门：overall ≥ hold（原分）且 pacing 跌幅 < 0.3 → 管线有效
//   5. 产物：drafts + 复测分 + keep 判定；正文原样不动（改写只在 S2 结论放行后另行 accept）。
//
// 本文件现为骨架：S1 未完成前运行会直接报错退出，不消耗 LLM。
import { readFileSync, writeFileSync, existsSync } from "node:fs"

const S1 = "../.workflow/harvest-staging/quality-gate-97-l9-s1.json"
const OUT = "../.workflow/harvest-staging/quality-gate-97-l9-s2-run.json"

if (!existsSync(S1)) {
  console.error("S1 未完成：quality-gate-97-l9-s1.json 不存在，拒绝执行（不消耗 LLM）。")
  process.exit(2)
}
const s1 = JSON.parse(readFileSync(S1, "utf8"))
for (const ch of ["ch2", "ch36"]) {
  const o = (s1.results as any)?.[ch]?.overall
  if (typeof o !== "number") {
    console.error(`S1 缺 ${ch} overall 中位（null 或缺失），拒绝执行。请先补测。`)
    process.exit(2)
  }
}
console.log("S1 中位就绪：ch2 =", (s1.results as any).ch2.overall, "ch36 =", (s1.results as any).ch36.overall)
console.log("S2-run 骨架校验通过。生成 + N=5 复测待通道稳定后实现（runDeepChapterGeneration 接线）。")
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), stage: "skeleton-checked", s1overalls: { ch2: (s1.results as any).ch2.overall, ch36: (s1.results as any).ch36.overall } }, null, 2) + "\n")
