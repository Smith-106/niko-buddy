/**
 * version-lock.ts — v2.7.0 版本锁（build 哈希 manifest + 失配阻断）
 *
 * 蓝图 `docs/p0/blueprint-v270-20260828.md`：
 *   - build 产物哈希（前端 bundle+Rust 二进制）写 manifest
 *   - 同 commit 两次构建一致；失配 fail-fast（不做静默降级）
 *   - 锁配置全谱（prompt/温度/权重哈希——防漏锁绕过）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 版本锁
// ============================================================================

/** 构建哈希。 */
export interface BuildHash {
  bundle: string
  binary: string
}

/** 门控配置哈希（prompt/温度/权重——防漏锁绕过）。 */
export interface GateConfigHash {
  prompt: string
  temperature: string
  weights: string
}

/** 版本锁结果。 */
export interface VersionLockResult {
  /** 产物哈希是否一致。 */
  artifactsMatch: boolean
  /** 配置哈希是否一致。 */
  configMatch: boolean
  /** 失配阻断（fail-fast——不做静默降级）。 */
  blocked: boolean
}

/**
 * 版本锁校验（纯函数——确定性）。
 * 输入：manifest 声明 + 实际产物/配置哈希；输出：一致 + 失配阻断。
 */
export function verifyVersionLock(
  declared: { artifacts: BuildHash; config: GateConfigHash },
  actual: { artifacts: BuildHash; config: GateConfigHash },
): VersionLockResult {
  const artifactsMatch =
    declared.artifacts.bundle === actual.artifacts.bundle && declared.artifacts.binary === actual.artifacts.binary
  const configMatch =
    declared.config.prompt === actual.config.prompt &&
    declared.config.temperature === actual.config.temperature &&
    declared.config.weights === actual.config.weights
  return { artifactsMatch, configMatch, blocked: !(artifactsMatch && configMatch) }
}
