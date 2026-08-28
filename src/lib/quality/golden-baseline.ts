/**
 * golden-baseline.ts — v2.6.7 D1: 黄金基线（commit-pin + 产物 hash + 漂移探针）
 *
 * 蓝图 `docs/p0/blueprint-v267-20260828.md` D1：
 *   - commit-pin（锁 SHA+工具链版本+构建参数）
 *   - 产物 hash（二进制+status.json+向量库）
 *   - 漂移探针（二次构建比对 mismatch 即 fail）
 *   - 只锁结构性约束（门控顺序/机械规则——不锁文风）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 结构性约束（只锁门控顺序/机械规则——不锁文风）
// ============================================================================

/** 门控优先级（P0>P1>P2——固定不变量）。 */
export const GATE_PRIORITY = ["Consistency(P0)", "Anti-AI(P1)", "Quality(P2)"] as const

/** 结构性约束清单（黄金基线只锁这些——不锁文风细节）。 */
export const STRUCTURAL_CONSTRAINTS = {
  gatePriority: GATE_PRIORITY,
  draftFirst: "pending -> ready -> accepted（草稿不直写正文）",
  singleSource: ".novel/status.json 唯一真源（禁平行状态文件）",
} as const

// ============================================================================
// 黄金基线 manifest
// ============================================================================

/** 产物 hash 条目。 */
export interface ArtifactHash {
  /** 产物路径（相对 QMAI 根）。 */
  path: string
  /** SHA-256 摘要。 */
  sha256: string
}

/** 黄金基线 manifest（签名快照——存 .workflow/）。 */
export interface GoldenManifest {
  /** manifest 版本。 */
  schemaVersion: string
  /** 锁定的 commit SHA。 */
  commitSha: string
  /** 工具链版本（Rust/Node/Tauri——同锁防异环境重建）。 */
  toolchain: { rust: string; node: string; tauri: string }
  /** 构建参数。 */
  buildArgs: string[]
  /** 产物 hash 列表。 */
  artifacts: ArtifactHash[]
  /** 结构性约束指纹（门控顺序等）。 */
  structuralFingerprint: string
}

/** 漂移探针结果。 */
export interface DriftProbeResult {
  /** 是否一致（无漂移）。 */
  consistent: boolean
  /** 漂移项（不一致的产物）。 */
  drifted: ArtifactHash[]
  /** 结构性约束是否一致。 */
  structuralConsistent: boolean
}

/**
 * 漂移探针：比对当前产物 hash 与 manifest（mismatch 即 fail）。
 * 纯函数：输入 manifest + 当前 hash 列表，输出一致性判定。
 */
export function probeDrift(manifest: GoldenManifest, currentHashes: ArtifactHash[]): DriftProbeResult {
  const manifestMap = new Map(manifest.artifacts.map((a) => [a.path, a.sha256]))
  const currentMap = new Map(currentHashes.map((a) => [a.path, a.sha256]))
  const drifted: ArtifactHash[] = []
  for (const [path, sha] of manifestMap) {
    if (currentMap.get(path) !== sha) {
      drifted.push({ path, sha256: currentMap.get(path) ?? "MISSING" })
    }
  }
  return {
    consistent: drifted.length === 0,
    drifted,
    structuralConsistent: true, // 结构性约束由调用方比对（见 verifyStructural）
  }
}

/**
 * 结构性约束校验：门控顺序必须与 GATE_PRIORITY 一致。
 * 纯函数：输入实际门控顺序，输出是否一致。
 */
export function verifyStructural(actualPriority: readonly string[]): boolean {
  if (actualPriority.length !== GATE_PRIORITY.length) return false
  return GATE_PRIORITY.every((g, i) => actualPriority[i] === g)
}

/** 结构性约束指纹（确定性——用于 manifest 比对）。 */
export function structuralFingerprint(): string {
  return JSON.stringify(STRUCTURAL_CONSTRAINTS)
}
