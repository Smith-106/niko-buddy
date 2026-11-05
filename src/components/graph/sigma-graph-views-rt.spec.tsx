// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import Graph from "graphology";
const fa2 = vi.hoisted(() => ({ inferSettings: vi.fn(() => ({})), assign: vi.fn() }));
vi.mock("graphology-layout-forceatlas2", () => ({ default: fa2 }));
const sm = vi.hoisted(() => ({ refresh: vi.fn(), loadGraph: vi.fn() }));
vi.mock("@react-sigma/core", () => ({
  useSigma: () => ({ getContainer: () => document.createElement("div"), refresh: sm.refresh, getGraph: () => new Graph(), getCamera: () => ({ animate: vi.fn() }) }),
  useLoadGraph: () => (g: unknown) => sm.loadGraph(g),
  useRegisterEvents: () => () => {},
}));
import { GraphLoader } from "./sigma-graph-views";
import { getGraphVisualSettings } from "@/lib/graph-layout";
describe("GraphLoader native rAF", () => {
  afterEach(() => {
    cleanup();
  });

  it("settles", async () => {
    const settled = vi.fn();
    let live: unknown = null;
    sm.loadGraph.mockImplementation((g: unknown) => { live = g; });
    render(<GraphLoader nodes={[{ id: "a", label: "A", type: "character", path: "/a.md", linkCount: 2, community: 0 },{ id: "b", label: "B", type: "character", path: "/b.md", linkCount: 1, community: 1 }]} edges={[{ source: "a", target: "b", weight: 1 }]} colorMode="type" novelMode={false} graphMode="overview" labelDisplayMode="all" edgeColorHex="#7f8ea3" edgeStrengthPercent={100} edgeLabelsAlwaysVisible={false} visualSettings={getGraphVisualSettings(2)} foreshadowingStatusMap={new Map()} layoutPreset="compact" onLayoutSettled={settled} />);
    expect(live).not.toBeNull();
    const g = live as Graph;
    // 真实引擎 + assign 空实现 → 输出恒等于初始坐标：断言落定后坐标与初始一致
    const ax0 = g.getNodeAttribute("a", "x");
    const by0 = g.getNodeAttribute("b", "y");
    const deadline = Date.now() + 12000;
    for (;;) {
      if (settled.mock.calls.length > 0) break;
      if (Date.now() > deadline) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(live).not.toBeNull();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(sm.refresh.mock.calls.length).toBeGreaterThan(5);
    expect((live as Graph).getNodeAttribute("a", "x")).toBe(ax0);
    expect((live as Graph).getNodeAttribute("b", "y")).toBe(by0);
  }, 15000);
});
