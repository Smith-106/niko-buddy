/** C4 冒烟覆盖：src/lib/novel/outline-wizard.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { OUTLINE_WIZARD_TASK_OPTIONS, OUTLINE_WIZARD_LENGTH_OPTIONS, OUTLINE_WIZARD_CHANNEL_OPTIONS, OUTLINE_WIZARD_SELLING_POINTS, OUTLINE_WIZARD_TARGETS, OUTLINE_WIZARD_NARRATIVE_OPTIONS, OUTLINE_WIZARD_MATERIAL_OPTIONS, getOutlineWizardGenres, getOutlineWizardGenreLabel, getOutlineWizardValidationError, getOutlineWizardSkillNames, buildOutlineWizardPrompt } from "./outline-wizard"
describe("outline-wizard.ts smoke", () => {
  it("exports OUTLINE_WIZARD_TASK_OPTIONS", () => {
    expect(OUTLINE_WIZARD_TASK_OPTIONS).toBeDefined()
  })
  it("exports OUTLINE_WIZARD_LENGTH_OPTIONS", () => {
    expect(OUTLINE_WIZARD_LENGTH_OPTIONS).toBeDefined()
  })
  it("exports OUTLINE_WIZARD_CHANNEL_OPTIONS", () => {
    expect(OUTLINE_WIZARD_CHANNEL_OPTIONS).toBeDefined()
  })
  it("exports OUTLINE_WIZARD_SELLING_POINTS", () => {
    expect(OUTLINE_WIZARD_SELLING_POINTS).toBeDefined()
  })
  it("exports OUTLINE_WIZARD_TARGETS", () => {
    expect(OUTLINE_WIZARD_TARGETS).toBeDefined()
  })
  it("exports OUTLINE_WIZARD_NARRATIVE_OPTIONS", () => {
    expect(OUTLINE_WIZARD_NARRATIVE_OPTIONS).toBeDefined()
  })
  it("exports OUTLINE_WIZARD_MATERIAL_OPTIONS", () => {
    expect(OUTLINE_WIZARD_MATERIAL_OPTIONS).toBeDefined()
  })
  it("exports getOutlineWizardGenres", () => {
    expect(getOutlineWizardGenres).toBeDefined()
  })
  it("exports getOutlineWizardGenreLabel", () => {
    expect(getOutlineWizardGenreLabel).toBeDefined()
  })
  it("exports getOutlineWizardValidationError", () => {
    expect(getOutlineWizardValidationError).toBeDefined()
  })
  it("exports getOutlineWizardSkillNames", () => {
    expect(getOutlineWizardSkillNames).toBeDefined()
  })
  it("exports buildOutlineWizardPrompt", () => {
    expect(buildOutlineWizardPrompt).toBeDefined()
  })
})
