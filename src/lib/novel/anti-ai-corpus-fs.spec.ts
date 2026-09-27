/** C4 冒烟覆盖：src/lib/novel/anti-ai-corpus-fs.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { resolveDefaultCorpusRoot, loadCorpusLayer } from "./anti-ai-corpus-fs"
describe("anti-ai-corpus-fs.ts smoke", () => {
  it("resolveDefaultCorpusRoot() executes", async () => {
    await (resolveDefaultCorpusRoot() as unknown as Promise<unknown>)
  })
  it("exports loadCorpusLayer", () => {
    expect(loadCorpusLayer).toBeDefined()
  })
})
