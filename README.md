# 虚拟试衣 · AI / AR Web Demo

手机友好的静态站点，提供两种试衣方式：

| 入口 | 说明 |
|---|---|
| **[AI 试衣（推荐）](https://xuhxsummer.github.io/ar-tryon/ai.html)** | 上传全身照 + 服装图，调用 Hugging Face **Kwai Kolors** 生成真实试穿效果 |
| [实时贴图（旧）](https://xuhxsummer.github.io/ar-tryon/ar.html) | 摄像头 + MediaPipe 姿态/分割，服装 PNG 实时贴合身体 |

首页：https://xuhxsummer.github.io/ar-tryon/

## AI 试衣怎么用

1. 打开 [ai.html](./ai.html)，上传或拍摄**人物全身照**（最近几张会缓存在浏览器 localStorage）。
2. 选择示例服装，或拖入/上传自己的服装图（默认白色一字肩连衣裙）。
3. 点「开始试衣」，等待排队与生成。
4. 查看结果并保存图片。

### 技术说明（Kolors）

- 目标 Space：[Kwai-Kolors/Kolors-Virtual-Try-On](https://huggingface.co/spaces/Kwai-Kolors/Kolors-Virtual-Try-On)
- **图片只发往 Hugging Face**，不经过本仓库 / GitHub Pages 服务器。
- 命名 API `POST /call/tryon` 目前被 Space 关闭（`api_open=False`）。页面会先尝试该接口，失败后自动改用 Gradio 队列协议（与网页 UI 相同）：
  1. `POST /upload` 上传人像与服装，得到 Gradio 文件路径  
  2. `POST /queue/join`（`fn_index=2`，seed=`0`，randomize=`true`）  
  3. `GET /queue/data?session_hash=…` 解析 SSE，`process_completed` → 结果图 URL  
- 免费；高峰可能排队。国内访问 Hugging Face 可能需要代理。

## 本地运行

```bash
cd ar-tryon
python3 -m http.server 5177 --bind 127.0.0.1
```

打开 http://localhost:5177/ 。摄像头仅在 localhost / HTTPS 下可用。

## AR 实时贴图（简述）

详见历史实现：`ar.html` + `src/app.js` + MediaPipe Pose / Image Segmenter。服装素材在 `assets/garments/`。

## 目录

```
index.html      # 首页枢纽（突出 AI）
ai.html         # AI 试衣
ai.css / src/ai-tryon.js
ar.html         # 原 AR Demo
styles.css / src/*.js
assets/garments/
```

## 许可与致谢

- Kwai Kolors Virtual Try-On（Hugging Face Space）
- 扩展参考：[riffchord/visual-try-on](https://github.com/riffchord/visual-try-on) 的 Gradio 调用思路
