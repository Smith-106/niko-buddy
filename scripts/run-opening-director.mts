import { writeFileSync } from "node:fs"
import { createDirectory, writeFileAtomic } from "../src/commands/fs.ts"
import {
  createDirectorPipeline,
  directorPipelineSummary,
} from "../src/lib/novel/director-pipeline.ts"
import { tryAdvanceDirectorFromProject } from "../src/lib/novel/director-orchestrator.ts"
import { saveDirectorPersisted } from "../src/lib/novel/director-pipeline-store.ts"

const projectPath = "C:/QM-BOOK/身体都是租的，你让我修仙？"
const idea = {
  title: "身体都是租的，你让我修仙？",
  genre: "都市修仙 / 悬疑",
  coreConflict: "毕业生白曦的身体被企业租用，债务与维护费到期后，他要用修仙体系和合同漏洞夺回身体自主权。",
}
const characterDir = `${projectPath}/wiki/entities/characters`
await createDirectory(characterDir)
const characters = [
  ["白曦", "主角", "身体被企业租赁的毕业生，目标是夺回身体自主权并揭开产业链。"],
  ["租赁公司", "主要对抗者", "掌控租赁合同、债务和身体回收权的企业体系。"],
  ["合同线索提供者", "盟友", "掌握合同漏洞与租赁产业内情，协助白曦反击。"],
]
for (const [name, role, motive] of characters) {
  await writeFileAtomic(`${characterDir}/${name}.md`, `# ${name}\n\n- **作品**：《${idea.title}》\n- **身份**：${role}\n- **核心动机**：${motive}\n`)
}
await writeFileAtomic(`${projectPath}/wiki/outlines/volume-plan.md`, [
  "# 分卷规划",
  "",
  "## 第一卷 债务到期（1-40章）",
  "白曦发现身体回收倒计时，学习基础修炼并找到第一处合同漏洞。",
  "",
  "## 第二卷 合同反制（41-90章）",
  "白曦联合线索提供者对抗租赁公司的法务与回收系统。",
  "",
  "## 第三卷 产业链（91-140章）",
  "追查身体租赁产业的上游，揭露培养债务的真实来源。",
  "",
  "## 第四卷 自主权（141-170章）",
  "白曦完成身体自主权夺回，并公开产业链真相。",
].join("\n"))

let state = createDirectorPipeline()
const phases = []
for (let i = 0; i < 5; i += 1) {
  const outcome = await tryAdvanceDirectorFromProject(projectPath, state, idea)
  phases.push({ phase: state.currentPhase, advanced: outcome.advanced, completed: outcome.completed, gap: outcome.gap || "" })
  state = outcome.state
  if (!outcome.advanced) break
}
await saveDirectorPersisted(projectPath, { fileVersion: 1, state, ideaInput: idea })
const out = `${projectPath}/.novel/opening-director.json`
writeFileSync(out, JSON.stringify({ phases, summary: directorPipelineSummary(state) }, null, 2))
console.log(directorPipelineSummary(state))
