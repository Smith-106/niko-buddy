import { describe, expect, it } from "vitest";

import {
  MAX_FILES_PER_BATCH,
  assessSafety,
  changedFilesOnly,
  diffLines,
  formatSummary,
  summarize,
  type FileDiffModel,
} from "../diff-model";

function file(path: string, changes: Array<[number, string, string]>): FileDiffModel {
  return {
    path,
    replacements: changes.length,
    changes: changes.map(([line, before, after]) => ({ line, before, after })),
  };
}

describe("批量替换 diff 模型", () => {
  it("逐行对齐并只保留有差异的行", () => {
    const before = "第一行\n林舟走进屋\n第三行";
    const after = "第一行\n林舟舟走进屋\n第三行";
    expect(diffLines(before, after)).toEqual([
      { line: 2, before: "林舟走进屋", after: "林舟舟走进屋" },
    ]);
  });

  it("行数不同的输入也能给出对称 diff", () => {
    expect(diffLines("a", "a\nb")).toEqual([{ line: 2, before: "", after: "b" }]);
  });

  it("汇总口径：文件数、替换数、命中行、最长行变化", () => {
    const summary = summarize([
      file("book/c1.md", [
        [1, "林舟", "林舟舟"],
        [4, "a", "aaaa"],
      ]),
      file("book/c2.md", [[2, "x", "xy"]]),
      file("book/c3.md", []),
    ]);
    expect(summary.changedFiles).toBe(2);
    expect(summary.totalReplacements).toBe(3);
    expect(summary.touchedLines).toBe(3);
    expect(summary.maxLineDelta).toBe(3);
    expect(formatSummary(summary)).toContain("3 replacements");
  });

  it("安全判据给出原因", () => {
    expect(assessSafety([], "林舟").ok).toBe(false);
    expect(assessSafety([file("book/c1.md", [[1, "a", "b"]])], "").reasons).toContain(
      "empty find text",
    );
    expect(assessSafety([file("book/c1.md", [])], "林舟").reasons).toContain("nothing to replace");
  });

  it("越界路径与超出单批上限都被拦", () => {
    const escape = assessSafety([file("../outside.md", [[1, "a", "b"]])], "a");
    expect(escape.ok).toBe(false);
    expect(escape.reasons.some((r) => r.startsWith("unsafe path"))).toBe(true);

    const many = Array.from({ length: MAX_FILES_PER_BATCH + 1 }, (_, i) =>
      file(`book/c${i}.md`, [[1, "a", "b"]]),
    );
    expect(assessSafety(many, "a").reasons.some((r) => r.startsWith("too many files"))).toBe(true);
  });

  it("只返回有命中的文件", () => {
    const files = [file("a.md", [[1, "x", "y"]]), file("b.md", [])];
    expect(changedFilesOnly(files).map((f) => f.path)).toEqual(["a.md"]);
  });
});
