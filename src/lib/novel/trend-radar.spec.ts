/**
 * trend-radar.spec — 波3-A 热门题材雷达（RadarSignal→kb 产物，出处强制）测试。
 * 覆盖：构建出口 schema+排序确定性+contentHash / 出处强制 fail-loud /
 * id 重复拒绝 / 零信号平凡 / 守恒复核（篡改检出）/ 健康探针 violation。
 */
import { describe, expect, it } from "vitest"
import {
  buildTrendRadarArtifact,
  probeTrendRadarHealth,
  RADAR_SIGNAL_SCHEMA,
  verifyTrendRadarConservation,
  type TrendRadarArtifact,
} from "./trend-radar"

const TS = "2026-09-16T00:00:00.000Z"

function signal(id: string, topic: string, heat: number, sourceRef = "榜单:qidian-2026-09") {
  return { signalId: id, topic, heat, sourceRef }
}

describe("buildTrendRadarArtifact（生成器出口）", () => {
  it("schema 校验 + 热度降序稳定排序 + 确定性 contentHash + 深冻结", () => {
    const artifact = buildTrendRadarArtifact({
      generatorVersion: "gen-1",
      generatedAt: TS,
      signals: [signal("s-b", "末世种田", 60), signal("s-a", "规则怪谈", 90), signal("s-c", "群像悬疑", 60)],
    })
    expect(artifact.signals.map((s) => s.signalId)).toEqual(["s-a", "s-b", "s-c"])
    expect(artifact.contentHash).toMatch(/^lib-fnv1a-/)
    expect(Object.isFrozen(artifact)).toBe(true)
    expect(Object.isFrozen(artifact.signals[0])).toBe(true)
    const again = buildTrendRadarArtifact({ generatorVersion: "gen-1", generatedAt: TS, signals: [...artifact.signals].reverse() })
    expect(again.contentHash).toBe(artifact.contentHash)
  })

  it("出处强制：空 sourceRef fail-loud（不静默入库）；schema 拒绝越界热度", () => {
    expect(() =>
      buildTrendRadarArtifact({ generatorVersion: "gen-1", generatedAt: TS, signals: [signal("s-x", "题材", 50, "  ")] }),
    ).toThrow(/出处为空/)
    expect(() => RADAR_SIGNAL_SCHEMA.parse({ signalId: "s", topic: "t", heat: 150, sourceRef: "x" })).toThrow()
  })

  it("signalId 重复拒绝；空 generatorVersion/generatedAt 拒绝；空信号平凡产物", () => {
    expect(() =>
      buildTrendRadarArtifact({ generatorVersion: "g", generatedAt: TS, signals: [signal("s", "a", 10), signal("s", "b", 20)] }),
    ).toThrow(/重复/)
    expect(() => buildTrendRadarArtifact({ generatorVersion: "", generatedAt: TS, signals: [] })).toThrow(/generatorVersion/)
    expect(() => buildTrendRadarArtifact({ generatorVersion: "g", generatedAt: "", signals: [] })).toThrow(/generatedAt/)
    const empty = buildTrendRadarArtifact({ generatorVersion: "g", generatedAt: TS, signals: [] })
    expect(empty.signals).toHaveLength(0)
    expect(probeTrendRadarHealth(empty).status).toBe("ok")
  })
})

describe("守恒复核 + 健康探针（产物不是真源）", () => {
  it("contentHash 由 signals 重建：一致 conserved；篡改 signals 失配检出", () => {
    const artifact = buildTrendRadarArtifact({ generatorVersion: "g", generatedAt: TS, signals: [signal("s-1", "规则怪谈", 80)] })
    expect(verifyTrendRadarConservation(artifact).conserved).toBe(true)
    const tampered = { ...artifact, signals: [signal("s-1", "被篡改题材", 80)] } as unknown as TrendRadarArtifact
    expect(verifyTrendRadarConservation(tampered).conserved).toBe(false)
    const health = probeTrendRadarHealth(tampered)
    expect(health.status).toBe("violation")
    expect(health.conserved).toBe(false)
  })

  it("健康探针复核出处缺失与重复 id（外部写入产物同样受检）", () => {
    const artifact = buildTrendRadarArtifact({ generatorVersion: "g", generatedAt: TS, signals: [signal("s-1", "t", 10)] })
    const tampered = {
      ...artifact,
      signals: [
        { ...signal("s-1", "t", 10), sourceRef: "" },
        { ...signal("s-1", "t2", 20) },
      ],
    } as unknown as TrendRadarArtifact
    const health = probeTrendRadarHealth(tampered)
    expect(health.missingProvenance).toEqual(["s-1"])
    expect(health.duplicates).toEqual(["s-1"])
    expect(health.status).toBe("violation")
  })
})