import { readSoulDoc } from "../src/lib/novel/soul-doc.ts"
import { buildWikiGraph } from "../src/lib/wiki-graph.ts"
import { searchWiki } from "../src/lib/search.ts"
import { collectHealthReport } from "../src/lib/diagnostics/health-check.ts"
import { loadBinding } from "../src/lib/novel/story-simulation/framework-binding.ts"
import { loadFrameworks } from "../src/lib/novel/story-simulation/framework-store.ts"
import { loadForeshadowingTracker } from "../src/lib/novel/foreshadowing-tracker.ts"
import { listEntityFiles } from "../src/lib/novel/entity-subdir-resolver.ts"
import { loadDirectorPersisted } from "../src/lib/novel/director-pipeline-store.ts"
import { listSnapshots } from "../src/lib/novel/chapter-ingest.ts"
import { DEFAULT_SKILL_HUB_SKILLS } from "../src/lib/novel/skill-hub-seed.ts"
import { loadWorldBlueprint, validateWorldBlueprint } from "../src/lib/novel/world-blueprint.ts"

const projectPath = "C:/QM-BOOK/身体都是租的，你让我修仙？"
const report: Record<string, unknown> = {}
async function step(name: string, run: () => Promise<unknown>) {
  try { report[name] = await run() } catch (error) { report[name] = { error: error instanceof Error ? error.message : String(error) } }
}
await step("soul", async () => ({ chars: (await readSoulDoc(projectPath)).length }))
await step("world", async () => {
  const bp = await loadWorldBlueprint(projectPath)
  return { verdict: bp ? validateWorldBlueprint(bp).verdict : "missing" }
})
await step("characters", async () => (await listEntityFiles(projectPath)).map((item) => item.name))
await step("director", async () => {
  const file = await loadDirectorPersisted(projectPath)
  return { phase: file.state.currentPhase, statuses: file.state.statuses, title: file.ideaInput.title }
})
await step("search", async () => (await searchWiki(projectPath, "白曦")).slice(0, 5).map((item) => item.path ?? item.title ?? item.file))
await step("graph", async () => {
  const graph = await buildWikiGraph(projectPath)
  return { nodes: graph.nodes?.length ?? 0, edges: graph.edges?.length ?? 0 }
})
await step("memory", async () => {
  const store = await loadForeshadowingTracker(projectPath)
  return { foreshadows: store.items?.length ?? store.entries?.length ?? Object.keys(store).length }
})
await step("skills", async () => ({ bundled: DEFAULT_SKILL_HUB_SKILLS.length }))
await step("simulation", async () => {
  const binding = await loadBinding(projectPath)
  const frameworks = await loadFrameworks(projectPath)
  return { bound: Boolean(binding), frameworks: frameworks.length }
})
await step("snapshots", async () => await listSnapshots(projectPath))
await step("diagnostics", async () => {
  const health = await collectHealthReport({ projectPath, llmCfg: { provider: "custom", model: "deepseek-v4.1-flash", customEndpoint: "https://ollama.com/v1", apiKey: "configured" } as never })
  return { overall: health.overall, items: health.items.map((item) => ({ id: item.id, status: item.status })) }
})
console.log(JSON.stringify(report, null, 2))
