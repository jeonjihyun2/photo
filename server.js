import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

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

// ===== 兑换码（额度）系统 =====
const DATA_DIR = path.join(__dirname, 'data');
const CODES_FILE = path.join(DATA_DIR, 'codes.json');

// 兑换码存储：优先用文件（本地 / Render 有持久磁盘）；Vercel 等 serverless 环境文件系统只读、
// 冷启动会重置，此时自动降级为「内存 + 环境变量种子码」。扣次在 serverless 下仅本次实例生命周期内有效。
let MEM_CODES = null;

function buildSeedCodes() {
  const seed = (process.env.MUGUA_SEED_CODES || '').trim();
  const codes = {};
  if (!seed) return codes;
  seed.split(',').forEach((item) => {
    const eq = item.indexOf('=');
    if (eq <= 0) return;
    const code = normCode(item.slice(0, eq));
    const total = parseInt(item.slice(eq + 1), 10);
    if (code && total > 0) {
      codes[code] = { total, used: 0, createdAt: new Date().toISOString(), note: 'seed' };
    }
  });
  return codes;
}

function loadCodes() {
  if (MEM_CODES) return MEM_CODES;
  try {
    if (fs.existsSync(CODES_FILE)) {
      return JSON.parse(fs.readFileSync(CODES_FILE, 'utf8')).codes || {};
    }
  } catch (e) {
    console.log('[codes] 文件读取失败:', e.message);
  }
  MEM_CODES = buildSeedCodes();
  if (Object.keys(MEM_CODES).length) {
    console.log(`[codes] 无码文件，已从 MUGUA_SEED_CODES 初始化 ${Object.keys(MEM_CODES).length} 个码（内存态）`);
  }
  return MEM_CODES;
}

function saveCodes(codes) {
  MEM_CODES = codes; // 总是同步内存态
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = CODES_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ codes }, null, 2));
    fs.renameSync(tmp, CODES_FILE);
  } catch (e) {
    // serverless 只读文件系统：写失败则仅保留内存态（重启/冷启动后扣次重置）
    console.log('[codes] 文件写入失败（已改用内存态）:', e.message);
  }
}
function normCode(c) { return (c || '').trim().toUpperCase(); }
// 校验兑换码：返回 { code, ok, error?, total, used, remaining }
function checkCode(code) {
  const c = normCode(code);
  if (!c) return { code: c, ok: false, error: '请输入兑换码。' };
  const codes = loadCodes();
  const info = codes[c];
  if (!info) return { code: c, ok: false, error: '兑换码不存在，请核对后重试。' };
  const remaining = (info.total || 0) - (info.used || 0);
  if (remaining <= 0) {
    return { code: c, ok: false, error: '兑换码额度已用完，请购买新的兑换码。', total: info.total, used: info.used, remaining: 0 };
  }
  return { code: c, ok: true, total: info.total, used: info.used || 0, remaining };
}
// 成功生成一次后扣减，返回剩余次数
function consumeCode(code) {
  const c = normCode(code);
  const codes = loadCodes();
  const info = codes[c];
  if (!info) return null;
  info.used = (info.used || 0) + 1;
  saveCodes(codes);
  return (info.total || 0) - (info.used || 0);
}

const NO_BASE = '接口地址无效。请在右上角「API 设置」填写木瓜 API 的完整网址（带 https:// 和域名），例如 https://api.mooko.ai，不要只填 /v1。';
const NO_KEY = '请填写 API Key（在木瓜后台「令牌」里新建）。';

// 查询 / 激活兑换码
app.post('/api/redeem', (req, res) => {
  const r = checkCode(req.body && req.body.code);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, code: r.code, total: r.total, used: r.used, remaining: r.remaining });
});

// 图生图 / 编辑 —— 走 /images/edits（multipart）
app.post('/api/edit', upload.single('image'), async (req, res) => {
  try {
    const gate = checkCode(req.body.code);
    if (!gate.ok) return res.status(403).json({ error: gate.error });
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
    const remaining = consumeCode(req.body.code);
    res.json({ ...data, remaining });
  } catch (e) {
    console.log('[edit] 异常:', e.message);
    const msg = e.name === 'AbortError' ? '请求超时（生成时间过长），请降低画质或换小图重试。' : ('服务异常：' + e.message);
    res.status(500).json({ error: msg });
  }
});

// 文生图 —— 走 /images/generations（JSON）
app.post('/api/generate', async (req, res) => {
  try {
    const gate = checkCode(req.body.code);
    if (!gate.ok) return res.status(403).json({ error: gate.error });
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
    const remaining = consumeCode(req.body.code);
    res.json({ ...data, remaining });
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
