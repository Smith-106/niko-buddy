import { createHash } from "node:crypto"
import { hostname, userInfo } from "node:os"
import { readFileSync, writeFileSync } from "node:fs"
import { decryptApiKeysInObject } from "../src/lib/crypto.ts"
import type { LlmConfig } from "../src/stores/wiki-store.ts"

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

const { runAutonomousNovelIncubator } = await import("../src/lib/novel/autonomous-incubator.ts")
const projectPath = "C:/QM-BOOK/身体都是租的，你让我修仙？"
const state = JSON.parse(readFileSync("C:/Users/niko/AppData/Roaming/com.niko-buddy.app/app-state.json", "utf8")) as { llmConfig?: LlmConfig }
const llmConfig = await decryptApiKeysInObject(state.llmConfig)
if (!llmConfig?.apiKey) throw new Error("模型配置不可用")
if (llmConfig.model === "deepseek-v4-flash:0731") llmConfig.model = "deepseek-v4.1-flash"

const result = await runAutonomousNovelIncubator({
  projectPath,
  idea: "毕业生白曦的身体被企业租用，培养债务和维护费同时到期；他利用修仙体系与合同漏洞夺回身体自主权，并逐步揭开租赁产业链。",
  title: "身体都是租的，你让我修仙？",
  genre: "都市修仙 / 悬疑",
  targetChapters: 170,
  llmConfig,
  onProgress: (info) => console.log(`[${info.current}/${info.total}] ${info.stage}: ${info.message}`),
})
const out = `${projectPath}/.novel/incubation.json`
writeFileSync(out, JSON.stringify({
  title: result.title,
  genre: result.genre,
  characters: result.characters.map((item) => item.name),
  outlineChars: result.outlineContent.length,
  skeletons: result.unpackedSkeletons.createdCount ?? result.unpackedSkeletons.files?.length ?? null,
}, null, 2))
console.log(JSON.stringify({ out, outlineChars: result.outlineContent.length }))
