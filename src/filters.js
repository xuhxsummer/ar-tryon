// 关键点平滑：One Euro Filter（Casiez 2012）+ 简单 EMA
const alpha = (cutoff, dt) => { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); };

class LowPass {
  constructor() { this.y = null; }
  filter(x, a) { this.y = this.y === null ? x : a * x + (1 - a) * this.y; return this.y; }
}

export class OneEuro {
  constructor({ minCutoff = 1.2, beta = 0.02, dCutoff = 1.0 } = {}) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.x = new LowPass(); this.dx = new LowPass(); this.tPrev = null; this.xPrev = null;
  }
  reset() { this.x = new LowPass(); this.dx = new LowPass(); this.tPrev = null; this.xPrev = null; }
  filter(v, tMs) {
    if (this.tPrev === null) { this.tPrev = tMs; this.xPrev = v; this.x.filter(v, 1); this.dx.filter(0, 1); return v; }
    const dt = Math.max(1e-3, (tMs - this.tPrev) / 1000);
    this.tPrev = tMs;
    const d = (v - this.xPrev) / dt; this.xPrev = v;
    const ed = this.dx.filter(d, alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(ed);
    return this.x.filter(v, alpha(cutoff, dt));
  }
}

export class EMA {
  constructor(a = 0.5) { this.a = a; this.y = null; }
  reset() { this.y = null; }
  filter(v) { this.y = this.y === null ? v : this.a * v + (1 - this.a) * this.y; return this.y; }
}

/** 对一组 2D 关键点做平滑（每个点 x/y 各一个滤波器），缺失点不更新 */
export class PointSmoother {
  constructor(opts) { this.opts = opts; this.f = new Map(); }
  reset() { this.f.clear(); }
  smooth(key, p, t, enabled = true) {
    if (!p) return null;
    if (!enabled) return { ...p };
    let f = this.f.get(key);
    if (!f) { f = [new OneEuro(this.opts), new OneEuro(this.opts)]; this.f.set(key, f); }
    return { ...p, x: f[0].filter(p.x, t), y: f[1].filter(p.y, t) };
  }
}
