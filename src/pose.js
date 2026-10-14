// MediaPipe 加载与推理封装（姿态 + 人像分割）
export const MP_VERSION = '0.10.14';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODELS = {
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
  heavy: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task',
  multiclass: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
  selfie: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
};
export const LM = { NOSE: 0, L_SH: 11, R_SH: 12, L_EL: 13, R_EL: 14, L_WR: 15, R_WR: 16, L_HIP: 23, R_HIP: 24 };

let vision = null, mp = null;
async function loadVision() {
  if (!mp) mp = await import(`${CDN}/vision_bundle.mjs`);
  if (!vision) vision = await mp.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
  return mp;
}

async function withDelegate(fn) {
  try { return { task: await fn('GPU'), delegate: 'GPU' }; }
  catch (e) { console.warn('GPU 失败，回退 CPU', e); return { task: await fn('CPU'), delegate: 'CPU' }; }
}

export async function createPose(variant = 'full') {
  const { PoseLandmarker } = await loadVision();
  return withDelegate((delegate) => PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODELS[variant], delegate },
    runningMode: 'VIDEO', numPoses: 1,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  }));
}

/** 优先多类分割（可区分头发/脸/身体皮肤/衣服），失败则回退普通人像分割 */
export async function createSegmenter() {
  const { ImageSegmenter } = await loadVision();
  try {
    const r = await withDelegate((delegate) => ImageSegmenter.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODELS.multiclass, delegate },
      runningMode: 'VIDEO', outputCategoryMask: true, outputConfidenceMasks: false,
    }));
    return { ...r, kind: 'multiclass' };
  } catch (e) {
    console.warn('多类分割失败，回退 selfie', e);
    const r = await withDelegate((delegate) => ImageSegmenter.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODELS.selfie, delegate },
      runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true,
    }));
    return { ...r, kind: 'selfie' };
  }
}

/**
 * 把分割结果写入一个小尺寸 canvas 的 alpha 通道（白=允许绘制服装）。
 * multiclass 类别：0 背景 1 头发 2 身体皮肤 3 脸部皮肤 4 衣服 5 其他(配饰)
 */
export class MaskBuilder {
  constructor() { this.canvas = document.createElement('canvas'); this.ctx = this.canvas.getContext('2d', { willReadFrequently: false }); this.img = null; this.valid = false; }
  update(result, kind) {
    const m = kind === 'multiclass' ? result.categoryMask : result.confidenceMasks?.[0];
    if (!m) { this.valid = false; return; }
    const w = m.width, h = m.height;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; this.img = this.ctx.createImageData(w, h); }
    const px = this.img.data;
    if (kind === 'multiclass') {
      const a = m.getAsUint8Array();
      for (let i = 0, j = 0; i < a.length; i++, j += 4) {
        const c = a[i]; const ok = c === 2 || c === 4 || c === 5;
        px[j] = px[j + 1] = px[j + 2] = 255; px[j + 3] = ok ? 255 : 0;
      }
    } else {
      const a = m.getAsFloat32Array();
      for (let i = 0, j = 0; i < a.length; i++, j += 4) { px[j] = px[j + 1] = px[j + 2] = 255; px[j + 3] = Math.min(255, Math.max(0, (a[i] - 0.3) * 600)); }
    }
    this.ctx.putImageData(this.img, 0, 0);
    this.valid = true;
  }
}
