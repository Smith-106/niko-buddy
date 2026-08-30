import { getLatestUserMemoryDecision } from "./decision-trace"
import { applyUserMemoryFeedback } from "./governance"
import { loadGlobalUserMemoryConfig, saveGlobalUserMemoryConfig } from "./store"

export function recordLatestUserMemoryFeedback(sentiment: "positive" | "negative", now = Date.now()): void {
  const decision = getLatestUserMemoryDecision()
  if (!decision || decision.selectedRuleIds.length === 0) return
  const config = loadGlobalUserMemoryConfig()
  saveGlobalUserMemoryConfig(applyUserMemoryFeedback(config, decision.selectedRuleIds, sentiment, now))
}
