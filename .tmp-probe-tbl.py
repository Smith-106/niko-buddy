import io, re
log = io.open(r"C:/Users/niko/AppData/Local/Temp/pi-bash-bg-BNjNmn/bg-2o-mw5ox3ce.log", encoding="utf-8", errors="replace").read()
rows = []
for line in log.splitlines():
    if "|" not in line:
        continue
    parts = [x.strip() for x in line.split("|")]
    if len(parts) < 6:
        continue
    name, stmts, br, fn, ln, unc = parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]
    if not unc or unc == "Uncovered Line #s":
        continue
    if not re.match(r"^[\d,\-]+$", unc):
        continue
    rows.append((name, stmts, unc))
print("rows:", len(rows))
for n, s, u in rows:
    print("%-32s %6s  %s" % (n[:32], s, u))
