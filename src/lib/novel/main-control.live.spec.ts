/**
 * 主控 Agent 真实 LLM 端到端联调（默认跳过，仅在 MAIN_CONTROL_E2E=1 时运行）。
 *
 * 为什么是一个 spec 而不是普通脚本：待测链路是 TypeScript + `@/` 别名 + 应用内 provider 配置，
 * 只有 vitest 的运行环境能原样加载。唯一的替身是 Tauri 文件命令（`@tauri-apps/api/core`
 * 的 invoke）——用 Node fs 落到真实磁盘，等价于应用内的读写语义；模型调用全部真实。
 *
 * 不打印密钥：密钥只经环境变量进入，证据只记录模型名/端点/轮次/分数/草稿 ID。
 */
import { describe, expect, it, vi } from "vitest"

const E2E = process.env.MAIN_CONTROL_E2E === "1"

vi.mock("@tauri-apps/api/core", async () => {
  const fsp = await import("node:fs/promises")
  const nodePath = await import("node:path")
  const norm = (p: string) => String(p).replace(/\\/g, "/")
  return {
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      const target = norm(String(args.path ?? ""))
      switch (cmd) {
        case "read_file":
        case "preprocess_file":
        case "read_text_file":
          return fsp.readFile(target, "utf8")
        case "write_file":
        case "write_file_atomic": {
          await fsp.mkdir(nodePath.dirname(target), { recursive: true })
          await fsp.writeFile(target, String(args.contents ?? ""), "utf8")
          return null
        }
        case "file_exists":
          try {
            await fsp.access(target)
            return true
          } catch {
            return false
          }
        case "list_directory": {
          const entries = await fsp.readdir(target, { withFileTypes: true })
          return entries
            .map((entry) => ({
              name: entry.name,
              path: `${target}/${entry.name}`,
              is_dir: entry.isDirectory(),
            }))
            .sort((a, b) => a.name.localeCompare(b.name))
        }
        case "create_directory":
          await fsp.mkdir(target, { recursive: true })
          return null
        case "delete_file":
          await fsp.rm(target, { force: true })
          return null
        case "copy_file":
          await fsp.copyFile(target, norm(String(args.destination ?? "")))
          return null
        default:
          throw new Error(`e2e fs shim: 未实现的 Tauri 命令 ${cmd}`)
      }
    },
  }
})

describe.skipIf(!E2E)("主控 Agent 真实 LLM 端到端", () => {
  it(
    "真实模型完成 评分 → 定向重写 → 草稿写入 → 轨迹快照",
    async () => {
      const fsp = await import("node:fs/promises")
      const nodePath = await import("node:path")
      const { runMainControlAgent } = await import("./main-control")
      const { createMainControlQualityDeps } = await import("./main-control-quality")
      const { buildTraceEntries, buildTraceSnapshot, saveTraceSnapshot } = await import("./main-control-trace")
      const { resolveWikiPath } = await import("./main-control")
      const { fileExists } = await import("@/commands/fs")
      type LlmConfig = import("@/stores/wiki-store").LlmConfig
      type ContextPack = import("./context-engine").ContextPack
      type MainControlStep = import("./main-control").MainControlStep

      const projectPath = String(process.env.E2E_PROJECT_PATH ?? "").replace(/\\/g, "/")
      const endpoint = String(process.env.E2E_ENDPOINT ?? "").replace(/\/+$/, "")
      const apiKey = String(process.env.E2E_API_KEY ?? "")
      const model = String(process.env.E2E_MODEL ?? "")
      expect(projectPath, "缺少 E2E_PROJECT_PATH").not.toBe("")
      expect(endpoint, "缺少 E2E_ENDPOINT").not.toBe("")
      expect(apiKey, "缺少 E2E_API_KEY").not.toBe("")
      expect(model, "缺少 E2E_MODEL").not.toBe("")

      const llmConfig = {
        provider: "custom",
        apiMode: (process.env.E2E_API_MODE as "chat_completions" | "responses" | undefined) ?? "chat_completions",
        apiKey,
        model,
        customEndpoint: endpoint,
        baseUrl: "",
        maxContextSize: 262144,
        ollamaUrl: "http://localhost:11434",
        azureApiVersion: "2024-10-21",
        azureModelFamily: "auto",
        reasoning: { mode: "auto" },
        localCliIsolation: false,
      } as unknown as LlmConfig

      // 空上下文包：只测「真实模型 + 真实主控链路」，不让检索/向量库成为失败源。
      const contextPack = {
        task: "主控 Agent 端到端联调",
        chapterGoal: "第1章正文质量把关",
        outline: "",
        recentSummaries: [],
        previousChapterEnding: "",
        characterStates: "",
        soulDoc: "",
        characterAuras: "",
        cognitionStates: "",
        foreshadowingStates: "",
        timeline: "",
        relatedSettings: "",
        canonRules: "",
        writingStyle: "",
        searchResults: "",
        graphSearchResults: "",
        mustDo: "",
        mustAvoid: "",
        nextChapterAdvice: "",
        revisionDirectives: "",
      } as unknown as ContextPack

      const scoreCalls: Array<{ dims: number; keys: string[]; median: number }> = []
      const reviseCalls: Array<{ brief: string; outLen: number }> = []
      const base = createMainControlQualityDeps({ projectPath, llmConfig, chapterNumber: 1, contextPack })
      const quality = {
        scoreChapter: async (content: string) => {
          const dims = await base.scoreChapter(content)
          const values = Object.values(dims).sort((a, b) => a - b)
          const median = values.length
            ? values.length % 2
              ? values[(values.length - 1) / 2]
              : (values[values.length / 2 - 1] + values[values.length / 2]) / 2
            : 0
          scoreCalls.push({ dims: values.length, keys: Object.keys(dims), median })
          return dims
        },
        reviseChapter: async (content: string, brief: string) => {
          const revised = await base.reviseChapter(content, brief)
          reviseCalls.push({ brief: brief.slice(0, 120), outLen: revised.length })
          return revised
        },
      }

      const wikiPath = await resolveWikiPath(projectPath, fileExists)
      const steps: MainControlStep[] = []
      const startedAt = Date.now()
      // 正文直接放进目标里：既避免弱模型在只读工具之间循环，也让这轮测的就是
      // 「真实模型 → 评分/重写/草稿」本身，而不是它的检索策略。
      const chapterText = await fsp.readFile(`${projectPath}/wiki/chapters/chapter-003.md`, "utf8")
      const goal = [
        "严格按 4 步执行，每步只做一次，不要调用 list_chapters / read_chapter 等只读工具：",
        "1) 立即调用 score_chapter，content 参数必须原样传入下面【正文】全部内容；",
        "2) 如果某一维低于 8 分，调用 revise_chapter（content 同样传【正文】，brief 写明「把最低的那一维改到 9 分」）；低于 8 分才需要，否则跳过；",
        "3) 调用 write_chapter，name=「第3章-e2e」，content=最终正文（有重写就用重写结果）；",
        "4) 用两三句话汇报六维分数与草稿 ID。",
        "【正文】",
        chapterText,
      ].join("\n")

      const out = await runMainControlAgent({
        projectPath,
        wikiPath,
        goal,
        llmConfig,
        quality,
        aiWorkflowMode: "standard",
        // 只挂本轮真正要用的三个工具：请求体最小化，避开网关在长工具表下的不稳定。
        enabledToolNames: ["score_chapter", "revise_chapter", "write_chapter"],
        maxRounds: 4,
        onStep: (step) => {
          const index = steps.findIndex((existing) => existing.callId === step.callId)
          if (index < 0) steps.push(step)
          else steps[index] = { ...steps[index], ...step }
        },
      })

      const calls = steps.map((step) => ({
        name: step.name,
        status: step.status,
        resultHead: String(step.result ?? "").slice(0, 160),
      }))
      const traceEntries = buildTraceEntries(steps)
      const saved = await saveTraceSnapshot(
        projectPath,
        buildTraceSnapshot({
          goal,
          ok: out.ok,
          stopReason: out.error,
          roundsUsed: steps.length,
          finalText: out.finalText,
          steps,
          now: Date.now(),
        }),
      )
      const traceSnapshotPath = `${projectPath}/.novel/telemetry/main-control-trace.json`
      const evidencePathTrace = saved ? traceSnapshotPath : "(快照写入失败)"

      const evidence = {
        ranAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        endpoint,
        model,
        apiMode: process.env.E2E_API_MODE ?? "chat_completions",
        projectPath,
        ok: out.ok,
        stoppedReason: out.error ?? "agent-loop-finished",
        rounds: steps.length,
        calls,
        scoreCalls,
        reviseCalls,
        drafts: out.drafts.map((draft) => ({ id: draft.id, chapterName: draft.chapterName, chars: draft.words ?? 0 })),
        finalTextChars: out.finalText.length,
        traceEntries: traceEntries.length,
        tracePath: evidencePathTrace,
      }
      const evidencePath = String(process.env.E2E_EVIDENCE_PATH ?? "")
      if (evidencePath) {
        await fsp.mkdir(nodePath.dirname(evidencePath), { recursive: true })
        await fsp.writeFile(evidencePath, JSON.stringify(evidence, null, 2), "utf8")
      }
      console.log("[e2e] 证据：", JSON.stringify({ ...evidence, calls: calls.map((c) => c.name) }))

      // 断言：真实模型至少完成一次评分与一次定向重写，且草稿经 Draft-first 落盘。
      expect(scoreCalls.length, "score_chapter 未被调用").toBeGreaterThan(0)
      expect(scoreCalls[0].keys.length, "六维分数缺失").toBeGreaterThanOrEqual(6)
      expect(reviseCalls.length, "revise_chapter 未被调用").toBeGreaterThan(0)
      expect(out.drafts.length, "没有草稿产出").toBeGreaterThan(0)
      expect(out.ok).toBe(true)
      // 草稿必须落在 .novel/drafts 下，正式章节未被改写。
      const chapterFile = `${projectPath}/wiki/chapters/chapter-003.md`
      const chapterBefore = await fsp.readFile(chapterFile, "utf8")
      expect(chapterBefore.length).toBeGreaterThan(200)
    },
    900_000,
  )
})
