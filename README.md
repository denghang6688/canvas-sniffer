# 素材嗅探助手 · AI Studio v2.0

Chrome 扩展（Manifest V3）：**预览优先**地嗅探网页图片 / 视频 / 文字，支持大图与播放预览、单文件直接导入画布或下载、低分辨率过滤、深挖原图、加密 HLS 合并、AI 自动分类。

---

## 一、更新源（可直接升级新版本）

| 渠道 | 地址 |
|---|---|
| GitHub 仓库 | https://github.com/denghang6688/canvas-sniffer |
| GitHub 最新版 | https://github.com/denghang6688/canvas-sniffer/releases/latest |
| 魔搭社区 | https://www.modelscope.cn/models/hans186/canvas-sniffer |

- 插件设置页有 **「检查更新」**：读取 `update.json` 比对版本号，有新版一键跳转下载页。
- 发布新版本的流程：
  1. 改 `manifest.json` 的 `version` 与 `update.json` 的 `version` / `notes`
  2. 推送到 GitHub 并打 tag 发 Release（zip 作为附件）
  3. 同步推送到魔搭，并把新版 zip 上传到仓库根目录
- `update.json` 同时挂在两个源上，任一可用即可完成更新检查。

## 二、安装

1. `chrome://extensions/` → 打开 **开发者模式**
2. **加载已解压的扩展程序**，选择本目录 `canvas-sniffer`
3. 首次使用点插件里的 **⚙** 检查设置：画布地址默认 `http://127.0.0.1:2000`
4. 修改代码后，在扩展卡片点 **刷新 ⟳**

## 三、界面（v2.0 预览优先）

- 打开插件即以 **两列预览卡片网格** 展示嗅探结果，图片直接显示缩略图，MP4 显示首帧，M3U8 显示封面或类型占位
- **点卡片上的「导入画布」或「下载」**：只处理这一个文件，无需先勾选
- **点缩略图**：打开大预览层
  - 图片：大图查看
  - MP4：内嵌播放器，可直接播放
  - M3U8：显示封面、清晰度、时长与加密状态，导入/下载时在后台合并
  - 文字：全文预览
  - 预览层支持上一个 / 下一个、复制直链、单文件导入与下载
- 顶部提供搜索、排序（尺寸 / 时间 / 名称）、分类切换、三个开关：
  - **低分过滤**：长边小于阈值的图片隐藏
  - **深挖原图**：按 CDN 规则并发探测更大原图，成功标 `原图`
  - **AI 分类**：画布入库时自动分类

> 长任务（HLS 合并、上传、下载）已移到后台离屏页面执行，**关掉弹窗也不会中断**；进度会在下次打开弹窗时继续显示当前批次。

## 四、和画布怎么对接的

| 素材类型 | 接口 | 说明 |
|---|---|---|
| 图片 / MP4 直链 | `POST /api/local-assets/import-urls` | 画布服务端下载入库；`classify: true` 顺带分类 |
| HLS（m3u8） | 浏览器合并分片 → `POST /api/local-assets/upload` | 支持 AES-128 解密，输出 `.ts` |
| 文字 | `POST /api/local-assets/upload` | 每条存成一个 `.txt` |
| 连通性 | `GET /api/health` | 顶部绿条 = 已连接 |

文件夹默认用网页标题建子文件夹，可在设置里改成固定名称或不建文件夹。

## 五、v2.0 主要变化

1. **任务不再被弹窗关闭打断**：合并 / 上传 / 下载由 offscreen worker 承接，带进度回报
2. **加密 HLS**：支持 `#EXT-X-KEY:METHOD=AES-128`，按媒体序号计算 IV，自动去除 PKCS#7 填充
3. **嗅探更全**：按 content-type 识别无扩展名 CDN 图片；补 `og:video`、任意 `<source>`、data-bg 等来源；过滤 `blob:` / `data:`
4. **深挖更强**：新增 Unsplash / imgix / Cloudinary / Shopify / WordPress 等规则，并发探测替代串行
5. **预览优先界面**：卡片网格 + 大预览层 + 单文件直接操作；搜索 / 排序 / 上下张 / 复制链接
6. **安全性**：所有动态文本 HTML 转义，状态栏不再直接写入 HTML

## 六、设置项

| 项 | 默认 | 说明 |
|---|---|---|
| 画布地址 | `http://127.0.0.1:2000` | 本地 AI Studio 服务 |
| 低分辨率阈值 | 200 | 长边小于该值判定低分 |
| HLS 分片并发 | 5 | 1–16，网络好可调高 |
| 携带页面 Cookie | 开 | 登录态视频需要；公开视频可关 |
| Provider / 模型 / 分类提示词 | comfly / 空 / 空 | 交给画布的 AI 分类参数 |

## 七、已知限制

- HLS 合并输出 `.ts`（标准 MPEG-TS），VLC / PotPlayer / 剪映可直接播放；要 `.mp4` 需画布端用 ffmpeg 转一次
- 桌面 Chrome 不原生播放 m3u8，因此预览层显示封面与信息而不直接播放；实际合并由后台完成
- 非 AES-128 的加密方式（如 SAMPLE-AES / DRM）仍不支持
- `chrome://`、扩展商店、PDF 内置阅读器等受保护页面不能注入
- 需要 cookie 鉴权的直链图片/MP4，画布服务端下载可能失败，请用「下载」走浏览器登录态

## 八、文件说明

```
canvas-sniffer/
├── manifest.json     清单（含 offscreen 权限）
├── background.js     网络嗅探 + HLS 解析 + 任务调度
├── worker.js/.html   离屏后台任务：HLS 合并/解密、下载、上传
├── content.js        DOM 提取 + 深挖原图候选与并发探测
├── popup.html/css/js 预览优先界面
├── options.html/js   设置页
└── README.md
```
