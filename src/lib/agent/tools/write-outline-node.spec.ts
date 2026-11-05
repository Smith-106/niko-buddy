import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildOutlineNodeWriteContent,
  createWriteOutlineNodeTool,
  normalizeOutlineWriteTarget,
  validateOutlineWriteTarget,
} from "./write-outline-node"

const fsMocks = vi.hoisted(() => ({
  fileExists: vi.fn(async (_p: string): Promise<boolean> => false),
  readFile: vi.fn(async (_p: string): Promise<string> => ""),
  writeFileAtomic: vi.fn(async (_p: string, _c: string): Promise<void> => {}),
}))

const novelMocks = vi.hoisted(() => ({
  isLikelyChapterOutline: vi.fn((_content: string, _name: string): boolean => false),
  summarizeChapterOutlineQuality: vi.fn(
    (_content: string): { valid: boolean; errors: string[]; warnings: string[] } => ({
      valid: true,
      errors: [],
      warnings: [],
    }),
  ),
}))

vi.mock("@/commands/fs", () => ({
  fileExists: fsMocks.fileExists,
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
}))

vi.mock("@/lib/novel", () => ({
  isLikelyChapterOutline: novelMocks.isLikelyChapterOutline,
  summarizeChapterOutlineQuality: novelMocks.summarizeChapterOutlineQuality,
}))

describe("write-outline-node helpers", () => {
  it("保留已经带标题的完整 Markdown 内容", () => {
    const content = buildOutlineNodeWriteContent("第1章", "# 章纲（第001章）\n\n正文")

    expect(content).toBe("# 章纲（第001章）\n\n正文\n")
  })

  it("为节点内容补充二级标题", () => {
    const content = buildOutlineNodeWriteContent("第1章", "正文")

    expect(content).toBe("## 第1章\n\n正文\n")
  })

  it("将结构化 JSON 节点内容转换为可阅读 Markdown，避免把 JSON 原文写入大纲", () => {
    const content = buildOutlineNodeWriteContent(
      "白莲教圣公",
      JSON.stringify({
        角色名: "白莲教圣公",
        定位: "第二方势力首领",
        核心目标: ["夺取龙脉", "逼主角暴露底牌"],
        关系: {
          主角: "表面合作，暗中试探",
          反派: "互相利用",
        },
      }),
    )

    expect(content).toContain("## 白莲教圣公")
    expect(content).toContain("### 核心目标")
    expect(content).toContain("- 夺取龙脉")
    expect(content).toContain("### 关系")
    expect(content).toContain("- 主角：表面合作，暗中试探")
    expect(content.trim()).not.toMatch(/^\{/)
  })

  it("为缺少扩展名的大纲目标自动补全 .md", () => {
    expect(normalizeOutlineWriteTarget("第一卷-有钱了我也还是程序员")).toBe(
      "第一卷-有钱了我也还是程序员.md",
    )
    expect(normalizeOutlineWriteTarget("卷纲/第一卷完整卷纲")).toBe("卷纲/第一卷完整卷纲.md")
    expect(normalizeOutlineWriteTarget("第一卷完整卷纲.MD")).toBe("第一卷完整卷纲.md")
    expect(normalizeOutlineWriteTarget("第一卷完整卷纲.md")).toBe("第一卷完整卷纲.md")
    expect(normalizeOutlineWriteTarget("章纲.txt")).toBe("章纲.txt")
    expect(validateOutlineWriteTarget(normalizeOutlineWriteTarget("第一卷完整卷纲"))).toBeNull()
  })

  it("拒绝不安全的大纲写入目标", () => {
    expect(validateOutlineWriteTarget("../章纲.md")).toContain("上级目录")
    expect(validateOutlineWriteTarget("C:/Book/章纲.md")).toContain("绝对路径")
    expect(validateOutlineWriteTarget("章纲.txt")).toContain("Markdown")
    expect(validateOutlineWriteTarget("章纲/章纲-第001章.md")).toBeNull()
  })
})

describe("jsonObjectToMarkdown 各类型分支（经 buildOutlineNodeWriteContent 观察）", () => {
  const render = (payload: unknown) => buildOutlineNodeWriteContent("节点", JSON.stringify(payload))

  it("null 值渲染为（空）占位而非字面 null", () => {
    expect(render({ a: null })).toContain("（空）")
  })

  it("字符串 / 数字 / 布尔按原值渲染", () => {
    const out = render({ s: "文本", n: 42, b: true })
    expect(out).toContain("文本")
    expect(out).toContain("42")
    expect(out).toContain("true")
  })

  it("空数组渲染为（空列表）", () => {
    expect(render({ list: [] })).toContain("（空列表）")
  })

  it("顶层空对象渲染为（空对象）", () => {
    expect(render({})).toContain("（空对象）")
  })

  it("键值为空对象时只出标题，不额外造占位", () => {
    // 嵌套空对象走“标题 + 子项”分支，Object.entries 为空 → 标题后为空
    expect(render({ obj: {} })).toContain("### obj")
  })

  it("元素为 ≤2 键的对象压成一行，键值用中文逗号连接", () => {
    const out = render({ pair: [{ 主角: "甲", 反派: "乙" }] })
    expect(out).toContain("主角：甲，反派：乙")
  })

  it("元素为 >2 键的对象递归展开为多行标题", () => {
    const out = render({ many: [{ a: 1, b: 2, c: 3 }] })
    // 键数 > 2 时不走一行“键：值”，而是逐键递归成子标题
    expect(out).not.toContain("a：1")
    expect(out).toContain("##### a")
    expect(out).toContain("##### c")
  })

  it("元素为原始值的数组按列表项渲染", () => {
    const out = render({ prims: [1, 2] })
    expect(out).toContain("- 1")
    expect(out).toContain("- 2")
  })

  it("嵌套对象渲染为标题 + 子项", () => {
    const out = render({ 卷: { 章: "一" } })
    expect(out).toContain("卷")
    expect(out).toContain("章：一")
  })

  it("递归深度超过 5 时标题层数封顶为 5（不出现六级标题）", () => {
    const out = render({ a: { b: { c: { d: { e: "x" } } } } })
    expect(out).toContain("#####")
    expect(out).not.toContain("######")
  })

  it("内容不是合法 JSON 但形似 JSON 时原样保留，不吞掉正文", () => {
    const out = buildOutlineNodeWriteContent("节点", "{不是合法 json}")
    expect(out).toContain("{不是合法 json}")
  })
})

describe("normalizeOutlineWriteTarget 边界", () => {
  it("空串原样返回", () => {
    expect(normalizeOutlineWriteTarget("")).toBe("")
  })

  it("反斜杠分隔符统一成正斜杠并补 .md", () => {
    const raw = String.raw`dir\sub\大纲`
    expect(normalizeOutlineWriteTarget(raw)).toBe("dir/sub/大纲.md")
  })

  it("扩展名大小写不敏感：.MD 归一为 .md", () => {
    expect(normalizeOutlineWriteTarget("Notes.MD")).toBe("Notes.md")
  })

  it("已有其它扩展名时原样返回，交由校验拒绝", () => {
    expect(normalizeOutlineWriteTarget("大纲.txt")).toBe("大纲.txt")
  })

  it("末段为 . 或 .. 时原样返回", () => {
    expect(normalizeOutlineWriteTarget("dir/.")).toBe("dir/.")
    expect(normalizeOutlineWriteTarget("dir/..")).toBe("dir/..")
  })

  it("末段为空（尾随斜杠）时原样返回", () => {
    expect(normalizeOutlineWriteTarget("dir/")).toBe("dir/")
  })
})

describe("validateOutlineWriteTarget 各拒绝原因", () => {
  it("空名称", () => {
    expect(validateOutlineWriteTarget("")).toBe("大纲文件名称不能为空。")
  })

  it("Unix 绝对路径", () => {
    expect(validateOutlineWriteTarget("/etc/x.md")).toBe("大纲文件名称不能使用绝对路径。")
  })

  it("Windows 盘符绝对路径", () => {
    expect(validateOutlineWriteTarget("C:/x.md")).toBe("大纲文件名称不能使用绝对路径。")
  })

  it("包含上级目录 ..", () => {
    expect(validateOutlineWriteTarget("a/../b.md")).toBe("大纲文件名称不能包含上级目录。")
  })

  it("非 Markdown 扩展名", () => {
    expect(validateOutlineWriteTarget("大纲.txt")).toBe("大纲文件名称必须是 Markdown 文件。")
  })

  it("合法名称返回 null", () => {
    expect(validateOutlineWriteTarget("卷纲/第一卷.md")).toBeNull()
  })
})

describe("createWriteOutlineNodeTool：generatePreview", () => {
  beforeEach(() => {
    fsMocks.fileExists.mockReset().mockResolvedValue(false)
    fsMocks.readFile.mockReset().mockResolvedValue("")
    fsMocks.writeFileAtomic.mockReset().mockResolvedValue(undefined)
    novelMocks.isLikelyChapterOutline.mockReset().mockReturnValue(false)
    novelMocks.summarizeChapterOutlineQuality.mockReset().mockReturnValue({ valid: true, errors: [], warnings: [] })
  })

  it("目标不合法时抛错并带上原因", async () => {
    const tool = createWriteOutlineNodeTool("/outlines")
    await expect(
      tool.generatePreview({ outlineName: "", nodeTitle: "t", nodeContent: "c" }),
    ).rejects.toThrow("无法写入大纲：大纲文件名称不能为空。")
  })

  it("文件已存在且已含同名节点：提示不会直接覆盖", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue("## 已有节点\n\n正文")
    const tool = createWriteOutlineNodeTool("/outlines")
    const preview = await tool.generatePreview({ outlineName: "卷纲", nodeTitle: "已有节点", nodeContent: "x" })
    expect(preview).toContain("不会直接覆盖")
    expect(preview).toContain("预览：")
  })

  it("文件已存在但无同名节点：提示不会直接追加", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue("## 别的节点\n\n正文")
    const tool = createWriteOutlineNodeTool("/outlines")
    const preview = await tool.generatePreview({ outlineName: "卷纲", nodeTitle: "新节点", nodeContent: "x" })
    expect(preview).toContain("不会直接追加")
  })

  it("存在性检查抛错时降级为「将写入」而不是崩掉", async () => {
    fsMocks.fileExists.mockRejectedValue(new Error("fs boom"))
    const tool = createWriteOutlineNodeTool("/outlines")
    const preview = await tool.generatePreview({ outlineName: "卷纲", nodeTitle: "n", nodeContent: "x" })
    expect(preview).toContain("将写入大纲「卷纲.md」")
  })

  it("文件不存在时给出「将写入」预览并含渲染后的节点内容", async () => {
    const tool = createWriteOutlineNodeTool("/outlines")
    const preview = await tool.generatePreview({ outlineName: "卷纲", nodeTitle: "节点", nodeContent: "正文" })
    expect(preview).toContain("将写入大纲「卷纲.md」")
    expect(preview).toContain("## 节点")
    expect(preview).toContain("正文")
  })

  it("判定为章纲且质量通过时追加「通过」提示", async () => {
    novelMocks.isLikelyChapterOutline.mockReturnValue(true)
    novelMocks.summarizeChapterOutlineQuality.mockReturnValue({ valid: true, errors: [], warnings: [] })
    const tool = createWriteOutlineNodeTool("/outlines")
    const preview = await tool.generatePreview({ outlineName: "章纲", nodeTitle: "n", nodeContent: "x" })
    expect(preview).toContain("章纲质量检查：通过。")
  })

  it("章纲有错误与警告时逐条列出", async () => {
    novelMocks.isLikelyChapterOutline.mockReturnValue(true)
    novelMocks.summarizeChapterOutlineQuality.mockReturnValue({
      valid: false,
      errors: ["缺章节标题"],
      warnings: ["节奏偏慢"],
    })
    const tool = createWriteOutlineNodeTool("/outlines")
    const preview = await tool.generatePreview({ outlineName: "章纲", nodeTitle: "n", nodeContent: "x" })
    expect(preview).toContain("错误：")
    expect(preview).toContain("- 缺章节标题")
    expect(preview).toContain("警告：")
    expect(preview).toContain("- 节奏偏慢")
  })
})

describe("createWriteOutlineNodeTool：execute", () => {
  beforeEach(() => {
    fsMocks.fileExists.mockReset().mockResolvedValue(false)
    fsMocks.readFile.mockReset().mockResolvedValue("")
    fsMocks.writeFileAtomic.mockReset().mockResolvedValue(undefined)
  })

  it("目标不合法时返回错误字符串而不是抛错", async () => {
    const tool = createWriteOutlineNodeTool("/outlines")
    const out = await tool.execute({ outlineName: "", nodeTitle: "t", nodeContent: "c" })
    expect(out).toBe("错误：大纲文件名称不能为空。")
  })

  it("文件已存在时拒绝静默覆盖", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    const tool = createWriteOutlineNodeTool("/outlines")
    const out = await tool.execute({ outlineName: "卷纲", nodeTitle: "t", nodeContent: "c" })
    expect(out).toContain("已存在")
    expect(out).toContain("不会静默覆盖")
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("写入并读回一致时报告验证通过", async () => {
    fsMocks.readFile.mockImplementation(async () => buildOutlineNodeWriteContent("节点", "正文"))
    const tool = createWriteOutlineNodeTool("/outlines")
    const out = await tool.execute({ outlineName: "卷纲", nodeTitle: "节点", nodeContent: "正文" })
    expect(out).toContain("读回验证通过")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
  })

  it("写入后读回不一致时给出警告而不是谎报成功", async () => {
    fsMocks.readFile.mockResolvedValue("被别的东西改掉了")
    const tool = createWriteOutlineNodeTool("/outlines")
    const out = await tool.execute({ outlineName: "卷纲", nodeTitle: "节点", nodeContent: "正文" })
    expect(out).toContain("警告：写入后读回验证失败")
  })

  it("写入抛错时返回错误文本并带原始消息", async () => {
    fsMocks.writeFileAtomic.mockRejectedValue(new Error("disk full"))
    const tool = createWriteOutlineNodeTool("/outlines")
    const out = await tool.execute({ outlineName: "卷纲", nodeTitle: "节点", nodeContent: "正文" })
    expect(out).toContain("错误：写入大纲失败")
    expect(out).toContain("disk full")
  })
})
