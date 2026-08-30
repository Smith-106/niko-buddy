import { describe, it, expect } from "vitest"
import { getMainGenreLabel } from "./outline-genres"
import {
  classifyDirectOutlineGenerationRequest,
  parseIntentClarity,
  buildIntentAnalysisPrompt,
} from "./outline-intent-clarity"
import { extractNextStep, parseNextStep } from "./outline-next-step"
import {
  getDefaultFolderForOutlineFileType,
  inferOutlineFileTypeFromSkills,
  formatChapterOutlineFileName,
  type OutlineSaveRequestFileType,
} from "./outline-save-classifier"
import { emptyPlotFrameworkLibrary } from "./plot-framework"

describe("outline-genres（频道/分类/标签体系，qmai 移植）", () => {
  it("getMainGenreLabel 男女频主分类", () => {
    expect(getMainGenreLabel("male", "xuanhuan")).toBe("玄幻")
    expect(getMainGenreLabel("female", "gudaiyanqing")).toBe("古代言情")
    expect(getMainGenreLabel("male", "unknown-key")).toBe("unknown-key")
  })
})

describe("outline-intent-clarity（意图澄清，qmai 移植）", () => {
  it("classifyDirectOutlineGenerationRequest 判定清晰/需输入", () => {
    expect(classifyDirectOutlineGenerationRequest("生成玄幻大纲，主角孤儿，修炼体系炼气筑基金丹"))
      .toBeTruthy()
  })

  it("parseIntentClarity 解析协议标记", () => {
    const r = parseIntentClarity(
      "<!-- intent_clarity -->{\"clarity\":\"needs_input\",\"missing\":[\"genre\"]}<!-- /intent_clarity -->",
    )
    expect(r).toBeTruthy()
    if (r) expect(r.clarity).toBe("needs_input")
  })

  it("buildIntentAnalysisPrompt 生成提示词", () => {
    const p = buildIntentAnalysisPrompt("测试大纲", "用户想写热血玄幻")
    expect(p).toContain("测试大纲")
    expect(p).toContain("用户想写热血玄幻")
  })
})

describe("outline-next-step（下一步推荐，qmai 移植）", () => {
  it("extractNextStep 提取推荐", () => {
    const payload = JSON.stringify({
      completedModule: "outline",
      completedScope: "第一卷",
      recommendations: [{ id: "1", label: "生成第一卷章纲", reason: "承接大纲" }],
    })
    const r = extractNextStep(`正文：\n<!-- next_step -->\n${payload}\n<!-- /next_step -->`)
    expect(r).toBeTruthy()
    const rec = r.recommendation
    if (rec) {
      expect(rec.completedModule).toBe("outline")
      expect(rec.recommendations[0].label).toBe("生成第一卷章纲")
    }
  })

  it("parseNextStep 无效输入返回 null", () => {
    expect(parseNextStep("没有标记")).toBeNull()
  })
})

describe("outline-save-classifier（保存分类，qmai 移植）", () => {
  it("getDefaultFolderForOutlineFileType 文件夹映射", () => {
    expect(getDefaultFolderForOutlineFileType("chapter-outline")).toBe("章纲")
    expect(getDefaultFolderForOutlineFileType("character")).toBe("人物小传")
  })

  it("inferOutlineFileTypeFromSkills 技能推断", () => {
    expect(inferOutlineFileTypeFromSkills(["ZhanggangSkill/v1"])).toBe("chapter-outline")
    expect(inferOutlineFileTypeFromSkills(["DagangSkill/v1"])).toBe("outline")
    expect(inferOutlineFileTypeFromSkills([])).toBeNull()
  })

  it("formatChapterOutlineFileName 文件名格式化", () => {
    expect(formatChapterOutlineFileName(3, "宗门风云")).toBe("章纲-第003章-宗门风云.md")
    expect(formatChapterOutlineFileName(1)).toBe("章纲-第001章.md")
    expect(formatChapterOutlineFileName(1, 'a/b:c')).toBe("章纲-第001章-a-b-c.md")
  })
})

describe("plot-framework 互操作（wizard 与框架库共存）", () => {
  it("emptyPlotFrameworkLibrary 可用", () => {
    const lib = emptyPlotFrameworkLibrary()
    expect(lib.frameworks).toHaveLength(0)
  })
})

// 类型存在性守卫（防未来重构破坏导出面）
const _types: OutlineSaveRequestFileType[] = [
  "outline", "volume-outline", "chapter-outline", "character",
  "setting", "foreshadowing", "organization", "quality-report",
]
expect(_types.length).toBe(8)
