import { describe, it, expect } from "vitest"
import {
  emptyPlotFrameworkLibrary,
  normalizePlotFramework,
  normalizePlotFrameworkLibrary,
  isPlotFrameworkComplete,
  autoJudgePacing,
  applyAutoPacing,
  formatPlotFrameworkForOutlinePrompt,
  listMainLineFrameworks,
  listSubLineFrameworks,
  PLOT_FRAMEWORK_REQUIRED_BEATS,
  type PlotFramework,
  type PlotFrameworkLibrary,
} from "./plot-framework"

function makeBeats(overrides: Partial<PlotFramework["beats"]> = {}) {
  return {
    hook: "穿越后觉醒双S职业",
    buildup: "配角衬托A级即顶点，女主觉醒A级震老师",
    payoff: "男主双S打破规则，震慑全场",
    endingHook: "所有人启程前往新手副本",
    ...overrides,
  }
}

function makeFramework(overrides: Partial<PlotFramework> = {}): PlotFramework {
  return {
    id: "fw-1",
    title: "双S转职反差爽点",
    beats: makeBeats(),
    rangeChapterIds: ["ch-1"],
    line: "main",
    characters: [{ name: "男主", role: "金手指持有者，打破规则完成爽点" }, { name: "女主", role: "觉醒A级职业，衬托主角反差" }],
    directionHints: "震惊时机：双S转职结果公布时；装逼时机：对比A级路人时",
    handcraftHints: "爽点处适合玩梗；铺垫处配角对话适合整活",
    foreshadowing: ["新手副本铺垫"],
    reusableTemplate: "先压后扬，规则打破",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  } as PlotFramework
}

describe("plot-framework 类型层", () => {
  describe("normalizePlotFramework", () => {
    it("保留完整四段框架", () => {
      const fw = normalizePlotFramework(makeFramework())
      expect(fw).not.toBeNull()
      expect(fw!.beats.hook).toBe("穿越后觉醒双S职业")
      expect(fw!.beats.buildup).toContain("配角衬托")
      expect(fw!.beats.payoff).toContain("双S打破规则")
      expect(fw!.beats.endingHook).toContain("新手副本")
    })

    it("任一四段为空则丢弃（防 AI 拆文抖动产生半成品）", () => {
      expect(normalizePlotFramework(makeFramework({ beats: makeBeats({ hook: "" }) }))).toBeNull()
      expect(normalizePlotFramework(makeFramework({ beats: makeBeats({ buildup: "  " }) }))).toBeNull()
      expect(normalizePlotFramework(makeFramework({ beats: makeBeats({ payoff: "" }) }))).toBeNull()
      expect(normalizePlotFramework(makeFramework({ beats: makeBeats({ endingHook: "" }) }))).toBeNull()
    })

    it("默认 line 为 main", () => {
      const fw = normalizePlotFramework({ ...makeFramework(), line: undefined })
      expect(fw!.line).toBe("main")
    })

    it("支线 line 显式标注后保留", () => {
      const fw = normalizePlotFramework(makeFramework({ line: "sub" }))
      expect(fw!.line).toBe("sub")
    })

    it("清理 rangeChapterIds 中空值", () => {
      const fw = normalizePlotFramework(
        makeFramework({ rangeChapterIds: ["ch-1", "", "  ", "ch-2"] }),
      )
      expect(fw!.rangeChapterIds).toEqual(["ch-1", "ch-2"])
    })

    it("清理 characters 中空值（结构化角色）", () => {
      const fw = normalizePlotFramework(
        makeFramework({
          characters: [
            { name: "男主", role: "主角" },
            { name: "", role: "无名" },
            { name: "  ", role: "空白" },
            { name: "女主", role: "" },
          ],
        }),
      )
      expect(fw!.characters).toEqual([
        { name: "男主", role: "主角" },
        { name: "女主", role: "" },
      ])
    })

    it("兼容旧 string[] characters 格式，自动转为结构化", () => {
      const fw = normalizePlotFramework({
        ...makeFramework(),
        // @ts-expect-error 测试旧格式兼容
        characters: ["旧男主", "旧女主"],
      })
      expect(fw!.characters).toEqual([
        { name: "旧男主", role: "" },
        { name: "旧女主", role: "" },
      ])
    })

    it("默认 directionHints 和 handcraftHints 为空字符串", () => {
      const fw = normalizePlotFramework({ ...makeFramework(), directionHints: undefined, handcraftHints: undefined })
      expect(fw!.directionHints).toBe("")
      expect(fw!.handcraftHints).toBe("")
    })

    it("缺 id 时自动生成 framework- 前缀", () => {
      const fw = normalizePlotFramework({ ...makeFramework(), id: "" })
      expect(fw!.id).toMatch(/^framework-\d+$/)
    })

    it("空标题回退为未命名剧情框架", () => {
      const fw = normalizePlotFramework({ ...makeFramework(), title: "   " })
      expect(fw!.title).toBe("未命名剧情框架")
    })
  })

  describe("isPlotFrameworkComplete", () => {
    it("完整框架返回 true", () => {
      expect(isPlotFrameworkComplete(makeFramework())).toBe(true)
    })

    it("检查四段全部覆盖", () => {
      expect(PLOT_FRAMEWORK_REQUIRED_BEATS).toEqual(["hook", "buildup", "payoff", "endingHook"])
    })
  })

  describe("autoJudgePacing", () => {
    it("<= 3 章判为 tight（紧凑型）", () => {
      expect(autoJudgePacing(makeFramework({ rangeChapterIds: ["ch-1"] })).pacing).toBe("tight")
      expect(autoJudgePacing(makeFramework({ rangeChapterIds: ["ch-1", "ch-2", "ch-3"] })).pacing).toBe("tight")
    })

    it("4-6 章判为 standard（标准）", () => {
      expect(autoJudgePacing(makeFramework({ rangeChapterIds: ["ch-1", "ch-2", "ch-3", "ch-4"] })).pacing).toBe("standard")
      expect(autoJudgePacing(makeFramework({ rangeChapterIds: Array.from({ length: 6 }, (_, i) => `ch-${i}`) })).pacing).toBe("standard")
    })

    it(">= 7 章判为 loose（水型）", () => {
      expect(autoJudgePacing(makeFramework({ rangeChapterIds: Array.from({ length: 7 }, (_, i) => `ch-${i}`) })).pacing).toBe("loose")
      expect(autoJudgePacing(makeFramework({ rangeChapterIds: Array.from({ length: 20 }, (_, i) => `ch-${i}`) })).pacing).toBe("loose")
    })

    it("0 章判为 tight（默认）", () => {
      expect(autoJudgePacing(makeFramework({ rangeChapterIds: [] })).pacing).toBe("tight")
    })

    it("返回 autoPacing=true", () => {
      expect(autoJudgePacing(makeFramework()).autoPacing).toBe(true)
    })
  })

  describe("applyAutoPacing", () => {
    it("对 autoPacing=true 的框架执行覆盖", () => {
      const fw = makeFramework({ pacing: "tight", autoPacing: true, rangeChapterIds: ["ch-1"] })
      const result = applyAutoPacing(fw)
      expect(result.pacing).toBe("tight")
    })

    it("用户手动校正过（autoPacing=false）的框架不被覆盖", () => {
      const fw = makeFramework({
        pacing: "loose",
        autoPacing: false,
        rangeChapterIds: ["ch-1"], // AI 会判 tight，但用户已经手动改 loose
      })
      const result = applyAutoPacing(fw)
      expect(result.pacing).toBe("loose")
      expect(result.autoPacing).toBe(false)
    })

    it("用户手动校正过但未填 pacing 的，仍按规则补全（避免空）", () => {
      const fw = makeFramework({ pacing: undefined, autoPacing: false, rangeChapterIds: ["ch-1"] })
      const result = applyAutoPacing(fw)
      expect(result.pacing).toBe("tight")
    })
  })

  describe("normalizePlotFrameworkLibrary", () => {
    it("空数组返回空库", () => {
      expect(normalizePlotFrameworkLibrary({ frameworks: [] }).frameworks).toEqual([])
    })

    it("同 id 框架去重保留 updatedAt 最新者", () => {
      const lib = normalizePlotFrameworkLibrary({
        frameworks: [
          makeFramework({ id: "fw-1", updatedAt: 1000 }),
          makeFramework({ id: "fw-1", updatedAt: 2000, title: "更新版" }),
        ],
      })
      expect(lib.frameworks).toHaveLength(1)
      expect(lib.frameworks[0].title).toBe("更新版")
    })

    it("按 createdAt 升序排序保证主线串联视图稳定", () => {
      const lib = normalizePlotFrameworkLibrary({
        frameworks: [
          makeFramework({ id: "fw-3", createdAt: 3000 }),
          makeFramework({ id: "fw-1", createdAt: 1000 }),
          makeFramework({ id: "fw-2", createdAt: 2000 }),
        ],
      })
      const ids = lib.frameworks.map((f) => f.id)
      expect(ids).toEqual(["fw-1", "fw-2", "fw-3"])
    })

    it("丢弃不完整框架（半成品不污染库）", () => {
      const lib = normalizePlotFrameworkLibrary({
        frameworks: [
          makeFramework({ id: "fw-1" }),
          makeFramework({ id: "fw-2", beats: makeBeats({ hook: "" }) }),
        ],
      })
      expect(lib.frameworks).toHaveLength(1)
      expect(lib.frameworks[0].id).toBe("fw-1")
    })

    it("emptyPlotFrameworkLibrary 返回空库", () => {
      expect(emptyPlotFrameworkLibrary().frameworks).toEqual([])
    })
  })

  describe("主线/支线筛选", () => {
    function makeLibrary(): PlotFrameworkLibrary {
      return normalizePlotFrameworkLibrary({
        frameworks: [
          makeFramework({ id: "fw-1", line: "main", createdAt: 1000 }),
          makeFramework({ id: "fw-2", line: "sub", createdAt: 2000 }),
          makeFramework({ id: "fw-3", line: "main", createdAt: 3000 }),
          makeFramework({ id: "fw-4", line: "sub", createdAt: 4000 }),
        ],
      })
    }

    it("listMainLineFrameworks 只返回主线并按时间排序", () => {
      const main = listMainLineFrameworks(makeLibrary())
      expect(main.map((f) => f.id)).toEqual(["fw-1", "fw-3"])
    })

    it("listSubLineFrameworks 只返回支线并按时间排序", () => {
      const sub = listSubLineFrameworks(makeLibrary())
      expect(sub.map((f) => f.id)).toEqual(["fw-2", "fw-4"])
    })
  })

  describe("formatPlotFrameworkForOutlinePrompt", () => {
    it("把完整剧情框架格式化为章纲生成的强约束上下文", () => {
      const context = formatPlotFrameworkForOutlinePrompt(makeFramework({
        sourceDismantlingProjectTitle: "全民转职参考书",
        prevConnector: "承接转职觉醒",
        nextConnector: "引出新手副本",
      }))

      expect(context).toContain("## 剧情框架强约束")
      expect(context).toContain("框架标题：双S转职反差爽点")
      expect(context).toContain("来源拆文：全民转职参考书")
      expect(context).toContain("### 开局钩子")
      expect(context).toContain("穿越后觉醒双S职业")
      expect(context).toContain("### 铺垫")
      expect(context).toContain("### 爽点")
      expect(context).toContain("### 结尾钩子")
      expect(context).toContain("## 涉及角色与作用")
      expect(context).toContain("男主：金手指持有者")
      expect(context).toContain("## 作者手搓留白要求")
      expect(context).toContain("爽点处适合玩梗")
      expect(context).toContain("必须按该框架生成章节细纲")
    })
  })

  describe("分支覆盖补齐（空输入/缺省回退/库去重/格式化缺省）", () => {
    it("null/undefined 框架输入返回 null", () => {
      expect(normalizePlotFramework(null)).toBeNull()
      expect(normalizePlotFramework(undefined)).toBeNull()
    })

    it("缺 id/空白 id 回退 framework- 前缀，带空格 id 会 trim", () => {
      const missing = normalizePlotFramework({ ...makeFramework(), id: undefined })
      expect(missing!.id).toMatch(/^framework-\d+$/)
      const blank = normalizePlotFramework({ ...makeFramework(), id: "   " })
      expect(blank!.id).toMatch(/^framework-\d+$/)
      const spaced = normalizePlotFramework({ ...makeFramework(), id: "  fw-x  " })
      expect(spaced!.id).toBe("fw-x")
    })

    it("缺 title 回退空字符串并由未命名兜底", () => {
      const fw = normalizePlotFramework({ ...makeFramework(), title: undefined })
      expect(fw!.title).toBe("未命名剧情框架")
    })

    it("rangeChapterIds 缺失回退空数组", () => {
      const fw = normalizePlotFramework({ ...makeFramework(), rangeChapterIds: undefined })
      expect(fw!.rangeChapterIds).toEqual([])
    })

    it("foreshadowing 缺失回退空数组，脏条目被清洗", () => {
      const missing = normalizePlotFramework({ ...makeFramework(), foreshadowing: undefined })
      expect(missing!.foreshadowing).toEqual([])
      const dirty = normalizePlotFramework({ ...makeFramework(), foreshadowing: [" 伏笔a ", "", "   ", "伏笔b"] })
      expect(dirty!.foreshadowing).toEqual(["伏笔a", "伏笔b"])
    })

    it("reusableTemplate 缺失回退空字符串", () => {
      const fw = normalizePlotFramework({ ...makeFramework(), reusableTemplate: undefined })
      expect(fw!.reusableTemplate).toBe("")
    })

    it("来源/衔接字段 present 时保留并 trim，空白回退 undefined", () => {
      const fw = normalizePlotFramework({
        ...makeFramework(),
        sourceDismantlingProjectId: "  src-1  ",
        sourceDismantlingProjectTitle: "  参考书  ",
        prevConnector: "  上承  ",
        nextConnector: "  下启  ",
      })
      expect(fw!.sourceDismantlingProjectId).toBe("src-1")
      expect(fw!.sourceDismantlingProjectTitle).toBe("参考书")
      expect(fw!.prevConnector).toBe("上承")
      expect(fw!.nextConnector).toBe("下启")
      const blank = normalizePlotFramework({
        ...makeFramework(),
        sourceDismantlingProjectId: "   ",
        sourceDismantlingProjectTitle: "   ",
        prevConnector: "   ",
        nextConnector: "   ",
      })
      expect(blank!.sourceDismantlingProjectId).toBeUndefined()
      expect(blank!.sourceDismantlingProjectTitle).toBeUndefined()
      expect(blank!.prevConnector).toBeUndefined()
      expect(blank!.nextConnector).toBeUndefined()
    })

    it("createdAt/updatedAt 缺失或 0 回退 now", () => {
      const before = Date.now()
      const fw = normalizePlotFramework({ ...makeFramework(), createdAt: undefined, updatedAt: undefined })
      expect(fw!.createdAt).toBeGreaterThanOrEqual(before)
      expect(fw!.updatedAt).toBeGreaterThanOrEqual(before)
      const zero = normalizePlotFramework({ ...makeFramework(), createdAt: 0, updatedAt: 0 })
      expect(zero!.createdAt).toBeGreaterThan(0)
      expect(zero!.updatedAt).toBeGreaterThan(0)
    })

    it("tags 去重/去空/trim，缺失回退空数组", () => {
      const fw = normalizePlotFramework({
        ...makeFramework(),
        tags: ["复仇", "  ", "", "复仇", "爽文", " 爽文 "],
      })
      expect(fw!.tags).toEqual(["复仇", "爽文"])
      expect(normalizePlotFramework({ ...makeFramework(), tags: undefined })!.tags).toEqual([])
    })

    it("characters 非数组回退空数组", () => {
      expect(normalizePlotFramework({ ...makeFramework(), characters: undefined })!.characters).toEqual([])
    })

    it("characters 对象缺 name 跳过、空 role 保留为空字符串", () => {
      const fw = normalizePlotFramework({
        ...makeFramework(),
        characters: [
          { name: "男主", role: "主角" },
          { name: "", role: "无名" },
          { name: "  ", role: "空白" },
          { name: "女主", role: "" },
        ],
      })
      expect(fw!.characters).toEqual([
        { name: "男主", role: "主角" },
        { name: "女主", role: "" },
      ])
    })

    it("beats 缺失时整个框架被丢弃", () => {
      expect(normalizePlotFramework({ ...makeFramework(), beats: undefined })).toBeNull()
    })

    it("library null/undefined/空对象/缺 frameworks 返回空库", () => {
      expect(normalizePlotFrameworkLibrary(null).frameworks).toEqual([])
      expect(normalizePlotFrameworkLibrary(undefined).frameworks).toEqual([])
      expect(normalizePlotFrameworkLibrary({}).frameworks).toEqual([])
      expect(normalizePlotFrameworkLibrary({ frameworks: undefined }).frameworks).toEqual([])
    })

    it("library 同 id 保留 updatedAt 最新者（旧版后到被忽略）", () => {
      const lib = normalizePlotFrameworkLibrary({
        frameworks: [
          makeFramework({ id: "fw-1", updatedAt: 2000, title: "新版" }),
          makeFramework({ id: "fw-1", updatedAt: 1000, title: "旧版" }),
        ],
      })
      expect(lib.frameworks).toHaveLength(1)
      expect(lib.frameworks[0].title).toBe("新版")
    })

    it("library createdAt 相同时按 id 排序保证稳定", () => {
      const lib = normalizePlotFrameworkLibrary({
        frameworks: [
          makeFramework({ id: "fw-b", createdAt: 1000 }),
          makeFramework({ id: "fw-a", createdAt: 1000 }),
        ],
      })
      expect(lib.frameworks.map((f) => f.id)).toEqual(["fw-a", "fw-b"])
    })

    it("isPlotFrameworkComplete 对空白段返回 false", () => {
      const fw = makeFramework()
      expect(isPlotFrameworkComplete(fw)).toBe(true)
      expect(isPlotFrameworkComplete({ ...fw, beats: { ...fw.beats, hook: "  " } })).toBe(false)
    })

    it("格式化支线且缺省可选字段时不输出对应段落、手工留白回退默认文案", () => {
      const context = formatPlotFrameworkForOutlinePrompt(makeFramework({
        line: "sub",
        sourceDismantlingProjectTitle: undefined,
        reusableTemplate: "",
        prevConnector: undefined,
        nextConnector: undefined,
        characters: [],
        directionHints: "",
        handcraftHints: "",
      }))
      expect(context).toContain("归属：支线")
      expect(context).not.toContain("来源拆文")
      expect(context).not.toContain("一句话可复用模板")
      expect(context).not.toContain("与上一框架衔接")
      expect(context).not.toContain("与下一框架衔接")
      expect(context).not.toContain("## 涉及角色与作用")
      expect(context).not.toContain("## 方向指引")
      expect(context).toContain("必须明确标注哪些内容交给作者")
    })

    it("格式化角色无 role 时不带冒号", () => {
      const context = formatPlotFrameworkForOutlinePrompt(makeFramework({
        characters: [{ name: "路人", role: "" }],
      }))
      expect(context).toContain("- 路人")
      expect(context).not.toContain("路人：")
    })
  })
})
