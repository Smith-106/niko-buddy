import { describe, expect, it } from "vitest"
import {
  DEFAULT_OUTLINE_FOLDERS,
  DEFAULT_OUTLINE_FOLDER_PATHS,
  LEGACY_OUTLINE_FOLDER_MIGRATIONS,
  isPathInsideOutlineRoot,
  sanitizeOutlineFileNamePart,
  formatChapterOutlineFileName,
  planOutlineFileMove,
  inferOutlineSaveTarget,
} from "./outline-workbench"

describe("常量", () => {
  it("默认文件夹与迁移表完整", () => {
    expect(DEFAULT_OUTLINE_FOLDERS.map((f) => f.name)).toEqual([
      "大纲",
      "卷纲",
      "章纲",
      "人物小传",
      "设定",
      "伏笔",
      "组织",
    ])
    expect(DEFAULT_OUTLINE_FOLDER_PATHS).toContain("设定/角色")
    expect(DEFAULT_OUTLINE_FOLDER_PATHS).toContain("设定/地图")
    expect(LEGACY_OUTLINE_FOLDER_MIGRATIONS).toContainEqual({
      from: "大纲文件夹",
      to: "大纲",
    })
    expect(LEGACY_OUTLINE_FOLDER_MIGRATIONS).toHaveLength(7)
  })
})

describe("isPathInsideOutlineRoot", () => {
  it("根自身视为内部", () => {
    expect(isPathInsideOutlineRoot("/book", "/book")).toBe(true)
  })

  it("子路径视为内部", () => {
    expect(isPathInsideOutlineRoot("/book/章纲/a.md", "/book")).toBe(true)
  })

  it("外部路径视为不在内部", () => {
    expect(isPathInsideOutlineRoot("/other/a.md", "/book")).toBe(false)
  })

  it("前缀相同但非子目录时返回 false", () => {
    expect(isPathInsideOutlineRoot("/book2/a.md", "/book")).toBe(false)
  })

  it("尾部斜杠被忽略", () => {
    expect(isPathInsideOutlineRoot("/book/", "/book")).toBe(true)
    expect(isPathInsideOutlineRoot("/book/章纲/", "/book/")).toBe(true)
  })

  it("反斜杠被归一化", () => {
    expect(isPathInsideOutlineRoot("\\book\\章纲\\a.md", "/book")).toBe(true)
  })
})

describe("sanitizeOutlineFileNamePart", () => {
  it("清洗非法字符与空白", () => {
    expect(sanitizeOutlineFileNamePart("  第一 章  ")).toBe("第一章")
    expect(sanitizeOutlineFileNamePart("a/b:c")).toBe("a-b-c")
    expect(sanitizeOutlineFileNamePart("-x-")).toBe("x")
    expect(sanitizeOutlineFileNamePart("   ")).toBe("")
  })
})

describe("formatChapterOutlineFileName", () => {
  it("补零并拼接标题", () => {
    expect(formatChapterOutlineFileName(5, "重逢")).toBe("章纲-第005章-重逢.md")
    expect(formatChapterOutlineFileName(12)).toBe("章纲-第012章.md")
    expect(formatChapterOutlineFileName(0)).toBe("章纲-第001章.md")
  })
})

describe("planOutlineFileMove", () => {
  it("合法移动返回目标路径", () => {
    const plan = planOutlineFileMove({
      outlineRoot: "/book",
      sourcePath: "/book/大纲/a.md",
      targetFolderPath: "/book/章纲",
      targetExists: false,
    })
    expect(plan).toEqual({ ok: true, targetPath: "/book/章纲/a.md" })
  })

  it("非 Markdown 文件被拒绝", () => {
    const plan = planOutlineFileMove({
      outlineRoot: "/book",
      sourcePath: "/book/大纲/a.txt",
      targetFolderPath: "/book/章纲",
      targetExists: false,
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.error).toContain("Markdown")
  })

  it("根目录外的源文件被拒绝", () => {
    const plan = planOutlineFileMove({
      outlineRoot: "/book",
      sourcePath: "/other/a.md",
      targetFolderPath: "/book/章纲",
      targetExists: false,
    })
    expect(plan).toEqual({
      ok: false,
      error: "只能移动大纲目录内的 Markdown 文件。",
    })
  })

  it("目标文件夹不在根内被拒绝", () => {
    const plan = planOutlineFileMove({
      outlineRoot: "/book",
      sourcePath: "/book/大纲/a.md",
      targetFolderPath: "/other/章纲",
      targetExists: false,
    })
    expect(plan).toEqual({
      ok: false,
      error: "目标文件夹必须位于大纲目录内。",
    })
  })

  it("目标已存在被拒绝", () => {
    const plan = planOutlineFileMove({
      outlineRoot: "/book",
      sourcePath: "/book/大纲/a.md",
      targetFolderPath: "/book/章纲",
      targetExists: true,
    })
    expect(plan).toEqual({
      ok: false,
      error: "目标文件已存在，请更换文件夹或重命名后再移动。",
    })
  })

  it("大写后缀与反斜杠路径可移动", () => {
    const plan = planOutlineFileMove({
      outlineRoot: "/book",
      sourcePath: "\\book\\大纲\\A.MD",
      targetFolderPath: "/book/章纲",
      targetExists: false,
    })
    expect(plan).toEqual({ ok: true, targetPath: "/book/章纲/A.MD" })
  })
})

describe("inferOutlineSaveTarget", () => {
  it("标题中的章节号判章纲", () => {
    expect(inferOutlineSaveTarget("第8章 大战", "正文")).toEqual({
      folderName: "章纲",
      fileName: "章纲-第008章-大战.md",
      outlineType: "chapter-outline",
    })
  })

  it("正文中的章节号判章纲（标题优先于正文）", () => {
    const fromContent = inferOutlineSaveTarget("番外", "第9章 余波\n后记")
    expect(fromContent.outlineType).toBe("chapter-outline")
    expect(fromContent.fileName).toBe("章纲-第009章-余波.md")
    const titleWins = inferOutlineSaveTarget("第2章 开端", "第9章 余波")
    expect(titleWins.fileName).toBe("章纲-第002章-开端.md")
  })

  it("卷纲模式判卷纲", () => {
    const result = inferOutlineSaveTarget("第二卷", "卷纲\n本卷规划")
    expect(result).toEqual({
      folderName: "卷纲",
      fileName: "卷纲-第二卷.md",
      outlineType: "volume-outline",
    })
  })

  it("分卷关键词判卷纲", () => {
    const result = inferOutlineSaveTarget("下册安排", "分卷说明")
    expect(result.outlineType).toBe("volume-outline")
    expect(result.folderName).toBe("卷纲")
  })

  it("章纲关键词判章纲", () => {
    const result = inferOutlineSaveTarget("下周计划", "下一章计划：主角进城")
    expect(result.outlineType).toBe("chapter-outline")
    expect(result.folderName).toBe("章纲")
    expect(result.fileName).toBe("章纲-下周计划.md")
  })

  it("人物关键词判人物小传", () => {
    const result = inferOutlineSaveTarget("萧炎", "男主，人物小传")
    expect(result).toEqual({
      folderName: "人物小传",
      fileName: "人物小传-萧炎.md",
      outlineType: "character-brief",
    })
  })

  it("组织关键词判组织", () => {
    const result = inferOutlineSaveTarget("青云门", "门派介绍")
    expect(result.outlineType).toBe("organization-outline")
    expect(result.folderName).toBe("组织")
  })

  it("伏笔关键词判伏笔", () => {
    const result = inferOutlineSaveTarget("玉佩", "这条线索后文回收")
    expect(result).toEqual({
      folderName: "伏笔",
      fileName: "伏笔-玉佩.md",
      outlineType: "foreshadowing-plan",
    })
  })

  it("设定关键词判设定", () => {
    const result = inferOutlineSaveTarget("修行体系", "世界观说明")
    expect(result.outlineType).toBe("setting-outline")
    expect(result.folderName).toBe("设定")
  })

  it("兜底判故事大纲", () => {
    expect(inferOutlineSaveTarget("我的故事", "很久很久以前")).toEqual({
      folderName: "大纲",
      fileName: "我的故事.md",
      outlineType: "story-outline",
    })
  })

  it("已有前缀的文件名不重复加前缀", () => {
    const result = inferOutlineSaveTarget("伏笔-玉佩", "线索回收")
    expect(result.fileName).toBe("伏笔-玉佩.md")
  })

  it("已带 md 后缀的文件名不重复加后缀", () => {
    const result = inferOutlineSaveTarget("伏笔-玉佩.md", "线索回收")
    expect(result.fileName).toBe("伏笔-玉佩.md")
  })

  it("空标题兜底为大纲", () => {
    const result = inferOutlineSaveTarget("   ", "很久很久以前")
    expect(result.fileName).toBe("大纲.md")
  })

  it("默认分支保留已有的 md 后缀", () => {
    const result = inferOutlineSaveTarget("notes.md", "很久很久以前")
    expect(result).toEqual({
      folderName: "大纲",
      fileName: "notes.md",
      outlineType: "story-outline",
    })
  })

  it("空标题命中规则时用前缀做文件名", () => {
    const result = inferOutlineSaveTarget("   ", "这条线索后文回收")
    expect(result).toEqual({
      folderName: "伏笔",
      fileName: "伏笔.md",
      outlineType: "foreshadowing-plan",
    })
  })

  it("规则按卷纲优先的顺序匹配", () => {
    const result = inferOutlineSaveTarget("第二卷人物", "卷纲与人物小传")
    expect(result.outlineType).toBe("volume-outline")
  })
})
