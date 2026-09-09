#!/usr/bin/env node
// 兑换码生成 / 管理工具
// 用法：
//   node gen-codes.js                列出所有兑换码及用量
//   node gen-codes.js 10 2           生成 10 个码，每个可用 2 次
//   node gen-codes.js 5 10 "VIP"     生成 5 个码，每个可用 10 次，备注 VIP
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const CODES_FILE = path.join(DATA_DIR, 'codes.json');

// 去掉易混淆字符 I / O / 0 / 1
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function loadCodes() {
  try {
    if (!fs.existsSync(CODES_FILE)) return {};
    return JSON.parse(fs.readFileSync(CODES_FILE, 'utf8')).codes || {};
  } catch (e) {
    console.error('读取 codes.json 失败:', e.message);
    return {};
  }
}

function saveCodes(codes) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CODES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ codes }, null, 2));
  fs.renameSync(tmp, CODES_FILE);
}

function genOne() {
  const part = () => {
    const bytes = randomBytes(4);
    let s = '';
    for (let i = 0; i < 4; i++) s += CHARSET[bytes[i] % CHARSET.length];
    return s;
  };
  return `${part()}-${part()}-${part()}`;
}

function generate(count, uses, note) {
  const codes = loadCodes();
  const created = [];
  for (let i = 0; i < count; i++) {
    let code;
    do { code = genOne(); } while (codes[code]);
    codes[code] = { total: uses, used: 0, createdAt: new Date().toISOString(), note: note || '' };
    created.push(code);
  }
  saveCodes(codes);
  return created;
}

function list() {
  const codes = loadCodes();
  const entries = Object.entries(codes);
  if (!entries.length) { console.log('（暂无兑换码）'); return; }
  entries.sort((a, b) => (a[1].createdAt || '').localeCompare(b[1].createdAt || ''));
  console.log(`兑换码列表（共 ${entries.length} 个）：`);
  for (const [code, info] of entries) {
    const remaining = (info.total || 0) - (info.used || 0);
    console.log(`  ${code}  已用 ${info.used}/${info.total}  剩 ${remaining}  ${info.note || ''}`);
  }
}

const args = process.argv.slice(2);
if (args.length === 0) {
  list();
} else {
  const count = parseInt(args[0], 10);
  const uses = args[1] ? parseInt(args[1], 10) : 2;
  const note = args.slice(2).join(' ');
  if (!Number.isFinite(count) || count <= 0) {
    console.error('数量需为正整数。用法：node gen-codes.js <数量> <每码次数=2> [备注]');
    process.exit(1);
  }
  if (!Number.isFinite(uses) || uses <= 0) {
    console.error('次数需为正整数。');
    process.exit(1);
  }
  const created = generate(count, uses, note);
  console.log(`已生成 ${created.length} 个兑换码（每个 ${uses} 次）：`);
  created.forEach((c) => console.log('  ' + c));
}
