// @vitest-environment jsdom
/** BriefingPanel 行为测试（TASK-031：替代 C4 空壳）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import {
  fireEvent,
  render,
  screen,
  setupDomGlobals,
  waitFor,
} from "@/test-helpers/component-test-utils";
import { BriefingPanel } from "./BriefingPanel";
import type { BriefingDigest } from "@/lib/novel";

function makeDigest(): BriefingDigest {
  return {
    blocks: ["emotion", "facts"],
    assertions: [
      {
        id: "a1",
        block: "emotion",
        text: "林舟在第三章情绪低落",
        source: { kind: "chapter", path: "wiki/chapters/c03.md", jsonPointer: "/emotion/0" },
        claimKey: "k1",
      },
      {
        id: "a2",
        block: "facts",
        text: "城门钥匙在老周手里",
        source: { kind: "outline", path: "wiki/outlines/main.md", jsonPointer: "/facts/1" },
        claimKey: null,
      },
    ],
    openDebts: [],
    warnings: ["w1: 章节缺失", "w2: 断言无源"],
  } as unknown as BriefingDigest;
}

beforeEach(() => {
  setupDomGlobals();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BriefingPanel — 只读呈现", () => {
  it("渲染来源计数、警告与内容块", () => {
    render(<BriefingPanel digest={makeDigest()} />);
    expect(screen.getByTestId("briefing-panel")).toBeTruthy();
    expect(screen.getByTestId("briefing-source-count").textContent).toContain("2 sourced assertions");
    expect(screen.getByTestId("briefing-warnings").textContent).toContain("w1");
    expect(screen.getByTestId("briefing-block-emotion")).toBeTruthy();
    expect(screen.getByTestId("briefing-block-facts")).toBeTruthy();
    expect(screen.getByTestId("briefing-block-emotion").textContent).toContain("林舟在第三章情绪低落");
  });

  it("无警告时不渲染警告区", () => {
    const digest = makeDigest();
    render(<BriefingPanel digest={{ ...digest, warnings: [] }} />);
    expect(screen.queryByTestId("briefing-warnings")).toBeNull();
  });

  it("溯源徽章切换来源明细（开/关）", () => {
    render(<BriefingPanel digest={makeDigest()} />);
    expect(screen.queryByTestId("briefing-source-detail")).toBeNull();
    fireEvent.click(screen.getByTestId("briefing-source-a1"));
    const detail = screen.getByTestId("briefing-source-detail");
    expect(detail.textContent).toContain("wiki/chapters/c03.md");
    // 再点关闭
    fireEvent.click(screen.getByTestId("briefing-source-a1"));
    expect(screen.queryByTestId("briefing-source-detail")).toBeNull();
  });

  it("canon 分歧块渲染（含/不含来源后缀）", () => {
    render(
      <BriefingPanel
        digest={makeDigest()}
        canonClaims={[
          { claimKey: "k1", value: "林舟在第三章情绪高涨", source: "canon:ch3" },
        ]}
      />,
    );
    const div = screen.getByTestId("briefing-divergence");
    expect(div.textContent).toContain("canon:ch3");
    expect(screen.getByTestId("briefing-divergence-k1")).toBeTruthy();
  });

  it("无分歧时不渲染分歧区", () => {
    render(<BriefingPanel digest={makeDigest()} canonClaims={[]} />);
    expect(screen.queryByTestId("briefing-divergence")).toBeNull();
  });
});

describe("BriefingPanel — opt-in 写回", () => {
  it("未勾选时写入禁用；勾选后启用", () => {
    render(<BriefingPanel digest={makeDigest()} onWritePatch={vi.fn()} />);
    expect((screen.getByTestId("briefing-patch-write") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("briefing-patch-optin"));
    expect((screen.getByTestId("briefing-patch-write") as HTMLButtonElement).disabled).toBe(false);
    // 取消勾选再次禁用
    fireEvent.click(screen.getByTestId("briefing-patch-optin"));
    expect((screen.getByTestId("briefing-patch-write") as HTMLButtonElement).disabled).toBe(true);
  });

  it("没有 onWritePatch 时即使勾选也禁用", () => {
    render(<BriefingPanel digest={makeDigest()} />);
    fireEvent.click(screen.getByTestId("briefing-patch-optin"));
    expect((screen.getByTestId("briefing-patch-write") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("briefing-patch-state")).toBeNull();
  });

  it("写入成功 → done；回调收到记忆补丁", async () => {
    const onWritePatch = vi.fn().mockResolvedValue(undefined);
    render(<BriefingPanel digest={makeDigest()} onWritePatch={onWritePatch} />);
    fireEvent.click(screen.getByTestId("briefing-patch-optin"));
    fireEvent.click(screen.getByTestId("briefing-patch-write"));
    await waitFor(() => expect(onWritePatch).toHaveBeenCalledTimes(1));
    const patch = onWritePatch.mock.calls[0][0] as { schema: string; assertions: unknown[] };
    expect(patch.schema).toBe("briefing-memory-patch/1");
    expect(patch.assertions).toHaveLength(2);
    await waitFor(() => {
      expect(screen.getByTestId("briefing-patch-state").textContent).toBe("done");
    });
  });

  it("写入失败 → failed", async () => {
    const onWritePatch = vi.fn().mockRejectedValue(new Error("disk-full"));
    render(<BriefingPanel digest={makeDigest()} onWritePatch={onWritePatch} />);
    fireEvent.click(screen.getByTestId("briefing-patch-optin"));
    fireEvent.click(screen.getByTestId("briefing-patch-write"));
    await waitFor(() => {
      expect(screen.getByTestId("briefing-patch-state").textContent).toBe("failed");
    });
  });

  it("写入中按钮禁用（busy 分支）", async () => {
    let resolveWrite!: () => void;
    const onWritePatch = vi.fn(
      () => new Promise<void>((r) => { resolveWrite = r; }),
    );
    render(<BriefingPanel digest={makeDigest()} onWritePatch={onWritePatch} />);
    fireEvent.click(screen.getByTestId("briefing-patch-optin"));
    fireEvent.click(screen.getByTestId("briefing-patch-write"));
    await waitFor(() => expect(onWritePatch).toHaveBeenCalled());
    expect((screen.getByTestId("briefing-patch-write") as HTMLButtonElement).disabled).toBe(true);
    resolveWrite();
    await waitFor(() => {
      expect(screen.getByTestId("briefing-patch-state").textContent).toBe("done");
    });
  });
});
