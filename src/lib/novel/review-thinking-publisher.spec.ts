import { describe, expect, it, vi } from "vitest"
import {
  createReviewThinkingPublisher,
  truncateReviewThinking,
} from "./review-thinking-publisher"

describe("review-thinking-publisher", () => {
  it("publishes first thinking immediately", () => {
    const publish = vi.fn()
    const publisher = createReviewThinkingPublisher({ publish, now: () => 0 })
    publisher.publish("hello")
    expect(publish).toHaveBeenCalledWith("hello")
  })

  it("throttles publishes within min interval", () => {
    const publish = vi.fn()
    let now = 0
    const publisher = createReviewThinkingPublisher({ publish, now: () => now })
    publisher.publish("a")
    now = 100
    publisher.publish("b") // still inside 300ms window -> dropped
    expect(publish).toHaveBeenCalledTimes(1)
    now = 400
    publisher.publish("b")
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith("b")
  })

  it("does not re-publish identical thinking", () => {
    const publish = vi.fn()
    let now = 0
    const publisher = createReviewThinkingPublisher({ publish, now: () => now })
    publisher.publish("same")
    now = 500
    publisher.publish("same")
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it("flush force-publishes latest thinking even within interval", () => {
    const publish = vi.fn()
    let now = 0
    const publisher = createReviewThinkingPublisher({ publish, now: () => now })
    publisher.publish("first")
    now = 100
    publisher.publish("second")
    expect(publish).toHaveBeenCalledTimes(1)
    publisher.flush()
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith("second")
  })

  it("flush with no pending thinking is a no-op", () => {
    const publish = vi.fn()
    const publisher = createReviewThinkingPublisher({ publish })
    publisher.flush()
    expect(publish).not.toHaveBeenCalled()
  })

  it("flush does not re-publish identical content", () => {
    const publish = vi.fn()
    const publisher = createReviewThinkingPublisher({ publish })
    publisher.publish("x")
    publisher.flush()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it("truncates thinking beyond maxChars with folded note", () => {
    const result = truncateReviewThinking("a".repeat(12001), 12000)
    expect(result).toContain("1 字审阅过程已折叠")
    expect(result.endsWith("a".repeat(12000))).toBe(true)
  })

  it("keeps short thinking unchanged", () => {
    expect(truncateReviewThinking("short", 12000)).toBe("short")
  })

  it("publisher truncates with custom maxChars", () => {
    const publish = vi.fn()
    const publisher = createReviewThinkingPublisher({
      publish,
      maxChars: 10,
      now: () => 0,
    })
    publisher.publish("abcdefghijklmnop")
    expect(publish).toHaveBeenCalledWith(
      expect.stringContaining("6 字审阅过程已折叠"),
    )
  })

  it("applies custom minIntervalMs", () => {
    const publish = vi.fn()
    let now = 0
    const publisher = createReviewThinkingPublisher({
      publish,
      minIntervalMs: 1000,
      now: () => now,
    })
    publisher.publish("a")
    now = 500
    publisher.publish("b")
    expect(publish).toHaveBeenCalledTimes(1)
    now = 1001
    publisher.publish("c")
    expect(publish).toHaveBeenCalledTimes(2)
  })
})
