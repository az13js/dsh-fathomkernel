import json, math, sys
from pathlib import Path

rounds_path = Path(sys.argv[1])
out = Path(sys.argv[2])
rows = [json.loads(line) for line in rounds_path.read_text().splitlines() if line.strip()]
rows = [r for r in rows if isinstance(r.get('metric'), (int, float)) and r['metric'] > 0]
if not rows:
    raise SystemExit('no measured rounds')
base = next((r['metric'] for r in rows if r.get('seed')), rows[0]['metric'])
best = min(r['metric'] for r in rows)
W, H = 940, 380
left, right, top, bottom = 78, 38, 58, 58
pw, ph = W - left - right, H - top - bottom
vals = [r['metric'] for r in rows] + [base]
lo, hi = min(vals) / 1.45, max(vals) * 1.45
log = lambda v: math.log10(v)
x = lambda i: left + (pw / 2 if len(rows) == 1 else i * pw / (len(rows) - 1))
y = lambda v: top + (1 - (log(v) - log(lo)) / (log(hi) - log(lo))) * ph
parts = []
parts.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="FathomKernel GEMM optimization curve">')
parts.append('<rect width="100%" height="100%" fill="#ffffff"/>')
parts.append(f'<text x="{left}" y="30" font-family="Inter, system-ui, sans-serif" font-size="19" font-weight="650" fill="#111827">FathomKernel: 512³ fp32 GEMM self-evolution</text>')
parts.append(f'<text x="{left}" y="49" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#6b7280">Xeon 8255C · AVX-512 · single thread · median of 3 benchmark processes × 5 runs · best {best:.3f} ms ({base/best:.1f}× over seed)</text>')
# grid + y labels
for i in range(4):
    ratio = i / 3
    v = 10 ** (log(lo) + ratio * (log(hi) - log(lo)))
    yy = top + (1 - ratio) * ph
    parts.append(f'<line x1="{left}" y1="{yy:.1f}" x2="{W-right}" y2="{yy:.1f}" stroke="#e5e7eb" stroke-width="1" stroke-dasharray="0"/>')
    parts.append(f'<text x="{left-10}" y="{yy+4:.1f}" text-anchor="end" font-family="ui-monospace, monospace" font-size="11" fill="#6b7280">{v:.0f} ms</text>')
# baseline
by = y(base)
parts.append(f'<line x1="{left}" y1="{by:.1f}" x2="{W-right}" y2="{by:.1f}" stroke="#f59e0b" stroke-width="1.4" stroke-dasharray="7 5"/>')
parts.append(f'<text x="{W-right}" y="{by-7:.1f}" text-anchor="end" font-family="Inter, sans-serif" font-size="11" fill="#b45309">baseline {base:.1f} ms</text>')
# best line
run = None
pts = []
for i, r in enumerate(rows):
    run = r['metric'] if run is None or r['metric'] < run else run
    pts.append(f'{x(i):.1f},{y(run):.1f}')
parts.append(f'<polyline points="{" ".join(pts)}" fill="none" stroke="#16a34a" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>')
# points + labels
for i, r in enumerate(rows):
    xx, yy = x(i), y(r['metric'])
    color = '#16a34a' if r.get('improved') else ('#dc2626' if not r.get('ok', True) else '#6b7280')
    parts.append(f'<circle cx="{xx:.1f}" cy="{yy:.1f}" r="4.3" fill="#ffffff" stroke="{color}" stroke-width="2"/>')
    label = f"{r['metric']:.2f}"
    label_y = yy + 19 if i == 0 else yy - 11
    parts.append(f'<text x="{xx:.1f}" y="{label_y:.1f}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10.5" fill="#374151">{label}</text>')
    rr = 'seed' if r.get('seed') else f"r{r['round']}"
    parts.append(f'<text x="{xx:.1f}" y="{H-bottom+20:.1f}" text-anchor="middle" font-family="Inter, sans-serif" font-size="10.5" fill="#6b7280">{rr}</text>')
parts.append(f'<text x="{left}" y="{H-18}" font-family="Inter, sans-serif" font-size="11" fill="#6b7280">rounds (green line = best-so-far; each point = median measured latency)</text>')
parts.append('</svg>')
out.write_text('\n'.join(parts))
print(out, 'wrote', len(rows), 'rounds', 'best', best)
