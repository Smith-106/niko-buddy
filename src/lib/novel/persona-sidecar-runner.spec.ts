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
