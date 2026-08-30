import type { AutomaticUserMemoryRuleInput, UserMemoryCategory, UserMemorySurface } from "./types"

const VALID_CATEGORIES = new Set<UserMemoryCategory>([
  "output_style", "writing_preference", "outline_preference", "workflow_preference",
  "interaction_preference", "format_preference", "constraint", "manual",
])
const VALID_SURFACES = new Set<UserMemorySurface>([
  "all", "ai-chat", "ai-outline", "chapter-writing", "book-analysis", "review", "analysis",
])
const SPECIFIC_TASK_PATTERN = /第\s*[一二三四五六七八九十百千万零〇两\d、,，~～\-至到]+\s*章|(?:生成|续写|改写|参考|根据)[^。；]{0,24}[一二三四五六七八九十百千万零〇两\d]+\s*章/
const SENSITIVE_PATTERN = /(?:api\s*key|密钥|密码|口令|token\s*[：:=]|sk-[a-z0-9_-]{6,}|身份证|银行卡|真实姓名|家庭住址|住址|详细地址|患有|病史|诊断|医疗信息|月收入|工资|资产|负债|财务信息|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:\+?86[-\s]?)?1[3-9]\d{9}\b)/i

export interface ParsedUserMemoryRule extends Omit<AutomaticUserMemoryRuleInput, "sourceHash"> {}

export function buildUserMemoryExtractionPrompt(userMessage: string): string {
  return [
    "你是全局用户习惯提取器。只输出 JSON，不要输出解释或 Markdown。",
    "目标：从用户消息中提取能够跨项目、跨任务复用的稳定习惯，让后续 AI 更符合用户偏好。",
    "严格规则：",
    "1. 不要保存具体章节号、人物名、本次生成数量、临时文件名或一次性任务目标。",
    "2. 不要保存密码、密钥、令牌、联系方式、身份信息或其他敏感信息。",
    "3. 只保留能够跨任务复用的表达、写作、流程、格式、交互和禁止事项。",
    "4. 无法确认是长期习惯时返回空数组。",
    "5. rule 必须是可直接给 AI 执行的中文规则，不得复述原始消息。",
    "输出结构：",
    JSON.stringify({
      memories: [{
        rule: "续写时优先保持用户指定章节之间的剧情承接。",
        category: "workflow_preference",
        surfaces: ["chapter-writing", "ai-chat"],
        confidence: 0.82,
        evidence_summary: "用户要求基于选定章节生成后续内容。",
      }],
    }, null, 2),
    "用户消息：",
    userMessage.slice(0, 12_000),
  ].join("\n")
}

function extractJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try { return JSON.parse(cleaned.slice(start, end + 1)) } catch { return null }
}

function isReusable(rule: string, evidence: string): boolean {
  if (rule.length < 6 || rule.length > 500) return false
  if (SPECIFIC_TASK_PATTERN.test(rule)) return false
  if (SENSITIVE_PATTERN.test(rule) || SENSITIVE_PATTERN.test(evidence)) return false
  return true
}

export function parseUserMemoryExtraction(text: string): ParsedUserMemoryRule[] {
  const parsed = extractJson(text)
  if (!parsed || typeof parsed !== "object") return []
  const memories = (parsed as { memories?: unknown }).memories
  if (!Array.isArray(memories)) return []
  return memories.flatMap((value): ParsedUserMemoryRule[] => {
    if (!value || typeof value !== "object") return []
    const raw = value as Record<string, unknown>
    const rule = typeof raw.rule === "string" ? raw.rule.trim() : ""
    const evidenceSummary = typeof raw.evidence_summary === "string" ? raw.evidence_summary.trim() : ""
    const category = typeof raw.category === "string" && VALID_CATEGORIES.has(raw.category as UserMemoryCategory)
      ? raw.category as UserMemoryCategory
      : null
    const surfaces = Array.isArray(raw.surfaces)
      ? [...new Set(raw.surfaces.filter((item): item is UserMemorySurface => typeof item === "string" && VALID_SURFACES.has(item as UserMemorySurface)))]
      : []
    if (!category || !isReusable(rule, evidenceSummary)) return []
    return [{
      rule,
      category,
      surfaces: surfaces.length > 0 ? surfaces : ["all"],
      confidence: typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
        ? Math.max(0, Math.min(1, raw.confidence))
        : 0.5,
      evidenceSummary,
    }]
  })
}

export async function computeUserMessageHash(message: string): Promise<string> {
  const normalized = message.replace(/\s+/g, " ").trim()
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  }
  let hash = 2166136261
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`
}
