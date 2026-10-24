// @vitest-environment jsdom
import { act, render, screen, fireEvent, setupDomGlobals } from "@/test-helpers/component-test-utils"
import { cleanup } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CapabilityReplayDrawer } from "./capability-replay-drawer"

const mocks = vi.hoisted(() => ({ read: vi.fn(async (): Promise<unknown[]> => []), project: { path: "E:/Novel" } as unknown })) 
vi.mock("@/lib/agent/capability-trace-store", () => ({ readCapabilityTraces: mocks.read }))
vi.mock("@/stores/wiki-store", () => ({ useWikiStore: (sel: (s: unknown) => unknown) => sel({ project: mocks.project }) }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string, d?: string) => d ?? k }) }))

beforeEach(() => { vi.clearAllMocks(); mocks.read.mockResolvedValue([]); mocks.project = { path: "E:/Novel" } as unknown; setupDomGlobals() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe("CapabilityReplayDrawer", () => {
  it("空态", async () => {
    render(<CapabilityReplayDrawer />)
    fireEvent.click(screen.getByRole("button"))
    expect(await screen.findByText("暂无能力规划记录")).toBeInTheDocument()
    await act(async () => {})
  })
  it("有记录展示链", async () => {
    mocks.read.mockResolvedValue([{ query: "q", intent: "write", mode: "deep", retrieved: [], filteredOut: [], planned: [{ id: "a" }, { id: "b" }], outcome: "success", at: 1 }])
    render(<CapabilityReplayDrawer />)
    fireEvent.click(screen.getByRole("button"))
    expect(await screen.findByText("write · deep · success")).toBeInTheDocument()
    await act(async () => {})
  })
})
