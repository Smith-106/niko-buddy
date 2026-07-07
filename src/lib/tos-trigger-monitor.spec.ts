import { describe, expect, it } from "vitest"
import {
  buildReassessmentIssue,
  checkTosTriggers,
  type TosTriggerCondition,
} from "./tos-trigger-monitor"

describe("tos-trigger-monitor (ANL-009 safety-valve)", () => {
  describe("checkTosTriggers", () => {
    it("returns hasTrigger=false and anl009Status=no_go when no knownConditions given", () => {
      const result = checkTosTriggers()

      expect(result.hasTrigger).toBe(false)
      expect(result.triggers).toEqual([])
      expect(result.anl009Status).toBe("no_go")
      expect(result.note).toContain("ANL-009")
      expect(result.note).toContain("NO-GO")
    })

    it("returns hasTrigger=false when knownConditions is an empty array", () => {
      const result = checkTosTriggers([])

      expect(result.hasTrigger).toBe(false)
      expect(result.anl009Status).toBe("no_go")
      expect(result.triggers).toEqual([])
    })

    it("returns hasTrigger=false when knownConditions contain only invalid entries (missing evidence)", () => {
      const invalid: TosTriggerCondition[] = [
        {
          type: "tos_change",
          description: "  ",
          evidence: "https://example.com/tos",
          detectedAt: "2026-07-08T00:00:00Z",
        },
        {
          type: "embedded_sdk_available",
          description: "SDK released",
          evidence: "",
          detectedAt: "2026-07-08T00:00:00Z",
        },
      ]

      const result = checkTosTriggers(invalid)

      expect(result.hasTrigger).toBe(false)
      expect(result.anl009Status).toBe("no_go")
      expect(result.triggers).toEqual([])
    })

    it("returns hasTrigger=true and anl009Status=reassessment_recommended when knownConditions contain valid evidence", () => {
      const valid: TosTriggerCondition[] = [
        {
          type: "embedded_sdk_available",
          description: "Anthropic released first-party embedded SDK",
          evidence: "https://docs.anthropic.com/en/docs/embedded-sdk v1.0",
          detectedAt: "2026-07-08T12:00:00Z",
        },
      ]

      const result = checkTosTriggers(valid)

      expect(result.hasTrigger).toBe(true)
      expect(result.anl009Status).toBe("reassessment_recommended")
      expect(result.triggers).toHaveLength(1)
      expect(result.triggers[0]).toEqual(valid[0])
      expect(result.note).toContain("reassessment")
    })

    it("preserves multiple valid triggers and filters invalid ones", () => {
      const conditions: TosTriggerCondition[] = [
        {
          type: "tos_change",
          description: "ToS updated to permit third-party OAuth reuse",
          evidence: "https://anthropic.com/tos-changelog#2026-07",
          detectedAt: "2026-07-08T08:00:00Z",
        },
        {
          type: "billing_model_change",
          description: "",
          evidence: "some evidence",
          detectedAt: "2026-07-08T09:00:00Z",
        },
        {
          type: "official_oauth_first_party",
          description: "First-party OAuth endpoint published",
          evidence: "https://api.anthropic.com/oauth/v1",
          detectedAt: "2026-07-08T10:00:00Z",
        },
      ]

      const result = checkTosTriggers(conditions)

      expect(result.hasTrigger).toBe(true)
      expect(result.anl009Status).toBe("reassessment_recommended")
      expect(result.triggers).toHaveLength(2)
      expect(result.triggers.map((t) => t.type)).toEqual([
        "tos_change",
        "official_oauth_first_party",
      ])
    })
  })

  describe("buildReassessmentIssue", () => {
    it("builds an issue with type=reassessment, severity=info, related=ANL-009", () => {
      const trigger: TosTriggerCondition = {
        type: "embedded_sdk_available",
        description: "Anthropic released first-party embedded SDK",
        evidence: "https://docs.anthropic.com/en/docs/embedded-sdk v1.0",
        detectedAt: "2026-07-08T12:00:00Z",
      }

      const issue = buildReassessmentIssue(trigger)

      expect(issue.type).toBe("reassessment")
      expect(issue.severity).toBe("info")
      expect(issue.status).toBe("open")
      expect(issue.source).toBe("tos-trigger-monitor")
      expect(issue.related).toBe("ANL-009")
      expect(issue.id).toContain("ISS-ANL009-REASSESS-")
      expect(issue.created_at).toBe("2026-07-08T12:00:00Z")
    })

    it("embeds trigger type, description, and evidence in the issue description", () => {
      const trigger: TosTriggerCondition = {
        type: "tos_change",
        description: "ToS updated to permit third-party OAuth reuse",
        evidence: "https://anthropic.com/tos-changelog#2026-07",
        detectedAt: "2026-07-08T08:00:00Z",
      }

      const issue = buildReassessmentIssue(trigger)

      expect(issue.title).toContain("tos change")
      expect(issue.description).toContain("tos_change")
      expect(issue.description).toContain("ToS updated to permit third-party OAuth reuse")
      expect(issue.description).toContain("https://anthropic.com/tos-changelog#2026-07")
      expect(issue.description).toContain("NO-GO remains enforced")
    })

    it("falls back to current ISO timestamp when trigger.detectedAt is empty", () => {
      const trigger: TosTriggerCondition = {
        type: "billing_model_change",
        description: "Billing model changed",
        evidence: "https://anthropic.com/billing",
        detectedAt: "",
      }

      const issue = buildReassessmentIssue(trigger)

      expect(issue.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
      expect(issue.id).toContain("ISS-ANL009-REASSESS-")
    })
  })
})
