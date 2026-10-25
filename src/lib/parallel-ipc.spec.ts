/**
 * PAT-IM1 / PAT-IM 并行化核心路径回归：
 * 验证本轮 sweep 统一采用的 `Promise.all(map+索引回填保序)` 模式：
 * - 顺序保持（延迟乱序仍按输入序回填）
 * - 结果完整（无丢失/重复）
 * - 单项失败隔离（ok:false 哨兵，不抛、后续按原序处理）
 * - 批量写/删全量执行（不同 path 并发）
 */
import { describe, expect, it, vi } from "vitest";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("parallel IPC pattern (PAT-IM1/PAT-IM)", () => {
  it("保序：延迟乱序仍按输入序回填", async () => {
    const files = ["a.md", "b.md", "c.md", "d.md", "e.md"];
    const readFile = async (p: string) => {
      // 故意倒序延迟：越靠前越慢，串行时序与并行完成序相反
      const idx = files.indexOf(p);
      await delay((files.length - idx) * 5);
      return `content:${p}`;
    };
    const contents = await Promise.all(
      files.map((f) =>
        readFile(f).then(
          (content) => ({ ok: true as const, content }),
          () => ({ ok: false as const, content: "" }),
        ),
      ),
    );
    const out: string[] = [];
    for (let i = 0; i < files.length; i += 1) {
      expect(contents[i].ok).toBe(true);
      out.push(`${files[i]}=${contents[i].content}`);
    }
    expect(out).toEqual([
      "a.md=content:a.md",
      "b.md=content:b.md",
      "c.md=content:c.md",
      "d.md=content:d.md",
      "e.md=content:e.md",
    ]);
  });

  it("完整：全部成功无丢失", async () => {
    const files = Array.from({ length: 10 }, (_, i) => `f${i}.md`);
    const contents = await Promise.all(
      files.map((f) =>
        Promise.resolve(`c:${f}`).then(
          (content) => ({ ok: true as const, content }),
          () => ({ ok: false as const, content: "" }),
        ),
      ),
    );
    expect(contents).toHaveLength(files.length);
    expect(contents.every((c) => c.ok)).toBe(true);
    expect(new Set(contents.map((c) => c.content)).size).toBe(files.length);
  });

  it("隔离：单项失败不中断整体且位置可回填", async () => {
    const files = ["ok1.md", "bad.md", "ok2.md"];
    const readFile = async (p: string) => {
      if (p === "bad.md") throw new Error("missing");
      return `c:${p}`;
    };
    const contents = await Promise.all(
      files.map((f) =>
        readFile(f).then(
          (content) => ({ ok: true as const, content }),
          () => ({ ok: false as const, content: "" }),
        ),
      ),
    );
    expect(contents[0]).toMatchObject({ ok: true, content: "c:ok1.md" });
    expect(contents[1].ok).toBe(false);
    expect(contents[2]).toMatchObject({ ok: true, content: "c:ok2.md" });
    // 调用方按原序 fallback（如文件名派生标题），顺序不变
    const titles: string[] = [];
    for (let i = 0; i < files.length; i += 1) {
      const r = contents[i];
      titles.push(r.ok ? r.content : `fallback:${files[i]}`);
    }
    expect(titles).toEqual(["c:ok1.md", "fallback:bad.md", "c:ok2.md"]);
  });

  it("批量写：独立路径并发全量执行", async () => {
    const writes: string[] = [];
    const writeFileAtomic = async (path: string) => {
      await delay(Math.random() * 3);
      writes.push(path);
    };
    const entries: Array<[string, string]> = [
      ["a.md", "A"],
      ["b.md", "B"],
      ["c.md", "C"],
    ];
    await Promise.all(entries.map(([name]) => writeFileAtomic(`/mem/${name}`)));
    const writtenPaths = entries.map(([name]) => `/mem/${name}`);
    expect(writtenPaths).toEqual(["/mem/a.md", "/mem/b.md", "/mem/c.md"]);
    expect(new Set(writes).size).toBe(3);
  });

  it("批量删：Promise.allSettled 收集失败并继续", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deleteFile = async (p: string) => {
      if (p.endsWith("dead2")) throw new Error("gone");
    };
    const targets = ["dead1", "dead2", "dead3"];
    const results = await Promise.allSettled(targets.map((d) => deleteFile(`/pp/${d}`)));
    results.forEach((res, i) => {
      if (res.status === "rejected") console.warn(`[dedup] failed to delete ${targets[i]}: ${res.reason}`);
    });
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
