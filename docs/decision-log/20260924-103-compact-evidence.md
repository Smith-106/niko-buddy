# 103 Compact Goal Evidence (ASCII only)

Date: 2026-09-24. Project: QMAI (niko-buddy v2.11.1 main chain).

## R1 All tasks done
- todo total=102. offset0 #1-50 all [x]. offset50 #51-100 all [x].
  offset100 #101-102 all [x]. Zero pending/blocked.
- Commits: a741863a, 86862911, 4b43eee7, d959f6c3, f5ca5638,
  cde30365, d3747834, 14187f08 (HEAD). git status lines=0 (clean).
- Debts closed: 89a (#90), 89b (#98 f5ca5638), 90a (#91 86862911),
  93a (#99 cde30365 + #100 double-green). Zero remaining.

## R2 Four reference reports considered
- RPT1 ainovel-cli strengths (7): 7-dim review+mandatory evidence,
  chapter contract, rolling-plan+completion checklist, 4-level
  compression, de-AI double layer, eval system, determinism-first.
- RPT2 AI-NWA: 3-layer director+LangGraph, versioned PromptAsset+
  dropOrder budget, RAG+book-mining reflow, quality-debt ledger
  (not blocking), derivative workshop (comic/drama, unique).
- RPT3 niko-buddy: task customization v2.9.0, control-kernel
  P0/P1/P2 gates, deep-chapter 6-stage chain, anti-AI 4 layers,
  905 spec/test mechanism density.
- RPT4 total report: DIM1 QMAI 4-star baseline / DIM2 QMAI 5-star /
  DIM3 QMAI 4-star / DIM4 QMAI 5-star; final ranking
  ainovel~=niko~=QMAI > AI-NWA~=studio > daizong > feelfish.

## R3 Surpass: 8-gap to code (all in QMAI/src/lib/novel/)
- gap1-3 (#88): deep-chapter-task-brief.ts:340 build / :354 parse /
  :412 check; deep-chapter-generation.ts:704 applyCheck.
- gap4 (#90): mechanical-slop-detector.ts:847 rollupStyleStats /
  :906 bookStyleStatsToText.
- gap5 (#89): story-compass.ts (evaluateCompletionChecklist:205,
  checkCompleteBookAllowed:308); volume.ts:272 checkFinaleAutoComplete.
- gap6 (#89): context-compact.ts (buildRestorePack:222,
  compactContextSections:282, DROP_ORDER, breaker, 6000-char pack).
- gap7 (#90): related-chapters.ts:305 recentCast / :328 renderCastIntros.
- gap8 (#90): dimension-review-adapter.ts:1138 minimalReworkSet /
  :1155 FromDimensionIssues / :328 dimensionResultsToReviewResults
  (evidence gate + score/verdict decoupling).
- plus (#91): repair-loop.ts:202 TRIAD_MAX_REWORK=2, :220 createState,
  :225 planGate, :232 draftGate, :243 reviewGate, :257 advance.
- plus (#98): contract.transitional self-declared, trade_off->info.
- specs: task-brief 26 cases, repair-loop 14, slop-detector 52.

## R4 Re-eval on each completion
- #90 first re-eval: DIM1 4->5, DIM2 5->5 tie, DIM3 4->4.5 (gap to R2),
  DIM4 5->5+; verdict: tie first tier, DIM3 left to Round2.
- #91 final re-eval: DIM1 5 DIM2 5 DIM3 5 DIM4 5+; first-tier sole lead
  (DIM1+DIM4 mechanism lead, DIM2 tie, DIM3 tied).
- #93/#98/#99/d3747834: zero product-behavior change, no re-eval
  needed (recorded in messages/docs). Final rating stands.
- Docs: decision-log 89/90/91/93/102 on file.

## R5 Feasibility
- typecheck: EXIT=0 (fresh run this turn).
- build: EXIT=0, built in 39.68s, dist/index.html present, dist=13M.

## R6 Stability
- test:mocks EXIT=0: 890 files passed / 2 skipped (892);
  13328 tests passed / 12 skipped (13340); graph-view isolation
  75/75; FAIL lines=0.

## R7 UI usability
- src/components: 177 files / 3055 tests passed, FAIL=0.
- graph-view right-click starvation fixed by data-settle gate
  (d3747834), 6x isolation 75/75 green, zero assertion relaxation.
- J03/J11/J12 longitudinal slice green; journey seals on file.
