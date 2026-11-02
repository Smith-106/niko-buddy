/**
 * G4：缓存命中率**真实实测**（实测层）。
 *
 * 与 `cache-hit-harness.ts` 的两层严格区分：
 *   - 真实层（theoretical）：字节级最长公共前缀复用率，证明「前缀稳定」；
 *   - 模拟层（simulated）：假设上游原样回报复用量的推演，**不是线上口径**；
 *   - **实测层（本文件）**：真发请求、真读 `usage` 的缓存字段。
 *
 * 为什么放在 `*.real-llm.spec.ts`：这是唯一会打真实端点、产生真实费用、且依赖
 * 外部网络与凭据的测试。`npm run test:mocks` 的 exclude 列表已覆盖该后缀，
 * 所以它不会进日常门禁；需要显式运行：
 *
 *   NIKO_MEASURE_CACHE=1 npx vitest run src/lib/cache-hit-measure.real-llm.spec.ts
 *
 * 纪律：
 *  - apiKey 只从 app-state.json 读入内存，**绝不打印、绝不落盘**；
 *  - 端点不暴露缓存计量字段时，用例**不产出任何命中率数字**，只记录「未测 + 原因」；
 *  - 输出里每个数字都能追到 `usage` 的某个键名。
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { buildChatStablePrefix } from "./stable-prefix"

interface LlmConfig {
  provider: string
  apiKey: string
  model: string
  customEndpoint?: string
}

/**
 * 取测量用凭据。优先环境变量，其次 app-state.json。
 *
 * 为什么需要环境变量覆盖：应用把 apiKey **加密存储**（`enc::` 前缀），只有
 * Tauri 运行时能解密。CLI 侧直接拿到的密文发出去只会得到 401，所以正式测量
 * 必须由用户显式提供明文 key：
 *
 *   NIKO_MEASURE_CACHE_KEY=sk-... \
 *   NIKO_MEASURE_CACHE_ENDPOINT=https://api.anthropic.com \
 *   NIKO_MEASURE_CACHE_MODEL=claude-... \
 *   NIKO_MEASURE_CACHE=1 npx vitest run src/lib/cache-hit-measure.real-llm.spec.ts
 */
function resolveCredentials(): { llm: LlmConfig | null; reason?: string } {
  const envKey = process.env.NIKO_MEASURE_CACHE_KEY
  if (envKey) {
    const endpoint = process.env.NIKO_MEASURE_CACHE_ENDPOINT ?? "https://api.anthropic.com"
    const model = process.env.NIKO_MEASURE_CACHE_MODEL ?? "claude-sonnet-4-20250514"
    return { llm: { provider: "env", apiKey: envKey, model, customEndpoint: endpoint } }
  }

  const fromFile = readLlmConfig()
  if (!fromFile) return { llm: null, reason: "找不到 llmConfig（apiKey/model 缺失）" }
  if (fromFile.apiKey.startsWith("enc::")) {
    return {
      llm: null,
      reason:
        "app-state.json 里的 apiKey 是加密存储（enc:: 前缀），只有 Tauri 运行时能解密；" +
        "请用 NIKO_MEASURE_CACHE_KEY / _ENDPOINT / _MODEL 显式提供明文凭据",
    }
  }
  return { llm: fromFile }
}

function readLlmConfig(): LlmConfig | null {
  const candidates = [
    process.env.NIKO_APP_STATE,
    join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "com.niko-buddy.app", "app-state.json"),
  ].filter((p): p is string => Boolean(p))
  for (const file of candidates) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
      const llm = (raw.llmConfig ?? (raw.state as Record<string, unknown> | undefined)?.llmConfig) as LlmConfig | undefined
      if (llm?.apiKey && llm?.model) return llm
    } catch {
      // 试下一个候选
    }
  }
  return null
}

/** 从 usage 取「缓存命中 token 数」与「输入 token 总数」，键名一并返回作为证据。 */
export function readCacheUsage(usage: Record<string, unknown> | null): {
  cachedTokens: number
  inputTotalTokens?: number
  key: string
} | null {
  if (!usage || typeof usage !== "object") return null
  const cachedKeys = [
    "cache_read_input_tokens",
    "prompt_tokens_details.cached_tokens",
    "prompt_cache_hit_tokens",
    "cached_tokens",
  ]
  for (const key of cachedKeys) {
    const value = key
      .split(".")
      .reduce<unknown>((acc, part) => (acc == null ? acc : (acc as Record<string, unknown>)[part]), usage)
    if (typeof value === "number" && Number.isFinite(value)) {
      // 分母口径因 provider 而异，不能一律用 prompt_tokens：
      //  - OpenAI 风格：prompt_tokens **已含**缓存部分，直接用它；
      //  - Anthropic 风格：input_tokens **不含**缓存部分，命中率分母必须是
      //    input_tokens + cache_creation_input_tokens + cache_read_input_tokens。
      // 拿 input_tokens 当分母会算出 9500% 这种荒谬值。
      const readTokens = usage.cache_read_input_tokens
      const creationTokens = usage.cache_creation_input_tokens
      const isAnthropicShape =
        typeof readTokens === "number" || typeof creationTokens === "number"
      let inputTotalTokens: number | undefined
      if (isAnthropicShape) {
        const parts = [usage.input_tokens, readTokens, creationTokens]
        inputTotalTokens = parts.every((p) => typeof p === "number" || p === undefined)
          ? parts.reduce<number>((sum, p) => sum + (typeof p === "number" ? p : 0), 0)
          : undefined
      } else if (typeof usage.prompt_tokens === "number") {
        inputTotalTokens = usage.prompt_tokens
      }
      return { cachedTokens: value, inputTotalTokens, key }
    }
  }
  return null
}

/** 命中率；分母缺失或算出的值超出 [0,1] 时返回 null（宁可不给数字，也不给错的）。 */
export function cacheHitRate(m: { cachedTokens: number; inputTotalTokens?: number }): number | null {
  if (typeof m.inputTotalTokens !== "number" || m.inputTotalTokens <= 0) return null
  const rate = m.cachedTokens / m.inputTotalTokens
  return rate >= 0 && rate <= 1 ? rate : null
}

async function sendOnce(llm: LlmConfig, messages: { role: string; content: string }[]) {
  const base = (llm.customEndpoint ?? "").replace(/\/+$/, "")
  const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify({ model: llm.model, messages, max_tokens: 16, stream: false }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`)
  const json = JSON.parse(text) as { usage?: Record<string, unknown> }
  return { usage: json.usage ?? null }
}

const enabled = process.env.NIKO_MEASURE_CACHE === "1"

describe.skipIf(!enabled)("G4 实测层：真实请求读 usage 缓存字段", () => {
  it("冷/热两次同前缀请求，从 usage 读真实缓存命中率", async (ctx) => {
    const { llm, reason } = resolveCredentials()
    if (!llm) {
      // 凭据不可用：**跳过**而不是通过。用 expect 断言「已知为 null」的恒真断言
      // 会让报告显示 PASSED，看起来像测过了——这正是 G4 要避免的自证。
      ctx.skip(`[G4] 未测：${reason}`)
      return
    }

    // 用应用真实函数生成稳定前缀：测量对象必须就是线上前缀。
    const prefix = buildChatStablePrefix({
      novelMode: true,
      skillPrompt: "## QM-QUAI 技能\n小说写作主链",
      canonRulesBase: "## 硬性世界规则\n- 灵气不可凭空生成\n- 凡人不可飞行",
    })
    const messages = [
      { role: "system", content: prefix.text },
      { role: "user", content: "用一句话说明你在做什么。" },
    ]

    const first = await sendOnce(llm, messages)
    const cold = readCacheUsage(first.usage)
    if (!cold) {
      // 端点不计量：同样跳过，不产出任何命中率数字。
      ctx.skip(
        `[G4] 端点未暴露缓存计量字段，实测层为空。usage keys: ${JSON.stringify(Object.keys(first.usage ?? {}))}`,
      )
      return
    }

    const second = await sendOnce(llm, messages)
    const warm = readCacheUsage(second.usage)
    expect(warm, "第二次响应应同样带缓存字段").toBeTruthy()
    if (!warm) return

    const report = {
      measuredFrom: { endpoint: llm.customEndpoint, model: llm.model, at: new Date().toISOString() },
      prefixChars: prefix.text.length,
      prefixVersion: prefix.version,
      cold: { ...cold, hitRate: cacheHitRate(cold), usage: first.usage },
      warm: { ...warm, hitRate: cacheHitRate(warm), usage: second.usage },
    }
    console.log("[G4] 实测结果:", JSON.stringify(report, null, 2))
    // 只有真读到字段才走到这里；命中率必须是可解释的 [0,1] 值。
    expect(report.warm.cachedTokens).toBeGreaterThanOrEqual(0)
    expect(report.warm.hitRate === null || (report.warm.hitRate >= 0 && report.warm.hitRate <= 1)).toBe(true)
  }, 120_000)
})
