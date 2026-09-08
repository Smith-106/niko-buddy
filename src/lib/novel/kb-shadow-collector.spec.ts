import { describe, expect, it } from "vitest"
import {
  appendShadowLine,
  armFlagsOf,
  desensitizeQuery,
  KB_SHADOW_DIR_REL,
  recordKbShadowArms,
  serializeShadowLine,
  shadowSegmentName,
  type KbShadowCollectorDeps,
} from "./kb-shadow-collector"

function fakeDeps(overrides: Partial<KbShadowCollectorDeps> = {}): KbShadowCollectorDeps {
  const files = new Map<string, string>()
  return {
    readFile: async (p) => {
      if (!files.has(p)) throw new Error("ENOENT")
      return files.get(p)!
    },
    writeFile: async (p, c) => {
      files.set(p, c)
    },
    createDirectory: async () => undefined,
    listFiles: async () => [...files.keys()],
    now: () => new Date("2026-09-08T12:00:00Z"),
    ...overrides,
  }
}

describe("kb-shadow-collector（R5 影子期双臂采集 · 纯函数面）", () => {
  it("armFlagsOf：baseline 三 flag 全关、experiment 全开（A/B 对照语义）", () => {
    expect(armFlagsOf("baseline")).toEqual({
      dualKbRoutingEnabled: false,
      hardInjectEnabled: false,
      usefulnessRerank: false,
    })
    expect(armFlagsOf("experiment")).toEqual({
      dualKbRoutingEnabled: true,
      hardInjectEnabled: true,
      usefulnessRerank: true,
    })
  })

  it("desensitizeQuery：空白归一 + 超长截断 ≤200（硬门）", () => {
    const q = `  query  with  多  空格  ${"长".repeat(300)} `
    const d = desensitizeQuery(q)
    expect(d).toContain("query with 多 空格")
    expect(d.length).toBeLessThanOrEqual(201) // 200 + 省略号
    expect(d.endsWith("…")).toBe(true)
  })

  it("shadowSegmentName / serializeShadowLine：白名单投影含 caseId + status + desensitized:true", () => {
    const now = new Date("2026-09-08T12:00:00Z")
    expect(shadowSegmentName(now, "ABCDEF12abcd", 7)).toBe("dual-arm-20260908-ABCDEF12-007.jsonl")
    const line = serializeShadowLine({
      ts: "2026-09-08T12:00:00.000Z",
      caseId: "GOV-OBL-CFX-017-R2",
      arm: "baseline",
      flags: armFlagsOf("baseline"),
      query: "q",
      hitIds: ["real-8人-ch002"],
      scaleViolation: false,
      obligationCoverage: 1,
      desensitized: true,
      status: "ok",
    })
    const parsed = JSON.parse(line)
    expect(parsed.schemaVersion).toBe("qm-kb-shadow/1.0")
    expect(parsed.caseId).toBe("GOV-OBL-CFX-017-R2")
    expect(parsed.arm).toBe("baseline")
    expect(parsed.desensitized).toBe(true)
    expect(parsed.status).toBe("ok")
    expect(parsed).not.toHaveProperty("content")
    expect(parsed).not.toHaveProperty("chapterText")
  })

  it("appendShadowLine：追加写 + 目录路径含 tel kb-shadow（deps 注入，无 IPC）", async () => {
    const deps = fakeDeps()
    await appendShadowLine(deps, "/proj", "SID12345", {
      caseId: "C-1",
      arm: "experiment",
      flags: armFlagsOf("experiment"),
      query: "query",
      hitIds: [],
      scaleViolation: false,
      obligationCoverage: null,
    })
    await appendShadowLine(deps, "/proj", "SID12345", {
      caseId: "C-2",
      arm: "baseline",
      flags: armFlagsOf("baseline"),
      query: "query2",
      hitIds: ["id"],
      scaleViolation: false,
      obligationCoverage: 0.5,
    })
    const files = await deps.listFiles("/proj")
    const seg = files.find((f) => f.includes(KB_SHADOW_DIR_REL))
    expect(seg).toBeDefined()
    const content = await deps.readFile(seg as string)
    const lines = content.trim().split("\n")
    expect(lines.length).toBe(2)
    expect(lines[0]).toContain('"C-1"')
    expect(lines[1]).toContain('"C-2"')
  })

  it("recordKbShadowArms：双臂 × N 案例全跑；单臂失败记 retrieval_error 不阻断", async () => {
    const deps = fakeDeps()
    let call = 0
    const { written, failed } = await recordKbShadowArms(
      deps,
      "/proj",
      "SID12345",
      [
        { caseId: "A", query: "q1", obligationCoverage: 1, scaleViolation: false },
        { caseId: "B", query: "q2", obligationCoverage: null, scaleViolation: false },
      ],
      async (query) => {
        call += 1
        if (query === "q2" && call === 3) throw new Error("检索失败（模拟）")
        return { hitIds: [`hit-${query}`] }
      },
    )
    // 4 臂跑（2 案例 × 2 臂）；q2 的第一次调用（baseline）失败 → failed=1、written=3
    expect(failed).toBe(1)
    expect(written).toBe(3)
    const files = await deps.listFiles("/proj")
    const seg = files.find((f) => f.includes(KB_SHADOW_DIR_REL))!
    const content = await deps.readFile(seg)
    const lines = content.trim().split("\n").map((l) => JSON.parse(l))
    const errLine = lines.find((l) => l.status === "retrieval_error")
    expect(errLine).toBeDefined()
    expect(errLine.arm).toBe("baseline")
    expect(errLine.hitIds).toEqual([])
    expect(errLine.obligationCoverage).toBeNull()
  })

  it("写盘失败丢尾不抛（fire-and-forget 契约）", async () => {
    const deps = fakeDeps({
      writeFile: async () => {
        throw new Error("disk full")
      },
    } as unknown as Partial<KbShadowCollectorDeps>)
    await expect(
      appendShadowLine(deps, "/proj", "SID", { caseId: "X", arm: "baseline", flags: armFlagsOf("baseline"), query: "q", hitIds: [], scaleViolation: false, obligationCoverage: null }),
    ).resolves.toBeUndefined()
  })
})
