/**
 * channel-b-attribution.spec — R1-c 通道 B 归因实指（路由缺配 vs token 缺词 vs 题材空置），
 * B5-a 补新流派探针（奇幻/武侠/科幻）。
 *
 * 输入：P0#3 发现「修仙 world_ref 空置」（golden 34/34 无失败项，故以该发现为输入，
 * 而非伪造失败项）。判定方法：对固定修仙探针集，分别在
 *   基线视图（__fixtures__/kb-routing-view.baseline-dfd24e776c100d12.json，sha 后缀冻结）
 *   现役视图（kb-routing-view.generated.json，builtFrom=sha256:df39ecbc9a177c41；B5-a 扩容后指纹）
 * 上跑通道 B 纯逻辑（routeByQueryIntent + tokensForKbMatch，与 golden-retrieval.spec 同 import 面），
 * 记录路由面 / token 面 / collection 命中面（含命中条目名）→ 三态归因：
 *   - routed_missing：目标 collection 不在路由 allowlist（路由缺配）
 *   - token_missing：token 全 collection 零命中（语料对该查询全空）
 *   - corpus_gap：路由内其他 collection 有命中而目标 collection 为 0（题材空置）
 *   - hit：目标 collection 命中
 *
 * 实测归因（2026-09-17 冻结）：基线 7×corpus_gap + 2×token_missing + 1×hit（该 hit 命中
 * 条目为 cthulhu-* 非修仙条目 = 题材噪声）；现役 10×hit 且 world_ref 命中条目均为
 * xianxia-world-*。→ 单点修复 = R1-a 内容补料（路由与分词均无代码缺陷；故无路由/分词
 * 改动），符合反目标「不伪造失败项」。
 *
 * @license MIT © QMAI
 */
import { describe, expect, it } from "vitest"
import { routeByQueryIntent, tokensForKbMatch } from "./search-adapter"
import kbRoutingView from "./kb/kb-routing-view.generated.json"
import baselineView from "./__fixtures__/kb-routing-view.baseline-dfd24e776c100d12.json"

type View = { builtFrom?: string; collections?: Record<string, Array<Record<string, unknown>>> }

/** 修仙探针集（world_ref 目标题材）。 */
const PROBES: Array<{ query: string; intent: string; target: string }> = [
  { query: "修仙 灵脉 争夺", intent: "lookup", target: "world_ref" },
  { query: "宗门 秩序 正魔两道", intent: "lookup", target: "world_ref" },
  { query: "天道 因果 业力", intent: "plan", target: "world_ref" },
  { query: "凡人世界 仙凡隔绝", intent: "lookup", target: "world_ref" },
  { query: "秘境 洞天 禁制", intent: "lookup", target: "world_ref" },
  { query: "妖兽 谱系 灵兽契约", intent: "lookup", target: "world_ref" },
  { query: "鬼道 魔道 阴气", intent: "lookup", target: "world_ref" },
  { query: "丹道 经济 灵石本位", intent: "lookup", target: "world_ref" },
  { query: "飞升 天劫 渡劫台", intent: "draft", target: "world_ref" },
  { query: "九州 地理 灵域分级", intent: "plan", target: "world_ref" },
]

/** B5-a 新流派探针集（奇幻/武侠/科幻 世界卡目标面；批准计划 r3 §T1）。 */
const GENRE_PROBES: Array<{ query: string; intent: string; target: string; prefix: string }> = [
  { query: "奇幻 魔法 咒式 代价", intent: "lookup", target: "world_ref", prefix: "fantasy-world-" },
  { query: "奇幻 王国 封建 继承法", intent: "plan", target: "world_ref", prefix: "fantasy-world-" },
  { query: "奇幻 种族 偏见 半血种", intent: "lookup", target: "world_ref", prefix: "fantasy-world-" },
  { query: "武侠 江湖 门派 盟主", intent: "lookup", target: "world_ref", prefix: "wuxia-world-" },
  { query: "武侠 镖局 商路 买路钱", intent: "lookup", target: "world_ref", prefix: "wuxia-world-" },
  { query: "武侠 朝廷 招安 禁武令", intent: "plan", target: "world_ref", prefix: "wuxia-world-" },
  { query: "科幻 星际 殖民 跃迁节点", intent: "plan", target: "world_ref", prefix: "scifi-world-" },
  { query: "科幻 义体 阶层 债务", intent: "lookup", target: "world_ref", prefix: "scifi-world-" },
  { query: "科幻 人工智能 责任 授权链", intent: "draft", target: "world_ref", prefix: "scifi-world-" },
]

interface Attribution {
  routed: string[]
  tokens: string[]
  byCollection: Record<string, number>
  names: Record<string, string[]>
  target: number
  anyHit: number
  mode: "routed_missing" | "token_missing" | "corpus_gap" | "hit"
}

function attribute(view: View, probe: { query: string; intent: string; target: string }): Attribution {
  const routed = routeByQueryIntent(probe.intent).collections.filter((c) => c !== "tech")
  const tokens = tokensForKbMatch(probe.query)
  const cols = view.collections ?? {}
  const byCollection: Record<string, number> = {}
  const names: Record<string, string[]> = {}
  let anyHit = 0
  for (const collection of routed) {
    const matched: string[] = []
    for (const entry of cols[collection] ?? []) {
      const hay = `${String(entry["name"] ?? "")} ${String(entry["title"] ?? "")} ${
        Array.isArray(entry["domain"]) ? (entry["domain"] as string[]).join(" ") : ""
      }`.toLowerCase()
      if (tokens.some((t) => hay.includes(t))) matched.push(String(entry["name"] ?? ""))
    }
    byCollection[collection] = matched.length
    names[collection] = matched
    anyHit += matched.length
  }
  const target = byCollection[probe.target] ?? 0
  const mode: Attribution["mode"] = !routed.includes(probe.target)
    ? "routed_missing"
    : anyHit === 0
      ? "token_missing"
      : target === 0
        ? "corpus_gap"
        : "hit"
  return { routed, tokens, byCollection, names, target, anyHit, mode }
}

const baseline: Attribution[] = PROBES.map((p) => attribute(baselineView as View, p))
const current: Attribution[] = PROBES.map((p) => attribute(kbRoutingView as View, p))
const genreCurrent: Attribution[] = GENRE_PROBES.map((p) => attribute(kbRoutingView as View, p))

describe("R1-c 通道 B 归因实指（三态）", () => {
  it("路由面：world_ref 在 lookup/plan/draft allowlist 内（非路由缺配）", () => {
    for (const a of baseline) {
      expect(a.routed).toContain("world_ref")
      expect(a.mode).not.toBe("routed_missing")
    }
  })

  it("token 面：分词对全部探针产出 token，且 CJK bigram 命中关键词（非分词缺词）", () => {
    for (const a of baseline) {
      expect(a.tokens.length).toBeGreaterThan(0)
    }
    // 分词器能力直证：灵脉/宗门/秘境 等复合词经 CJK bigram 切分后仍含可匹配 token
    const t = tokensForKbMatch("修仙 灵脉 争夺")
    expect(t).toContain("灵脉")
    expect(tokensForKbMatch("秘境 洞天 禁制")).toContain("秘境")
  })

  it("基线归因分布冻结：7 corpus_gap + 2 token_missing + 1 hit（语料空置证据）", () => {
    const modes = baseline.map((a) => a.mode)
    expect(modes.filter((m) => m === "corpus_gap")).toHaveLength(7)
    expect(modes.filter((m) => m === "token_missing")).toHaveLength(2)
    expect(modes.filter((m) => m === "hit")).toHaveLength(1)
    expect(modes.filter((m) => m === "routed_missing")).toHaveLength(0)
    // 2 条 token_missing 在「全 collection 零命中」意义上成立（token 本身存在，非分词缺陷）
    for (let i = 0; i < PROBES.length; i += 1) {
      if (baseline[i]!.mode === "token_missing") expect(baseline[i]!.tokens.length).toBeGreaterThan(0)
    }
    expect(baselineView.builtFrom).toBe("sha256:dfd24e776c100d12")
  })

  it("基线唯一 world_ref 命中为 cthulhu 题材噪声（非修仙条目）", () => {
    const noisy = baseline.find((a) => a.mode === "hit")!
    const idx = baseline.indexOf(noisy)
    expect(PROBES[idx]!.query).toBe("凡人世界 仙凡隔绝")
    expect(noisy.names["world_ref"]).toEqual(["cthulhu-places"])
    // 其余 9 条 world_ref 命中为 0
    expect(baseline.filter((a) => a.target === 0)).toHaveLength(9)
  })

  it("现役视图：全部探针 hit，且 world_ref 命中含 xianxia-world-* 修仙条目（R1-a 补料生效）", () => {
    for (const a of current) {
      expect(a.mode).toBe("hit")
      expect(a.target).toBeGreaterThan(0)
      // 既有 cthulhu 条目可共存命中（题材并行），但每条探针必须至少命中一张修仙世界卡
      expect(a.names["world_ref"]!.some((n) => n.startsWith("xianxia-world-"))).toBe(true)
    }
    expect(kbRoutingView.builtFrom).toBe("sha256:df39ecbc9a177c41")
  })

  it("零回归：craft/lexicon 命中数不下降（补料不挤占既有 collection）", () => {
    for (let i = 0; i < PROBES.length; i += 1) {
      expect(current[i]!.byCollection["craft"] ?? 0).toBeGreaterThanOrEqual(
        baseline[i]!.byCollection["craft"] ?? 0,
      )
      expect(current[i]!.byCollection["lexicon"] ?? 0).toBeGreaterThanOrEqual(
        baseline[i]!.byCollection["lexicon"] ?? 0,
      )
    }
  })

  it("扩容计数守恒：world_ref 8→18→27（R1 +10，B5-a +9），lexicon 38→44→53（R1 +6，B5-a +9）", () => {
    const counts = (v: View) =>
      Object.fromEntries(Object.entries(v.collections ?? {}).map(([k, arr]) => [k, arr.length]))
    expect(counts(baselineView as View)["world_ref"]).toBe(8)
    expect(counts(kbRoutingView as View)["world_ref"]).toBe(27)
    expect(counts(baselineView as View)["lexicon"]).toBe(38)
    expect(counts(kbRoutingView as View)["lexicon"]).toBe(53)
    // corpus 不增（AG1 唯一 headroom 保护）
    expect(counts(kbRoutingView as View)["corpus"]).toBe(6)
  })

  it("新流派探针（奇幻/武侠/科幻）：全部 hit 且各命中所属流派世界卡", () => {
    for (let i = 0; i < GENRE_PROBES.length; i += 1) {
      const a = genreCurrent[i]!
      expect(a.routed).toContain("world_ref")
      expect(a.tokens.length).toBeGreaterThan(0)
      expect(a.mode).toBe("hit")
      expect(a.target).toBeGreaterThan(0)
      expect(a.names["world_ref"]!.some((n) => n.startsWith(GENRE_PROBES[i]!.prefix))).toBe(true)
    }
  })

  it("新流派归因可负向验证：去掉新流派世界卡后探针不再命中目标面（lookup 降为 corpus_gap）", () => {
    const stripped = {
      collections: {
        ...(kbRoutingView as View).collections,
        world_ref: ((kbRoutingView as View).collections?.["world_ref"] ?? []).filter(
          (e) => !/^(fantasy|wuxia|scifi)-world-/.test(String(e["name"] ?? "")),
        ),
      },
    }
    const modes = GENRE_PROBES.map((probe) => attribute(stripped as View, probe))
    for (const a of modes) {
      expect(a.mode).not.toBe("hit")
      expect(a.target).toBe(0)
    }
    // 冻结退化分布（剔除 9 张新流派世界卡后）：lookup/draft 面仍含 lexicon（新流派词条）→ corpus_gap；
    // plan 面不含 lexicon → 全 collection 零命中 → token_missing。
    const flat = modes.map((a) => a.mode)
    expect(flat.filter((m) => m === "corpus_gap")).toHaveLength(6)
    expect(flat.filter((m) => m === "token_missing")).toHaveLength(3)
    expect(flat.filter((m) => m === "hit")).toHaveLength(0)
  })
})
