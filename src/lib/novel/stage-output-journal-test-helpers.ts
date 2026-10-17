/** 测试专用：journal 内存依赖（供 director 生成/推进 spec 复用）。 */
import type { StageJournalDeps, StageJournalRuntime } from "./stage-output-journal"

export interface MemoryJournal {
  runtime: StageJournalRuntime
  files: Map<string, string>
  readonly writes: number
}

export function memoryJournal(now = 1_000): MemoryJournal {
  const files = new Map<string, string>()
  const state = { writes: 0 }
  const deps: StageJournalDeps = {
    read: async (path) => files.get(path) ?? "",
    writeFile: async (path, contents) => {
      state.writes += 1
      files.set(path, contents)
    },
    createDirectory: async () => {},
  }
  return {
    runtime: { projectId: "proj", deps, now: () => now, ttlMs: 60_000 },
    files,
    get writes() {
      return state.writes
    },
  }
}
