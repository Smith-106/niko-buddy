import { expect, test } from "vitest"
import { getCopyableAssistantContent } from "./chat-copy-content"

test("copies generated chapter edit content instead of surrounding context", () => {
  const content = [
    "Outline context that should not be copied.",
    "",
    '<file_edit path="wiki/chapters/chapter-003.md">',
    "<search>",
    "Old chapter text.",
    "</search>",
    "<replace>",
    "# Chapter 3",
    "",
    "The usable chapter body starts here.",
    "</replace>",
    "</file_edit>",
  ].join("\n")

  const copied = getCopyableAssistantContent(content)

  expect(copied).toContain("The usable chapter body starts here.")
  expect(copied).not.toContain("Outline context")
  expect(copied).not.toContain("<file_edit")
})

test("joins multiple chapter edits into one copy payload", () => {
  const content = [
    '<file_edit path="wiki/chapters/chapter-001.md">',
    "<search>old</search>",
    "<replace># Chapter 1\n\nBody one.</replace>",
    "</file_edit>",
    '<file_edit path="wiki/chapters/chapter-002.md">',
    "<search>old</search>",
    "<replace># Chapter 2\n\nBody two.</replace>",
    "</file_edit>",
  ].join("\n")

  const copied = getCopyableAssistantContent(content)

  expect(copied).toContain("Body one.")
  expect(copied).toContain("Body two.")
  expect(copied.indexOf("Body one.")).toBeLessThan(copied.indexOf("Body two."))
})

test("ignores edits outside the wiki chapters directory and empty replaces", () => {
  const content = [
    "Intro text.",
    '<file_edit path="notes/other.md">',
    "<search>old</search>",
    "<replace>not a chapter</replace>",
    "</file_edit>",
    '<file_edit path="wiki/chapters/chapter-003.md">',
    "<search>old</search>",
    "<replace>   </replace>",
    "</file_edit>",
  ].join("\n")

  const copied = getCopyableAssistantContent(content)

  expect(copied).toContain("Intro text.")
  expect(copied).not.toContain("not a chapter")
})

test("strips HTML comments and paired think blocks from plain text", () => {
  const content = "Visible line.\n<!-- hidden comment -->\n<think>reasoning here</think>\nMore visible."

  const copied = getCopyableAssistantContent(content)

  expect(copied).toContain("Visible line.")
  expect(copied).toContain("More visible.")
  expect(copied).not.toContain("hidden comment")
  expect(copied).not.toContain("reasoning here")
})

test("strips unclosed think blocks and orphaned closing tags", () => {
  const content = "Prefix text.\n<thinking>never closed reasoning"

  const copied = getCopyableAssistantContent(content)

  expect(copied).toContain("Prefix text.")
  expect(copied).not.toContain("never closed")
})

test("strips a leading orphaned closing think tag", () => {
  const content = "<think>opened</think> tail text.\n</thinking>\nMore text."

  const copied = getCopyableAssistantContent(content)

  expect(copied).toBe("More text.")
})

test("keeps a closed think block untouched when no open tag precedes the close", () => {
  const content = "visible answer"

  const copied = getCopyableAssistantContent(content)

  expect(copied).toBe("visible answer")
})

test("falls back to the raw content when there is no parsed text", () => {
  const copied = getCopyableAssistantContent("   \n  ")

  expect(copied).toBe("")
})
