/**
 * 共享客户端分页控件（P2 统一分页）
 * 所有历史/进度/搜索列表复用此组件：全量已取数组 → 调用方 slice(page*pageSize,(page+1)*pageSize) → 渲染本控件。
 * 仅在 pageCount>1（即数据超过单页）时渲染，避免对短列表注入多余控件。
 */
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"

/** 默认单页条数；搜索沿用原硬顶语义（20），其余列表统一 20，单测可调小。 */
export const PAGINATION_PAGE_SIZE = 20

export interface PaginationProps {
  /** 当前页（1 基）。 */
  page: number
  /** 总页数（Math.ceil(total / pageSize)）。 */
  pageCount: number
  /** 总条数。 */
  total: number
  /** 单页条数（可选，仅用于展示）。 */
  pageSize?: number
  /** 上一页回调。 */
  onPrev: () => void
  /** 下一页回调。 */
  onNext: () => void
}

export function Pagination({ page, pageCount, total, pageSize, onPrev, onNext }: PaginationProps) {
  const { t } = useTranslation()
  if (pageCount <= 1) return null
  return (
    <div
      className="flex items-center justify-between gap-3 border-t px-4 py-2 text-xs text-muted-foreground"
      data-testid="pagination"
    >
      <button
        type="button"
        className="h-7 rounded-md border bg-background px-3 text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        onClick={onPrev}
        disabled={page <= 1}
        data-testid="pagination-prev"
      >
        {t("common.pagination.prev")}
      </button>
      <span data-testid="pagination-info">
        {t("common.pagination.info", { page, pageCount, total, pageSize: pageSize ?? PAGINATION_PAGE_SIZE })}
      </span>
      <button
        type="button"
        className="h-7 rounded-md border bg-background px-3 text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        onClick={onNext}
        disabled={page >= pageCount}
        data-testid="pagination-next"
      >
        {t("common.pagination.next")}
      </button>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// PaginationControls（v2.8 P1-2）：服务端分页通用控件
// ────────────────────────────────────────────────────────────────────────────

export interface PaginationControlsProps {
  /** 当前页（1 基）。 */
  page: number
  /** 总页数（Math.ceil(total / pageSize)，由调用方从服务端 total 推导）。 */
  pageCount: number
  /** 过滤后全量条数（服务端 total，非当前页条数）。 */
  total: number
  /** 翻页回调（携带钳位后的目标页码；越界由组件内部钳位）。 */
  onPageChange: (page: number) => void
  /** 加载中等场景禁用翻页（默认 false）。 */
  disabled?: boolean
  /** testid 前缀：`${prefix}-pagination|-page-prev|-page-info|-page-next`（默认 "pagination"）。 */
  testIdPrefix?: string
  /** 单页（pageCount<=1）时隐藏；默认 true（沿用 canon-editor 既有行为）。 */
  hideOnSinglePage?: boolean
  className?: string
}

/**
 * 服务端分页通用控件（上一页 / 页码 / 下一页 + 全量计数）。
 *
 * 与上方 `Pagination`（客户端切片列表用，onPrev/onNext 契约）互补：
 * 本控件面向「每次 IPC 只取当前页」的服务端分页流（canon-editor 等长列表），
 * `onPageChange(nextPage)` 单回调 + `disabled` + 可配 testid 前缀。
 * 文案走 i18n `common.pagination.*`（与 Pagination 共用键集）。
 */
export function PaginationControls({
  page,
  pageCount,
  total,
  onPageChange,
  disabled = false,
  testIdPrefix = "pagination",
  hideOnSinglePage = true,
  className,
}: PaginationControlsProps) {
  const { t } = useTranslation()
  if (hideOnSinglePage && pageCount <= 1) return null
  const prevPage = Math.max(1, page - 1)
  const nextPage = Math.min(pageCount, page + 1)
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-t px-4 py-2 text-xs text-muted-foreground",
        className,
      )}
      data-testid={`${testIdPrefix}-pagination`}
    >
      <button
        type="button"
        className="h-7 rounded-md border bg-background px-3 text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => onPageChange(prevPage)}
        disabled={disabled || page <= 1}
        data-testid={`${testIdPrefix}-page-prev`}
      >
        {t("common.pagination.prev")}
      </button>
      <span data-testid={`${testIdPrefix}-page-info`}>
        {t("common.pagination.info", { page, pageCount, total })}
      </span>
      <button
        type="button"
        className="h-7 rounded-md border bg-background px-3 text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => onPageChange(nextPage)}
        disabled={disabled || page >= pageCount}
        data-testid={`${testIdPrefix}-page-next`}
      >
        {t("common.pagination.next")}
      </button>
    </div>
  )
}
