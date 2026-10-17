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
  value: { getItem: (key: string) => key === "niko_buddy_fallback_fingerprint" ? deviceFingerprint : null, setItem: () => {}, removeItem: () => {} },
})
const { ingestChapter } = await import("../src/lib/novel/chapter-ingest.ts")
const projectPath = "C:/QM-BOOK/身体都是租的，你让我修仙？"
const state = JSON.parse(readFileSync("C:/Users/niko/AppData/Roaming/com.niko-buddy.app/app-state.json", "utf8")) as { llmConfig?: LlmConfig; projectNovelConfigs?: Record<string, NovelConfig> }
const llmConfig = await decryptApiKeysInObject(state.llmConfig)
if (llmConfig?.model === "deepseek-v4-flash:0731") llmConfig.model = "deepseek-v4.1-flash"
const novelConfig = {
  ...(state.projectNovelConfigs?.["508dafa6-8006-4f6a-9219-10a58fb5e14c"] ?? {}),
  extractModel: "deepseek-v4.1-flash",
  reviewModel: "deepseek-v4.1-flash",
  summaryModel: "deepseek-v4.1-flash",
  writingModel: "deepseek-v4.1-flash",
}
const result = await ingestChapter(projectPath, `${projectPath}/wiki/chapters/chapter-001.md`, undefined, undefined, {
  novelMode: true,
  llmConfig,
  novelConfig,
})
console.log(JSON.stringify({ chapter: result.snapshot?.chapterNumber ?? null, failReason: result.failReason ?? "" }))
