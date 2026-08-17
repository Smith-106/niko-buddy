import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  streamChat: vi.fn(),
  bumpDataVersion: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
}))

vi.mock("./llm-client", () => ({
  streamChat: mocks.streamChat,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: {
    getState: () => ({
      outputLanguage: "auto",
      bumpDataVersion: mocks.bumpDataVersion,
    }),
  },
}))

import { enrichWithWikilinks } from "./enrich-wikilinks"

const fakeLlmConfig = {} as LlmConfig

beforeEach(() => {
  vi.clearAllMocks()
})

describe("enrichWithWikilinks", () => {
  it("bails out when the page content is empty", async () => {
    mocks.readFile.mockImplementation(async (p: string) => (p.endsWith("index.md") ? "# Index" : ""))
    await enrichWithWikilinks("/P", "/P/wiki/a.md", fakeLlmConfig)
    expect(mocks.streamChat).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("bails out when the wiki index cannot be read", async () => {
    mocks.readFile.mockImplementation(async (p: string) =>
      p.endsWith("index.md") ? Promise.reject(new Error("no index")) : "body",
    )
    await enrichWithWikilinks("/P", "/P/wiki/a.md", fakeLlmConfig)
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it("applies parsed links, writes the file, and bumps the data version", async () => {
    mocks.readFile.mockImplementation(async (p: string) =>
      p.endsWith("index.md") ? "- transformer\n- Other" : "---\ntitle: A\n---\n\nTransformer is key. See transformer again and Other.",
    )
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"links":[{"term":"Transformer","target":"transformer"},{"term":"Other","target":"Other"}]}')
      callbacks.onDone()
    })

    await enrichWithWikilinks("/P", "/P/wiki/a.md", fakeLlmConfig)

    expect(mocks.streamChat).toHaveBeenCalledWith(
      fakeLlmConfig,
      expect.any(Array),
      expect.any(Object),
    )
    const written = mocks.writeFile.mock.calls[0]
    expect(written[0]).toBe("/P/wiki/a.md")
    expect(String(written[1])).toContain("[[Transformer]]")
    expect(String(written[1])).toContain("[[Other]]")
    expect(mocks.bumpDataVersion).toHaveBeenCalled()
  })

  it("keeps frontmatter untouched and links only the first unlinked occurrence per target", async () => {
    mocks.readFile.mockImplementation(async (p: string) =>
      p.endsWith("index.md") ? "- term" : "---\ntitle: X\nterm: not-linked\n---\n\nterm term term",
    )
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"links":[{"term":"term","target":"term"}]}')
      callbacks.onDone()
    })

    await enrichWithWikilinks("/P", "/P/wiki/b.md", fakeLlmConfig)

    const written = String(mocks.writeFile.mock.calls[0][1])
    expect(written.startsWith("---\ntitle: X\nterm: not-linked\n---")).toBe(true)
    expect(written).toContain("[[term]] term term")
  })

  it("does nothing when the LLM returns no valid links", async () => {
    mocks.readFile.mockImplementation(async (p: string) =>
      p.endsWith("index.md") ? "# Index" : "plain body",
    )
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"links":[]}')
      callbacks.onDone()
    })
    await enrichWithWikilinks("/P", "/P/wiki/c.md", fakeLlmConfig)
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("does nothing when parsing fails entirely", async () => {
    mocks.readFile.mockImplementation(async (p: string) =>
      p.endsWith("index.md") ? "# Index" : "plain body",
    )
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken("no json here")
      callbacks.onDone()
    })
    await enrichWithWikilinks("/P", "/P/wiki/c.md", fakeLlmConfig)
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("does not write when enrichment leaves content unchanged", async () => {
    mocks.readFile.mockImplementation(async (p: string) =>
      p.endsWith("index.md") ? "# Index" : "see [[plain body]] here",
    )
    // term appears only inside an existing wikilink → no change
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"links":[{"term":"plain","target":"plain"}]}')
      callbacks.onDone()
    })
    await enrichWithWikilinks("/P", "/P/wiki/c.md", fakeLlmConfig)
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("tolerates markdown-fenced JSON with nested braces and escaped strings", async () => {
    mocks.readFile.mockImplementation(async (p: string) =>
      p.endsWith("index.md") ? "- t" : 'he said "quoted" term here',
    )
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('```json\n{"links":[{"term":"term","target":"t"}]}\n```')
      callbacks.onDone()
    })
    await enrichWithWikilinks("/P", "/P/wiki/d.md", fakeLlmConfig)
    expect(mocks.writeFile).toHaveBeenCalledTimes(1)
    expect(String(mocks.writeFile.mock.calls[0][1])).toContain("[[t|term]]")
  })

  it("handles escaped quotes inside LLM JSON terms", async () => {
    mocks.readFile.mockImplementation(async (p: string) =>
      p.endsWith("index.md") ? "- t" : 'he said "hi" there',
    )
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"links":[{"term":"he said \\"hi\\"","target":"t"}]}')
      callbacks.onDone()
    })
    await enrichWithWikilinks("/P", "/P/wiki/g.md", fakeLlmConfig)
    expect(String(mocks.writeFile.mock.calls[0][1])).toBe('[[t|he said "hi"]] there')
  })

  it("returns no links for unbalanced braces", async () => {
    mocks.readFile.mockImplementation(async (p: string) =>
      p.endsWith("index.md") ? "# Index" : "body",
    )
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"links": [')
      callbacks.onDone()
    })
    await enrichWithWikilinks("/P", "/P/wiki/h.md", fakeLlmConfig)
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("returns no links when links is not an array", async () => {
    mocks.readFile.mockImplementation(async (p: string) =>
      p.endsWith("index.md") ? "# Index" : "body",
    )
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"links":{}}')
      callbacks.onDone()
    })
    await enrichWithWikilinks("/P", "/P/wiki/i.md", fakeLlmConfig)
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("returns no links when the JSON inside braces is malformed", async () => {
    mocks.readFile.mockImplementation(async (p: string) =>
      p.endsWith("index.md") ? "# Index" : "body",
    )
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"links": [broken}')
      callbacks.onDone()
    })
    await enrichWithWikilinks("/P", "/P/wiki/j.md", fakeLlmConfig)
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("stops scanning when a skipped term ends at the document boundary", async () => {
    mocks.readFile.mockImplementation(async (p: string) =>
      p.endsWith("index.md") ? "# Index" : "x [[plain",
    )
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"links":[{"term":"plain","target":"plain"}]}')
      callbacks.onDone()
    })
    await enrichWithWikilinks("/P", "/P/wiki/k.md", fakeLlmConfig)
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("handles stream errors without throwing", async () => {
    mocks.readFile.mockImplementation(async (p: string) =>
      p.endsWith("index.md") ? "# Index" : "body",
    )
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onError(new Error("stream broke"))
    })
    await expect(enrichWithWikilinks("/P", "/P/wiki/e.md", fakeLlmConfig)).resolves.toBeUndefined()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("ignores invalid link entries and keeps only well-formed ones", async () => {
    mocks.readFile.mockImplementation(async (p: string) =>
      p.endsWith("index.md") ? "- ok" : "alpha beta",
    )
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken(
        '{"links":[{"term":"","target":"ok"},{"term":"alpha","target":"ok"},{"term":"beta","target":""},{"term":"gamma","target":"ok"}]}',
      )
      callbacks.onDone()
    })
    await enrichWithWikilinks("/P", "/P/wiki/f.md", fakeLlmConfig)
    expect(String(mocks.writeFile.mock.calls[0][1])).toBe("[[ok|alpha]] beta")
  })
})
