/**
 * #44 真实Provider联合补证包(J05+#40合并) — 受控验证 spec。
 *
 * 链路: 配置→健康检查→最小生成→流式→Agent提问→回答→门控→续跑→持久化→重启(读回+中断恢复)。
 * 凭据从环境变量读取(STEP0_REAL_LLM_KEY/BASE/MODEL，与 .env.test.local 同名)，
 * 缺则整文件 skip；key 只进内存 Authorization 头，永不写盘/日志/trace。
 *
 * fs 用内存 mock（与 j06-j09-real-transport.spec.ts 同法，等价 Tauri invoke 语义）；
 * 真实网络仅一步：streamChat 经 custom provider 打真实 BASE。
 * 取消/超时用纯本地确定性断言（llm-client.spec.ts 已有全覆盖，此处做存在性复核，
 * 不烧真实 token）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const fsState = vi.hoisted(() => {
  const fileMap = new Map<string, string>()
  return {
    fileMap,
    createDirectory: vi.fn(async (_path: string) => {}),
    readFile: vi.fn(async (path: string) => {
      const c = fileMap.get(path)
      if (c === undefined) throw new Error(`ENOENT: ${path}`)
      return c
    }),
    writeFileAtomic: vi.fn(async (path: string, content: string) => {
      fileMap.set(path, content)
    }),
  }
})
vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    createDirectory: fsState.createDirectory,
    readFile: fsState.readFile,
    writeFileAtomic: fsState.writeFileAtomic,
  }
})
// streamChat 顶部 import writing-wake-lock → 其内部 import platform 的 isTauri 在
// 非 Tauri 下直接走 operation()，无需 mock。运行时若抛错再处理。

import { streamChat } from "../llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import { hasUsableLlm } from "../has-usable-llm"
import { assessLlmHealth } from "../llm-health"
import { testLlmConnection } from "../connection-tests"
import { buildLlmRequestCacheTrace } from "../llm-request-trace"
import {
  startDeepChapterSession,
  completeDeepChapterSession,
  persistDeepChapterCheckpoint,
  acceptDeepChapterDraft,
  loadNovelSessionStatus,
  loadNovelDraftArtifact,
  markSessionInterrupted,
  resolveInterruptedSessionResumeCheckpoint,
} from "./novel-session-status"

const REAL_KEY = process.env.STEP0_REAL_LLM_KEY ?? ""
const REAL_BASE = process.env.STEP0_REAL_LLM_BASE ?? ""
const REAL_MODEL = process.env.STEP0_REAL_LLM_MODEL ?? ""
const hasRealCreds = REAL_KEY.length > 0 && REAL_BASE.length > 0 && REAL_MODEL.length > 0
const describeOrSkip = hasRealCreds ? describe : describe.skip

const REAL_LLM: LlmConfig = {
  provider: "custom",
  apiKey: REAL_KEY,
  model: REAL_MODEL,
  ollamaUrl: "",
  customEndpoint: REAL_BASE,
  maxContextSize: 131072,
  apiMode: "chat_completions",
  reasoning: { mode: "off" },
}
const PROJECT = "C:/QM-P44/test-book"

beforeEach(() => fsState.fileMap.clear())

describeOrSkip("#44 真实Provider联合补证(配置→健康→生成→门控→续跑→持久化→重启)", () => {
  it("配置→健康检查→最小生成", async () => {
    // 配置可用性（静态，不联网）
    expect(hasUsableLlm(REAL_LLM)).toBe(true)
    expect(assessLlmHealth(REAL_LLM).status).not.toBe("unconfigured")
    // 健康检查：真实最小生成（testLlmConnection 内部 streamChat 一短词）
    const health = await testLlmConnection(REAL_LLM)
    expect(health.ok).toBe(true)
  }, 120000)

  it("流式→Agent提问→回答(多片流式+真实内容)", async () => {
    let acc = ""
    let chunks = 0
    let done = false
    let streamErr: Error | null = null
    await streamChat(
      REAL_LLM,
      [
        { role: "system", content: "你是写作助手，只输出正文。" },
        { role: "user", content: "用一句话描写雾中的灯塔，不超过30字。" },
      ],
      {
        onToken: (t) => { acc += t; chunks++ },
        onDone: () => { done = true },
        onError: (e) => { streamErr = e },
      },
      undefined,
      { max_tokens: 64 },
    )
    expect(streamErr).toBeNull()
    expect(done).toBe(true)
    expect(chunks).toBeGreaterThan(1) // 真实流式多片（非一次性 mock）
    expect(acc.trim().length).toBeGreaterThan(0)
  }, 120000)

  it("取消与超时映射(本地确定性复核,不烧token)", async () => {
    // 超时文案存在性（llm-client.spec.ts 已全覆盖，此处复核映射不断）
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("src/lib/llm-client.ts", "utf8")
    expect(src).toContain("Request timed out after")
    expect(src).toContain("DEFAULT_LLM_REQUEST_TIMEOUT_MS")
    expect(src).toContain("isRequestCancelledError")
    // 已中止信号 → onDone（取消语义），不发起网络
    const ctrl = new AbortController()
    ctrl.abort()
    let done = false
    let err: Error | null = null
    // 用不可达端点+已中止信号：取消优先，不会真正建连
    await streamChat(
      { ...REAL_LLM, customEndpoint: "https://127.0.0.1:9/v1" },
      [{ role: "user", content: "hi" }],
      { onToken: () => {}, onDone: () => { done = true }, onError: (e) => { err = e } },
      ctrl.signal,
    )
    expect(err).toBeNull()
    expect(done).toBe(true)
  }, 60000)

  it("门控→accept→持久化→重启读回一致性", async () => {
    // 启动 running
    const s = await startDeepChapterSession({
      projectPath: PROJECT,
      conversationId: "conv-p44",
      userRequest: "P44补证生成",
      chapterNumber: 1,
    })
    expect(s.status).toBe("running")
    // 续跑检查点（门控 pending 写入）
    const gates = {
      consistency: { status: "passed" as const, verdict: "pass" as const, findings: [], repair_suggestions: [], retry_count: 0 },
      anti_ai: { status: "passed" as const, verdict: "pass" as const, findings: [], repair_suggestions: [], retry_count: 0 },
      quality: { status: "passed" as const, verdict: "pass" as const, findings: [], repair_suggestions: [], retry_count: 0 },
      overall: "pass" as const,
    }
    const cp = await persistDeepChapterCheckpoint({
      projectPath: PROJECT,
      conversationId: "conv-p44",
      userRequest: "P44补证生成",
      chapterNumber: 1,
      sessionId: s.session_id,
      checkpoint: {
        version: 1,
        originalRequest: "P44补证生成",
        chapterNumber: 1,
        stage: "after_draft",
        draftContent: "雾中灯塔一豆火。",
        decisionGates: gates,
      },
    })
    expect(cp.decision_gates.overall).toBe("pass")
    expect(cp.draft.draft_status).toBe("pending")
    // 完成 → ready
    const done = await completeDeepChapterSession({
      projectPath: PROJECT,
      conversationId: "conv-p44",
      userRequest: "P44补证生成",
      chapterNumber: 1,
      sessionId: s.session_id,
      finalContent: "雾中灯塔一豆火，归人影影绰绰。",
    })
    expect(done.status).toBe("completed")
    expect(done.draft.draft_status).toBe("ready")
    // 门控 accept（ready 才可 accept）
    const acc = await acceptDeepChapterDraft({
      projectPath: PROJECT,
      conversationId: "conv-p44",
      userRequest: "P44补证生成",
      chapterNumber: 1,
      sessionId: s.session_id,
    })
    expect(acc.draft.draft_status).toBe("accepted")
    // 重启读回一致性
    const disk = await loadNovelSessionStatus(PROJECT)
    expect(disk?.status).toBe("completed")
    expect(disk?.session_id).toBe(s.session_id)
    expect(disk?.draft.draft_status).toBe("accepted")
    const draft = await loadNovelDraftArtifact(PROJECT, "conv-p44")
    expect(draft?.draft_status).toBe("accepted")
    // completed 不被中断复活
    const marked = await markSessionInterrupted(PROJECT)
    expect(marked?.status).toBe("completed")
  })

  it("中断→续跑恢复点可达", async () => {
    const s = await startDeepChapterSession({
      projectPath: PROJECT,
      conversationId: "conv-p44i",
      userRequest: "P44中断续跑",
      chapterNumber: 2,
    })
    await persistDeepChapterCheckpoint({
      projectPath: PROJECT,
      conversationId: "conv-p44i",
      userRequest: "P44中断续跑",
      chapterNumber: 2,
      sessionId: s.session_id,
      checkpoint: {
        version: 1,
        originalRequest: "P44中断续跑",
        chapterNumber: 2,
        stage: "after_task_brief",
      },
    })
    const marked = await markSessionInterrupted(PROJECT)
    expect(marked?.status).toBe("interrupted")
    const disk = await loadNovelSessionStatus(PROJECT)
    const resume = resolveInterruptedSessionResumeCheckpoint(disk, {
      conversationId: "conv-p44i",
      userRequest: "P44中断续跑",
    })
    expect(resume?.stage).toBe("after_task_brief")
    expect(resume?.chapterNumber).toBe(2)
  })

  it("凭据不进trace/日志/落盘", async () => {
    // trace 只携带 provider/model/apiMode/用量，无 key 字段
    const trace = buildLlmRequestCacheTrace({
      config: REAL_LLM,
      startedAt: 1,
      finishedAt: 2,
      status: "success",
    })
    expect(JSON.stringify(trace)).not.toContain(REAL_KEY)
    expect(JSON.stringify(trace).toLowerCase()).not.toContain("apikey")
    // 内存 status.json 快照无凭据
    const s = await startDeepChapterSession({
      projectPath: PROJECT,
      conversationId: "conv-p44s",
      userRequest: "P44脱敏检查",
      chapterNumber: 9,
    })
    const disk = await loadNovelSessionStatus(PROJECT)
    expect(JSON.stringify(disk)).not.toContain(REAL_KEY)
    expect(s.session_id.length).toBeGreaterThan(0)
    // 落盘文件全量扫描：无 key
    for (const [, content] of fsState.fileMap) {
      expect(content).not.toContain(REAL_KEY)
    }
  })
})
