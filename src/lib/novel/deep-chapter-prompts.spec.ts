import { describe, expect, it } from "vitest"
import {
  DEEP_CHAPTER_DRAFT_MAX_CHARS,
  DEEP_CHAPTER_MAX_OUTPUT_TOKENS,
  DEEP_CHAPTER_MIN_CHARS,
  DEEP_CHAPTER_TARGET_CHARS,
  buildDeepChapterBriefPrompt,
  buildDeepChapterDraftPrompt,
  buildDeepChapterExpansionPrompt,
  buildDeepChapterFinalPolishPrompt,
  buildDeepChapterLengthRewritePrompt,
  buildDeepChapterRevisionPrompt,
  resolveChapterLengthSpec,
} from "./deep-chapter-prompts"
import type { NovelReviewResult } from "./review-adapter"
import { createDefaultStore, createPreference } from "@/lib/user-memory/types"

describe("resolveChapterLengthSpec", () => {
  it("keeps the built-in defaults when no target is configured", () => {
    const spec = resolveChapterLengthSpec()

    expect(spec.targetChars).toBe(DEEP_CHAPTER_TARGET_CHARS)
    expect(spec.minChars).toBe(DEEP_CHAPTER_MIN_CHARS)
    expect(spec.draftMaxChars).toBe(DEEP_CHAPTER_DRAFT_MAX_CHARS)
    expect(spec.maxOutputTokens).toBe(DEEP_CHAPTER_MAX_OUTPUT_TOKENS)
  })

  it("derives all thresholds from a configured chapter target (issue #8)", () => {
    const spec = resolveChapterLengthSpec(2000)

    expect(spec.targetChars).toBe(2000)
    expect(spec.minChars).toBeLessThan(2000)
    expect(spec.minChars).toBeGreaterThan(1000)
    expect(spec.draftMaxChars).toBe(2500)
  })

  it("scales output token budget up for long chapters", () => {
    const spec = resolveChapterLengthSpec(6000)

    expect(spec.maxOutputTokens).toBeGreaterThan(DEEP_CHAPTER_MAX_OUTPUT_TOKENS)
  })

  it("clamps unreasonable targets", () => {
    expect(resolveChapterLengthSpec(10).targetChars).toBe(500)
    expect(resolveChapterLengthSpec(999999).targetChars).toBe(20000)
  })
})

describe("chapter prompts honor the configured length spec", () => {
  it("injects the configured target into brief and draft prompts", () => {
    const spec = resolveChapterLengthSpec(2000)
    const brief = buildDeepChapterBriefPrompt("", "context", "continue writing next chapter", 5, undefined, spec)
    const draft = buildDeepChapterDraftPrompt("", "context", "task brief", "continue writing next chapter", 5, undefined, spec)

    expect(brief).toContain("[TASK_BRIEF_MARKER]")
    expect(draft).toContain("[DRAFT_STAGE_MARKER]")
    expect(brief).toContain("2000")
    expect(draft).toContain("2000")
    expect(draft).toContain(String(spec.draftMaxChars))
    expect(draft).not.toContain(String(DEEP_CHAPTER_TARGET_CHARS))
  })
})

describe("prompt builders fallback branches (w3nb 补齐)", () => {
  it("length-rewrite prompt honors autoGenerateTitle true/false and chapter number", () => {
    const withTitle = buildDeepChapterLengthRewritePrompt("ctx", "brief", "正文", "user", 7, undefined, {
      autoGenerateTitle: true,
    })
    expect(withTitle).toContain("2. 正文第一行必须是章节标题")

    const noTitle = buildDeepChapterLengthRewritePrompt("ctx", "brief", "正文", "user", 7, undefined, {
      autoGenerateTitle: false,
    })
    expect(noTitle).toContain("2. 不要输出章节标题。")

    // 缺省 options → autoGenerateTitle 默认 true
    const defaulted = buildDeepChapterLengthRewritePrompt("ctx", "brief", "正文", "user", 7)
    expect(defaulted).toContain("2. 正文第一行必须是章节标题")

    const withChapter = buildDeepChapterLengthRewritePrompt("ctx", "brief", "正文", "user", 7)
    expect(withChapter).toContain("目标章节：第7章")
    expect(withChapter).toContain("TARGET_CHAPTER_NUMBER: 7")

    const noChapter = buildDeepChapterLengthRewritePrompt("ctx", "brief", "正文", "user")
    expect(noChapter).toContain("目标章节：用户请求中的章节")
    expect(noChapter).not.toContain("TARGET_CHAPTER_NUMBER")
  })

  it("final polish prompt picks custom de-AI skill when provided, falls back otherwise", () => {
    const custom = buildDeepChapterFinalPolishPrompt("o", "ctx", "brief", "正文", "user", 3, undefined, "  自定义去AI味规则  ")
    expect(custom).toContain("自定义去AI味规则")
    expect(custom).not.toContain("中文小说去 AI 味补充规则")

    const fallback = buildDeepChapterFinalPolishPrompt("o", "ctx", "brief", "正文", "user", 3, undefined, "")
    expect(fallback).toContain("中文小说去 AI 味补充规则")
  })

  it("final polish prompt uses user-aware de-AI rules when store has weights", () => {
    const store = createDefaultStore()
    store.preferences.push(
      createPreference({ key: "deai_boost:词汇", value: "2.0", category: "vocabulary" }),
    )
    const prompt = buildDeepChapterFinalPolishPrompt("o", "ctx", "brief", "正文", "user", 3, undefined, undefined, store)
    expect(prompt).toContain("用户个性化")
    expect(prompt).not.toContain("中文小说去 AI 味补充规则")
  })

  it("final polish prompt includes user avoid words section", () => {
    const store = createDefaultStore()
    store.preferences.push(
      createPreference({ key: "avoid_words", value: "仿佛、不禁", category: "vocabulary" }),
    )
    const prompt = buildDeepChapterFinalPolishPrompt("o", "ctx", "brief", "正文", "user", 3, undefined, undefined, store)
    expect(prompt).toContain("用户避用词")
    expect(prompt).toContain("仿佛、不禁")
  })

  it("final polish prompt falls back to built-in rules when store has no weights", () => {
    const store = createDefaultStore()
    const prompt = buildDeepChapterFinalPolishPrompt("o", "ctx", "brief", "正文", "user", 3, undefined, undefined, store)
    expect(prompt).toContain("中文小说去 AI 味补充规则")
    expect(prompt).not.toContain("用户个性化")
  })

  it("final polish prompt prefers custom skill over user store", () => {
    const store = createDefaultStore()
    store.preferences.push(
      createPreference({ key: "deai_boost:词汇", value: "2.0", category: "vocabulary" }),
    )
    const prompt = buildDeepChapterFinalPolishPrompt("o", "ctx", "brief", "正文", "user", 3, undefined, "自定义规则", store)
    expect(prompt).toContain("自定义规则")
    expect(prompt).not.toContain("用户个性化")
  })

  it("revision prompt renders review issues incl. evidence/relatedMemory/suggestion", () => {
    const issues: NovelReviewResult[] = [
      {
        severity: "error",
        type: "continuity",
        message: "开头节奏慢",
        evidence: "第3段",
        relatedMemory: "上章钩子",
        suggestion: "压缩环境描写",
      },
      {
        severity: "warning",
        type: "style",
        message: "轻微解释腔",
        evidence: "",
        relatedMemory: "",
        suggestion: "",
      },
    ]
    const prompt = buildDeepChapterRevisionPrompt("o", "ctx", "brief", "草稿", issues, "user", 3)
    expect(prompt).toContain("1. [error] 开头节奏慢")
    expect(prompt).toContain("证据：第3段")
    expect(prompt).toContain("相关记忆：上章钩子")
    expect(prompt).toContain("建议：压缩环境描写")
    expect(prompt).toContain("2. [warning] 轻微解释腔")
  })

  it("revision prompt with empty review issues reports 未发现问题", () => {
    const prompt = buildDeepChapterRevisionPrompt("o", "ctx", "brief", "草稿", [], "user", 3)
    expect(prompt).toContain("未发现问题。")
  })

  it("all stage builders fall back to the generic target line when chapterNumber is missing", () => {
    const prompts = [
      buildDeepChapterBriefPrompt("o", "ctx", "user"),
      buildDeepChapterDraftPrompt("o", "ctx", "brief", "user"),
      buildDeepChapterRevisionPrompt("o", "ctx", "brief", "草稿", [], "user"),
      buildDeepChapterExpansionPrompt("o", "ctx", "brief", "正文", "user"),
      buildDeepChapterFinalPolishPrompt("o", "ctx", "brief", "正文", "user"),
    ]
    for (const p of prompts) {
      expect(p).toContain("目标章节：用户请求中的章节")
      expect(p).not.toContain("TARGET_CHAPTER_NUMBER")
    }
  })
})
