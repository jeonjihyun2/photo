import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODES_FILE = path.join(__dirname, 'data', 'codes.json');
const OUT = path.join(__dirname, '兑换码清单.csv');

function loadCodes() {
  try { return JSON.parse(fs.readFileSync(CODES_FILE, 'utf8')).codes || {}; }
  catch { return {}; }
}

const codes = loadCodes();
const entries = Object.entries(codes).sort((a, b) => (a[1].createdAt || '').localeCompare(b[1].createdAt || ''));
const rows = [['序号', '兑换码', '可用次数', '已用', '剩余', '备注', '客户(待填)']];
entries.forEach(([code, info], i) => {
  const used = info.used || 0, total = info.total || 0;
  rows.push([String(i + 1), code, String(total), String(used), String(total - used), info.note || '', '']);
});

const csv = rows.map(r => r.map(c => {
  c = c || '';
  return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
}).join(',')).join('\n');

fs.writeFileSync(OUT, '\ufeff' + csv); // BOM 让 Excel/WPS 正确识别中文
console.log('已导出 ' + entries.length + ' 个兑换码到 ' + OUT);
