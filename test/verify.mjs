/**
 * 交互验收：双击取词 + 选多少显示多少 + 滚动后 fixed 定位
 * 运行: node test/verify.mjs
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const root = dirname(fileURLToPath(import.meta.url));

// 拼入最新 content.js（与 manifest 一致：先 local-dict.js 再 content.js）
const dictJs = readFileSync(join(root, '../extension/src/lib/local-dict.js'), 'utf8');
const contentJs = readFileSync(join(root, '../extension/src/content/content.js'), 'utf8');
const pageHtml = readFileSync(join(root, 'page.html'), 'utf8')
  .replace(
    '<script src="content-inject.js"></script>',
    `<script>\n${dictJs}\n</script>\n  <script>\n${contentJs}\n</script>`
  );
const builtPath = join(root, 'page.html.built');
writeFileSync(builtPath, pageHtml);
// 无头浏览器读不了本工作区路径（macOS 沙箱/中文路径），统一落到临时目录再加载
const loadPath = join(tmpdir(), 'rv-verify-page.html');
writeFileSync(loadPath, pageHtml);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
await page.goto(pathToFileURL(loadPath).href);
await page.waitForFunction(() => !!window.__rvDebug);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function dbg() {
  return page.evaluate(() => ({
    head: window.__rvDebug.head(),
    visible: window.__rvDebug.visible(),
    meaning: window.__rvDebug.meaning(),
    bubbleText: window.__rvDebug.bubbleText(),
    bubbleRect: window.__rvDebug.bubbleRect(),
    lookups: window.__lookups || [],
  }));
}

// —— 1) 双击单词 sanctions（词表命中：离线秒回，无需网络查询） ——
let s;
{
  const t = await page.evaluate(() => {
    const h = document.querySelector('h1');
    const node = h.firstChild;
    const idx = node.textContent.indexOf('sanctions');
    const r = document.createRange();
    r.setStart(node, idx);
    r.setEnd(node, idx + 'sanctions'.length);
    const rc = r.getBoundingClientRect();
    return { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2 };
  });
  await page.mouse.dblclick(t.x, t.y);
  await page.waitForTimeout(400);
  s = await dbg();
  check('双击 sanctions head 严格等于 sanctions', s.head === 'sanctions' && s.visible, `head=${JSON.stringify(s.head)} visible=${s.visible}`);
  check('sanctions 词表秒回（不出网络查询）', (s.lookups || []).length === 0 && s.meaning.includes('制裁'), `meaning=${JSON.stringify(s.meaning)} lookups=${JSON.stringify(s.lookups)}`);
  check('双击气泡在视口内', !!(s.bubbleRect && s.bubbleRect.inViewport), JSON.stringify(s.bubbleRect));
  check('双击气泡文案含选中词', (s.bubbleText || '').includes('sanctions'), (s.bubbleText || '').slice(0, 80));
}

// —— 2) 选中两个词 Iranian flights ——
await page.evaluate(() => {
  const h = document.querySelector('h1');
  const t = h.firstChild;
  // 只选 "Iranian flights"
  const idx = t.textContent.indexOf('Iranian flights');
  const r = document.createRange();
  r.setStart(t, idx);
  r.setEnd(t, idx + 'Iranian flights'.length);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  // 触发 mouseup 路径
  h.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 100, clientY: 100 }));
});
await page.waitForTimeout(300);
s = await dbg();
check('选中 Iranian flights 两词原样显示', s.head === 'Iranian flights', `head=${JSON.stringify(s.head)}`);
check('LOOKUP 收到完整 Iranian flights', (s.lookups.at(-1) || {}).word === 'Iranian flights', JSON.stringify(s.lookups.at(-1)));
check('气泡文案含 Iranian flights', (s.bubbleText || '').includes('Iranian flights'), (s.bubbleText || '').slice(0, 80));

// —— 3) 选中一个词 inflation（在下方段落） ——
await page.evaluate(() => {
  const p = [...document.querySelectorAll('p')].find((x) => x.textContent.includes('Inflation'));
  const t = p.firstChild;
  const idx = t.textContent.indexOf('Inflation');
  const r = document.createRange();
  r.setStart(t, idx);
  r.setEnd(t, idx + 'Inflation'.length);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 200, clientY: 300 }));
});
await page.waitForTimeout(300);
s = await dbg();
check('选中 Inflation 单词原样显示', s.head === 'Inflation', `head=${JSON.stringify(s.head)}`);

// —— 4) 滚动后再双击（fixed 定位回归） ——
{
  const t = await page.evaluate(() => {
    const p = [...document.querySelectorAll('p')].find((x) => x.textContent.includes('Inflation'));
    const node = p.firstChild;
    const idx = node.textContent.indexOf('Inflation');
    const r = document.createRange();
    r.setStart(node, idx);
    r.setEnd(node, idx + 'Inflation'.length);
    // 把词滚到视口正中，确保坐标在可视区内
    const docTop = r.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, docTop - window.innerHeight / 2);
    const rc = r.getBoundingClientRect();
    return { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2 };
  });
  await page.waitForTimeout(250);
  await page.mouse.dblclick(t.x, t.y);
}
await page.waitForTimeout(400);
s = await dbg();
check('滚动后双击仍响应', s.visible && s.head === 'Inflation', `head=${JSON.stringify(s.head)} visible=${s.visible}`);
check('滚动后词表秒回且气泡在视口内', !!(s.bubbleRect && s.bubbleRect.inViewport) && s.meaning.includes('通货膨胀'), JSON.stringify(s.bubbleRect));

// —— 5) 不应把两词收成一词 ——
await page.evaluate(() => {
  window.scrollTo(0, 0);
  const h = document.querySelector('h1');
  const t = h.firstChild;
  const idx = t.textContent.indexOf('Iranian flights');
  const r = document.createRange();
  r.setStart(t, idx);
  r.setEnd(t, idx + 'Iranian flights'.length);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  h.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 100, clientY: 100 }));
});
await page.waitForTimeout(300);
s = await dbg();
check('两词不会被砍成 Iranian', s.head === 'Iranian flights' || s.head === 'flights' || s.head.includes('Iranian'), `head=${JSON.stringify(s.head)}`);
check('两词严格相等 Iranian flights', s.head === 'Iranian flights', `head=${JSON.stringify(s.head)}`);

// —— 8) 点击页面空白处（左边距，无文字）：不应弹出气泡 ——
{
  // 先点一次正文清除拖选残留选区，再点空白
  await page.mouse.click(950, 500);
  await page.waitForTimeout(300);
  await page.mouse.click(100, 500);
  await page.waitForTimeout(600);
  s = await dbg();
  check('点击空白处不弹气泡', !s.visible && s.head === '', `head=${JSON.stringify(s.head)} visible=${s.visible}`);
  // 点两次空白后再次点词仍能正常弹（不会因空白点击进入坏状态）
  const t = await page.evaluate(() => {
    const h = document.querySelector('h1');
    const node = h.firstChild;
    const idx = node.textContent.indexOf('sanctions');
    const r = document.createRange();
    r.setStart(node, idx);
    r.setEnd(node, idx + 'sanctions'.length);
    const rc = r.getBoundingClientRect();
    return { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2 };
  });
  await page.mouse.dblclick(t.x, t.y);
  await page.waitForTimeout(500);
  s = await dbg();
  check('空白点击后再点词仍正常弹气泡', s.visible && s.head === 'sanctions', `head=${JSON.stringify(s.head)} visible=${s.visible}`);
}

// —— 9) 真实鼠标点击气泡内「收藏 / 复制」按钮（回归：按钮点击必须可用） ——
{
  // 弹出 sanctions 气泡
  const t = await page.evaluate(() => {
    const h = document.querySelector('h1');
    const node = h.firstChild;
    const idx = node.textContent.indexOf('sanctions');
    const r = document.createRange();
    r.setStart(node, idx);
    r.setEnd(node, idx + 'sanctions'.length);
    const rc = r.getBoundingClientRect();
    return { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2 };
  });
  await page.mouse.dblclick(t.x, t.y);
  await page.waitForTimeout(400);
  s = await dbg();
  const br = s.bubbleRect;
  check('按钮用例前置：气泡可见', s.visible && !!br, JSON.stringify(br));

  // 真实鼠标点击「收藏」按钮（用 __rvDebug.saveBtnRect 拿按钮精确矩形）
  const btn = await page.evaluate(() => window.__rvDebug.saveBtnRect());
  const savesBefore = (await page.evaluate(() => (window.__saves || []).length));
  await page.mouse.click(btn.left + btn.width / 2, btn.top + btn.height / 2);
  await page.waitForTimeout(400);
  s = await dbg();
  const savesAfter = (await page.evaluate(() => (window.__saves || []).length));
  check('真实点击「收藏」按钮完成收藏', savesAfter === savesBefore + 1, `saves=${savesAfter} (was ${savesBefore})`);
  check('收藏后按钮变为已藏状态', (s.bubbleText || '').includes('已藏'), s.bubbleText.slice(-120));

  // Alt+S 快捷键收藏仍可用
  await page.keyboard.press('Alt+s');
  await page.waitForTimeout(300);
  const savesKbd = (await page.evaluate(() => (window.__saves || []).length));
  check('Alt+S 快捷键收藏仍可用', savesKbd === savesAfter + 1, `saves=${savesKbd}`);

  // 真实鼠标点击「复制」按钮：状态行必须有反馈（证明事件可达）
  const cpy = await page.evaluate(() => {
    const b = window.__rvDebug.saveBtnRect();
    return { x: b.left + b.width + 45, y: b.top + b.height / 2 };
  });
  await page.mouse.click(cpy.x, cpy.y);
  await page.waitForTimeout(300);
  s = await dbg();
  check('真实点击「复制」按钮有状态反馈', (s.bubbleText || '').includes('已复制') || (s.bubbleText || '').includes('复制失败'), s.bubbleText.slice(-80));
}

await page.screenshot({ path: join(root, 'verify.png'), fullPage: false });

// —— 6) 真实单击词表外单词 cancelled（回归：mousedown 会清空 current；
//      词形还原 cancelled→cancel 命中词表，应本地秒回且不发网络查询） ——
{
  await page.evaluate(() => window.scrollTo(0, 0));
  const t = await page.evaluate(() => {
    const h = document.querySelector('h1');
    const node = h.firstChild;
    const idx = node.textContent.indexOf('cancelled');
    const r = document.createRange();
    r.setStart(node, idx);
    r.setEnd(node, idx + 'cancelled'.length);
    const rc = r.getBoundingClientRect();
    return { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2 };
  });
  await page.mouse.click(t.x, t.y);
  await page.waitForTimeout(600);
  s = await dbg();
  const lookupsBefore = (s.lookups || []).length;
  check('词表外变形词 cancelled 单击弹气泡', s.visible && s.head === 'cancelled', `head=${JSON.stringify(s.head)} visible=${s.visible}`);
  check('cancelled 词形还原秒回（cancelled→cancel，无网络查询）', (s.lookups || []).length === lookupsBefore && s.meaning.includes('取消'), `meaning=${JSON.stringify(s.meaning)} lookups=${JSON.stringify(s.lookups)}`);
}

// —— 6b) 单击词库真没有的词 Houthi（专有名词）：必须走网络查询且有释义 ——
{
  // 先点空白关掉上一步的气泡，避免它悬浮在 Houthi 上方吃掉点击
  await page.mouse.click(100, 500);
  await page.waitForTimeout(300);
  const t = await page.evaluate(() => {
    const p = [...document.querySelectorAll('p')].find((x) => x.textContent.includes('Houthi'));
    const node = p.firstChild;
    const idx = node.textContent.indexOf('Houthi');
    const r = document.createRange();
    r.setStart(node, idx);
    r.setEnd(node, idx + 'Houthi'.length);
    const rc = r.getBoundingClientRect();
    return { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2 };
  });
  await page.mouse.click(t.x, t.y);
  await page.waitForTimeout(600);
  s = await dbg();
  check('词库真没有的词 Houthi 走网络查询', (s.lookups.at(-1) || {}).word === 'Houthi', JSON.stringify(s.lookups.at(-1)));
  check('Houthi 气泡有释义', (s.meaning || '').length > 0, s.meaning);
}

// —— 7) 真实拖选多词 recession fears continue（mousedown→move→mouseup 全链路） ——
{
  const t = await page.evaluate(() => {
    const p = [...document.querySelectorAll('p')].find((x) => x.textContent.includes('recession fears'));
    const node = p.firstChild;
    const i1 = node.textContent.indexOf('recession');
    const r1 = document.createRange();
    r1.setStart(node, i1);
    r1.setEnd(node, i1 + 'recession'.length);
    const a = r1.getBoundingClientRect();
    const i2 = node.textContent.indexOf('continue');
    const r2 = document.createRange();
    r2.setStart(node, i2);
    r2.setEnd(node, i2 + 'continue'.length);
    const b = r2.getBoundingClientRect();
    return { x1: a.left + 2, y1: a.top + a.height / 2, x2: b.right - 2, y2: b.top + b.height / 2 };
  });
  await page.mouse.move(t.x1, t.y1);
  await page.mouse.down();
  await page.mouse.move((t.x1 + t.x2) / 2, t.y2, { steps: 6 });
  await page.mouse.move(t.x2, t.y2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  s = await dbg();
  // 设计契约「选多少显示多少」：气泡 head 必须与页面真实选区逐字一致
  const actualSel = await page.evaluate(() => String(getSelection().toString() || '').replace(/\s+/g, ' ').trim());
  check('拖选后气泡可见', s.visible, `visible=${s.visible}`);
  check('拖选 head 与真实选区逐字一致（选多少显示多少）', s.head === actualSel && s.head.startsWith('recession fears continue'), `head=${JSON.stringify(s.head)} sel=${JSON.stringify(actualSel)}`);
  check('拖选 LOOKUP 收到完整选区', (s.lookups.at(-1) || {}).word === s.head, JSON.stringify(s.lookups.at(-1)));
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log('\n---');
console.log(`合计 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length) {
  process.exitCode = 1;
  console.log('失败项：', failed.map((f) => f.name).join(' | '));
} else {
  console.log('全部通过');
}
