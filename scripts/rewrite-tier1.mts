// Tier1 改写战役：7 重灾章，带原文参照 + dim-aware 结构计划，Draft-first。
// 用法：SKIP 无；断点续跑：改写产物落 .novel/rewrite-tier1/chapter-NNN.md，通过 Keep 门才 accept 进 wiki/chapters。
// 模型：Muse Spark（与测量同口径），reasoning off。
import { createHash } from "node:crypto"
import { hostname, userInfo } from "node:os"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

const deviceFingerprint = createHash("sha256")
  .update(`qmai::${process.env.COMPUTERNAME || hostname()}::${process.env.USERNAME || userInfo().username}::windows::device-key-v1`)
  .digest("hex")
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => key === "niko_buddy_fallback_fingerprint" ? deviceFingerprint : null,
    setItem: () => {},
    removeItem: () => {},
  },
})

const PROJECT = "C:/QM-BOOK/身体都是租的，你让我修仙？"
const PROJECT_ID = "508dafa6-8006-4f6a-9219-10a58fb5e14c"
const OUT_DIR = `${PROJECT}/.novel/rewrite-tier1`
const BASELINE_PATH = "C:/Users/niko/Desktop/工作目录/niko-hub/.workflow/harvest-staging/quality-gate-97-l9-baseline.json"
const TIER1 = [2, 3, 36, 38, 67, 88, 136]

const state = JSON.parse(readFileSync("C:/Users/niko/AppData/Roaming/com.niko-buddy.app/app-state.json", "utf8")) as any
const { decryptApiKeysInObject } = await import("../src/lib/crypto.ts")
const ds = (await decryptApiKeysInObject(state.providerConfigs?.deepseek ?? {})) as any
if (!ds?.apiKey || ds.apiKey.startsWith("enc::")) throw new Error("deepseek key fail")
const llmConfig = {
  provider: "custom",
  apiKey: ds.apiKey,
  model: "muse-spark-1.3-contributor-free",
  customEndpoint: ds.baseUrl || "https://cpa.nikoniko.tech/v1",
  apiMode: ds.apiMode ?? "chat_completions",
  maxContextSize: ds.maxContextSize ?? 262144,
  reasoning: { mode: "off" },
} as any
const novelConfig = {
  ...(state.projectNovelConfigs?.[PROJECT_ID] ?? {}),
  writingModel: llmConfig.model,
  reviewModel: llmConfig.model,
  summaryModel: llmConfig.model,
  communitySummaryEnabled: false,
  residualCampaignEnabled: true,
} as any

const { useWikiStore } = await import("../src/stores/wiki-store.ts")
useWikiStore.setState({ novelMode: true, llmConfig, novelConfig } as any)
const { runAutonomousDraftCampaign } = await import("../src/lib/novel/campaign-runner.ts")
const { buildContextPack } = await import("../src/lib/novel/context-engine.ts")
const { resolveResidualCampaignFields } = await import("../src/lib/novel/residual-campaign.ts")

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { results: Record<string, any> }
mkdirSync(OUT_DIR, { recursive: true })

function stripFrontmatter(t: string): string {
  return t.replace(/^---\n.*?\n---\n/s, "")
}
function dimDiagnosis(ch: number): string {
  const r = baseline.results[`ch${ch}`]
  const dm = r?.dimensionMedians ?? {}
  const lines = [`第${ch}章当前 overall=${r?.overall}（<9.0 不通过），六维中位：`]
  for (const dim of ["thrill", "consistency", "pacing", "character", "continuity", "pull"]) {
    lines.push(`- ${dim}: ${dm[dim]}`)
  }
  return lines.join("\n")
}

const only = process.argv[2] ? [Number(process.argv[2])] : TIER1
for (const ch of only) {
  const draftPath = `${OUT_DIR}/chapter-${String(ch).padStart(3, "0")}.md`
  if (existsSync(draftPath)) {
    console.log(`[ch${ch}] draft exists, skip`)
    continue
  }
  const origRaw = readFileSync(`${PROJECT}/wiki/chapters/chapter-${String(ch).padStart(3, "0")}.md`, "utf8")
  const origText = stripFrontmatter(origRaw)
  const r = baseline.results[`ch${ch}`]
  // residual 字段：用实测 overall 做 hold median，dim-aware 计划自动选 emphasis
  const fields = resolveResidualCampaignFields({
    enabled: true,
    chapterNumber: ch,
    config: {
      ...novelConfig,
      residualCampaignOverallMedian: r?.overall ?? null,
      residualCampaignDimMedians: r?.dimensionMedians ?? null,
    },
  })
  if (!fields) throw new Error(`ch${ch}: residual fields null`)
  console.log(`[ch${ch}] mode=${fields.residualRewriteMode} band=${fields.residualBand} emphasis-dim=${JSON.stringify(novelConfig.residualCampaignDimMedians ?? r?.dimensionMedians)}`)

  const report = await runAutonomousDraftCampaign({
    projectPath: PROJECT,
    startChapter: ch,
    chapterCount: 1,
    llmConfig,
    novelConfig: {
      ...novelConfig,
      residualCampaignOverallMedian: fields.residualOverallMedian,
      residualCampaignMode: fields.residualRewriteMode,
      residualCampaignLengthPreserving: fields.residualLengthPreserving,
      residualCampaignDimMedians: r?.dimensionMedians ?? null,
    },
    cruiseMode: false, // 不自动 accept：草稿先落 .novel，Keep 门过了才人工 accept
    buildChapterRequest: (n) => [
      `请改写《身体都是租的，你让我修仙？》第 ${n} 章正文。`,
      `【原章全文参照】（保持人物/情节连续，只强化弱维，不要改坏已达标维度）：`,
      origText,
      ``,
      `【维度诊断】`,
      dimDiagnosis(n),
      ``,
      `要求：本章 2800 到 3600 字；只输出可直接保存的小说正文。`,
    ].join("\n"),
    onProgress: (info) => console.log(`[ch${ch} ${info.current}/${info.total}] ${info.stage}: ${info.message}`),
  })
  const item = report.results[0]
  if (!item || item.status !== "ready" || !item.content.trim()) {
    console.log(`[ch${ch}] NOT READY status=${item?.status} err=${item?.error ?? ""}`)
    continue
  }
  writeFileSync(draftPath, item.content)
  console.log(`[ch${ch}] draft saved words=${item.wordCount} revised=${item.revised}`)
}
console.log("TIER1-DRAFT-DONE")
