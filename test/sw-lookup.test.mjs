/**
 * 个人词库单元测试：直接在 vm 沙箱里跑真实的 service-worker.js
 * 验证：① 网络查询成功 → 沉淀进个人词库 ② 再查同词 → 秒回且不再发网络请求
 *       ③ 已收藏生词直接命中 ④ 空结果不污染词库
 * 运行: node test/sw-lookup.test.mjs
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const root = dirname(fileURLToPath(import.meta.url));

// —— chrome 桩：内存版 storage.local + 可计数的假 fetch ——
const store = new Map();
const chromeStub = {
  runtime: { id: 'test', onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
  storage: {
    sync: {
      async get(k) {
        return store.has('sync:' + k) ? { [k]: store.get('sync:' + k) } : {};
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store.set('sync:' + k, v);
      },
    },
    local: {
      async get(k) {
        return store.has(k) ? { [k]: store.get(k) } : {};
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store.set(k, v);
      },
    },
  },
};

let fetchCalls = 0;
const fakeFetch = async (url) => {
  fetchCalls += 1;
  const q = decodeURIComponent(String(url).match(/q=([^&]+)/)?.[1] || '');
  // zzz 开头的词模拟网络彻底失败
  if (q.startsWith('zzz')) {
    return { ok: false, json: async () => ({}) };
  }
  if (String(url).includes('translate.googleapis.com')) {
    return { ok: true, json: async () => ({ sentences: [{ trans: '【网译】' + q }] }) };
  }
  return { ok: true, json: async () => ({ responseData: { translatedText: '【备译】' } }) };
};

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  fetch: fakeFetch,
  chrome: chromeStub,
  self: { addEventListener() {} },
};
vm.createContext(sandbox);
const code = readFileSync(join(root, '../extension/src/background/service-worker.js'), 'utf8');
vm.runInContext(code, sandbox);

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name} — ${detail || ''}`); }
}

// ① 首次查询词库没有的词：走网络，结果沉淀进个人词库
const r1 = await sandbox.handle({ type: 'LOOKUP', word: 'Houthi', sentence: '' });
check('首次查询走网络并返回释义', r1 && r1.meaning && r1.meaning.includes('【网译】'), JSON.stringify(r1));
const saved = store.get('personalDict') || {};
check('查询结果已沉淀进个人词库', !!saved.houthi && saved.houthi.meaning.includes('【网译】'), JSON.stringify(Object.keys(saved)));

// ② 再查同词：秒回，不再发网络请求
const callsAfterFirst = fetchCalls;
const r2 = await sandbox.handle({ type: 'LOOKUP', word: '  Houthi ', sentence: '' });
check('再次查询命中个人词库（source=personal）', r2 && r2.source === 'personal' && r2.meaning.includes('【网译】'), JSON.stringify(r2));
check('不再发起网络请求', fetchCalls === callsAfterFirst, `fetchCalls=${fetchCalls}`);

// ③ 已收藏生词直接命中（不走网络）
await sandbox.handle({ type: 'SAVE_WORD', entry: { word: 'reshaped', meaning: '重塑；改变形态', pos: 'v.' } });
const r3 = await sandbox.handle({ type: 'LOOKUP', word: 'Reshaped', sentence: '' });
check('已收藏生词直接命中（source=vocab）', r3 && r3.source === 'vocab' && r3.meaning === '重塑；改变形态', JSON.stringify(r3));
check('收藏命中不发网络请求', fetchCalls === callsAfterFirst, `fetchCalls=${fetchCalls}`);

// ④ 网络失败（空结果）不污染个人词库
const callsBefore = fetchCalls;
const r4 = await sandbox.handle({ type: 'LOOKUP', word: 'zzzqqq', sentence: '' });
const storeAfter = store.get('personalDict') || {};
check('查询失败不写入个人词库', !storeAfter.zzzqqq, JSON.stringify(Object.keys(storeAfter)));
check('失败查询不误报成功', !r4.meaning || r4.meaning.length === 0 || (r4.errors && r4.errors.length > 0) || r4.meaning.includes('失败'), JSON.stringify(r4).slice(0, 120));

// ⑤ 划选短语不进个人词库（短语译文与语境相关）
await sandbox.handle({ type: 'LOOKUP', word: 'Iranian flights', sentence: 'x' });
const storeAfter2 = store.get('personalDict') || {};
check('短语不写入个人词库', !storeAfter2['iranian flights'], JSON.stringify(Object.keys(storeAfter2)));

console.log(`\n合计 ${pass + fail}，通过 ${pass}，失败 ${fail}`);
if (fail) process.exitCode = 1;
