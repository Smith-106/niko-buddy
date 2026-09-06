/**
 * 64 号实施（63 号共识 §6 缺口 9）：PromptInjectionAuditor — RAG 注入防御层 8.
 *
 * 吸收来源：reference/RAG-PROMPT_INJECTION_-SECURITY 12 层对照表的层 8
 * （LLM Security Auditor）——只借模式不借代码（该参考仓无 LICENSE，55 号
 * W3-2 已锁定此口径）。rag-trust-audit.spec.ts 曾登记 covered:false，本模块
 * 落地后翻转 covered:true（机械规则层；LLM 语义审计 defer 记录在 spec 注释）。
 *
 * 定位：检索输入侧（snippet/pack 文本）注入签名机械扫描，确定性规则表零 LLM。
 * 与 avoid-ai-patterns 职责区隔：avoid-ai 管写作输出侧软信号，本模块管
 * 检索/装配输入侧注入；双向注释锚定。
 *
 * 三档动作：pass 直通 / sanitize 剥离命中行 / drop 仅对 high 整段剔除
 * （IC-02 不静默：drop 必须进 gaps 告知）。
 */

export type InjectionSeverity = "info" | "suspicious" | "high"

export interface InjectionFinding {
  /** 规则 id（规则表冻结键）。 */
  ruleId: string
  /** 命中上下文片段（截断）。 */
  excerpt: string
  severity: InjectionSeverity
}

export interface InjectionAuditVerdict {
  findings: InjectionFinding[]
  /** 机械三档，零 LLM。 */
  action: "pass" | "sanitize" | "drop"
  /** drop 时被剔除的行号（1-based）；sanitize 时被剥离的行号。 */
  affectedLineNumbers: number[]
}

interface InjectionRule {
  id: string
  /** 正则（含 i 标志的中英双语确定性模式）。 */
  re: RegExp
  severity: InjectionSeverity
}

/** 冻结规则表（中英双语；测试断言规则数不得无提示变更）。 */
const INJECTION_RULES: readonly InjectionRule[] = [
  {
    id: "instruction-override",
    re: /忽略(以上|上面|之前)?(所有|全部)?(指令|指示|要求|prompt|提示)/i,
    severity: "high",
  },
  {
    id: "ignore-previous",
    re: /ignore\s+(all\s+)?previous\s+(instructions|prompts|messages)/i,
    severity: "high",
  },
  {
    id: "role-hijack",
    re: /(现在|接下来|从现在起)(你是|你扮演|你的角色是)/i,
    severity: "suspicious",
  },
  {
    id: "you-are-now",
    re: /you\s+are\s+now\s+(a|an|the)/i,
    severity: "suspicious",
  },
  {
    id: "fake-system",
    re: /<system[^>]*>|\[system\]|(system|sys)\s*[:：]\s*(prompt|message|指令)/i,
    severity: "high",
  },
  {
    id: "encoded-payload",
    re: /(base64|hex|percent-encoded|urlencoded)\s*(解码|decode|encod)/i,
    severity: "suspicious",
  },
  {
    id: "tool-escalation",
    re: /(调用|执行|运行|access|execute|run)\s*(工具|命令|命令面|tool|command)/i,
    severity: "suspicious",
  },
  {
    id: "exfil-prompt",
    re: /(输出|打印|print|echo)\s*(全文|内容|输入|所有|the\s+entire|everything)/i,
    severity: "info",
  },
  {
    id: "delimiter-jailbreak",
    re: /(忽略|forget|disregard).{0,20}(规则|constraints|boundaries|instructions)/i,
    severity: "high",
  },
]

export const INJECTION_RULE_COUNT = INJECTION_RULES.length

function excerptOf(text: string, matchIndex: number, matchLength: number, maxChars: number): string {
  const start = Math.max(0, matchIndex - Math.floor(maxChars / 2))
  const end = Math.min(text.length, matchIndex + matchLength + Math.floor(maxChars / 2))
  return text.slice(start, end)
}

/**
 * 扫描文本中的注入签名。确定性：同输入同输出（规则表冻结）。
 * 返回所有命中（按出现顺序）；severity 最高级决定 action。
 */
export function auditRetrievedChunk(
  content: string,
  opts: { maxExcerptChars?: number; maxFindings?: number } = {},
): InjectionAuditVerdict {
  const maxExcerpt = opts.maxExcerptChars ?? 60
  const maxFindings = opts.maxFindings ?? 20
  if (!content) return { findings: [], action: "pass", affectedLineNumbers: [] }

  const findings: InjectionFinding[] = []
  const affectedLineNumbers = new Set<number>()

  for (const rule of INJECTION_RULES) {
    rule.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rule.re.exec(content)) !== null) {
      const idx = m.index
      findings.push({
        ruleId: rule.id,
        excerpt: excerptOf(content, idx, m[0].length, maxExcerpt),
        severity: rule.severity,
      })
      // 命中所在行号（1-based）
      const lineIdx = content.slice(0, idx).split("\n").length
      affectedLineNumbers.add(lineIdx)
      if (findings.length >= maxFindings) break
      // 零宽匹配防死循环
      if (m[0].length === 0) rule.re.lastIndex++
    }
    if (findings.length >= maxFindings) break
  }

  const hasHigh = findings.some((f) => f.severity === "high")
  const hasSuspicious = findings.some((f) => f.severity === "suspicious")
  const action: InjectionAuditVerdict["action"] = hasHigh ? "drop" : hasSuspicious ? "sanitize" : "pass"

  return {
    findings,
    action,
    affectedLineNumbers: [...affectedLineNumbers].sort((a, b) => a - b),
  }
}

/** 渲染审计结果为可注入 gaps/日志的摘要文本。 */
export function formatInjectionAuditSummary(verdict: InjectionAuditVerdict): string {
  if (verdict.findings.length === 0) return ""
  const lines = verdict.findings.map((f) => `- [${f.severity}] ${f.ruleId}: ${f.excerpt}`)
  return [`## RAG 注入审计（层 8）`, `动作：${verdict.action}`, ...lines].join("\n")
}

/** 剥离命中行（sanitize 动作的确定性执行）；返回剥离后的文本与剩余行号。 */
export function sanitizeAffectedLines(content: string, lineNumbers: number[]): string {
  const toStrip = new Set(lineNumbers)
  return content
    .split("\n")
    .filter((_l, i) => !toStrip.has(i + 1))
    .join("\n")
}
