// 服装资源加载 + 网格变形渲染
const BASE = './assets/garments/';

export async function loadGarments() {
  const ids = await (await fetch(BASE + 'index.json')).json();
  return Promise.all(ids.map(async (id) => {
    const meta = await (await fetch(`${BASE}${id}.json`)).json();
    const img = new Image(); img.src = BASE + meta.file; await img.decode();
    return { ...meta, img };
  }));
}

const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const smooth01 = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const rot = (p, c, ang) => { const s = Math.sin(ang), co = Math.cos(ang), dx = p.x - c.x, dy = p.y - c.y; return { x: c.x + dx * co - dy * s, y: c.y + dx * s + dy * co }; };
const angle = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);

/**
 * 把服装模板中的点 (x,y) 映射到画面。
 * 模板以「肩线 + 髋线」构成梯形；在梯形参数空间 (s,t) 中做双线性插值（可外推到袖子/裙摆）。
 * 袖子区域额外按上臂角度绕肩点旋转，实现简单的袖子跟随。
 */
function makeMapper(g, dst, opts) {
  const P = g.points;
  const tl = { x: P.leftShoulder[0], y: P.leftShoulder[1] }, tr = { x: P.rightShoulder[0], y: P.rightShoulder[1] };
  const bl = { x: P.leftHip[0], y: P.leftHip[1] }, br = { x: P.rightHip[0], y: P.rightHip[1] };
  const sy = (tl.y + tr.y) / 2, hy = (bl.y + br.y) / 2;
  // 模板袖子方向（肩点 → 袖口中心）大约 55° 向下外侧
  const tmplArmL = angle(tl, { x: tl.x - 70, y: tl.y + 100 });
  const tmplArmR = angle(tr, { x: tr.x + 70, y: tr.y + 100 });
  const dL = opts.sleeveFollow && dst.elbowL ? clampAng(angle(dst.tl, dst.elbowL) - tmplArmL - dstRoll(dst), 1.1) : 0;
  const dR = opts.sleeveFollow && dst.elbowR ? clampAng(angle(dst.tr, dst.elbowR) - tmplArmR - dstRoll(dst), 1.1) : 0;
  return (x, y) => {
    const t = (y - sy) / (hy - sy);
    const lx = tl.x + (bl.x - tl.x) * t, rx = tr.x + (br.x - tr.x) * t;
    const s = (x - lx) / (rx - lx);
    const top = lerp(dst.tl, dst.tr, s), bot = lerp(dst.bl, dst.br, s);
    let p = lerp(top, bot, t);
    // 袖子：肩线外侧、靠上的点
    const wTop = 1 - smooth01((t - 0.25) / 0.2);
    if (s < 0 && dL) p = rot(p, dst.tl, dL * smooth01(-s / 0.12) * wTop);
    if (s > 1 && dR) p = rot(p, dst.tr, dR * smooth01((s - 1) / 0.12) * wTop);
    return p;
  };
}
function clampAng(a, m) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return Math.max(-m, Math.min(m, a)); }
function dstRoll(d) { return angle(d.tl, d.tr); }

/** 仿射贴三角形：源三角 (s0,s1,s2) → 目标三角 (d0,d1,d2) */
function drawTri(ctx, img, s0, s1, s2, d0, d1, d2) {
  // 目标三角略外扩 0.6px，消除网格缝隙
  const cx = (d0.x + d1.x + d2.x) / 3, cy = (d0.y + d1.y + d2.y) / 3;
  const ex = (p) => { const dx = p.x - cx, dy = p.y - cy, l = Math.hypot(dx, dy) || 1; return { x: p.x + dx / l * 0.6, y: p.y + dy / l * 0.6 }; };
  const e0 = ex(d0), e1 = ex(d1), e2 = ex(d2);
  const den = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(den) < 1e-6) return;
  const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / den;
  const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / den;
  const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / den;
  const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / den;
  const e = (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) / den;
  const f = (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) / den;
  ctx.save();
  ctx.beginPath(); ctx.moveTo(e0.x, e0.y); ctx.lineTo(e1.x, e1.y); ctx.lineTo(e2.x, e2.y); ctx.closePath(); ctx.clip();
  ctx.setTransform(a, b, c, d, e, f); // 叠加在 identity 上（调用方保证 ctx 为 identity）
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/**
 * 渲染服装到 ctx（应为单独的离屏图层，便于之后做遮罩）。
 * dst: { tl, tr, bl, br, elbowL?, elbowR? } 画面像素坐标，tl = 画面左侧肩（人物右肩）
 */
export function renderGarment(ctx, g, dst, opts = {}) {
  const map = makeMapper(g, dst, opts);
  const COLS = 10, ROWS = 14;
  const grid = [];
  for (let j = 0; j <= ROWS; j++) {
    const row = [];
    for (let i = 0; i <= COLS; i++) {
      const sx = (i / COLS) * g.width, sy = (j / ROWS) * g.height;
      row.push({ s: { x: sx, y: sy }, d: map(sx, sy) });
    }
    grid.push(row);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
    const a = grid[j][i], b = grid[j][i + 1], c = grid[j + 1][i], d = grid[j + 1][i + 1];
    drawTri(ctx, g.img, a.s, b.s, c.s, a.d, b.d, c.d);
    drawTri(ctx, g.img, b.s, d.s, c.s, b.d, d.d, c.d);
  }
  if (opts.debugMesh) {
    ctx.strokeStyle = 'rgba(0,255,200,.35)'; ctx.lineWidth = 1;
    for (const row of grid) { ctx.beginPath(); row.forEach((p, i) => i ? ctx.lineTo(p.d.x, p.d.y) : ctx.moveTo(p.d.x, p.d.y)); ctx.stroke(); }
  }
}

/**
 * 用户上传图片 → 服装对象。
 * - 若图片本身带透明通道（PNG），直接使用；
 * - 否则从四周边缘做「背景色泛洪」快速去背（适合纯色/浅色背景的商品图）；
 * - 按 alpha 轮廓自动估计肩点与髋点。
 */
export async function garmentFromFile(file, { removeBg = true, category = 'auto' } = {}) {
  const url = URL.createObjectURL(file);
  const img = new Image(); img.src = url; await img.decode();
  const MAX = 900, k = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(url);
  let data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  let transparent = 0;
  for (let i = 3; i < px.length; i += 16) if (px[i] < 250) transparent++;
  const hasAlpha = transparent > px.length / 16 * 0.05;
  let note = hasAlpha ? '已使用图片自带透明通道' : '未去背景（整图叠加）';
  if (!hasAlpha && removeBg) { floodRemove(px, w, h); note = '已自动去除背景（边缘泛洪，纯色背景效果最佳）'; }
  ctx.putImageData(data, 0, 0);
  // 包围盒
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 <= x0 || y1 <= y0) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; note = '未检测到主体，使用整图'; }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const out = document.createElement('canvas'); out.width = bw; out.height = bh;
  out.getContext('2d').drawImage(cv, x0, y0, bw, bh, 0, 0, bw, bh);
  const a2 = out.getContext('2d').getImageData(0, 0, bw, bh).data;
  const rowSpan = (y) => { y = Math.max(0, Math.min(bh - 1, Math.round(y))); let l = -1, r = -1; for (let x = 0; x < bw; x++) if (a2[(y * bw + x) * 4 + 3] > 60) { if (l < 0) l = x; r = x; } return l < 0 ? [bw * 0.2, bw * 0.8] : [l, r]; };
  const aspect = bh / bw;
  const cat = category === 'auto' ? (aspect > 1.25 ? 'dress' : 'top') : category;
  // 肩线约在主体 12% 高度处，肩点向内收 12% 行宽（去掉袖子外沿）；髋线：上衣 ≈ 底部，连衣裙 ≈ 50%
  const shY = bh * 0.12, [sl, sr] = rowSpan(shY), inset = (sr - sl) * 0.12;
  const hipY = cat === 'dress' ? bh * 0.5 : bh * 0.94;
  const cx = (sl + sr) / 2, sw = sr - sl - 2 * inset, hipHalf = sw * 0.42;
  const imgOut = new Image(); imgOut.src = out.toDataURL('image/png'); await imgOut.decode();
  return {
    id: 'upload-' + Date.now(), name: file.name.replace(/\.[^.]+$/, '').slice(0, 14) || '上传服装', file: null,
    category: cat, anchor: 'shoulders', width: bw, height: bh, naturalShoulderWidth: sw, sleeveFollow: false,
    points: { leftShoulder: [sl + inset, shY], rightShoulder: [sr - inset, shY], leftHip: [cx - hipHalf, hipY], rightHip: [cx + hipHalf, hipY] },
    neck: [cx, shY * 0.6], img: imgOut, thumb: imgOut.src, uploaded: true, note,
  };
}

/** 从边缘开始按颜色相似度泛洪，把背景置为透明；边缘做 1px 羽化 */
function floodRemove(px, w, h) {
  const idx = (x, y) => (y * w + x) * 4;
  // 采样边框颜色作为背景参考（取中位数）
  const samples = [];
  for (let x = 0; x < w; x += 4) { samples.push(idx(x, 0), idx(x, h - 1)); }
  for (let y = 0; y < h; y += 4) { samples.push(idx(0, y), idx(w - 1, y)); }
  const med = [0, 1, 2].map((c) => samples.map((i) => px[i + c]).sort((a, b) => a - b)[samples.length >> 1]);
  const TOL = 42, TOL2 = TOL * TOL;
  const seen = new Uint8Array(w * h), stack = [];
  const near = (i) => { const dr = px[i] - med[0], dg = px[i + 1] - med[1], db = px[i + 2] - med[2]; return dr * dr + dg * dg + db * db < TOL2; };
  const push = (x, y) => { const p = y * w + x; if (!seen[p] && near(p * 4)) { seen[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const p = stack.pop(), x = p % w, y = (p / w) | 0;
    px[p * 4 + 3] = 0;
    if (x > 0) push(x - 1, y); if (x < w - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < h - 1) push(x, y + 1);
  }
  // 羽化：与背景相邻的前景像素半透明
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x; if (seen[p]) continue;
    if (seen[p - 1] || seen[p + 1] || seen[p - w] || seen[p + w]) px[p * 4 + 3] = 140;
  }
}
