// @vitest-environment jsdom
// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import * as jestDomMatchers from "@testing-library/jest-dom/matchers"
import { useMainControlRuntimeStore } from "@/stores/main-control-runtime-store"
import { MainControlAutonomyBar } from "./main-control-autonomy-bar"

expect.extend(jestDomMatchers)

const wikiState = vi.hoisted(() => ({
  project: { id: "p1", name: "测试书", path: "/proj-a" } as { id: string; name: string; path: string } | null,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: <T,>(selector: (s: typeof wikiState) => T) => selector(wikiState),
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("./campaign-dashboard-dialog", () => ({
  CampaignDashboardDialog: ({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) => (
    <div data-testid="mock-campaign-dialog" data-open={String(open)}>
      {open ? (
        <button type="button" data-testid="mock-campaign-close" onClick={() => onOpenChange(false)}>
          close
        </button>
      ) : null}
    </div>
  ),
}))

vi.mock("./autonomous-incubator-dialog", () => ({
  AutonomousIncubatorDialog: ({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) => (
    <div data-testid="mock-incubator-dialog" data-open={String(open)}>
      {open ? (
        <button type="button" data-testid="mock-incubator-close" onClick={() => onOpenChange(false)}>
          close
        </button>
      ) : null}
    </div>
  ),
}))

beforeEach(() => {
  wikiState.project = { id: "p1", name: "测试书", path: "/proj-a" }
  useMainControlRuntimeStore.getState().reset()
})

afterEach(() => {
  cleanup()
  useMainControlRuntimeStore.getState().reset()
})

describe("MainControlAutonomyBar", () => {
  it("有项目时渲染长程战役与冷启动孵化按钮，点击分别打开对应弹窗", () => {
    render(<MainControlAutonomyBar />)
    const campaignBtn = screen.getByTestId("main-control-launch-campaign") as HTMLButtonElement
    const incubatorBtn = screen.getByTestId("main-control-launch-incubator") as HTMLButtonElement

    expect(campaignBtn).not.toBeDisabled()
    expect(incubatorBtn).not.toBeDisabled()
    expect(screen.getByTestId("mock-campaign-dialog")).toHaveAttribute("data-open", "false")
    expect(screen.getByTestId("mock-incubator-dialog")).toHaveAttribute("data-open", "false")

    fireEvent.click(campaignBtn)
    expect(screen.getByTestId("mock-campaign-dialog")).toHaveAttribute("data-open", "true")
    fireEvent.click(screen.getByTestId("mock-campaign-close"))
    expect(screen.getByTestId("mock-campaign-dialog")).toHaveAttribute("data-open", "false")

    fireEvent.click(incubatorBtn)
    expect(screen.getByTestId("mock-incubator-dialog")).toHaveAttribute("data-open", "true")
    fireEvent.click(screen.getByTestId("mock-incubator-close"))
    expect(screen.getByTestId("mock-incubator-dialog")).toHaveAttribute("data-open", "false")
  })

  it("project=null 时两个按钮均禁用，且不会响应 pendingLaunchDialog", async () => {
    wikiState.project = null
    useMainControlRuntimeStore.getState().requestLaunchDialog("campaign")
    render(<MainControlAutonomyBar />)

    expect(screen.getByTestId("main-control-launch-campaign")).toBeDisabled()
    expect(screen.getByTestId("main-control-launch-incubator")).toBeDisabled()
    await waitFor(() => {
      expect(useMainControlRuntimeStore.getState().pendingLaunchDialog).toBeNull()
    })
    expect(screen.getByTestId("mock-campaign-dialog")).toHaveAttribute("data-open", "false")
    expect(screen.getByTestId("mock-incubator-dialog")).toHaveAttribute("data-open", "false")
  })

  it("订阅纯内存 pendingLaunchDialog：挂载前与挂载后触发 campaign / incubator 均自动打开并消费清零", async () => {
    useMainControlRuntimeStore.getState().requestLaunchDialog("campaign")
    render(<MainControlAutonomyBar />)

    await waitFor(() => {
      expect(screen.getByTestId("mock-campaign-dialog")).toHaveAttribute("data-open", "true")
    })
    expect(useMainControlRuntimeStore.getState().pendingLaunchDialog).toBeNull()

    // 挂载后再通过 Ctrl+K 请求 incubator
    useMainControlRuntimeStore.getState().requestLaunchDialog("incubator")
    await waitFor(() => {
      expect(screen.getByTestId("mock-incubator-dialog")).toHaveAttribute("data-open", "true")
    })
    expect(useMainControlRuntimeStore.getState().pendingLaunchDialog).toBeNull()
  })

  it("main-control-runtime-store：syncProject 切换项目与 reset 均清零 pendingLaunchDialog", () => {
    const store = useMainControlRuntimeStore.getState()
    store.syncProject("/proj-a")
    store.requestLaunchDialog("campaign")
    expect(useMainControlRuntimeStore.getState().pendingLaunchDialog).toBe("campaign")

    // 同项目 syncProject 保留
    store.syncProject("/proj-a/")
    expect(useMainControlRuntimeStore.getState().pendingLaunchDialog).toBe("campaign")

    // 切换项目清零
    store.syncProject("/proj-b")
    expect(useMainControlRuntimeStore.getState().pendingLaunchDialog).toBeNull()

    // reset 清零
    store.requestLaunchDialog("incubator")
    expect(useMainControlRuntimeStore.getState().pendingLaunchDialog).toBe("incubator")
    store.reset()
    expect(useMainControlRuntimeStore.getState().pendingLaunchDialog).toBeNull()
  })
})
