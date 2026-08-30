// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest"
import { buildUserMemoryDecision, setLatestUserMemoryDecision } from "./decision-trace"
import { recordLatestUserMemoryFeedback } from "./feedback-service"
import { addManualUserMemoryRule, loadGlobalUserMemoryConfig, saveGlobalUserMemoryConfig } from "./store"

describe("user memory feedback service", () => {
  beforeEach(() => window.localStorage.clear())

  it("只给最近一次实际命中的规则记录反馈", () => {
    let config = loadGlobalUserMemoryConfig()
    config = addManualUserMemoryRule(config, { rule: "先给结论。", category: "manual", surfaces: ["all"] }, 1)
    config = addManualUserMemoryRule(config, { rule: "保持简洁。", category: "manual", surfaces: ["all"] }, 2)
    saveGlobalUserMemoryConfig(config)
    setLatestUserMemoryDecision(buildUserMemoryDecision({
      rules: config.rules,
      selected: [config.rules[0]!],
      filtered: [],
      prompt: "先给结论",
      surface: "ai-chat",
    }))

    recordLatestUserMemoryFeedback("negative", 100)
    const loaded = loadGlobalUserMemoryConfig()

    expect(loaded.rules[0]?.negativeFeedback).toBe(1)
    expect(loaded.rules[1]?.negativeFeedback).toBe(0)
  })
})
