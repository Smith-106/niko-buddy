import { readFile, writeFile, fileExists } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { InteractiveStoryGraph } from "./interactive-film-graph"

/**
 * interactive-io — Play 面板的 additive IO 层（65 号共识 A-qw：勿在组件内联读盘）。
 *
 * 文件契约：
 * - `<project>/.novel/interactive-graph.json` — 影游图（exportInteractiveStory 产物侧，Play 面消费）
 * - `<project>/.novel/play-session.json` — 崩溃续玩会话（choicePath 快照，Draft-first pending 区）
 */
const GRAPH_FILE = ".novel/interactive-graph.json"
const SESSION_FILE = ".novel/play-session.json"

export async function loadInteractiveGraph(projectPath: string): Promise<InteractiveStoryGraph | null> {
  const pp = normalizePath(projectPath)
  const p = `${pp}/${GRAPH_FILE}`
  if (!(await fileExists(p))) return null
  try {
    const raw = await readFile(p)
    const parsed = JSON.parse(raw) as InteractiveStoryGraph
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges) || typeof parsed.startId !== "string") {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export async function savePlaySession(projectPath: string, choicePath: string[]): Promise<void> {
  const pp = normalizePath(projectPath)
  await writeFile(`${pp}/${SESSION_FILE}`, JSON.stringify({ choicePath, savedAt: new Date().toISOString() }, null, 2))
}

export async function loadPlaySession(projectPath: string): Promise<string[] | null> {
  const pp = normalizePath(projectPath)
  const p = `${pp}/${SESSION_FILE}`
  if (!(await fileExists(p))) return null
  try {
    const raw = await readFile(p)
    const parsed = JSON.parse(raw) as { choicePath?: unknown }
    if (!Array.isArray(parsed.choicePath) || parsed.choicePath.some((c) => typeof c !== "string")) return null
    return parsed.choicePath
  } catch {
    return null
  }
}
