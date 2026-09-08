/**
 * kb-shadow-collector.ts — R5 影子期双臂采集器（前端模块，sink 模式镜像 anti-ai-telemetry-sink）。
 *
 * 语义：Tauri 运行期内，双臂（三 flag dualKbRoutingEnabled / hardInjectEnabled /
 * usefulnessRerank 开/关对照）各跑一次检索路由，逐例落
 *   {projectPath}/.novel/telemetry/kb-shadow/dual-arm-<YYYYMMDD>-<sid8>-<seq:03>.jsonl
 * 供 `npm run eval:gov -- --shadow-input <dir>` 消费 → 检索维实测解锁（ADR-47 判定式挂钩，
 * SOP 见 docs/p0/gov-seed/README.md）。
 *
 * 设计边界（与 anti-ai-telemetry-sink 一致）：
 *   - 本模块不 import 任何 IPC / Tauri 符号 —— 全部副作用经注入 deps（挂接层在
 *     composition-root，经 `@/commands/fs` 提供真实 IPC deps，避开 renderer node:fs 的
 *     ISS-020 地雷；此镜像 anti-ai-telemetry-wiring 的 defaultTelemetrySinkDeps）。
 *   - F-34 同意门控复用：采集器单例未 init（同意键默认 false）= null = 零 IO。
 *   - fire-and-forget：recordKbShadowArms 永不抛；单臂失败记 status:"retrieval_error" 行
 *     （hitIds 空、coverage null），绝不静默合成（E-06 C-7）。
 *
 * 本轮交付=模块 + 纯函数单测 + JSONL 序列化（node 可离线验）；真实双臂数据须 Tauri 运行时
 * （同意开 + 显式触发）——采集后 eval-gov-gate --shadow-input 消费，pending 转实采。
 */

export type KbShadowArm = "baseline" | "experiment"

export interface KbShadowFlags {
  dualKbRoutingEnabled: boolean
  hardInjectEnabled: boolean
  usefulnessRerank: boolean
}

export interface KbShadowLine {
  /** 双臂 JSONL 行 schema（README §五 + 增量：caseId join 硬键、status 错误码）。 */
  ts: string
  caseId: string
  arm: KbShadowArm
  flags: KbShadowFlags
  query: string
  hitIds: string[]
  scaleViolation: boolean
  obligationCoverage: number | null
  desensitized: true
  status: "ok" | "retrieval_error"
}

export interface KbShadowCollectorDeps {
  readFile: (p: string) => Promise<string>
  writeFile: (p: string, content: string) => Promise<void>
  createDirectory: (p: string) => Promise<void>
  listFiles: (dir: string) => Promise<string[]>
  now: () => Date
}

export const KB_SHADOW_SCHEMA_VERSION = "qm-kb-shadow/1.0"
export const KB_SHADOW_DIR_REL = ".novel/telemetry/kb-shadow"
export const QUERY_MAX_LEN = 200

/** 臂 flag 向量（baseline=全关 counterfactual 对照；实验=全开——与 kb-flag-promotion-flow A/B 口径一致）。 */
export function armFlagsOf(arm: KbShadowArm): KbShadowFlags {
  return arm === "baseline"
    ? { dualKbRoutingEnabled: false, hardInjectEnabled: false, usefulnessRerank: false }
    : { dualKbRoutingEnabled: true, hardInjectEnabled: true, usefulnessRerank: true }
}

/** query 脱敏 + 截断（≤200；未脱敏禁止落盘——desensitized:true 是硬门）。 */
export function desensitizeQuery(query: string): string {
  const trimmed = query.replace(/\s+/g, " ").trim()
  return trimmed.length > QUERY_MAX_LEN ? `${trimmed.slice(0, QUERY_MAX_LEN)}…` : trimmed
}

/** 段文件名：dual-arm-<YYYYMMDD>-<sid8>-<seq:03>.jsonl（纯字符串拼接，不 import node:path）。 */
export function shadowSegmentName(now: Date, sid8: string, seq: number): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `dual-arm-${y}${m}${d}-${sid8.slice(0, 8)}-${String(seq).padStart(3, "0")}.jsonl`
}

/** 行序列化（白名单投影，不落正文；纯函数可测）。 */
export function serializeShadowLine(line: KbShadowLine): string {
  return JSON.stringify({ schemaVersion: KB_SHADOW_SCHEMA_VERSION, ...line })
}

/**
 * 单臂记录（fire-and-forget 语义由调用方保证不 await 或 catch 后吞掉）。
 * 失败不 rethrow：遥测非真源，写盘失败丢缓冲尾。
 */
export async function appendShadowLine(
  deps: Pick<KbShadowCollectorDeps, "readFile" | "writeFile" | "createDirectory" | "now">,
  projectPath: string,
  sid8: string,
  line: Omit<KbShadowLine, "ts" | "desensitized" | "status"> & { status?: KbShadowLine["status"] },
): Promise<void> {
  try {
    const segment = shadowSegmentName(deps.now(), sid8, line.caseId.length % 1000)
    const dir = `${projectPath}/${KB_SHADOW_DIR_REL}`
    try {
      await deps.createDirectory(dir)
    } catch {
      // 已存在等可容忍错误
    }
    const path = `${dir}/${segment}`
    const full: KbShadowLine = {
      ts: deps.now().toISOString(),
      caseId: line.caseId,
      arm: line.arm,
      flags: line.flags,
      query: desensitizeQuery(line.query),
      hitIds: line.hitIds,
      scaleViolation: line.scaleViolation,
      obligationCoverage: line.obligationCoverage,
      desensitized: true,
      status: line.status ?? "ok",
    }
    let existing = ""
    try {
      existing = await deps.readFile(path)
    } catch {
      existing = ""
    }
    await deps.writeFile(path, existing + serializeShadowLine(full) + "\n")
  } catch {
    // 写盘失败丢尾，不阻塞写作路径
  }
}

/**
 * 双臂记录入口（Tauri 运行时采集调用点；本轮交付模块本体，真实驱动由挂接层接
 * composition-root：同意开（antiAiTelemetryConsent）+ 显式触发，逐案双跑）。
 */
export async function recordKbShadowArms(
  deps: KbShadowCollectorDeps,
  projectPath: string,
  sid8: string,
  cases: ReadonlyArray<{ caseId: string; query: string; obligationCoverage: number | null; scaleViolation: boolean }>,
  runRetrieval: (query: string, flags: KbShadowFlags) => Promise<{ hitIds: string[] }>,
): Promise<{ written: number; failed: number }> {
  let written = 0
  let failed = 0
  const arms: KbShadowArm[] = ["baseline", "experiment"]
  for (const c of cases) {
    for (const arm of arms) {
      const flags = armFlagsOf(arm)
      try {
        const { hitIds } = await runRetrieval(c.query, flags)
        await appendShadowLine(deps, projectPath, sid8, {
          caseId: c.caseId,
          arm,
          flags,
          query: c.query,
          hitIds,
          scaleViolation: c.scaleViolation,
          obligationCoverage: c.obligationCoverage,
        })
        written += 1
      } catch {
        // 单臂失败：记 retrieval_error 行，不阻断其余
        try {
          await appendShadowLine(
            deps,
            projectPath,
            sid8,
            {
              caseId: c.caseId,
              arm,
              flags,
              query: c.query,
              hitIds: [],
              scaleViolation: false,
              obligationCoverage: null,
              status: "retrieval_error",
            },
          )
        } catch {
          // 忽略
        }
        failed += 1
      }
    }
  }
  return { written, failed }
}
