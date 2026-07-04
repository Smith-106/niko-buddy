import { describe, expect, it, vi } from "vitest"
import { runAppUpdateFlow } from "./app-updater"

function createBindings() {
  return {
    isTauri: true,
    check: vi.fn(),
    confirm: vi.fn(),
    message: vi.fn(),
  }
}

describe("runAppUpdateFlow", () => {
  it("does not prompt during silent startup checks when an update is available", async () => {
    const bindings = createBindings()
    bindings.check.mockResolvedValue({
      version: "2.2.29",
      body: "update notes",
    })

    const result = await runAppUpdateFlow(bindings, { mode: "silent" })

    expect(result).toEqual({
      status: "update_available",
      prompted: false,
      version: "2.2.29",
    })
    expect(bindings.confirm).not.toHaveBeenCalled()
    expect(bindings.message).not.toHaveBeenCalled()
  })

  it("prompts in interactive mode and stops when the user declines the update", async () => {
    const bindings = createBindings()
    bindings.check.mockResolvedValue({
      version: "2.2.29",
      body: "update notes",
    })
    bindings.confirm.mockResolvedValue(false)

    const result = await runAppUpdateFlow(bindings)

    expect(result).toEqual({
      status: "declined",
      prompted: true,
      version: "2.2.29",
    })
    expect(bindings.confirm).toHaveBeenCalledTimes(1)
    expect(bindings.message).not.toHaveBeenCalled()
  })

  it("never calls dialog APIs during silent startup checks even when an update exists", async () => {
    const bindings = createBindings()
    bindings.check.mockResolvedValue({
      version: "2.2.29",
      body: "update notes",
    })

    await runAppUpdateFlow(bindings, { mode: "silent" })

    expect(bindings.confirm).not.toHaveBeenCalled()
    expect(bindings.message).not.toHaveBeenCalled()
  })
})
