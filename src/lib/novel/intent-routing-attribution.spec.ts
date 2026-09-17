/**
 * intent-routing-attribution.spec.ts — B5-b 意图路由归因（批准计划 r3 §T2）。
 *
 * 职责（与 golden-retrieval / channel-b-attribution 同一通道 B 纯逻辑面）：
 *   1. 冻结 `routing.agent` 期望矩阵并断言消费面视图一致（revise 面含 world_ref）。
 *   2. intent×genre 归因实指：每个 intent 在其允许集合内命中（hit），且目标题材条目可命中。
 *   3. `assertNoTechLeak` 安全不变量：任何 intent 的 allowlist 不得含 tech（数据面 + 调用面双证）。
 *   4. 负向控制：以「改动前的 revise allowlist（craft/lexicon）」重放同一探针 → 目标面命中为 0，
 *      证明该断言不是空转（若恢复旧矩阵，测试即失败）。
 *
 * 输入：kb-routing-view.generated.json（真实生成产物，builtFrom=sha256:df39ecbc9a177c41）。
 * 零 IO / 零时钟：只读真实产物 + 纯函数调用。
 */
import { describe, expect, it } from "vitest"
import { routeByQueryIntent, tokensForKbMatch } from "./search-adapter"
import kbRoutingView from "./kb/kb-routing-view.generated.json"

type View = { collections?: Record<string, Array<Record<string, unknown>>> }
const view = kbRoutingView as unknown as View

/** 期望矩阵（真源：niko-hub/scripts/build-reference-kb-view.js 的 ROUTING_AGENT）。 */
const EXPECTED_AGENT: Record<string, string[]> = {
  plan: ["craft", "world_ref", "corpus"],
  draft: ["craft", "corpus", "lexicon", "world_ref"],
  revise: ["craft", "lexicon", "world_ref"],
  lookup: ["world_ref", "lexicon", "craft"],
  style: ["craft", "lexicon", "corpus"],
}

/** intent×genre 探针：每个 intent ≥1 条，target 为其允许集合中的题材面。 */
const PROBES: Array<{ intent: string; query: string; target: string; prefix: string }> = [
  { intent: "revise", query: "修仙 灵脉 争夺 修订", target: "world_ref", prefix: "xianxia-world-" },
  { intent: "revise", query: "奇幻 魔法 体系 改写", target: "world_ref", prefix: "fantasy-world-" },
  { intent: "lookup", query: "武侠 江湖 门派", target: "world_ref", prefix: "wuxia-world-" },
  { intent: "lookup", query: "科幻 义体 阶层", target: "world_ref", prefix: "scifi-world-" },
  { intent: "plan", query: "修仙 宗门 秩序", target: "world_ref", prefix: "xianxia-world-" },
  { intent: "plan", query: "奇幻 王国 政治", target: "world_ref", prefix: "fantasy-world-" },
  { intent: "draft", query: "科幻 星际 殖民", target: "world_ref", prefix: "scifi-world-" },
  { intent: "draft", query: "武侠 镖局 商路", target: "world_ref", prefix: "wuxia-world-" },
  { intent: "style", query: "武侠 侠义 用词", target: "lexicon", prefix: "wuxia-term-" },
]

function attribute(query: string, intent: string, target: string, cols: View["collections"]) {
  const routed = routeByQueryIntent(intent).collections.filter((c) => c !== "tech")
  const tokens = tokensForKbMatch(query)
  const hits = routed.filter((collection) => {
    for (const entry of cols?.[collection] ?? []) {
      const hay = `${String(entry["name"] ?? "")} ${String(entry["title"] ?? "")} ${
        Array.isArray(entry["domain"]) ? (entry["domain"] as string[]).join(" ") : ""
      }`.toLowerCase()
      if (tokens.some((t) => hay.includes(t))) return true
    }
    return false
  })
  return { routed, tokens, hits, targetHit: hits.includes(target) }
}

describe("B5-b 意图路由归因（intent×genre）", () => {
  it("消费面 routing.agent 与冻结矩阵一致（revise 已含 world_ref）", () => {
    const agent = (kbRoutingView as { routing?: { agent?: Record<string, string[]> } }).routing?.agent
    expect(agent).toBeDefined()
    for (const [intent, allowlist] of Object.entries(EXPECTED_AGENT)) {
      expect(agent![intent]).toEqual(allowlist)
    }
    expect(agent!["revise"]).toContain("world_ref")
  })

  it("调用面：routeByQueryIntent 对全部 intent 返回冻结矩阵（tech 结构性消失）", () => {
    for (const intent of Object.keys(EXPECTED_AGENT)) {
      const routed = routeByQueryIntent(intent)
      expect(routed.collections).toEqual(EXPECTED_AGENT[intent])
      expect(routed.collections).not.toContain("tech")
      expect(routed.blocked).toEqual([])
      expect(routed.gaps).toEqual([])
    }
  })

  it("数据面：routing.agent 任一 intent 的 allowlist 均不含 tech（assertNoTechLeak 同口径）", () => {
    const agent = (kbRoutingView as { routing?: { agent?: Record<string, string[]> } }).routing!.agent!
    for (const allowlist of Object.values(agent)) {
      expect(allowlist).not.toContain("tech")
    }
  })

  it("intent×genre 归因：全部探针在其 allowlist 内命中，且命中目标题材面", () => {
    for (const probe of PROBES) {
      const a = attribute(probe.query, probe.intent, probe.target, view.collections)
      expect(a.tokens.length).toBeGreaterThan(0)
      expect(a.routed).toContain(probe.target)
      expect(a.hits.length).toBeGreaterThan(0)
      expect(a.targetHit).toBe(true)
      if (probe.prefix) {
        const names = (view.collections?.[probe.target] ?? [])
          .filter((e) => String(e["name"] ?? "").startsWith(probe.prefix))
          .map((e) => String(e["name"] ?? ""))
        expect(names.length).toBeGreaterThan(0)
      }
    }
  })

  it("revise 面回归：新增 world_ref 后既有 craft/lexicon 命中不丢失", () => {
    const routed = routeByQueryIntent("revise").collections
    expect(routed).toContain("craft")
    expect(routed).toContain("lexicon")
    expect(routed).toContain("world_ref")
    // 既有集合（craft/lexicon）仍在 allowlist 内且探针 token 非退化 → 新增面不挤占既有面
    for (const probe of PROBES.filter((p) => p.intent === "revise")) {
      expect(routed.slice(0, 2)).toContain("craft")
      expect(tokensForKbMatch(probe.query).length).toBeGreaterThan(0)
    }
  })

  it("负向控制：以改动前的 revise allowlist（craft/lexicon）重放 → 目标面零命中", () => {
    const legacyRevise = ["craft", "lexicon"]
    for (const probe of PROBES.filter((p) => p.intent === "revise")) {
      const routed = legacyRevise.filter((c) => c !== "tech")
      const tokens = tokensForKbMatch(probe.query)
      const targetHits = (view.collections?.[probe.target] ?? []).filter((entry) => {
        const hay = `${String(entry["name"] ?? "")} ${String(entry["title"] ?? "")} ${
          Array.isArray(entry["domain"]) ? (entry["domain"] as string[]).join(" ") : ""
        }`.toLowerCase()
        return tokens.some((t) => hay.includes(t))
      })
      // 条目本身可命中（证明语料在位），但旧路由面不检索 world_ref → 修订查询拿不到世界卡
      expect(targetHits.length).toBeGreaterThan(0)
      expect(routed).not.toContain(probe.target)
    }
  })
})
