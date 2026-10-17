import type { IngestResult } from "./chapter-ingest";
import { recordModuleHit } from "./module-heat"
import { resolveReviewModel } from "./review-model";
import { listResumeCandidates, type ResumeCandidate } from "./stage-output-journal";

export interface ChapterPipelineDeps {
  ingestChapter: (projectPath: string, chapterPath: string, reviewModel: string) => Promise<IngestResult>;
  /**
   * 批量编排注入（R3）：默认走内存直调；UI 层可注入带并发/断点恢复的实现。
   * 缺省单章串行，保证旧调用方零改动可用。
   */
  runBatch?: (projectPath: string, chapterPaths: readonly string[], reviewModel: string) => Promise<BatchChapterResult[]>;
  /** 恢复候选扫描注入（R2可见化）：默认空列表；journal 背靠调用方按需注入。 */
  scanResume?: (projectPath: string, now: number) => Promise<ResumeCandidate[]>;
}

export type ChapterPipeline = (projectPath: string, chapterPath: string) => Promise<IngestResult>;

export interface BatchChapterResult {
  chapterPath: string;
  result: IngestResult;
}

export interface BatchPipelineSummary {
  total: number;
  succeeded: number;
  failed: number;
  results: BatchChapterResult[];
}

export const createChapterPipeline = (deps: ChapterPipelineDeps): ChapterPipeline => {
  return async (projectPath, chapterPath) => {
    const reviewModel = resolveReviewModel();
    return deps.ingestChapter(projectPath, chapterPath, reviewModel);
  };
};

/**
 * 批量管线（R3：对标 ANW 批量思想位，MIT 原生实现）。
 * 默认串行走 ingestChapter；注入 runBatch 时走调用方并发/恢复实现。
 * 失败隔离：单章抛错收敛为 { snapshot: null, failReason }，不中断整批。
 */
export function createBatchChapterPipeline(deps: ChapterPipelineDeps): (
  projectPath: string,
  chapterPaths: readonly string[],
) => Promise<BatchPipelineSummary> {
  return async (projectPath, chapterPaths) => {
    const reviewModel = resolveReviewModel();
    if (deps.runBatch) {
      const results = await deps.runBatch(projectPath, chapterPaths, reviewModel);
      let succeeded = 0;
      for (const r of results) if (r.result.snapshot) succeeded += 1;
      recordModuleHit({
        path: "src/lib/novel/chapter-pipeline.ts",
        at: Date.now(),
        ok: succeeded === chapterPaths.length,
        detail: `批量章节管线 ${succeeded}/${chapterPaths.length}`,
      });
      return { total: chapterPaths.length, succeeded, failed: results.length - succeeded, results };
    }
    const results: BatchChapterResult[] = [];
    for (const chapterPath of chapterPaths) {
      try {
        const result = await deps.ingestChapter(projectPath, chapterPath, reviewModel);
        results.push({ chapterPath, result });
      } catch {
        results.push({
          chapterPath,
          result: { snapshot: null, failReason: "extract_failed" },
        });
      }
    }
    let succeeded = 0;
    for (const r of results) if (r.result.snapshot) succeeded += 1;
    return { total: chapterPaths.length, succeeded, failed: results.length - succeeded, results };
  };
}

/**
 * 恢复候选查询（R2可见化：journal 层 listResumeCandidates 的管线侧薄封装）。
 * 未注入 scanResume 时回空列表（调用方按 digest 清单注入 journal 背靠）。
 */
export async function queryResumeCandidates(
  deps: ChapterPipelineDeps,
  projectPath: string,
  now: number,
): Promise<ResumeCandidate[]> {
  if (!deps.scanResume) return [];
  return deps.scanResume(projectPath, now);
}

export { listResumeCandidates, type ResumeCandidate };
