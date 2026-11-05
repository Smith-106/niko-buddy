// @vitest-environment jsdom
/**
 * 行为测试：action-type-utils.tsx
 *
 * 覆盖 4 个公开映射函数（短标签 / 带目标动词短语 / 纯动词 / 图标）在
 * 「已知类型 × 全部枚举值」与「未知类型兜底」两条路径上的真实返回值，
 * 并校验映射表里每个 entry 都逐一命中（防止表项漏配被 fallback 静默吞掉）。
 */
import { describe, expect, it } from "vitest"
import {
  Brain,
  Forward,
  Eye,
  Zap,
  MessageCircle,
  Handshake,
  Swords,
  EyeOff,
  Search,
  CheckCircle,
  Flame,
  Users,
  Lock,
  type LucideIcon,
} from "lucide-react"
import {
  actionTypeShortLabel,
  actionTypePhrase,
  actionTypePhraseOnly,
  actionTypeIcon,
} from "./action-type-utils"

/** 与实现内 LABEL_MAP 一一对应的期望表（独立书写，不复用生产常量）。 */
const EXPECTED_SHORT_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["evaluate", "评价"],
  ["pushPlot", "推动"],
  ["observe", "观察"],
  ["react", "反应"],
  ["speak", "对话"],
  ["ally", "示好"],
  ["confront", "对抗"],
  ["conceal", "隐瞒"],
  ["investigate", "调查"],
  ["act", "行动"],
  ["decide", "决策"],
  ["conflict", "冲突"],
  ["cooperate", "合作"],
  ["withhold", "隐瞒"],
]

/** 与实现内 ICON_MAP 一一对应的期望表。 */
const EXPECTED_ICONS: ReadonlyArray<readonly [string, LucideIcon]> = [
  ["evaluate", Brain],
  ["pushPlot", Forward],
  ["observe", Eye],
  ["react", Zap],
  ["speak", MessageCircle],
  ["ally", Handshake],
  ["confront", Swords],
  ["conceal", EyeOff],
  ["investigate", Search],
  ["act", Zap],
  ["decide", CheckCircle],
  ["conflict", Flame],
  ["cooperate", Users],
  ["withhold", Lock],
]

describe("actionTypeShortLabel", () => {
  it.each(EXPECTED_SHORT_LABELS)("把 %s 映射为短标签 %s", (type, label) => {
    expect(actionTypeShortLabel(type)).toBe(label)
  })

  it("未知类型原样返回（不做任何翻译或截断）", () => {
    expect(actionTypeShortLabel("teleport")).toBe("teleport")
    expect(actionTypeShortLabel("")).toBe("")
    // 大小写敏感：已知 key 的变形同样走兜底
    expect(actionTypeShortLabel("Evaluate")).toBe("Evaluate")
  })

  it("区分大小写与短标签长度约束（2-4 字）", () => {
    for (const [type, label] of EXPECTED_SHORT_LABELS) {
      expect(actionTypeShortLabel(type)).not.toBe(type)
      expect(label.length).toBeGreaterThanOrEqual(2)
      expect(label.length).toBeLessThanOrEqual(4)
    }
  })
})

describe("actionTypePhrase", () => {
  it("不带 targetName 时返回各类型的默认短语", () => {
    expect(actionTypePhrase("evaluate")).toBe("心中评价")
    expect(actionTypePhrase("pushPlot")).toBe("推动事态")
    expect(actionTypePhrase("observe")).toBe("观察到")
    expect(actionTypePhrase("conceal")).toBe("隐瞒内心")
    expect(actionTypePhrase("investigate")).toBe("调查")
  })

  it("react / speak / ally / confront 无目标时退回无宾语的默认短语", () => {
    expect(actionTypePhrase("react")).toBe("做出反应")
    expect(actionTypePhrase("speak")).toBe("说")
    expect(actionTypePhrase("ally")).toBe("寻求合作")
    expect(actionTypePhrase("confront")).toBe("采取对抗姿态")
  })

  it("react / speak / ally / confront 有目标时把目标名嵌入短语", () => {
    expect(actionTypePhrase("react", "林岚")).toBe("对 林岚 的反应")
    expect(actionTypePhrase("speak", "林岚")).toBe("对 林岚 说")
    expect(actionTypePhrase("ally", "林岚")).toBe("向 林岚 示好")
    expect(actionTypePhrase("confront", "林岚")).toBe("与 林岚 对抗")
  })

  it("目标名不影响不支持宾语的动作类型", () => {
    // 这些分支在任何 targetName 下都返回同一短语
    expect(actionTypePhrase("evaluate", "林岚")).toBe("心中评价")
    expect(actionTypePhrase("pushPlot", "林岚")).toBe("推动事态")
    expect(actionTypePhrase("observe", "林岚")).toBe("观察到")
    expect(actionTypePhrase("conceal", "林岚")).toBe("隐瞒内心")
    expect(actionTypePhrase("investigate", "林岚")).toBe("调查")
  })

  it("targetName 为空串时按「无目标」处理（falsy 走默认短语）", () => {
    expect(actionTypePhrase("speak", "")).toBe("说")
    expect(actionTypePhrase("react", "")).toBe("做出反应")
  })

  it("未知类型兜底为通用「行动」", () => {
    expect(actionTypePhrase("teleport")).toBe("行动")
    expect(actionTypePhrase("teleport", "林岚")).toBe("行动")
    // 表内存在但并未在 switch 中单列的类型同样兜底
    expect(actionTypePhrase("decide")).toBe("行动")
    expect(actionTypePhrase("conflict")).toBe("行动")
  })
})

describe("actionTypePhraseOnly", () => {
  it("返回不含目标名的纯动词", () => {
    expect(actionTypePhraseOnly("evaluate")).toBe("评价")
    expect(actionTypePhraseOnly("pushPlot")).toBe("推动")
    expect(actionTypePhraseOnly("observe")).toBe("观察到")
    expect(actionTypePhraseOnly("conceal")).toBe("隐瞒")
    expect(actionTypePhraseOnly("investigate")).toBe("调查")
  })

  it("需要宾语的四个类型返回介词，供调用方自行拼接目标名", () => {
    expect(actionTypePhraseOnly("react")).toBe("对")
    expect(actionTypePhraseOnly("speak")).toBe("对")
    expect(actionTypePhraseOnly("ally")).toBe("向")
    expect(actionTypePhraseOnly("confront")).toBe("与")
  })

  it("未知类型兜底为介词「对」", () => {
    expect(actionTypePhraseOnly("teleport")).toBe("对")
    expect(actionTypePhraseOnly("")).toBe("对")
    expect(actionTypePhraseOnly("decide")).toBe("对")
  })

  it("与 actionTypePhrase 一致：动词短语以纯动词为前缀或语义等价", () => {
    // 对每个已知类型，纯动词版本长度不会超过带目标版本
    for (const [type] of EXPECTED_SHORT_LABELS) {
      expect(actionTypePhraseOnly(type).length).toBeLessThanOrEqual(
        actionTypePhrase(type, "林岚").length,
      )
    }
  })
})

describe("actionTypeIcon", () => {
  it.each(EXPECTED_ICONS)("把 %s 映射为对应 Lucide 图标组件", (type, icon) => {
    expect(actionTypeIcon(type)).toBe(icon)
  })

  it("未知类型兜底为 Zap", () => {
    expect(actionTypeIcon("teleport")).toBe(Zap)
    expect(actionTypeIcon("")).toBe(Zap)
    expect(actionTypeIcon("Act")).toBe(Zap)
  })

  it("图标映射区分同义不同义的类型（withhold 用 Lock 而非 EyeOff）", () => {
    expect(actionTypeIcon("withhold")).not.toBe(actionTypeIcon("conceal"))
    expect(actionTypeIcon("withhold")).toBe(Lock)
    expect(actionTypeIcon("conceal")).toBe(EyeOff)
    // act 复用 Zap，与 react 同图标
    expect(actionTypeIcon("act")).toBe(actionTypeIcon("react"))
  })
})

describe("跨函数一致性", () => {
  it("短标签表与图标表覆盖完全相同的类型集合", () => {
    const labelKeys = EXPECTED_SHORT_LABELS.map(([type]) => type).sort()
    const iconKeys = EXPECTED_ICONS.map(([type]) => type).sort()
    expect(iconKeys).toEqual(labelKeys)

    // 短标签表：每个 key 都返回翻译值而非原样 key（即不会落到 label 兜底）
    for (const key of labelKeys) {
      expect(actionTypeShortLabel(key)).not.toBe(key)
    }
  })

  it("图标兜底 Zap 只被 react 与 act 命中", () => {
    const zapKeys = EXPECTED_SHORT_LABELS.map(([type]) => type)
      .filter((type) => actionTypeIcon(type) === Zap)
      .sort()
    expect(zapKeys).toEqual(["act", "react"])
  })
})
