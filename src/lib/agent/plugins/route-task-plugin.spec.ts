import { describe, expect, it, vi } from "vitest"
import { createRouteTaskPlugin } from "./route-task-plugin"
import { routeTask } from "@/lib/novel"

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    userMessage: "写第5章",
    projectPath: "/test-project",
    agentConfig: {} as never,
    novelMode: true,
    ...overrides,
  }
}

describe("createRouteTaskPlugin", () => {
  it("exposes name route_task and priority 10", () => {
    const plugin = createRouteTaskPlugin()
    expect(plugin.name).toBe("route_task")
    expect(plugin.priority).toBe(10)
  })

  it("returns empty output when not in novel mode without calling routeTask", () => {
    const plugin = createRouteTaskPlugin()
    return plugin.run(baseInput({ novelMode: false })).then((result) => {
      expect(result).toEqual({})
      expect(result.taskRoute).toBeUndefined()
    })
  })

  it("routes the user message and returns the taskRoute", async () => {
    const plugin = createRouteTaskPlugin()
    const result = await plugin.run(baseInput({ userMessage: "" }))
    // routeTask("") -> general_chat (task-router.ts:332-334)
    expect(result.taskRoute).toEqual(routeTask(""))
    expect(result.taskRoute?.intent).toBe("general_chat")
  })

  it("returns a polish route for a polish request", async () => {
    const plugin = createRouteTaskPlugin()
    const input = baseInput({ userMessage: "润色一下这一章" })
    const result = await plugin.run(input)
    expect(result.taskRoute).toEqual(routeTask("润色一下这一章"))
    expect(result.taskRoute?.intent).toBe("polish_chapter")
  })

  it("emits virtual-tool start/end events with the routing result", async () => {
    const events: Array<{ event: string; name: string; data: unknown }> = []
    const plugin = createRouteTaskPlugin({
      onVirtualTool: (event, name, data) => {
        events.push({ event, name, data })
      },
    })
    const result = await plugin.run(baseInput({ userMessage: "继续写下一章" }))

    expect(events).toHaveLength(2)
    expect(events[0].event).toBe("start")
    expect(events[0].name).toBe("route_task")
    const startData = events[0].data as { callId?: string; params?: { userMessage?: string } }
    expect(typeof startData.callId).toBe("string")
    expect(startData.callId).toMatch(/^route_task_/)
    expect(startData.params?.userMessage).toBe("继续写下一章")

    expect(events[1].event).toBe("end")
    const endData = events[1].data as { callId?: string; result?: string; status?: string }
    expect(endData.callId).toBe(startData.callId)
    expect(endData.status).toBe("done")
    expect(JSON.parse(endData.result as string)).toEqual(result.taskRoute)
  })

  it("works without virtual-tool callbacks", async () => {
    const plugin = createRouteTaskPlugin()
    const result = await plugin.run(baseInput({ userMessage: "帮我审稿" }))
    expect(result.taskRoute?.intent).toBe("review_chapter")
  })

  it("generates distinct callIds per run", async () => {
    let tick = 1000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => tick++)
    try {
      const callIds: string[] = []
      const plugin = createRouteTaskPlugin({
        onVirtualTool: (event, _name, data) => {
          if (event === "start") callIds.push((data as { callId?: string }).callId ?? "")
        },
      })
      await plugin.run(baseInput({ userMessage: "a" }))
      await plugin.run(baseInput({ userMessage: "b" }))
      expect(callIds).toEqual(["route_task_1000", "route_task_1001"])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("emits no virtual-tool events when not in novel mode", async () => {
    const onVirtualTool = vi.fn()
    const plugin = createRouteTaskPlugin({ onVirtualTool })
    const result = await plugin.run(baseInput({ novelMode: false }))
    expect(result).toEqual({})
    expect(onVirtualTool).not.toHaveBeenCalled()
  })
})
