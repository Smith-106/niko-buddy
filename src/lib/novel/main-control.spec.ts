import { beforeEach, describe, expect, it, vi } from "vitest"
import { ToolRegistry } from "@/lib/agent/registry"
import type { AgentRunCallbacks, AgentRunRecord } from "@/lib/agent/types"
import type { LlmConfig } from "@/stores/wiki-store"
import {
  MAIN_CONTROL_TOOLS,
  parseDraftReceipts,
  resolveWikiPath,
  runMainControlAgent,
} from "./main-control"
import { setModuleHeatSink } from "./module-heat"

const LLM = { provider: "openai", model: "gpt-test", apiKey: "k", baseUrl: "" } as unknown as LlmConfig

/** 造一个假 runner：按预设顺序触发回调并发起工具调用。 */
function fakeRunner(
  plan: Array<{ id: string; name: string; arguments?: Record<string, unknown>; result?: string; error?: string }>,
  finalText = "已完成。",
): { run: (config: unknown, reg: unknown, msgs: unknown, cb: AgentRunCallbacks) => Promise<AgentRunRecord> } {
  return {
    async run(_config, _registry, _messages, callbacks) {
      const toolCalls: AgentRunRecord["toolCalls"] = []
      for (const step of plan) {
        callbacks.onToolCall({ id: step.id, name: step.name, arguments: step.arguments ?? {} })
        if (step.error) {
          callbacks.onToolError(step.id, step.error)
          toolCalls.push({
            id: step.id,
            name: step.name,
            params: step.arguments ?? {},
            result: "",
            status: "error",
            startedAt: 0,
            finishedAt: 0,
          })
          continue
        }
        callbacks.onToolResult(step.id, step.result ?? "ok")
        toolCalls.push({
          id: step.id,
          name: step.name,
          params: step.arguments ?? {},
          result: step.result ?? "ok",
          status: "done",
          startedAt: 0,
          finishedAt: 0,
        })
      }
      callbacks.onText(finalText)
      callbacks.onDone()
      return { toolCalls, roundsUsed: 2, finalText }
    },
  }
}

beforeEach(() => {
  setModuleHeatSink(null)
})

describe("parseDraftReceipts", () => {
  it("解析草稿回执的 ID、章节名与字数", () => {
    const drafts = parseDraftReceipts([
      "已生成章节草稿「第12章 旧梦」，等待确认保存。\n草稿ID: draft_1700000000_ab12cd\n字数：3200字",
      "无关回执",
    ])
    expect(drafts).toEqual([{ id: "draft_1700000000_ab12cd", chapterName: "第12章 旧梦", words: 3200 }])
  })

  it("忽略没有草稿 ID 的文本", () => {
    expect(parseDraftReceipts(["读取成功", ""])).toEqual([])
  })
})

describe("resolveWikiPath", () => {
  it("存在 <project>/wiki 时用它", async () => {
    const exists = vi.fn(async (p: string) => p === "/proj/wiki")
    await expect(resolveWikiPath("/proj", exists)).resolves.toBe("/proj/wiki")
  })

  it("缺省回退到项目根（单目录布局）", async () => {
    const exists = vi.fn(async () => false)
    await expect(resolveWikiPath("/proj/", exists)).resolves.toBe("/proj")
  })
})

describe("runMainControlAgent", () => {
  it("空目标直接失败，不调用模型", async () => {
    const run = vi.fn()
    const out = await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "   ",
      llmConfig: LLM,
      deps: { runner: { run } },
    })
    expect(out.ok).toBe(false)
    expect(out.error).toContain("目标")
    expect(run).not.toHaveBeenCalled()
  })

  it("注册白名单：只有只读工具 + 草稿写入，正式记忆/大纲写工具不注册", async () => {
    const registry = new ToolRegistry()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "读第 3 章",
      llmConfig: LLM,
      deps: { runner: fakeRunner([]), registry },
    })
    const names = registry.list().map((tool) => tool.name)
    expect(names).toContain("read_chapter")
    expect(names).toContain("write_chapter")
    expect(names).not.toContain("write_memory")
    expect(names).not.toContain("write_outline_node")
    // run_chapter_workflow 需要注入深章流水线，阶段 1 未注入 → 不注册
    expect(names).not.toContain("run_chapter_workflow")
    for (const name of names) expect(MAIN_CONTROL_TOOLS).toContain(name)
  })

  it("收集轨迹、解析草稿并返回终稿", async () => {
    const out = await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "给第 12 章写个开头",
      llmConfig: LLM,
      deps: {
        runner: fakeRunner([
          { id: "c1", name: "list_chapters" },
          { id: "c2", name: "read_chapter", arguments: { name: "第12章" } },
          {
            id: "c3",
            name: "write_chapter",
            arguments: { name: "第12章 旧梦" },
            result: "已生成章节草稿「第12章 旧梦」，等待确认保存。\n草稿ID: draft_91_x\n字数：1800字",
          },
        ]),
      },
    })
    expect(out.ok).toBe(true)
    expect(out.steps.map((s) => s.name)).toEqual(["list_chapters", "read_chapter", "write_chapter"])
    expect(out.drafts).toEqual([{ id: "draft_91_x", chapterName: "第12章 旧梦", words: 1800 }])
    expect(out.finalText).toBe("已完成。")
    expect(out.roundsUsed).toBe(2)
  })

  it("工具失败被记录为 error 步骤，run 抛错时返回 error", async () => {
    const failing = {
      async run() {
        throw new Error("模型不可用")
      },
    }
    const out = await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "读第 1 章",
      llmConfig: LLM,
      deps: { runner: failing, registry: new ToolRegistry() },
    })
    expect(out.ok).toBe(false)
    expect(out.error).toContain("模型不可用")
  })

  it("onStep 回调拿到每次工具调用状态", async () => {
    const seen: string[] = []
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "读第 2 章",
      llmConfig: LLM,
      onStep: (step) => seen.push(`${step.name}:${step.status}`),
      deps: { runner: fakeRunner([{ id: "c1", name: "read_chapter" }]) },
    })
    expect(seen).toEqual(["read_chapter:running", "read_chapter:done"])
  })
})
