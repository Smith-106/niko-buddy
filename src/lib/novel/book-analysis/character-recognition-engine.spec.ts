import { describe, it, expect } from "vitest"
import { vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import {
  heuristicRecognizeCharacters,
  llmScoreCharacters,
  filterMidFrequencyCandidates,
  stableCharacterId,
  recognizeCharacters,
  type HeuristicInput,
  type LlmScoringInput,
} from "./character-recognition-engine"

const stubLlmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "x",
  model: "x",
  ollamaUrl: "http://127.0.0.1:1",
  customEndpoint: "http://127.0.0.1:1",
  maxContextSize: 8000,
}

describe("heuristicRecognizeCharacters", () => {
  it("按出场章节数统计名字频次", () => {
    const input: HeuristicInput = {
      chapters: [
        { index: 0, content: "许七安走在街上，临安公主从后面追来。" },
        { index: 1, content: "许七安进入皇宫，许七安向皇帝行礼。" },
        { index: 2, content: "路人甲问路，许七安指路。" },
      ],
      minChapters: 2,
    }
    const result = heuristicRecognizeCharacters(input)
    expect(result.length).toBeGreaterThan(0)
    const xu = result.find((r) => r.name === "许七安")
    expect(xu).toBeDefined()
    expect(xu!.appearances).toBeGreaterThanOrEqual(3)  // 3 章都有
    expect(xu!.chapterIndices).toEqual([0, 1, 2])
  })

  it("次要角色低于 minChapters 阈值不出现", () => {
    const input: HeuristicInput = {
      chapters: [
        { index: 0, content: "许七安出门。" },
        { index: 1, content: "许七安回府，路人甲问路。" },
      ],
      minChapters: 2,
    }
    const result = heuristicRecognizeCharacters(input)
    expect(result.find((r) => r.name === "许七安")).toBeDefined()
    expect(result.find((r) => r.name === "路人甲")).toBeUndefined()
  })

  it("空章节返回空数组", () => {
    const input: HeuristicInput = { chapters: [], minChapters: 2 }
    expect(heuristicRecognizeCharacters(input)).toEqual([])
  })
})

describe("llmScoreCharacters", () => {
  it("调用 LLM 1 次并覆盖中频候选启发式分数", async () => {
    const llmCall = vi.fn().mockResolvedValue(JSON.stringify([
      { name: "许七安", importanceScore: 95, category: "主角", aliases: ["许七"] },
      { name: "路人甲", importanceScore: 20, category: "次要", aliases: [] },
    ]))

    const input: LlmScoringInput = {
      candidates: [
        // 中频：≤ 2 章出场（会被送入 LLM 评分）
        { id: "1", name: "许七安", aliases: [], appearances: 2, chapterIndices: [0, 1], importanceScore: 30, category: "次要", sourceBook: "" },
        { id: "2", name: "路人甲", aliases: [], appearances: 2, chapterIndices: [1, 3], importanceScore: 20, category: "次要", sourceBook: "" },
        // 高频：> 2 章出场（保留启发式分数，不送 LLM）
        { id: "3", name: "高频角色", aliases: [], appearances: 5, chapterIndices: [0, 1, 2, 3, 4], importanceScore: 50, category: "主角", sourceBook: "" },
      ],
      chapters: [{ index: 0, content: "..." }],
      llmConfig: stubLlmConfig,
      _llmCall: llmCall,
    }

    const result = await llmScoreCharacters(input)
    expect(llmCall).toHaveBeenCalledTimes(1)
    const xu = result.scored.find((r) => r.name === "许七安")
    expect(xu!.importanceScore).toBe(95)
    expect(xu!.category).toBe("主角")
    // 高频角色保留启发式分数
    const high = result.scored.find((r) => r.name === "高频角色")
    expect(high!.importanceScore).toBe(50)
  })

  it("LLM 失败时回退到启发式分数", async () => {
    const llmCall = vi.fn().mockRejectedValue(new Error("network error"))
    const result = await llmScoreCharacters({
      candidates: [
        { id: "1", name: "A", aliases: [], appearances: 1, chapterIndices: [0], importanceScore: 50, category: "配角", sourceBook: "" },
      ],
      chapters: [{ index: 0, content: "x" }],
      llmConfig: stubLlmConfig,
      _llmCall: llmCall,
    })
    expect(result.scored[0].importanceScore).toBe(50)  // 保持启发式分数
    expect(result.scored[0].category).toBe("配角")
  })

  it("没有中频候选时直接返回，跳过 LLM 调用", async () => {
    const llmCall = vi.fn().mockResolvedValue("[]")
    const result = await llmScoreCharacters({
      candidates: [
        // 全部为高频（> 2 章）
        { id: "1", name: "A", aliases: [], appearances: 5, chapterIndices: [0, 1, 2, 3, 4], importanceScore: 50, category: "配角", sourceBook: "" },
        { id: "2", name: "B", aliases: [], appearances: 4, chapterIndices: [0, 1, 2, 3], importanceScore: 40, category: "配角", sourceBook: "" },
      ],
      chapters: [{ index: 0, content: "x" }],
      llmConfig: stubLlmConfig,
      _llmCall: llmCall,
    })
    expect(llmCall).not.toHaveBeenCalled()
    expect(result.scored).toHaveLength(2)
    expect(result.scored[0].importanceScore).toBe(50)
  })
})

describe("filterMidFrequencyCandidates", () => {
  it("保留 appearances ≤ maxAppearances 的角色，截断到 maxCandidates", () => {
    const candidates = [
      { id: "1", name: "A", aliases: [], appearances: 1, chapterIndices: [0], importanceScore: 30, category: "次要" as const, sourceBook: "" },
      { id: "2", name: "B", aliases: [], appearances: 2, chapterIndices: [0], importanceScore: 30, category: "次要" as const, sourceBook: "" },
      { id: "3", name: "C", aliases: [], appearances: 3, chapterIndices: [0], importanceScore: 30, category: "次要" as const, sourceBook: "" },
    ]
    const mid = filterMidFrequencyCandidates(candidates, { maxAppearances: 2 })
    expect(mid.map((c) => c.name)).toEqual(["A", "B"])
  })
})

describe("stableCharacterId", () => {
  it("相同 name + sourceBook 生成相同 id", () => {
    const a = stableCharacterId("许七安", "长夜书")
    const b = stableCharacterId("许七安", "长夜书")
    expect(a).toBe(b)
  })

  it("不同 name 或不同 sourceBook 生成不同 id", () => {
    expect(stableCharacterId("许七安", "长夜书")).not.toBe(stableCharacterId("临安", "长夜书"))
    expect(stableCharacterId("许七安", "长夜书")).not.toBe(stableCharacterId("许七安", "其他书"))
  })

  it("heuristicRecognizeCharacters 用稳定 id", () => {
    const a = heuristicRecognizeCharacters({
      chapters: [
        { index: 0, content: "许七安出门。" },
        { index: 1, content: "许七安回来。" },
      ],
      minChapters: 2,
      sourceBook: "长夜书",
    })
    const b = heuristicRecognizeCharacters({
      chapters: [
        { index: 0, content: "许七安在路上。" },
      ],
      minChapters: 1,
      sourceBook: "长夜书",
    })
    const xuA = a.find((c) => c.name === "许七安")
    const xuB = b.find((c) => c.name === "许七安")
    expect(xuA).toBeDefined()
    expect(xuB).toBeDefined()
    expect(xuA!.id).toBe(xuB!.id)
    expect(xuA!.sourceBook).toBe("长夜书")
  })
})

describe("extractCandidateNames 分段分支", () => {
  it("2 字分段走 else 分支（整段入列）", () => {
    const result = heuristicRecognizeCharacters({
      chapters: [{ index: 0, content: "你好。许七安说：出发！" }],
      minChapters: 1,
    })
    const names = result.map((r) => r.name)
    expect(names).toContain("你好") // 2 字段
    expect(names).toContain("许七安") // 说话模式 3 字
  })
})

describe("classifyByScore 阈值", () => {
  it("出现 7 章以上 → 主角；4-6 章 → 配角", () => {
    const chapters = Array.from({ length: 7 }, (_, i) => ({
      index: i,
      content: `主角甲登场了。`,
    })).concat(
      Array.from({ length: 4 }, (_, i) => ({
        index: i,
        content: `配角乙也在场。`,
      })),
    )
    const result = heuristicRecognizeCharacters({ chapters, minChapters: 1 })
    const jia = result.find((r) => r.name === "主角甲")!
    const yi = result.find((r) => r.name === "配角乙")!
    expect(jia.appearances).toBe(7)
    expect(jia.importanceScore).toBe(70)
    expect(jia.category).toBe("主角")
    expect(yi.appearances).toBe(4)
    expect(yi.importanceScore).toBe(40)
    expect(yi.category).toBe("配角")
  })
})

describe("llmScoreCharacters 更多分支", () => {
  const mid = (name: string, appearances = 2) => ({
    id: name, name, aliases: ["原别名"] as string[], appearances,
    chapterIndices: [0], importanceScore: 30, category: "次要" as const, sourceBook: "",
  })

  it("中频角色未出现在 LLM 结果中 → 保留原样", async () => {
    const llmCall = vi.fn().mockResolvedValue(JSON.stringify([{ name: "路人甲", importanceScore: 90, category: "主角" }]))
    const result = await llmScoreCharacters({
      candidates: [mid("许七安"), mid("路人甲")],
      chapters: [{ index: 0, content: "x" }],
      llmConfig: stubLlmConfig,
      _llmCall: llmCall,
    })
    const xu = result.scored.find((r) => r.name === "许七安")!
    expect(xu.importanceScore).toBe(30) // 未覆盖
    expect(xu.category).toBe("次要")
  })

  it("llmResult.aliases 缺失 → 保留候选原别名", async () => {
    const llmCall = vi.fn().mockResolvedValue(JSON.stringify([{ name: "许七安", importanceScore: 90, category: "主角" }]))
    const result = await llmScoreCharacters({
      candidates: [mid("许七安")],
      chapters: [{ index: 0, content: "x" }],
      llmConfig: stubLlmConfig,
      _llmCall: llmCall,
    })
    expect(result.scored[0].aliases).toEqual(["原别名"])
  })

  it("未注入 _llmCall → 回退 defaultLlmCall（抛错）→ 回退启发式", async () => {
    const result = await llmScoreCharacters({
      candidates: [mid("许七安")],
      chapters: [{ index: 0, content: "x" }],
      llmConfig: stubLlmConfig,
    })
    expect(result.scored[0].importanceScore).toBe(30)
  })

  it("signal 已中止 → 抛 aborted → 回退启发式", async () => {
    const controller = new AbortController()
    controller.abort()
    const llmCall = vi.fn().mockResolvedValue("[]")
    const result = await llmScoreCharacters({
      candidates: [mid("许七安")],
      chapters: [{ index: 0, content: "x" }],
      llmConfig: stubLlmConfig,
      _llmCall: llmCall,
      signal: controller.signal,
    })
    expect(result.scored[0].importanceScore).toBe(30)
  })

  it("未中止 signal → 正常通过", async () => {
    const controller = new AbortController()
    const llmCall = vi.fn().mockResolvedValue(JSON.stringify([{ name: "许七安", importanceScore: 90, category: "主角" }]))
    const result = await llmScoreCharacters({
      candidates: [mid("许七安")],
      chapters: [{ index: 0, content: "x" }],
      llmConfig: stubLlmConfig,
      _llmCall: llmCall,
      signal: controller.signal,
    })
    expect(result.scored[0].importanceScore).toBe(90)
  })

  it("JSON 解析失败（非 JSON）→ 回退启发式", async () => {
    const llmCall = vi.fn().mockResolvedValue("不是 JSON")
    const result = await llmScoreCharacters({
      candidates: [mid("许七安")],
      chapters: [{ index: 0, content: "x" }],
      llmConfig: stubLlmConfig,
      _llmCall: llmCall,
    })
    expect(result.scored[0].importanceScore).toBe(30)
  })
})

describe("filterMidFrequencyCandidates 默认参数", () => {
  it("options 缺省 → maxAppearances=2 / maxCandidates=30", () => {
    const candidates = [
      { id: "1", name: "A", aliases: [], appearances: 2, chapterIndices: [0], importanceScore: 30, category: "次要" as const, sourceBook: "" },
      { id: "2", name: "B", aliases: [], appearances: 3, chapterIndices: [0], importanceScore: 30, category: "次要" as const, sourceBook: "" },
    ]
    const mid = filterMidFrequencyCandidates(candidates)
    expect(mid.map((c) => c.name)).toEqual(["A"])
  })

  it("maxCandidates 截断", () => {
    const candidates = Array.from({ length: 40 }, (_, i) => ({
      id: String(i), name: `C${i}`, aliases: [] as string[], appearances: 1,
      chapterIndices: [0], importanceScore: 30, category: "次要" as const, sourceBook: "",
    }))
    const mid = filterMidFrequencyCandidates(candidates, { maxAppearances: 1, maxCandidates: 5 })
    expect(mid).toHaveLength(5)
  })
})

describe("recognizeCharacters 统一入口", () => {
  it("无 llmConfig → 启发式", async () => {
    const result = await recognizeCharacters({
      chapters: [{ index: 0, content: "许七安出门。" }],
      minChapters: 1,
      sourceBook: "长夜书",
    })
    expect(result.source).toBe("heuristic")
    expect(result.characters.length).toBeGreaterThan(0)
  })

  it("有 llmConfig → llm 评分路径", async () => {
    const result = await recognizeCharacters({
      chapters: [
        { index: 0, content: "许七安出门。" },
        { index: 1, content: "许七安回来。" },
      ],
      minChapters: 2,
      sourceBook: "长夜书",
      llmConfig: stubLlmConfig,
    })
    expect(result.source).toBe("llm")
    expect(result.characters.length).toBeGreaterThan(0)
  })

  it("llmScoreCharacters 抛 Error（chapters Proxy 在 slice 时抛错）→ 回退启发式 + error 消息", async () => {
    const throwingChapters = new Proxy([{ index: 0, content: "许七安出门。" }], {
      get(t, prop) {
        if (prop === "slice") throw new Error("LLM down")
        return Reflect.get(t, prop)
      },
    })
    const result = await recognizeCharacters({
      chapters: throwingChapters,
      minChapters: 1,
      sourceBook: "长夜书",
      llmConfig: stubLlmConfig,
    })
    expect(result.source).toBe("heuristic")
    expect(result.error).toBe("LLM down")
  })

  it("llmScoreCharacters 抛非 Error → error=LLM评分失败", async () => {
    const throwingChapters = new Proxy([{ index: 0, content: "许七安出门。" }], {
      get(t, prop) {
        if (prop === "slice") throw "boom"
        return Reflect.get(t, prop)
      },
    })
    const result = await recognizeCharacters({
      chapters: throwingChapters,
      minChapters: 1,
      sourceBook: "长夜书",
      llmConfig: stubLlmConfig,
    })
    expect(result.source).toBe("heuristic")
    expect(result.error).toBe("LLM评分失败")
  })
})
