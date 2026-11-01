import { computeCheckpointDigestOf } from "./checkpoint-digest"

/**
 * 大纲模型（outline-model）——结构化大纲真源的类型与纯函数层。
 *
 * 定位（双轨架构）：
 *   - **AI 读这一份**：字段可寻址（卷/章/场景/实体/伏笔/约束），替代「整段长文本
 *     + substring 猜测」的现状（context-engine 的 outline 字符串）。
 *   - **人读另一份**：由 outline-model-render 渲染出的 Markdown 投影，人不直接改
 *     结构字段，只改 prose（本章目标/场景/情绪）。
 *
 * 命名：不叫 canon——仓库内 `canon` 已被事实三表占用（src-tauri/src/canon/*，
 * 实体/边/章节快照 + 时态三层 + POV 认知轴），两者语义不同，不可混用。
 *
 * 本文件零 IO、零 LLM，可被单测直接覆盖。
 */

export const OUTLINE_MODEL_SCHEMA_VERSION = 2

/** 本章散文部分：人类作者的自由文本，渲染回人读版时可编辑。 */
export interface OutlineModelProse {
  /** 本章目标（一句话说清这章要完成什么）。 */
  goal: string
  /** 场景序列，保持作者排列顺序。 */
  scenes: string[]
  /** 情绪线 / 读者感受曲线。 */
  emotion: string
}

/** 伏笔引用：埋设与回收分开，供台账对账。 */
export interface OutlineModelForeshadow {
  /** 本章埋设的伏笔 ID。 */
  plant: string[]
  /** 本章回收的伏笔 ID。 */
  payoff: string[]
}

export interface OutlineModelChapter {
  /** 稳定锚点，形如 `v02c012`；由 volume/chapter 派生，不手写。 */
  id: string
  volume: number
  chapter: number
  title: string
  /**
   * 计划期 POV（写作前意图，人名）。
   * 边界（BG-2）：实际 POV 仍以 `.novel/snapshots/*.snapshot.json` 的 `povCharacter` 为准
   * （resolveChapterPovCharacter）；本字段禁止被当作「实际 POV」消费，也禁止新增第三套 POV 解析路径。
   */
  pov: string
  /** 所属弧线 / 小高潮名，可空。 */
  arc: string
  /** 显式登场实体名。替代 `outlineText.includes(entityName)` 的猜测。 */
  entities: string[]
  foreshadow: OutlineModelForeshadow
  /** 显式约束 / 禁止项（如「苏七本章不出场」）。 */
  constraints: string[]
  prose: OutlineModelProse
  /** ISO 时间戳；由写入方用 utils.todayStamp 或调用方注入。 */
  updatedAt: string
}

export interface OutlineModelVolume {
  number: number
  title: string
  /** 本卷弧线概述。 */
  arc: string
  chapters: OutlineModelChapter[]
}

export interface OutlineModel {
  schemaVersion: number
  volumes: OutlineModelVolume[]
  updatedAt: string
}

export interface OutlineModelValidation {
  ok: boolean
  issues: string[]
}

const ID_RE = /^v(\d{2,})c(\d{3,})$/

/** 由卷号/章号派生稳定锚点（卷补 2 位、章补 3 位）。 */
export function outlineChapterId(volume: number, chapter: number): string {
  return `v${String(volume).padStart(2, "0")}c${String(chapter).padStart(3, "0")}`
}

/** 反解锚点；格式不合法返回 null。 */
export function parseOutlineChapterId(id: string): { volume: number; chapter: number } | null {
  const matched = ID_RE.exec(id)
  if (!matched) return null
  const volume = Number(matched[1])
  const chapter = Number(matched[2])
  if (!Number.isFinite(volume) || !Number.isFinite(chapter)) return null
  return { volume, chapter }
}

/** 空模型骨架，供导入器/新建流程起手。 */
export function emptyOutlineModel(updatedAt: string): OutlineModel {
  return { schemaVersion: OUTLINE_MODEL_SCHEMA_VERSION, volumes: [], updatedAt }
}

/** 按卷号/章号取章，未命中返回 null。 */
export function findOutlineChapter(
  model: OutlineModel,
  volume: number,
  chapter: number,
): OutlineModelChapter | null {
  const target = model.volumes.find((item) => item.number === volume)
  if (!target) return null
  return target.chapters.find((item) => item.chapter === chapter) ?? null
}

/** 拍平成章列表（卷号升序、章号升序）。 */
export function flattenOutlineChapters(model: OutlineModel): OutlineModelChapter[] {
  return model.volumes
    .slice()
    .sort((a, b) => a.number - b.number)
    .flatMap((volume) => volume.chapters.slice().sort((a, b) => a.chapter - b.chapter))
}

/**
 * 校验模型自洽性。收集全部问题而非首错即返，便于一次修完。
 *
 * 覆盖四类错：① 卷号/章号重复或非正整数；② id 与 volume/chapter 不一致；
 * ③ 必填字符串为空（title）；④ schemaVersion 不受支持。
 */
export function validateOutlineModel(model: OutlineModel): OutlineModelValidation {
  const issues: string[] = []

  if (model.schemaVersion !== OUTLINE_MODEL_SCHEMA_VERSION) {
    issues.push(`schemaVersion 不支持：${model.schemaVersion}（期望 ${OUTLINE_MODEL_SCHEMA_VERSION}）`)
  }

  const seenVolumes = new Set<number>()
  for (const volume of model.volumes) {
    if (!Number.isInteger(volume.number) || volume.number <= 0) {
      issues.push(`卷号非法：${volume.number}`)
    }
    if (seenVolumes.has(volume.number)) {
      issues.push(`卷号重复：${volume.number}`)
    }
    seenVolumes.add(volume.number)

    const seenChapters = new Set<number>()
    for (const chapter of volume.chapters) {
      const where = `v${volume.number}c${chapter.chapter}`
      if (!Number.isInteger(chapter.chapter) || chapter.chapter <= 0) {
        issues.push(`章号非法：${where}`)
      }
      if (seenChapters.has(chapter.chapter)) {
        issues.push(`章号重复：${where}`)
      }
      seenChapters.add(chapter.chapter)

      const expected = outlineChapterId(volume.number, chapter.chapter)
      if (chapter.id !== expected) {
        issues.push(`id 与卷章号不一致：${chapter.id}（期望 ${expected}）`)
      }
      if (chapter.volume !== volume.number) {
        issues.push(`章归属卷号不一致：${chapter.id} 声明 ${chapter.volume}，实际在 ${volume.number}`)
      }
      if (!chapter.title.trim()) {
        issues.push(`章标题为空：${where}`)
      }
    }
  }

  return { ok: issues.length === 0, issues }
}

/** 内容摘要（忽略 updatedAt，便于比较「内容是否变化」）。 */
export function outlineModelContentKey(model: OutlineModel): string {
  return JSON.stringify({
    schemaVersion: model.schemaVersion,
    volumes: model.volumes.map((volume) => ({
      number: volume.number,
      title: volume.title,
      arc: volume.arc,
      chapters: volume.chapters.map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        pov: chapter.pov ?? "",
        arc: chapter.arc,
        entities: chapter.entities,
        foreshadow: chapter.foreshadow,
        constraints: chapter.constraints,
        prose: chapter.prose,
      })),
    })),
  })
}

/** 内容摘要的 SHA-256（复用 checkpoint-digest 的规范化序列化）。 */
export async function computeOutlineModelDigest(model: OutlineModel): Promise<string> {
  return computeCheckpointDigestOf(JSON.parse(outlineModelContentKey(model)))
}
