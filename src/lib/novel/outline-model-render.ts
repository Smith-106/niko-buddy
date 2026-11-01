import {
  flattenOutlineChapters,
  findOutlineChapter,
  normalizeOutlinePov,
  type OutlineModel,
  type OutlineModelChapter,
  type OutlineModelVolume,
} from "./outline-model"

/**
 * 大纲模型 → Markdown 投影渲染器（人读版）。
 *
 * 契约：
 *   - **确定性**：同一模型必然渲染出逐字节相同的 Markdown（无时间戳、无随机）。
 *   - **幂等**：render(parse(render(m))) 与 render(m) 相等。
 *   - **可回读**：输出格式必须能被 outline-model-parse 解析回等价模型（往返不丢
 *     volume/chapter/title/arc/entities/foreshadow/constraints/prose 八类字段）。
 *     `pov` 经 `normalizeOutlinePov` 规范化后写出（trim + 折行折叠为「 / 」）：
 *     否则多行 pov 会注入新的 `### 场景` 小节，把内容搬到错误字段上（R-23）。
 *
 * 人读版是**投影**：结构字段由模型决定，人不在此改结构；只有 prose 三字段
 * （本章目标/场景/情绪）是作者的自由文本，回写时按字段边界处理。
 */

export interface RenderOutlineModelOptions {
  /** 内容摘要（computeOutlineModelDigest 的结果），写入 frontmatter 供漂移检测。 */
  digest?: string
}

const SECTION_ARC = "弧线"
const SECTION_POV = "视角"
const SECTION_GOAL = "本章目标"
const SECTION_SCENES = "场景"
const SECTION_EMOTION = "情绪"
const SECTION_ENTITIES = "登场"
const SECTION_FORESHADOW = "伏笔"
const SECTION_CONSTRAINTS = "约束"

function renderFrontmatter(pairs: string[]): string {
  return ["---", ...pairs, "---", ""].join("\n")
}

function renderList(items: string[]): string[] {
  return items.map((item, index) => `${index + 1}. ${item}`)
}

function renderBullets(items: string[]): string[] {
  return items.map((item) => `- ${item}`)
}

function renderChapterSections(chapter: OutlineModelChapter): string[] {
  const out: string[] = []

  if (chapter.arc.trim()) {
    out.push(`### ${SECTION_ARC}`, "", chapter.arc.trim(), "")
  }
  if (chapter.pov.trim()) {
    out.push(`### ${SECTION_POV}`, "", normalizeOutlinePov(chapter.pov), "")
  }
  if (chapter.prose.goal.trim()) {
    out.push(`### ${SECTION_GOAL}`, "", chapter.prose.goal.trim(), "")
  }
  if (chapter.prose.scenes.length > 0) {
    out.push(`### ${SECTION_SCENES}`, "", ...renderList(chapter.prose.scenes), "")
  }
  if (chapter.prose.emotion.trim()) {
    out.push(`### ${SECTION_EMOTION}`, "", chapter.prose.emotion.trim(), "")
  }
  if (chapter.entities.length > 0) {
    out.push(`### ${SECTION_ENTITIES}`, "", ...renderBullets(chapter.entities), "")
  }
  if (chapter.foreshadow.plant.length > 0 || chapter.foreshadow.payoff.length > 0) {
    out.push(`### ${SECTION_FORESHADOW}`, "")
    if (chapter.foreshadow.plant.length > 0) {
      out.push(`- 埋设：${chapter.foreshadow.plant.join("、")}`)
    }
    if (chapter.foreshadow.payoff.length > 0) {
      out.push(`- 回收：${chapter.foreshadow.payoff.join("、")}`)
    }
    out.push("")
  }
  if (chapter.constraints.length > 0) {
    out.push(`### ${SECTION_CONSTRAINTS}`, "", ...renderBullets(chapter.constraints), "")
  }
  return out
}

function renderVolume(volume: OutlineModelVolume, updatedAt: string): string[] {
  const out: string[] = [`# 第${volume.number}卷 ${volume.title}`.trim(), ""]
  if (volume.arc.trim()) {
    out.push(`## ${SECTION_ARC}`, "", volume.arc.trim(), "")
  }
  const chapters = volume.chapters.slice().sort((a, b) => a.chapter - b.chapter)
  for (const chapter of chapters) {
    const heading = `## 第${chapter.chapter}章 ${chapter.title}`.trim()
    out.push(heading, "")
    out.push(...renderChapterSections({ ...chapter, updatedAt }))
  }
  return out
}

/** 渲染整本大纲模型。 */
export function renderOutlineModelToMarkdown(
  model: OutlineModel,
  options: RenderOutlineModelOptions = {},
): string {
  const pairs = [
    "type: outline",
    "outline_type: outline-model",
    `schema_version: ${model.schemaVersion}`,
  ]
  if (options.digest) pairs.push(`outline_model_digest: ${options.digest}`)
  if (model.updatedAt) pairs.push(`outline_updated_at: ${model.updatedAt}`)

  const volumes = model.volumes.slice().sort((a, b) => a.number - b.number)
  const body = volumes.flatMap((volume) => renderVolume(volume, model.updatedAt))
  return `${renderFrontmatter(pairs)}\n${body.join("\n")}`.trimEnd() + "\n"
}

/**
 * 渲染单章（用于人读视图按章展开、或章纲单文件）。
 *
 * 走 frontmatter 结构化路径：卷/章/实体/伏笔/约束写入 frontmatter，正文只放
 * prose 与弧线，因此单章文件也能被解析器无损回读。
 */
export function renderOutlineChapterToMarkdown(
  model: OutlineModel,
  chapterId: string,
  options: RenderOutlineModelOptions = {},
): string {
  const chapter = flattenOutlineChapters(model).find((item) => item.id === chapterId)
  if (!chapter) {
    throw new Error(`outline-model: 未找到章节 ${chapterId}`)
  }
  const volume = model.volumes.find((item) => item.number === chapter.volume)
  const pairs = [
    "type: outline",
    "outline_type: chapter-outline",
    `volume: ${chapter.volume}`,
    `chapter: ${chapter.chapter}`,
    `title: ${JSON.stringify(chapter.title)}`,
  ]
  if (chapter.pov.trim()) pairs.push(`pov: ${JSON.stringify(normalizeOutlinePov(chapter.pov))}`)
  if (chapter.arc.trim()) pairs.push(`arc: ${JSON.stringify(chapter.arc)}`)
  if (volume && volume.title) pairs.push(`volume_title: ${JSON.stringify(volume.title)}`)
  if (chapter.entities.length > 0) pairs.push(`entities: ${JSON.stringify(chapter.entities)}`)
  if (chapter.foreshadow.plant.length > 0) {
    pairs.push(`foreshadow_plant: ${JSON.stringify(chapter.foreshadow.plant)}`)
  }
  if (chapter.foreshadow.payoff.length > 0) {
    pairs.push(`foreshadow_payoff: ${JSON.stringify(chapter.foreshadow.payoff)}`)
  }
  if (chapter.constraints.length > 0) pairs.push(`constraints: ${JSON.stringify(chapter.constraints)}`)
  if (options.digest) pairs.push(`outline_model_digest: ${options.digest}`)
  if (chapter.updatedAt) pairs.push(`outline_updated_at: ${chapter.updatedAt}`)

  // pov / arc 已在 frontmatter（结构化字段），正文不再重复一份：否则回读时
  // 「frontmatter + ### 视角」双源会被 appendText 合并成「李慕白 / 李慕白」。
  const body = renderChapterSections({ ...chapter, arc: "", pov: "" })
  const heading = `# 第${chapter.chapter}章 ${chapter.title}`.trim()
  return `${renderFrontmatter(pairs)}\n${[heading, "", ...body].join("\n")}`.trimEnd() + "\n"
}

/** 便于调用方按「卷章」直接取渲染结果，未命中返回 null。 */
export function renderOutlineChapterByPosition(
  model: OutlineModel,
  volume: number,
  chapter: number,
  options: RenderOutlineModelOptions = {},
): string | null {
  const found = findOutlineChapter(model, volume, chapter)
  if (!found) return null
  return renderOutlineChapterToMarkdown(model, found.id, options)
}
