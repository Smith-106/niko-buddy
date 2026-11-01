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

/** 数组元素的「全为 string」判定（R-13 根因：非 string[] 交给下游 `.some` 会抛 TypeError）。 */
function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

/**
 * 校验模型自洽性。收集全部问题而非首错即返，便于一次修完。
 *
 * 覆盖五类错：① 根形状（根节点非对象 / schemaVersion 非数字 / volumes 非数组）；
 * ② 卷号/章号重复或非正整数；③ id 与 volume/chapter 不一致；④ 必填字符串为空（title）；
 * ⑤ 嵌套字段类型（entities/constraints/scenes 必须是 string[]，prose/foreshadow 必须是对象）。
 *
 * R-01/R-03/R-13：本函数是「损坏 JSON 不得变成可用模型」的最后一道闸。入参按未知形状处理，
 * 任何形状异常都只转成 issue 返回，**绝不抛异常**（数组闸在遍历前早退，正是 TypeError 的源头）。
 */
export function validateOutlineModel(model: OutlineModel): OutlineModelValidation {
  const issues: string[] = []
  const raw = model as unknown as Record<string, unknown> | null | undefined

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, issues: ["模型根节点不是对象"] }
  }

  if (typeof raw.schemaVersion !== "number") {
    issues.push(`schemaVersion 缺失或非数字：${String(raw.schemaVersion)}`)
  }
  if (raw.schemaVersion !== OUTLINE_MODEL_SCHEMA_VERSION) {
    issues.push(`schemaVersion 不支持：${String(raw.schemaVersion)}（期望 ${OUTLINE_MODEL_SCHEMA_VERSION}）`)
  }

  if (!Array.isArray(raw.volumes)) {
    // 必须早退：`for (const volume of undefined)` 正是 R-03 的 TypeError 源。
    issues.push("volumes 不是数组")
    return { ok: false, issues }
  }

  const seenVolumes = new Set<number>()
  for (const volumeItem of raw.volumes) {
    if (!volumeItem || typeof volumeItem !== "object" || Array.isArray(volumeItem)) {
      issues.push("卷节点不是对象")
      continue
    }
    const volume = volumeItem as Record<string, unknown>
    const volumeNumber = volume.number as number
    if (!Number.isInteger(volumeNumber) || volumeNumber <= 0) {
      issues.push(`卷号非法：${String(volume.number)}`)
    }
    if (seenVolumes.has(volumeNumber)) {
      issues.push(`卷号重复：${volumeNumber}`)
    }
    seenVolumes.add(volumeNumber)

    if (typeof volume.title !== "string") {
      issues.push(`卷 ${String(volume.number)} 的 title 必须是字符串`)
    }
    if (typeof volume.arc !== "string") {
      issues.push(`卷 ${String(volume.number)} 的 arc 必须是字符串`)
    }

    if (!Array.isArray(volume.chapters)) {
      issues.push(`卷 ${String(volume.number)} 的 chapters 不是数组`)
      continue
    }

    const seenChapters = new Set<number>()
    for (const chapterItem of volume.chapters) {
      if (!chapterItem || typeof chapterItem !== "object" || Array.isArray(chapterItem)) {
        issues.push("章节点不是对象")
        continue
      }
      const chapter = chapterItem as Record<string, unknown>
      const where = `v${String(volume.number)}c${String(chapter.chapter)}`
      const chapterNumber = chapter.chapter as number
      if (!Number.isInteger(chapterNumber) || chapterNumber <= 0) {
        issues.push(`章号非法：${where}`)
      }
      if (seenChapters.has(chapterNumber)) {
        issues.push(`章号重复：${where}`)
      }
      seenChapters.add(chapterNumber)

      const expected = outlineChapterId(volumeNumber, chapterNumber)
      if (chapter.id !== expected) {
        issues.push(`id 与卷章号不一致：${String(chapter.id)}（期望 ${expected}）`)
      }
      if (chapter.volume !== volumeNumber) {
        issues.push(
          `章归属卷号不一致：${String(chapter.id)} 声明 ${String(chapter.volume)}，实际在 ${volumeNumber}`,
        )
      }
      if (typeof chapter.title !== "string") {
        // 不得对非字符串调用 .trim()：那正是 R-03 重演的形态。
        issues.push(`章标题类型非法：${where}`)
      } else if (!chapter.title.trim()) {
        issues.push(`章标题为空：${where}`)
      }

      // 嵌套类型闸（R-13 根因）：非 string[] 交给消费侧 `.some` 会抛 TypeError。
      if (!isStringArray(chapter.entities)) issues.push(`${where} 的 entities 必须是 string[]`)
      if (!isStringArray(chapter.constraints)) issues.push(`${where} 的 constraints 必须是 string[]`)
      if (typeof chapter.pov !== "string") issues.push(`${where} 的 pov 必须是字符串`)
      if (typeof chapter.arc !== "string") issues.push(`${where} 的 arc 必须是字符串`)

      const prose = chapter.prose
      if (!prose || typeof prose !== "object" || Array.isArray(prose)) {
        issues.push(`${where} 的 prose 必须是对象`)
      } else {
        const built = prose as Record<string, unknown>
        if (typeof built.goal !== "string") issues.push(`${where} 的 prose.goal 必须是字符串`)
        if (!isStringArray(built.scenes)) issues.push(`${where} 的 prose.scenes 必须是 string[]`)
        if (typeof built.emotion !== "string") issues.push(`${where} 的 prose.emotion 必须是字符串`)
      }

      const foreshadow = chapter.foreshadow
      if (!foreshadow || typeof foreshadow !== "object" || Array.isArray(foreshadow)) {
        issues.push(`${where} 的 foreshadow 必须是对象`)
      } else {
        const built = foreshadow as Record<string, unknown>
        if (!isStringArray(built.plant)) issues.push(`${where} 的 foreshadow.plant 必须是 string[]`)
        if (!isStringArray(built.payoff)) issues.push(`${where} 的 foreshadow.payoff 必须是 string[]`)
      }
    }
  }

  return { ok: issues.length === 0, issues }
}

/**
 * 计划期 POV 规范化（R-23）：trim + 折行折叠为「 / 」+ 连续空格归一。
 *
 * 只规范化 pov：arc/goal 的同源往返不稳定另立债（DEBT-R23B），不在本函数里扩面。
 * 幂等：已规范值再规范化不变，故 render→parse 往返 contentKey 等值。
 */
export function normalizeOutlinePov(value: string): string {
  return value
    .trim()
    .replace(/\s*\n+\s*/g, " / ")
    .replace(/[ \t]{2,}/g, " ")
}

/**
 * 模型边界规范化（R-23）：深拷贝并只把每章 `pov` 换成 `normalizeOutlinePov`。
 *
 * 调用方：parse 出口（heading / frontmatter 结构化两条路径）与 render 入口侧。
 * **禁止**在 `saveOutlineModel` 内调用：save 的字节形态是 `JSON.stringify(model, null, 2)`
 * 原样写入（D5），在里面规范化会打破 spec 固化的字节断言。
 */
export function normalizeOutlineModel(model: OutlineModel): OutlineModel {
  return {
    ...model,
    volumes: model.volumes.map((volume) => ({
      ...volume,
      chapters: volume.chapters.map((chapter) => ({
        ...chapter,
        pov: normalizeOutlinePov(chapter.pov ?? ""),
      })),
    })),
  }
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
