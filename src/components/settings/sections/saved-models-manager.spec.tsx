// @vitest-environment jsdom
/**
 * W4 coverage campaign — SavedModelsManager 全口径 100%。
 * 依赖 mock 策略与 llm-provider-section.spec 一致：vi.hoisted 提供可写 mock；
 * 所有 UI 基元 / toast / i18n 均 vi.mock；fetch 用 vi.stubGlobal。
 * 断言对照 src/components/settings/sections/saved-models-manager.tsx 的实现分支。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  fireEvent,
  render,
  screen,
  setupDomGlobals,
  waitFor,
} from "@/test-helpers/component-test-utils"
import type { ReactNode } from "react"
import type { SavedModel } from "@/stores/wiki-store"
import { SavedModelsManager } from "./saved-models-manager"

/* eslint-disable @typescript-eslint/no-explicit-any */

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string) => key),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  confirm: vi.fn(() => true),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/lib/toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    info: mocks.toastInfo,
  },
}))

vi.mock("@/components/ui/button", () => ({
  Button: (props: Record<string, unknown>) => <button type="button" data-slot="button" {...props} />,
}))

vi.mock("@/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input data-slot="input" {...props} />,
}))

vi.mock("@/components/ui/label", () => ({
  Label: (props: Record<string, unknown>) => <label data-slot="label" {...props} />,
}))

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, onOpenChange, children }: { open: boolean; onOpenChange?: (v: boolean) => void; children: ReactNode }) =>
    open ? (
      <div data-testid="dialog">
        {children}
        <button type="button" data-testid="dialog-dismiss-trigger" onClick={() => onOpenChange?.(false)}>
          close-dialog
        </button>
      </div>
    ) : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div data-testid="dialog-content">{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div data-testid="dialog-description">{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div data-testid="dialog-footer">{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div data-testid="dialog-header">{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div data-testid="dialog-title">{children}</div>,
}))

function makeModel(over: Partial<SavedModel> = {}): SavedModel {
  return {
    id: "m1",
    name: "默认模型",
    model: "gpt-4o",
    apiKey: "sk-123",
    customEndpoint: "https://api.example.com/v1",
    description: "主模型描述",
    createdAt: 1000,
    ...over,
  }
}

function renderManager(savedModels: SavedModel[] = [], onChange = vi.fn()) {
  return render(<SavedModelsManager savedModels={savedModels} onChange={onChange} />)
}

/** 打开对话框并填写表单字段 */
function fillForm(over: Partial<Record<"name" | "model" | "apiKey" | "endpoint" | "description", string>> = {}) {
  const values = {
    name: "新模型",
    model: "claude-3-5-sonnet",
    apiKey: "sk-new",
    endpoint: "https://new.example.com/v1",
    description: "新描述",
    ...over,
  }
  if (values.name !== undefined) fireEvent.change(screen.getByLabelText(/modelName/), { target: { value: values.name } })
  if (values.model !== undefined) fireEvent.change(screen.getByLabelText(/modelId/), { target: { value: values.model } })
  if (values.apiKey !== undefined) fireEvent.change(screen.getByLabelText(/apiKey/), { target: { value: values.apiKey } })
  if (values.endpoint !== undefined) fireEvent.change(screen.getByLabelText(/customEndpoint/), { target: { value: values.endpoint } })
  if (values.description !== undefined) fireEvent.change(screen.getByLabelText(/description/), { target: { value: values.description } })
}

function openAddDialog() {
  fireEvent.click(screen.getByText("settings.sections.llm.savedModels.addModel"))
}

beforeEach(() => {
  vi.clearAllMocks()
  setupDomGlobals()
  mocks.confirm.mockReturnValue(true)
  vi.spyOn(window, "confirm").mockImplementation(() => mocks.confirm())
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }))
  vi.stubGlobal("fetch", fetchMock)
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("SavedModelsManager — 列表渲染", () => {
  it("无模型时渲染 empty 文案", () => {
    renderManager([])
    expect(screen.getByText("settings.sections.llm.savedModels.empty")).toBeInTheDocument()
    expect(screen.getByText("settings.sections.llm.savedModels.title")).toBeInTheDocument()
  })

  it("模型卡片渲染名称/模型号/描述/接口/测试按钮；无 apiKey 等可选字段不渲染对应行", () => {
    renderManager([
      makeModel(),
      makeModel({
        id: "m2",
        name: "极简",
        model: "mini",
        apiKey: undefined,
        customEndpoint: undefined,
        description: undefined,
      }),
    ])
    expect(screen.getByText("默认模型")).toBeInTheDocument()
    expect(screen.getByText("gpt-4o")).toBeInTheDocument()
    expect(screen.getByText("主模型描述")).toBeInTheDocument()
    expect(screen.getByText(/api\.example\.com/)).toBeInTheDocument()
    expect(screen.getByText("极简")).toBeInTheDocument()
    expect(screen.getByText("mini")).toBeInTheDocument()
    // 卡片测试按钮（每卡一个）+ 无对话框时无弹层
    expect(screen.getAllByText("测试模型")).toHaveLength(2)
    expect(screen.queryByTestId("dialog")).not.toBeInTheDocument()
  })
})

describe("SavedModelsManager — 新增/编辑/删除", () => {
  it("新增：空表单 → 保存禁用；填 name/model → 保存触发 onChange（trim/undefined 归一）", () => {
    const onChange = vi.fn()
    renderManager([], onChange)
    openAddDialog()
    // 标题：新增模式 (editingId null → addModel)；顶部 add 按钮同文案 → getAllByText
    expect(screen.getAllByText("settings.sections.llm.savedModels.addModel")).toHaveLength(2)
    const save = screen.getByText("common.save") as HTMLButtonElement
    expect(save).toBeDisabled()
    // 只填 name → 仍禁用
    fillForm({ name: "  新模型  ", model: "", apiKey: "", endpoint: "", description: "" })
    expect(save).toBeDisabled()
    // 填 model → 启用；保存 → onChange
    fillForm({ model: "  claude-3-5-sonnet  " })
    expect(save).not.toBeDisabled()
    fireEvent.click(save)
    const [models] = onChange.mock.calls[0] as [SavedModel[]]
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      name: "新模型",
      model: "claude-3-5-sonnet",
      apiKey: "sk-new",
      customEndpoint: "https://new.example.com/v1",
      description: "新描述",
    })
    expect(models[0].id).toMatch(/^model-\d+$/)
    expect(typeof models[0].createdAt).toBe("number")
    // 保存后对话框关闭
    expect(screen.queryByTestId("dialog")).not.toBeInTheDocument()
  })

  it("新增：全部可选字段留空 → apiKey/customEndpoint/description 为 undefined", () => {
    const onChange = vi.fn()
    renderManager([], onChange)
    openAddDialog()
    fillForm({ apiKey: "", endpoint: "", description: "" })
    fireEvent.click(screen.getByText("common.save"))
    const [models] = onChange.mock.calls[0] as [SavedModel[]]
    expect(models[0].apiKey).toBeUndefined()
    expect(models[0].customEndpoint).toBeUndefined()
    expect(models[0].description).toBeUndefined()
  })

  it("编辑：预填表单 + 保留 id/createdAt；编辑模式标题 editModel", () => {
    const onChange = vi.fn()
    renderManager([makeModel()], onChange)
    fireEvent.click(screen.getByTitle("settings.sections.llm.savedModels.edit"))
    expect(screen.getByText("settings.sections.llm.savedModels.editModel")).toBeInTheDocument()
    expect((screen.getByLabelText(/modelName/) as HTMLInputElement).value).toBe("默认模型")
    expect((screen.getByLabelText(/modelId/) as HTMLInputElement).value).toBe("gpt-4o")
    expect((screen.getByLabelText(/apiKey/) as HTMLInputElement).value).toBe("sk-123")
    fireEvent.change(screen.getByLabelText(/modelName/), { target: { value: "改名模型" } })
    fireEvent.click(screen.getByText("common.save"))
    const [models] = onChange.mock.calls[0] as [SavedModel[]]
    expect(models).toHaveLength(1)
    expect(models[0].id).toBe("m1")
    expect(models[0].name).toBe("改名模型")
    expect(models[0].createdAt).toBe(1000)
  })

  it("编辑：保存时原 createdAt 读取失败 → Date.now 兜底（createdAt 缺失模型）", () => {
    const onChange = vi.fn()
    const before = Date.now()
    renderManager([makeModel({ createdAt: undefined as unknown as number })], onChange)
    fireEvent.click(screen.getByTitle("settings.sections.llm.savedModels.edit"))
    fireEvent.click(screen.getByText("common.save"))
    const [models] = onChange.mock.calls[0] as [SavedModel[]]
    expect(models[0].createdAt).toBeGreaterThanOrEqual(before)
  })

  it("删除：confirm=true → onChange filter；confirm=false → 不调用", () => {
    const onChange = vi.fn()
    renderManager([makeModel(), makeModel({ id: "m2", name: "第二个" })], onChange)
    // confirm=true
    fireEvent.click(screen.getAllByTitle("settings.sections.llm.savedModels.delete")[0])
    expect(window.confirm).toHaveBeenCalledWith("settings.sections.llm.savedModels.confirmDelete")
    const [after] = onChange.mock.calls[0] as [SavedModel[]]
    expect(after.map((m) => m.id)).toEqual(["m2"])
    // confirm=false（组件受控，两次删除按钮都仍在 DOM）
    mocks.confirm.mockReturnValue(false)
    fireEvent.click(screen.getAllByTitle("settings.sections.llm.savedModels.delete")[0])
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it("取消按钮关闭对话框", () => {
    renderManager([])
    openAddDialog()
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
    fireEvent.click(screen.getByText("common.cancel"))
    expect(screen.queryByTestId("dialog")).not.toBeInTheDocument()
  })

  it("禁用态保存按钮点击不触发 onChange（handleSave 守卫）", () => {
    const onChange = vi.fn()
    renderManager([], onChange)
    openAddDialog()
    const save = screen.getByText("common.save") as HTMLButtonElement
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(onChange).not.toHaveBeenCalled()
  })

  it("编辑：模型缺 apiKey/customEndpoint/description → 表单回退空串", () => {
    const onChange = vi.fn()
    renderManager([makeModel({ apiKey: undefined, customEndpoint: undefined, description: undefined })], onChange)
    fireEvent.click(screen.getByTitle("settings.sections.llm.savedModels.edit"))
    expect((screen.getByLabelText(/apiKey/) as HTMLInputElement).value).toBe("")
    expect((screen.getByLabelText(/customEndpoint/) as HTMLInputElement).value).toBe("")
    expect((screen.getByLabelText(/description/) as HTMLInputElement).value).toBe("")
    fireEvent.click(screen.getByText("common.save"))
    const [models] = onChange.mock.calls[0] as [SavedModel[]]
    expect(models[0].apiKey).toBeUndefined()
  })

  it("编辑：多模型时仅替换目标 id（map else 分支）", () => {
    const onChange = vi.fn()
    renderManager([makeModel(), makeModel({ id: "m2", name: "不动" })], onChange)
    fireEvent.click(screen.getAllByTitle("settings.sections.llm.savedModels.edit")[0])
    fireEvent.click(screen.getByText("common.save"))
    const [models] = onChange.mock.calls[0] as [SavedModel[]]
    expect(models.map((m) => m.name)).toEqual(["默认模型", "不动"])
  })
})

describe("SavedModelsManager — 拉取模型 (handleFetchModels)", () => {
  it("成功：拉取数量 toast + console.log；按钮 busy 文案", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }, { id: "c" }] }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    renderManager([])
    openAddDialog()
    fillForm({ model: "", description: "" })
    fireEvent.click(screen.getByText("拉取模型"))
    expect(screen.getByText("拉取中...")).toBeInTheDocument()
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("已拉取 3 个模型"))
    expect(fetchMock).toHaveBeenCalledWith("https://new.example.com/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer sk-new" }),
    }))
    expect(console.log).toHaveBeenCalled()
    expect(screen.getByText("拉取模型")).toBeInTheDocument()
  })

  it("HTTP 非 2xx → toast.error HTTP 状态码", async () => {
    const fetchMock = vi.fn(async () => new Response("err", { status: 500 }))
    vi.stubGlobal("fetch", fetchMock)
    renderManager([])
    openAddDialog()
    fillForm({ model: "", description: "" })
    fireEvent.click(screen.getByText("拉取模型"))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("HTTP 500"))
  })

  it("fetch 拒绝 → toast.error(message)；非 Error 拒绝 → 未知错误", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("网络不可达")
    })
    vi.stubGlobal("fetch", fetchMock)
    renderManager([])
    openAddDialog()
    fillForm({ model: "", description: "" })
    fireEvent.click(screen.getByText("拉取模型"))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("网络不可达"))
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw "boom"
    }))
    fireEvent.click(screen.getByText("拉取模型"))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("未知错误"))
  })

  it("成功但 data.data 缺失 → 0 个模型 toast（data || [] 回退）", async () => {
    renderManager([])
    openAddDialog()
    fillForm({ model: "", description: "" })
    fireEvent.click(screen.getByText("拉取模型"))
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("已拉取 0 个模型"))
  })

  it("apiKey 留空 → Authorization Bearer 空串（trim || \"\" 回退）", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    renderManager([])
    openAddDialog()
    fillForm({ model: "", apiKey: "", description: "" })
    fireEvent.click(screen.getByText("拉取模型"))
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("已拉取 0 个模型"))
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/models"), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer " }),
    }))
  })

  it("无 endpoint 时拉取按钮禁用；点击不触发 toast（守卫不可达验证）", () => {
    renderManager([])
    openAddDialog()
    fillForm({ model: "", description: "", endpoint: "" })
    const fetchBtn = screen.getByText("拉取模型") as HTMLButtonElement
    expect(fetchBtn).toBeDisabled()
    fireEvent.click(fetchBtn)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})

describe("SavedModelsManager — 测试模型 (handleTestModel)", () => {
  it("卡片测试：成功 → 成功 toast + console.log；busy 文案切换", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    renderManager([makeModel()])
    fireEvent.click(screen.getByText("测试模型"))
    expect(screen.getByText("测试中...")).toBeInTheDocument()
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("模型 默认模型 可正常使用"))
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/v1/chat/completions", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"model":"gpt-4o"'),
    }))
    expect(screen.getByText("测试模型")).toBeInTheDocument()
  })

  it("卡片测试：未配置接口 → toast.error；HTTP 非 2xx → toast.error 状态码", async () => {
    renderManager([makeModel({ customEndpoint: undefined })])
    fireEvent.click(screen.getByText("测试模型"))
    expect(mocks.toastError).toHaveBeenCalledWith("该模型未配置接口地址")
    expect(screen.getByText("测试模型")).toBeInTheDocument()
    const fetchMock = vi.fn(async () => new Response("err", { status: 429 }))
    vi.stubGlobal("fetch", fetchMock)
    cleanup()
    renderManager([makeModel()])
    fireEvent.click(screen.getByText("测试模型"))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("HTTP 429"))
  })

  it("对话框内临时测试：填 model + endpoint → 以 temp id 调 handleTestModel", async () => {
    renderManager([])
    openAddDialog()
    // 未填 model → 测试模型按钮禁用
    const tempTest = screen.getByText("测试模型") as HTMLButtonElement
    expect(tempTest).toBeDisabled()
    fillForm({ name: "", description: "" })
    expect(tempTest).not.toBeDisabled()
    fireEvent.click(tempTest)
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("模型  可正常使用"))
  })

  it("对话框内临时测试：无 endpoint → toast.error（temp 模型）", async () => {
    renderManager([])
    openAddDialog()
    fillForm({ name: "", description: "", endpoint: "" })
    fireEvent.click(screen.getByText("测试模型"))
    expect(mocks.toastError).toHaveBeenCalledWith("该模型未配置接口地址")
  })

  it("卡片测试：apiKey 缺失 → Bearer 空串；非 Error 拒绝 → 未知错误", async () => {
    const fetchMock = vi.fn(async () => {
      throw "boom-string"
    })
    vi.stubGlobal("fetch", fetchMock)
    renderManager([makeModel({ apiKey: undefined })])
    fireEvent.click(screen.getByText("测试模型"))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("未知错误"))
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/chat/completions"), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer " }),
    }))
  })

  it("对话框内临时测试：apiKey 留空 → temp 模型 apiKey undefined（Bearer 空串）", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    renderManager([])
    openAddDialog()
    fillForm({ name: "", apiKey: "", description: "" })
    fireEvent.click(screen.getByText("测试模型"))
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("模型  可正常使用"))
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/chat/completions"), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer " }),
    }))
  })
})
