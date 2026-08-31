// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// Spec for src/components/settings/sections/mcp-section.tsx — focuses on the
// transport-type selector added by audit ①-6 (stdio default, SSE reserved).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"
import { McpSection } from "./mcp-section"
import type { McpConfig } from "@/lib/mcp/config"

const mocks = vi.hoisted(() => {
  const setMcpConfig = vi.fn()
  return {
    t: vi.fn((key: string, _options?: Record<string, unknown>) => key),
    setMcpConfig,
    saveMcpConfig: vi.fn(async () => {}),
    testConnection: vi.fn(),
    closeAll: vi.fn(async () => {}),
    state: {
      mcpConfig: null as McpConfig | null,
      setMcpConfig,
    },
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: typeof mocks.state) => unknown) => selector(mocks.state),
}))

vi.mock("@/lib/project-store", () => ({
  saveMcpConfig: mocks.saveMcpConfig,
}))

vi.mock("@/lib/mcp/real-connector", () => ({
  RealMcpConnector: class {
    testConnection = mocks.testConnection
    closeAll = mocks.closeAll
  },
}))

const SERVER = {
  id: "graph",
  name: "Graph",
  enabled: true,
  transport: "stdio" as const,
  command: "node",
  args: ["server.js"],
  tools: [
    {
      serverId: "graph",
      serverName: "Graph",
      name: "query_graph",
      description: "Query the graph",
      operation: "read" as const,
      inputSchema: { type: "object" as const },
    },
  ],
}

beforeEach(() => {
  mocks.t.mockClear()
  mocks.setMcpConfig.mockClear()
  mocks.saveMcpConfig.mockClear()
  mocks.testConnection.mockClear()
  mocks.closeAll.mockClear()
  mocks.state.mcpConfig = { servers: [{ ...SERVER }] }
})

afterEach(() => {
  cleanup()
})

describe("McpSection — transport type selector (audit ①-6)", () => {
  it("renders a transport select defaulting to stdio with SSE reserved (disabled)", () => {
    render(<McpSection />)
    const select = screen.getByRole("combobox") as HTMLSelectElement
    expect(select).toBeInTheDocument()
    expect(select.value).toBe("stdio")
    const sseOption = Array.from(select.options).find((o) => o.value === "sse")
    expect(sseOption).toBeDefined()
    expect(sseOption!.disabled).toBe(true)
  })

  it("transport hint is shown below the selector", () => {
    render(<McpSection />)
    expect(screen.getByText("settings.sections.mcp.transportHint")).toBeInTheDocument()
  })

  it("persists the config when the transport is changed to stdio", async () => {
    render(<McpSection />)
    const select = screen.getByRole("combobox") as HTMLSelectElement
    fireEvent.change(select, { target: { value: "stdio" } })
    await waitFor(() => {
      expect(mocks.setMcpConfig).toHaveBeenCalled()
    })
    expect(mocks.saveMcpConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        servers: expect.arrayContaining([expect.objectContaining({ transport: "stdio" })]),
      }),
    )
  })
})
