import { describe, expect, it } from "vitest"
import {
  sanitizeOutlineFileNamePart,
  formatChapterOutlineFileName,
  getDefaultFolderForOutlineFileType,
  inferOutlineFileTypeFromSkills,
  classifyOutlineSaveTarget,
} from "./outline-save-classifier"

describe("sanitizeOutlineFileNamePart", () => {
  it("去除首尾空白并删除内部空白", () => {
    expect(sanitizeOutlineFileNamePart("  第一 章  ")).toBe("第一章")
  })

  it("非法字符替换为连字符并合并", () => {
    expect(sanitizeOutlineFileNamePart("a/b\\c:d*e?f\"g<h>i|j")).toBe("a-b-c-d-e-f-g-h-i-j")
    expect(sanitizeOutlineFileNamePart("a//b")).toBe("a-b")
  })

  it("首尾连字符被剥离", () => {
    expect(sanitizeOutlineFileNamePart("-abc-")).toBe("abc")
    expect(sanitizeOutlineFileNamePart("：开场")).toBe("：开场")
  })

  it("空输入返回空字符串", () => {
    expect(sanitizeOutlineFileNamePart("   ")).toBe("")
  })
})

describe("formatChapterOutlineFileName", () => {
  it("章节号补零到三位并拼接标题", () => {
    expect(formatChapterOutlineFileName(5, "重逢")).toBe("章纲-第005章-重逢.md")
  })

  it("无标题时只保留章节号", () => {
    expect(formatChapterOutlineFileName(12)).toBe("章纲-第012章.md")
    expect(formatChapterOutlineFileName(3, "   ")).toBe("章纲-第003章.md")
  })

  it("章节号小于 1 时按 1 处理", () => {
    expect(formatChapterOutlineFileName(0, "序")).toBe("章纲-第001章-序.md")
    expect(formatChapterOutlineFileName(-4)).toBe("章纲-第001章.md")
  })

  it("小数章节号向下取整", () => {
    expect(formatChapterOutlineFileName(7.9, "战")).toBe("章纲-第007章-战.md")
  })

  it("标题中的非法字符被清洗", () => {
    expect(formatChapterOutlineFileName(2, "a/b")).toBe("章纲-第002章-a-b.md")
  })
})

describe("getDefaultFolderForOutlineFileType", () => {
  it("返回每种文件类型对应的目标文件夹", () => {
    expect(getDefaultFolderForOutlineFileType("outline")).toBe("大纲")
    expect(getDefaultFolderForOutlineFileType("volume-outline")).toBe("卷纲")
    expect(getDefaultFolderForOutlineFileType("chapter-outline")).toBe("章纲")
    expect(getDefaultFolderForOutlineFileType("character")).toBe("人物小传")
    expect(getDefaultFolderForOutlineFileType("setting")).toBe("设定")
    expect(getDefaultFolderForOutlineFileType("foreshadowing")).toBe("伏笔")
    expect(getDefaultFolderForOutlineFileType("organization")).toBe("组织")
    expect(getDefaultFolderForOutlineFileType("quality-report")).toBe("质量检查")
  })
})

describe("inferOutlineFileTypeFromSkills", () => {
  it("按技能名推断文件类型", () => {
    expect(inferOutlineFileTypeFromSkills(["ZhanggangSkill/生成"])).toBe("chapter-outline")
    expect(inferOutlineFileTypeFromSkills(["JueseSkill/小传"])).toBe("character")
    expect(inferOutlineFileTypeFromSkills(["faction-system"])).toBe("organization")
    expect(inferOutlineFileTypeFromSkills(["foreshadowing-suspense"])).toBe("foreshadowing")
    expect(inferOutlineFileTypeFromSkills(["SheDingSkill/设定"])).toBe("setting")
    expect(inferOutlineFileTypeFromSkills(["DagangSkill/总纲"])).toBe("outline")
  })

  it("无匹配时返回 null", () => {
    expect(inferOutlineFileTypeFromSkills([])).toBeNull()
    expect(inferOutlineFileTypeFromSkills()).toBeNull()
    expect(inferOutlineFileTypeFromSkills(["unknown-skill"])).toBeNull()
  })

  it("章纲技能优先于其他技能", () => {
    expect(
      inferOutlineFileTypeFromSkills(["JueseSkill/小传", "ZhanggangSkill/生成"]),
    ).toBe("chapter-outline")
  })
})

describe("classifyOutlineSaveTarget", () => {
  it("显式文件类型优先级最高", () => {
    const result = classifyOutlineSaveTarget({
      explicitFileType: "character",
      referencedSkills: ["ZhanggangSkill/生成"],
      title: "第3章 大战",
      content: "# 第3章 大战\n正文",
      sourceHint: "第二卷卷纲",
    })
    expect(result.fileType).toBe("character")
    expect(result.targetFolder).toBe("人物小传")
  })

  it("技能推断次之", () => {
    const result = classifyOutlineSaveTarget({
      referencedSkills: ["SheDingSkill/设定"],
      title: "我的故事",
      content: "很久很久以前",
    })
    expect(result.fileType).toBe("setting")
    expect(result.targetFolder).toBe("设定")
  })

  it("标题中的章节标记优先于 hint 与正文", () => {
    const result = classifyOutlineSaveTarget({
      title: "第3章 初遇",
      content: "平淡的开场",
      sourceHint: "人物小传",
    })
    expect(result.fileType).toBe("chapter-outline")
    expect(result.fileName).toBe("章纲-第003章-初遇.md")
  })

  it("标题中的卷标记判为卷纲", () => {
    const result = classifyOutlineSaveTarget({
      title: "第二卷 卷纲",
      content: "本卷总览",
    })
    expect(result.fileType).toBe("volume-outline")
    expect(result.targetFolder).toBe("卷纲")
  })

  it("标题带 # 前缀仍能识别章节", () => {
    const result = classifyOutlineSaveTarget({
      title: "## 第5章 重逢",
      content: "久别重逢",
    })
    expect(result.fileType).toBe("chapter-outline")
    expect(result.fileName).toBe("章纲-第005章-重逢.md")
  })

  it("正文一级标题参与章节识别", () => {
    const result = classifyOutlineSaveTarget({
      title: "更新",
      content: "# 第7章 夜战\n今晚开打",
    })
    expect(result.fileType).toBe("chapter-outline")
    expect(result.fileName).toBe("章纲-第007章-夜战.md")
  })

  it("章卷并存且只有章纲标记时判章纲", () => {
    const result = classifyOutlineSaveTarget({
      title: "第3章细纲 第二卷",
      content: "同时提到第二卷",
    })
    expect(result.fileType).toBe("chapter-outline")
  })

  it("章卷并存且只有卷纲标记时判卷纲", () => {
    const result = classifyOutlineSaveTarget({
      title: "第3章 第二卷卷纲",
      content: "卷层面的规划",
    })
    expect(result.fileType).toBe("volume-outline")
  })

  it("章卷并存且两种标记都有时判章纲", () => {
    const result = classifyOutlineSaveTarget({
      title: "章纲 卷纲 第3章 第二卷",
      content: "混合文档",
    })
    expect(result.fileType).toBe("chapter-outline")
  })

  it("章卷并存且都无类型标记时判卷纲", () => {
    const result = classifyOutlineSaveTarget({
      title: "第3章 第二卷",
      content: "混合但无类型词",
    })
    expect(result.fileType).toBe("volume-outline")
  })

  it("sourceHint 可识别章纲", () => {
    const result = classifyOutlineSaveTarget({
      title: "我的故事",
      content: "很久很久以前",
      sourceHint: "这是第5章细纲",
    })
    expect(result.fileType).toBe("chapter-outline")
  })

  it("sourceHint 识别人物/伏笔/组织/设定/质检/大纲", () => {
    const cases: Array<[string, string]> = [
      ["写一个人物小传", "character"],
      ["伏笔计划表", "foreshadowing"],
      ["组织势力一览", "organization"],
      ["世界观背景设定", "setting"],
      ["质量检查报告", "quality-report"],
      ["故事大纲总纲", "outline"],
    ]
    for (const [hint, expected] of cases) {
      expect(
        classifyOutlineSaveTarget({
          title: "我的故事",
          content: "很久很久以前",
          sourceHint: hint,
        }).fileType,
      ).toBe(expected)
    }
  })

  it("空白 hint 被忽略并走正文推断", () => {
    const result = classifyOutlineSaveTarget({
      title: "我的故事",
      content: "很久很久以前",
      sourceHint: "   ",
    })
    expect(result.fileType).toBe("outline")
    expect(result.targetFolder).toBe("大纲")
  })

  it("无法识别的 hint 返回 null 分支并走正文推断", () => {
    const result = classifyOutlineSaveTarget({
      title: "我的故事",
      content: "男主的人物小传",
      sourceHint: "随便写写",
    })
    expect(result.fileType).toBe("character")
  })

  it("正文含章纲标记判章纲", () => {
    const result = classifyOutlineSaveTarget({
      title: "更新",
      content: "# 更新\n本节是章纲草稿",
    })
    expect(result.fileType).toBe("chapter-outline")
  })

  it("正文卷纲标题判卷纲", () => {
    const result = classifyOutlineSaveTarget({
      title: "更新",
      content: "## 第二卷卷纲\n本卷规划",
    })
    expect(result.fileType).toBe("volume-outline")
  })

  it("正文第 N 卷大纲句式判卷纲", () => {
    const result = classifyOutlineSaveTarget({
      title: "更新",
      content: "第三卷大纲如下",
    })
    expect(result.fileType).toBe("volume-outline")
  })

  it("正文第 N 章句式判章纲", () => {
    const result = classifyOutlineSaveTarget({
      title: "更新",
      content: "# 更新\n第12章的内容安排",
    })
    expect(result.fileType).toBe("chapter-outline")
    expect(result.fileName).toBe("章纲-第012章-的内容安排.md")
  })

  it("正文第 N 卷句式判卷纲", () => {
    const result = classifyOutlineSaveTarget({
      title: "更新",
      content: "# 更新\n第三卷的安排",
    })
    expect(result.fileType).toBe("volume-outline")
  })

  it("正文角色词判人物", () => {
    const result = classifyOutlineSaveTarget({
      title: "更新",
      content: "# 更新\n男主的角色定位",
    })
    expect(result.fileType).toBe("character")
  })

  it("正文线索词判伏笔", () => {
    const result = classifyOutlineSaveTarget({
      title: "更新",
      content: "# 更新\n这条线索后文回收",
    })
    expect(result.fileType).toBe("foreshadowing")
  })

  it("正文阵营词判组织", () => {
    const result = classifyOutlineSaveTarget({
      title: "更新",
      content: "# 更新\n两大阵营对峙",
    })
    expect(result.fileType).toBe("organization")
  })

  it("正文世界观词判设定", () => {
    const result = classifyOutlineSaveTarget({
      title: "更新",
      content: "# 更新\n世界观与地图",
    })
    expect(result.fileType).toBe("setting")
  })

  it("正文检查报告词判质检", () => {
    const result = classifyOutlineSaveTarget({
      title: "更新",
      content: "# 更新\n问题清单如下",
    })
    expect(result.fileType).toBe("quality-report")
  })

  it("兜底判大纲", () => {
    const result = classifyOutlineSaveTarget({
      title: "我的故事",
      content: "很久很久以前",
    })
    expect(result).toEqual({
      fileType: "outline",
      targetFolder: "大纲",
      fileName: "我的故事.md",
    })
  })

  it("章纲但无章节号时用标题做文件名", () => {
    const result = classifyOutlineSaveTarget({
      explicitFileType: "chapter-outline",
      title: "番外小剧场",
      content: "轻松日常",
    })
    expect(result.fileName).toBe("番外小剧场.md")
  })

  it("章节标题后的冒号分隔符被清理", () => {
    const result = classifyOutlineSaveTarget({
      title: "第5章： 重逢",
      content: "久别",
    })
    expect(result.fileName).toBe("章纲-第005章-重逢.md")
  })

  it("人物文件名自动加角色前缀且不重复", () => {
    const first = classifyOutlineSaveTarget({
      explicitFileType: "character",
      title: "萧炎",
      content: "男主",
    })
    expect(first.fileName).toBe("角色-萧炎.md")
    const second = classifyOutlineSaveTarget({
      explicitFileType: "character",
      title: "角色-萧炎",
      content: "男主",
    })
    expect(second.fileName).toBe("角色-萧炎.md")
  })

  it("已带 .md 后缀的文件名不重复加后缀", () => {
    const result = classifyOutlineSaveTarget({
      explicitFileType: "character",
      title: "角色-萧炎.md",
      content: "男主",
    })
    expect(result.fileName).toBe("角色-萧炎.md")
    const outline = classifyOutlineSaveTarget({
      title: "总纲.md",
      content: "很久很久以前",
    })
    expect(outline.fileName).toBe("总纲.md")
  })

  it("空标题兜底文件名为大纲", () => {
    const result = classifyOutlineSaveTarget({
      title: "   ",
      content: "很久很久以前",
    })
    expect(result.fileName).toBe("大纲.md")
  })
})
