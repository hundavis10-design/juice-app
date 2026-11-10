// Tiny SVG charts (no library). Returns SVG markup strings.
import { esc } from "./util.js";

const W = 520, H = 200, PAD = { l: 44, r: 12, t: 14, b: 30 };

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function axes(maxY, labels, xAt, fmtY) {
  let s = "";
  for (let i = 0; i <= 4; i++) {
    const v = maxY * i / 4, y = PAD.t + (H - PAD.t - PAD.b) * (1 - i / 4);
    s += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}" class="grid"/>`;
    s += `<text x="${PAD.l - 6}" y="${y + 4}" text-anchor="end" class="ax">${esc(fmtY(v))}</text>`;
  }
  const every = Math.ceil(labels.length / 8);
  labels.forEach((l, i) => {
    if (i % every) return;
    s += `<text x="${xAt(i)}" y="${H - 10}" text-anchor="middle" class="ax">${esc(l)}</text>`;
  });
  return s;
}

/** points: [{label, value|null}] */
export function lineChart(points, { fmtY = v => String(Math.round(v)), color = "var(--lime)", title = "" } = {}) {
  const vals = points.map(p => p.value).filter(v => v != null);
  if (!vals.length) return "";
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const minY = Math.max(0, Math.floor((lo - (hi - lo) * 0.3 - 10) / 10) * 10);
  const maxY = Math.ceil((hi + (hi - lo) * 0.2 + 10) / 10) * 10;
  const n = points.length;
  const xAt = i => PAD.l + (n === 1 ? (W - PAD.l - PAD.r) / 2 : i * (W - PAD.l - PAD.r) / (n - 1));
  const yAt = v => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - minY) / (maxY - minY || 1));
  let grid = "";
  for (let i = 0; i <= 4; i++) {
    const v = minY + (maxY - minY) * i / 4, y = yAt(v);
    grid += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}" class="grid"/><text x="${PAD.l - 6}" y="${y + 4}" text-anchor="end" class="ax">${esc(fmtY(v))}</text>`;
  }
  const every = Math.ceil(n / 8);
  const anchor = i => n === 1 ? "middle" : i === 0 ? "start" : i === n - 1 ? "end" : "middle";
  points.forEach((p, i) => { if (!(i % every) || i === n - 1) grid += `<text x="${xAt(i)}" y="${H - 10}" text-anchor="${anchor(i)}" class="ax">${esc(p.label)}</text>`; });
  let path = "", dots = "";
  points.forEach((p, i) => {
    if (p.value == null) return;
    path += (path ? "L" : "M") + xAt(i).toFixed(1) + "," + yAt(p.value).toFixed(1);
    dots += `<circle cx="${xAt(i)}" cy="${yAt(p.value)}" r="4" fill="${color}"><title>${esc(p.label)}: ${esc(fmtY(p.value))}</title></circle>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${grid}<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>${dots}</svg>`;
}

export function barChart(points, { fmtY = v => String(Math.round(v)), color = "var(--pink)", title = "" } = {}) {
  if (!points.length) return "";
  points = points.map(p => ({ ...p, value: Number.isFinite(+p.value) ? +p.value : 0 }));   // one bad record must not blank the chart
  const maxY = niceMax(Math.max(...points.map(p => p.value)));
  const n = points.length, slot = (W - PAD.l - PAD.r) / n, bw = Math.min(42, slot * 0.7);
  const xAt = i => PAD.l + slot * (i + 0.5);
  let s = axes(maxY, points.map(p => p.label), xAt, fmtY);
  points.forEach((p, i) => {
    const h = (H - PAD.t - PAD.b) * p.value / maxY;
    s += `<rect x="${xAt(i) - bw / 2}" y="${H - PAD.b - h}" width="${bw}" height="${h}" rx="5" fill="${color}"><title>${esc(p.label)}: ${esc(fmtY(p.value))}</title></rect>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${s}</svg>`;
}
