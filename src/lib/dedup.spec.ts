import { describe, expect, it } from "vitest"
import {
  buildEntityLinkIndex,
  extractEntitySummary,
  normalizeEntityLinkKey,
  resolveEntityLink,
} from "./dedup"

describe("deterministic entity linking", () => {
  const hero = extractEntitySummary("wiki/entities/lin-yun.md", `---
type: entity
title: "林云"
tags: [character]
aliases: ["阿云", "林・云"]
---
# 林云
`)!

  it("normalizes width, case, whitespace, and punctuation deterministically", () => {
    expect(normalizeEntityLinkKey(" 林・云 ")).toBe(normalizeEntityLinkKey("林云"))
    expect(normalizeEntityLinkKey("VFA")).toBe("vfa")
  })

  it("links a unique title or alias to the existing canonical entity", () => {
    const index = buildEntityLinkIndex([hero])
    expect(resolveEntityLink(index, "阿云", "character")).toMatchObject({ canonicalName: "林云", source: "alias" })
    expect(resolveEntityLink(index, "林・云", "character")).toMatchObject({ canonicalName: "林云" })
  })

  it("does not cross-link entities of different kinds", () => {
    const place = extractEntitySummary("wiki/entities/lin-yun-tower.md", `---
type: entity
title: "林云"
tags: [location]
---
# 林云
`)!
    const index = buildEntityLinkIndex([hero, place])
    expect(resolveEntityLink(index, "林云", "character")).toMatchObject({ canonicalName: "林云", type: "character" })
    expect(resolveEntityLink(index, "林云", "location")).toMatchObject({ canonicalName: "林云", type: "location" })
  })

  it("leaves a new entity and ambiguous aliases unresolved", () => {
    const rival = extractEntitySummary("wiki/entities/chen-yun.md", `---
type: entity
title: "陈云"
tags: [character]
aliases: ["阿云"]
---
# 陈云
`)!
    const index = buildEntityLinkIndex([hero, rival])
    expect(resolveEntityLink(index, "新人物", "character")).toBeNull()
    expect(resolveEntityLink(index, "阿云", "character")).toBeNull()
  })
})
