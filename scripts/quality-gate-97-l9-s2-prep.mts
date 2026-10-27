// L9 S2 AB 试改写准备：零 LLM 调用，只构建两臂输入并落盘待审。
//
// Arm A（ch2 带全文改写）：task-brief + 原章全文参照。
// Arm B（ch36 仅 brief 重写）：task-brief + dim 诊断，不带原文。
// dim 输入暂用 muse 基线中位；S1 deepseek 中位出炉后替换重跑本脚本。
// 实际生成 + N=5 复测待通道恢复后执行（另起 S2-run 脚本）。
//
// 运行: npx tsx --import ./scripts/node-fs-register.mjs scripts/quality-gate-97-l9-s2-prep.mts
// 产物: ../.workflow/harvest-staging/quality-gate-97-l9-s2-briefs.json
import { readFileSync, writeFileSync } from "node:fs"

const PROJECT = "C:/QM-BOOK/身体都是租的，你让我修仙？"
const OUT = "../.workflow/harvest-staging/quality-gate-97-l9-s2-briefs.json"

const { resolveResidualCampaignFields } = await import("../src/lib/novel/residual-campaign.ts")

const baseline = JSON.parse(
  readFileSync("../.workflow/harvest-staging/quality-gate-97-l9-baseline.json", "utf8"),
) as {
  results: Record<string, { dimensions: Record<string, { median: number | null }> }>
}

function dimMedians(ch: number): Record<string, number> {
  const d = baseline.results[`ch${ch}`]?.dimensions ?? {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(d)) if (v?.median != null) out[k] = v.median
  return out
}
function stripFrontmatter(t: string): string {
  return t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
}

const arms: Record<string, unknown> = {}
for (const [ch, withFullText] of [[2, true], [36, false]] as Array<[number, boolean]>) {
  const medians = dimMedians(ch)
  const fields = resolveResidualCampaignFields({
    enabled: true,
    chapterNumber: ch,
    config: {
      residualCampaignOverallMedian: undefined,
      residualCampaignDimMedians: medians,
    } as any,
  })
  const briefLines = [
    `【L9 S2 试改写任务书】第 ${ch} 章`,
    `残余带 overall 中位基线（muse 口径，待 S1 deepseek 中位替换）：${JSON.stringify(medians)}`,
    `改写模式：structure_thril_pacing + lengthPreserving`,
    `结构计划 beats：${((fields?.chapterStructurePlan as any)?.beats ?? []).length} 拍 / 覆盖点：${JSON.stringify((fields?.chapterStructurePlan as any)?.thrilCheckpointCoverage ?? [])}`,
    withFullText
      ? "参照模式：带原章全文（吃原文改写，AB 对比 A 臂）"
      : "参照模式：仅 task-brief + dim 诊断重写，不带原文（AB 对比 B 臂）",
  ]
  let userRequest = briefLines.join("\n")
  let fullText: string | null = null
  if (withFullText) {
    fullText = stripFrontmatter(
      readFileSync(`${PROJECT}/QM/chapters/chapter-${String(ch).padStart(3, "0")}.md`, "utf8"),
    )
    userRequest += `\n\n【原章全文参照（改写锚点，不得照抄）】\n${fullText}`
  }
  arms[`ch${ch}`] = {
    chapter: ch,
    withFullText,
    dimMediansSource: "muse-baseline（S1 deepseek 中位出炉后替换）",
    dimMedians: medians,
    emphasis: null,
    beats: ((fields?.chapterStructurePlan as any)?.beats ?? []).map((b: any) => b.label ?? b.id),
    thrilCheckpointCoverage: (fields?.chapterStructurePlan as any)?.thrilCheckpointCoverage ?? [],
    residualBand: fields?.residualBand ?? null,
    userRequestChars: userRequest.length,
    fullTextChars: fullText?.length ?? 0,
    // 全文只存 hash 与长度，不存正文（brief 文件保持可审大小；正文执行时现读）。
    userRequestHead: userRequest.slice(0, 1200),
  }
}

const doc = {
  generatedAt: new Date().toISOString(),
  purpose: "L9 S2 AB 试改写输入准备（P4 待答问题 2 的执行载体）",
  note: "零 LLM 调用；实际生成待通道恢复 + S1 deepseek 中位替换 dim 输入后执行",
  arms,
}
writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n")
console.log(JSON.stringify({ arms: Object.keys(arms), out: OUT }, null, 1))
for (const [k, v] of Object.entries(arms)) {
  const a = v as any
  console.log(`${k}: brief=${a.userRequestChars}ch 全文=${a.fullTextChars}ch emphasis=${a.emphasis} band=${a.residualBand}`)
}
