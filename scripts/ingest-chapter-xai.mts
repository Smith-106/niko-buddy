import { createHash } from "node:crypto"
import { hostname, userInfo } from "node:os"
import { readFileSync } from "node:fs"
import { decryptApiKeysInObject } from "../src/lib/crypto.ts"
import type { LlmConfig, NovelConfig } from "../src/stores/wiki-store.ts"

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
const { ingestChapter } = await import("../src/lib/novel/chapter-ingest.ts")

const projectPath = "C:/QM-BOOK/身体都是租的，你让我修仙？"
const chapterNumber = Number(process.argv[2] ?? 1)
const chapterPath = `${projectPath}/wiki/chapters/chapter-${String(chapterNumber).padStart(3, "0")}.md`

const state = JSON.parse(readFileSync("C:/Users/niko/AppData/Roaming/com.niko-buddy.app/app-state.json", "utf8")) as {
  llmConfig?: LlmConfig
  providerConfigs?: Record<string, LlmConfig>
  projectNovelConfigs?: Record<string, NovelConfig>
}

// 与 write-novel-campaign.mts 同款：优先解密 providerConfigs.xai（responses 模式）
const xaiProvider = await decryptApiKeysInObject(state.providerConfigs?.xai ?? {})
if (!xaiProvider?.apiKey || xaiProvider.apiKey.startsWith("enc::")) {
  throw new Error("xai provider key 未解密成功")
}
const llmConfig: LlmConfig = {
  provider: "custom",
  apiKey: xaiProvider.apiKey,
  model: xaiProvider.model || "composer-2.5",
  customEndpoint: xaiProvider.customEndpoint || (() => { throw new Error("providerConfigs.customEndpoint 未配置：原中转端点已于 2026-10-28 弃用，不再隐式回退") })(),
  apiMode: "responses",
  maxContextSize: xaiProvider.maxContextSize ?? 200000,
  reasoning: xaiProvider.reasoning ?? { mode: "auto" },
}

// extract/review/summary/writing 全走 xai/composer-2.5（与前端设置等效）
const novelConfig = {
  ...(state.projectNovelConfigs?.["508dafa6-8006-4f6a-9219-10a58fb5e14c"] ?? {}),
  extractModel: llmConfig.model,
  reviewModel: llmConfig.model,
  summaryModel: llmConfig.model,
  writingModel: llmConfig.model,
  communitySummaryEnabled: false,
}

console.log(`[ingest] chapter=${chapterNumber} model=${llmConfig.model} endpoint=${llmConfig.customEndpoint}`)
const result = await ingestChapter(projectPath, chapterPath, undefined, undefined, {
  novelMode: true,
  llmConfig,
  novelConfig,
})
console.log(JSON.stringify({
  chapter: result.snapshot?.chapterNumber ?? null,
  failReason: result.failReason ?? "",
  summary: (result.snapshot?.summary ?? "").slice(0, 120),
  characters: result.snapshot?.characters?.length ?? 0,
  canonFacts: result.snapshot?.newCanonFacts?.length ?? 0,
  warnings: result.snapshot?.validationWarnings?.length ?? 0,
}))
