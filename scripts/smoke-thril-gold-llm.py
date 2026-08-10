# -*- coding: utf-8 -*-
"""Thril-only gold smoke via urllib (Node fetch may fail on this host)."""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parents[1]
ENV = ROOT / ".env.test.local"
if ENV.exists():
    for line in ENV.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip("'\""))


def arg(name: str, default: str = "") -> str:
    flag = f"--{name}"
    if flag in sys.argv:
        i = sys.argv.index(flag)
        return sys.argv[i + 1] if i + 1 < len(sys.argv) else default
    return default


KEY = os.environ.get("STEP0_REAL_LLM_KEY", "")
BASE = os.environ.get("STEP0_REAL_LLM_BASE", "").rstrip("/")
MODEL = os.environ.get("STEP0_REAL_LLM_MODEL", "claude-sonnet-4-6")
samples = max(1, min(5, int(arg("samples", os.environ.get("STEP0_SAMPLES", "1")) or "1")))

pack_path = Path(arg("pack"))
chapter_file = Path(arg("chapter-file"))
project = Path(arg("project", r"E:/写作/8人"))
out = Path(arg("out", str(ROOT.parent / ".workflow/harvest-staging/step0-ab-results-ch4-gold-thril-smoke.json")))

if not KEY or not BASE or not pack_path.exists() or not chapter_file.exists():
    print(json.dumps({"ok": False, "error": "missing key/base/pack/chapter"}, ensure_ascii=False, indent=2))
    sys.exit(2)

pack = json.loads(pack_path.read_text(encoding="utf-8"))
chapter_text = chapter_file.read_text(encoding="utf-8-sig")
gold_path = project / ".novel" / "literary-gold-anchors.json"
gold = json.loads(gold_path.read_text(encoding="utf-8")) if gold_path.exists() else {"anchors": []}
thril_anchors = [
    a
    for a in gold.get("anchors", [])
    if a.get("dimension") == "thrill" and a.get("status") == "human_confirmed" and len(str(a.get("text") or "")) >= 20
]


def format_gold(anchors, max_n=3) -> str:
    if not anchors:
        return "【文学金标量程 · thril · 非产品硬门】\n金标未就绪"
    lines = []
    for i, a in enumerate(anchors[:max_n], 1):
        t = a["text"]
        if len(t) > 280:
            t = t[:280] + "…"
        lines.append(f"{i}. [target≈{a.get('targetScore', 9)}|human_confirmed] {t}")
    return "\n".join(
        [
            "【文学金标 thril 量程参照 · human_confirmed · 非产品硬门】",
            "以下片段代表人类认可的约 9+ / 9–10 档，仅作量程锚，不得把 thril/overall≥9 写成产品硬门。",
            *lines,
        ]
    )


gold_block = format_gold(thril_anchors)
body = chapter_text if len(chapter_text) <= 12000 else chapter_text[:5000] + "\n\n[中段省略]\n\n" + chapter_text[-5000:]
tf = pack.get("temporalFacts") or []
tf_lines = "\n".join(
    f"- {f.get('subject','')}{f.get('predicate','')}{f.get('object','')} @ch{f.get('validFrom')}" for f in tf[:12]
)
prompt = "\n\n".join(
    [
        f"任务：{pack.get('task') or '六维审查'}",
        f"章目标：{pack.get('chapterGoal') or ''}",
        f"大纲摘录：\n{str(pack.get('outline') or '')[:4000]}",
        f"角色状态：\n{str(pack.get('characterStates') or '')[:2500]}",
        f"时间线事实（{len(tf)}）：\n{tf_lines}" if tf else "时间线事实：（空）",
        "六维独立审查维度：爽感密度（thril）",
        "评分量程 0-10。9-10=可发表文学质量。Track B only，非产品硬门。",
        gold_block,
        '只输出最终 JSON：{"score":0.0,"status":"...","summary":"...","issues":[]}',
        "章节正文：",
        body,
    ]
)


def call(sample: int) -> dict:
    payload = json.dumps(
        {
            "model": MODEL,
            "temperature": 0.4,
            "max_tokens": 2000,
            "messages": [{"role": "user", "content": f"{prompt}\n\n[sample {sample}] 只输出 JSON。"}],
        },
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        BASE + "/chat/completions",
        data=payload,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        raw = resp.read().decode("utf-8", "ignore")
    data = json.loads(raw)
    content = data.get("choices", [{}])[0].get("message", {}).get("content") or raw
    m = re.search(r'"score"\s*:\s*([\d.]+)', content)
    score = float(m.group(1)) if m else None
    if score is not None and score > 10.5:
        score = score / 10.0
    return {"score": score, "content": content[:4000]}


scores = []
errors = []
details = []
for i in range(samples):
    try:
        r = call(i)
        details.append(r)
        scores.append(r["score"])
        print(f"[thril/s{i}] score={r['score']}", file=sys.stderr)
    except Exception as e:
        errors.append(str(e))
        scores.append(None)
        print(f"[thril/s{i}] error {e}", file=sys.stderr)

valid = [s for s in scores if isinstance(s, (int, float))]
med = float(median(valid)) if valid else None

report = {
    "generatedAt": __import__("datetime").datetime.now().astimezone().isoformat(),
    "model": MODEL,
    "base": BASE,
    "samples": samples,
    "label": "ch4-gold-pack-thril-smoke",
    "productHardGate": False,
    "pack": {
        "path": str(pack_path),
        "characterStateChars": len(str(pack.get("characterStates") or "")),
        "temporalFactsCount": len(tf),
    },
    "gold": {
        "thrilHumanConfirmed": len(thril_anchors),
        "promptContains文学金标": "文学金标" in prompt,
        "promptContainsHumanConfirmed": "human_confirmed" in prompt,
        "promptChars": len(prompt),
    },
    "results": {"thrill": {"new": scores, "newMedian": med, "errors": errors}},
    "samplesDetail": [{"score": d["score"], "contentHead": d["content"][:500]} for d in details],
    "ingestDecision": {
        "formalIngest": False,
        "reason": "Heuristic committed seed kept; formal LLM ingest optional upgrade when extract model budget available",
        "seedSnapshots": 6,
        "newCanonFacts": 29,
    },
    "ch4DebtPolicy": {
        "priorTrueProdThrillMedian": 7.8,
        "smokeMedian": med,
        "action": "observe_continue",
        "product_blocker": False,
        "note": "Smoke N=1 not seal-grade N≥5; keep literary_debt open/observe; no fragment rewrite",
    },
}

out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(
    json.dumps(
        {
            "ok": bool(valid),
            "out": str(out),
            "thrilScores": scores,
            "thrilMedian": med,
            "goldInPrompt": report["gold"]["promptContains文学金标"],
            "packTemporal": len(tf),
            "packCharacterChars": report["pack"]["characterStateChars"],
            "errors": errors,
        },
        ensure_ascii=False,
        indent=2,
    )
)
sys.exit(0 if valid else 3)
