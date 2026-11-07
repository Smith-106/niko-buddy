import json, io, sys
d = json.load(io.open('coverage/coverage-final.json', encoding='utf-8'))
targets = sys.argv[1:]
for p, v in d.items():
    rel = p.replace(chr(92), '/').split('QMAI/')[-1]
    if not any(t in rel for t in targets):
        continue
    src = io.open(p, encoding='utf-8', errors='replace').read().splitlines()
    unc = sorted({v['statementMap'][k]['start']['line'] for k, c in v['s'].items() if c == 0})
    print('\n### %s  %s' % (rel, unc))
    for ln in unc:
        for i in range(max(1, ln - 1), min(len(src), ln) + 1):
            print('%s %4d| %s' % ('>>' if i == ln else '  ', i, src[i - 1].strip()[:78]))
