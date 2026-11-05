/** C4 冒烟覆盖：src/lib/novel/skill-pack/pack-export.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { CREDENTIAL_KEY_PARTS, isCredentialLikeKey, stripCredentialKeys, stripCredentialLines, buildPack, serializePack } from "./pack-export"
describe("pack-export.ts smoke", () => {
  it("exports CREDENTIAL_KEY_PARTS", () => {
    expect(CREDENTIAL_KEY_PARTS).toBeDefined()
  })
  it("exports isCredentialLikeKey", () => {
    expect(isCredentialLikeKey).toBeDefined()
  })
  it("exports stripCredentialKeys", () => {
    expect(stripCredentialKeys).toBeDefined()
  })
  it("exports stripCredentialLines", () => {
    expect(stripCredentialLines).toBeDefined()
  })
  it("exports buildPack", () => {
    expect(buildPack).toBeDefined()
  })
  it("exports serializePack", () => {
    expect(serializePack).toBeDefined()
  })
})

describe("buildPack 工具凭据剔除", () => {
  // 通过变量传入（而非字面量）以保留“外部对象带多余键”的真实形态：
  // 工具来自 store / 导入物，运行时可能带任意键，类型层只是契约声明。
  const outline = { name: "read-outline", category: "readable-state", description: "" }
  const leaked = {
    name: "read-secretive",
    category: "readable-state",
    description: "",
    apiKey: "sk-live-123456",
  }

  it("工具里出现凭据类键时整条工具被剔除，并给出带字段路径的结构化告警", () => {
    const result = buildPack([], {
      name: "demo-pack",
      version: "1.0.0",
      tools: [outline, leaked],
    })

    // 整条剔除：不能留下一条“少了凭据字段、其余字段照抄”的残缺工具。
    expect(result.pack.tools).toEqual([outline])
    expect(result.warnings).toContainEqual({
      code: "stripped_tool_fields",
      fields: ["apiKey"],
    })
    // 凭据值不得出现在导出物里（序列化后逐字节检查）。
    expect(serializePack(result)).not.toContain("sk-live-123456")
  })

  it("无凭据键的工具原样保留，且不产生剔除告警", () => {
    const result = buildPack([], {
      name: "demo-pack",
      version: "1.0.0",
      tools: [outline],
    })
    expect(result.pack.tools).toEqual([outline])
    expect(result.warnings.some((w) => w.code === "stripped_tool_fields")).toBe(false)
  })
})

describe("buildPack 提示词回退", () => {
  it("技能正文字段为空时用 (empty) 占位，导出物不得出现空 body", () => {
    const result = buildPack(
      [
        {
          id: "s1",
          name: "s",
          description: "",
          kind: ["style"],
          stages: ["rewrite"],
          modes: ["standard"],
          content: "",
          source: "project",
          priority: 50,
          tags: [],
          categoryId: "c1",
        },
      ],
      { name: "demo-pack", version: "1.0.0" },
    )

    expect(result.pack.prompts).toEqual([{ id: "s1", body: "(empty)" }])
  })

  it("技能 id 缺失时按序号生成稳定 prompt id（不丢这条提示词）", () => {
    const result = buildPack(
      [
        {
          id: "",
          name: "s",
          description: "",
          kind: ["style"],
          stages: ["rewrite"],
          modes: ["standard"],
          content: "正文",
          source: "project",
          priority: 50,
          tags: [],
          categoryId: "c1",
        },
      ],
      { name: "demo-pack", version: "1.0.0" },
    )

    expect(result.pack.prompts).toEqual([{ id: "prompt-0", body: "正文" }])
  })
})
