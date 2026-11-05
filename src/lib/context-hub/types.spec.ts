/**
 * context-hub/types 行为测试（新建；此前无 spec，lines 0%）。
 *
 * 文件名虽叫 types，但包含可执行代码：isCurrentContextHubStats /
 * parseContextHubSnapshot / parseContextHubSnapshotRef（含内部 normalize）。
 * 全部用真实调用 + 行为断言覆盖。
 */
import { describe, expect, it } from "vitest"
import {
  CONTEXT_CACHE_SCHEMA_VERSION,
  isCurrentContextHubStats,
  parseContextHubSnapshot,
  parseContextHubSnapshotRef,
  type ContextHubStats,
} from "./types"

function makeStats(
  overrides: Omit<Partial<ContextHubStats>, "requestDiagnostics"> & {
    // 运行时健壮性用例会传入非法 requestDiagnostics（如字符串 requestCount、
    // 非法 scope、非数组 requests），故在 helper 边界放宽为 unknown，
    // 内部再断言还原为 ContextHubStats（运行时形状由被测解析器校验）。
    requestDiagnostics?: unknown
  } = {},
): ContextHubStats {
  return {
    cacheHits: 2,
    reloaded: 1,
    empty: 0,
    fallbackUsed: 0,
    readFailed: 0,
    writeFailed: 0,
    stableTokens: 100,
    summaryTokens: 50,
    dynamicTokens: 200,
    candidateTokens: 400,
    estimatedSavedTokens: 30,
    estimatedSavedPercent: 10,
    expanded: false,
    providerCacheEnabled: true,
    ...overrides,
  } as ContextHubStats
}

function makeTrace(overrides: Record<string, unknown> = {}) {
  return {
    provider: "openai",
    model: "gpt-test",
    apiMode: "chat",
    startedAt: 100,
    finishedAt: 200,
    durationMs: 100,
    status: "success",
    ...overrides,
  }
}

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: CONTEXT_CACHE_SCHEMA_VERSION,
    id: "snap-1",
    surface: "ai-chat",
    createdAt: 1700000000000,
    stats: makeStats(),
    items: [
      {
        key: "k1",
        sourceName: "s1",
        status: "cache_hit",
        dependencyStamp: { fingerprint: "abc", sourceCount: 1, kinds: ["chapter"] },
        dependencyPaths: ["a.md"],
        dependencyPathsTruncated: false,
      },
    ],
    stableCore: "core",
    sessionSummary: "summary",
    dynamicContext: "dynamic",
    ...overrides,
  }
}

describe("CONTEXT_CACHE_SCHEMA_VERSION", () => {
  it("当前版本为 2", () => {
    expect(CONTEXT_CACHE_SCHEMA_VERSION).toBe(2)
  })
})

describe("isCurrentContextHubStats", () => {
  it("完整的新形状返回 true", () => {
    expect(isCurrentContextHubStats(makeStats())).toBe(true)
  })

  it("非对象一律拒绝", () => {
    for (const raw of [null, undefined, 0, "x", [], true]) {
      expect(isCurrentContextHubStats(raw)).toBe(false)
    }
  })

  it("缺任一计数/ token 字段即拒绝", () => {
    const base = makeStats()
    for (const key of [
      "cacheHits",
      "reloaded",
      "empty",
      "fallbackUsed",
      "readFailed",
      "writeFailed",
      "stableTokens",
      "summaryTokens",
      "dynamicTokens",
      "candidateTokens",
      "estimatedSavedTokens",
      "estimatedSavedPercent",
    ] as const) {
      const broken = { ...base }
      delete (broken as Record<string, unknown>)[key]
      expect(isCurrentContextHubStats(broken), key).toBe(false)
    }
  })

  it("非有限数字（NaN/Infinity/字符串）拒绝", () => {
    expect(isCurrentContextHubStats(makeStats({ cacheHits: Number.NaN }))).toBe(false)
    expect(isCurrentContextHubStats(makeStats({ reloaded: Number.POSITIVE_INFINITY }))).toBe(false)
    expect(isCurrentContextHubStats({ ...makeStats(), stableTokens: "100" })).toBe(false)
  })

  it("expanded / providerCacheEnabled 非布尔拒绝", () => {
    expect(isCurrentContextHubStats({ ...makeStats(), expanded: 1 })).toBe(false)
    expect(isCurrentContextHubStats({ ...makeStats(), providerCacheEnabled: "yes" })).toBe(false)
  })

  it("旧形状（hits/refreshed/failures）被拒绝", () => {
    const legacy = {
      hits: 2,
      refreshed: 1,
      failures: 0,
      expanded: false,
      providerCacheEnabled: false,
    }
    expect(isCurrentContextHubStats(legacy)).toBe(false)
  })

  it("多余字段不影响判定", () => {
    expect(isCurrentContextHubStats({ ...makeStats(), extra: 1 })).toBe(true)
  })
})

describe("parseContextHubSnapshot", () => {
  it("合法快照完整解析（含 warnings 与依赖路径）", () => {
    const parsed = parseContextHubSnapshot(
      makeSnapshot({ warnings: ["w1", 42, "w2"], items: [
        {
          key: "k1",
          sourceName: "s1",
          status: "reloaded",
          dependencyStamp: { fingerprint: "abc", sourceCount: 2, kinds: ["chapter"] },
          dependencyPaths: ["a.md", 123, "b.md"],
          dependencyPathsTruncated: 1,
        },
      ] }),
    )
    expect(parsed).not.toBeNull()
    expect(parsed!.id).toBe("snap-1")
    expect(parsed!.surface).toBe("ai-chat")
    expect(parsed!.warnings).toEqual(["w1", "w2"])
    expect(parsed!.items).toHaveLength(1)
    expect(parsed!.items[0].status).toBe("reloaded")
    // 非字符串路径被过滤，truthy 被归一为 true
    expect(parsed!.items[0].dependencyPaths).toEqual(["a.md", "b.md"])
    expect(parsed!.items[0].dependencyPathsTruncated).toBe(true)
  })

  it("六种现行 item 状态全部接受", () => {
    for (const status of [
      "cache_hit",
      "reloaded",
      "empty",
      "fallback_used",
      "read_failed",
      "write_failed",
    ]) {
      const parsed = parseContextHubSnapshot(makeSnapshot({ items: [
        {
          key: "k",
          sourceName: "s",
          status,
          dependencyStamp: { fingerprint: "f", sourceCount: 0, kinds: [] },
          dependencyPaths: [],
        },
      ] }))
      expect(parsed?.items[0].status, status).toBe(status)
    }
  })

  it("无 warnings 时不带 warnings 键", () => {
    const parsed = parseContextHubSnapshot(makeSnapshot())
    expect(parsed).not.toBeNull()
    expect("warnings" in parsed!).toBe(false)
  })

  it("非对象/空直接返回 null", () => {
    for (const raw of [null, undefined, 0, "snap", []]) {
      expect(parseContextHubSnapshot(raw)).toBeNull()
    }
  })

  it("schemaVersion 不符拒绝（含旧版本）", () => {
    expect(parseContextHubSnapshot(makeSnapshot({ schemaVersion: 1 }))).toBeNull()
    expect(parseContextHubSnapshot(makeSnapshot({ schemaVersion: "2" }))).toBeNull()
  })

  it("surface 非法拒绝", () => {
    expect(parseContextHubSnapshot(makeSnapshot({ surface: "ai-write" }))).toBeNull()
  })

  it("id/createdAt/文本字段类型错误拒绝", () => {
    expect(parseContextHubSnapshot(makeSnapshot({ id: 1 }))).toBeNull()
    expect(parseContextHubSnapshot(makeSnapshot({ createdAt: "t" }))).toBeNull()
    expect(parseContextHubSnapshot(makeSnapshot({ stableCore: 1 }))).toBeNull()
    expect(parseContextHubSnapshot(makeSnapshot({ sessionSummary: null }))).toBeNull()
    expect(parseContextHubSnapshot(makeSnapshot({ dynamicContext: 0 }))).toBeNull()
  })

  it("stats 非现行形状拒绝", () => {
    expect(
      parseContextHubSnapshot(makeSnapshot({ stats: { hits: 1, expanded: false } })),
    ).toBeNull()
  })

  it("warnings 非数组拒绝", () => {
    expect(parseContextHubSnapshot(makeSnapshot({ warnings: "w1" }))).toBeNull()
  })

  it("items 非数组拒绝；item 非对象拒绝", () => {
    expect(parseContextHubSnapshot(makeSnapshot({ items: {} }))).toBeNull()
    expect(parseContextHubSnapshot(makeSnapshot({ items: [null] }))).toBeNull()
    expect(parseContextHubSnapshot(makeSnapshot({ items: ["x"] }))).toBeNull()
  })

  it("item 缺 key/sourceName/坏 status/缺 stamp/坏 paths 拒绝", () => {
    const good = {
      key: "k",
      sourceName: "s",
      status: "cache_hit",
      dependencyStamp: { fingerprint: "f", sourceCount: 0, kinds: [] },
      dependencyPaths: [] as unknown[],
    }
    expect(parseContextHubSnapshot(makeSnapshot({ items: [{ ...good, key: 1 }] }))).toBeNull()
    expect(parseContextHubSnapshot(makeSnapshot({ items: [{ ...good, sourceName: 2 }] }))).toBeNull()
    // 旧状态字符串（如 hit）拒绝
    expect(parseContextHubSnapshot(makeSnapshot({ items: [{ ...good, status: "hit" }] }))).toBeNull()
    expect(parseContextHubSnapshot(makeSnapshot({ items: [{ ...good, status: 0 }] }))).toBeNull()
    expect(
      parseContextHubSnapshot(makeSnapshot({ items: [{ ...good, dependencyStamp: null }] })),
    ).toBeNull()
    expect(
      parseContextHubSnapshot(makeSnapshot({ items: [{ ...good, dependencyStamp: "x" }] })),
    ).toBeNull()
    expect(
      parseContextHubSnapshot(makeSnapshot({ items: [{ ...good, dependencyPaths: "a.md" }] })),
    ).toBeNull()
  })

  it("requestDiagnostics 合法时被归一化（取整/过滤/拷贝）", () => {
    const parsed = parseContextHubSnapshot(makeSnapshot({
      stats: makeStats({
        requestDiagnostics: {
          requestCount: 2.9,
          requestCountAvailable: true,
          usageScope: "workflow",
          providerUsageAvailable: true,
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 5,
          cacheWriteTokens: 6,
          requests: [makeTrace(), { provider: "nope", model: 1 }],
          omittedRequestCount: 1.7,
        },
      }),
    }))
    const diag = parsed!.stats.requestDiagnostics!
    expect(diag.requestCount).toBe(2)
    expect(diag.requestCountAvailable).toBe(true)
    expect(diag.usageScope).toBe("workflow")
    expect(diag.inputTokens).toBe(10)
    // 非法 trace 被过滤，只剩一条
    expect(diag.requests).toHaveLength(1)
    expect(diag.requests![0].provider).toBe("openai")
    expect(diag.omittedRequestCount).toBe(1)
  })

  it("requestDiagnostics 非法时被丢弃（不带该键但快照仍有效）", () => {
    for (const bad of [
      { requestCount: "2", providerUsageAvailable: true },
      { requestCount: 2, providerUsageAvailable: "yes" },
      { requestCount: 2, providerUsageAvailable: true, inputTokens: "10" },
      { requestCount: 2, providerUsageAvailable: true, outputTokens: Number.NaN },
      { requestCount: 2, providerUsageAvailable: true, cacheReadTokens: Infinity },
      { requestCount: 2, providerUsageAvailable: true, cacheWriteTokens: null },
    ]) {
      const parsed = parseContextHubSnapshot(
        makeSnapshot({ stats: makeStats({ requestDiagnostics: bad }) }),
      )
      expect(parsed).not.toBeNull()
      expect("requestDiagnostics" in parsed!.stats).toBe(false)
    }
  })

  it("requestDiagnostics 可选字段缺省/非法 scope 处理", () => {
    // 无 requestCountAvailable / 无 scope 时键不存在而非 undefined
    const bare = parseContextHubSnapshot(makeSnapshot({
      stats: makeStats({ requestDiagnostics: { requestCount: 1, providerUsageAvailable: false } }),
    }))
    expect(bare!.stats.requestDiagnostics).toEqual({ requestCount: 1, providerUsageAvailable: false })

    // 非法 scope 被丢弃；合法 provider_thread 保留
    const badScope = parseContextHubSnapshot(makeSnapshot({
      stats: makeStats({
        requestDiagnostics: { requestCount: 1, providerUsageAvailable: true, usageScope: "other" },
      }),
    }))
    expect("usageScope" in badScope!.stats.requestDiagnostics!).toBe(false)

    const threadScope = parseContextHubSnapshot(makeSnapshot({
      stats: makeStats({
        requestDiagnostics: {
          requestCount: 1,
          providerUsageAvailable: true,
          usageScope: "provider_thread",
          requestCountAvailable: false,
        },
      }),
    }))
    expect(threadScope!.stats.requestDiagnostics!.usageScope).toBe("provider_thread")
    expect(threadScope!.stats.requestDiagnostics!.requestCountAvailable).toBe(false)
  })

  it("requestDiagnostics 非对象/缺字段时丢弃", () => {
    for (const bad of [null, "x", 42, {}, { requestCount: 1 }]) {
      const parsed = parseContextHubSnapshot(
        makeSnapshot({ stats: makeStats({ requestDiagnostics: bad }) }),
      )
      expect(parsed).not.toBeNull()
      expect("requestDiagnostics" in parsed!.stats).toBe(false)
    }
  })

  it("requests 非数组时不带 requests 键", () => {
    const parsed = parseContextHubSnapshot(makeSnapshot({
      stats: makeStats({
        requestDiagnostics: { requestCount: 1, providerUsageAvailable: true, requests: "bad" },
      }),
    }))
    expect(parsed!.stats.requestDiagnostics).toEqual({
      requestCount: 1,
      providerUsageAvailable: true,
    })
  })

  it("负 requestCount / omitted 被钳到 0", () => {
    const parsed = parseContextHubSnapshot(makeSnapshot({
      stats: makeStats({
        requestDiagnostics: { requestCount: -3.2, providerUsageAvailable: true, omittedRequestCount: -1 },
      }),
    }))
    expect(parsed!.stats.requestDiagnostics!.requestCount).toBe(0)
    expect(parsed!.stats.requestDiagnostics!.omittedRequestCount).toBe(0)
  })
})

describe("parseContextHubSnapshotRef", () => {
  it("合法 ref 解析成功并归一化 diagnostics", () => {
    const ref = parseContextHubSnapshotRef({
      id: "r1",
      surface: "ai-outline",
      createdAt: 123,
      stats: makeStats({
        requestDiagnostics: { requestCount: 3.7, providerUsageAvailable: true },
      }),
    })
    expect(ref).not.toBeNull()
    expect(ref!.id).toBe("r1")
    expect(ref!.surface).toBe("ai-outline")
    expect(ref!.stats.requestDiagnostics!.requestCount).toBe(3)
  })

  it("非对象/字段缺失或类型错误返回 null", () => {
    expect(parseContextHubSnapshotRef(null)).toBeNull()
    expect(parseContextHubSnapshotRef({})).toBeNull()
    expect(
      parseContextHubSnapshotRef({ id: 1, surface: "ai-chat", createdAt: 1, stats: makeStats() }),
    ).toBeNull()
    expect(
      parseContextHubSnapshotRef({ id: "r", surface: "bad", createdAt: 1, stats: makeStats() }),
    ).toBeNull()
    expect(
      parseContextHubSnapshotRef({ id: "r", surface: "ai-chat", createdAt: "t", stats: makeStats() }),
    ).toBeNull()
    expect(
      parseContextHubSnapshotRef({ id: "r", surface: "ai-chat", createdAt: 1, stats: { hits: 1 } }),
    ).toBeNull()
  })

  it("非法 diagnostics 被丢弃但 ref 仍有效", () => {
    const ref = parseContextHubSnapshotRef({
      id: "r",
      surface: "ai-chat",
      createdAt: 1,
      stats: makeStats({ requestDiagnostics: { requestCount: "x", providerUsageAvailable: true } }),
    })
    expect(ref).not.toBeNull()
    expect("requestDiagnostics" in ref!.stats).toBe(false)
  })
})
