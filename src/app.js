// AR 虚拟试衣 · 主流程
import { createPose, createSegmenter, MaskBuilder, LM, MP_VERSION } from './pose.js';
import { PointSmoother } from './filters.js';
import { loadGarments, renderGarment, garmentFromFile } from './garment.js';

const $ = (id) => document.getElementById(id);
const el = {
  stage: $('stage'), view: $('view'), video: $('video'), placeholder: $('placeholder'), error: $('error'),
  btnCam: $('btnCam'), facing: $('facing'), btnCalib: $('btnCalib'), btnShot: $('btnShot'), btnReset: $('btnReset'),
  garments: $('garments'), fileInput: $('fileInput'), dropZone: $('dropZone'), uploadNote: $('uploadNote'),
  fpsPill: $('fpsPill'), modelPill: $('modelPill'), trackPill: $('trackPill'), inferMs: $('inferMs'), segState: $('segState'),
  countdown: $('countdown'), toast: $('toast'), calibInfo: $('calibInfo'), poseVariant: $('poseVariant'),
  opacity: $('opacity'), scale: $('scale'), offset: $('offset'), smoothLvl: $('smoothLvl'),
  optMirror: $('optMirror'), optSkeleton: $('optSkeleton'), optMask: $('optMask'), optSmooth: $('optSmooth'),
  optClip: $('optClip'), optArms: $('optArms'), optSleeve: $('optSleeve'), optMesh: $('optMesh'), optRemoveBg: $('optRemoveBg'),
};
const ctx = el.view.getContext('2d');
const layer = document.createElement('canvas'); // 服装离屏图层
const lctx = layer.getContext('2d');
const combo = document.createElement('canvas'), cctx = combo.getContext('2d'); // 组合遮罩
const tint = document.createElement('canvas'), tctx = tint.getContext('2d');   // 遮罩可视化

const SMOOTH_PRESETS = [{ minCutoff: 3.0, beta: 0.05, label: '弱' }, { minCutoff: 1.2, beta: 0.02, label: '中' }, { minCutoff: 0.5, beta: 0.008, label: '强' }];
const state = {
  pose: null, poseDelegate: '', seg: null, segKind: '', segOk: false, mask: new MaskBuilder(),
  stream: null, running: false, garments: [], current: null, lastVideoTime: -1, frame: 0,
  smoother: new PointSmoother(SMOOTH_PRESETS[1]), lastPose: null, lostFrames: 0,
  fps: 0, fpsT: performance.now(), fpsN: 0,
  calib: JSON.parse(localStorage.getItem('artryon.calib') || 'null'), calibrating: null,
};

/* ---------------- UI 工具 ---------------- */
function step(name, cls) { const li = document.querySelector(`[data-step="${name}"]`); if (li) li.className = cls; }
function pill(p, text, cls = '') { p.textContent = text; p.className = 'pill ' + cls; }
let toastT; function toast(msg, ms = 2400) { el.toast.textContent = msg; el.toast.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.toast.classList.remove('show'), ms); }
function showError(msg) { el.error.hidden = !msg; el.error.textContent = msg || ''; }

/* ---------------- 初始化 ---------------- */
async function init() {
  bindUI();
  try {
    step('assets', 'doing');
    state.garments = await loadGarments();
    renderPicker(); selectGarment(state.garments[0]);
    step('assets', 'done');
  } catch (e) { console.error(e); step('assets', 'fail'); showError('服装素材加载失败，请确认通过本地服务器（而不是 file://）打开页面。'); }
  await loadModels(el.poseVariant.value);
  setTimeout(() => $('loading').classList.add('hide'), 300);
  updateCalibInfo();
}

async function loadModels(variant) {
  pill(el.modelPill, '模型：加载中…', 'warn');
  try {
    step('wasm', 'doing'); step('pose', 'doing');
    state.pose?.close?.();
    const r = await createPose(variant);
    state.pose = r.task; state.poseDelegate = r.delegate;
    step('wasm', 'done'); step('pose', 'done');
  } catch (e) {
    console.error(e); step('wasm', 'fail'); step('pose', 'fail');
    pill(el.modelPill, '模型加载失败', 'err');
    showError('姿态模型加载失败：' + (e?.message || e) + '\n请检查网络能否访问 cdn.jsdelivr.net 与 storage.googleapis.com，然后刷新页面。');
    return;
  }
  if (!state.seg) {
    try {
      step('seg', 'doing');
      const s = await createSegmenter();
      state.seg = s.task; state.segKind = s.kind; state.segOk = true; step('seg', 'done');
    } catch (e) {
      console.warn('分割模型不可用，降级为仅姿态模式', e); state.segOk = false; step('seg', 'fail');
      toast('人像分割不可用，已降级为仅姿态叠加');
    }
  }
  el.segState.textContent = state.segOk ? (state.segKind === 'multiclass' ? '多类分割（衣服/皮肤/头发）' : '人像分割') : '不可用（仅姿态）';
  pill(el.modelPill, `模型：Pose ${variant} · ${state.poseDelegate}${state.segOk ? ' + 分割' : ''}`, 'ok');
}

/* ---------------- 摄像头 ---------------- */
async function startCamera() {
  showError('');
  if (!window.isSecureContext) { showError('当前页面不是安全上下文（HTTPS 或 localhost），浏览器禁止访问摄像头。\n请使用 http://localhost:5177 打开，或部署到 HTTPS。'); return; }
  if (!navigator.mediaDevices?.getUserMedia) { showError('此浏览器不支持 getUserMedia，请使用最新版 Chrome / Edge / Safari。'); return; }
  const want = el.facing.value;
  const tries = [
    { video: { facingMode: { ideal: want }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
    { video: { facingMode: want === 'environment' ? 'user' : 'environment' }, audio: false },
    { video: true, audio: false },
  ];
  let lastErr;
  for (const c of tries) {
    try { state.stream = await navigator.mediaDevices.getUserMedia(c); break; } catch (e) { lastErr = e; if (e.name === 'NotAllowedError' || e.name === 'SecurityError') break; }
  }
  if (!state.stream) { showError(cameraErrorText(lastErr)); return; }
  const track = state.stream.getVideoTracks()[0];
  const facing = track.getSettings?.().facingMode;
  // 前置摄像头默认镜像，后置不镜像（用户可再手动切换）
  el.optMirror.checked = facing ? facing === 'user' : true; applyMirror();
  el.video.srcObject = state.stream;
  await el.video.play();
  state.running = true; state.lastVideoTime = -1; state.smoother.reset();
  el.placeholder.style.display = 'none';
  el.btnCam.textContent = '关闭摄像头'; el.btnCam.className = 'btn danger';
  el.btnCalib.disabled = false; el.btnShot.disabled = false;
  toast(`摄像头已开启：${track.label || '默认设备'}`);
  requestAnimationFrame(loop);
}
function stopCamera() {
  state.running = false;
  state.stream?.getTracks().forEach((t) => t.stop()); state.stream = null;
  el.video.srcObject = null;
  ctx.clearRect(0, 0, el.view.width, el.view.height);
  el.placeholder.style.display = '';
  el.btnCam.textContent = '开启摄像头'; el.btnCam.className = 'btn primary';
  el.btnCalib.disabled = true; el.btnShot.disabled = true;
  pill(el.trackPill, '未检测到人体'); pill(el.fpsPill, 'FPS --');
}
function cameraErrorText(e) {
  const n = e?.name || '';
  if (n === 'NotAllowedError' || n === 'SecurityError') return '摄像头权限被拒绝。\n请点击地址栏左侧的🔒/摄像头图标 → 允许使用摄像头，然后重新点击「开启摄像头」。\n（macOS 还需在 系统设置 → 隐私与安全性 → 摄像头 中允许浏览器）';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return '未找到可用摄像头。请确认设备已连接，或切换「前置/后置」后重试。';
  if (n === 'NotReadableError' || n === 'AbortError') return '摄像头被其他程序占用（如会议软件）。请关闭占用摄像头的应用后重试。';
  return '无法打开摄像头：' + (e?.message || n || '未知错误');
}

/* ---------------- 主循环 ---------------- */
function loop() {
  if (!state.running) return;
  requestAnimationFrame(loop);
  const v = el.video;
  if (v.readyState < 2 || v.currentTime === state.lastVideoTime) return;
  state.lastVideoTime = v.currentTime;
  const W = v.videoWidth, H = v.videoHeight;
  if (el.view.width !== W || el.view.height !== H) { el.view.width = layer.width = W; el.view.height = layer.height = H; }
  const now = performance.now();

  let lms = null;
  const t0 = performance.now();
  if (state.pose) {
    try { const res = state.pose.detectForVideo(v, now); lms = res.landmarks?.[0] || null; } catch (e) { console.warn(e); }
  }
  // 分割：每 2 帧一次，降低开销
  if (state.segOk && (el.optClip.checked || el.optMask.checked) && state.frame % 2 === 0) {
    try { const r = state.seg.segmentForVideo(v, now); state.mask.update(r, state.segKind); r.close?.(); }
    catch (e) { console.warn('分割失败，降级', e); state.segOk = false; el.segState.textContent = '运行出错，已降级为仅姿态'; toast('人像分割出错，已降级为仅姿态叠加'); }
  }
  el.inferMs.textContent = (performance.now() - t0).toFixed(1) + ' ms';
  state.frame++;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(v, 0, 0, W, H);

  const kp = lms ? extract(lms, W, H, now) : null;
  if (kp) { state.lastPose = kp; state.lostFrames = 0; }
  else if (++state.lostFrames > 8) state.lastPose = null; // 短暂丢失时保持上一帧，避免闪烁
  const P = state.lastPose;

  if (P && state.current) {
    drawGarment(P, W, H);
    pill(el.trackPill, P.estimatedHips ? '已跟踪（髋部估算）' : '已跟踪', P.estimatedHips ? 'warn' : 'ok');
  } else pill(el.trackPill, lms ? '请露出双肩' : '未检测到人体', 'warn');

  if (el.optMask.checked && state.mask.valid) drawMaskOverlay(W, H);
  if (el.optSkeleton.checked && lms) drawSkeleton(lms, W, H, P);
  if (state.calibrating) calibTick(P);

  state.fpsN++;
  if (now - state.fpsT > 500) { state.fps = state.fpsN * 1000 / (now - state.fpsT); state.fpsN = 0; state.fpsT = now; pill(el.fpsPill, `FPS ${state.fps.toFixed(0)}`, state.fps > 20 ? 'ok' : state.fps > 12 ? 'warn' : 'err'); }
}

/** 取关键点（像素坐标）+ 平滑 + 估算缺失的髋部 */
function extract(lms, W, H, t) {
  const on = el.optSmooth.checked;
  const get = (i, minVis = 0.5) => { const l = lms[i]; return l && (l.visibility ?? 1) >= minVis ? { x: l.x * W, y: l.y * H, v: l.visibility ?? 1 } : null; };
  const sm = (k, p) => state.smoother.smooth(k, p, t, on);
  const rs = sm('rs', get(LM.R_SH, 0.4)), ls = sm('ls', get(LM.L_SH, 0.4));
  if (!rs || !ls) return null;
  const re = sm('re', get(LM.R_EL)), le = sm('le', get(LM.L_EL));
  const rw = sm('rw', get(LM.R_WR)), lw = sm('lw', get(LM.L_WR));
  let rh = get(LM.R_HIP), lh = get(LM.L_HIP), estimatedHips = false;
  const sw = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  if (!rh || !lh || rh.y > H * 1.15) {
    // 髋部不可见：沿肩线法线向下估算（使用校准比例）
    const ratio = state.calib?.torsoRatio ?? 1.35, hipW = state.calib?.hipRatio ?? 0.78;
    const mx = (rs.x + ls.x) / 2, my = (rs.y + ls.y) / 2;
    const ux = (ls.x - rs.x) / sw, uy = (ls.y - rs.y) / sw; // 肩线方向
    let nx = -uy, ny = ux; if (ny < 0) { nx = -nx; ny = -ny; }
    const L = sw * ratio, hx = mx + nx * L, hy = my + ny * L;
    rh = { x: hx - ux * sw * hipW / 2, y: hy - uy * sw * hipW / 2 };
    lh = { x: hx + ux * sw * hipW / 2, y: hy + uy * sw * hipW / 2 };
    estimatedHips = true;
  }
  rh = sm('rh', rh); lh = sm('lh', lh);
  return { rs, ls, re, le, rw, lw, rh, lh, sw, estimatedHips };
}

function drawGarment(P, W, H) {
  const g = state.current;
  // 未镜像的画面中，人物右肩（landmark 12）位于画面左侧 → 对应模板左肩
  let dst = { tl: P.rs, tr: P.ls, bl: P.rh, br: P.lh, elbowL: P.re, elbowR: P.le };
  // 微调：缩放（以肩中点为中心）+ 上下偏移（按肩宽比例）
  const s = +el.scale.value, off = +el.offset.value * P.sw;
  const c = { x: (P.rs.x + P.ls.x) / 2, y: (P.rs.y + P.ls.y) / 2 };
  const tf = (p) => p && ({ x: c.x + (p.x - c.x) * s, y: c.y + (p.y - c.y) * s + off });
  dst = { tl: tf(dst.tl), tr: tf(dst.tr), bl: tf(dst.bl), br: tf(dst.br), elbowL: tf(dst.elbowL), elbowR: tf(dst.elbowR) };

  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.globalCompositeOperation = 'source-over';
  lctx.clearRect(0, 0, W, H);
  renderGarment(lctx, g, dst, { sleeveFollow: el.optSleeve.checked && g.sleeveFollow !== false, debugMesh: el.optMesh.checked });

  // 1) 人像遮罩：服装只保留在人体区域；连衣裙髋线以下（裙摆可外扩）不裁剪
  if (el.optClip.checked && state.segOk && state.mask.valid) {
    if (combo.width !== W || combo.height !== H) { combo.width = W; combo.height = H; }
    cctx.setTransform(1, 0, 0, 1, 0, 0); cctx.clearRect(0, 0, W, H);
    cctx.filter = 'blur(2px)'; cctx.drawImage(state.mask.canvas, 0, 0, W, H); cctx.filter = 'none';
    if (g.category === 'dress') {
      const hipY = (dst.bl.y + dst.br.y) / 2;
      const grd = cctx.createLinearGradient(0, hipY - P.sw * 0.15, 0, hipY + P.sw * 0.1);
      grd.addColorStop(0, 'rgba(255,255,255,0)'); grd.addColorStop(1, '#fff');
      cctx.fillStyle = grd; cctx.fillRect(0, hipY - P.sw * 0.15, W, H);
    }
    lctx.save(); lctx.globalCompositeOperation = 'destination-in'; lctx.drawImage(combo, 0, 0); lctx.restore();
  }
  // 2) 手臂遮挡：前臂位于躯干前方时，从服装上擦除前臂（避免衣服盖住交叉/抬起的手）
  if (el.optArms.checked) {
    lctx.save(); lctx.globalCompositeOperation = 'destination-out'; lctx.lineCap = 'round';
    lctx.lineWidth = P.sw * 0.22; lctx.strokeStyle = '#000';
    for (const [e, w] of [[P.re, P.rw], [P.le, P.lw]]) {
      if (!e || !w) continue;
      if (!insideQuad(w, dst) && !insideQuad(midp(e, w), dst)) continue;
      lctx.beginPath(); lctx.moveTo(e.x, e.y); lctx.lineTo(w.x, w.y); lctx.stroke();
    }
    lctx.restore();
  }
  ctx.save(); ctx.globalAlpha = +el.opacity.value; ctx.drawImage(layer, 0, 0); ctx.restore();
}
const midp = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
function insideQuad(p, q) {
  const pts = [q.tl, q.tr, q.br, q.bl]; let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) { const a = pts[i], b = pts[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside; }
  return inside;
}

function drawMaskOverlay(W, H) {
  // 在离屏画布上把遮罩染成青色，再半透明叠加
  if (tint.width !== W || tint.height !== H) { tint.width = W; tint.height = H; }
  tctx.globalCompositeOperation = 'source-over'; tctx.clearRect(0, 0, W, H);
  tctx.drawImage(state.mask.canvas, 0, 0, W, H);
  tctx.globalCompositeOperation = 'source-in'; tctx.fillStyle = '#22d3ee'; tctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.globalAlpha = 0.4; ctx.drawImage(tint, 0, 0); ctx.restore();
}

const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28]];
function drawSkeleton(lms, W, H, P) {
  ctx.save(); ctx.lineWidth = Math.max(2, W / 400); ctx.strokeStyle = 'rgba(124,92,255,.9)';
  for (const [a, b] of BONES) { const A = lms[a], B = lms[b]; if ((A.visibility ?? 1) < 0.4 || (B.visibility ?? 1) < 0.4) continue; ctx.beginPath(); ctx.moveTo(A.x * W, A.y * H); ctx.lineTo(B.x * W, B.y * H); ctx.stroke(); }
  for (const l of lms.slice(11, 29)) { if ((l.visibility ?? 1) < 0.4) continue; ctx.fillStyle = '#22d3ee'; ctx.beginPath(); ctx.arc(l.x * W, l.y * H, Math.max(3, W / 250), 0, 7); ctx.fill(); }
  if (P) { ctx.fillStyle = '#fbbf24'; for (const p of [P.rs, P.ls, P.rh, P.lh]) { ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(4, W / 180), 0, 7); ctx.fill(); } }
  ctx.restore();
}

/* ---------------- 校准 ---------------- */
function startCalibration() {
  if (!state.running) return;
  state.calibrating = { t0: performance.now(), samples: [] };
  toast('请正对摄像头，双臂微微张开（T 字姿势），保持不动');
}
function calibTick(P) {
  const c = state.calibrating, el_ = el.countdown, dt = performance.now() - c.t0;
  el_.style.display = 'flex';
  if (dt < 3000) { el_.innerHTML = `${Math.ceil((3000 - dt) / 1000)}<small>请摆出 T 字姿势</small>`; return; }
  el_.innerHTML = `采集中<small>${c.samples.length}/30</small>`;
  if (P && !P.estimatedHips) {
    const hm = midp(P.rh, P.lh), sm = midp(P.rs, P.ls);
    c.samples.push({ sw: P.sw, torso: Math.hypot(hm.x - sm.x, hm.y - sm.y), hw: Math.hypot(P.lh.x - P.rh.x, P.lh.y - P.rh.y) });
  }
  if (c.samples.length >= 30 || dt > 9000) {
    el_.style.display = 'none'; state.calibrating = null;
    if (c.samples.length < 10) { toast('校准失败：请确保双肩和髋部都在画面中，再试一次', 3500); return; }
    const med = (k) => c.samples.map((s) => s[k]).sort((a, b) => a - b)[c.samples.length >> 1];
    const sw = med('sw'), torso = med('torso'), hw = med('hw');
    state.calib = { shoulderPx: sw, torsoRatio: torso / sw, hipRatio: Math.min(1.1, Math.max(0.55, hw / sw)), at: Date.now() };
    localStorage.setItem('artryon.calib', JSON.stringify(state.calib));
    updateCalibInfo(); toast('✅ 校准完成');
  }
}
function updateCalibInfo() {
  const c = state.calib;
  el.calibInfo.textContent = c ? `已校准：肩宽 ${c.shoulderPx.toFixed(0)}px · 躯干/肩宽 ${c.torsoRatio.toFixed(2)} · 髋/肩 ${c.hipRatio.toFixed(2)}（髋部出画时用于估算）` : '未校准：使用默认身体比例（躯干/肩宽 1.35）。';
}

/* ---------------- 服装选择 / 上传 ---------------- */
function renderPicker() {
  el.garments.innerHTML = '';
  for (const g of state.garments) {
    const b = document.createElement('button');
    b.className = 'g-item' + (state.current === g ? ' active' : ''); b.title = g.name;
    b.innerHTML = `<img alt="" src="${g.thumb || g.img.src}"><span>${g.name}</span>${g.uploaded ? '<i class="tag">上传</i>' : ''}`;
    b.onclick = () => selectGarment(g);
    el.garments.appendChild(b);
  }
}
function selectGarment(g) {
  state.current = g;
  [...el.garments.children].forEach((n, i) => n.classList.toggle('active', state.garments[i] === g));
  el.optSleeve.disabled = g.sleeveFollow === false;
}
async function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) { toast('请拖入图片文件（PNG / JPG / WebP）'); return; }
  try {
    toast('正在处理图片…');
    const g = await garmentFromFile(file, { removeBg: el.optRemoveBg.checked });
    state.garments.unshift(g); renderPicker(); selectGarment(g);
    el.uploadNote.textContent = `「${g.name}」${g.note}；自动识别为${g.category === 'dress' ? '连衣裙' : '上衣'}。可用缩放/偏移微调。`;
    toast('已换上：' + g.name);
  } catch (e) { console.error(e); toast('图片处理失败：' + (e?.message || e), 3500); }
}

/* ---------------- 事件绑定 ---------------- */
function applyMirror() { el.stage.classList.toggle('mirror', el.optMirror.checked); }
function bindUI() {
  el.btnCam.onclick = () => (state.running ? stopCamera() : startCamera());
  el.facing.onchange = () => { if (state.running) { stopCamera(); startCamera(); } };
  el.btnCalib.onclick = startCalibration;
  el.btnShot.onclick = () => { const a = document.createElement('a'); a.download = `tryon-${Date.now()}.png`;
    if (el.optMirror.checked) { const c = document.createElement('canvas'); c.width = el.view.width; c.height = el.view.height; const x = c.getContext('2d'); x.scale(-1, 1); x.drawImage(el.view, -c.width, 0); a.href = c.toDataURL(); } else a.href = el.view.toDataURL();
    a.click(); };
  el.optMirror.onchange = applyMirror;
  el.optSmooth.onchange = () => state.smoother.reset();
  const fmt = () => {
    $('opacityVal').textContent = Math.round(el.opacity.value * 100) + '%';
    $('scaleVal').textContent = (+el.scale.value).toFixed(2) + '×';
    $('offsetVal').textContent = (+el.offset.value > 0 ? '+' : '') + Math.round(el.offset.value * 100);
    const p = SMOOTH_PRESETS[+el.smoothLvl.value]; $('smoothVal').textContent = p.label;
  };
  [el.opacity, el.scale, el.offset].forEach((r) => (r.oninput = fmt));
  el.smoothLvl.oninput = () => { fmt(); state.smoother = new PointSmoother(SMOOTH_PRESETS[+el.smoothLvl.value]); };
  el.btnReset.onclick = () => { el.opacity.value = 0.95; el.scale.value = 1; el.offset.value = 0; fmt(); };
  el.poseVariant.onchange = async () => { $('loading').classList.remove('hide'); await loadModels(el.poseVariant.value); $('loading').classList.add('hide'); };
  // 上传：点击 + 拖拽（整个画面都可放置）
  el.dropZone.onclick = () => el.fileInput.click();
  el.fileInput.onchange = () => { handleFile(el.fileInput.files[0]); el.fileInput.value = ''; };
  let depth = 0;
  el.stage.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; el.stage.classList.add('dragging'); });
  el.stage.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  el.stage.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; el.stage.classList.remove('dragging'); } });
  el.stage.addEventListener('drop', (e) => { e.preventDefault(); depth = 0; el.stage.classList.remove('dragging'); handleFile(e.dataTransfer.files[0]); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  // 粘贴图片也可换装
  window.addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])][0]; if (f) handleFile(f); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.running) state.lastVideoTime = -1; });
  fmt(); applyMirror();
  console.info('MediaPipe tasks-vision', MP_VERSION);
}

init();
