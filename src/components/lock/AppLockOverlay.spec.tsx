// @vitest-environment jsdom
/** AppLockOverlay 行为测试（TASK-028：替代 C4 空壳）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import {
  fireEvent,
  render,
  screen,
  setupDomGlobals,
  waitFor,
} from "@/test-helpers/component-test-utils";
import { AppLockOverlay } from "./AppLockOverlay";

const mocks = vi.hoisted(() => ({
  lockState: vi.fn<() => Promise<string>>(),
  verifyPassphrase: vi.fn<(p: string) => Promise<boolean>>(),
  isTauri: vi.fn<() => boolean>(() => false),
}));

vi.mock("@/lib/app-lock/lock-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/app-lock/lock-client")>();
  return {
    ...actual,
    lockState: mocks.lockState,
    verifyPassphrase: mocks.verifyPassphrase,
  };
});

vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>();
  return { ...actual, isTauri: mocks.isTauri };
});

beforeEach(() => {
  setupDomGlobals();
  mocks.isTauri.mockReturnValue(false);
  mocks.lockState.mockReset();
  mocks.verifyPassphrase.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AppLockOverlay — 受控 initialState", () => {
  it("initialState=locked 时渲染遮挡层（无关闭出口）", () => {
    render(<AppLockOverlay initialState="locked" />);
    expect(screen.getByTestId("app-lock-overlay")).toBeTruthy();
    expect(screen.getByTestId("app-lock-input")).toBeTruthy();
    expect(screen.getByTestId("app-lock-unlock")).toBeTruthy();
    // 无关闭按钮：dialog 内只有解锁按钮
    expect(screen.queryByRole("button", { name: /关闭/ })).toBeNull();
  });

  it("initialState=not_configured 时不遮挡", () => {
    const { container } = render(<AppLockOverlay initialState="not_configured" />);
    expect(container.querySelector('[data-testid="app-lock-overlay"]')).toBeNull();
  });

  it("initialState=unlocked 时不遮挡", () => {
    const { container } = render(<AppLockOverlay initialState="unlocked" />);
    expect(container.querySelector('[data-testid="app-lock-overlay"]')).toBeNull();
  });

  it("解锁按钮在口令过短时禁用，达标后启用", () => {
    render(<AppLockOverlay initialState="locked" />);
    const btn = screen.getByTestId("app-lock-unlock") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("app-lock-input"), {
      target: { value: "123456" },
    });
    expect(btn.disabled).toBe(false);
  });
});

describe("AppLockOverlay — 自查询分支", () => {
  it("非 Tauri 环境直接放行（不调用 lockState）", async () => {
    mocks.isTauri.mockReturnValue(false);
    const { container } = render(<AppLockOverlay />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="app-lock-overlay"]')).toBeNull();
    });
    expect(mocks.lockState).not.toHaveBeenCalled();
  });

  it("Tauri 环境查询 locked → 显示遮挡层", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.lockState.mockResolvedValue("locked");
    render(<AppLockOverlay />);
    await waitFor(() => {
      expect(screen.getByTestId("app-lock-overlay")).toBeTruthy();
    });
  });

  it("Tauri 环境查询 not_configured → 不遮挡", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.lockState.mockResolvedValue("not_configured");
    const { container } = render(<AppLockOverlay />);
    await waitFor(() => {
      expect(mocks.lockState).toHaveBeenCalled();
    });
    expect(container.querySelector('[data-testid="app-lock-overlay"]')).toBeNull();
  });

  it("Tauri 环境 invoke 抛错 → 放行 not_configured 并 warn", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.lockState.mockRejectedValue(new Error("no ipc"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(<AppLockOverlay />);
    await waitFor(() => {
      expect(mocks.lockState).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="app-lock-overlay"]')).toBeNull();
    });
    expect(warn).toHaveBeenCalled();
  });
});

describe("AppLockOverlay — 提交流程", () => {
  it("口令正确 → 清空输入、回到 unlocked、回调 onUnlocked", async () => {
    mocks.verifyPassphrase.mockResolvedValue(true);
    const onUnlocked = vi.fn();
    render(<AppLockOverlay initialState="locked" onUnlocked={onUnlocked} />);
    fireEvent.change(screen.getByTestId("app-lock-input"), {
      target: { value: "correct1" },
    });
    fireEvent.click(screen.getByTestId("app-lock-unlock"));
    await waitFor(() => {
      expect(mocks.verifyPassphrase).toHaveBeenCalledWith("correct1");
    });
    await waitFor(() => {
      expect(onUnlocked).toHaveBeenCalledTimes(1);
    });
    // 解锁后遮挡层消失
    await waitFor(() => {
      expect(screen.queryByTestId("app-lock-overlay")).toBeNull();
    });
  });

  it("口令错误 → 显示 invalid 提示且不回调", async () => {
    mocks.verifyPassphrase.mockResolvedValue(false);
    const onUnlocked = vi.fn();
    render(<AppLockOverlay initialState="locked" onUnlocked={onUnlocked} />);
    fireEvent.change(screen.getByTestId("app-lock-input"), {
      target: { value: "wrongpw1" },
    });
    fireEvent.click(screen.getByTestId("app-lock-unlock"));
    await waitFor(() => {
      expect(screen.getByTestId("app-lock-error")).toBeTruthy();
    });
    expect(onUnlocked).not.toHaveBeenCalled();
    // 仍在锁定态
    expect(screen.getByTestId("app-lock-overlay")).toBeTruthy();
  });

  it("verify 抛错 → 显示操作失败文案", async () => {
    mocks.verifyPassphrase.mockRejectedValue(new Error("ipc-down"));
    render(<AppLockOverlay initialState="locked" />);
    fireEvent.change(screen.getByTestId("app-lock-input"), {
      target: { value: "whatever1" },
    });
    fireEvent.click(screen.getByTestId("app-lock-unlock"));
    await waitFor(() => {
      expect(screen.getByTestId("app-lock-error").textContent).toContain("ipc-down");
    });
  });

  it("Enter 键可提交（口令达标且非忙）", async () => {
    mocks.verifyPassphrase.mockResolvedValue(true);
    render(<AppLockOverlay initialState="locked" />);
    fireEvent.change(screen.getByTestId("app-lock-input"), {
      target: { value: "enterok1" },
    });
    fireEvent.keyDown(screen.getByTestId("app-lock-input"), { key: "Enter" });
    await waitFor(() => {
      expect(mocks.verifyPassphrase).toHaveBeenCalledWith("enterok1");
    });
  });

  it("Enter 口令过短时不提交", () => {
    mocks.verifyPassphrase.mockResolvedValue(true);
    render(<AppLockOverlay initialState="locked" />);
    fireEvent.change(screen.getByTestId("app-lock-input"), {
      target: { value: "abc" },
    });
    fireEvent.keyDown(screen.getByTestId("app-lock-input"), { key: "Enter" });
    expect(mocks.verifyPassphrase).not.toHaveBeenCalled();
  });

  it("忙碌时 Enter 不重复提交", async () => {
    let resolveVerify!: (v: boolean) => void;
    mocks.verifyPassphrase.mockReturnValue(
      new Promise<boolean>((r) => {
        resolveVerify = r;
      }),
    );
    render(<AppLockOverlay initialState="locked" />);
    fireEvent.change(screen.getByTestId("app-lock-input"), {
      target: { value: "busytest1" },
    });
    fireEvent.click(screen.getByTestId("app-lock-unlock"));
    await waitFor(() => {
      expect(mocks.verifyPassphrase).toHaveBeenCalledTimes(1);
    });
    // busy=true 期间按 Enter 不应再调用
    fireEvent.keyDown(screen.getByTestId("app-lock-input"), { key: "Enter" });
    expect(mocks.verifyPassphrase).toHaveBeenCalledTimes(1);
    resolveVerify(true);
  });

  it("卸载后 resolve 不再 setState（alive 守卫）", async () => {
    mocks.isTauri.mockReturnValue(true);
    let resolveState!: (v: string) => void;
    mocks.lockState.mockReturnValue(
      new Promise<string>((r) => {
        resolveState = r;
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { unmount } = render(<AppLockOverlay />);
    unmount();
    resolveState("locked");
    await new Promise((r) => setTimeout(r, 20));
    expect(warn).not.toHaveBeenCalled();
  });

  it("卸载后 reject 不再 setState（catch 内 alive 守卫）", async () => {
    mocks.isTauri.mockReturnValue(true);
    let rejectState!: (e: unknown) => void;
    mocks.lockState.mockReturnValue(
      new Promise<string>((_, rej) => {
        rejectState = rej;
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { unmount } = render(<AppLockOverlay />);
    unmount();
    rejectState(new Error("late-ipc-down"));
    await waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
  });

  it("Escape 在遮罩层被 preventDefault（无关闭语义）", () => {
    render(<AppLockOverlay initialState="locked" />);
    const overlay = screen.getByTestId("app-lock-overlay");
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const prevented = !overlay.dispatchEvent(ev);
    expect(prevented).toBe(true);
  });
});
