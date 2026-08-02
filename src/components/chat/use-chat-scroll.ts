// Copyright (c) 2024 Niko-hub contributors. MIT License.
import { useRef, useState, useEffect, useCallback } from "react"

/**
 * Manages auto-scroll behavior for chat message lists.
 * - Auto-scrolls to bottom when new messages arrive or streaming content updates.
 * - Stops auto-scroll if user manually scrolls up.
 * - Resumes auto-scroll when user scrolls back to bottom.
 * - Provides a scroll-to-bottom FAB visibility state and action.
 */
export function useChatAutoScroll(deps: {
  activeMessages: unknown[]
  streamingContent: string
  isStreaming: boolean
  activeConversationId: string | null
}) {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const userScrolledUpRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)

  // Auto-scroll to bottom when messages change or streaming content updates,
  // but stop if user manually scrolled up.
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    if (!userScrolledUpRef.current) {
      container.scrollTop = container.scrollHeight
      lastScrollTopRef.current = container.scrollTop
    }
  }, [deps.activeMessages, deps.streamingContent])

  // Detect user scroll: if user scrolls up, stop auto-scroll; if at bottom, resume.
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    lastScrollTopRef.current = container.scrollTop
    const handleScroll = () => {
      const threshold = 50
      const currentScrollTop = container.scrollTop
      const atBottom = container.scrollHeight - currentScrollTop - container.clientHeight < threshold
      if (currentScrollTop < lastScrollTopRef.current - 1) {
        userScrolledUpRef.current = true
      } else if (atBottom) {
        userScrolledUpRef.current = false
      }
      lastScrollTopRef.current = currentScrollTop
      setShowScrollToBottom(userScrolledUpRef.current)
    }
    container.addEventListener("scroll", handleScroll)
    return () => container.removeEventListener("scroll", handleScroll)
  }, [deps.activeConversationId])

  // Reset scroll lock when streaming ends or conversation changes.
  useEffect(() => {
    if (!deps.isStreaming) {
      userScrolledUpRef.current = false
      setShowScrollToBottom(false)
    }
  }, [deps.isStreaming])

  useEffect(() => {
    userScrolledUpRef.current = false
    setShowScrollToBottom(false)
  }, [deps.activeConversationId])

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
    lastScrollTopRef.current = container.scrollTop
    userScrolledUpRef.current = false
    setShowScrollToBottom(false)
  }, [])

  return {
    scrollContainerRef,
    bottomRef,
    showScrollToBottom,
    scrollToBottom,
  }
}
