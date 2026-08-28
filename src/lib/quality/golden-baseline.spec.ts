/**
 * golden-baseline.spec.ts — v2.6.7 D1 验收
 *
 * 覆盖：漂移探针 / 结构性约束（门控顺序）/ manifest 指纹
 */
import { describe, expect, it } from "vitest"
import {
  GATE_PRIORITY,
  probeDrift,
  structuralFingerprint,
  verifyStructural,
  type GoldenManifest,
} from "./golden-baseline"

const manifest: GoldenManifest = {
  schemaVersion: "golden-v1",
  commitSha: "abc123",
  toolchain: { rust: "1.80", node: "24.19.0", tauri: "2.0" },
  buildArgs: ["--release"],
  artifacts: [
    { path: "src-tauri/target/release/app.exe", sha256: "hash-a" },
    { path: ".novel/status.json", sha256: "hash-b" },
  ],
  structuralFingerprint: structuralFingerprint(),
}

describe("D1 黄金基线 — 漂移探针", () => {
  it("一致：无漂移", () => {
    const r = probeDrift(manifest, [
      { path: "src-tauri/target/release/app.exe", sha256: "hash-a" },
      { path: ".novel/status.json", sha256: "hash-b" },
    ])
    expect(r.consistent).toBe(true)
    expect(r.drifted).toHaveLength(0)
  })

  it("漂移：产物 hash 不一致 → fail", () => {
    const r = probeDrift(manifest, [
      { path: "src-tauri/target/release/app.exe", sha256: "hash-a" },
      { path: ".novel/status.json", sha256: "CHANGED" },
    ])
    expect(r.consistent).toBe(false)
    expect(r.drifted).toHaveLength(1)
    expect(r.drifted[0].path).toBe(".novel/status.json")
  })

  it("漂移：产物缺失 → fail", () => {
    const r = probeDrift(manifest, [{ path: "src-tauri/target/release/app.exe", sha256: "hash-a" }])
    expect(r.consistent).toBe(false)
    expect(r.drifted[0].sha256).toBe("MISSING")
  })
})

describe("D1 结构性约束 — 门控顺序不变量", () => {
  it("门控顺序固定：Consistency(P0) > Anti-AI(P1) > Quality(P2)", () => {
    expect(GATE_PRIORITY).toEqual(["Consistency(P0)", "Anti-AI(P1)", "Quality(P2)"])
  })

  it("verifyStructural：一致通过", () => {
    expect(verifyStructural(["Consistency(P0)", "Anti-AI(P1)", "Quality(P2)"])).toBe(true)
  })

  it("verifyStructural：顺序颠倒拒绝（Quality 不得覆盖 Consistency）", () => {
    expect(verifyStructural(["Quality(P2)", "Anti-AI(P1)", "Consistency(P0)"])).toBe(false)
    expect(verifyStructural(["Consistency(P0)", "Quality(P2)", "Anti-AI(P1)"])).toBe(false)
  })

  it("指纹确定性：同输入同输出", () => {
    expect(structuralFingerprint()).toBe(structuralFingerprint())
    expect(structuralFingerprint()).toContain("Consistency(P0)")
  })
})
