/**
 * R-anwa-3 (26 审计落地): CoverBrief — 封面需求契约（provider 无关）.
 *
 * 吸收来源：reference/AI-Novel-Writing-Assistant server/src/services/image/
 * （ImageGen 图像生成）。26 号审计三票 worth_absorbing（ds value7 封面刚需 /
 * GLM value6 / hy3 value8）。裁决：不建图像流水线（立绘/分镜属 IP 衍生
 * positioning），仅落地「封面 brief 确定性契约」——从书籍元数据生成结构化
 * 封面需求，供任意外部图像 provider 消费；契约校验确定性。
 */

export interface BookCoverMeta {
  title: string
  genre: string
  /** 主角色一句话（外形/气质）。 */
  protagonistBrief: string
  /** 全书基调（如 热血/悬疑/温暖）。 */
  tone: string
  /** 关键意象词（如 剑、霓虹、古卷）。 */
  keyImagery: string[]
}

export interface CoverBrief {
  /** 画面主体描述。 */
  subject: string
  /** 构图（如 竖版人物居中/场景俯瞰）。 */
  composition: string
  /** 色调方案（主色+辅色描述）。 */
  palette: string
  /** 氛围关键词。 */
  moodKeywords: string[]
  /** 文字位（书名排布建议）。 */
  titlePlacement: "top" | "center" | "bottom"
  /** 底线约束（如 无真人脸、留白比例）。 */
  constraints: string[]
}

/** 题材 → 默认视觉语言的确定性映射（吸收 ANWA genre 服务按题材分治思路）。 */
const GENRE_VISUAL: Record<string, { palette: string; composition: string; mood: string[] }> = {
  都市: { palette: "霓虹冷色 + 深灰底", composition: "竖版人物居中，城市天际线背景", mood: ["现代", "紧张", "都市感"] },
  玄幻: { palette: "金橙 + 深蓝对比", composition: "竖版人物居中，法相/元素特效环绕", mood: ["宏大", "神秘", "史诗"] },
  悬疑: { palette: "暗青 + 单点暖光", composition: "场景局部特写，留白压迫", mood: ["压抑", "悬念", "冷峻"] },
  科幻: { palette: "银蓝 + 荧光青", composition: "竖版主体 + 几何科技结构", mood: ["未来", "理性", "疏离"] },
  历史: { palette: "宣纸米色 + 墨色", composition: "横卷式场景，人物点景", mood: ["厚重", "古意", "苍茫"] },
}

const DEFAULT_VISUAL = { palette: "低饱和中性色 + 单点强调色", composition: "竖版人物居中", mood: ["沉稳", "故事感"] }

/**
 * 从书籍元数据生成封面 brief。确定性：同输入同输出；
 * 未知题材走 DEFAULT_VISUAL。
 */
export function buildCoverBrief(meta: BookCoverMeta): CoverBrief {
  const visual = GENRE_VISUAL[meta.genre] ?? DEFAULT_VISUAL
  const subject = `${meta.protagonistBrief}，${meta.keyImagery.length > 0 ? `核心意象：${meta.keyImagery.join("、")}` : "无特定意象"}`
  const constraints = ["书名文字清晰可读", "主体与文字位不重叠", `基调贴合「${meta.tone}」`]
  if (meta.tone.includes("悬疑") || meta.tone.includes("暗") || meta.tone.includes("压抑")) {
    constraints.push("避免高饱和大色块")
  }
  return {
    subject,
    composition: visual.composition,
    palette: visual.palette,
    moodKeywords: [...visual.mood],
    titlePlacement: meta.genre === "历史" ? "top" : "bottom",
    constraints,
  }
}

export interface CoverBriefValidation {
  errors: string[]
  verdict: "valid" | "invalid"
}

/** 契约校验：主体/构图/色调非空、至少 1 条氛围词与 1 条约束。 */
export function validateCoverBrief(brief: CoverBrief): CoverBriefValidation {
  const errors: string[] = []
  if (!brief.subject.trim()) errors.push("主体描述缺失")
  if (!brief.composition.trim()) errors.push("构图缺失")
  if (!brief.palette.trim()) errors.push("色调缺失")
  if (brief.moodKeywords.length === 0) errors.push("氛围词至少 1 条")
  if (brief.constraints.length === 0) errors.push("约束至少 1 条")
  return { errors, verdict: errors.length === 0 ? "valid" : "invalid" }
}

/** 渲染为 provider 可消费的 prompt 文本（确定性）。 */
export function coverBriefToPrompt(brief: CoverBrief, title: string): string {
  return [
    `为小说《${title}》生成封面插画。`,
    `主体：${brief.subject}`,
    `构图：${brief.composition}`,
    `色调：${brief.palette}`,
    `氛围：${brief.moodKeywords.join("、")}`,
    `书名排布：${brief.titlePlacement}`,
    `约束：${brief.constraints.map((c, i) => `${i + 1}. ${c}`).join(" ")}`,
  ].join("\n")
}
