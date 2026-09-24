self.addEventListener('error', function () {});
self.addEventListener('unhandledrejection', function () {});
// MV3 service worker（经典脚本）
// 注意：不要 importScripts 大词表（易导致 SW 启动/运行失败）。
// 页内词表在 content 的 local-dict.js；这里只负责网络翻译与存储。

const DEFAULT_SETTINGS = {
  translateSource: 'auto',
  enableLLM: false,
  llmBaseUrl: 'http://127.0.0.1:11434/v1',
  llmModel: 'qwen3.5:4b',
  llmApiKey: '',
  fontSize: 15,
  sentenceDefault: true,
  enableSelection: true,
  hotkeysHint: true,
  domainAllowlist: 'reuters.com,www.reuters.com',
};

const SETTINGS_KEY = 'settings';
const SECRETS_KEY = 'secrets';
const VOCAB_KEY = 'vocab';

function toContentSettings(settings) {
  return {
    translateSource: settings.translateSource,
    fontSize: settings.fontSize,
    sentenceDefault: settings.sentenceDefault,
    enableSelection: settings.enableSelection,
    hotkeysHint: settings.hotkeysHint,
    domainAllowlist: settings.domainAllowlist,
    enableLLM: settings.enableLLM,
  };
}

function safeHttpUrl(u) {
  try {
    const parsed = new URL(String(u || ''));
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.href;
  } catch (_) {}
  return '';
}

function isValidLlmBaseUrl(url) {
  const u = String(url || '').trim();
  if (!u) return true;
  try {
    const parsed = new URL(u);
    if (parsed.protocol === 'https:') return true;
    if (parsed.protocol === 'http:') {
      const h = parsed.hostname;
      return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
    }
    return false;
  } catch (_) {
    return false;
  }
}

function isExtensionPage(sender) {
  // content script 一定带 tab；扩展页（options/sidepanel/popup）不带
  return !(sender && sender.tab);
}

const INTERVALS_MS = [
  1 * 24 * 3600 * 1000,
  2 * 24 * 3600 * 1000,
  4 * 24 * 3600 * 1000,
  7 * 24 * 3600 * 1000,
  15 * 24 * 3600 * 1000,
];

// 词表见 local-dict.js（importScripts 注入 self.RV_LOCAL_DICT）
const LOCAL_DICT = (typeof self !== 'undefined' && self.RV_LOCAL_DICT) || {};

const LOOKUP_CACHE = new Map();
const LOOKUP_CACHE_MAX = 500;

// 个人词库：网络查询成功的词持久化到 chrome.storage.local，下次本地秒回
const PERSONAL_KEY = 'personalDict';
const PERSONAL_MAX = 10000;

async function getPersonalDict() {
  try {
    const data = await chrome.storage.local.get(PERSONAL_KEY);
    return (data && data[PERSONAL_KEY]) || {};
  } catch (_) {
    return {};
  }
}

async function rememberWord(word, result) {
  try {
    const w = normalizeWord(word);
    if (!w || !result || !result.meaning) return;
    const dict = await getPersonalDict();
    // 超量时按时间淘汰最旧的 10%，避免无限膨胀
    const keys = Object.keys(dict);
    if (keys.length >= PERSONAL_MAX && !dict[w]) {
      keys.sort(function (a, b) { return (dict[a].ts || 0) - (dict[b].ts || 0); });
      const evict = keys.slice(0, Math.ceil(PERSONAL_MAX / 10));
      for (let i = 0; i < evict.length; i++) delete dict[evict[i]];
    }
    dict[w] = {
      meaning: String(result.meaning).slice(0, 500),
      phonetic: String(result.phonetic || '').slice(0, 80),
      pos: String(result.pos || '').slice(0, 40),
      defEn: String(result.defEn || '').slice(0, 500),
      ts: Date.now(),
    };
    await chrome.storage.local.set({ [PERSONAL_KEY]: dict });
  } catch (_) {}
}

function cacheGet(key) {
  return LOOKUP_CACHE.get(key);
}
function cacheSet(key, val) {
  if (LOOKUP_CACHE.size >= LOOKUP_CACHE_MAX) {
    const first = LOOKUP_CACHE.keys().next().value;
    LOOKUP_CACHE.delete(first);
  }
  LOOKUP_CACHE.set(key, val);
}

function lookupLocal(word) {
  const w = String(word || '').trim();
  const dict = LOCAL_DICT || self.RV_LOCAL_DICT || {};
  const hit = dict[w] || dict[w.toLowerCase()];
  if (hit) return Object.assign({}, hit, { word: w, source: 'local' });
  return null;
}

function normalizeWord(w) {
  return String(w || '').trim().toLowerCase().replace(/^[^\w'-]+|[^\w'-]+$/g, '');
}

async function getSettings() {
  const sync = await chrome.storage.sync.get(SETTINGS_KEY);
  const local = await chrome.storage.local.get(SECRETS_KEY);
  return Object.assign({}, DEFAULT_SETTINGS, sync[SETTINGS_KEY] || {}, local[SECRETS_KEY] || {});
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = Object.assign({}, current, patch || {});
  const syncPayload = Object.assign({}, next);
  delete syncPayload.llmApiKey;
  await chrome.storage.sync.set({ [SETTINGS_KEY]: syncPayload });
  await chrome.storage.local.set({ [SECRETS_KEY]: { llmApiKey: next.llmApiKey || '' } });
  return next;
}

async function getVocab() {
  const data = await chrome.storage.local.get(VOCAB_KEY);
  return Array.isArray(data[VOCAB_KEY]) ? data[VOCAB_KEY] : [];
}

async function saveVocab(list) {
  await chrome.storage.local.set({ [VOCAB_KEY]: list });
  return list;
}

async function upsertWord(entry) {
  const list = await getVocab();
  const key = normalizeWord(entry.word);
  const now = Date.now();
  const existing = list.find(function (x) {
    return normalizeWord(x.word) === key;
  });

  if (existing) {
    existing.savedCount = (existing.savedCount || 1) + 1;
    existing.updatedAt = now;
    if (entry.meaning && (!existing.meaning || existing.meaning.length < entry.meaning.length)) {
      existing.meaning = entry.meaning;
    }
    if (entry.phonetic) existing.phonetic = entry.phonetic;
    if (entry.pos) existing.pos = entry.pos;
    if (entry.defEn) existing.defEn = entry.defEn;
    if (entry.sentence) {
      const bag = [entry.sentence, existing.sentence].concat(existing.sentences || []).filter(Boolean);
      existing.sentences = bag.filter(function (s, i) { return bag.indexOf(s) === i; }).slice(0, 5);
      existing.sentence = entry.sentence;
    }
    if (entry.title) existing.title = String(entry.title).slice(0, 300);
    if (entry.url) existing.url = safeHttpUrl(entry.url);
    await saveVocab(list);
    return { item: existing, created: false };
  }

  const item = {
    id: 'w_' + now + '_' + Math.random().toString(36).slice(2, 8),
    word: String(entry.word || '').slice(0, 80),
    phonetic: String(entry.phonetic || '').slice(0, 80),
    pos: String(entry.pos || '').slice(0, 40),
    meaning: String(entry.meaning || '').slice(0, 500),
    defEn: String(entry.defEn || '').slice(0, 500),
    sentence: String(entry.sentence || '').slice(0, 1000),
    sentences: entry.sentence ? [String(entry.sentence).slice(0, 1000)] : [],
    title: String(entry.title || '').slice(0, 300),
    url: safeHttpUrl(entry.url),
    createdAt: now,
    updatedAt: now,
    savedCount: 1,
    stage: 0,
    dueAt: now,
    reviews: 0,
    lapses: 0,
  };
  list.unshift(item);
  await saveVocab(list);
  return { item: item, created: true };
}

async function findWord(word) {
  const key = normalizeWord(word);
  const list = await getVocab();
  return list.find(function (x) {
    return normalizeWord(x.word) === key;
  }) || null;
}

function nextDue(stage, now) {
  const s = Math.max(0, Math.min(stage, INTERVALS_MS.length - 1));
  return now + INTERVALS_MS[s];
}

function applyReview(item, grade, now) {
  now = now || Date.now();
  const stage = Number(item.stage || 0);
  let nextStage = stage;
  let lapses = item.lapses || 0;
  const reviews = (item.reviews || 0) + 1;

  if (grade === 'again') {
    nextStage = 0;
    lapses += 1;
  } else if (grade === 'hard') {
    nextStage = Math.max(0, stage);
  } else if (grade === 'good') {
    nextStage = Math.min(stage + 1, INTERVALS_MS.length - 1);
  } else if (grade === 'easy') {
    nextStage = Math.min(stage + 2, INTERVALS_MS.length - 1);
  }

  return Object.assign({}, item, {
    stage: nextStage,
    reviews: reviews,
    lapses: lapses,
    dueAt: nextDue(nextStage, now),
    lastReviewAt: now,
  });
}

function isDue(item, now) {
  now = now || Date.now();
  return !item.dueAt || item.dueAt <= now;
}

function filterDue(list, now) {
  return list.filter(function (x) { return isDue(x, now); });
}

function cleanWord(w) {
  return String(w || '').trim().replace(/^[^\w'-]+|[^\w'-]+$/g, '');
}

async function googleTranslate(text) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&dt=bd&dj=1&q=' + encodeURIComponent(text);
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (Array.isArray(data.sentences)) {
    return data.sentences.map(function (s) { return s.trans || ''; }).join('');
  }
  return '';
}

async function myMemoryTranslate(text) {
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=en|zh-CN';
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const t = data && data.responseData && data.responseData.translatedText;
  if (!t || /MYMEMORY WARNING|INVALID/i.test(t)) throw new Error('mymemory 无效响应');
  return t;
}

async function llmExplain(word, sentence, settings) {
  const base = (settings.llmBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (settings.llmApiKey) headers.Authorization = 'Bearer ' + settings.llmApiKey;
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      model: settings.llmModel || 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: '你是英语新闻助教。根据给出的英文句子解释目标词。只输出 JSON：{"meaning":"中文核心义（短）","pos":"词性","defEn":"简短英文释义"}',
        },
        { role: 'user', content: 'word: ' + word + '\nsentence: ' + sentence },
      ],
    }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const raw = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (_) {
    return { meaning: raw.slice(0, 80) };
  }
}

async function llmTranslateSentence(text, settings) {
  const base = (settings.llmBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (settings.llmApiKey) headers.Authorization = 'Bearer ' + settings.llmApiKey;
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      model: settings.llmModel || 'qwen3.5:4b',
      temperature: 0.2,
      messages: [
        { role: 'system', content: '把用户给出的英文新闻句子翻译成流畅中文。只输出译文，不要解释。' },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return ((data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
}

async function translateWord(word, settings, sentence) {
  settings = settings || {};
  sentence = sentence || '';
  const w = cleanWord(word);
  const source = settings.translateSource || 'auto';
  const ckey = w.toLowerCase() + '|' + source + '|' + (String(sentence || '').slice(0, 80));
  const hit = cacheGet(ckey);
  if (hit) return hit;
  const results = {
    word: w,
    phonetic: '',
    pos: '',
    meaning: '',
    defEn: '',
    sentenceZh: '',
    source: '',
    errors: [],
  };

  // ① 本地词表：命中就离线秒回，不再走网络/模型
  const local = lookupLocal(w);
  if (local && local.meaning) {
    results.phonetic = local.phonetic || '';
    results.pos = local.pos || '';
    results.meaning = local.meaning;
    results.defEn = local.defEn || '';
    results.source = 'local';
    return results;
  }

  if (source === 'localOnly') return results;

  // ② 本机/配置的 LLM（如千问 3.5 4B）：词表未命中时优先
  //    本地服务（127.0.0.1）不需要 API Key
  const llmReady = !!settings.enableLLM && !!settings.llmBaseUrl && settings.llmBaseUrl.trim();
  const baseHost = (() => {
    try { return new URL(settings.llmBaseUrl || '').hostname; } catch (_) { return ''; }
  })();
  const isLocalHost = baseHost === '127.0.0.1' || baseHost === 'localhost' || baseHost === '::1';
  if (llmReady && (isLocalHost || settings.llmApiKey)) {
    try {
      const llm = await llmExplain(w, sentence || w, settings);
      if (llm && llm.meaning) {
        results.meaning = llm.meaning;
        if (llm.defEn) results.defEn = llm.defEn;
        if (llm.pos) results.pos = llm.pos;
        results.source = 'llm';
        // 本地模型答出来就够用；若 translateSource 强制 google 则仍继续
        if (source === 'auto' || source === 'localLLM' || source === 'localOnly') {
          return results;
        }
      }
    } catch (e) {
      results.errors.push('llm: ' + e.message);
    }
  }

  // ③ 在线翻译兜底：Google ∥ MyMemory 并行竞速
  if (source === 'localOnly' || source === 'localLLM') {
    cacheSet(ckey, results);
    return results;
  }

  const tasks = [];
  if (source !== 'mymemory') {
    tasks.push(
      googleTranslate(w).then(
        (text) => ({ src: 'google', text: text }),
        (err) => ({ src: 'google', text: '', err: err })
      )
    );
  }
  if (source !== 'google') {
    tasks.push(
      myMemoryTranslate(w).then(
        (text) => ({ src: 'mymemory', text: text }),
        (err) => ({ src: 'mymemory', text: '', err: err })
      )
    );
  }
  if (tasks.length) {
    const settled = await Promise.all(tasks);
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.err) results.errors.push(s.src + ': ' + (s.err.message || s.err));
    }
    // 取第一个成功的（数组顺序 google 优先，同时成功用 google）
    let winner = null;
    for (let i = 0; i < settled.length; i++) {
      if (settled[i].text) {
        winner = settled[i];
        break;
      }
    }
    if (winner) {
      if (!results.meaning) results.meaning = winner.text;
      results.source = results.source ? results.source + '+' + winner.src : winner.src;
    }
  }

  cacheSet(ckey, results);
  return results;
}

async function translateSentence(text, settings) {
  settings = settings || {};
  const q = String(text || '').trim();
  const out = { text: '', source: '', errors: [] };
  if (!q) return out;
  const source = settings.translateSource || 'auto';
  if (source === 'localOnly') {
    out.errors.push('localOnly 不支持整句翻译');
    return out;
  }

  const canLLM = !!settings.enableLLM && !!String(settings.llmBaseUrl || '').trim();
  if (canLLM) {
    try {
      out.text = await llmTranslateSentence(q, settings);
      if (out.text) {
        out.source = 'llm';
        return out;
      }
    } catch (e) {
      out.errors.push('llm: ' + e.message);
    }
  }

  // Google ∥ MyMemory 并行竞速
  const tasks = [];
  if (source !== 'mymemory') {
    tasks.push(
      googleTranslate(q).then(
        (text) => ({ src: 'google', text: text }),
        (err) => ({ src: 'google', text: '', err: err })
      )
    );
  }
  if (source !== 'google') {
    tasks.push(
      myMemoryTranslate(q).then(
        (text) => ({ src: 'mymemory', text: text }),
        (err) => ({ src: 'mymemory', text: '', err: err })
      )
    );
  }
  if (tasks.length) {
    const settled = await Promise.all(tasks);
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.err) out.errors.push(s.src + ': ' + (s.err.message || s.err));
    }
    let winner = null;
    for (let i = 0; i < settled.length; i++) {
      if (settled[i].text) {
        winner = settled[i];
        break;
      }
    }
    if (winner) {
      out.text = winner.text;
      out.source = winner.src;
    }
  }
  return out;
}

chrome.runtime.onInstalled.addListener(function (details) {
  try {
    if (details && details.reason === 'install') {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') });
    }
  } catch (_) {}
  // 有 default_popup 时不要再设 openPanelOnActionClick / onClicked，避免行为冲突导致错误
});

chrome.commands.onCommand.addListener(async function (command) {
  try {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (command === 'save-word') {
    if (tab && tab.id != null) {
      chrome.tabs.sendMessage(tab.id, { type: 'CMD_SAVE' }).catch(function () {});
    }
  } else if (command === 'open-panel') {
    openSidePanel(tab);
  } else if (command === 'review-mode') {
    openSidePanel(tab);
    chrome.runtime.sendMessage({ type: 'REVIEW_MODE' }).catch(function () {});
  }
  } catch (_) {}
});

async function openSidePanel(tab) {
  try {
    if (chrome.sidePanel && chrome.sidePanel.open) {
      let t = tab;
      if (!t) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        t = tabs[0];
      }
      if (t && t.windowId != null) {
        await chrome.sidePanel.open({ windowId: t.windowId });
        return;
      }
    }
  } catch (_) {}
  chrome.tabs.create({ url: chrome.runtime.getURL('src/sidepanel/sidepanel.html') });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  Promise.resolve()
    .then(function () {
      return handle(msg, sender);
    })
    .then(function (result) {
      try {
        sendResponse(result);
      } catch (_) {}
    })
    .catch(function (e) {
      try {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      } catch (_) {}
    });
  return true;
});

async function handle(msg, sender) {
  switch (msg && msg.type) {
    case 'GET_SETTINGS': {
      const settings = await getSettings();
      // content script 永远拿不到密钥
      if (!isExtensionPage(sender)) {
        return { ok: true, settings: toContentSettings(settings) };
      }
      return { ok: true, settings: settings };
    }

    case 'SAVE_SETTINGS': {
      // 仅扩展页可改设置；content script 不可改（防止改 LLM 地址偷钥匙）
      if (!isExtensionPage(sender)) {
        return { ok: false, error: 'forbidden' };
      }
      const patch = msg.patch || {};
      if (patch.llmBaseUrl != null && !isValidLlmBaseUrl(patch.llmBaseUrl)) {
        return { ok: false, error: 'llmBaseUrl 必须是 https:// 地址' };
      }
      return { ok: true, settings: await saveSettings(patch) };
    }

    case 'LOOKUP': {
      const settings = await getSettings();
      // ① 个人词库：查过的词（含划选短语）持久化秒回，SW 重启后依然有效
      // ② 已收藏生词：storage 里就有释义，不再走网络
      const w = normalizeWord(msg.word);
      if (w && !/\s/.test(w)) {
        try {
          const personal = await getPersonalDict();
          const p = personal[w];
          if (p && p.meaning) {
            return {
              word: w,
              phonetic: p.phonetic || '',
              pos: p.pos || '',
              meaning: p.meaning,
              defEn: p.defEn || '',
              source: 'personal',
            };
          }
          const saved = await findWord(w);
          if (saved && saved.meaning) {
            return {
              word: w,
              phonetic: saved.phonetic || '',
              pos: saved.pos || '',
              meaning: saved.meaning,
              defEn: saved.defEn || '',
              source: 'vocab',
            };
          }
        } catch (_) {}
      }
      const r = await translateWord(msg.word, settings, msg.sentence || '');
      // 网络查询有结果就沉淀进个人词库（只记单词；空结果不缓存，避免污染）
      if (w && !/\s/.test(w) && r && r.meaning) {
        await rememberWord(msg.word, r);
      }
      return r;
    }

    case 'TRANSLATE_SENTENCE': {
      const settings = await getSettings();
      return await translateSentence(msg.text || '', settings);
    }

    case 'SAVE_WORD': {
      const r = await upsertWord(msg.entry || {});
      return { ok: true, created: r.created, item: r.item };
    }

    case 'FIND_WORD': {
      const item = await findWord(msg.word);
      return { ok: true, found: !!item, item: item };
    }

    case 'GET_VOCAB':
      return { ok: true, list: await getVocab() };

    case 'REVIEW_GRADE': {
      const list = await getVocab();
      const idx = list.findIndex(function (x) { return x.id === msg.id; });
      if (idx < 0) return { ok: false, error: 'not found' };
      list[idx] = applyReview(list[idx], msg.grade || 'good');
      await saveVocab(list);
      return { ok: true, item: list[idx], list: list };
    }

    case 'DELETE_WORD': {
      const list = (await getVocab()).filter(function (x) { return x.id !== msg.id; });
      await saveVocab(list);
      return { ok: true, list: list };
    }

    case 'GET_TODAY_COUNT': {
      const list = await getVocab();
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const t0 = start.getTime();
      const count = list.filter(function (x) {
        return (x.updatedAt || x.createdAt) >= t0;
      }).length;
      return { ok: true, count: count, due: filterDue(list).length, total: list.length };
    }

    case 'TEST_LLM': {
      const baseUrl = String(msg.llmBaseUrl || '').trim().replace(/\/$/, '');
      if (!isValidLlmBaseUrl(baseUrl)) {
        return { ok: false, error: 'Base URL 须为 https，或本机 http://127.0.0.1' };
      }
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (msg.llmApiKey) headers.Authorization = 'Bearer ' + msg.llmApiKey;
        // 优先列模型
        let model = msg.llmModel;
        try {
          const r = await fetch(baseUrl + '/models', { headers: { Accept: 'application/json', ...(headers.Authorization ? { Authorization: headers.Authorization } : {}) } });
          if (r.ok) {
            const data = await r.json();
            const ids = (data && data.data && data.data.map(function (x) { return x.id; })) || [];
            if (ids.length && !model) model = ids[0];
            if (ids.length && model && ids.indexOf(model) < 0 && ids.indexOf(String(model).split(':').pop()) < 0) {
              // 提示实际可用
              return { ok: true, model: model, available: ids.slice(0, 12) };
            }
          }
        } catch (_) {}
        // 再发一条极短 chat 探测
        const res = await fetch(baseUrl + '/chat/completions', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({
            model: model || 'qwen3.5:4b',
            max_tokens: 4,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });
        if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120) };
        return { ok: true, model: model || 'ok' };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    }

    case 'OPEN_SIDEPANEL':
      await openSidePanel(sender && sender.tab);
      return { ok: true };

    default:
      return { ok: false, error: 'unknown type ' + (msg && msg.type) };
  }
}
