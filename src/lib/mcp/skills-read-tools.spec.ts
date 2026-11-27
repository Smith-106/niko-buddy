// @vitest-environment node
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  BUILT_IN_DE_AI_SKILLS,
  DEFAULT_BUILTIN_WRITING_SKILLS,
  USER_SKILL_CONFIG_FILE,
} from "@/lib/novel"
import {
  DEFAULT_MAX_CHARS_PER_SKILL,
  DEFAULT_MAX_TOTAL_CHARS,
  SKILLS_KIND_VALUES,
  SKILLS_STAGE_VALUES,
  loadDeAiSkillConfigReadOnly,
  loadWritingSkillConfigReadOnly,
  runSkillsGet,
  runSkillsList,
} from "./skills-read-tools"

const PROJECT = "/proj/demo"

function mockFs(files: Record<string, string>) {
  const reads: string[] = []
  const readFileText = vi.fn(async (path: string) => {
    reads.push(path)
    if (path in files) return files[path]
    throw new Error(`ENOENT: ${path}`)
  })
  return { reads, readFileText }
}

describe("skills-read-tools（零 LLM / 零写盘只读技能桥）", () => {
  it("静态安全边界：零 @/lib/novel/* 深导入且零写前缀导出", async () => {
    const source = readFileSync(resolve(__dirname, "skills-read-tools.ts"), "utf8")
    // 禁止任何 @/lib/novel/... 静态或动态深导入
    expect(source).not.toMatch(/from\s+["']@\/lib\/novel\//)
    expect(source).not.toMatch(/import\(\s*["']@\/lib\/novel\//)
    // 禁止调用任何带写盘迁移副作用的 loader
    expect(source).not.toMatch(/\bloadUserSkillConfig\s*\(/)
    expect(source).not.toMatch(/\bloadDeAiSkillConfig\s*\(/)

    const mod = await import("./skills-read-tools")
    const exported = Object.keys(mod)
    expect(exported.filter((name) => /^(set|write|remove|delete|update)/i.test(name))).toEqual([])
  })

  it("冻结共享常量与默认预算契约对齐", () => {
    expect(SKILLS_STAGE_VALUES).toEqual([
      "planning",
      "drafting",
      "review",
      "rewrite",
      "output",
      "outline",
      "writing",
      "summary",
      "extract",
    ])
    expect(SKILLS_KIND_VALUES).toEqual(["writing", "de_ai", "all"])
    expect(DEFAULT_MAX_CHARS_PER_SKILL).toBe(6_000)
    expect(DEFAULT_MAX_TOTAL_CHARS).toBe(18_000)
  })

  it("纯只读配置加载器：无文件合并全部内置技能、支持旧根路径与损坏 JSON 安全降级且零写盘", async () => {
    // 1. 缺省文件 → 内置写作技能 + 内置 De-AI 技能
    const emptyFs = mockFs({})
    const wDefault = await loadWritingSkillConfigReadOnly(PROJECT, emptyFs.readFileText)
    expect(wDefault.source).toBe("built_in_default")
    expect(wDefault.corrupt).toBe(false)
    expect(wDefault.config.skills.length).toBe(DEFAULT_BUILTIN_WRITING_SKILLS.length)
    expect(wDefault.config.skills.length).toBeGreaterThanOrEqual(24)

    const dDefault = await loadDeAiSkillConfigReadOnly(PROJECT, emptyFs.readFileText)
    expect(dDefault.source).toBe("built_in_default")
    expect(dDefault.corrupt).toBe(false)

    // 2. 旧根路径回退（writing-skills.json / de-ai-skill.txt）
    const legacyFs = mockFs({
      [`${PROJECT}/writing-skills.json`]: JSON.stringify({
        version: 1,
        selectedSkillId: "skill:legacy-1",
        disabledSkillIds: ["builtin:chapter-connection"],
        skills: [
          {
            id: "skill:legacy-1",
            name: "旧根自定义技能",
            description: "来自旧路径",
            kind: ["planning"],
            stages: ["planning"],
            modes: ["standard"],
            content: "旧根正文",
            source: "uploaded",
            priority: 10,
            tags: ["旧根"],
            categoryId: "",
          },
        ],
        categories: [],
      }),
      [`${PROJECT}/de-ai-skill.txt`]: "旧版 txt 去AI味规则正文",
    })
    const wLegacy = await loadWritingSkillConfigReadOnly(PROJECT, legacyFs.readFileText)
    expect(wLegacy.source).toBe("legacy_json")
    expect(wLegacy.corrupt).toBe(false)
    expect(wLegacy.config.disabledSkillIds).toEqual(["builtin:chapter-connection"])
    expect(wLegacy.config.skills.some((s) => s.id === "skill:legacy-1")).toBe(true)
    expect(wLegacy.config.skills.length).toBe(DEFAULT_BUILTIN_WRITING_SKILLS.length + 1)

    const dLegacyTxt = await loadDeAiSkillConfigReadOnly(PROJECT, legacyFs.readFileText)
    expect(dLegacyTxt.source).toBe("legacy_txt")
    expect(dLegacyTxt.config.projectSkills).toHaveLength(1)
    expect(dLegacyTxt.config.projectSkills[0].source).toBe("legacy")

    // 3. 损坏 JSON 安全降级（不抛错、不写盘、标 corrupt: true）
    const corruptFs = mockFs({
      [`${PROJECT}/${USER_SKILL_CONFIG_FILE}`]: "{bad json",
      [`${PROJECT}/.niko-buddy/de-ai-skills.json`]: "{bad json",
    })
    const wCorrupt = await loadWritingSkillConfigReadOnly(PROJECT, corruptFs.readFileText)
    expect(wCorrupt.source).toBe("built_in_default")
    expect(wCorrupt.corrupt).toBe(true)
    expect(wCorrupt.config.skills.length).toBe(DEFAULT_BUILTIN_WRITING_SKILLS.length)

    const dCorrupt = await loadDeAiSkillConfigReadOnly(PROJECT, corruptFs.readFileText)
    expect(dCorrupt.source).toBe("built_in_default")
    expect(dCorrupt.corrupt).toBe(true)

    // 4. 损坏的旧根 de-ai-skills.json 必须立即返回 corrupt: true，不得静默吞错降级到 de-ai-skill.txt
    const legacyCorruptFs = mockFs({
      [`${PROJECT}/de-ai-skills.json`]: "{broken legacy json",
      [`${PROJECT}/de-ai-skill.txt`]: "不应被静默回退读取的旧 txt",
    })
    const dLegacyCorrupt = await loadDeAiSkillConfigReadOnly(PROJECT, legacyCorruptFs.readFileText)
    expect(dLegacyCorrupt.source).toBe("built_in_default")
    expect(dLegacyCorrupt.corrupt).toBe(true)
    expect(legacyCorruptFs.reads).not.toContain(`${PROJECT}/de-ai-skill.txt`)
  })

  it("runSkillsList：聚合内置写作 + 自定义 + De-AI（含 override），返回轻量目录（零 content）并正确标注 disabled 与 configuredForStage", async () => {
    const customWritingId = "skill:custom-outline"
    const disabledBuiltinId = DEFAULT_BUILTIN_WRITING_SKILLS[0].id
    const fs = mockFs({
      [`${PROJECT}/${USER_SKILL_CONFIG_FILE}`]: JSON.stringify({
        version: 1,
        selectedSkillId: customWritingId,
        disabledSkillIds: [disabledBuiltinId],
        skills: [
          {
            id: customWritingId,
            name: "悬疑三幕大纲法",
            description: "项目定制悬疑大纲规范",
            kind: ["planning", "structure"],
            stages: ["planning"],
            modes: ["standard", "strict"],
            content: "---\nname: suspense-outline\n---\n# 悬疑大纲规则\n高能开局。",
            source: "uploaded",
            priority: 90,
            tags: ["悬疑", "大纲"],
            categoryId: "",
          },
        ],
        categories: [],
      }),
      [`${PROJECT}/.niko-buddy/de-ai-skills.json`]: JSON.stringify({
        version: 1,
        defaultSkillId: "project:deai-custom",
        disabledSkillIds: ["built-in:literary-retain"],
        projectSkills: [
          {
            id: "project:deai-custom",
            name: "冷硬派去AI味",
            description: "项目定制去AI味",
            templateId: "custom",
            content: "删抒情总结句。",
            source: "project",
          },
        ],
        builtInSkillOverrides: [
          {
            id: "built-in:comprehensive",
            name: "综合去AI味（项目覆盖版）",
            description: "覆写描述",
            templateId: "comprehensive",
            content: "覆盖后的综合去AI味正文",
            source: "built-in",
          },
        ],
        lastChapterDeAiSkillId: null,
      }),
    })

    const novelConfig = {
      taskSkillNames: {
        writing: [disabledBuiltinId],
        outline: ["悬疑三幕大纲法"],
        review: [] as string[],
        summary: [] as string[],
        extract: [] as string[],
      },
    }

    const res = await runSkillsList(
      PROJECT,
      { stage: "outline", limit: 200 },
      { readFileText: fs.readFileText, getNovelConfig: () => novelConfig },
    )

    expect(res.meta).toEqual({ readOnly: true, llmCalls: 0, diskWrites: 0 })
    expect(res.filters.mappedSkillStage).toBe("planning")
    expect(res.filters.mappedTaskKey).toBe("outline")
    expect(res.counts.writingTotal).toBe(DEFAULT_BUILTIN_WRITING_SKILLS.length + 1)
    expect(res.counts.deAiTotal).toBe(BUILT_IN_DE_AI_SKILLS.length + 1)
    expect(res.items.length).toBeGreaterThan(0)
    // 首项应为 configuredForStage=true 的定制大纲技能（尽管其 priority=90 高于内置）
    expect(res.items[0].id).toBe(customWritingId)
    expect(res.items[0].configuredForStage).toBe(true)
    expect(res.items[0].configuredTaskKeys).toEqual(["outline"])
    expect(res.items[0].contentChars).toBeGreaterThan(0)
    // 严格轻量目录契约：绝不携带 content 正文字段
    for (const item of res.items) {
      expect("content" in item).toBe(false)
      expect(typeof item.contentChars).toBe("number")
    }

    // 过滤全部维度：kind=de_ai、enabledOnly、includeBuiltin=false、includeDeAi=false、query、分页
    const deAiRes = await runSkillsList(
      PROJECT,
      { kind: "de_ai" },
      { readFileText: fs.readFileText, getNovelConfig: () => novelConfig },
    )
    expect(deAiRes.total).toBe(BUILT_IN_DE_AI_SKILLS.length + 1)
    expect(deAiRes.items.find((i) => i.id === "built-in:comprehensive")?.name).toBe("综合去AI味（项目覆盖版）")
    expect(deAiRes.items.find((i) => i.id === "built-in:literary-retain")?.enabled).toBe(false)
    expect(deAiRes.items.find((i) => i.id === "project:deai-custom")?.isDefaultDeAi).toBe(true)

    const deAiEnabledOnly = await runSkillsList(
      PROJECT,
      { kind: "de_ai", enabledOnly: true },
      { readFileText: fs.readFileText, getNovelConfig: () => novelConfig },
    )
    expect(deAiEnabledOnly.items.some((i) => i.id === "built-in:literary-retain")).toBe(false)

    const customOnly = await runSkillsList(
      PROJECT,
      { includeBuiltin: false },
      { readFileText: fs.readFileText, getNovelConfig: () => novelConfig },
    )
    expect(customOnly.items.map((i) => i.id).sort()).toEqual(["project:deai-custom", customWritingId].sort())

    const writingOnlyViaFlag = await runSkillsList(
      PROJECT,
      { includeDeAi: false, includeBuiltin: false },
      { readFileText: fs.readFileText, getNovelConfig: () => novelConfig },
    )
    expect(writingOnlyViaFlag.items.map((i) => i.id)).toEqual([customWritingId])

    const queried = await runSkillsList(
      PROJECT,
      { query: "冷硬派" },
      { readFileText: fs.readFileText, getNovelConfig: () => novelConfig },
    )
    expect(queried.items.map((i) => i.id)).toEqual(["project:deai-custom"])

    // 分页校验
    const page1 = await runSkillsList(
      PROJECT,
      { offset: 0, limit: 2 },
      { readFileText: fs.readFileText, getNovelConfig: () => novelConfig },
    )
    const page2 = await runSkillsList(
      PROJECT,
      { offset: 2, limit: 2 },
      { readFileText: fs.readFileText, getNovelConfig: () => novelConfig },
    )
    expect(page1.returned).toBe(2)
    expect(page1.hasMore).toBe(true)
    expect(page2.returned).toBe(2)
    expect(page1.items[0].id).not.toBe(page2.items[0].id)
  })

  it("runSkillsGet：按 ids/names/stage 水合、frontmatter 剥离、linked 单文件只读容错、disabledSkipped/notFound 与单条/总量截断诊断", async () => {
    const longBody = "甲".repeat(500)
    const secondBody = "乙".repeat(500)
    const thirdBody = "丙".repeat(500)
    const fs = mockFs({
      [`${PROJECT}/${USER_SKILL_CONFIG_FILE}`]: JSON.stringify({
        version: 1,
        selectedSkillId: "skill:fm",
        disabledSkillIds: ["skill:disabled-one"],
        skills: [
          {
            id: "skill:fm",
            name: "带Frontmatter技能",
            description: "含 YAML 头",
            kind: ["planning"],
            stages: ["planning"],
            modes: ["standard"],
            content: `---\nname: fm-skill\ndescription: secret-meta\n---\n\n${longBody}`,
            source: "uploaded",
            priority: 1,
            tags: [],
            categoryId: "",
          },
          {
            id: "skill:second",
            name: "第二技能",
            description: "超预算测试",
            kind: ["planning"],
            stages: ["planning"],
            modes: ["standard"],
            content: secondBody,
            source: "uploaded",
            priority: 2,
            tags: [],
            categoryId: "",
          },
          {
            id: "skill:third",
            name: "第三技能",
            description: "将被总量预算省略",
            kind: ["planning"],
            stages: ["planning"],
            modes: ["standard"],
            content: thirdBody,
            source: "uploaded",
            priority: 3,
            tags: [],
            categoryId: "",
          },
          {
            id: "skill:disabled-one",
            name: "已禁用技能",
            description: "禁用状态",
            kind: ["planning"],
            stages: ["planning"],
            modes: ["standard"],
            content: "禁用正文",
            source: "uploaded",
            priority: 4,
            tags: [],
            categoryId: "",
          },
          {
            id: "skill:linked-rel-ok",
            name: "项目内相对外链技能",
            description: "linked 项目内相对路径",
            kind: ["style"],
            stages: ["drafting"],
            modes: ["standard"],
            content: "",
            source: "linked",
            linkedPath: "skills/custom-skill.md",
            priority: 5,
            tags: [],
            categoryId: "",
          },
          {
            id: "skill:linked-abs-ok",
            name: "项目内绝对外链技能",
            description: "linked 项目内绝对路径",
            kind: ["style"],
            stages: ["drafting"],
            modes: ["standard"],
            content: "",
            source: "linked",
            linkedPath: `${PROJECT}/skills/abs-skill.md`,
            priority: 6,
            tags: [],
            categoryId: "",
          },
          {
            id: "skill:linked-missing",
            name: "项目内外链缺失技能",
            description: "读取失败不抛错",
            kind: ["style"],
            stages: ["drafting"],
            modes: ["standard"],
            content: "缓存兜底正文",
            source: "linked",
            linkedPath: "skills/missing-dir",
            priority: 7,
            tags: [],
            categoryId: "",
          },
        ],
        categories: [],
      }),
      [`${PROJECT}/skills/custom-skill.md`]: "---\nname: rel\n---\n项目内相对外链真实正文",
      [`${PROJECT}/skills/abs-skill.md`]: "---\nname: abs\n---\n项目内绝对外链真实正文",
    })

    // 1. 默认剥离 frontmatter + 跳过 disabled + 记录 notFound + 严格单条与总量预算截断
    const res = await runSkillsGet(
      PROJECT,
      {
        ids: ["skill:fm", "skill:second", "skill:third", "skill:disabled-one", "skill:does-not-exist"],
        maxCharsPerSkill: 300,
        maxTotalChars: 500,
      },
      { readFileText: fs.readFileText, getNovelConfig: () => undefined },
    )
    expect(res.meta).toEqual({ readOnly: true, llmCalls: 0, diskWrites: 0 })
    expect(res.notFound).toEqual(["skill:does-not-exist"])
    expect(res.disabledSkipped).toEqual(["skill:disabled-one"])
    expect(res.omittedDueToBudget).toEqual(["skill:third"])
    expect(res.totalTruncated).toBe(true)
    expect(res.totalReturnedChars).toBeLessThanOrEqual(500)
    expect(res.skills).toHaveLength(2)

    expect(res.skills[0].id).toBe("skill:fm")
    expect(res.skills[0].frontmatterStripped).toBe(true)
    expect(res.skills[0].content).not.toContain("secret-meta")
    expect(res.skills[0].originalChars).toBe(500)
    expect(res.skills[0].returnedChars).toBeLessThanOrEqual(300)
    expect(res.skills[0].truncated).toBe(true)

    expect(res.skills[1].id).toBe("skill:second")
    expect(res.skills[1].returnedChars).toBeLessThanOrEqual(200)
    expect(res.skills[1].truncated).toBe(true)

    // 2. stripFrontmatter=false 保留 YAML 头，includeDisabled=true 允许返回禁用项
    const rawRes = await runSkillsGet(
      PROJECT,
      {
        ids: ["skill:fm", "skill:disabled-one"],
        stripFrontmatter: false,
        includeDisabled: true,
      },
      { readFileText: fs.readFileText, getNovelConfig: () => undefined },
    )
    expect(rawRes.disabledSkipped).toEqual([])
    expect(rawRes.skills).toHaveLength(2)
    expect(rawRes.skills[0].frontmatterStripped).toBe(false)
    expect(rawRes.skills[0].content).toContain("secret-meta")
    expect(rawRes.skills[1].enabled).toBe(false)
    expect(rawRes.skills[1].content).toBe("禁用正文")

    // 3. 项目内相对/绝对 linked 技能单文件只读水合 + 缺失目录失败不抛错回退缓存正文
    const linkedRes = await runSkillsGet(
      PROJECT,
      { ids: ["skill:linked-rel-ok", "skill:linked-abs-ok", "skill:linked-missing"] },
      { readFileText: fs.readFileText, getNovelConfig: () => undefined },
    )
    expect(linkedRes.skills).toHaveLength(3)
    expect(linkedRes.skills[0].content).toBe("项目内相对外链真实正文")
    expect(linkedRes.skills[0].frontmatterStripped).toBe(true)
    expect(linkedRes.skills[1].content).toBe("项目内绝对外链真实正文")
    expect(linkedRes.skills[1].frontmatterStripped).toBe(true)
    expect(linkedRes.skills[2].content).toBe("缓存兜底正文")

    // 4. names 解析（含路由别名 via resolveSkillReference）与 stage 按 configuredForStage 优先排序
    const byName = await runSkillsGet(
      PROJECT,
      { names: ["带Frontmatter技能", "综合去AI味", "故事大纲"] },
      { readFileText: fs.readFileText, getNovelConfig: () => undefined },
    )
    expect(byName.skills.map((s) => s.id)).toContain("skill:fm")
    expect(byName.skills.map((s) => s.id)).toContain("built-in:comprehensive")

    const byStage = await runSkillsGet(
      PROJECT,
      { stage: "outline", maxTotalChars: 2000 },
      {
        readFileText: fs.readFileText,
        getNovelConfig: () => ({
          taskSkillNames: {
            writing: [],
            outline: ["第二技能"],
            review: [],
            summary: [],
            extract: [],
          },
        }),
      },
    )
    expect(byStage.skills[0].id).toBe("skill:second")
    expect(byStage.skills[0].configuredForStage).toBe(true)
    expect(byStage.disabledSkipped).toContain("skill:disabled-one")
  })

  it("对称参数校验（对齐 Rust normalize_strict_object_args / KB 1a05e035）：容忍合法可选字段显式 null，拒绝未知键（含 null 值）与全空/全 null skills.get", async () => {
    const fs = mockFs({})
    const deps = { readFileText: fs.readFileText, getNovelConfig: () => undefined }

    // 合法可选字段传显式 null → 正常通过
    const listNullOk = await runSkillsList(
      PROJECT,
      {
        stage: null,
        kind: null,
        includeDeAi: null,
        includeBuiltin: null,
        enabledOnly: null,
        query: null,
        offset: null,
        limit: null,
      },
      deps,
    )
    expect(listNullOk.returned).toBeGreaterThan(0)

    const getNullOptionalOk = await runSkillsGet(
      PROJECT,
      {
        ids: null,
        names: ["综合去AI味"],
        stage: null,
        includeDeAi: null,
        includeDisabled: null,
        stripFrontmatter: null,
        maxCharsPerSkill: null,
        maxTotalChars: null,
      },
      deps,
    )
    expect(getNullOptionalOk.skills.map((s) => s.id)).toEqual(["built-in:comprehensive"])

    // 未知键（即便值为 null）必须显式拒绝
    await expect(runSkillsList(PROJECT, { unknownKey: null }, deps)).rejects.toThrow("参数未知")
    await expect(runSkillsGet(PROJECT, { ids: ["built-in:comprehensive"], rogueNull: null }, deps)).rejects.toThrow("参数未知")

    // skills.get 在 ids/names/stage 全部缺失或全部为 null 时必须拒绝
    await expect(runSkillsGet(PROJECT, {}, deps)).rejects.toThrow("至少需要提供 ids、names 或 stage 之一")
    await expect(
      runSkillsGet(PROJECT, { ids: null, names: null, stage: null }, deps),
    ).rejects.toThrow("至少需要提供 ids、names 或 stage 之一")

    // 非法枚举 / 换行控制字符 / 越界整数 / 空数组 / 超 20 项 / 空项目路径
    await expect(runSkillsList("", {}, deps)).rejects.toThrow("需要已打开的项目")
    await expect(runSkillsList(PROJECT, { stage: "invalid-stage" }, deps)).rejects.toThrow("stage")
    await expect(runSkillsList(PROJECT, { kind: "other" }, deps)).rejects.toThrow("kind")
    await expect(runSkillsList(PROJECT, { query: "line1\nline2" }, deps)).rejects.toThrow("单行文本")
    await expect(runSkillsList(PROJECT, { limit: 0 }, deps)).rejects.toThrow("1..200")
    await expect(runSkillsGet(PROJECT, { ids: [] }, deps)).rejects.toThrow("不能为空数组")
    await expect(
      runSkillsGet(
        PROJECT,
        { ids: Array.from({ length: 21 }, (_, idx) => `id-${idx}`) },
        deps,
      ),
    ).rejects.toThrow("最多允许 20 项")
    await expect(runSkillsGet(PROJECT, { ids: ["bad\nid"] }, deps)).rejects.toThrow("单行文本")
    await expect(runSkillsGet(PROJECT, { stage: "outline", maxCharsPerSkill: 100 }, deps)).rejects.toThrow("200..20000")
    await expect(runSkillsGet(PROJECT, { stage: "outline", maxTotalChars: 400 }, deps)).rejects.toThrow("500..30000")

    // 与 Rust validate_single_line_str 1:1 对称：拒绝 C1 控制字符（U+0080..U+009F），并在 trim 前按 Unicode 标量数校验上限
    await expect(runSkillsList(PROJECT, { query: "bad\u0085c1" }, deps)).rejects.toThrow("单行文本")
    await expect(runSkillsList(PROJECT, { query: "bad\u009bc1" }, deps)).rejects.toThrow("单行文本")
    await expect(runSkillsGet(PROJECT, { ids: ["id\u0080c1"] }, deps)).rejects.toThrow("单行文本")
    await expect(runSkillsGet(PROJECT, { names: ["name\u009fc1"] }, deps)).rejects.toThrow("单行文本")
    // trim 后为 200 字符但 trim 前为 204 字符 → 与 Rust 侧一致必须拒绝
    await expect(runSkillsList(PROJECT, { query: `  ${"a".repeat(200)}  ` }, deps)).rejects.toThrow("200 字符上限")
    await expect(runSkillsGet(PROJECT, { ids: [`  ${"a".repeat(200)}  `] }, deps)).rejects.toThrow("200 字符上限")
    // 代理对（Unicode 标量长度 = 200，UTF-16 码元 = 400）→ 200 标量放行、201 标量拒绝
    const astralOk = await runSkillsList(PROJECT, { query: "😀".repeat(200) }, deps)
    expect(astralOk.filters.query).toBe("😀".repeat(200))
    await expect(runSkillsList(PROJECT, { query: "😀".repeat(201) }, deps)).rejects.toThrow("200 字符上限")
  })

  it("安全边界（Finding 1）：越界绝对路径、目录穿越、UNC、盘符相对路径与控制字符 linkedPath 绝不调用 readFileText 并回退缓存正文", async () => {
    const blockedSkills = [
      { id: "skill:ext-unix", linkedPath: "/external/my-skill.md", content: "缓存-ext-unix" },
      { id: "skill:ext-win", linkedPath: "C:/Users/alice/.gemini/antigravity/mcp_config.json", content: "缓存-ext-win" },
      { id: "skill:traversal-rel", linkedPath: "../secret.md", content: "缓存-traversal-rel" },
      { id: "skill:traversal-nested", linkedPath: "skills/../../mcp_config.json", content: "缓存-traversal-nested" },
      { id: "skill:unc-slash", linkedPath: "//server/share/a.md", content: "缓存-unc-slash" },
      { id: "skill:unc-backslash", linkedPath: "\\\\server\\share\\a.md", content: "缓存-unc-backslash" },
      { id: "skill:drive-rel", linkedPath: "C:foo/bar.md", content: "缓存-drive-rel" },
      { id: "skill:ctrl-char", linkedPath: "skills/ok\u0085.md", content: "缓存-ctrl-char" },
      { id: "skill:empty-path", linkedPath: "   ", content: "缓存-empty-path" },
    ]
    const fs = mockFs({
      [`${PROJECT}/${USER_SKILL_CONFIG_FILE}`]: JSON.stringify({
        version: 1,
        selectedSkillId: "skill:ext-unix",
        disabledSkillIds: [],
        skills: blockedSkills.map((item, idx) => ({
          id: item.id,
          name: item.id,
          description: "越界外链回归测试",
          kind: ["style"],
          stages: ["drafting"],
          modes: ["standard"],
          content: item.content,
          source: "linked",
          linkedPath: item.linkedPath,
          priority: idx + 1,
          tags: [],
          categoryId: "",
        })),
        categories: [],
      }),
      "/external/my-skill.md": "SECRET_UNIX",
      "C:/Users/alice/.gemini/antigravity/mcp_config.json": "SECRET_WIN",
      "/proj/secret.md": "SECRET_TRAVERSAL",
      "//server/share/a.md": "SECRET_UNC",
    })

    const res = await runSkillsGet(
      PROJECT,
      { ids: blockedSkills.map((s) => s.id) },
      { readFileText: fs.readFileText, getNovelConfig: () => undefined },
    )

    expect(res.skills).toHaveLength(blockedSkills.length)
    for (let i = 0; i < blockedSkills.length; i++) {
      expect(res.skills[i].content).toBe(blockedSkills[i].content)
    }

    // 除加载项目配置文件外，绝不允许调用 readFileText 触碰任何越界/非法 linkedPath
    const nonConfigReads = fs.reads.filter(
      (p) =>
        p !== `${PROJECT}/${USER_SKILL_CONFIG_FILE}` &&
        p !== `${PROJECT}/.niko-buddy/de-ai-skills.json` &&
        p !== `${PROJECT}/de-ai-skills.json` &&
        p !== `${PROJECT}/de-ai-skill.txt`,
    )
    expect(nonConfigReads).toEqual([])
  })
})
