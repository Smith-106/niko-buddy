// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

describe("ChatPanel A11y — ContextPack replay disclosure semantics", () => {
  const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")

  it("does not override <summary> native disclosure semantics with role=\"note\"", () => {
    const start = source.indexOf('data-testid="context-pack-replay-collapsible"')
    expect(start).toBeGreaterThan(-1)
    const snippet = source.slice(start, start + 400)
    expect(snippet).toContain("<summary")
    expect(snippet).not.toContain('role="note"')
  })
})
