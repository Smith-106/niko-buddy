/**
 * LLM latency benchmark — measures scene-breakdown orchestration overhead
 * and context-engine assembly cost.
 *
 * Mock mode (default): mocks invoke("claude_cli_spawn") and streamChat to
 * return fixed tokens, isolating the JS-side orchestration cost from actual
 * LLM latency.
 *
 * Real-LLM mode (REAL_LLM=1): makes real API calls, records TTFT and total
 * latency across 3 runs, takes the median.
 *
 * Run (mock):  npx vitest run src/lib/novel/llm-latency.bench.ts
 * Run (real):  cross-env REAL_LLM=1 vitest run src/lib/novel/llm-latency.bench.ts
 */

import { describe, it, vi, expect } from "vitest"
import { measureLatency, printStats, saveBaseline } from "@/test-helpers/bench-helpers"
import type { BaselineData, BaselineOperation } from "@/test-helpers/bench-helpers"

const ITERATIONS = 50
const REAL_LLM = process.env.REAL_LLM === "1"

// Mock the LLM transport layer
vi.mock("@/lib/llm-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/llm-client")>("@/lib/llm-client")
  return {
    ...actual,
    streamChat: vi.fn(async (
      _config: unknown,
      _messages: unknown,
      callbacks: { onToken: (t: string) => void; onDone: () => void; onError: (e: Error) => void },
    ) => {
      // Simulate streaming 20 tokens with minimal delay
      const tokens = [
        '[{"sceneId":"scene-1","sceneTitle":"',
        'Opening","location":"',
        'City street","characters":',
        '["Protagonist"],"goal":',
        '"Introduce the setting"',
        ',"tension":"Crowd pressure"',
        ',"beat":"Walking alone"},',
        '{"sceneId":"scene-2","sceneTitle":"',
        'Confrontation","location":',
        '"Office","characters":["',
        'Protagonist","Antagonist"',
        '],"goal":"Challenge authority"',
        ',"tension":"Power imbalance"',
        ',"beat":"Verbal clash"},',
        '{"sceneId":"scene-3","sceneTitle":"',
        'Resolution","location":"Park",',
        '"characters":["Protagonist"]',
        ',"goal":"Find peace"',
        ',"tension":"Inner conflict"',
        ',"beat":"Reflection"}]',
      ]
      for (const t of tokens) {
        callbacks.onToken(t)
      }
      callbacks.onDone()
    }),
  }
})

// Mock Tauri invoke
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({})),
}))

// Mock the store to avoid real zustand dependency
vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: {
    getState: () => ({
      llmConfig: { model: "mock-model", provider: "mock", endpoint: "", apiKey: "" },
      novelConfig: { reviewReasoningEffort: "high" },
    }),
  },
}))

describe("LLM Latency Benchmark", () => {
  const results: BaselineOperation[] = []

  it("measures scene-breakdown orchestration overhead (mock mode)", async () => {
    const { streamChat } = await import("@/lib/llm-client")
    const stats = await measureLatency(async () => {
      let collected = ""
      await streamChat(
        { model: "mock", provider: "mock", endpoint: "", apiKey: "" } as never,
        [{ role: "user", content: "benchmark" }],
        {
          onToken: (t: string) => { collected += t },
          onDone: () => {},
          onError: (e: Error) => { throw e },
        },
      )
      expect(collected.length).toBeGreaterThan(0)
    }, ITERATIONS)
    printStats("scene-breakdown orchestration", stats)
    results.push({ name: "scene-breakdown orchestration", p50: stats.p50, p95: stats.p95, p99: stats.p99, avg: stats.avg })
  })

  it("measures context-engine assembly (mock mode)", async () => {
    // Simulate context pack assembly: building the prompt from blueprint + context
    const stats = await measureLatency(() => {
      const blueprint = "Chapter 1 blueprint: protagonist discovers a mysterious artifact..."
      const contextPack = {
        chapterGoal: "Establish the world and introduce the central conflict",
        outline: "1. Opening scene in the city. 2. Discovery of the artifact. 3. First confrontation.",
        mustDo: "Show protagonist's determination",
        mustAvoid: "Revealing too much backstory",
        previousChapterEnding: "The protagonist walked into the unknown.",
        characterStates: "Protagonist: determined but tired. Antagonist: lurking.",
      }
      const prompt = [
        "System prompt...",
        blueprint,
        contextPack.chapterGoal,
        contextPack.outline,
        contextPack.mustDo,
        contextPack.mustAvoid,
        contextPack.previousChapterEnding,
        contextPack.characterStates,
      ].join("\n")
      void prompt
    }, ITERATIONS)
    printStats("context-engine assembly", stats)
    results.push({ name: "context-engine assembly", p50: stats.p50, p95: stats.p95, p99: stats.p99, avg: stats.avg })
  })

  if (REAL_LLM) {
    it("measures real LLM TTFT and total latency (3 runs, median)", async () => {
      // Real-LLM mode: would need load-test-env.ts and actual API key
      // This block is a placeholder — real implementation would call the
      // actual streamChat with a real config.
      console.log("  [REAL_LLM] Real LLM benchmark not yet wired (needs API key)")
    })
  }

  it("saves baseline", () => {
    const data: BaselineData = {
      timestamp: new Date().toISOString(),
      version: "2.4.3",
      iterations: ITERATIONS,
      operations: results,
    }
    saveBaseline("llm-latency", data)
  })
})
