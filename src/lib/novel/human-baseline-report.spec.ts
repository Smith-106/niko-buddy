/**
 * T1 人类基线校准报告（只报告不动阈值，Track B soft）。
 *
 * 背景（人类侧缺口清单，来源：de-ai-calibration.spec.ts + anti-ai-seeds.generated.json 60 条）：
 *   GAP-1 合成人声：human 30 条 layer=human-simulated，source 全为 synthetic-degraded，
 *         无真实人类作者文本，human 分布 = “合成降质的人仿”，非人类基线。
 *   GAP-2 文体窄：human 侧只有 gufeng/xuanhuan/yanqing 网文开场 3 类，无文言/翻译腔/
 *         现实题材/非虚构，风格盲区大。
 *   GAP-3 篇幅窄：human 字数 670-774（中位 ~716），无短章/长章，密度分母保底 500
 *         掩盖了短文本行为，生产 2-5K 章节无覆盖。
 *   GAP-4 单批次：batchIds 仅 20260821-001 一批，无跨时/跨源/跨标注者，holdout 只是
 *         同批内切分（seed=42 分层 80/20），无跨批泛化证据。
 *   GAP-5 零真实语料：36 号《8人》6 章为外部一次性脚本标定、未进仓；本仓内可复现的
 *         human 基线仍是 0。
 *
 * 本文件对策：内嵌 4 段人类风格样例（文言/白话叙事/白话对白/翻译腔，直接当 fixture），
 * 用现有纯函数 scorer（runDeAiSelfCheck / statisticalFingerprint / slopScore /
 * overCorrectionReport，零 LLM/IO）跑出每维分数分布，console 即报告，并以硬断言区间
 * 锁定当前人类基线快照。scoreSyntax 未导出（de-ai-selfcheck 内部函数），本文件以
 * runDeAiSelfCheck 的“句式”维 + statisticalFingerprint 直接覆盖，不重复实现。
 *
 * 纪律：不动任何阈值/权重（SLOP_CLASSIFY_* / SELFCHECK_PASS_THRESHOLD /
 * CAVITY_* / SELFCHECK_WEIGHTS 只读引用）。数据来源待补：真实 ≥100+100 语料落地后
 * 须增量重标定，本快照仅为 synthetic-human 风格探针，非产品 anti-AI 宣称依据。
 */
import { describe, expect, it } from "vitest"
import { runDeAiSelfCheck, SELFCHECK_PASS_THRESHOLD } from "./de-ai-selfcheck"
import { statisticalFingerprint } from "./mechanical-fingerprint"
import {
  slopScore,
  classifySlop,
  overCorrectionReport,
  SLOP_CLASSIFY_WARN_THRESHOLD,
  CAVITY_CV_LOW,
  CAVITY_CV_HIGH,
  CAVITY_FILLER_PER_1000,
} from "./mechanical-slop-detector"
import { valueAtPercentile } from "./de-ai-percentile"

type HumanStyle = "文言" | "白话" | "翻译腔"

interface HumanBaselineSample {
  readonly name: string
  readonly style: HumanStyle
  readonly text: string
}

/**
 * 内嵌人类风格样例（fixture 自撰，非出版物摘录，无版权文本）。
 * 写作约束：避开 TIER1/2/3 已知中文 slop 触发串与 cavity 补漏模式
 * （总结腔/解释腔/模板句首/转折连用/顿号三连/假口语填充词），以便探针测的是
 * “干净人类叙事”的基线，而非词库命中。
 */
const HUMAN_SAMPLES: readonly HumanBaselineSample[] = [
  {
    name: "wenyan-garden",
    style: "文言",
    text: [
      "秋雨初歇，檐下残滴时断时续。沈砚推窗而望，庭中梧桐落叶满径，青石缝里渗出薄薄水光。",
      "",
      "老仆提灯而来，步履迟缓，灯罩上糊着去年除夕新换的纱。他立在阶下，低声禀报庄上秋租已收齐，只余东坡三户因雹灾欠了半成。",
      "",
      "沈砚披衣下楼，取过账册，就着灯火逐页翻看。册页边角卷起，墨字间夹着几片干枯桂瓣，应是收租时不慎带入。",
      "",
      "他沉吟片刻，提笔在东坡三户名下各勾一笔，准其以柴炭抵租。老仆躬身应诺，提灯退入雨雾深处。",
      "",
      "窗外蛙鸣渐起，沈砚独坐灯前，听更鼓传过三重院落，方吹灭烛火，就榻而眠。",
    ].join("\n"),
  },
  {
    name: "baihua-alley",
    style: "白话",
    text: [
      "清晨六点半，菜场的卷帘门哗啦啦升起一半。陈阿婆把昨夜摘的空心菜码齐，菜叶上还挂着水珠，绿得晃眼。",
      "",
      "她对面的肉摊换了新伙计，年轻人围裙系得歪歪扭扭，切肉时手腕发紧，刀落下去总偏三分。陈阿婆看不下去，走过去替他把磨刀石摆正，教他手肘抵住案板发力。",
      "",
      "九点刚过，雨点砸下来，买菜的人挤进棚里。雨水顺着棚沿连成线，落在青菜叶子上，溅起细小的泥点。年轻人学着陈阿婆的样子，把最嫩的几把菜往里挪了挪。",
      "",
      "收摊时他数了数钱，零钱多出五块，追出半条巷子还给一位老伯。回头见陈阿婆在笑，他挠挠头，也跟着笑起来，露出一颗缺角的门牙。",
    ].join("\n"),
  },
  {
    name: "baihua-dialogue",
    style: "白话",
    text: [
      "林晚把帆布包放在桌上，拉链敞开一角，露出里面卷边的稿纸。她抬头问：“房东说下周要涨租，你这边有消息吗？”",
      "",
      "周屿把手里的扳手放下，用抹布擦了擦指缝里的机油：“上午他在楼下和人提过一句，我没接话。你先别急，我去问问隔壁栋的刘姐。”",
      "",
      "“刘姐上周就搬走了。”林晚把稿纸摊开，“你看这段，我改了三遍还是不顺，你帮我读一遍。”",
      "",
      "周屿接过稿纸，清了清嗓子，读得很慢，遇到标点就停一下。读到一半他停住，指着一行字说：“这里断句有问题，主语换了，读者会跟丢。”",
      "",
      "窗外有人卖糖炒栗子，叫卖声穿过楼道。林晚笑起来：“先记下，晚上买一包，你一半我一半。”",
    ].join("\n"),
  },
  {
    name: "translation-letter",
    style: "翻译腔",
    text: [
      "玛尔塔在十月末写给哥哥的信里提到，港口的雾比往年更早地漫了进来，渡船的时间表因此被改写了两次。她把这件事记在日历边缘，字迹被海水般的潮气洇开一小块。",
      "",
      "她租住的阁楼在面包房楼上，每天清晨，烤炉的暖气先于日光抵达她的地板。她学会了在暖气到来之前起床，把前一晚泡好的燕麦煮开，再配着读完报纸的社会版。",
      "",
      "信的后半部分，她谈到了一位邻居，一位退休的灯塔看守人。他每周三下午来借书，归还时总在扉页夹一张手写的纸条，上面记着他对结局的异议。玛尔塔起初不同意他的看法，后来逐渐发现，这些纸条让她重读时多了另一双眼睛。",
      "",
      "十一月的第一场雨落下时，她把信装进信封，在封口处贴了一枚灯塔图案的邮票。她在日记里写道，雾会散去，渡船会准时，冬天也会像往年那样，带着松枝的气味到来。",
    ].join("\n"),
  },
]

function quantiles(values: readonly number[]): { p5: number; p50: number; p95: number } {
  return {
    p5: valueAtPercentile(values, 5),
    p50: valueAtPercentile(values, 50),
    p95: valueAtPercentile(values, 95),
  }
}

function reportLine(label: string, vals: readonly number[]): string {
  const q = quantiles(vals)
  return `${label.padEnd(28)} n=${String(vals.length).padStart(2)}  P5=${q.p5.toFixed(3).padStart(7)}  P50=${q.p50.toFixed(3).padStart(7)}  P95=${q.p95.toFixed(3).padStart(7)}`
}

describe("T1 人类基线校准报告（内嵌 4 段，只报告不动阈值）", () => {
  it("fixture 完整性：4 段三风格齐全，正文非空且具篇幅", () => {
    expect(HUMAN_SAMPLES.length).toBe(4)
    const styles = HUMAN_SAMPLES.map((s) => s.style)
    expect(styles).toContain("文言")
    expect(styles.filter((s) => s === "白话").length).toBe(2)
    expect(styles).toContain("翻译腔")
    for (const s of HUMAN_SAMPLES) {
      expect(s.text.length).toBeGreaterThan(200)
      expect(s.text.split(/\n+/).filter((p) => p.trim().length > 0).length).toBeGreaterThanOrEqual(4)
    }
  })

  it("分布报告：4 段 × selfcheck 7 维/slop/fingerprint/cavity（console 即报告）", () => {
    const overalls = HUMAN_SAMPLES.map((s) => runDeAiSelfCheck(s.text, s.text).overall)
    const slops = HUMAN_SAMPLES.map((s) => slopScore(s.text).slopPenalty)
    const fps = HUMAN_SAMPLES.map((s) => statisticalFingerprint(s.text).score)
    const cvs = HUMAN_SAMPLES.map((s) => overCorrectionReport(s.text).sentenceLengthCV)
    const fillers = HUMAN_SAMPLES.map((s) => overCorrectionReport(s.text).fillerDensityPer1000)
    const dimNames = ["词汇", "句式", "对白", "叙事", "心理", "场景", "节奏"] as const
    const dimSeries: Record<(typeof dimNames)[number], number[]> = {
      "词汇": [],
      "句式": [],
      "对白": [],
      "叙事": [],
      "心理": [],
      "场景": [],
      "节奏": [],
    }
    for (const s of HUMAN_SAMPLES) {
      const r = runDeAiSelfCheck(s.text, s.text)
      for (const d of r.dimensions) {
        dimSeries[d.dimension].push(d.score)
      }
    }

    // eslint-disable-next-line no-console
    console.log("\n[T1 human-baseline] 内嵌 4 段（文言1/白话2/翻译腔1，自撰 fixture，非出版物摘录）\n")
    for (const s of HUMAN_SAMPLES) {
      const r = runDeAiSelfCheck(s.text, s.text)
      const dims = r.dimensions.map((d) => `${d.dimension}${(d.score * 100).toFixed(0)}`).join(" ")
      // eslint-disable-next-line no-console
      console.log(`- ${s.name}(${s.style}) overall=${r.overall.toFixed(2)} ${r.verdict} | ${dims} | slop=${slopScore(s.text).slopPenalty.toFixed(1)} fp=${statisticalFingerprint(s.text).score.toFixed(2)}`)
    }
    // eslint-disable-next-line no-console
    console.log(reportLine("overall", overalls))
    // eslint-disable-next-line no-console
    console.log(reportLine("slopPenalty", slops))
    // eslint-disable-next-line no-console
    console.log(reportLine("fingerprint score", fps))
    // eslint-disable-next-line no-console
    console.log(reportLine("cavity CV", cvs))
    // eslint-disable-next-line no-console
    console.log(reportLine("cavity filler/1k", fillers))
    for (const n of dimNames) {
      // eslint-disable-next-line no-console
      console.log(reportLine(`dim ${n}`, dimSeries[n]))
    }
    expect(true).toBe(true)
  })

  it("基线快照：4 段全部 clean 且 selfcheck PASS（零误杀，阈值只读引用）", () => {
    for (const s of HUMAN_SAMPLES) {
      expect(classifySlop(slopScore(s.text))).toBe("clean")
      expect(slopScore(s.text).slopPenalty).toBeLessThan(SLOP_CLASSIFY_WARN_THRESHOLD)
    }
    for (const s of HUMAN_SAMPLES) {
      const r = runDeAiSelfCheck(s.text, s.text)
      expect(r.verdict).toBe("PASS")
      expect(r.overall).toBeGreaterThanOrEqual(SELFCHECK_PASS_THRESHOLD)
      expect(r.dimensions.length).toBe(7)
      for (const d of r.dimensions) {
        expect(d.score).toBeGreaterThanOrEqual(0)
        expect(d.score).toBeLessThanOrEqual(1)
      }
    }
  })

  it("基线快照：cavity 无 flag 且指纹 natural（阈值只读引用，不修改）", () => {
    for (const s of HUMAN_SAMPLES) {
      const cav = overCorrectionReport(s.text)
      expect(cav.flags).toEqual([])
      expect(cav.sentenceLengthCV).toBeGreaterThan(CAVITY_CV_LOW)
      expect(cav.sentenceLengthCV).toBeLessThan(CAVITY_CV_HIGH)
      expect(cav.fillerDensityPer1000).toBeLessThan(CAVITY_FILLER_PER_1000)
      expect(statisticalFingerprint(s.text).score).toBeGreaterThanOrEqual(0.6)
    }
  })
})
