// Copyright (c) 2024 Niko-hub contributors. MIT License.
import { describe, expect, it } from "vitest"
import {
  CONTINUE_UNFINISHED_FIELD_ORDER,
  CONTINUE_UNFINISHED_ROLE_DIRECTIVE,
  STABLE_PREFIX_FIELD_ORDER,
  STABLE_PREFIX_FORMAT_HINT,
  STABLE_PREFIX_TEXT_BASELINE,
  STABLE_PREFIX_VERSION,
  STABLE_PREFIX_VERSIONED_TEXTS,
  STABLE_SKILL_SECTION_HEADER,
  buildChatStablePrefix,
  buildContinueUnfinishedStablePrefix,
  buildStableAnswerRules,
  buildStableChapterOutputRules,
  buildStablePrefix,
  buildStablePrefixTraceFields,
  buildStableRoleDirective,
  canonicalizeStablePrefix,
  composeStableSystemBlocks,
  hashStablePrefix,
} from "./stable-prefix"
import { sha256Text } from "@/lib/context-hub/fingerprint"
import {
  buildLlmRequestCacheTrace,
  isLlmRequestCacheTrace,
} from "@/lib/llm-request-trace"
import { getProviderConfig, resolvePromptCacheStrategy, promptCacheTraceLabel } from "@/lib/llm-providers"
import type { ChatMessage } from "@/lib/llm-providers"
import type { LlmConfig } from "@/stores/wiki-store"

function config(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "anthropic",
    apiKey: "sk-test",
    model: "claude-sonnet-4-5",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    maxContextSize: 200000,
    reasoning: { mode: "auto" },
    ...overrides,
  }
}

describe("stable-prefix 版本与白名单", () => {
  it("版本号是正整数（bump 是人工动作，不能被算成小数）", () => {
    expect(Number.isInteger(STABLE_PREFIX_VERSION)).toBe(true)
    expect(STABLE_PREFIX_VERSION).toBeGreaterThanOrEqual(1)
  })

  it("渲染顺序只由白名单决定，不受入参对象键序影响", () => {
    const ordered = buildStablePrefix({
      skillPrompt: "S",
      roleDirective: "R",
      chapterOutputRules: "C",
      answerRules: "A",
      formatHint: "F",
    })
    const shuffled = buildStablePrefix({
      formatHint: "F",
      answerRules: "A",
      chapterOutputRules: "C",
      roleDirective: "R",
      skillPrompt: "S",
    })
    expect(ordered.parts).toEqual(["S", "R", "C", "A", "F"])
    expect(shuffled.text).toBe(ordered.text)
    expect(ordered.order).toEqual(STABLE_PREFIX_FIELD_ORDER)
  })

  it("空字段不参与渲染，拼接与旧的 parts.join(\"\\n\") 等价", () => {
    const prefix = buildStablePrefix({ roleDirective: "R", formatHint: "F" })
    expect(prefix.parts).toEqual(["R", "F"])
    expect(prefix.text).toBe("R\nF")
  })

  it("白名单外的键被丢弃（dynamic 段永不进缓存）", () => {
    const polluted = buildStablePrefix({
      roleDirective: "R",
      // 下面这些是真实装配点里会出现的动态内容，绝不允许进稳定段
      pagesContext: "资料页面正文",
      novelContextPreamble: "上下文包",
      langReminder: "请使用中文",
    } as never)
    expect(polluted.text).toBe("R")
    expect(Object.keys(polluted.fields).sort()).toEqual([...STABLE_PREFIX_FIELD_ORDER].sort())
  })

  it("chat / continue 两个组装点各有锁定顺序（continue 保持角色在技能之前）", () => {
    const chat = buildChatStablePrefix({ novelMode: true, skillPrompt: "SKILL" })
    expect(chat.parts[0]).toBe(`${STABLE_SKILL_SECTION_HEADER}\nSKILL`)
    expect(chat.parts[1]).toBe(buildStableRoleDirective(true))

    const resume = buildContinueUnfinishedStablePrefix({ skillPrompt: "SKILL" })
    expect(resume.order).toEqual(CONTINUE_UNFINISHED_FIELD_ORDER)
    expect(resume.parts[0]).toBe(CONTINUE_UNFINISHED_ROLE_DIRECTIVE)
    expect(resume.parts[1]).toBe(`${STABLE_SKILL_SECTION_HEADER}\nSKILL`)
  })

  it("没有技能时技能段整体消失（不留空标题行）", () => {
    const resume = buildContinueUnfinishedStablePrefix({ skillPrompt: "   " })
    expect(resume.text).toBe(CONTINUE_UNFINISHED_ROLE_DIRECTIVE)
    expect(resume.text).not.toContain(STABLE_SKILL_SECTION_HEADER)
  })
})

describe("hashStablePrefix", () => {
  it("输出 64 位 hex，可直接当 trace 的 prefixFingerprint", async () => {
    const hash = await hashStablePrefix(buildChatStablePrefix({ novelMode: false, skillPrompt: "S" }))
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it("同字段同版本 → 同哈希（跨调用稳定）", async () => {
    const a = await hashStablePrefix({ roleDirective: "R", formatHint: "F" })
    const b = await hashStablePrefix({ formatHint: "F", roleDirective: "R" })
    expect(a).toBe(b)
  })

  it("任一 stable 字段变更 → 哈希变更（字段白名单逐个验证）", async () => {
    const base = buildStablePrefix({
      skillPrompt: "S",
      roleDirective: "R",
      chapterOutputRules: "C",
      answerRules: "A",
      formatHint: "F",
    })
    const baseHash = await hashStablePrefix(base)
    for (const name of STABLE_PREFIX_FIELD_ORDER) {
      const mutated = buildStablePrefix({ ...base.fields, [name]: `${base.fields[name]}!` })
      expect(await hashStablePrefix(mutated), `${name} 变更后哈希未变`).not.toBe(baseHash)
    }
  })

  it("版本变更 → 哈希变更（版本折进哈希，trace 既有字段就带上了版本）", async () => {
    const base = buildChatStablePrefix({ novelMode: true, skillPrompt: "S" })
    const bumped = { ...base, version: base.version + 1 }
    expect(await hashStablePrefix(bumped)).not.toBe(await hashStablePrefix(base))
    expect(canonicalizeStablePrefix(bumped)).toContain(`"version":${base.version + 1}`)
  })

  it("渲染顺序不同 → 哈希不同（顺序也是缓存身份的一部分）", async () => {
    const fields = { roleDirective: "R", skillPrompt: "S" }
    const chat = await hashStablePrefix(buildStablePrefix(fields))
    const resume = await hashStablePrefix(buildStablePrefix(fields, CONTINUE_UNFINISHED_FIELD_ORDER))
    expect(chat).not.toBe(resume)
  })
})

/**
 * 缓解 R4：上游缓存的前缀一旦过期，命中率看上去正常、喂给模型的却是旧规则。
 * 所以「字段文本」和「版本号」必须同步 —— 文本抖动而版本没 bump，本用例直接红。
 */
describe("字段抖动即版本变", () => {
  it("字段抖动即版本变：任一 stable 字段文本改动都必须 bump STABLE_PREFIX_VERSION", async () => {
    const baseline = STABLE_PREFIX_TEXT_BASELINE[STABLE_PREFIX_VERSION]
    expect(
      baseline,
      `STABLE_PREFIX_VERSION=${STABLE_PREFIX_VERSION} 没有登记基线：bump 版本后必须补一条 STABLE_PREFIX_TEXT_BASELINE`,
    ).toBeDefined()

    // 双向对齐：基线键 ↔ 文本解析器键。新增一个会被缓存的字段却不登记，
    // 等于让它的抖动绕过版本约束。
    expect(Object.keys(baseline!).sort()).toEqual(Object.keys(STABLE_PREFIX_VERSIONED_TEXTS).sort())

    for (const [key, digest] of Object.entries(baseline!)) {
      const resolve = STABLE_PREFIX_VERSIONED_TEXTS[key]
      expect(resolve, `基线键 ${key} 没有对应文本解析器`).toBeDefined()
      expect(
        await sha256Text(resolve()),
        `stable 字段 ${key} 的文本变了但 STABLE_PREFIX_VERSION 没 bump`,
      ).toBe(digest)
    }
  })

  it("基线覆盖了所有静态 stable 字段（防止新字段漏登记）", () => {
    const baselineKeys = Object.keys(STABLE_PREFIX_TEXT_BASELINE[STABLE_PREFIX_VERSION] ?? {})
    // 技能段文本来自 buildQmQuaiSystemPrompt（运行期注入），不在静态基线里；
    // 其余四个字段两种模式都必须被登记。
    expect(baselineKeys).toContain("formatHint")
    expect(baselineKeys).toContain("roleDirective:novel")
    expect(baselineKeys).toContain("roleDirective:wiki")
    expect(baselineKeys).toContain("chapterOutputRules:novel")
    expect(baselineKeys).toContain("answerRules:novel")
    expect(baselineKeys).toContain("answerRules:wiki")
    expect(baselineKeys).toContain("continueUnfinished:roleDirective")
    expect(baselineKeys.length).toBe(7)
  })
})

describe("composeStableSystemBlocks：稳定段缓存、动态段不缓存", () => {
  it("稳定块带 cacheControl，动态块不带", () => {
    const blocks = composeStableSystemBlocks(
      buildChatStablePrefix({ novelMode: true, skillPrompt: "SKILL" }),
      ["## 资料库目标\n目标", "## 强制输出语言：中文"],
    )
    expect(blocks).toHaveLength(2)
    expect(blocks[0].cacheControl).toBe(true)
    expect(blocks[1].cacheControl).toBeUndefined()
    expect(blocks[1].text).toContain("资料库目标")
  })

  it("两块拼起来与拆分前 join(\"\\n\") 逐字节等价（提示词语义不变）", () => {
    const prefix = buildChatStablePrefix({ novelMode: false, skillPrompt: "" })
    const dynamicParts = ["## 资料库目标\n目标", "", "## 资料页面\n\n正文", "", "## ⚠️ 强制输出语言：中文"]
    const blocks = composeStableSystemBlocks(prefix, dynamicParts)
    const legacy = [prefix.text, ...dynamicParts].filter(Boolean).join("\n")
    expect(blocks.map((block) => block.text).join("")).toBe(legacy)
  })

  it("continue-unfinished 组装点同样等价（角色定位 + 技能 + 动态任务指令）", () => {
    const prefix = buildContinueUnfinishedStablePrefix({ skillPrompt: "SKILL" })
    const dynamicParts = ["任务指令", "黄金三章指令", "", "## 原始深度章节上下文包", "上下文包正文", "拆解指令"]
    const blocks = composeStableSystemBlocks(prefix, dynamicParts)
    const legacy = [
      CONTINUE_UNFINISHED_ROLE_DIRECTIVE,
      "",
      STABLE_SKILL_SECTION_HEADER,
      "SKILL",
      "",
      ...dynamicParts,
    ].filter(Boolean).join("\n")
    expect(blocks.map((block) => block.text).join("")).toBe(legacy)
    expect(blocks[0].cacheControl).toBe(true)
    expect(blocks.slice(1).every((block) => block.cacheControl === undefined)).toBe(true)
  })

  it("动态段为空时稳定段不带尾随换行", () => {
    const blocks = composeStableSystemBlocks(buildStablePrefix({ roleDirective: "R" }), [])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe("R")
  })
})

describe("版本与哈希写入 llm-request-trace 既有字段", () => {
  it("只产出既有字段名（不新增 trace 结构）", async () => {
    const fields = await buildStablePrefixTraceFields(buildChatStablePrefix({ novelMode: true, skillPrompt: "S" }))
    expect(Object.keys(fields).sort()).toEqual(["prefixEstimatedTokens", "prefixFingerprint"])
    expect(fields.prefixEstimatedTokens).toBeGreaterThan(0)
  })

  it("字段值能通过 trace 校验并原样落到 prefixFingerprint", async () => {
    const prefix = buildChatStablePrefix({ novelMode: true, skillPrompt: "S" })
    const fields = await buildStablePrefixTraceFields(prefix)
    const trace = buildLlmRequestCacheTrace({
      config: config(),
      ...fields,
      startedAt: 1_000,
      finishedAt: 1_200,
      status: "success",
    })
    expect(isLlmRequestCacheTrace(trace)).toBe(true)
    expect(trace.prefixFingerprint).toBe(fields.prefixFingerprint)
    expect(trace.prefixFingerprint).toBe(await hashStablePrefix(prefix))
  })
})

describe("跨 provider 缓存策略", () => {
  const systemMessages: ChatMessage[] = [
    {
      role: "system",
      content: composeStableSystemBlocks(
        buildChatStablePrefix({ novelMode: true, skillPrompt: "SKILL" }),
        ["## 资料页面\n\n正文"],
      ),
    },
    { role: "user", content: "继续写" },
  ]
  const expectedText = [
    buildChatStablePrefix({ novelMode: true, skillPrompt: "SKILL" }).text,
    "## 资料页面\n\n正文",
  ].join("\n")

  it("Anthropic：稳定段落成 cache_control ephemeral 块，动态段无标记", () => {
    const body = getProviderConfig(config({ provider: "anthropic" })).buildBody(systemMessages) as {
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>
    }
    expect(Array.isArray(body.system)).toBe(true)
    expect(body.system).toHaveLength(2)
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" })
    expect(body.system[1].cache_control).toBeUndefined()
    expect(body.system.map((block) => block.text).join("")).toBe(expectedText)
  })

  it("Anthropic：没有 cacheControl 断点时 system 仍是纯字符串（旧线格式不变）", () => {
    const body = getProviderConfig(config({ provider: "anthropic" })).buildBody([
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
    ]) as { system: unknown }
    expect(body.system).toBe("SYS")
  })

  it("OpenAI：隐式前缀，压平成字符串且不带 cache_control", () => {
    const body = getProviderConfig(config({ provider: "openai", model: "gpt-4o" })).buildBody(systemMessages) as {
      messages: Array<{ role: string; content: unknown }>
    }
    expect(body.messages[0].content).toBe(expectedText)
    expect(JSON.stringify(body)).not.toContain("cache_control")
  })

  it("Google：隐式前缀，systemInstruction 压平成同一份字节序", () => {
    const body = getProviderConfig(config({ provider: "google", model: "gemini-2.5-pro" })).buildBody(systemMessages) as {
      systemInstruction: { parts: Array<{ text: string }> }
    }
    expect(body.systemInstruction.parts.map((part) => part.text).join("")).toBe(expectedText)
    expect(JSON.stringify(body)).not.toContain("cache_control")
  })

  it("策略标签覆盖各 provider（含 custom 的 anthropic_messages 分支）", () => {
    expect(resolvePromptCacheStrategy(config({ provider: "anthropic" }))).toBe("explicit")
    expect(resolvePromptCacheStrategy(config({ provider: "minimax" }))).toBe("explicit")
    expect(resolvePromptCacheStrategy(config({ provider: "custom", apiMode: "anthropic_messages" }))).toBe("explicit")
    expect(resolvePromptCacheStrategy(config({ provider: "custom", apiMode: "chat_completions" }))).toBe("implicit")
    expect(resolvePromptCacheStrategy(config({ provider: "openai" }))).toBe("implicit")
    expect(resolvePromptCacheStrategy(config({ provider: "google" }))).toBe("implicit")
    expect(resolvePromptCacheStrategy(config({ provider: "azure" }))).toBe("implicit")
    expect(resolvePromptCacheStrategy(config({ provider: "ollama" }))).toBe("none")
    expect(promptCacheTraceLabel(config({ provider: "anthropic" }))).toBe("anthropic:explicit")
    expect(promptCacheTraceLabel(config({ provider: "openai" }))).toBe("openai:implicit")
    expect(promptCacheTraceLabel(config({ provider: "custom", apiMode: "anthropic_messages" }))).toBe("custom:explicit")
  })
})

describe("稳定字段文本契约", () => {
  it("资料库模式没有章节输出规则，但要求编号引用", () => {
    expect(buildStableChapterOutputRules(false)).toBe("")
    expect(buildStableAnswerRules(false)).toContain("[[页面名]]")
    expect(buildStableAnswerRules(false)).toContain("<!-- cited: 1, 3, 5 -->")
  })

  it("小说模式禁引用标记，且章节标题行规则在位", () => {
    expect(buildStableChapterOutputRules(true)).toContain("# 第X章 标题名")
    expect(buildStableAnswerRules(true)).not.toContain("[[页面名]]")
    expect(buildStableRoleDirective(true)).toContain("小说写作助手")
    expect(buildStableRoleDirective(false)).toContain("资料库问答助手")
    expect(STABLE_PREFIX_FORMAT_HINT).toContain("Markdown")
  })
})

/**
 * NIT-1 回归：让「加字段必须 bump 版本」变成红绿灯。
 *
 * 之前 STABLE_PREFIX_VERSION 只是记账——往 FIELD_ORDER 里加字段而不 bump，
 * 既有基线用例依然全绿。这条用例把版本与字段序快照绑定起来。
 */
describe("STABLE_PREFIX_VERSION 与字段序快照绑定", () => {
  const VERSION_FIELD_ORDER: Record<number, readonly string[]> = {
    1: ["skillPrompt", "roleDirective", "chapterOutputRules", "answerRules", "formatHint"],
    2: ["skillPrompt", "roleDirective", "canonRulesBase", "chapterOutputRules", "answerRules", "formatHint"],
  }

  it("当前版本的字段序必须与快照一致（加字段就要 bump + 补快照）", () => {
    expect(STABLE_PREFIX_FIELD_ORDER).toEqual(VERSION_FIELD_ORDER[STABLE_PREFIX_VERSION])
  })

  it("每个登记版本都必须有对应的字段序快照", () => {
    // STABLE_PREFIX_TEXT_BASELINE 的键是版本号（1、2…），不是文本键。
    for (const version of Object.keys(STABLE_PREFIX_TEXT_BASELINE).map(Number)) {
      expect(VERSION_FIELD_ORDER[version], `版本 ${version} 缺少字段序快照`).toBeDefined()
    }
  })
})
