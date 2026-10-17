import { createHash } from "node:crypto"
import { hostname, userInfo } from "node:os"
import { readFileSync, writeFileSync } from "node:fs"

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
const { runAutonomousDraftCampaign } = await import("../src/lib/novel/campaign-runner.ts")
import { decryptApiKeysInObject } from "../src/lib/crypto.ts"
import type { LlmConfig, NovelConfig } from "../src/stores/wiki-store.ts"

const projectPath = "C:/QM-BOOK/身体都是租的，你让我修仙？"
const statePath = "C:/Users/niko/AppData/Roaming/com.niko-buddy.app/app-state.json"
const startChapter = Number(process.argv[2] ?? 1)
const chapterCount = Number(process.argv[3] ?? 1)
const state = JSON.parse(readFileSync(statePath, "utf8")) as {
  llmConfig?: LlmConfig
  projectNovelConfigs?: Record<string, NovelConfig>
}
const fallbackProvider = await decryptApiKeysInObject(state.providerConfigs?.xai)
const llmConfig = fallbackProvider?.apiKey && !fallbackProvider.apiKey.startsWith("enc::")
  ? {
      ...fallbackProvider,
      provider: "custom" as const,
      apiMode: "responses" as const,
      model: fallbackProvider.model,
      customEndpoint: fallbackProvider.baseUrl,
    }
  : await decryptApiKeysInObject(state.llmConfig)
if (!llmConfig?.model || !llmConfig.apiKey || llmConfig.apiKey.startsWith("enc::")) {
  throw new Error("当前项目没有可用的已解密模型配置")
}
if (llmConfig.model === "deepseek-v4-flash:0731") llmConfig.model = "deepseek-v4.1-flash"
if (process.argv.includes("--check-key")) {
  console.log(JSON.stringify({ model: llmConfig.model, endpoint: llmConfig.customEndpoint, keyReady: true }))
  process.exit(0)
}
const writingModel = llmConfig.model
const novelConfig = {
  ...(state.projectNovelConfigs?.["508dafa6-8006-4f6a-9219-10a58fb5e14c"] ?? {}),
  extractModel: writingModel,
  reviewModel: writingModel,
  summaryModel: writingModel,
  writingModel,
  // 全图社区摘要会按社区逐个打模型，参考书图谱有数百个社区，会打满额度。批量正文不跑这项。
  communitySummaryEnabled: false,
}

const report = await runAutonomousDraftCampaign({
  projectPath,
  startChapter,
  chapterCount,
  llmConfig,
  novelConfig,
  cruiseMode: true,
  buildChapterRequest: (chapterNumber) => [
    `请撰写《身体都是租的，你让我修仙？》第 ${chapterNumber} 章正文。`,
    "核心设定：毕业生白曦的身体被企业租用，培养债务和维护费同时到期；他利用修仙体系与合同漏洞夺回身体自主权，并逐步揭开租赁产业链。",
    "要求：延续上一章事实，不重写旧章；本章 2800 到 3600 字；只输出可直接保存的小说正文。",
  ].join("\n"),
  onProgress: (info) => {
    console.log(`[${info.current}/${info.total}] ${info.stage}: ${info.message}`)
  },
})

const out = `C:/QM-BOOK/身体都是租的，你让我修仙？/.novel/campaign-${startChapter}.json`
writeFileSync(out, JSON.stringify({
  startChapter: report.startChapter,
  endChapter: report.endChapter,
  completedChapters: report.completedChapters,
  totalWords: report.totalWords,
  summary: report.summary,
  results: report.results.map((item) => ({
    title: item.title,
    wordCount: item.wordCount,
    status: item.status,
    autoAccepted: item.autoAccepted,
    error: item.error,
  })),
}, null, 2))
console.log(JSON.stringify({ out, completed: report.completedChapters, words: report.totalWords, summary: report.summary }))
