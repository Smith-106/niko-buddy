import { describe, expect, it } from "vitest";

import {
  BRIEFING_SOURCE_KINDS,
  assertSourced,
  buildBriefingDigest,
  currentChapterOf,
  formatEmotionEntry,
  openDebtsOf,
  type BriefingSourceBundle,
} from "../digest-aggregator";
import {
  BRIEFING_RENDERER_VERSION,
  buildMemoryPatch,
  memoryPatchPath,
  renderBriefing,
  resolveAgainstCanon,
  sortDebtsForDisplay,
} from "../briefing-renderer";

function bundle(overrides: Partial<BriefingSourceBundle> = {}): BriefingSourceBundle {
  return {
    status: { currentChapter: 12, title: "卷二" },
    emotionLedger: {
      entries: [
        { chapter: 10, emotion: "焦虑", intensity: 0.6 },
        { chapter: 11, emotion: "平静", intensity: 0.2 },
      ],
      lastUpdated: "2026-09-12T00:00:00.000Z",
    },
    foreshadowing: {
      items: [
        {
          id: "f-2",
          name: "断剑",
          description: "断剑来历",
          status: "planted",
          plantedChapter: 4,
          advancedChapters: [],
          relatedCharacters: ["甲"],
          relatedEvents: [],
          notes: "",
        },
        {
          id: "f-1",
          name: "旧信",
          description: "旧信内容",
          status: "advanced",
          plantedChapter: 2,
          advancedChapters: [5],
          relatedCharacters: [],
          relatedEvents: [],
          notes: "",
        },
        {
          id: "f-9",
          name: "已回收",
          description: "x",
          status: "resolved",
          plantedChapter: 1,
          resolvedChapter: 6,
          advancedChapters: [],
          relatedCharacters: [],
          relatedEvents: [],
          notes: "",
        },
      ],
      lastUpdated: "2026-09-12T00:00:00.000Z",
    },
    factsRaw: JSON.stringify({
      schema_version: "facts/1.0",
      facts: [
        { id: "fact-a", subject: "甲", predicate: "持有", object: "断剑", valid_at: 4 },
        { id: "fact-b", subject: "乙", predicate: "位于", object: "凌霄殿", valid_at: 6 },
      ],
      episodes: [],
      next_id: 3,
    }),
    behavior: {
      profiles: {},
      anomalies: [
        {
          character: "甲",
          severity: "warning",
          type: "overuse",
          message: "拔剑动作重复",
          suggestion: "换写法",
        },
      ],
      consistencyScores: { 甲: 0.8 },
    },
    behaviorSourcePath: "chapters/ch-0012.md",
    ...overrides,
  };
}

describe("digest-aggregator / 五类确定性来源", () => {
  it("五类来源全部产出断言，且 kind 集合闭合", () => {
    const digest = buildBriefingDigest(bundle());
    const kinds = new Set(digest.assertions.map((a) => a.source.kind));
    expect([...kinds].sort()).toEqual(
      ["behavior-state-machine", "emotion-ledger", "fact-store", "foreshadowing", "status-projection"].sort(),
    );
    expect(BRIEFING_SOURCE_KINDS).toHaveLength(5);
    expect(digest.blocks).toEqual(["emotion", "debts", "behavior", "facts", "progress"]);
  });

  it("每条断言都带 source，且 jsonPointer 指向来源内部位置", () => {
    const digest = buildBriefingDigest(bundle());
    for (const a of digest.assertions) {
      expect(a.source.path.length).toBeGreaterThan(0);
      expect(a.source.jsonPointer.startsWith("/")).toBe(true);
    }
    const emotion = digest.assertions.find((a) => a.id === "emotion:0");
    expect(emotion?.source).toEqual({
      kind: "emotion-ledger",
      path: ".novel/emotion-ledger.json",
      jsonPointer: "/entries/0",
    });
    const fact = digest.assertions.find((a) => a.id === "fact:fact-b");
    expect(fact?.source).toEqual({
      kind: "fact-store",
      path: ".novel/facts.json",
      jsonPointer: "/facts/1",
    });
  });

  it("无 source 的断言不渲染（assertSourced 兜底）", () => {
    const good = { kind: "fact-store" as const, path: ".novel/facts.json", jsonPointer: "/facts/0" };
    const kept = assertSourced([
      { id: "a", block: "facts", text: "t", source: good, claimKey: null },
      { id: "b", block: "facts", text: "t", source: { ...good, jsonPointer: "" }, claimKey: null },
      { id: "c", block: "facts", text: "t", source: { ...good, path: "" }, claimKey: null },
    ]);
    expect(kept.map((k) => k.id)).toEqual(["a"]);
  });

  it("未回收债务按播种章升序，且 dueChapter 恒为 null（真实 store 无该字段）", () => {
    const debts = openDebtsOf(bundle());
    expect(debts.map((d) => d.id)).toEqual(["f-1", "f-2"]);
    expect(debts.every((d) => d.dueChapter === null)).toBe(true);
    expect(debts[0].chaptersSincePlanted).toBe(10); // 12 - 2
    expect(debts[1].chaptersSincePlanted).toBe(8); // 12 - 4
  });

  it("facts.json schema 不匹配时降级为 warning，不猜测事实", () => {
    const digest = buildBriefingDigest(
      bundle({ factsRaw: JSON.stringify({ schema_version: "facts/9.9", facts: [] }) }),
    );
    expect(digest.warnings.some((w) => w.includes("fact-store unavailable"))).toBe(true);
    expect(digest.assertions.some((a) => a.source.kind === "fact-store")).toBe(false);
    expect(digest.blocks).not.toContain("facts");
  });

  it("缺失来源不产生断言（不臆造）", () => {
    const digest = buildBriefingDigest(
      bundle({ emotionLedger: null, foreshadowing: null, behavior: null, factsRaw: null }),
    );
    expect(digest.assertions.map((a) => a.id)).toEqual(["progress:current-chapter"]);
    expect(digest.openDebts).toEqual([]);
  });

  it("情绪条目字段未命中时标 UNMAPPED 原样回显", () => {
    expect(formatEmotionEntry({ chapter: 3, emotion: "喜", intensity: 0.5 })).toBe(
      "第3章 情绪=喜 强度=0.5",
    );
    expect(formatEmotionEntry({ unknown: true })).toContain("UNMAPPED");
    expect(formatEmotionEntry({ emotionTag: "怒" })).toBe("情绪=怒");
  });

  it("当前章号只认确定性字段", () => {
    expect(currentChapterOf({ currentChapter: 7 })).toBe(7);
    expect(currentChapterOf({ current_chapter: 8 })).toBe(8);
    expect(currentChapterOf({})).toBeNull();
    expect(currentChapterOf(null)).toBeNull();
  });
});

describe("briefing-renderer / canon 优先与 divergence", () => {
  it("默认无 canon 冲突时全部保留", () => {
    const digest = buildBriefingDigest(bundle());
    const out = renderBriefing(digest);
    expect(out.version).toBe(BRIEFING_RENDERER_VERSION);
    expect(out.divergence).toEqual([]);
    expect(out.blocks.map((b) => b.kind)).toEqual(digest.blocks);
  });

  it("canon 取值不同 → 该断言被 canon 取代并进入 divergence 块", () => {
    const digest = buildBriefingDigest(bundle());
    const out = renderBriefing(digest, [
      { claimKey: "foreshadowing/f-1", value: "旧信已于第7章回收", source: "QMAI/canon#f-1" },
    ]);
    expect(out.divergence).toHaveLength(1);
    expect(out.divergence[0].claimKey).toBe("foreshadowing/f-1");
    expect(out.divergence[0].canonSide).toBe("旧信已于第7章回收");
    expect(out.divergence[0].canonSource).toBe("QMAI/canon#f-1");
    const debts = out.blocks.find((b) => b.kind === "debts");
    expect(debts?.lines.map((l) => l.id)).toEqual(["debt:f-2"]);
  });

  it("canon 取值相同 → 不算冲突", () => {
    const digest = buildBriefingDigest(bundle());
    const same = digest.assertions.find((a) => a.id === "debt:f-1");
    const out = renderBriefing(digest, [
      { claimKey: "foreshadowing/f-1", value: same!.text },
    ]);
    expect(out.divergence).toEqual([]);
  });

  it("resolveAgainstCanon 不动没有对应 claim 的断言", () => {
    const digest = buildBriefingDigest(bundle());
    const { kept, divergence } = resolveAgainstCanon(digest.assertions, [
      { claimKey: "unrelated/key", value: "x" },
    ]);
    expect(divergence).toEqual([]);
    expect(kept).toHaveLength(digest.assertions.length);
  });

  it("债务展示排序：播种章升序，同章按 id", () => {
    const debts = sortDebtsForDisplay([
      { id: "b", name: "b", plantedChapter: 5, chaptersSincePlanted: 1, dueChapter: null, source: { kind: "foreshadowing", path: "p", jsonPointer: "/items/0" } },
      { id: "a", name: "a", plantedChapter: 5, chaptersSincePlanted: 1, dueChapter: null, source: { kind: "foreshadowing", path: "p", jsonPointer: "/items/1" } },
      { id: "c", name: "c", plantedChapter: 1, chaptersSincePlanted: 5, dueChapter: null, source: { kind: "foreshadowing", path: "p", jsonPointer: "/items/2" } },
    ]);
    expect(debts.map((d) => d.id)).toEqual(["c", "a", "b"]);
  });
});

describe("briefing-renderer / 记忆补丁为纯构造", () => {
  it("补丁路径落在 QM/memory/<ns>/patches/", () => {
    expect(memoryPatchPath("demo", "20260912T101500")).toBe(
      "QM/memory/demo/patches/20260912T101500.json",
    );
  });

  it("补丁只承载带溯源的断言", () => {
    const digest = buildBriefingDigest(bundle());
    const patch = buildMemoryPatch(digest, "20260912T101500");
    expect(patch.schema).toBe("briefing-memory-patch/1");
    expect(patch.generatedAt).toBe("20260912T101500");
    expect(patch.assertions).toHaveLength(digest.assertions.length);
    for (const a of patch.assertions) {
      expect(a.source.jsonPointer.startsWith("/")).toBe(true);
    }
  });
});
