/**
 * 工作流/大纲模板注册表（EPIC「工作流/大纲模板注册表」：**只读登记**，零新真源）。
 *
 * 真源（唯一，本模块不复制、不改写、不派生第二份）：
 * - `outline-templates.ts` 的 6 个常量 + 2 个模板渲染函数
 * - `novel-skill-hooks.ts` 的 `NovelSkillStage` 联合类型（stage 列表）
 *
 * 诚实边界（每条都对应一次可复核的取舍）：
 * 1. 注册表**不存模板正文**：只登记必填字段名、枚举取值、`源文件:符号名`，
 *    以及**一次哨兵渲染**的首行 + 全文字符数（正文留在真源文件里）。
 * 2. 渲染失败（抛错 / 非字符串 / 空串）→ `templateStatus: "failed"` + `error` 文案，
 *    `templateHead` 为 `null`——**绝不写空串冒充成功**。
 * 3. 真源没有渲染函数的条目（枚举清单、`CHAPTER_BLUEPRINT_FIELDS`、技能 stage）
 *    → `templateStatus: "not-applicable"`，不借用别的渲染函数冒充。
 * 4. `novel-skill-hooks.ts` 只导出 stage **联合类型**、没有运行期数组：本模块用全量
 *    `Record<NovelSkillStage, true>` 把它落成运行期列表——联合类型新增成员时这里是
 *    **编译错误**（缺键），不是静默漂移。
 * 5. 枚举 → 模板的链接规则（可复核）：仅当 (a) 模板含**同名章节/字段**，(b) 常量 doc
 *    注释声明同名目标字段时，才挂到该模板条目上，并用 `linkedField` 记录挂载依据。
 *    反例（因此**不链接**）：`CHAPTER_POSITION_TYPES`（「六类章节定位标签枚举」）与
 *    `getChapterOutlineTemplate` 里「章节定位：开篇 / 推进 / 高压 / …」的取值**不一致**。
 * 6. 分组与排序一律**码点比较**（`a < b`），不用 `localeCompare`（避免语言环境抖动）。
 */
import {
  CHAPTER_BLUEPRINT_FIELDS,
  CHAPTER_END_HOOK_TYPES,
  CHAPTER_HOOK_TYPES,
  CHAPTER_OUTLINE_REQUIRED_SECTIONS,
  CHAPTER_POSITION_TYPES,
  getChapterOutlineTemplate,
  getVolumeOutlineTemplate,
  VOLUME_OUTLINE_REQUIRED_FIELDS,
} from "./outline-templates"
import type { NovelSkillStage } from "./novel-skill-hooks"

/** 条目类别：`volume` / `chapter` 为模板类，其余（枚举清单、技能挂点）归「其他」。 */
export type WorkflowTemplateKind = "chapter" | "enum" | "skill-stage" | "volume"

/** 模板渲染状态；`not-applicable` = 真源里没有可渲染的模板函数（显式 N/A，不是失败）。 */
export type WorkflowTemplateRenderStatus = "rendered" | "failed" | "not-applicable"

/** 枚举引用：名称 + 取值 + 挂载依据（`linkedField` 为 null = 未链接任何模板字段）。 */
export interface WorkflowTemplateEnumRef {
  /** 源常量名（如 `CHAPTER_HOOK_TYPES`）。 */
  readonly name: string
  /** 该枚举在模板里对应的字段/章节名；`null` = 未建立链接（见模块头第 5 条）。 */
  readonly linkedField: string | null
  /** 取值个数（= `values.length`，冗余但便于 UI/断言）。 */
  readonly valueCount: number
  /** 取值本身（真源常量的只读副本，顺序与真源一致）。 */
  readonly values: readonly string[]
  /** `源文件:符号名`。 */
  readonly source: string
}

/** 一条只读登记项。 */
export interface WorkflowTemplateEntry {
  /** 稳定 id（码点序排列，UI 不抖动）。 */
  readonly id: string
  readonly kind: WorkflowTemplateKind
  /** 人类可读标题（取自真源 doc 注释，不新造语义）。 */
  readonly title: string
  /** 必填字段/章节名（真源常量原样）。 */
  readonly requiredFields: readonly string[]
  /** = `requiredFields.length`。 */
  readonly requiredFieldCount: number
  /** 关联枚举清单。 */
  readonly enums: readonly WorkflowTemplateEnumRef[]
  /** 枚举清单**条数**。 */
  readonly enumListCount: number
  /** 枚举**取值总数**（各清单 `valueCount` 之和）。 */
  readonly enumValueCount: number
  /** `源文件:符号名`（多个符号用 `,` 连接）。 */
  readonly source: string
  readonly templateStatus: WorkflowTemplateRenderStatus
  /** 哨兵渲染的**首行**（超长截断）；未渲染/失败为 `null`（不是空串）。 */
  readonly templateHead: string | null
  /** 哨兵渲染全文的字符数；未渲染/失败为 0。 */
  readonly templateLength: number
  /**
   * 渲染正文里**没出现**的必填字段名（如实列出，不补内容）。
   * `null` = 无渲染结果，无法判定（与「空数组 = 全部出现」区分开）。
   */
  readonly missingRequiredFieldNames: readonly string[] | null
  /** 渲染失败原因；成功或 N/A 时为 `null`。 */
  readonly error: string | null
}

/** 按类别分组（组间与组内均按码点排序）。 */
export interface WorkflowTemplateGroup {
  readonly kind: WorkflowTemplateKind
  readonly entries: readonly WorkflowTemplateEntry[]
}

/** 可注入的渲染函数（测试可替换，用于验证失败降级路径；默认即真源函数）。 */
export interface WorkflowTemplateRenderers {
  readonly volumeOutline?: (volumeNumber: number, title: string, chapterRange: string) => unknown
  readonly chapterOutline?: (chapterNumber: number, title: string) => unknown
}

/** 首行预览最大字符数（注册表是索引，不是模板正文存档）。 */
export const WORKFLOW_TEMPLATE_HEAD_MAX = 120

/** 渲染哨兵：一眼能看出是占位符，且不触发任何真实分支。 */
export const WORKFLOW_TEMPLATE_TITLE_SENTINEL = "«title»"
export const WORKFLOW_TEMPLATE_RANGE_SENTINEL = "«chapterRange»"

const OUTLINE_SOURCE = "outline-templates.ts"
const HOOKS_SOURCE = "novel-skill-hooks.ts"

/** 码点比较（不用 localeCompare）。 */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * stage 真源 = 联合类型 `NovelSkillStage`（`novel-skill-hooks.ts` 无运行期数组）。
 * 全量 Record 即编译期清单：联合类型新增成员 → 这里缺键 → 编译错误（不是静默漂移）。
 */
const SKILL_STAGE_DECLARATION: Record<NovelSkillStage, true> = {
  pre_outline_soft_gate: true,
  pre_write_prompt: true,
  post_draft_light_check: true,
  pre_six_dim_review: true,
  post_gate_literary_polish: true,
}

/** stage 运行期列表（码点序）。`Object.keys` 的结果是 `string[]`，此处按已声明的键收窄。 */
export const NOVEL_SKILL_STAGES: readonly NovelSkillStage[] = (
  Object.keys(SKILL_STAGE_DECLARATION) as NovelSkillStage[]
).sort(byCodePoint)

function enumRef(
  name: string,
  values: readonly string[],
  linkedField: string | null,
): WorkflowTemplateEnumRef {
  return {
    name,
    linkedField,
    valueCount: values.length,
    values: [...values],
    source: `${OUTLINE_SOURCE}:${name}`,
  }
}

interface RenderedTemplate {
  readonly status: WorkflowTemplateRenderStatus
  readonly head: string | null
  readonly length: number
  readonly error: string | null
  /** 仅内部用于算 `missingRequiredFieldNames`；**不进 entry**（注册表不存正文）。 */
  readonly text: string | null
}

/** 哨兵渲染一次；抛错/非字符串/空串 → failed + error（不写空串）。 */
function renderTemplate(render: (() => unknown) | null, label: string): RenderedTemplate {
  if (render === null) {
    return { status: "not-applicable", head: null, length: 0, error: null, text: null }
  }
  let output: unknown
  try {
    output = render()
  } catch (error) {
    return {
      status: "failed",
      head: null,
      length: 0,
      error: `${label}渲染抛错：${error instanceof Error ? error.message : String(error)}`,
      text: null,
    }
  }
  if (typeof output !== "string") {
    return {
      status: "failed",
      head: null,
      length: 0,
      error: `${label}渲染结果不是字符串（${typeof output}）`,
      text: null,
    }
  }
  if (output.trim().length === 0) {
    return {
      status: "failed",
      head: null,
      length: 0,
      error: `${label}渲染结果为空字符串`,
      text: null,
    }
  }
  const firstLine = output.split("\n")[0] ?? ""
  const head =
    firstLine.length > WORKFLOW_TEMPLATE_HEAD_MAX
      ? `${firstLine.slice(0, WORKFLOW_TEMPLATE_HEAD_MAX)}…`
      : firstLine
  return { status: "rendered", head, length: output.length, error: null, text: output }
}

interface EntrySpec {
  readonly id: string
  readonly kind: WorkflowTemplateKind
  readonly title: string
  readonly requiredFields: readonly string[]
  readonly enums: readonly WorkflowTemplateEnumRef[]
  readonly source: string
  readonly render: (() => unknown) | null
}

function buildEntry(spec: EntrySpec): WorkflowTemplateEntry {
  const rendered = renderTemplate(spec.render, spec.title)
  const text = rendered.text
  return {
    id: spec.id,
    kind: spec.kind,
    title: spec.title,
    requiredFields: [...spec.requiredFields],
    requiredFieldCount: spec.requiredFields.length,
    enums: spec.enums,
    enumListCount: spec.enums.length,
    enumValueCount: spec.enums.reduce((sum, ref) => sum + ref.valueCount, 0),
    source: spec.source,
    templateStatus: rendered.status,
    templateHead: rendered.head,
    templateLength: rendered.length,
    // 整词/标题行匹配，不用裸子串：否则「爽点节奏」会被「爽点节奏表」算成已出现，
    // 「关键反转」会被「本卷关键反转」算成已出现（审查发现）。
    missingRequiredFieldNames: text === null ? null : spec.requiredFields.filter((field) => !hasFieldLine(text, field)),
    error: rendered.error,
  }
}

/** 行首整词匹配：去掉列表符号/编号/标题符号后，行首等于字段名才算"已声明该字段"。 */
export function hasFieldLine(text: string, field: string): boolean {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine
      // 先去掉加粗标记（`*` 不属于字段名），再去列表/标题/表格/序数前缀，避免「**字段**：说明」漏报
      .replace(/\*/g, "")
      .replace(/^[\s>#\-+|]+/, "")
      .replace(/^(?:[一二三四五六七八九十]+[、.]|第[一二三四五六七八九十\d]+[章节])\s*/, "")
      .replace(/^\d+[.、)]\s*/, "")
      .replace(/[\s|]+$/, "")
      .trim()
    if (line === field) return true
    if (!line.startsWith(field)) continue
    // 只认紧跟字段名的冒号/括号分隔或表格单元格结束（`|`）；
    // 「字段 补充」这类纯空格后接后文不算声明了该字段（审查点 3）。
    if (/^[:：（(【\[]|^\s*\|/.test(line.slice(field.length))) return true
  }
  return false
}

function entrySpecs(
  volumeRender: (volumeNumber: number, title: string, chapterRange: string) => unknown,
  chapterRender: (chapterNumber: number, title: string) => unknown,
): EntrySpec[] {
  const volumeArgs = [1, WORKFLOW_TEMPLATE_TITLE_SENTINEL, WORKFLOW_TEMPLATE_RANGE_SENTINEL] as const
  const chapterArgs = [1, WORKFLOW_TEMPLATE_TITLE_SENTINEL] as const

  const stageSpecs: EntrySpec[] = NOVEL_SKILL_STAGES.map((stage) => ({
    id: `skill-stage-${stage.split("_").join("-")}`,
    kind: "skill-stage",
    title: `技能挂点 stage：${stage}`,
    requiredFields: [],
    enums: [],
    source: `${HOOKS_SOURCE}:NovelSkillStage`,
    render: null,
  }))

  return [
    {
      id: "volume-outline",
      kind: "volume",
      title: "卷纲模板（VOLUME_OUTLINE_REQUIRED_FIELDS · getVolumeOutlineTemplate）",
      requiredFields: VOLUME_OUTLINE_REQUIRED_FIELDS,
      enums: [],
      source: `${OUTLINE_SOURCE}:VOLUME_OUTLINE_REQUIRED_FIELDS,getVolumeOutlineTemplate`,
      render: () => volumeRender(...volumeArgs),
    },
    {
      id: "chapter-outline",
      kind: "chapter",
      title: "AI 大纲工作台章纲（CHAPTER_OUTLINE_REQUIRED_SECTIONS · getChapterOutlineTemplate）",
      requiredFields: CHAPTER_OUTLINE_REQUIRED_SECTIONS,
      enums: [
        enumRef("CHAPTER_HOOK_TYPES", CHAPTER_HOOK_TYPES, "章首钩子"),
        enumRef("CHAPTER_END_HOOK_TYPES", CHAPTER_END_HOOK_TYPES, "章尾钩子"),
      ],
      source: `${OUTLINE_SOURCE}:CHAPTER_OUTLINE_REQUIRED_SECTIONS,getChapterOutlineTemplate`,
      render: () => chapterRender(...chapterArgs),
    },
    {
      id: "chapter-blueprint",
      kind: "chapter",
      title: "细纲新版章节蓝图字段（CHAPTER_BLUEPRINT_FIELDS）",
      requiredFields: CHAPTER_BLUEPRINT_FIELDS,
      enums: [],
      source: `${OUTLINE_SOURCE}:CHAPTER_BLUEPRINT_FIELDS`,
      // 真源无独立渲染函数 → 显式 N/A（不借用章纲渲染冒充）。
      render: null,
    },
    {
      id: "chapter-hook-types",
      kind: "enum",
      title: "章首钩子 7 种类型枚举（CHAPTER_HOOK_TYPES）",
      requiredFields: [],
      enums: [enumRef("CHAPTER_HOOK_TYPES", CHAPTER_HOOK_TYPES, "章首钩子")],
      source: `${OUTLINE_SOURCE}:CHAPTER_HOOK_TYPES`,
      render: null,
    },
    {
      id: "chapter-end-hook-types",
      kind: "enum",
      title: "章尾钩子 13 种类型枚举（CHAPTER_END_HOOK_TYPES）",
      requiredFields: [],
      enums: [enumRef("CHAPTER_END_HOOK_TYPES", CHAPTER_END_HOOK_TYPES, "章尾钩子")],
      source: `${OUTLINE_SOURCE}:CHAPTER_END_HOOK_TYPES`,
      render: null,
    },
    {
      id: "chapter-position-types",
      kind: "enum",
      title: "六类章节定位标签枚举（CHAPTER_POSITION_TYPES）",
      requiredFields: [],
      // 与章纲模板「章节定位：开篇 / 推进 / …」取值不一致 → 不链接（模块头第 5 条）。
      enums: [enumRef("CHAPTER_POSITION_TYPES", CHAPTER_POSITION_TYPES, null)],
      source: `${OUTLINE_SOURCE}:CHAPTER_POSITION_TYPES`,
      render: null,
    },
    ...stageSpecs,
  ]
}

/**
 * 枚举注册表：纯函数、零 IO、零 LLM、零时间依赖（两次调用结果深度相等）。
 *
 * @param renderers 注入渲染函数（测试用）；默认即真源 `getVolumeOutlineTemplate` /
 *                  `getChapterOutlineTemplate`。
 */
export function listWorkflowTemplateRegistry(
  renderers: WorkflowTemplateRenderers = {},
): WorkflowTemplateEntry[] {
  const volumeRender = renderers.volumeOutline ?? getVolumeOutlineTemplate
  const chapterRender = renderers.chapterOutline ?? getChapterOutlineTemplate
  return entrySpecs(volumeRender, chapterRender)
    .map(buildEntry)
    .sort((a, b) => byCodePoint(a.id, b.id))
}

/** 按 `kind` 分组；组间与组内均按码点排序（UI 不抖动）。 */
export function groupWorkflowTemplates(
  entries: readonly WorkflowTemplateEntry[],
): WorkflowTemplateGroup[] {
  const byKind = new Map<WorkflowTemplateKind, WorkflowTemplateEntry[]>()
  for (const entry of entries) {
    const bucket = byKind.get(entry.kind)
    if (bucket) bucket.push(entry)
    else byKind.set(entry.kind, [entry])
  }
  return [...byKind.entries()]
    .sort((a, b) => byCodePoint(a[0], b[0]))
    .map(([kind, group]) => ({
      kind,
      entries: [...group].sort((a, b) => byCodePoint(a.id, b.id)),
    }))
}
