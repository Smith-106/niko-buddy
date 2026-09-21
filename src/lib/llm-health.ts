import type { LlmConfig } from "@/stores/wiki-store"
import { hasUsableLlm } from "./has-usable-llm"

/**
 * J01-T01 (F-007)：模型服务健康状态机。
 *
 * 纯函数零 IO，可被「建项流程的可展开模型服务步骤」与「设置页 LLM 区块」（J05）
 * 共同复用——不是一次性 onboarding 专用。状态面向用户语言，不泄漏 apiKey/
 * provider/endpoint 等内部字段；provider 内部细节只进 diagnostics，不进 label。
 */
export type LlmHealthStatus =
  | "unconfigured"      // 未配置（默认态：apiKey/model 全空）
  | "incomplete"        // 配置不完整（填了部分必填但缺关键项）
  | "checking"          // 正在检测（异步连通性探测中，UI 由调用方驱动）
  | "usable"            // 可用（hasUsableLlm 通过）
  | "auth_failed"       // 认证失败（联网探测 401/403，由调用方注入）
  | "model_unavailable" // 凭证有效但模型名不存在/不可用（探测 404，由调用方注入）

export interface LlmHealth {
  status: LlmHealthStatus
  /** 用户可读的一句话状态（不暴露内部字段名） */
  label: string
  /** 该状态下 LLM 写作任务能否真实执行 */
  canWrite: boolean
  /** 不可用时给用户的下一步提示；usable 时为 null */
  nextStep: string | null
}

function isBlank(s: string | undefined | null): boolean {
  return !s || s.trim().length === 0
}

/** CLI provider 两档：
 * - claude-code/codex-cli/antigravity-cli：二进制自带默认模型，零配置即可用（hasUsableLlm 恒 true）
 * - cursor-cli：本地 proxy 通道，无需 apiKey 但需 model
 * 两者都「不需要 apiKey」——这与 hosted provider 的“未配置”判定标准不同。 */
function isCliProvider(provider: string): boolean {
  return provider === "claude-code" || provider === "codex-cli"
    || provider === "antigravity-cli" || provider === "cursor-cli"
}

/** 始终可用的 CLI（零字段即 hasUsableLlm=true）——对它们“unconfigured”无意义。 */
function isAlwaysUsableCli(provider: string): boolean {
  return provider === "claude-code" || provider === "codex-cli" || provider === "antigravity-cli"
}

/**
 * 判定模型服务健康状态。
 * probeResult 由调用方注入（默认 null=未探测）：
 *   "ok" | "auth" | "model" —— 分别映射 usable / auth_failed / model_unavailable
 *   null → 仅按配置字段静态判定（不联网）。
 */
export function assessLlmHealth(
  cfg: (Pick<LlmConfig, "provider" | "apiKey" | "model">
    & Partial<Pick<LlmConfig, "customEndpoint" | "ollamaUrl">>) | undefined | null,
  probeResult: "ok" | "auth" | "model" | null = null,
): LlmHealth {
  // cfg 缺省（store 早期未水合 / spec 未注入）→ 视为未配置，不抛错
  if (!cfg) {
    return {
      status: "unconfigured",
      label: "尚未配置模型服务",
      canWrite: false,
      nextStep: "AI 写作功能需要模型服务——可立即配置，或先跳过（仅本地编辑可用）",
    }
  }
  // 探测结果优先（调用方联网探测过才传入）
  if (probeResult === "auth") {
    return {
      status: "auth_failed",
      label: "模型服务未授权",
      canWrite: false,
      nextStep: "检查密钥是否正确，或更换模型服务后重试",
    }
  }
  if (probeResult === "model") {
    return {
      status: "model_unavailable",
      label: "模型暂不可用",
      canWrite: false,
      nextStep: "凭证有效，但所选模型当前不可用——请改选其他模型",
    }
  }
  if (probeResult === "ok") {
    return { status: "usable", label: "模型服务可用", canWrite: true, nextStep: null }
  }

  // 静态判定（未探测）
  const cli = isCliProvider(cfg.provider)

  // 始终可用 CLI：零字段也直接 usable（二进制自带默认模型），不存在"未配置"
  if (isAlwaysUsableCli(cfg.provider)) {
    return { status: "usable", label: "模型服务已就绪", canWrite: true, nextStep: null }
  }

  const fullyEmpty = cli
    ? isBlank(cfg.model)                                  // cursor-cli：只看 model
    : isBlank(cfg.apiKey) && isBlank(cfg.model)           // hosted：apiKey+model 全空才算未配置

  if (fullyEmpty) {
    return {
      status: "unconfigured",
      label: "尚未配置模型服务",
      canWrite: false,
      nextStep: "AI 写作功能需要模型服务——可立即配置，或先跳过（仅本地编辑可用）",
    }
  }

  if (hasUsableLlm(cfg)) {
    return {
      status: "usable",
      label: "模型服务已就绪",
      canWrite: true,
      nextStep: null,
    }
  }

  return {
    status: "incomplete",
    label: "模型服务配置不完整",
    canWrite: false,
    nextStep: "还差一步即可完成配置——请补全模型服务信息",
  }
}
