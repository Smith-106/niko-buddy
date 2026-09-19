/**
 * run-event-ledger-store.ts — 波2-A 模块 18 接线：EB-4 运行事件账本持久化。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 模块 18 + 波2-A）：
 *   - 数据归口三分类之「事件」归口：过程事件一律落 `.novel/run-events.jsonl`
 *     （append-only JSONL，每行一条 RunEvent），不写 status.json（状态归口）
 *     也不写 kb 产物（资产归口）；
 *   - 落盘复用 run-event-ledger.ts 的 zod strict + seq 严格单调 + eventId
 *     唯一校验（load 逐行 appendRunEvent 重建）；损坏行 fail-loud（含行号），
 *     绝不静默丢事件（账本是「门结果未落事件=未发生」的唯一证据源）；
 *   - fs 注入 DI（仿 canon-dual-write CanonDualWriteDeps 先例）：机械层在
 *     spec/离线环境注入内存 deps，Tauri 环境走 createFsRunEventLedgerStoreDeps。
 *
 * 单写者假设（与 saveNovelSessionStatus 同纪律）：v1 追加 = 读+原子写
 * （@/commands/fs 无 append 原语），写路径包 withProjectLock（锁键
 * run-events:<file path>）；跨进程并发写由上层串行调用保证。
 * Rust append IPC 为 additive 后续项，本契约不变。
 *
 * @license MIT © Niko Buddy
 */

import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import {
  RunEventLedgerError,
  appendRunEvent,
  appendRunEvents,
  createRunEventLedger,
  type RunEvent,
  type RunEventInput,
  type RunEventLedger,
} from "./run-event-ledger"
import { withProjectLock } from "./novel-locks"

// ============================================================================
// 路径与 DI
// ============================================================================

/** 运行事件账本文件名（`.novel/run-events.jsonl`）。 */
export const RUN_EVENTS_FILENAME = "run-events.jsonl"

/** 运行事件账本路径：`{projectPath}/.novel/run-events.jsonl`。 */
export function runEventsPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.novel/${RUN_EVENTS_FILENAME}`
}

/** 文件系统依赖（注入；spec/离线环境用内存 fake）。 */
export interface RunEventLedgerStoreDeps {
  /** 读账本全文；文件不存在 → null（不得抛错）。 */
  readText: (path: string) => Promise<string | null>
  /** 追加文本块（append-only 语义；调用方保证行尾换行）。 */
  appendText: (path: string, text: string) => Promise<void>
  /** 可选目录创建（首写前调用，缺省不建）。 */
  ensureDir?: (dir: string) => Promise<void>
}

/** 默认生产 deps：Tauri fs 直 invoke；追加 = withProjectLock 内读+原子写。 */
export function createFsRunEventLedgerStoreDeps(): RunEventLedgerStoreDeps {
  return {
    readText: async (path) => {
      try {
        return await readFile(path)
      } catch {
        return null
      }
    },
    appendText: async (path, text) => {
      // 单写者假设 + 进程内互斥锁（锁键含文件路径，与 status 锁族键前缀区分）。
      await withProjectLock(`run-events:${path}`, async () => {
        let existing = ""
        try {
          existing = await readFile(path)
        } catch {
          existing = ""
        }
        await writeFileAtomic(path, existing + text)
      })
    },
    ensureDir: (dir) => createDirectory(dir),
  }
}

// ============================================================================
// 错误
// ============================================================================

/** 账本 store 错误（损坏行 fail-loud，含行号）。 */
export class RunEventLedgerStoreError extends RunEventLedgerError {
  constructor(message: string) {
    super(message)
    this.name = "RunEventLedgerStoreError"
  }
}

// ============================================================================
// load（重建账本）
// ============================================================================

/**
 * 从磁盘重建账本：文件缺失/空 → 空账本；逐行（空行容忍，CRLF 归一）JSON
 * 解析 + RUN_EVENT_SCHEMA 校验 + appendRunEvent 逐条重建（seq 单调/eventId
 * 唯一复用账本校验）；损坏行抛 StoreError 含行号——不静默丢事件。
 */
export async function loadRunEventLedgerStore(
  deps: RunEventLedgerStoreDeps,
  projectPath: string,
): Promise<RunEventLedger> {
  const raw = await deps.readText(runEventsPath(projectPath))
  if (raw === null || raw.length === 0) return createRunEventLedger()
  let ledger = createRunEventLedger()
  const lines = raw.split("\n")
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.replace(/\r$/, "").trim() ?? ""
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new RunEventLedgerStoreError(`run-events.jsonl 第 ${i + 1} 行非法 JSON（损坏行 fail-loud，不静默丢事件）`)
    }
    try {
      ledger = appendRunEvent(ledger, parsed as RunEventInput)
    } catch (err) {
      throw new RunEventLedgerStoreError(
        `run-events.jsonl 第 ${i + 1} 行契约违反: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return ledger
}

// ============================================================================
// append（seq 由账本长度派生；eventId 缺省确定性派生）
// ============================================================================

/** 追加事件输入（seq 由账本长度派生；eventId 缺省 `${kind}:${seq}`）。 */
export type RunEventAppendInput = Omit<RunEventInput, "seq" | "eventId"> & { eventId?: string }

/** 单行序列化（JSON 单行 + 尾换行；事件字段均 JSON 安全类型）。 */
function serializeEventLine(event: RunEvent): string {
  return `${JSON.stringify(event)}\n`
}

/** 单条追加：load → seq=length → appendRunEvent 校验 → appendText 落盘。 */
export async function appendRunEventToStore(
  deps: RunEventLedgerStoreDeps,
  projectPath: string,
  event: RunEventAppendInput,
): Promise<RunEventLedger> {
  const ledger = await loadRunEventLedgerStore(deps, projectPath)
  const seq = ledger.events.length
  const eventId = event.eventId ?? `${event.kind}:${seq}`
  const next = appendRunEvent(ledger, { ...event, seq, eventId } as RunEventInput)
  const appended = next.events[next.events.length - 1] as RunEvent
  await persistAppend(deps, projectPath, serializeEventLine(appended))
  return next
}

/** 批量追加：一次 load，seq 连续派生，单次落盘（半提交不落盘）。 */
export async function appendRunEventsToStore(
  deps: RunEventLedgerStoreDeps,
  projectPath: string,
  events: readonly RunEventAppendInput[],
): Promise<RunEventLedger> {
  const ledger = await loadRunEventLedgerStore(deps, projectPath)
  const prepared: RunEventInput[] = []
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i] as RunEventAppendInput
    const seq = ledger.events.length + prepared.length
    const eventId = event.eventId ?? `${event.kind}:${seq}`
    prepared.push({ ...event, seq, eventId } as RunEventInput)
  }
  const next = appendRunEvents(ledger, prepared)
  const chunk = next.events
    .slice(ledger.events.length)
    .map((e) => `${JSON.stringify(e)}\n`)
    .join("")
  if (chunk.length > 0) {
    await persistAppend(deps, projectPath, chunk)
  }
  return next
}

/** 落盘（首次写前建目录；目录创建失败随 append 抛错——观测层不得假成功）。 */
async function persistAppend(
  deps: RunEventLedgerStoreDeps,
  projectPath: string,
  chunk: string,
): Promise<void> {
  const path = runEventsPath(projectPath)
  if (deps.ensureDir) {
    await deps.ensureDir(path.slice(0, path.lastIndexOf("/")))
  }
  await deps.appendText(path, chunk)
}