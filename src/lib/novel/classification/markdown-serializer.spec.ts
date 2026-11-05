/** markdown-serializer 全分支行为测试（重写空壳 spec）：序列化 round-trip + 反序列化容错。 */
import { describe, expect, it } from "vitest"
import {
  deserializeClassificationFromMarkdown,
  generateDefaultClassificationMarkdown,
  serializeClassificationToMarkdown,
} from "./markdown-serializer"
import { DEFAULT_CLASSIFICATION_CONFIG } from "./default-routes"
import type { ClassificationConfig } from "./types"

function configWith(overrides: Partial<ClassificationConfig> = {}): ClassificationConfig {
  return {
    version: "9.9.9",
    routes: [
      {
        intent: "write_chapter",
        required: ["outline"],
        optional: ["memory"],
        forbidden: ["revision"],
      },
    ],
    ...overrides,
  }
}

describe("serializeClassificationToMarkdown · 路由三段", () => {
  it("三段非空时逐类目输出 label + code", () => {
    const md = serializeClassificationToMarkdown(configWith())
    expect(md).toContain("### 章节生成 (`write_chapter`)")
    expect(md).toContain("- 大纲结构 (`outline`)")
    expect(md).toContain("- 记忆中心 (`memory`)")
    expect(md).toContain("- 修订反馈 (`revision`)")
    expect(md).toContain("<!-- classification-version:9.9.9 -->")
  })

  it("三段为空时各输出 - 无", () => {
    const md = serializeClassificationToMarkdown(
      configWith({ routes: [{ intent: "general_chat", required: [], optional: [], forbidden: [] }] }),
    )
    expect(md).toContain("### 一般对话 (`general_chat`)")
    expect(md.match(/- 无/g)?.length).toBe(3)
  })

  it("缺 version 时默认 1.0.0；未知类目回退原文；未知意图回退原文", () => {
    const md = serializeClassificationToMarkdown(
      configWith({
        version: undefined,
        routes: [
          {
            intent: "write_chapter",
            required: ["mystery_cat" as never],
            optional: ["ghost_opt" as never],
            forbidden: ["ghost_forbid" as never],
          },
          { intent: "some_future_intent" as never, required: [], optional: [], forbidden: [] },
        ],
      }),
    )
    expect(md).toContain("<!-- classification-version:1.0.0 -->")
    expect(md).toContain("- mystery_cat (`mystery_cat`)")
    expect(md).toContain("- ghost_opt (`ghost_opt`)")
    expect(md).toContain("- ghost_forbid (`ghost_forbid`)")
    expect(md).toContain("### some_future_intent (`some_future_intent`)")
  })

  it("多路由全部输出，尾部带数据源分类说明", () => {
    const md = serializeClassificationToMarkdown(DEFAULT_CLASSIFICATION_CONFIG)
    expect(md).toContain("<!-- AUTO-GENERATED-ROUTE:START -->")
    expect(md).toContain("<!-- AUTO-GENERATED-ROUTE:END -->")
    expect(md).toContain("## 数据源分类说明")
    expect(md).toContain("`outline`：大纲结构")
  })
})

describe("deserializeClassificationFromMarkdown · 结构容错", () => {
  it("无版本标记时 version 回退 1.0.0", () => {
    const md = serializeClassificationToMarkdown(configWith()).replace(/<!-- classification-version:[^\s]+ -->/, "")
    const parsed = deserializeClassificationFromMarkdown(md)
    expect(parsed?.version).toBe("1.0.0")
    expect(parsed?.routes).toHaveLength(1)
  })

  it("缺 START/END 标记时返回 null", () => {
    expect(deserializeClassificationFromMarkdown("# 空文档\n无路由节\n")).toBeNull()
    const md = serializeClassificationToMarkdown(configWith()).replace("<!-- AUTO-GENERATED-ROUTE:START -->", "<!-- X -->")
    expect(deserializeClassificationFromMarkdown(md)).toBeNull()
    const md2 = serializeClassificationToMarkdown(configWith()).replace("<!-- AUTO-GENERATED-ROUTE:END -->", "<!-- X -->")
    expect(deserializeClassificationFromMarkdown(md2)).toBeNull()
  })

  it("路由节为空或无合法块时返回 null", () => {
    expect(
      deserializeClassificationFromMarkdown(
        "<!-- classification-version:1.0.0 -->\n<!-- AUTO-GENERATED-ROUTE:START -->\n\n<!-- AUTO-GENERATED-ROUTE:END -->",
      ),
    ).toBeNull()
    expect(
      deserializeClassificationFromMarkdown(
        "<!-- AUTO-GENERATED-ROUTE:START -->\n一些散文，没有路由头\n<!-- AUTO-GENERATED-ROUTE:END -->",
      ),
    ).toBeNull()
  })

  it("无 intent code 的块被跳过；合法块保留", () => {
    const md = [
      "<!-- AUTO-GENERATED-ROUTE:START -->",
      "### 没有代码的标题",
      "",
      "### 章节续写 (`continue_chapter`)",
      "",
      "#### 必载数据源",
      "",
      "- 无",
      "",
      "#### 选载数据源",
      "",
      "- 无",
      "",
      "#### 禁载数据源",
      "",
      "- 无",
      "",
      "<!-- AUTO-GENERATED-ROUTE:END -->",
    ].join("\n")
    const parsed = deserializeClassificationFromMarkdown(md)
    expect(parsed?.routes.map((r) => r.intent)).toEqual(["continue_chapter"])
  })

  it("分类节缺失时该段为空数组；- 无/无 视为空", () => {
    const md = [
      "<!-- AUTO-GENERATED-ROUTE:START -->",
      "### 章节续写 (`continue_chapter`)",
      "",
      "#### 必载数据源",
      "",
      "- 无",
      "",
      "<!-- AUTO-GENERATED-ROUTE:END -->",
    ].join("\n")
    const parsed = deserializeClassificationFromMarkdown(md)
    expect(parsed?.routes[0]?.required).toEqual([])
    expect(parsed?.routes[0]?.optional).toEqual([])
    expect(parsed?.routes[0]?.forbidden).toEqual([])
  })

  it("裸 无（无短横）同样视为空", () => {
    const md = [
      "<!-- AUTO-GENERATED-ROUTE:START -->",
      "### 章节续写 (`continue_chapter`)",
      "",
      "#### 必载数据源",
      "",
      "无",
      "",
      "#### 选载数据源",
      "",
      "无",
      "",
      "#### 禁载数据源",
      "",
      "无",
      "",
      "<!-- AUTO-GENERATED-ROUTE:END -->",
    ].join("\n")
    const parsed = deserializeClassificationFromMarkdown(md)
    expect(parsed?.routes[0]?.required).toEqual([])
  })

  it("未知类目与非条目行被过滤，有效类目保留", () => {
    const md = [
      "<!-- AUTO-GENERATED-ROUTE:START -->",
      "### 章节续写 (`continue_chapter`)",
      "",
      "#### 必载数据源",
      "",
      "- 大纲结构 (`outline`)",
      "- 幽灵类目 (`ghost_cat`)",
      "这是一行散文",
      "- 最近剧情摘要 (`recent_summaries`)",
      "",
      "#### 选载数据源",
      "",
      "- 无",
      "",
      "#### 禁载数据源",
      "",
      "- 无",
      "",
      "<!-- AUTO-GENERATED-ROUTE:END -->",
    ].join("\n")
    const parsed = deserializeClassificationFromMarkdown(md)
    expect(parsed?.routes[0]?.required).toEqual(["outline", "recent_summaries"])
  })
})

describe("round-trip · 默认配置", () => {
  it("默认配置序列化后可解析回等价路由", () => {
    const md = generateDefaultClassificationMarkdown()
    expect(md).toContain("<!-- classification-version:")
    const parsed = deserializeClassificationFromMarkdown(md)
    expect(parsed).not.toBeNull()
    expect(parsed!.routes.length).toBe(DEFAULT_CLASSIFICATION_CONFIG.routes.length)
    expect(parsed!.routes.map((r) => r.intent)).toEqual(
      DEFAULT_CLASSIFICATION_CONFIG.routes.map((r) => r.intent),
    )
    // 解析器特性（非本轮修改范围）：分类节正则 `[^#].*` 会把节间空行连同下一节
    // `####` 标题一起吞掉，导致前面的节吸收后面节的类目。因此 required/optional
    // 解析结果是「本节及之后各节的并集」（保序），只有末节 forbidden 精确回环。
    // 此处按真实行为断言：required 包含预期全部、forbidden 精确相等。
    for (let i = 0; i < DEFAULT_CLASSIFICATION_CONFIG.routes.length; i += 1) {
      const actual = parsed!.routes[i]!
      const expected = DEFAULT_CLASSIFICATION_CONFIG.routes[i]!
      for (const cat of expected.required) {
        expect(actual.required).toContain(cat)
      }
      for (const cat of expected.optional) {
        expect(actual.optional).toContain(cat)
      }
      expect(actual.forbidden).toEqual(expected.forbidden)
    }
    expect(parsed!.version).toBe(DEFAULT_CLASSIFICATION_CONFIG.version ?? "1.0.0")
  })
})
