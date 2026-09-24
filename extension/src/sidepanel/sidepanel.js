import { getVocab, removeWord, getSettings, safeHttpUrl } from '../lib/storage.js';
import { filterDue, stageLabel, isDue } from '../lib/srs.js';
import { toAnkiCsv, toMarkdown, downloadText, stamp } from '../lib/export.js';

let list = [];
let filter = 'all';
let query = '';
let reviewQueue = [];
let reviewIndex = 0;
let flipped = false;

const $ = (id) => document.getElementById(id);

async function refresh() {
  list = await getVocab();
  renderList();
  renderStats();
}

function renderStats() {
  const due = filterDue(list).length;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const today = list.filter((x) => (x.updatedAt || x.createdAt) >= todayStart.getTime()).length;
  $('stats').textContent = `共 ${list.length} · 待复习 ${due} · 今日 ${today}`;
}

function filtered() {
  let out = list.slice();
  if (filter === 'due') out = out.filter((x) => isDue(x));
  if (filter === 'mastered') out = out.filter((x) => (x.stage || 0) >= 3);
  if (filter === 'recent') {
    out.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  }
  if (query) {
    const q = query.toLowerCase();
    out = out.filter(
      (x) =>
        (x.word || '').toLowerCase().includes(q) ||
        (x.meaning || '').toLowerCase().includes(q) ||
        (x.sentence || '').toLowerCase().includes(q) ||
        (x.title || '').toLowerCase().includes(q)
    );
  }
  return out;
}

function renderList() {
  const el = $('list');
  const rows = filtered();
  if (!rows.length) {
    el.innerHTML = `<div class="empty">暂无词条<br/>在 Reuters 文章里双击单词并点 ★ 收藏</div>`;
    return;
  }
  el.innerHTML = rows
    .map(
      (x) => `
    <article class="item" data-id="${escapeHtml(x.id)}">
      <div class="item-top">
        <p class="item-word">${escapeHtml(x.word)}</p>
        <span class="item-badge">${stageLabel(x.stage)} · ${escapeHtml(String(x.savedCount || 1))}藏</span>
      </div>
      <p class="item-meaning">${escapeHtml(x.meaning || '—')}</p>
      <p class="item-src">${escapeHtml(x.title || x.url || '')}</p>
    </article>`
    )
    .join('');
  el.querySelectorAll('.item').forEach((node) => {
    node.addEventListener('click', () => openDetail(node.dataset.id));
  });
}

function openDetail(id) {
  const item = list.find((x) => x.id === id);
  if (!item) return;
  const box = $('detail');
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="detail-card">
      <h2>${escapeHtml(item.word)}</h2>
      <p class="kv">${escapeHtml(item.phonetic || '')} ${escapeHtml(item.pos || '')}</p>
      <p class="kv"><strong>释义</strong> ${escapeHtml(item.meaning || '')}</p>
      ${item.defEn ? `<p class="kv"><strong>英文</strong> ${escapeHtml(item.defEn)}</p>` : ''}
      ${item.sentence ? `<p class="kv"><strong>例句</strong> ${escapeHtml(item.sentence)}</p>` : ''}
      ${item.title ? `<p class="kv"><strong>来源</strong> ${escapeHtml(item.title)}</p>` : ''}
      <p class="kv"><strong>复习</strong> ${stageLabel(item.stage)} · ${item.reviews || 0} 次 · 忘了 ${item.lapses || 0} 次</p>
      <div class="detail-actions">
        ${safeHttpUrl(item.url) ? `<a class="btn primary" href="${escapeAttr(safeHttpUrl(item.url))}" target="_blank" rel="noreferrer">回原文</a>` : ''}
        <button class="btn" id="btn-del">删除</button>
        <button class="btn ghost" id="btn-close">关闭</button>
      </div>
    </div>`;
  box.addEventListener('click', (e) => {
    if (e.target === box) closeDetail();
  });
  $('btn-close')?.addEventListener('click', closeDetail);
  $('btn-del')?.addEventListener('click', async () => {
    if (!confirm(`删除「${item.word}」？`)) return;
    await removeWord(item.id);
    closeDetail();
    refresh();
  });
}

function closeDetail() {
  $('detail').classList.add('hidden');
}

function startReview() {
  reviewQueue = filterDue(list);
  if (!reviewQueue.length) {
    alert('当前没有到期待复习的词');
    return;
  }
  reviewIndex = 0;
  flipped = false;
  $('list').classList.add('hidden');
  $('detail').classList.add('hidden');
  document.querySelector('.toolbar').classList.add('hidden');
  $('review').classList.remove('hidden');
  showReviewCard();
}

function showReviewCard() {
  const item = reviewQueue[reviewIndex];
  if (!item) {
    $('review-word').textContent = '本轮复习完成 🎉'.replace('🎉', '');
    $('review-phonetic').textContent = '';
    $('review-back').classList.add('hidden');
    $('review-tag').textContent = '全部搞定';
    $('btn-flip').classList.add('hidden');
    $('grade').classList.add('hidden');
    return;
  }
  flipped = false;
  $('review-tag').textContent = `${reviewIndex + 1} / ${reviewQueue.length} · ${stageLabel(item.stage)}`;
  $('review-word').textContent = item.word;
  $('review-phonetic').textContent = item.phonetic || '';
  $('review-back').classList.add('hidden');
  $('grade').classList.add('hidden');
  $('btn-flip').classList.remove('hidden');
  $('btn-flip').textContent = '显示答案（空格）';
  $('review-meaning').textContent = item.meaning || '';
  $('review-def').textContent = item.defEn || '';
  $('review-sentence').textContent = item.sentence || '';
}

function flipReview() {
  if (reviewIndex >= reviewQueue.length) return;
  flipped = !flipped;
  $('review-back').classList.toggle('hidden', !flipped);
  $('grade').classList.toggle('hidden', !flipped);
  $('btn-flip').classList.toggle('hidden', flipped);
}

async function gradeReview(grade) {
  const item = reviewQueue[reviewIndex];
  if (!item) return;
  await chrome.runtime.sendMessage({ type: 'REVIEW_GRADE', id: item.id, grade });
  await refresh();
  // 重新拉队列中的数据状态（本地 list 已更新）
  reviewIndex += 1;
  showReviewCard();
}

function exitReview() {
  $('review').classList.add('hidden');
  $('list').classList.remove('hidden');
  document.querySelector('.toolbar').classList.remove('hidden');
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

// UI 绑定
$('search').addEventListener('input', (e) => {
  query = e.target.value.trim();
  renderList();
});

document.querySelectorAll('.chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    filter = btn.dataset.filter;
    renderList();
  });
});

$('btn-review').addEventListener('click', startReview);
$('btn-exit-review').addEventListener('click', exitReview);
$('btn-flip').addEventListener('click', flipReview);
$('review-card').addEventListener('click', flipReview);
document.querySelectorAll('[data-grade]').forEach((btn) => {
  btn.addEventListener('click', () => gradeReview(btn.dataset.grade));
});

$('btn-settings').addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL('src/options/options.html'));
  }
});

$('btn-export-csv').addEventListener('click', () => {
  const csv = toAnkiCsv(list);
  downloadText(`生词本_Anki_${stamp()}.csv`, csv, 'text/csv;charset=utf-8');
});

$('btn-export-md').addEventListener('click', () => {
  const md = toMarkdown(list);
  downloadText(`生词本_${stamp()}.md`, md, 'text/markdown;charset=utf-8');
});

document.addEventListener('keydown', (e) => {
  if (e.key === ' ' && !$('review').classList.contains('hidden')) {
    e.preventDefault();
    if (!flipped) flipReview();
  }
  if (e.key === 'Enter' && flipped) {
    gradeReview('good');
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'REVIEW_MODE') startReview();
  if (msg?.type === 'VOCAB_CHANGED') refresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.vocab) refresh();
});

getSettings().then(() => refresh());
refresh();
