import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/platform"
import type { NovelGateStatus, NovelGateType, StatusFinding } from "./status"

export interface GateResultInfo {
  gate_type: NovelGateType
  status: NovelGateStatus
  score: number
  finding_count: number
  retry_count: number
  mechanical_findings: StatusFinding[]
  semantic_findings: StatusFinding[]
  findings_desc: string[]
}

export interface GateSummary {
  all_passed: boolean
  gate_results: Record<string, GateResultInfo>
  total_retries: number
  max_retry: number
  final_text: string | null
}

const MAX_RETRY = 3
const ANTI_AI_THRESHOLD = 45
const QUALITY_SENTENCE_LENGTH_WARNING = 50

type GateKey = "consistency" | "anti_ai" | "quality"

interface SlopRule {
  category: string
  pattern: RegExp
  weight: number
  description: string
}

interface SlopFinding {
  category: string
  count: number
  weight: number
  description: string
}

function makeGateResult(
  gateType: NovelGateType,
  status: NovelGateStatus,
  score: number,
  mechanicalFindings: StatusFinding[],
  semanticFindings: StatusFinding[],
  retryCount: number,
  findingsDesc?: string[],
): GateResultInfo {
  return {
    gate_type: gateType,
    status,
    score,
    finding_count: mechanicalFindings.length + semanticFindings.length,
    retry_count: retryCount,
    mechanical_findings: mechanicalFindings,
    semantic_findings: semanticFindings,
    findings_desc: findingsDesc ?? [...mechanicalFindings, ...semanticFindings].map((finding) =>
      `- [${finding.severity}] ${finding.description} (${finding.location ?? "未知位置"})`,
    ),
  }
}

function gateStatusPassed(status: NovelGateStatus): boolean {
  return status === "passed" || status === "warning"
}

function sentenceCount(text: string): number {
  const count = (text.match(/[。！？.!?]/g) ?? []).length
  return Math.max(count, 1)
}

function buildSlopRules(): SlopRule[] {
  return [
    {
      category: "transition_overuse",
      pattern: /(?:然而|不过|但是|因此|因而|值得注意的是|与此同时|尽管如此|基于这个原因|在某种层面上|换句话说|总的来说|总而言之)/g,
      weight: 8,
      description: "过渡词过度使用",
    },
    {
      category: "explanatory_aside",
      pattern: /(?:因为|毕竟|之所以)/g,
      weight: 7,
      description: "解释性旁白",
    },
    {
      category: "overcomplete_action",
      pattern: /(?:伸手|从.*里掏出|从.*中取出|朝着.*的方向走了过去)/g,
      weight: 5,
      description: "动作描写过度完整",
    },
    {
      category: "emotion_labeling",
      pattern: /(?:感到一阵|心里充满了|非常惊讶|感到深深的|充满了感动)/g,
      weight: 9,
      description: "情感标签化",
    },
    {
      category: "overcomplete_causality",
      pattern: /(?:因为.*所以|由于.*因此|之所以.*是因为)/g,
      weight: 6,
      description: "因果链过度完整",
    },
    {
      category: "panoramic_scan",
      pattern: /(?:环顾|扫视|打量|放眼|环视|四下|四周|周围).{0,20}(?:、).*?(?:、).*?(?:、)/g,
      weight: 4,
      description: "全方位观察综合征",
    },
    {
      category: "summary_ending",
      pattern: /(?:这就是.*之处|终于还是来了|不管怎么样.*都得|这意味着|也就是说|确实如此|没错[。，])/g,
      weight: 7,
      description: "标准答案式结尾",
    },
    {
      category: "temporal_adverb",
      pattern: /(?:正在|正准备|刚要|刚准备)/g,
      weight: 5,
      description: "多余时间副词",
    },
    {
      category: "identity_retag",
      pattern: /(?:作为|身为|作为一名).*的/g,
      weight: 5,
      description: "身份重复标签",
    },
    {
      category: "ai_fingerprint",
      pattern: /(?:赋能|抓手|底层逻辑|全方位|凸显|彰显|加持|助力)/g,
      weight: 9,
      description: "AI指纹词污染",
    },
    {
      category: "verb_homogenization",
      pattern: /(?:进行|实施|做出|采取|获得提升|产生怀疑|做出选择|进行评估)/g,
      weight: 6,
      description: "动词同质化",
    },
    {
      category: "judgment_shortcut",
      pattern: /(?:不是.*(?:是|而是)|不是.*[。，]是|也就是说|换句话说|这意味着|这说明)/g,
      weight: 8,
      description: "判定式短句和自问自答",
    },
  ]
}

function applySlopRules(text: string): { score: number, findings: SlopFinding[] } {
  const findings = buildSlopRules()
    .map((rule) => {
      const matches = text.match(rule.pattern) ?? []
      if (matches.length === 0) return null
      return {
        category: rule.category,
        count: matches.length,
        weight: rule.weight,
        description: rule.description,
      } satisfies SlopFinding
    })
    .filter((finding): finding is SlopFinding => Boolean(finding))

  const rawScore = findings.reduce((sum, finding) => sum + finding.count * finding.weight, 0)
  return {
    score: Math.min(100, rawScore),
    findings,
  }
}

function runConsistencyGate(text: string): GateResultInfo {
  const mechanicalFindings: StatusFinding[] = []

  const roleContradictions: Array<{ pattern: RegExp, description: string, suggestion: string }> = [
    {
      pattern: /不知道.*?却知道/g,
      description: "角色同时不知道和知道同一件事",
      suggestion: "检查角色认知是否一致——角色不能同时知道和不知道同一件事",
    },
    {
      pattern: /完全不了解.*?却.*?熟悉/g,
      description: "角色对同一领域同时不了解和熟悉",
      suggestion: "检查角色认知边界，避免同一对象既陌生又熟悉",
    },
    {
      pattern: /第一次.*?见.*?之前.*?见过/g,
      description: "角色对同一事物既是第一次见又之前见过",
      suggestion: "统一首次见面的事实表述，避免时间与认知冲突",
    },
    {
      pattern: /(他|她|它|他们)(?:对|关于|在).+?(?:一无所知|完全不了解|毫不知情).+?(?:却|但|竟然).+?(?:知道|了解|熟悉|明白)/g,
      description: "角色认知矛盾：同一段落内既不知情又知情",
      suggestion: "修正角色认知状态——确保知道/不知道的边界一致",
    },
  ]

  for (const rule of roleContradictions) {
    for (const match of text.matchAll(rule.pattern)) {
      mechanicalFindings.push({
        severity: "critical",
        description: rule.description,
        location: typeof match.index === "number" ? `offset ${match.index}` : "未知位置",
        suggestion: rule.suggestion,
      })
    }
  }

  const settingViolations: Array<{ pattern: RegExp, description: string, severity: string, suggestion: string }> = [
    {
      pattern: /(?:古代|古代背景|封建|朝代).+?(?:手机|电脑|网络|互联网|微信|电子邮件)/g,
      description: "古代背景出现现代科技",
      severity: "critical",
      suggestion: "检查世界观设定——此场景中的物品/概念不应出现在当前时代背景",
    },
    {
      pattern: /(?:修仙|仙侠|修真).+?(?:基因|DNA|量子|纳米|粒子|辐射)/g,
      description: "修仙背景出现现代科学概念",
      severity: "critical",
      suggestion: "检查世界观设定——现代科学概念不应直接落入当前修仙语境",
    },
    {
      pattern: /(?:末日|废土|末世).+?(?:信用卡|银行|超市购物|网购|外卖)/g,
      description: "末日背景出现正常社会消费",
      severity: "critical",
      suggestion: "检查世界观设定——末日场景不应保留正常消费秩序",
    },
    {
      pattern: /(?:房间里有一张床.*?衣柜|街道两旁是各种.*?店铺.*?行人来来往往|四周是一片.*?景象)/g,
      description: "AI式全景扫描描写",
      severity: "warning",
      suggestion: "只写角色当前会注意到的 2-3 个特征，不要做全景扫描",
    },
  ]

  for (const rule of settingViolations) {
    for (const match of text.matchAll(rule.pattern)) {
      mechanicalFindings.push({
        severity: rule.severity,
        description: rule.description,
        location: typeof match.index === "number" ? `offset ${match.index}` : "未知位置",
        suggestion: rule.suggestion,
      })
    }
  }

  const passed = mechanicalFindings.length === 0
  const score = passed ? 100 : Math.max(0, 100 - mechanicalFindings.length * 15)

  return makeGateResult(
    "consistency",
    passed ? "passed" : "failed",
    score,
    mechanicalFindings,
    [],
    passed ? 0 : 1,
  )
}

function runAntiAiGate(text: string): GateResultInfo {
  const report = applySlopRules(text)
  const passed = report.score < ANTI_AI_THRESHOLD
  const mechanicalFindings = report.findings.map<StatusFinding>((finding) => ({
    severity: "warning",
    description: `${finding.description}（出现 ${finding.count} 次）`,
    location: null,
    suggestion: `减少 ${finding.category} 类 AI 味表达`,
  }))
  const findingsDesc = report.findings.map((finding) =>
    `- [${finding.category}] ${finding.description} (出现${finding.count}次)`,
  )

  return makeGateResult(
    "anti_ai",
    passed ? "passed" : "failed",
    100 - report.score,
    mechanicalFindings,
    [],
    passed ? 0 : 1,
    findingsDesc,
  )
}

function runQualityGate(text: string): GateResultInfo {
  const avgSentenceLength = text.length / sentenceCount(text)
  const hasWarning = avgSentenceLength > QUALITY_SENTENCE_LENGTH_WARNING
  const mechanicalFindings = hasWarning
    ? [{
      severity: "warning",
      description: `平均句长 ${avgSentenceLength.toFixed(1)}，存在长句拖沓风险`,
      location: null,
      suggestion: "拆分过长句子，增强节奏起伏",
    }]
    : []

  return makeGateResult(
    "quality",
    hasWarning ? "warning" : "passed",
    hasWarning ? 70 : 100,
    mechanicalFindings,
    [],
    0,
    [],
  )
}

function runDecisionGatesFallback(_projectPath: string, text: string): GateSummary {
  const gateResults: Record<GateKey, GateResultInfo> = {
    consistency: runConsistencyGate(text),
    anti_ai: runAntiAiGate(text),
    quality: runQualityGate(text),
  }

  return {
    all_passed: Object.values(gateResults).every((gate) => gateStatusPassed(gate.status)),
    gate_results: gateResults,
    total_retries: Object.values(gateResults).reduce((sum, gate) => sum + gate.retry_count, 0),
    max_retry: MAX_RETRY,
    final_text: null,
  }
}

export async function runDecisionGates(projectPath: string, text: string): Promise<GateSummary> {
  if (!isTauri()) {
    return runDecisionGatesFallback(projectPath, text)
  }
  return invoke<GateSummary>("run_decision_gates", { projectPath, text })
}
