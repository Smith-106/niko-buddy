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
