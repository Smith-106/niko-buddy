import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8")
}

describe("story simulation partial save and resume wiring", () => {
  it("persists partial simulation result metadata for cancelled runs", () => {
    const storeSource = read("src/lib/novel/story-simulation/framework-store.ts")

    expect(storeSource).toContain("SimulationResultStatus")
    expect(storeSource).toContain("partialReason")
    expect(storeSource).toContain("resume")
    expect(storeSource).toContain('status: parsed.status ?? "complete"')
  })

  it("saves partial progress on cancel and exposes a continue action", () => {
    const viewSource = read(
      "src/components/novel/story-simulation/story-simulation-view.tsx",
    )
    const modalSource = read(
      "src/components/novel/story-simulation/history-results-modal.tsx",
    )

    expect(viewSource).toContain("savePartialSimulationResult")
    expect(viewSource).toContain("handleContinuePartialResult")
    expect(viewSource).toContain("resumeSimulationRef")
    expect(modalSource).toContain("onContinueResult")
    expect(viewSource).toContain("storySimulation.partialSavedInfo")
    expect(viewSource).toContain("storySimulation.savingPartial")
    expect(modalSource).toContain("storySimulation.continueSimulation")
    expect(modalSource).toContain("storySimulation.badgePartial")
    expect(modalSource).toContain("badgeDraft")
  })
})
