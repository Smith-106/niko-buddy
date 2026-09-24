// J06-J09 真实 LLM transport 纵切面集成测试
// 真实 streamChat 经本地 fake-LLM(127.0.0.1:8787,OpenAI兼容SSE)走 HTTP+SSE;
// fs 用内存 mock(与既有 session spec 同法,等价 Tauri invoke 语义)。
// 覆盖: 启动(写running)→真实LLM流式生成→完成(写completed+结果)→重启读回一致性。
import { describe, expect, it, beforeEach, vi } from "vitest"

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

import { streamChat } from "../llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import { setAllowHttpLoopbackForTests } from "../tauri-fetch"
import {
  startDeepChapterSession,
  completeDeepChapterSession,
  loadNovelSessionStatus,
  markSessionInterrupted,
} from "./novel-session-status"

const FAKE_LLM: LlmConfig = {
  provider: "custom",
  customEndpoint: "http://127.0.0.1:8787/v1",
  model: "fake-model-1",
  apiKey: "",
  ollamaUrl: "",
  maxContextSize: 8000,
}
const PROJECT = "C:/QM-J069E2E/test-book"

// SEC-02: 允许 vitest 集成测试访问 http://127.0.0.1 loopback fake-LLM(仅测试开关)
setAllowHttpLoopbackForTests(true)

beforeEach(() => fsState.fileMap.clear())

describe("J06-J09 真实LLM transport纵切面(fake-LLM HTTP+SSE)", () => {
  it("J06 启动→J07生成→J09完成→重启读回 全链", async (ctx) => {
    // 前置: fake-LLM 未启动时跳过(本地集成证据需先起 scripts/fake-llm-server.cjs)
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 2000)
      const r = await fetch("http://127.0.0.1:8787/v1/models", { signal: ctrl.signal })
      clearTimeout(t)
      if (!r.ok) { ctx.skip(); return }
    } catch { ctx.skip(); return }
    // ── J06 启动: 写 running status ──
    const s = await startDeepChapterSession({
      projectPath: PROJECT,
      conversationId: "conv-e2e",
      userRequest: "生成第2章",
      chapterNumber: 2,
    })
    expect(s.status).toBe("running")
    let disk = await loadNovelSessionStatus(PROJECT)
    expect(disk?.status).toBe("running")
    expect(disk?.session_id).toBe(s.session_id)

    // ── J07 观察+真实LLM流式生成 ──
    let acc = ""
    let tokenCount = 0
    let streamErr: Error | null = null
    let doneFired = false
    await streamChat(
      FAKE_LLM,
      [
        { role: "system", content: "你是写作助手" },
        { role: "user", content: "生成第2章正文" },
      ],
      { onToken: (t) => { acc += t; tokenCount++ }, onDone: () => { doneFired = true }, onError: (e) => { streamErr = e } },
    )
    expect(streamErr).toBeNull()                    // 真实transport无错
    expect(doneFired).toBe(true)                    // 流式正常结束(onDone)
    expect(tokenCount).toBeGreaterThan(1)          // 真流式多片
    expect(acc).toContain("第二章 雾中的回声")       // fake-LLM确定性正文
    expect(acc.length).toBeGreaterThan(50)

    // ── J09 完成+结果落盘 ──
    const done = await completeDeepChapterSession({
      projectPath: PROJECT,
      sessionId: s.session_id,
      conversationId: "conv-e2e",
      userRequest: "生成第2章",
      chapterNumber: 2,
      finalContent: acc,
    })
    expect(done.status).toBe("completed")

    // ── 重启读回一致性 ──
    disk = await loadNovelSessionStatus(PROJECT)
    expect(disk?.status).toBe("completed")
    expect(disk?.session_id).toBe(s.session_id)

    // ── J13语义: completed非活跃态不被interrupted复活 ──
    const marked = await markSessionInterrupted(PROJECT)
    expect(marked?.status).toBe("completed")        // 幂等,不复活
  })

  it("中断降级语义: running session markSessionInterrupted→interrupted", async () => {
    const s = await startDeepChapterSession({
      projectPath: PROJECT,
      conversationId: "conv-i",
      userRequest: "生成第3章",
      chapterNumber: 3,
    })
    expect(s.status).toBe("running")
    const marked = await markSessionInterrupted(PROJECT)
    expect(marked?.status).toBe("interrupted")
    const disk = await loadNovelSessionStatus(PROJECT)
    expect(disk?.status).toBe("interrupted")
    // 二次降级幂等
    const again = await markSessionInterrupted(PROJECT)
    expect(again?.status).toBe("interrupted")
  })
})
