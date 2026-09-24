import { describe, expect, it } from "vitest"
import { checkFinaleVolumeDiscipline, runVolumeOutlineQualityCheck } from "./outline-quality-check"

const ORDINARY_VOLUME = [
  "## 本卷目标",
  "本卷主角深入黑市，失去线人。",
  "## 爽点节奏",
  "三章一小爽，五章一大爽。",
  "## 情绪弧线",
  "压抑转扬眉。",
  "## 人物弧线",
  "主角学会信任。",
  "## 伏笔布局",
  "| ID | 内容 | 优先级 | 预计回收时机 |",
  "| F1 | 玉佩 | 高 | 第 8 章 |",
  "## 关键反转",
  "线人竟是内鬼。",
].join("\n")

const FINALE_CLEAN = [
  "## 本卷目标",
  "收官卷（final: true）：收束全部长线，终局兑现。",
  "## 爽点节奏",
  "决战三连爽。",
  "## 情绪弧线",
  "悲壮转释然。",
  "## 人物弧线",
  "主角完成抉择，配角尘埃落定。",
  "## 伏笔布局",
  "| ID | 内容 | 优先级 | 预计回收时机 |",
  "| F1 | 玉佩 | 高 | 第 2 章回收 |",
  "## 关键反转",
  "终局落幕，所有长线收束完结。",
].join("\n")

describe("checkFinaleVolumeDiscipline 收官卷纪律（§GAP-89-01）", () => {
  it("普通卷恒 pass（零误伤）", () => {
    const r = checkFinaleVolumeDiscipline(ORDINARY_VOLUME)
    expect(r.status).toBe("pass")
  })

  it("收官卷埋新钩子 → error", () => {
    const r = checkFinaleVolumeDiscipline(`${FINALE_CLEAN}\n新埋伏笔：神秘人再现，后续再议。`)
    expect(r.status).toBe("error")
    expect(r.details?.join("")).toContain("新钩子")
  })

  it("收官卷无回收分配 → warn", () => {
    const strip = (s: string, pairs: Array<[string, string]>) =>
      pairs.reduce((acc, [from, to]) => acc.split(from).join(to), s)
    const noRecycle = strip(FINALE_CLEAN, [["回收", "推进"], ["收束", "发展"], ["完结", "继续"], ["落幕", "开启"], ["终局", "开局"], ["尘埃落定", "各归其位"]])
    const r = checkFinaleVolumeDiscipline(noRecycle)
    expect(r.status).toBe("warn")
  })

  it("干净收官卷 → pass", () => {
    const r = checkFinaleVolumeDiscipline(FINALE_CLEAN)
    expect(r.status).toBe("pass")
  })
})

describe("runVolumeOutlineQualityCheck 集成收官检查", () => {
  it("普通卷结果含收官卷纪律 pass 项", () => {
    const items = runVolumeOutlineQualityCheck(ORDINARY_VOLUME)
    const finale = items.find((i) => i.category === "收官卷纪律")
    expect(finale?.status).toBe("pass")
  })

  it("埋新钩子的收官卷在卷纲全量检查中 error", () => {
    const items = runVolumeOutlineQualityCheck(`${FINALE_CLEAN}\n新增长线：海外篇敬请期待。`)
    const finale = items.find((i) => i.category === "收官卷纪律")
    expect(finale?.status).toBe("error")
  })
})
