import { describe, expect, it } from "vitest"

import { applyWorkflowModeDepth } from "./workflow-mode-depth"
import type { NovelConfig } from "@/stores/wiki-store-config"

/**
 * DEBT-20261108-01：档位必须落到管线**真实在读**的开关上。
 *
 * 这里钉死三件事：
 *   1. fast 只关「加厚阶段」（共识 + 门控后打磨），不碰门控本身；
 *   2. standard / 未传 走原对象引用（保证零行为变更，而不是"等价的新对象"）；
 *   3. 不发明开关：共识模型组等设置在 strict 下原样保留。
 */
function baseConfig(overrides: Partial<NovelConfig> = {}): NovelConfig {
  return {
    consensusEnabled: false,
    literaryPolishAfterGate: false,
    consensusDebateRounds: 1,
    consensusWritingModels: [],
    consensusReviewModels: {},
    ...overrides,
  } as unknown as NovelConfig
}

describe("applyWorkflowModeDepth", () => {
  it("未传档位时原样返回（引用不变，行为零变更）", () => {
    const config = baseConfig({ consensusEnabled: true, literaryPolishAfterGate: true })
    expect(applyWorkflowModeDepth(config, undefined)).toBe(config)
  })

  it("standard = 完全按应用设置（引用不变）", () => {
    const on = baseConfig({ consensusEnabled: true, literaryPolishAfterGate: true })
    const off = baseConfig()
    expect(applyWorkflowModeDepth(on, "standard")).toBe(on)
    expect(applyWorkflowModeDepth(off, "standard")).toBe(off)
  })

  it("fast 关掉共识与门控后打磨，其它设置原样保留", () => {
    const config = baseConfig({
      consensusEnabled: true,
      literaryPolishAfterGate: true,
      consensusWritingModels: ["m1", "m2"],
      consensusDebateRounds: 3,
    })
    const fast = applyWorkflowModeDepth(config, "fast")
    expect(fast.consensusEnabled).toBe(false)
    expect(fast.literaryPolishAfterGate).toBe(false)
    // 只关阶段，不改配置值（避免用户改回 standard 时发现设置被悄悄重写）
    expect(fast.consensusWritingModels).toEqual(["m1", "m2"])
    expect(fast.consensusDebateRounds).toBe(3)
    // 不就地改写原对象
    expect(config.consensusEnabled).toBe(true)
  })

  it("strict 打开共识与门控后打磨", () => {
    const strict = applyWorkflowModeDepth(baseConfig(), "strict")
    expect(strict.consensusEnabled).toBe(true)
    expect(strict.literaryPolishAfterGate).toBe(true)
  })

  it("fast 不会跳一致性门控：门控相关配置一个都不动", () => {
    const config = baseConfig({
      consistencyGateEnabled: false,
      antiAiGateEnabled: false,
      qualityGateEnabled: false,
    } as unknown as Partial<NovelConfig>)
    const fast = applyWorkflowModeDepth(config, "fast")
    const keys = Object.keys(config) as (keyof NovelConfig)[]
    for (const key of keys) {
      if (key === "consensusEnabled" || key === "literaryPolishAfterGate") continue
      expect(fast[key], `${String(key)} 不应被档位改写`).toEqual(config[key])
    }
  })
})
