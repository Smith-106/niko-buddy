import { describe, expect, it } from "vitest"
import { contextPackToPrompt, type ContextPack } from "./context-engine"

function createPack(): ContextPack {
  return {
    task: "生成第 3 章",
    chapterGoal: "",
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
    styleProfile: "冷峻、克制、短句。",
    searchResults: "",
    graphSearchResults: "",
    mustDo: "",
    mustAvoid: "",
    nextChapterAdvice: "",
    revisionDirectives: "",
  }
}

describe("contextPackToPrompt", () => {
  it("injects styleProfile only once", () => {
    const prompt = contextPackToPrompt(createPack())
    const matches = prompt.match(/冷峻、克制、短句。/g) ?? []

    expect(matches).toHaveLength(1)
  })
})
