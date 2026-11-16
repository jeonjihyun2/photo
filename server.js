import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json({ limit: '40mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 让用户填 "host.com" 或 "https://host.com/v1" 都能正确拼出 /v1/images/...
// 如果填的是无效地址（比如只填了 /v1），返回空字符串由调用方提示。
function normalizeBaseUrl(u) {
  let base = (u || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  let p;
  try { p = new URL(base); } catch { return ''; }
  const host = p.hostname || '';
  // 真实域名必须含 "."（或 localhost）；否则如 "/v1" 会被误解析成 hostname="v1"，视为无效
  if (!host.includes('.') && host !== 'localhost') return '';
  if (/\/v\d+$/.test(base)) return base;
  return `${base}/v1`;
}

// 前端可选模型白名单：只允许这几个生图模型名，防止注入高价/任意模型刷额度。
const ALLOWED_MODELS = new Set([
  'gpt-image-2',
  'gpt-image-2-pro',
  'gpt-image-2-max',
  'gpt-image-2-plus',
  'gpt-image-2-plus-high',
  'gpt-image-2-plus-low',
  'gpt-image-2-plus-medium',
]);

function getConfig(body) {
  // 安全加固：baseUrl / apiKey 只从服务器 .env 读取，忽略前端注入。
  // model 允许前端在“白名单”内选择（用于“不同功能不同档次模型”），否则回退 .env 默认。
  const envModel = (process.env.MUGUA_MODEL || 'gpt-image-2').trim();
  const reqModel = ((body && body.model) || '').trim();
  const model = (reqModel && ALLOWED_MODELS.has(reqModel)) ? reqModel : envModel;
  return {
    baseUrl: normalizeBaseUrl(process.env.MUGUA_BASE_URL || ''),
    apiKey: (process.env.MUGUA_API_KEY || '').trim(),
    model,
  };
}

function extractError(data) {
  if (!data) return '未知错误';
  if (typeof data.error === 'string') return data.error;
  if (data.error && data.error.message) return data.error.message;
  if (data.message) return data.message;
  return JSON.stringify(data).slice(0, 300);
}

// 带超时的 fetch（mooko 生图可能较慢，给 180 秒）
function fetchWithTimeout(url, options, ms = 180000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

const NO_BASE = '生图服务暂不可用（服务器未配置接口地址），请稍后再试或联系管理员。';
const NO_KEY = '生图服务暂不可用（服务器未配置密钥），请稍后再试或联系管理员。';

// 图生图 / 编辑 —— 走 /images/edits（multipart）
app.post('/api/edit', upload.single('image'), async (req, res) => {
  try {
    const { baseUrl, apiKey, model } = getConfig(req.body);
    if (!baseUrl) return res.status(400).json({ error: NO_BASE });
    if (!apiKey) return res.status(400).json({ error: NO_KEY });
    if (!req.file) return res.status(400).json({ error: '请先上传一张图片。' });
    const prompt = (req.body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: '请填写修改描述（想怎么改）。' });

    console.log(`[edit] model=${model} size=${req.body.size || '-'} img=${(req.file.size / 1024 / 1024).toFixed(2)}MB`);

    const fd = new FormData();
    fd.append('model', model);
    fd.append('prompt', prompt);
    fd.append('response_format', 'b64_json');
    if (req.body.size) fd.append('size', req.body.size);
    if (req.body.quality) fd.append('quality', req.body.quality);
    if (req.body.output_format) fd.append('output_format', req.body.output_format);
    fd.append('image', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname || 'image.png');

    const r = await fetchWithTimeout(`${baseUrl}/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    });

    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }

    if (!r.ok) {
      console.log(`[edit] 上游错误 ${r.status}: ${text.slice(0, 200)}`);
      return res.status(r.status).json({ error: extractError(data) || `上游返回 ${r.status}` });
    }
    res.json(data);
  } catch (e) {
    console.log('[edit] 异常:', e.message);
    const msg = e.name === 'AbortError' ? '请求超时（生成时间过长），请降低画质或换小图重试。' : ('服务异常：' + e.message);
    res.status(500).json({ error: msg });
  }
});

// 文生图 —— 走 /images/generations（JSON）
app.post('/api/generate', async (req, res) => {
  try {
    const { baseUrl, apiKey, model } = getConfig(req.body);
    if (!baseUrl) return res.status(400).json({ error: NO_BASE });
    if (!apiKey) return res.status(400).json({ error: NO_KEY });
    const prompt = (req.body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: '请填写图片描述。' });

    console.log(`[generate] model=${model} size=${req.body.size || '-'}`);

    const r = await fetchWithTimeout(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size: req.body.size || '1024x1024',
        quality: req.body.quality || undefined,
        response_format: 'b64_json',
      }),
    });

    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }

    if (!r.ok) {
      console.log(`[generate] 上游错误 ${r.status}: ${text.slice(0, 200)}`);
      return res.status(r.status).json({ error: extractError(data) || `上游返回 ${r.status}` });
    }
    res.json(data);
  } catch (e) {
    console.log('[generate] 异常:', e.message);
    const msg = e.name === 'AbortError' ? '请求超时（生成时间过长），请降低画质或换小图重试。' : ('服务异常：' + e.message);
    res.status(500).json({ error: msg });
  }
});

// multer / 其他错误统一处理：保证始终返回 JSON，避免前端拿到空响应
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: '图片太大（超过 25MB），请压缩或换一张再上传。' });
    }
    return res.status(400).json({ error: '上传失败：' + err.message });
  }
  console.log('[error]', err && err.message);
  res.status(500).json({ error: (err && err.message) || '服务器错误' });
});

// 导出 app，供 Vercel serverless 函数（api/index.js）使用
export default app;

// 本地直接运行（node server.js）或 Render 部署时监听端口。
// Vercel 通过 api/index.js 导入此模块，不走这里（Vercel 自己会用 serverless 包装）。
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mugua Image Editor running at http://0.0.0.0:${PORT}`);
});
