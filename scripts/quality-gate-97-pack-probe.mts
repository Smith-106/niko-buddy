// #97 pack probe: buildContextPack 在 node 下是否可用（零 LLM，只装配）
// 运行：npx tsx --import ./scripts/node-fs-register.mjs scripts/quality-gate-97-pack-probe.mts
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

const projectPath = "C:/QM-BOOK/身体都是租的，你让我修仙？"
const state = JSON.parse(readFileSync("C:/Users/niko/AppData/Roaming/com.niko-buddy.app/app-state.json", "utf8")) as {
  llmConfig?: LlmConfig
  providerConfigs?: Record<string, LlmConfig>
  projectNovelConfigs?: Record<string, NovelConfig>
}
const xaiProvider = await decryptApiKeysInObject(state.providerConfigs?.xai ?? {})
if (!xaiProvider?.apiKey || xaiProvider.apiKey.startsWith("enc::")) throw new Error("xai key fail")
const llmConfig: LlmConfig = {
  provider: "custom",
  apiKey: xaiProvider.apiKey,
  model: xaiProvider.model || "composer-2.5",
  customEndpoint: xaiProvider.customEndpoint || (() => { throw new Error("providerConfigs.customEndpoint 未配置：原中转端点已于 2026-10-28 弃用，不再隐式回退") })(),
  apiMode: "responses",
  maxContextSize: xaiProvider.maxContextSize ?? 200000,
  reasoning: xaiProvider.reasoning ?? { mode: "auto" },
}
const novelConfig = {
  ...(state.projectNovelConfigs?.["508dafa6-8006-4f6a-9219-10a58fb5e14c"] ?? {}),
  reviewModel: llmConfig.model,
  communitySummaryEnabled: false,
}

// seed store so buildContextPack default reads see novelMode + configs
try {
  const { useWikiStore } = await import("../src/stores/wiki-store.ts")
  useWikiStore.setState({ novelMode: true, llmConfig, novelConfig } as any)
  console.log("STORE-SEED ok")
} catch (e) {
  console.log("STORE-SEED fail:", String(e).slice(0, 200))
}

const { buildContextPack } = await import("../src/lib/novel/context-engine.ts")
const pack = await buildContextPack(projectPath, "六维审查第1章", 1, {
  novelMode: true, llmConfig, novelConfig,
})
const sizes: Record<string, number> = {}
for (const [k, v] of Object.entries(pack)) {
  if (typeof v === "string") sizes[k] = v.length
  else if (Array.isArray(v)) sizes[k] = v.length
}
console.log(JSON.stringify({ sections: sizes, gaps: (pack as any).gaps?.length ?? 0 }, null, 1))
