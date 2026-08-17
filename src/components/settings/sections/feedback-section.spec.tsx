// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/sections/feedback-section.tsx

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, waitFor } from "@testing-library/react"
import {
  act,
  fireEvent,
  render,
  screen,
} from "@/test-helpers/component-test-utils"
import { FeedbackSection } from "./feedback-section"

const mocks = vi.hoisted(() => ({
  submitFeedback: vi.fn(),
}))

vi.mock("@/lib/feedback", () => ({
  submitFeedback: mocks.submitFeedback,
}))

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  mocks.submitFeedback.mockReset()
  mocks.submitFeedback.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

describe("FeedbackSection", () => {
  it("renders the form and keeps the submit button disabled until a message is typed", () => {
    render(<FeedbackSection />)
    const btn = screen.getByRole("button", { name: "提交反馈" })
    expect(btn).toBeDisabled()
    fireEvent.change(screen.getByLabelText("反馈内容"), { target: { value: "hello" } })
    expect(btn).not.toBeDisabled()
  })

  it("switches feedback type via the select", () => {
    render(<FeedbackSection />)
    const select = screen.getByLabelText("反馈类型") as HTMLSelectElement
    fireEvent.change(select, { target: { value: "bug" } })
    expect(select.value).toBe("bug")
    fireEvent.change(select, { target: { value: "other" } })
    expect(select.value).toBe("other")
  })

  it("submits successfully: clears message/contact and shows the thanks status", async () => {
    render(<FeedbackSection />)
    fireEvent.change(screen.getByLabelText("反馈内容"), { target: { value: "  nice tool  " } })
    fireEvent.change(screen.getByLabelText("联系方式（选填）"), { target: { value: "me@x.com" } })
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }))

    await waitFor(() => {
      expect(screen.getByText("反馈已提交，谢谢。")).toBeInTheDocument()
    })
    expect(mocks.submitFeedback).toHaveBeenCalledWith({
      type: "suggestion",
      message: "  nice tool  ",
      contact: "me@x.com",
    })
    expect((screen.getByLabelText("反馈内容") as HTMLTextAreaElement).value).toBe("")
    expect((screen.getByLabelText("联系方式（选填）") as HTMLInputElement).value).toBe("")
  })

  it("submit failure with an Error shows its message in destructive styling", async () => {
    mocks.submitFeedback.mockRejectedValue(new Error("反馈提交失败，请稍后再试"))
    render(<FeedbackSection />)
    fireEvent.change(screen.getByLabelText("反馈内容"), { target: { value: "x" } })
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }))
    await waitFor(() => {
      expect(screen.getByText("反馈提交失败，请稍后再试")).toBeInTheDocument()
    })
    const status = screen.getByText("反馈提交失败，请稍后再试")
    expect(status.className).toContain("text-destructive")
    // 提交失败后按钮恢复可点
    expect(screen.getByRole("button", { name: "提交反馈" })).not.toBeDisabled()
  })

  it("submit failure with a non-Error stringifies the value", async () => {
    mocks.submitFeedback.mockRejectedValue("plain failure")
    render(<FeedbackSection />)
    fireEvent.change(screen.getByLabelText("反馈内容"), { target: { value: "x" } })
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }))
    await waitFor(() => expect(screen.getByText("plain failure")).toBeInTheDocument())
  })

  it("请输入 error status also counts as destructive", async () => {
    mocks.submitFeedback.mockRejectedValue(new Error("请输入反馈内容"))
    render(<FeedbackSection />)
    fireEvent.change(screen.getByLabelText("反馈内容"), { target: { value: "x" } })
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }))
    await waitFor(() => {
      expect(screen.getByText("请输入反馈内容").className).toContain("text-destructive")
    })
  })

  it("submitting state shows 提交中... and the button re-disables after the message clears", async () => {
    let resolveSubmit: (() => void) | undefined
    mocks.submitFeedback.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve
        }),
    )
    render(<FeedbackSection />)
    fireEvent.change(screen.getByLabelText("反馈内容"), { target: { value: "x" } })
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }))
    await flushAsync()
    expect(screen.getByRole("button", { name: "提交中..." })).toBeDisabled()
    await act(async () => {
      resolveSubmit?.()
    })
    await waitFor(() => {
      // 成功后 message 被清空 → canSubmit 再次为 false → 按钮回到禁用态
      expect(screen.getByText("反馈已提交，谢谢。")).toBeInTheDocument()
    })
    expect(screen.getByRole("button", { name: "提交反馈" })).toBeDisabled()
  })

  it("clicking while message empty is a no-op (canSubmit guard)", async () => {
    render(<FeedbackSection />)
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }))
    await flushAsync()
    expect(mocks.submitFeedback).not.toHaveBeenCalled()
  })

  it("whitespace-only message keeps the button disabled", () => {
    render(<FeedbackSection />)
    fireEvent.change(screen.getByLabelText("反馈内容"), { target: { value: "   " } })
    expect(screen.getByRole("button", { name: "提交反馈" })).toBeDisabled()
  })
})
