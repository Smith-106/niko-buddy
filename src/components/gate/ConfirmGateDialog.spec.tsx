// @vitest-environment jsdom
/** ConfirmGateDialog 行为测试（TASK-030：替代 C4 空壳）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import {
  act,
  fireEvent,
  render,
  screen,
  setupDomGlobals,
  waitFor,
} from "@/test-helpers/component-test-utils";
import { ConfirmGateDialog, GateHaltBanner } from "./ConfirmGateDialog";
import type { GateOutcome, PendingGate } from "@/lib/novel";

const mocks = vi.hoisted(() => ({
  confirmGate: vi.fn(),
  rejectGate: vi.fn(),
  t: vi.fn((key: string, opts?: Record<string, unknown>) => {
    const dict: Record<string, string> = {
      "gate.confirm.criterion.protected": "受保护区真源面",
      "gate.confirm.criterion.destructive": "破坏性操作",
      "gate.confirm.windowNotice": "剩余 {{seconds}} 秒后自动拒绝",
      "gate.confirm.timeout": "已超时，按拒绝处理",
      "gate.confirm.error": "裁决失败：{{message}}",
    };
    let s = dict[key] ?? key;
    if (opts) {
      for (const [k, v] of Object.entries(opts)) s = s.split(`{{${k}}}`).join(String(v));
    }
    return s;
  }),
}));

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: mocks.t }),
}));

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>();
  return {
    ...actual,
    confirmGate: mocks.confirmGate,
    rejectGate: mocks.rejectGate,
  };
});

const NOW = 1_700_000_000_000;
const nowMs = () => NOW;

function makePending(overrides: Partial<PendingGate> = {}): PendingGate {
  return {
    request_id: "req-1",
    op: "write_file",
    target: "wiki/chapters/c01.md",
    class: "irreversible",
    hit_criteria: ["external_side_effect", "protected_prefix"],
    actor: "agent",
    created_at_ms: NOW - 1000,
    deadline_ms: NOW + 60_000,
    diff_summary: "-old\n+new",
    ...overrides,
  };
}

const OUTCOME = {
  decision: "allowed",
  class: "irreversible",
  hit_criteria: [],
} as unknown as GateOutcome;

beforeEach(() => {
  setupDomGlobals();
  mocks.confirmGate.mockReset();
  mocks.rejectGate.mockReset();
  mocks.confirmGate.mockResolvedValue(OUTCOME);
  mocks.rejectGate.mockResolvedValue(OUTCOME);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ConfirmGateDialog — 渲染", () => {
  it("pending 为空不渲染", () => {
    const { container } = render(<ConfirmGateDialog pending={null} nowMs={nowMs} />);
    expect(container.querySelector('[data-testid="confirm-gate-dialog"]')).toBeNull();
  });

  it("渲染 op/target/分类/diff/剩余窗口", () => {
    render(<ConfirmGateDialog pending={makePending()} nowMs={nowMs} />);
    expect(screen.getByTestId("confirm-gate-dialog")).toBeTruthy();
    expect(screen.getByTestId("confirm-gate-target").textContent).toBe("wiki/chapters/c01.md");
    expect(screen.getByTestId("confirm-gate-class")).toBeTruthy();
    expect(screen.getByTestId("confirm-gate-diff").textContent).toBe("-old\n+new");
    // 剩余 60s → windowNotice 分支
    expect(screen.getByTestId("confirm-gate-timeout").textContent).toContain("60");
  });

  it("命中判据按固定顺序渲染，未知判据显示原文", () => {
    render(
      <ConfirmGateDialog
        pending={makePending({ hit_criteria: ["zzz_custom", "destructive_op", "protected_prefix"] })}
        nowMs={nowMs}
      />,
    );
    const chips = screen
      .getByTestId("confirm-gate-criteria")
      .querySelectorAll("div.flex.flex-wrap > span");
    const texts = [...chips].map((c) => c.textContent ?? "");
    // protected(受保护区真源面) < destructive(破坏性操作) < 未知原文(末尾)
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain("受保护区真源面");
    expect(texts[1]).toContain("破坏性操作");
    expect(texts[2]).toBe("zzz_custom");
  });

  it("并列未知判据按字典序兜底（localeCompare 分支）", () => {
    render(
      <ConfirmGateDialog
        pending={makePending({ hit_criteria: ["zzz_b", "zzz_a"] })}
        nowMs={nowMs}
      />,
    );
    const chips = screen
      .getByTestId("confirm-gate-criteria")
      .querySelectorAll("div.flex.flex-wrap > span");
    const texts = [...chips].map((c) => c.textContent ?? "");
    expect(texts).toEqual(["zzz_a", "zzz_b"]);
  });

  it("未注入时钟时用默认时钟（defaultClock 分支）", async () => {
    // 真实时间下已过期（NOW 为过去固定值）→ 超时自动拒绝仍走通
    render(<ConfirmGateDialog pending={makePending()} />);
    expect(screen.getByTestId("confirm-gate-dialog")).toBeTruthy();
    await waitFor(() => expect(mocks.rejectGate).toHaveBeenCalledTimes(1));
  });

  it("打开时聚焦确认按钮", () => {
    render(<ConfirmGateDialog pending={makePending()} nowMs={nowMs} />);
    expect(document.activeElement).toBe(screen.getByTestId("confirm-gate-accept"));
  });
});

describe("ConfirmGateDialog — 裁决", () => {
  it("确认 → confirmGate + onResolved", async () => {
    const onResolved = vi.fn();
    render(<ConfirmGateDialog pending={makePending()} onResolved={onResolved} nowMs={nowMs} />);
    fireEvent.click(screen.getByTestId("confirm-gate-accept"));
    await waitFor(() => expect(mocks.confirmGate).toHaveBeenCalledWith("req-1"));
    expect(onResolved).toHaveBeenCalledWith(OUTCOME);
  });

  it("拒绝 → rejectGate（带固定备注）+ onResolved", async () => {
    const onResolved = vi.fn();
    render(<ConfirmGateDialog pending={makePending()} onResolved={onResolved} nowMs={nowMs} />);
    fireEvent.click(screen.getByTestId("confirm-gate-reject"));
    await waitFor(() =>
      expect(mocks.rejectGate).toHaveBeenCalledWith("req-1", "rejected in dialog"),
    );
    expect(onResolved).toHaveBeenCalledWith(OUTCOME);
  });

  it("忙碌时重复点击被忽略", async () => {
    let resolveConfirm!: (v: GateOutcome) => void;
    mocks.confirmGate.mockReturnValue(
      new Promise<GateOutcome>((r) => {
        resolveConfirm = r;
      }),
    );
    render(<ConfirmGateDialog pending={makePending()} nowMs={nowMs} />);
    const accept = screen.getByTestId("confirm-gate-accept") as HTMLButtonElement;
    fireEvent.click(accept);
    await waitFor(() => expect(mocks.confirmGate).toHaveBeenCalledTimes(1));
    expect((screen.getByTestId("confirm-gate-accept") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("confirm-gate-reject") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("confirm-gate-reject"));
    expect(mocks.rejectGate).not.toHaveBeenCalled();
    resolveConfirm(OUTCOME);
  });

  it("确认失败 → 错误态 + 重试重发 confirm", async () => {
    mocks.confirmGate.mockRejectedValueOnce(new Error("ipc-down"));
    render(<ConfirmGateDialog pending={makePending()} nowMs={nowMs} />);
    fireEvent.click(screen.getByTestId("confirm-gate-accept"));
    expect(await screen.findByTestId("confirm-gate-error")).toBeTruthy();
    expect(screen.getByTestId("confirm-gate-error").textContent).toContain("ipc-down");
    // 重试重发最后一次尝试（accept → confirmGate）
    fireEvent.click(screen.getByTestId("confirm-gate-retry"));
    await waitFor(() => expect(mocks.confirmGate).toHaveBeenCalledTimes(2));
  });

  it("拒绝失败 → 重试重发 reject", async () => {
    mocks.rejectGate.mockRejectedValueOnce(new Error("net-down"));
    render(<ConfirmGateDialog pending={makePending()} nowMs={nowMs} />);
    fireEvent.click(screen.getByTestId("confirm-gate-reject"));
    expect(await screen.findByTestId("confirm-gate-error")).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-gate-retry"));
    await waitFor(() => expect(mocks.rejectGate).toHaveBeenCalledTimes(2));
  });

  it("新请求重置错误态与自动裁决标记", async () => {
    mocks.rejectGate.mockRejectedValueOnce(new Error("net-down"));
    const { rerender } = render(<ConfirmGateDialog pending={makePending()} nowMs={nowMs} />);
    fireEvent.click(screen.getByTestId("confirm-gate-reject"));
    expect(await screen.findByTestId("confirm-gate-error")).toBeTruthy();
    // 新 request_id → 错误清除
    rerender(<ConfirmGateDialog pending={makePending({ request_id: "req-2" })} nowMs={nowMs} />);
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-gate-error")).toBeNull();
    });
  });
});

describe("ConfirmGateDialog — 超时自动拒绝", () => {
  it("过期 → 超时文案 + 确认禁用 + 自动 reject 一次", async () => {
    render(
      <ConfirmGateDialog
        pending={makePending({ deadline_ms: NOW - 1000 })}
        nowMs={nowMs}
      />,
    );
    expect(screen.getByTestId("confirm-gate-timeout").textContent).toBeTruthy();
    expect((screen.getByTestId("confirm-gate-accept") as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() =>
      expect(mocks.rejectGate).toHaveBeenCalledWith("req-1", "rejected in dialog"),
    );
    expect(mocks.rejectGate).toHaveBeenCalledTimes(1);
  });

  it("同一请求不重复自动裁决（轮询身份变化不重发）", async () => {
    const expired = makePending({ deadline_ms: NOW - 1000 });
    const { rerender } = render(<ConfirmGateDialog pending={expired} nowMs={nowMs} />);
    await waitFor(() => expect(mocks.rejectGate).toHaveBeenCalledTimes(1));
    // 宿主轮询传入新对象（同 id）→ 不重发
    rerender(
      <ConfirmGateDialog pending={{ ...expired }} nowMs={nowMs} />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(mocks.rejectGate).toHaveBeenCalledTimes(1);
  });

  it("自动裁决失败 → 错误态可手动重试", async () => {
    mocks.rejectGate.mockRejectedValueOnce(new Error("auto-down"));
    render(<ConfirmGateDialog pending={makePending({ deadline_ms: NOW - 500 })} nowMs={nowMs} />);
    expect(await screen.findByTestId("confirm-gate-error")).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-gate-retry"));
    await waitFor(() => expect(mocks.rejectGate).toHaveBeenCalledTimes(2));
  });
});

describe("ConfirmGateDialog — 键盘", () => {
  it("Escape 触发拒绝", async () => {
    render(<ConfirmGateDialog pending={makePending()} nowMs={nowMs} />);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(mocks.rejectGate).toHaveBeenCalledTimes(1));
  });

  it("Tab 在容器首尾循环（焦点陷阱）", () => {
    render(<ConfirmGateDialog pending={makePending()} nowMs={nowMs} />);
    const dialog = screen.getByTestId("confirm-gate-dialog");
    // focusable 顺序：summary(diff) → reject → accept
    const summary = dialog.querySelector("summary") as HTMLElement;
    const accept = screen.getByTestId("confirm-gate-accept");
    summary.focus();
    expect(document.activeElement).toBe(summary);
    // 在首个按 shift+Tab → 跳到末尾 accept
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(accept);
    // 在末尾按 Tab → 回绕到首个 summary
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(summary);
    // 中间元素 Tab/shift+Tab 不回绕（else 分支）
    (screen.getByTestId("confirm-gate-reject") as HTMLButtonElement).focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByTestId("confirm-gate-reject"));
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId("confirm-gate-reject"));
  });
});

describe("ConfirmGateDialog — 倒计时 tick", () => {
  it("每秒刷新剩余窗口（interval 分支）", async () => {
    vi.useFakeTimers();
    try {
      let now = NOW;
      render(<ConfirmGateDialog pending={makePending()} nowMs={() => now} />);
      expect(screen.getByTestId("confirm-gate-timeout").textContent).toContain("60");
      now += 1000;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByTestId("confirm-gate-timeout").textContent).toContain("59");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GateHaltBanner — 熔断横幅", () => {
  it("未熔断不渲染", () => {
    const { container } = render(<GateHaltBanner halted={false} />);
    expect(container.querySelector('[data-testid="gate-halt-banner"]')).toBeNull();
  });

  it("熔断渲染横幅；无 onResume 时无按钮", () => {
    render(<GateHaltBanner halted={true} />);
    expect(screen.getByTestId("gate-halt-banner")).toBeTruthy();
    expect(screen.queryByTestId("gate-halt-resume")).toBeNull();
  });

  it("恢复按钮回调 onResume", () => {
    const onResume = vi.fn();
    render(<GateHaltBanner halted={true} onResume={onResume} />);
    fireEvent.click(screen.getByTestId("gate-halt-resume"));
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
