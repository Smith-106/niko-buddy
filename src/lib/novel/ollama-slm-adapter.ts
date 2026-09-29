// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * ollama-slm-adapter.ts — 本地 Ollama 端侧轻量小模型 (SLM) 网关与分级门控适配器
 *
 * 架构背景与决策：
 * 1. 为什么用本地 Ollama 介入，而非 Rust 后端内嵌 ONNX Runtime？
 *    - 包体零膨胀：ONNX Runtime C/C++ 动态链接库及硬件驱动（DirectML/CUDA）打包会使安装包暴增 300MB~1GB，
 *      而 Ollama 是由用户本地独立守护运行，Niko Buddy 保持轻量纯粹；
 *    - 极致硬件利用：Ollama 基于 llama.cpp，对 Apple Silicon Metal、Windows DirectML/NVIDIA CUDA、
 *      CPU AVX2 提供成熟的底层硬件自适应加速，稳定性远超自编译的嵌入式推理引擎；
 *    - 动态模型生命周期：用户可随意按需拉取 `qwen2.5:0.5b`、`llama3.2:1b`、`deepseek-r1:1.5b` 等，
 *      无需随软件发版重新分发权重。
 *
 * 2. 核心功能：
 *    - `detectOllamaSlmStatus`: 本地可用性探测与最优 SLM（0.5B~3B）自动发现；
 *    - `screenDraftWithSlm`: Tier-1 快速初筛（P0 认知穿帮与 P1 模板化）；
 *    - `verifyPovEpistemicIntegrityWithSlm`: 多主角视点认知隔离（防止全知视角泄露）的 SLM 语义审查；
 *    - 弹性容灾与零阻塞降级：若本地 Ollama 离线或超时，自动 Fallback 至内建规则引擎。
 */

export interface OllamaModelInfo {
  name: string
  model: string
  size: number
  parameterSize?: string
  family?: string
}

export interface OllamaSlmDiscoveryResult {
  available: boolean
  baseUrl: string
  latencyMs: number
  recommendedSlm?: string
  installedModels: string[]
  error?: string
}

export interface SlmScreeningResult {
  passed: boolean
  tier: "slm_fast_gate" | "rule_fallback"
  p0Violations: string[]
  p1Warnings: string[]
  confidence: number
  durationMs: number
}

export interface EpistemicCheckResult {
  passed: boolean
  leakedFacts: string[]
  reasoning?: string
  checkedBy: "slm" | "rule_fallback"
}

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434"

/** 轻量端侧小模型推荐优先级正则（参数越小，初筛越快） */
const SLM_PREFERENCE_REGEX = [
  /0\.5b/i,
  /1b/i,
  /1\.5b/i,
  /2b/i,
  /3b/i,
  /qwen2\.5/i,
  /llama3\.2/i,
  /deepseek-r1:1\.5b/i,
  /smollm/i,
  /minicpm/i,
]

/**
 * 探测本地 Ollama 服务是否可用，并自动挑选适合做门控初筛的轻量 SLM 模型
 */
export async function detectOllamaSlmStatus(
  baseUrl = DEFAULT_OLLAMA_BASE_URL,
  timeoutMs = 2000,
): Promise<OllamaSlmDiscoveryResult> {
  const cleanUrl = baseUrl.replace(/\/+$/, "")
  const start = Date.now()

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const resp = await fetch(`${cleanUrl}/api/tags`, {
      method: "GET",
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!resp.ok) {
      return {
        available: false,
        baseUrl: cleanUrl,
        latencyMs: Date.now() - start,
        installedModels: [],
        error: `Ollama returned HTTP ${resp.status}`,
      }
    }

    const data = (await resp.json()) as { models?: Array<{ name: string; model?: string }> }
    const installedModels = (data.models || []).map((m) => m.name)

    // 寻找最佳小模型
    let recommendedSlm: string | undefined
    for (const regex of SLM_PREFERENCE_REGEX) {
      const match = installedModels.find((name) => regex.test(name))
      if (match) {
        recommendedSlm = match
        break
      }
    }

    // 若无明确命中上述模式，则选列表中第一个作为备选，或者保持 undefined
    if (!recommendedSlm && installedModels.length > 0) {
      recommendedSlm = installedModels[0]
    }

    return {
      available: true,
      baseUrl: cleanUrl,
      latencyMs: Date.now() - start,
      recommendedSlm,
      installedModels,
    }
  } catch (err) {
    return {
      available: false,
      baseUrl: cleanUrl,
      latencyMs: Date.now() - start,
      installedModels: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export interface ScreenDraftOptions {
  draftText: string
  prohibitedTerms?: string[]
  epistemicConstraints?: string[]
  ollamaBaseUrl?: string
  slmModel?: string
  timeoutMs?: number
}

/**
 * 纯机械规则降级检查（零模型调用，极速保险底线）
 */
export function screenDraftWithRuleFallback(options: {
  draftText: string
  prohibitedTerms?: string[]
  epistemicConstraints?: string[]
}): SlmScreeningResult {
  const start = Date.now()
  const p0Violations: string[] = []
  const p1Warnings: string[] = []

  // 1. 禁用词/违例词硬匹配
  if (options.prohibitedTerms) {
    for (const term of options.prohibitedTerms) {
      if (term.trim() && options.draftText.includes(term.trim())) {
        p0Violations.push(`触发禁忌词违规：${term}`)
      }
    }
  }

  // 2. 认知硬边界匹配（提取【...】中的事实子串检测是否泄露）
  if (options.epistemicConstraints) {
    for (const constraint of options.epistemicConstraints) {
      // 提取最后一个【...】中的事实（避开前置【禁止描写】标签）
      const matches = Array.from(constraint.matchAll(/【(.*?)】/g))
      const secret = matches.length > 1
        ? matches[matches.length - 1][1]
        : (matches[0] ? matches[0][1] : constraint)
      if (secret.trim() && options.draftText.includes(secret.trim())) {
        p0Violations.push(`全知视角泄露违规（角色不知晓却出现）：${secret}`)
      }
    }
  }

  // 3. 基础 AI 套话模板初筛
  const aiStockPhrases = ["值得注意的是", "总而言之", "如同一道闪电", "不可否认的是", "心中涌起一股暖流"]
  for (const phrase of aiStockPhrases) {
    if (options.draftText.includes(phrase)) {
      p1Warnings.push(`疑似AI套话：${phrase}`)
    }
  }

  return {
    passed: p0Violations.length === 0,
    tier: "rule_fallback",
    p0Violations,
    p1Warnings,
    confidence: 0.9,
    durationMs: Date.now() - start,
  }
}

/**
 * 通过本地 Ollama SLM 小模型执行草稿 Tier-1 快速初筛
 * 若本地服务离线或超时，自动透明降级为 rule_fallback
 */
export async function screenDraftWithSlm(options: ScreenDraftOptions): Promise<SlmScreeningResult> {
  const baseUrl = (options.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "")
  const timeoutMs = options.timeoutMs ?? 3000

  // 准备 prompt 审查契约
  const prompt = [
    "你是一个严格的长篇小说一致性门控初筛员（Tier-1 Fast Filter）。请阅读以下草稿并检查：",
    "1. 是否包含了禁忌词或明显事实冲突；",
    options.epistemicConstraints && options.epistemicConstraints.length > 0
      ? `2. 视点认知硬边界（主角绝对不知晓的事实，严禁描写主角直接知道或说出）：\n${options.epistemicConstraints.join("\n")}`
      : "",
    "3. 是否含有严重AI模板套话。",
    "【待审查草稿】：",
    options.draftText.slice(0, 2000),
    "请仅输出严格 JSON 格式：{\"p0Violations\": [\"原因\"], \"p1Warnings\": [\"警告\"]}",
  ].filter(Boolean).join("\n\n")

  const start = Date.now()

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const resp = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.slmModel || "qwen2.5:0.5b",
        prompt,
        stream: false,
        format: "json",
        options: {
          temperature: 0.1,
          num_predict: 256,
        },
      }),
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!resp.ok) {
      return screenDraftWithRuleFallback(options)
    }

    const data = (await resp.json()) as { response?: string }
    const rawOutput = data.response?.trim() || "{}"

    const parsed = JSON.parse(rawOutput) as {
      p0Violations?: string[]
      p1Warnings?: string[]
    }

    const p0Violations = Array.isArray(parsed.p0Violations) ? parsed.p0Violations : []
    const p1Warnings = Array.isArray(parsed.p1Warnings) ? parsed.p1Warnings : []

    return {
      passed: p0Violations.length === 0,
      tier: "slm_fast_gate",
      p0Violations,
      p1Warnings,
      confidence: 0.95,
      durationMs: Date.now() - start,
    }
  } catch {
    // 无论是网络不通、模型未下载、还是超时，均平滑降级至规则引擎
    return screenDraftWithRuleFallback(options)
  }
}

/**
 * 专用于 Multi-POV 认知隔离的轻量审查
 */
export async function verifyPovEpistemicIntegrityWithSlm(options: {
  draftText: string
  characterName: string
  doesNotKnowFacts: string[]
  ollamaBaseUrl?: string
  slmModel?: string
}): Promise<EpistemicCheckResult> {
  if (options.doesNotKnowFacts.length === 0) {
    return {
      passed: true,
      leakedFacts: [],
      checkedBy: "slm",
    }
  }

  const epistemicConstraints = options.doesNotKnowFacts.map(
    (fact) => `【禁止描写】：${options.characterName}此时绝对不知晓【${fact}】`,
  )

  const res = await screenDraftWithSlm({
    draftText: options.draftText,
    epistemicConstraints,
    ollamaBaseUrl: options.ollamaBaseUrl,
    slmModel: options.slmModel,
  })

  return {
    passed: res.p0Violations.length === 0,
    leakedFacts: res.p0Violations,
    reasoning: res.p0Violations.join("; ") || undefined,
    checkedBy: res.tier === "slm_fast_gate" ? "slm" : "rule_fallback",
  }
}
