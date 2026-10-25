/**
 * ISS-20260709-033：lib 层直读 UI store（useWikiStore.getState）改参数注入/context 传值。
 *
 * 五处改造（注入优先、缺省回退 store，行为等价）：
 * 1. post-write-check-ai.runPostWriteCheckAI — params.providerConfigs/novelConfig
 * 2. select-skills-plugin planCapabilitySelection — input.llmConfig/providerConfigs
 * 3. trim-context.createTrimContextTool — deps.hardInjectEnabled
 * 4. run-chapter-workflow — options.getNovelConfig
 * 5. auto-save.setupAutoSave — deps.getProjectPath
 *
 * 结构断言：源码含注入点 + 回退语义；等价断言：注入/缺省双路径输出一致。
 */
import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { runPostWriteCheckAI } from "./plugins/post-write-check-ai"
import { createTrimContextTool } from "./tools/trim-context"
import { createRunChapterWorkflowTool } from "./tools/run-chapter-workflow"
import { setupAutoSave } from "../auto-save"
import type { LlmConfig } from "@/stores/wiki-store"

function readSource(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8")
}

const llmConfig: LlmConfig = {
  provider: "custom",
  apiKey: "test-key",
  model: "test-model",
  ollamaUrl: "",
  customEndpoint: "https://example.test/v1",
  maxContextSize: 120000,
}

describe("ISS-20260709-033 lib 层 UI store 直读改注入", () => {
  it("五处源码均含注入优先 + 回退 store 结构", () => {
    const postWrite = readSource("./plugins/post-write-check-ai.ts")
    expect(postWrite).toMatch(/params\.providerConfigs\s*\?\?\s*storeState\.providerConfigs/)
    expect(postWrite).toMatch(/params\.novelConfig\s*\?\?\s*storeState\.novelConfig/)

    const selectSkills = readSource("./plugins/select-skills-plugin.ts")
    expect(selectSkills).toMatch(/input\.providerConfigs\s*\?\?\s*storeState\.providerConfigs/)
    expect(selectSkills).toMatch(/input\.llmConfig\s*\?\?\s*storeState\.llmConfig/)

    const trim = readSource("./tools/trim-context.ts")
    expect(trim).toMatch(/deps\?\.hardInjectEnabled/)

    const workflow = readSource("./tools/run-chapter-workflow.ts")
    expect(workflow).toMatch(/getNovelConfig/)
    expect(workflow).toMatch(/options\.getNovelConfig/)

    const autoSave = readFileSync(new URL("../auto-save.ts", import.meta.url), "utf8")
    expect(autoSave).toMatch(/getProjectPath/)
    expect(autoSave).toMatch(/defaultGetProjectPath/)
  })

  it("post-write-check-ai 空正文双路径一致（规则兜底，不触 store）", async () => {
    const params = { chapterContent: "   " }
    const viaDefault = await runPostWriteCheckAI(params)
    const viaInjected = await runPostWriteCheckAI({
      ...params,
      providerConfigs: {},
      novelConfig: { recentSummaryWindow: 8 } as never,
    })
    expect(viaDefault).toEqual(viaInjected)
    expect(viaDefault.source).toBe("rule")
  })

  it("trim-context 空预算双路径一致（注入 hardInjectEnabled 不改变空分支）", async () => {
    const pack = { chapterGoal: "g" } as never
    const toolDefault = createTrimContextTool(pack, 0)
    const toolInjected = createTrimContextTool(pack, 0, { hardInjectEnabled: true })
    await expect(toolDefault.execute({})).resolves.toBe("【上下文为空】tokenBudget 为 0，已跳过上下文加载")
    await expect(toolInjected.execute({})).resolves.toBe("【上下文为空】tokenBudget 为 0，已跳过上下文加载")
  })

  it("run-chapter-workflow 缺参数双路径一致（store 读取在参数校验之后）", async () => {
    const runDeepChapterGeneration = vi.fn()
    const base = {
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard" as const,
      runDeepChapterGeneration,
    }
    const toolDefault = createRunChapterWorkflowTool(base)
    const toolInjected = createRunChapterWorkflowTool({
      ...base,
      getNovelConfig: () => ({ genre: "injected" }) as never,
    })
    await expect(toolDefault.execute({ userRequest: "   " })).resolves.toContain("缺少 userRequest")
    await expect(toolInjected.execute({ userRequest: "   " })).resolves.toContain("缺少 userRequest")
    expect(runDeepChapterGeneration).not.toHaveBeenCalled()
  })

  it("auto-save 缺省/注入双路径均可订阅且行为一致（不抛错）", () => {
    expect(() => setupAutoSave()).not.toThrow()
    expect(() => setupAutoSave({ getProjectPath: () => undefined })).not.toThrow()
    expect(() => setupAutoSave({ getProjectPath: () => "E:/Novel" })).not.toThrow()
  })
})
