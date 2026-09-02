/**
 * anti-ai-telemetry-wiring.ts — #34 生产接线 + F-34 显式同意开关
 *
 * 组合根（composition-root.ts）在「项目打开」处调用本模块完成：
 *   - 经 `@/commands/fs`（Tauri IPC，避开 renderer 直连 node:fs 的 ISS-020 地雷）
 *     提供真实落盘 deps（结构镜像 StageJournalDeps / defaultStageJournalDeps）。
 *   - 经 F-34 显式同意门控（默认关）初始化 sink；未同意 = 不初始化 = 零 IO。
 *   - 组合根在应用退出时注册 pagehide → shutdownAntiAiTelemetrySink（flush + 90 天清理）。
 *
 * 设计边界（与 sink 模块一致）：本模块只做 type-only 导入 + 经 IPC 的运行时导入，
 * 绝不导入 AntiAiCandidatePool 运行时符号（node:fs 地雷隔离在 shadow-telemetry 动态 import）。
 *
 * 隐私口径（F-34）：仅本地匿名落盘诊断 JSONL，不进任何门裁；默认关，须用户显式
 * 同意（持久化标志，默认 false）后才记录。
 */
import {
  readFile,
  writeFileAtomic,
  createDirectory,
  listDirectory,
  deleteFile,
} from "@/commands/fs"
import { getStore } from "@/lib/web-store"
import {
  initAntiAiTelemetrySink,
  shutdownAntiAiTelemetrySink,
  type AntiAiTelemetrySink,
  type TelemetrySinkDeps,
} from "./anti-ai-telemetry-sink"
import { createNovelSessionId } from "./novel-session-status"

const ANTI_AI_TELEMETRY_CONSENT_KEY = "antiAiTelemetryConsent"

/**
 * 真实落盘 deps：全部副作用经 `@/commands/fs` IPC（Tauri invoke），绝不直连 node:fs。
 * listDirectory 返回 FileNode[]，适配 TelemetrySinkDeps.listFiles 需要的名字列表。
 */
export function defaultTelemetrySinkDeps(): TelemetrySinkDeps {
  return {
    readFile: (p) => readFile(p),
    writeFile: (p, c) => writeFileAtomic(p, c),
    createDirectory: (p) => createDirectory(p),
    listFiles: (dir) => listDirectory(dir).then((xs) => xs.map((x) => x.name)),
    deleteFile: (p) => deleteFile(p),
    now: () => new Date(),
  }
}

/**
 * F-34 显式同意开关（app 级持久化；默认 false = 关）。
 * 镜像 project-store 的 loadTheme/saveTheme 范式，但本模块自持持久化，
 * 不改动 project-store（避免触及非组合根数据层）。
 */
export async function loadAntiAiTelemetryConsent(): Promise<boolean> {
  const store = await getStore()
  return (await store.get<boolean>(ANTI_AI_TELEMETRY_CONSENT_KEY)) ?? false
}

export async function saveAntiAiTelemetryConsent(value: boolean): Promise<void> {
  const store = await getStore()
  await store.set(ANTI_AI_TELEMETRY_CONSENT_KEY, value)
}

/**
 * 生产接线纯函数（便于单测门控分支）：
 *   同意=true  → 用工厂 deps 初始化 sink，返回非 null（调用方应已 shutdown 旧 sink）。
 *   同意=false → 不初始化，返回 null（F-34 默认关契约的保证）。
 */
export function initAntiAiTelemetryIfConsented(
  consent: boolean,
  projectPath: string,
  sessionId: string,
): AntiAiTelemetrySink | null {
  if (!consent) return null
  return initAntiAiTelemetrySink(projectPath, sessionId, defaultTelemetrySinkDeps())
}

/**
 * 组合根在项目打开处调用：按同意初始化；切换项目前先 flush 上一项目残留缓冲。
 * 每次打开生成新的会话 id（用于段文件名）；遥测行 sessionId/projectId 由文件名承载。
 */
export async function applyAntiAiTelemetryConsentOnProjectOpen(projectPath: string): Promise<void> {
  const consent = await loadAntiAiTelemetryConsent()
  // 项目切换安全：先 flush 上一项目残留，再按同意状态决定 init / 保持关。
  await shutdownAntiAiTelemetrySink()
  if (consent) {
    initAntiAiTelemetryIfConsented(true, projectPath, createNovelSessionId())
  }
}
