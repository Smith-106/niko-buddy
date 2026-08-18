import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(async (_path: string) => {}),
  writeFileAtomic: vi.fn(async (_path: string, _contents: string) => {}),
  readFile: vi.fn(async (_path: string): Promise<string> => {
    throw new Error("ENOENT")
  }),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: fsMocks.createDirectory,
  writeFileAtomic: fsMocks.writeFileAtomic,
  readFile: fsMocks.readFile,
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: vi.fn(async (_cfg: unknown, _msgs: unknown, callbacks: { onToken?: (t: string) => void; onDone?: () => void; onError?: (e: unknown) => void }) => {
    callbacks.onToken?.('{"summary":"默认 streamChat 路径","findings":["f1"]}')
    callbacks.onDone?.()
  }),
  combineAbortSignals: (signal?: AbortSignal, timeoutSignal?: AbortSignal): AbortSignal | undefined => {
    const signals = [signal, timeoutSignal].filter(Boolean) as AbortSignal[]
    if (signals.length === 0) return undefined
    if (signals.length === 1) return signals[0]
    const controller = new AbortController()
    for (const s of signals) {
      if (s.aborted) {
        controller.abort()
        break
      }
      s.addEventListener("abort", () => controller.abort(), { once: true })
    }
    return controller.signal
  },
  DEFAULT_LLM_REQUEST_TIMEOUT_MS: 30 * 60 * 1000,
}))

import {
  isDraftEligibleForPersona,
  personaSidecarPath,
  runPersonaCritique,
  type PersonaId,
} from "./persona-sidecar-runner"
import type { NovelDraftArtifact } from "./novel-session-status"

function draft(
  partial: Partial<NovelDraftArtifact> & Pick<NovelDraftArtifact, "draft_status" | "content">,
): NovelDraftArtifact {
  return {
    draft_id: "conv-1",
    conversation_id: "conv-1",
    source_task_id: "tsk-conv-1",
    user_request: "写一章对决",
    review_results: [],
    created_at: "2026-08-10T00:00:00.000Z",
    updated_at: "2026-08-10T00:00:00.000Z",
    chapter_number: 3,
    ...partial,
  }
}

describe("EPIC-005 / ADR-34 persona-sidecar-runner", () => {
  beforeEach(() => {
    fsMocks.createDirectory.mockReset()
    fsMocks.writeFileAtomic.mockReset()
    fsMocks.readFile.mockReset()
  })

  it("rejects pending draft (Draft-first)", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify(draft({ draft_status: "pending", content: "x" })))
    const res = await runPersonaCritique({
      projectPath: "/P",
      draftId: "conv-1",
      llmConfig: { provider: "openai", model: "m", apiKey: "k", baseUrl: "http://x" } as never,
      llmCall: async () => {
        throw new Error("should not call llm")
      },
    })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("draft-not-ready")
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("isDraftEligibleForPersona returns false for null draft", () => {
    expect(isDraftEligibleForPersona(null)).toBe(false)
  })

  it("returns draft-missing when the artifact cannot be loaded", async () => {
    fsMocks.readFile.mockRejectedValueOnce(new Error("ENOENT"))
    const res = await runPersonaCritique({
      projectPath: "/P",
      draftId: "conv-1",
      llmConfig: { provider: "openai", model: "m", apiKey: "k", baseUrl: "http://x" } as never,
      llmCall: async () => {},
    })
    expect(res.reason).toBe("draft-missing")
    expect(res.results).toEqual([])
  })

  it("runs all default personas when personaIds is omitted", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify(draft({ draft_status: "ready", content: "正文" })))
    let calls = 0
    const res = await runPersonaCritique({
      projectPath: "/P",
      draftId: "conv-1",
      llmConfig: { provider: "openai", model: "m", apiKey: "k", baseUrl: "http://x" } as never,
      llmCall: async (_c, _m, cb) => {
        calls += 1
        cb.onToken('{"summary":"s","findings":["f"]}')
        cb.onDone()
      },
    })
    expect(calls).toBe(4)
    expect(res.results.every((r) => r.status === "ok")).toBe(true)
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(4)
  })

  it("returns empty-personas when every persona id is unknown", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify(draft({ draft_status: "ready", content: "正文" })))
    const res = await runPersonaCritique({
      projectPath: "/P",
      draftId: "conv-1",
      personaIds: ["bogus"] as unknown as PersonaId[],
      llmConfig: { provider: "openai", model: "m", apiKey: "k", baseUrl: "http://x" } as never,
      llmCall: async () => {},
    })
    expect(res.reason).toBe("empty-personas")
  })

  it("skips remaining personas when the signal is aborted", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify(draft({ draft_status: "ready", content: "正文" })))
    const controller = new AbortController()
    controller.abort()
    const llmCall = vi.fn(async () => {})
    const res = await runPersonaCritique({
      projectPath: "/P",
      draftId: "conv-1",
      personaIds: ["critic", "reader"],
      llmConfig: { provider: "openai", model: "m", apiKey: "k", baseUrl: "http://x" } as never,
      signal: controller.signal,
      llmCall,
    })
    expect(res.results.every((r) => r.status === "skipped" && r.error === "aborted")).toBe(true)
    expect(llmCall).not.toHaveBeenCalled()
  })

  it("records persona-error for non-Error throws", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify(draft({ draft_status: "ready", content: "正文" })))
    const res = await runPersonaCritique({
      projectPath: "/P",
      draftId: "conv-1",
      personaIds: ["critic"],
      llmConfig: { provider: "openai", model: "m", apiKey: "k", baseUrl: "http://x" } as never,
      llmCall: async () => {
        throw "plain string failure"
      },
    })
    expect(res.results[0]?.status).toBe("error")
    expect(res.results[0]?.error).toBe("persona-error")
  })

  it("uses the default streamChat when llmCall is not injected", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify(draft({ draft_status: "ready", content: "正文" })))
    const res = await runPersonaCritique({
      projectPath: "/P",
      draftId: "conv-1",
      personaIds: ["critic"],
      llmConfig: { provider: "openai", model: "m", apiKey: "k", baseUrl: "http://x" } as never,
    })
    expect(res.results[0]?.status).toBe("ok")
    expect(res.results[0]?.summary).toBe("默认 streamChat 路径")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
  })

  it("tolerates an environment without AbortSignal.timeout (defensive fallback)", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify(draft({ draft_status: "ready", content: "正文" })))
    vi.stubGlobal("AbortSignal", undefined)
    try {
      const res = await runPersonaCritique({
        projectPath: "/P",
        draftId: "conv-1",
        personaIds: ["critic"],
        llmConfig: { provider: "openai", model: "m", apiKey: "k", baseUrl: "http://x" } as never,
        llmCall: async () => {},
      })
      expect(res.results[0]?.status).toBe("ok")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("invokes the onError callback when streamChat reports an error", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify(draft({ draft_status: "ready", content: "正文" })))
    const { streamChat } = await import("@/lib/llm-client")
    vi.mocked(streamChat).mockImplementationOnce(
      async (_c: unknown, _m: unknown, cb) => {
        cb.onError?.(new Error("provider error"))
        cb.onDone?.()
      },
    )
    const res = await runPersonaCritique({
      projectPath: "/P",
      draftId: "conv-1",
      personaIds: ["critic"],
      llmConfig: { provider: "openai", model: "m", apiKey: "k", baseUrl: "http://x" } as never,
    })
    expect(res.results[0]?.status).toBe("ok")
  })

  it("parses fenced JSON output", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify(draft({ draft_status: "ready", content: "正文" })))
    const res = await runPersonaCritique({
      projectPath: "/P",
      draftId: "conv-1",
      personaIds: ["critic"],
      llmConfig: { provider: "openai", model: "m", apiKey: "k", baseUrl: "http://x" } as never,
      llmCall: async (_c, _m, cb) => {
        cb.onToken('```json\n{"summary":"围栏内","findings":["f1"]}\n```')
        cb.onDone()
      },
    })
    expect(res.results[0]?.summary).toBe("围栏内")
    expect(res.results[0]?.findings).toEqual(["f1"])
  })

  it("handles JSON without a findings array", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify(draft({ draft_status: "ready", content: "正文" })))
    const res = await runPersonaCritique({
      projectPath: "/P",
      draftId: "conv-1",
      personaIds: ["critic"],
      llmConfig: { provider: "openai", model: "m", apiKey: "k", baseUrl: "http://x" } as never,
      llmCall: async (_c, _m, cb) => {
        cb.onToken('{"summary":"无发现字段"}')
        cb.onDone()
      },
    })
    expect(res.results[0]?.findings).toEqual([])
  })

  it("handles no-fence JSON, missing summary, and non-string findings", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify(draft({ draft_status: "ready", content: "正文" })))
    const res = await runPersonaCritique({
      projectPath: "/P",
      draftId: "conv-1",
      personaIds: ["critic"],
      llmConfig: { provider: "openai", model: "m", apiKey: "k", baseUrl: "http://x" } as never,
      llmCall: async (_c, _m, cb) => {
        cb.onToken('{"findings":[1,"真实要点"]}')
        cb.onDone()
      },
    })
    expect(res.results[0]?.status).toBe("ok")
    expect(res.results[0]?.findings).toEqual(["真实要点"])
    expect(typeof res.results[0]?.summary).toBe("string")
  })

  it("falls back to raw text summary for non-JSON output and empty output", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify(draft({ draft_status: "ready", content: "正文" })))
    const res = await runPersonaCritique({
      projectPath: "/P",
      draftId: "conv-1",
      personaIds: ["critic"],
      llmConfig: { provider: "openai", model: "m", apiKey: "k", baseUrl: "http://x" } as never,
      llmCall: async (_c, _m, cb) => {
        cb.onToken("这不是 JSON")
        cb.onDone()
      },
    })
    expect(res.results[0]?.summary).toBe("这不是 JSON")

    fsMocks.readFile.mockResolvedValue(JSON.stringify(draft({ draft_status: "ready", content: "正文" })))
    const res2 = await runPersonaCritique({
      projectPath: "/P",
      draftId: "conv-1",
      personaIds: ["critic"],
      llmConfig: { provider: "openai", model: "m", apiKey: "k", baseUrl: "http://x" } as never,
      llmCall: async (_c, _m, cb) => {
        cb.onDone()
      },
    })
    expect(res2.results[0]?.summary).toBe("(empty)")
  })

  it("clips long content and labels chapter-less drafts 本章", async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify(draft({ draft_status: "ready", content: "x".repeat(12001), chapter_number: null as unknown as number })),
    )
    const seenMessages: Array<Array<{ role: string; content: string }>> = []
    const res = await runPersonaCritique({
      projectPath: "/P",
      draftId: "conv-1",
      personaIds: ["critic"],
      llmConfig: { provider: "openai", model: "m", apiKey: "k", baseUrl: "http://x" } as never,
      llmCall: async (_c, messages, cb) => {
        seenMessages.push(messages)
        cb.onToken('{"summary":"s","findings":[]}')
        cb.onDone()
      },
    })
    expect(res.results[0]?.status).toBe("ok")
    const userPrompt = seenMessages[0]?.[1]?.content ?? ""
    expect(userPrompt).toContain("本章")
    expect(userPrompt).toContain("…(截断)")
  })

  it("writes sidecar JSON for ready draft without touching status.json", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify(draft({ draft_status: "ready", content: "正文对决" })))
    const res = await runPersonaCritique({
      projectPath: "/P",
      draftId: "conv-1",
      personaIds: ["critic"],
      llmConfig: { provider: "openai", model: "m", apiKey: "k", baseUrl: "http://x" } as never,
      llmCall: async (_c, _m, cb) => {
        cb.onToken('{"summary":"节奏紧","findings":["对白略硬"]}')
        cb.onDone()
      },
    })
    expect(res.ok).toBe(true)
    expect(res.results).toHaveLength(1)
    expect(res.results[0].status).toBe("ok")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const call = fsMocks.writeFileAtomic.mock.calls[0] as unknown as [string, string]
    const path = call[0]
    const body = call[1]
    expect(path).toBe(personaSidecarPath("/P", "critic"))
    expect(path).toContain("/.novel/sidecars/personas/critic.json")
    expect(path).not.toContain("status.json")
    const parsed = JSON.parse(body)
    expect(parsed.authority).toBe("advisory")
    expect(parsed.summary).toBe("节奏紧")
    expect(parsed.findings).toEqual(["对白略硬"])
  })

  it("accepts accepted draft (formal path)", () => {
    expect(isDraftEligibleForPersona(draft({ draft_status: "accepted", content: "x" }))).toBe(true)
    expect(isDraftEligibleForPersona(draft({ draft_status: "ready", content: "x" }))).toBe(true)
    expect(isDraftEligibleForPersona(draft({ draft_status: "pending", content: "x" }))).toBe(false)
    expect(isDraftEligibleForPersona(draft({ draft_status: "rejected", content: "x" }))).toBe(false)
  })

  it("continues remaining personas when one LLM call fails", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify(draft({ draft_status: "ready", content: "正文" })))
    let n = 0
    const res = await runPersonaCritique({
      projectPath: "/P",
      draftId: "conv-1",
      personaIds: ["critic", "reader"] as PersonaId[],
      llmConfig: { provider: "openai", model: "m", apiKey: "k", baseUrl: "http://x" } as never,
      llmCall: async () => {
        n += 1
        if (n === 1) throw new Error("boom")
      },
    })
    expect(res.results.map((r) => r.status)).toEqual(["error", "ok"])
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
  })
})

describe("ADR-34 firewall: main chain does not import persona-sidecar-runner", () => {
  const roots = [
    "deep-chapter-generation.ts",
    "review-adapter.ts",
    "dimension-review-adapter.ts",
    "de-ai-adapter.ts",
  ]

  for (const file of roots) {
    it(`${file} has no persona-sidecar-runner import`, () => {
      const abs = resolve(__dirname, file)
      const src = readFileSync(abs, "utf8")
      expect(src).not.toMatch(/persona-sidecar-runner/)
    })
  }
})
