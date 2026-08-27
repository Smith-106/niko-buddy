import { writeFileAtomic, readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { useBookAnalysisStore } from "@/stores/book-analysis-store"
import type { BookAnalysisTask } from "@/lib/novel/book-analysis/types"

const TASKS_FILE = ".qmai/book-analysis-tasks.json"

function tasksFilePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${TASKS_FILE}`
}

/** Fields persisted to disk; volatile/large result fields are stripped (restored from per-book result dirs). */
type TaskSummary = Pick<
  BookAnalysisTask,
  | "id"
  | "projectPath"
  | "bookId"
  | "bookPath"
  | "config"
  | "metadata"
  | "progress"
  | "status"
  | "error"
  | "startedAt"
  | "updatedAt"
  | "chapters"
>

function toSummary(task: BookAnalysisTask): TaskSummary {
  return {
    id: task.id,
    projectPath: task.projectPath,
    bookId: task.bookId,
    bookPath: task.bookPath,
    config: task.config,
    metadata: task.metadata,
    progress: task.progress,
    status: task.status,
    error: task.error,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    chapters: task.chapters,
  }
}

/** Loads persisted task summaries for a project. Returns [] when the file is absent or unreadable. */
export async function loadTaskSummaries(projectPath: string): Promise<BookAnalysisTask[]> {
  try {
    const raw = await readFile(tasksFilePath(projectPath))
    const parsed = JSON.parse(raw) as TaskSummary[]
    return parsed as BookAnalysisTask[]
  } catch {
    return []
  }
}

/** Subscribes to store changes and persists task summaries (debounced). Returns an unsubscribe function. */
export function attachTaskPersistence(projectPath: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let previous = useBookAnalysisStore.getState()

  const unsubscribe = useBookAnalysisStore.subscribe((state) => {
    // Only persist if the task list reference changed.
    if (state.tasks === previous.tasks) {
      previous = state
      return
    }
    previous = state

    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      const summaries = state.tasks.map(toSummary)
      void writeFileAtomic(tasksFilePath(projectPath), JSON.stringify(summaries, null, 2)).catch(() => {
        // non-critical: persistence is best-effort
      })
    }, 500)
  })

  return () => {
    if (timer) clearTimeout(timer)
    unsubscribe()
  }
}
