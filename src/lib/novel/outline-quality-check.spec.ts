/** C4 冒烟覆盖：src/lib/novel/outline-quality-check.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { runVolumeOutlineQualityCheck, runChapterOutlineQualityCheck, summarizeChapterOutlineQuality, isLikelyChapterOutline, extractChapterOutlineStatus, checkFinaleVolumeDiscipline, formatOutlineQualityReport } from "./outline-quality-check"
describe("outline-quality-check.ts smoke", () => {
  it("exports runVolumeOutlineQualityCheck", () => {
    expect(runVolumeOutlineQualityCheck).toBeDefined()
  })
  it("exports runChapterOutlineQualityCheck", () => {
    expect(runChapterOutlineQualityCheck).toBeDefined()
  })
  it("exports summarizeChapterOutlineQuality", () => {
    expect(summarizeChapterOutlineQuality).toBeDefined()
  })
  it("exports isLikelyChapterOutline", () => {
    expect(isLikelyChapterOutline).toBeDefined()
  })
  it("exports extractChapterOutlineStatus", () => {
    expect(extractChapterOutlineStatus).toBeDefined()
  })
  it("exports checkFinaleVolumeDiscipline", () => {
    expect(checkFinaleVolumeDiscipline).toBeDefined()
  })

  it("names the missing volume headings", () => {
    const report = formatOutlineQualityReport("# 总大纲\n没有卷字段", "volume")
    expect(report).toContain("大纲审核：有缺项。")
    expect(report).toContain("本卷目标")
  })

  it("names missing chapter sections", () => {
    const report = formatOutlineQualityReport("# 章节细纲\n只有标题", "chapter")
    expect(report).toContain("章纲审核：有缺项。")
    expect(report).toContain("本章目标")
  })
})

describe("章纲钩子与爽点：标题存在但内容空壳", () => {
  const buildOutline = (enjoymentBody: string, hookBody: string) => [
    "## 章首钩子",
    "开篇第一屏：契约到期通知弹出，倒计时开始。",
    "## 爽点设计",
    enjoymentBody,
    "## 章尾钩子",
    hookBody,
  ].join("\n")

  it("只剩字段名没有内容 → warn（不阻断保存）", () => {
    const items = runChapterOutlineQualityCheck(
      buildOutline("- 本章核心爽点：\n- 爽点铺垫：\n- 爽点兑现方式：", "- 结尾落点：\n- 悬念或反转："),
    )
    const hooks = items.find((item) => item.category === "钩子与爽点")!
    expect(hooks.status).toBe("warn")
    expect(hooks.details?.join()).toContain("具体压迫源")
  })

  it("只剩套话 → warn", () => {
    const items = runChapterOutlineQualityCheck(buildOutline("- 本章核心爽点：有爽点", "- 结尾落点：留下悬念"))
    const hooks = items.find((item) => item.category === "钩子与爽点")!
    expect(hooks.status).toBe("warn")
  })

  it("写出可指认内容 → pass", () => {
    const items = runChapterOutlineQualityCheck(
      buildOutline(
        "- 本章核心爽点：白曦用“到账即还款”条款反将周砚一军，围观租体者第一次看到公司吃瘪\n- 爽点兑现方式：周砚被迫签字，灵压反噬回到他身上",
        "- 结尾落点：周砚递来补充协议，条款里写着白曦母亲的名字，下一章必须查清担保链",
      ),
    )
    const hooks = items.find((item) => item.category === "钩子与爽点")!
    expect(hooks.status).toBe("pass")
  })

  it("整节缺失仍是 error（空壳只是降级为 warn）", () => {
    const items = runChapterOutlineQualityCheck("## 章首钩子\n开篇有钩子。")
    const hooks = items.find((item) => item.category === "钩子与爽点")!
    expect(hooks.status).toBe("error")
  })
})

describe("isLikelyChapterOutline", () => {
  it("内容含章纲关键词时判定为章纲", () => {
    expect(isLikelyChapterOutline("## 本章目标\n推进主线")).toBe(true)
  })

  it("内容无关但文件名带「细纲」时也判定为章纲", () => {
    expect(isLikelyChapterOutline("随便写点东西", "第3章细纲.md")).toBe(true)
  })

  it("内容与文件名都无关时返回 false", () => {
    expect(isLikelyChapterOutline("## 卷纲\n本卷目标：打完这一仗", "第一卷.md")).toBe(false)
  })
})

describe("extractChapterOutlineStatus", () => {
  it("解析出三种已知状态", () => {
    expect(extractChapterOutlineStatus("当前状态：已确认")).toBe("已确认")
    expect(extractChapterOutlineStatus("当前状态: 草稿")).toBe("草稿")
    expect(extractChapterOutlineStatus("当前状态：需修改")).toBe("需修改")
  })

  it("没有状态行时返回未知", () => {
    expect(extractChapterOutlineStatus("## 本章目标\n无状态标记")).toBe("未知")
  })

  it("状态值不在枚举内时也返回未知，不猜", () => {
    expect(extractChapterOutlineStatus("当前状态：写了一半")).toBe("未知")
  })
})

describe("summarizeChapterOutlineQuality", () => {
  it("空内容时 valid 为 false，errors 非空，items 覆盖全部章纲规则", () => {
    const summary = summarizeChapterOutlineQuality("")
    expect(summary.valid).toBe(false)
    expect(summary.errors.length).toBeGreaterThan(0)
    expect(summary.items).toHaveLength(10)
  })

  it("errors/warnings 都来自 items 的 details，没有 details 时回落到 message", () => {
    const summary = summarizeChapterOutlineQuality("")
    const errorItems = summary.items.filter((i) => i.status === "error")
    const expected = errorItems.flatMap((i) => (i.details?.length ? i.details : [i.message]))
    expect(summary.errors).toEqual(expected)
  })

  it("valid 与 errors 长度严格一致（有错误即不通过）", () => {
    const summary = summarizeChapterOutlineQuality("")
    expect(summary.valid).toBe(summary.errors.length === 0)
  })
})

describe("formatOutlineQualityReport", () => {
  it("章纲有缺项时输出标题 + 逐条问题", () => {
    const report = formatOutlineQualityReport("", "chapter")
    expect(report.startsWith("章纲审核：有缺项。")).toBe(true)
    expect(report).toContain("\n- ")
  })

  it("卷纲有缺项时用「大纲审核」标题", () => {
    const report = formatOutlineQualityReport("", "volume")
    expect(report.startsWith("大纲审核：有缺项。")).toBe(true)
  })

  it("问题项带 details 时逐条缩进列出", () => {
    const report = formatOutlineQualityReport("", "chapter")
    // 至少有一个规则返回 details（例如缺失章节清单），缩进两格
    expect(report).toMatch(/\n {2}- /)
  })
})

describe("runVolumeOutlineQualityCheck", () => {
  it("没有定位分布表时给出 warn 并跳过章节级检查", () => {
    const items = runVolumeOutlineQualityCheck("## 本卷目标\n打一场硬仗")
    const item = items.find((i) => i.category === "章节定位分布")
    expect(item?.status).toBe("warn")
    expect(item?.message).toContain("未解析到章节定位分布表")
  })

  it("结果恒为数组且每项都有 category/status/message", () => {
    for (const item of runVolumeOutlineQualityCheck("")) {
      expect(typeof item.category).toBe("string")
      expect(["pass", "warn", "error"]).toContain(item.status)
      expect(typeof item.message).toBe("string")
    }
  })
})

/**
 * 全项合规的章纲样本：15 个必填章节齐备，且各规则要求的字段与条数都满足。
 * 目的是让 10 条章纲规则全部走 pass 分支（现有用例此前只覆盖了失败分支）。
 */
const VALID_CHAPTER_OUTLINE = `## 基础信息
时间锚点：深秋傍晚，宗门大比前三日
章内时间跨度：两个时辰
与上章时间差：一日

## 上层依据
卷纲第 3 节点：主角首次公开对抗执事层

## 本章目标
当众拆穿执事贪墨，夺回被扣灵石份额

## 核心事件
事件1：事件内容：主角翻出账册；事件作用：立起对抗动机；涉及人物：主角、执事；因果关系：灵石短缺；必须写出的细节：账册边角的墨迹
事件2：事件内容：执事否认；事件作用：抬高冲突；涉及人物：主角、执事；因果关系：当众对峙；必须写出的细节：围观弟子的低语
事件3：事件内容：主角出示第二本账；事件作用：坐实贪墨；涉及人物：主角、执事；因果关系：证据闭环；必须写出的细节：账本封皮的火漆
事件4：事件内容：长老到场；事件作用：引入更高压力；涉及人物：长老、执事；因果关系：事态升级；必须写出的细节：长老袖口的旧纹样
事件5：事件内容：灵石份额当场归还；事件作用：兑现爽点；涉及人物：主角、众弟子；因果关系：证据成立；必须写出的细节：灵石碰撞声
事件6：事件内容：主角收起铜牌；事件作用：埋下长线；涉及人物：主角；因果关系：铜牌与信使同款；必须写出的细节：铜牌边缘的磨损

## 场景顺序
### 场景1
场景地点：宗门演武场东侧账房
出场人物：主角、执事、两名杂役
场景目标：拿到账册
冲突点：执事阻拦
关键动作：主角翻检木箱
关键对白：你凭什么查我
情绪变化：克制的怒意
必须出现的信息：灵石短缺的数目
禁止偏离：不得提前暴露铜牌
### 场景2
场景地点：演武场中央高台
出场人物：主角、执事、长老、众弟子
场景目标：当众坐实贪墨
冲突点：长老试图压事
关键动作：主角举起第二本账
关键对白：火漆是谁的
情绪变化：从紧绷到释放
必须出现的信息：份额归还的具体数字
禁止偏离：不得让长老直接倒向主角

## 结构节点
CBN：主角在账房拿到账册
CPNs：执事否认→出示第二本账→长老到场
CEN：份额归还，主角收起铜牌

## 章首钩子
章首钩子：主角在木箱夹层里摸到一本被虫蛀过的旧账，扉页上写着执事的私印。

## 爽点设计
本章核心爽点：主角在宗门前当众拆穿执事的贪墨账目，把压迫源从暗处拖到明处，并当场夺回被扣下的灵石份额。

## 章尾钩子
章尾钩子：执事背后那枚刻着旧朝纹样的铜牌被主角悄悄收起，而山下已有信使带着同款铜牌启程。

## 执行约束
必须覆盖节点：账册到手、当众对质、份额归还
本章禁区：不得让长老在本章内改变立场

## 人物状态
主角状态：由隐忍转为公开对抗
关键配角状态：执事从有恃无恐转为慌乱
反派/阻力方状态：长老仍在观望
人物关系变化：众弟子对主角的态度松动
本章后人物认知变化：主角确认铜牌牵涉更大的势力

## 伏笔与追踪
本章无新增伏笔

## 待写回设定
执事私印、旧朝铜牌

## 写作约束
必须遵守：账册与铜牌的细节描写
不允许改变：执事的既有身份
不允许出现：主角提前知道信使的存在

## AI写作提示
严格遵循本章纲，不得自行改写节点顺序
`

describe("全项合规章纲：10 条章纲规则全部走 pass 分支", () => {
  it("runChapterOutlineQualityCheck 返回 10 项且全部 pass", () => {
    const items = runChapterOutlineQualityCheck(VALID_CHAPTER_OUTLINE)
    expect(items).toHaveLength(10)
    const notPass = items
      .filter((i) => i.status !== "pass")
      .map((i) => `${i.category}：${i.message}｜${(i.details ?? []).join(" / ")}`)
    expect(notPass).toEqual([])
  })

  it("summarizeChapterOutlineQuality 给出 valid=true 且无 errors/warnings", () => {
    const summary = summarizeChapterOutlineQuality(VALID_CHAPTER_OUTLINE)
    expect(summary.valid).toBe(true)
    expect(summary.errors).toEqual([])
    expect(summary.warnings).toEqual([])
    expect(summary.items).toHaveLength(10)
  })

  it("formatOutlineQualityReport 对合规章纲只输出一句通过结论", () => {
    expect(formatOutlineQualityReport(VALID_CHAPTER_OUTLINE, "chapter")).toBe("章纲审核：通过。")
  })

  it("isLikelyChapterOutline 对该章纲判定为 true", () => {
    expect(isLikelyChapterOutline(VALID_CHAPTER_OUTLINE)).toBe(true)
  })
})

/**
 * 卷纲侧规则 pass 分支：20 章合规卷纲。
 * 类型配比紧贴 DEFAULT_SHOUWEN_BASELINE（开场2/发展7/铺垫5/转折2/高潮3/收束1），
 * 高压 25%（≤30%）、收束 5%（≤10%）、各类型偏差 ≤5%，且无连续 3 章同类型。
 */
const VOLUME_POSITION_ROWS = [
  "| 1 | 开场 | 2 | 6 | 楔子：夜市初见 |",
  "| 2 | 发展 | 2 | 5 | 查账起疑 |",
  "| 3 | 铺垫 | 3 | 6 | 旧案重提 |",
  "| 4 | 转折 | 3 | 7 | 线人灭口 |",
  "| 5 | 发展 | 2 | 5 | 按下不表 |",
  "| 6 | 铺垫 | 3 | 6 | 铜牌现身 |",
  "| 7 | 高潮 | 4 | 8 | 当众对质 |",
  "| 8 | 发展 | 3 | 6 | 余波回响 |",
  "| 9 | 铺垫 | 3 | 6 | 火漆比对 |",
  "| 10 | 发展 | 2 | 5 | 暗访账房 |",
  "| 11 | 开场 | 2 | 5 | 分线开场 |",
  "| 12 | 转折 | 4 | 7 | 第二本账 |",
  "| 13 | 铺垫 | 3 | 6 | 长老施压 |",
  "| 14 | 高潮 | 5 | 9 | 祠堂对簿 |",
  "| 15 | 发展 | 3 | 6 | 份额归还 |",
  "| 16 | 铺垫 | 3 | 6 | 信使南下 |",
  "| 17 | 发展 | 3 | 6 | 整军备战 |",
  "| 18 | 高潮 | 5 | 9 | 擂台约战 |",
  "| 19 | 发展 | 2 | 5 | 战后清点 |",
  "| 20 | 收束 | 1 | 4 | 卷尾落子 |",
]

const VOLUME_FULL = [
  "## 本卷目标",
  "主角查到线人被灭口的线索，决定收网。本卷以收束旧案、兑现承诺为核心，卷尾以悬念钩子承接下一卷。",
  "## 爽点节奏",
  "爽点节奏表：三章一小爽，七章一大爽（高潮章兑现），开篇钩子先行。",
  "## 情绪弧线",
  "情绪弧线呈W形：起点压抑→中段下降触底→强势回升→再降→最终回升，情绪强度逐级上升。",
  "1/4 节点、中点、3/4 节点处各设情绪强度与压力级标注，开篇设悬念钩子，结尾收束并留下伏笔。",
  "## 人物弧线",
  "主角由隐忍转向公开对抗，配角由观望转为站队。",
  "## 伏笔布局",
  "| ID | 内容 | 优先级 | 预计回收时机 |",
  "| --- | --- | --- | --- |",
  "| F1 | 旧朝铜牌的来历 | 高 | 第18章回收 |",
  "| F2 | 账房第二本账 | 中 | 第14章回收 |",
  "## 关键反转",
  "线人竟是内鬼，账本火漆与铜牌同源。",
  "## 章节定位",
  "| 章 | 定位 | 压力级(1-5) | 情绪强度(1-10) | 说明 |",
  "| --- | --- | --- | --- | --- |",
  ...VOLUME_POSITION_ROWS,
].join("\n")

describe("卷纲侧规则 pass 分支（20 章合规卷纲）", () => {
  it("必填/八节点/情绪弧线/定位分布/相邻情绪/伏笔回收/收官纪律全部 pass", () => {
    const items = runVolumeOutlineQualityCheck(VOLUME_FULL)
    const byCategory = new Map(items.map((i) => [i.category, i]))
    for (const category of ["卷纲必填项", "八节点结构", "情绪弧线", "章节定位分布", "相邻章情绪", "伏笔回收", "收官卷纪律"]) {
      expect(byCategory.get(category)?.status, category).toBe("pass")
    }
    expect(byCategory.get("伏笔回收")?.message).toBe("所有伏笔均有回收计划")
    expect(byCategory.get("收官卷纪律")?.message).toContain("非收官卷")
  })

  it("合规卷纲下爽点节律仍 warn：每 3 章一冲突与高压 ≤30% 在此配比下互斥", () => {
    const item = runVolumeOutlineQualityCheck(VOLUME_FULL).find((i) => i.category === "爽点节律")
    expect(item?.status).toBe("warn")
    expect(item?.details?.length).toBeGreaterThan(0)
  })
})

describe("卷纲侧规则 pass 分支（精干 4 章卷纲）", () => {
  const LEAN_VOLUME = [
    "| 章 | 定位 | 压力级(1-5) | 情绪强度(1-10) | 说明 |",
    "| --- | --- | --- | --- | --- |",
    "| 1 | 开场 | 2 | 5 | 楔子 |",
    "| 2 | 转折 | 3 | 7 | 变故 |",
    "| 3 | 发展 | 2 | 5 | 缓冲 |",
    "| 4 | 高潮 | 5 | 9 | 决战 |",
  ].join("\n")

  it("爽点节律与相邻章情绪 pass（每 3 章窗都有转折/高潮、无同类型三连）", () => {
    const items = runVolumeOutlineQualityCheck(LEAN_VOLUME)
    const byCategory = new Map(items.map((i) => [i.category, i]))
    expect(byCategory.get("爽点节律")?.status).toBe("pass")
    expect(byCategory.get("相邻章情绪")?.status).toBe("pass")
    expect(byCategory.get("伏笔回收")?.message).toBe("未检测到伏笔记录")
  })

  it("高压 50% 的代价：同一样本下章节定位分布 warn", () => {
    const item = runVolumeOutlineQualityCheck(LEAN_VOLUME).find((i) => i.category === "章节定位分布")
    expect(item?.status).toBe("warn")
    expect(item?.details?.join("")).toContain("高压章")
  })
})

describe("相邻章情绪扎堆 warn", () => {
  it("连续 3 章同类型且情绪都 >7 → warn 并点名章节", () => {
    const content = [
      "| 章 | 定位 | 压力级(1-5) | 情绪强度(1-10) | 说明 |",
      "| --- | --- | --- | --- | --- |",
      "| 1 | 发展 | 2 | 5 | 缓冲 |",
      "| 2 | 高潮 | 4 | 8 | 激战 |",
      "| 3 | 高潮 | 5 | 9 | 决战 |",
      "| 4 | 高潮 | 4 | 8 | 余烬 |",
      "| 5 | 收束 | 1 | 3 | 收尾 |",
    ].join("\n")
    const item = runVolumeOutlineQualityCheck(content).find((i) => i.category === "相邻章情绪")
    expect(item?.status).toBe("warn")
    expect(item?.message).toBe("发现 1 处扎堆")
    expect(item?.details?.join("")).toContain("第2、3、4章")
  })
})

describe("卷纲伏笔缺少回收计划 warn", () => {
  it("回收时机为空或占位 → warn 并点名伏笔", () => {
    const content = [
      "## 伏笔布局",
      "| ID | 内容 | 优先级 | 预计回收时机 |",
      "| --- | --- | --- | --- |",
      "| F1 | 旧朝铜牌的来历 | 高 | 第18章回收 |",
      "| F2 | 账房第二本账 | 中 | [待定] |",
      "| F3 | 山下信使 | 低 |",
    ].join("\n")
    const item = runVolumeOutlineQualityCheck(content).find((i) => i.category === "伏笔回收")!
    expect(item.status).toBe("warn")
    expect(item.message).toContain("2 条伏笔缺少回收计划")
    expect(item.details?.join("")).toContain("F2")
    expect(item.details?.join("")).toContain("F3")
  })
})

describe("章纲伏笔含糊其辞 warn", () => {
  it("有伏笔章节但既无明确说明又无字段 → warn", () => {
    const items = runChapterOutlineQualityCheck(
      ["## 伏笔与追踪", "本章有一个重要伏笔，后面会交代。"].join("\n"),
    )
    const item = items.find((i) => i.category === "伏笔与追踪")!
    expect(item.status).toBe("warn")
    expect(item.message).toBe("伏笔处理不明确")
  })
})
