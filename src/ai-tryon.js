/**
 * AI Virtual Try-On via Kwai Kolors Gradio Space (Hugging Face).
 *
 * Official /call/tryon API is currently disabled (api_open=False).
 * Working path (same as Gradio UI queue):
 *   1) POST /upload  → Gradio file path
 *   2) POST /queue/join (fn_index=2) → event_id
 *   3) GET  /queue/data?session_hash=…  SSE → process_completed
 *
 * Images go only to Hugging Face, not to this static site's servers.
 */

const HF_BASE = "https://kwai-kolors-kolors-virtual-try-on.hf.space";
const HF_SPACE_PAGE = "https://huggingface.co/spaces/Kwai-Kolors/Kolors-Virtual-Try-On";
const FN_INDEX = 2;
const TRIGGER_ID = 26;
const PERSON_CACHE_KEY = "aiTryOn.personCache.v1";
const MAX_PERSON_CACHE = 4;
const MAX_EDGE = 1024;
const JPEG_QUALITY = 0.88;

const SAMPLE_GARMENTS = [
  { id: "white-dress", name: "白色连衣裙", src: "./assets/garments/white-dress.png" },
  { id: "dress_rose", name: "玫瑰连衣裙", src: "./assets/garments/dress_rose.png" },
  { id: "tee_white", name: "白色T恤", src: "./assets/garments/tee_white.png" },
  { id: "tee_red", name: "红色T恤", src: "./assets/garments/tee_red.png" },
  { id: "tee_navy_stripe", name: "海军条纹", src: "./assets/garments/tee_navy_stripe.png" },
  { id: "jacket_denim", name: "牛仔外套", src: "./assets/garments/jacket_denim.png" },
  { id: "tee_mint", name: "薄荷绿", src: "./assets/garments/tee_mint.png" },
];

/** @type {{ blob: Blob, url: string, name: string } | null} */
let personState = null;
/** @type {{ blob: Blob, url: string, name: string } | null} */
let garmentState = null;
let busy = false;
let abortCtrl = null;

const $ = (id) => document.getElementById(id);

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2800);
}

function setStatus(kind, text) {
  const el = $("status");
  el.className = "status " + (kind || "idle");
  el.textContent = text;
}

function updateTryButton() {
  $("btnTry").disabled = busy || !personState || !garmentState;
}

function revokeIfBlob(url) {
  if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
}

function showPreview(el, url, emptyText) {
  if (!url) {
    el.classList.add("empty");
    el.innerHTML = `<span>${emptyText || "暂无图片"}</span>`;
    return;
  }
  el.classList.remove("empty");
  el.innerHTML = "";
  const img = document.createElement("img");
  img.src = url;
  img.alt = "预览";
  el.appendChild(img);
}

/** Compress / resize image File → JPEG Blob (keeps PNG if small enough & has alpha need — we always JPEG for person). */
function fileToProcessedBlob(file, { maxEdge = MAX_EDGE, quality = JPEG_QUALITY, forceJpeg = true } = {}) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        let { width: w, height: h } = img;
        const scale = Math.min(1, maxEdge / Math.max(w, h));
        w = Math.round(w * scale);
        h = Math.round(h * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const mime = forceJpeg ? "image/jpeg" : (file.type || "image/png");
        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(url);
            if (!blob) reject(new Error("图片处理失败"));
            else resolve(blob);
          },
          mime,
          quality
        );
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取图片"));
    };
    img.src = url;
  });
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function dataURLToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

function loadPersonCache() {
  try {
    return JSON.parse(localStorage.getItem(PERSON_CACHE_KEY) || "[]");
  } catch {
    return [];
  }
}

function savePersonCache(list) {
  try {
    localStorage.setItem(PERSON_CACHE_KEY, JSON.stringify(list.slice(0, MAX_PERSON_CACHE)));
  } catch (e) {
    console.warn("localStorage full, trimming cache", e);
    try {
      localStorage.setItem(PERSON_CACHE_KEY, JSON.stringify(list.slice(0, 2)));
    } catch { /* ignore */ }
  }
}

async function cachePerson(blob) {
  const dataUrl = await blobToDataURL(blob);
  const list = loadPersonCache().filter((x) => x !== dataUrl);
  list.unshift(dataUrl);
  savePersonCache(list);
  renderPersonCache();
}

function renderPersonCache() {
  const box = $("personCache");
  const list = loadPersonCache();
  box.innerHTML = "";
  list.forEach((dataUrl, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "thumb";
    const img = document.createElement("img");
    img.src = dataUrl;
    img.alt = "缓存人物";
    wrap.appendChild(img);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.setAttribute("aria-label", "删除");
    del.textContent = "×";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      const next = loadPersonCache().filter((_, i) => i !== idx);
      savePersonCache(next);
      renderPersonCache();
    });
    wrap.appendChild(del);
    wrap.addEventListener("click", async () => {
      try {
        const blob = await dataURLToBlob(dataUrl);
        await setPerson(blob, "cached.jpg");
        box.querySelectorAll(".thumb").forEach((t) => t.classList.remove("active"));
        wrap.classList.add("active");
      } catch (err) {
        toast("无法加载缓存照片");
      }
    });
    box.appendChild(wrap);
  });
}

async function setPerson(blob, name) {
  revokeIfBlob(personState?.url);
  const url = URL.createObjectURL(blob);
  personState = { blob, url, name: name || "person.jpg" };
  showPreview($("personPreview"), url);
  updateTryButton();
}

async function setGarment(blob, name) {
  revokeIfBlob(garmentState?.url);
  const url = URL.createObjectURL(blob);
  garmentState = { blob, url, name: name || "garment.png" };
  showPreview($("garmentPreview"), url);
  updateTryButton();
}

async function onPersonFile(file) {
  if (!file) return;
  try {
    setStatus("idle", "正在处理人物照片…");
    const blob = await fileToProcessedBlob(file, { forceJpeg: true });
    await setPerson(blob, file.name.replace(/\.\w+$/, "") + ".jpg");
    await cachePerson(blob);
    setStatus("idle", "人物照片已就绪");
  } catch (e) {
    setStatus("err", "人物照片处理失败");
    toast(String(e.message || e));
  }
}

async function onGarmentFile(file) {
  if (!file) return;
  try {
    // Keep PNG when possible for transparency; still resize large files
    const forceJpeg = !/^image\/png$/i.test(file.type);
    const blob = await fileToProcessedBlob(file, { forceJpeg, quality: 0.92 });
    await setGarment(blob, file.name || "garment.png");
    document.querySelectorAll(".g-item").forEach((el) => el.classList.remove("active"));
    setStatus("idle", "服装已就绪");
  } catch (e) {
    toast(String(e.message || e));
  }
}

async function selectSampleGarment(sample, el) {
  try {
    const res = await fetch(sample.src);
    if (!res.ok) throw new Error("服装素材加载失败");
    const blob = await res.blob();
    await setGarment(blob, sample.id + ".png");
    document.querySelectorAll(".g-item").forEach((n) => n.classList.remove("active"));
    el.classList.add("active");
  } catch (e) {
    toast(String(e.message || e));
  }
}

function renderGarmentSamples() {
  const box = $("garmentSamples");
  SAMPLE_GARMENTS.forEach((g, i) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "g-item" + (i === 0 ? " active" : "");
    el.innerHTML = `<img src="${g.src}" alt="${g.name}" /><span>${g.name}</span>`;
    el.addEventListener("click", () => selectSampleGarment(g, el));
    box.appendChild(el);
  });
  // default load first sample
  selectSampleGarment(SAMPLE_GARMENTS[0], box.querySelector(".g-item"));
}

function sessionHash() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function uploadToGradio(blob, filename) {
  const fd = new FormData();
  fd.append("files", blob, filename);
  const res = await fetch(`${HF_BASE}/upload`, { method: "POST", body: fd, signal: abortCtrl?.signal });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`上传失败 (${res.status}) ${t.slice(0, 120)}`);
  }
  const data = await res.json();
  if (!Array.isArray(data) || !data[0]) throw new Error("上传返回异常");
  return data[0];
}

function fileData(path, name) {
  return {
    path,
    url: `${HF_BASE}/file=${path}`,
    orig_name: name,
    meta: { _type: "gradio.FileData" },
  };
}

/**
 * Extension-style /call/tryon (may 500 while API disabled).
 * Kept as first attempt for when Kwai re-opens the named endpoint.
 */
async function tryCallTryon(personPath, garmentPath) {
  const res = await fetch(`${HF_BASE}/call/tryon`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [{ path: personPath }, { path: garmentPath }, 0, true],
    }),
    signal: abortCtrl?.signal,
  });
  if (!res.ok) throw new Error("call/tryon " + res.status);
  const { event_id } = await res.json();
  if (!event_id) throw new Error("无 event_id");
  return listenCallSSE(`${HF_BASE}/call/tryon/${event_id}`);
}

async function listenCallSSE(url) {
  const res = await fetch(url, { signal: abortCtrl?.signal });
  if (!res.ok || !res.body) throw new Error("SSE " + res.status);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (const block of parts) {
      const lines = block.split("\n");
      let event = "message";
      let dataLine = "";
      for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) dataLine = line.slice(5).trim();
      }
      if (!dataLine) continue;
      let data;
      try { data = JSON.parse(dataLine); } catch { continue; }
      if (event === "complete") {
        const urlOut = data?.[0]?.url || data?.[0]?.path;
        if (!urlOut) throw new Error("结果为空");
        return normalizeResultUrl(typeof urlOut === "string" && urlOut.startsWith("http") ? urlOut : `${HF_BASE}/file=${urlOut}`);
      }
      if (event === "error") throw new Error("Kolors 返回错误");
    }
  }
  throw new Error("连接已结束，未收到结果");
}

/** Working path: Gradio queue (fn_index=2). Join first, then SSE. */
async function tryQueueTryon(personPath, garmentPath) {
  const hash = sessionHash();
  const payload = {
    data: [fileData(personPath, "person.jpg"), fileData(garmentPath, "garment.png"), 0, true],
    event_data: null,
    fn_index: FN_INDEX,
    trigger_id: TRIGGER_ID,
    session_hash: hash,
  };

  const joinRes = await fetch(`${HF_BASE}/queue/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: abortCtrl?.signal,
  });
  if (!joinRes.ok) throw new Error("排队失败 (" + joinRes.status + ")");
  const join = await joinRes.json();
  if (!join.event_id) throw new Error("未获得排队 ID");

  setStatus("queue", "排队中…");

  const sseUrl = `${HF_BASE}/queue/data?session_hash=${encodeURIComponent(hash)}`;
  const res = await fetch(sseUrl, { signal: abortCtrl?.signal });
  if (!res.ok || !res.body) throw new Error("无法监听队列 (" + res.status + ")");

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (const block of parts) {
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      let msg;
      try { msg = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }

      if (msg.msg === "estimation") {
        const rank = msg.rank ?? 0;
        const eta = msg.rank_eta != null ? `约 ${Math.ceil(msg.rank_eta)} 秒` : "";
        setStatus("queue", `排队中（第 ${rank + 1} 位）${eta ? " · " + eta : ""}`);
      } else if (msg.msg === "process_starts") {
        setStatus("gen", "生成中，请稍候…");
      } else if (msg.msg === "progress") {
        setStatus("gen", "生成中…");
      } else if (msg.msg === "process_completed") {
        if (!msg.success) {
          const err = msg.output?.error || msg.output?.data?.[2] || "生成失败";
          throw new Error(typeof err === "string" ? err : "生成失败");
        }
        const out = msg.output?.data?.[0];
        const info = msg.output?.data?.[2];
        if (info && info !== "Success" && typeof info === "string" && /empty|fail|error|busy/i.test(info)) {
          throw new Error(info);
        }
        if (!out) throw new Error("结果为空（繁忙请重试）");
        const resultUrl = out.url || (out.path ? `${HF_BASE}/file=${out.path}` : null);
        if (!resultUrl) throw new Error("结果为空（繁忙请重试）");
        return normalizeResultUrl(resultUrl);
      } else if (msg.msg === "unexpected_error") {
        throw new Error(msg.message || "会话错误，请重试");
      }
    }
  }
  throw new Error("连接已结束，未收到结果");
}

function normalizeResultUrl(url) {
  // Prefer main host file URLs for fewer embedding blocks
  try {
    const u = new URL(url);
    if (u.hostname.includes("kwai-kolors-kolors-virtual-try-on") && u.hostname.includes("--")) {
      const path = u.pathname + u.search;
      const m = path.match(/\/file=(.+)$/);
      if (m) return `${HF_BASE}/file=${m[1]}`;
    }
  } catch { /* keep */ }
  return url;
}

async function runTryOn() {
  if (busy || !personState || !garmentState) return;
  busy = true;
  updateTryButton();
  $("resultCard").hidden = true;
  abortCtrl = new AbortController();

  try {
    setStatus("queue", "正在上传图片到 Hugging Face…");
    const personPath = await uploadToGradio(personState.blob, personState.name || "person.jpg");
    const garmentPath = await uploadToGradio(garmentState.blob, garmentState.name || "garment.png");

    let resultUrl = null;
    // 1) Named API (extension style) — usually disabled
    try {
      setStatus("queue", "尝试 API 调用…");
      resultUrl = await tryCallTryon(personPath, garmentPath);
    } catch (e) {
      console.info("call/tryon unavailable, using queue:", e);
    }

    // 2) Queue protocol (works with api_open=False via UI queue)
    if (!resultUrl) {
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          setStatus("queue", attempt > 1 ? `重新排队（第 ${attempt} 次）…` : "排队中…");
          resultUrl = await tryQueueTryon(personPath, garmentPath);
          break;
        } catch (e) {
          lastErr = e;
          const msg = String(e.message || e);
          if (/Session not found|会话/i.test(msg) && attempt < 3) {
            await new Promise((r) => setTimeout(r, 600 * attempt));
            continue;
          }
          throw e;
        }
      }
      if (!resultUrl && lastErr) throw lastErr;
    }

    setStatus("ok", "完成");
    showResult(resultUrl);
    toast("试衣完成");
  } catch (e) {
    console.error(e);
    const msg = String(e.message || e);
    if (/abort/i.test(msg)) {
      setStatus("idle", "已取消");
    } else {
      setStatus(
        "err",
        `失败（繁忙请重试）：${msg.slice(0, 80)}。可打开官方 Space 手动试衣。`
      );
    }
  } finally {
    busy = false;
    abortCtrl = null;
    updateTryButton();
  }
}

function showResult(url) {
  const card = $("resultCard");
  card.hidden = false;
  showPreview($("resultPreview"), url);
  const a = $("btnDownload");
  a.href = url;
  a.download = "ai-tryon-" + Date.now() + ".webp";
  // Improve download on cross-origin: fetch blob
  a.onclick = async (ev) => {
    ev.preventDefault();
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const obj = URL.createObjectURL(blob);
      const tmp = document.createElement("a");
      tmp.href = obj;
      tmp.download = "ai-tryon-" + Date.now() + ".webp";
      document.body.appendChild(tmp);
      tmp.click();
      tmp.remove();
      setTimeout(() => URL.revokeObjectURL(obj), 2000);
    } catch {
      window.open(url, "_blank");
    }
  };
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function wireDrop(zone, onFile) {
  zone.addEventListener("click", () => $("garmentFile").click());
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("drag");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag");
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(f);
  });
}

function init() {
  renderPersonCache();
  renderGarmentSamples();

  $("personFile").addEventListener("change", (e) => onPersonFile(e.target.files?.[0]));
  $("personCam").addEventListener("change", (e) => onPersonFile(e.target.files?.[0]));
  $("garmentFile").addEventListener("change", (e) => onGarmentFile(e.target.files?.[0]));
  wireDrop($("garmentDrop"), onGarmentFile);

  $("btnTry").addEventListener("click", runTryOn);
  $("btnRetry").addEventListener("click", runTryOn);

  updateTryButton();
  setStatus("idle", "准备就绪 · 图片仅发往 Hugging Face");
}

init();
