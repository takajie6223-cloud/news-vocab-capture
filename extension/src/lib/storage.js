// 统一存储
// - 非敏感设置：chrome.storage.sync（跨设备）
// - 密钥 llmApiKey：仅 chrome.storage.local（禁止进 Google 同步）
// - 生词本：chrome.storage.local（内容不进 sync，避免词汇/例句上传）

export const DEFAULT_SETTINGS = {
  translateSource: 'auto', // auto | google | mymemory | localOnly
  enableLLM: false,
  llmBaseUrl: 'http://127.0.0.1:11434/v1',
  llmModel: 'qwen3.5:4b',
  llmApiKey: '',
  fontSize: 15,
  sentenceDefault: true,
  enableSelection: true,
  hotkeysHint: true,
  domainAllowlist: 'nytimes.com,washingtonpost.com,ft.com,economist.com,bloomberg.com,theatlantic.com,scmp.com,nature.com,theverge.com,theguardian.com,independent.co.uk,theglobeandmail.com,thestar.com,nikkei.com,technologyreview.com,foreignaffairs.com,forbes.com,fortune.com,reuters.com,axios.com,politico.com,thehill.com,slate.com,thedailybeast.com,thehindu.com,indianexpress.com,jpost.com,haaretz.com,lemonde.fr,spiegel.de,faz.net,sueddeutsche.de,elpais.com,corriere.it,newrepublic.com,newstatesman.com,seattletimes.com,inquirer.com,startribune.com,nypost.com,popsci.com,entrepreneur.com,inews.co.uk,observer.co.uk,wsj.com,latimes.com,telegraph.co.uk,hbr.org,thetimes.com,bostonglobe.com,foreignpolicy.com,theintercept.com,vox.com,science.org,zeit.de,nybooks.com,nationalreview.com,texasmonthly.com,tomshardware.com,csmonitor.com,chicagotribune.com,businessinsider.com,marketwatch.com,towardsdatascience.com,fastcompany.com,inc.com,qz.com,dallasnews.com,sfchronicle.com',
};

const SETTINGS_KEY = 'settings';
const SECRETS_KEY = 'secrets';
const VOCAB_KEY = 'vocab';

/** content script 只应拿到这些（绝不含密钥） */
export function toContentSettings(settings) {
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

function splitPatch(patch) {
  const secrets = {};
  const rest = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'llmApiKey') secrets[k] = v;
    else rest[k] = v;
  }
  return { secrets, rest };
}

export async function getSettings() {
  const sync = await chrome.storage.sync.get(SETTINGS_KEY);
  const local = await chrome.storage.local.get(SECRETS_KEY);
  return {
    ...DEFAULT_SETTINGS,
    ...(sync[SETTINGS_KEY] || {}),
    ...(local[SECRETS_KEY] || {}),
  };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  const { secrets, rest } = splitPatch(next);

  // sync 中永远不落密钥
  const syncPayload = { ...rest };
  delete syncPayload.llmApiKey;
  await chrome.storage.sync.set({ [SETTINGS_KEY]: syncPayload });
  await chrome.storage.local.set({ [SECRETS_KEY]: { llmApiKey: secrets.llmApiKey || '' } });
  return next;
}

export function isValidLlmBaseUrl(url) {
  const u = String(url || '').trim();
  if (!u) return true;
  try {
    const parsed = new URL(u);
    // 公网只允许 https；本机千问/Ollama 等允许 http://127.0.0.1|localhost
    if (parsed.protocol === 'https:') return true;
    if (parsed.protocol === 'http:') {
      const h = parsed.hostname;
      return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
    }
    return false;
  } catch {
    return false;
  }
}

export const LLM_PRESETS = {
  ollama: { llmBaseUrl: 'http://127.0.0.1:11434/v1', llmModel: 'qwen3.5:4b', label: 'Ollama · 本机千问' },
  lmstudio: { llmBaseUrl: 'http://127.0.0.1:1234/v1', llmModel: 'qwen3.5-4b', label: 'LM Studio' },
  vllm: { llmBaseUrl: 'http://127.0.0.1:8000/v1', llmModel: 'qwen3.5-4b', label: 'vLLM / 本地服务' },
};

export async function getVocab() {
  const data = await chrome.storage.local.get(VOCAB_KEY);
  return Array.isArray(data[VOCAB_KEY]) ? data[VOCAB_KEY] : [];
}

export async function saveVocab(list) {
  await chrome.storage.local.set({ [VOCAB_KEY]: list });
  return list;
}

export function normalizeWord(w) {
  return String(w || '').trim().toLowerCase().replace(/^[^\w'-]+|[^\w'-]+$/g, '');
}

export function safeHttpUrl(u) {
  try {
    const parsed = new URL(String(u || ''));
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.href;
  } catch {
    /* ignore */
  }
  return '';
}

export async function upsertWord(entry) {
  const list = await getVocab();
  const key = normalizeWord(entry.word);
  const now = Date.now();
  const existing = list.find((x) => normalizeWord(x.word) === key);

  const clean = {
    word: String(entry.word || '').slice(0, 80),
    phonetic: String(entry.phonetic || '').slice(0, 80),
    pos: String(entry.pos || '').slice(0, 40),
    meaning: String(entry.meaning || '').slice(0, 500),
    defEn: String(entry.defEn || '').slice(0, 500),
    sentence: String(entry.sentence || '').slice(0, 1000),
    title: String(entry.title || '').slice(0, 300),
    url: safeHttpUrl(entry.url),
  };

  if (existing) {
    existing.savedCount = (existing.savedCount || 1) + 1;
    existing.updatedAt = now;
    if (clean.meaning && (!existing.meaning || existing.meaning.length < clean.meaning.length)) {
      existing.meaning = clean.meaning;
    }
    if (clean.phonetic) existing.phonetic = clean.phonetic;
    if (clean.pos) existing.pos = clean.pos;
    if (clean.defEn) existing.defEn = clean.defEn;
    if (clean.sentence) {
      const bag = [clean.sentence, existing.sentence, ...(existing.sentences || [])].filter(Boolean);
      existing.sentences = [...new Set(bag)].slice(0, 5);
      existing.sentence = clean.sentence;
    }
    if (clean.title) existing.title = clean.title;
    if (clean.url) existing.url = clean.url;
    await saveVocab(list);
    return { item: existing, created: false };
  }

  const item = {
    id: `w_${now}_${Math.random().toString(36).slice(2, 8)}`,
    ...clean,
    sentences: clean.sentence ? [clean.sentence] : [],
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
  return { item, created: true };
}

export async function updateWord(id, patch) {
  const list = await getVocab();
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) return null;
  const safePatch = { ...patch };
  if (safePatch.url != null) safePatch.url = safeHttpUrl(safePatch.url);
  list[idx] = { ...list[idx], ...safePatch, updatedAt: Date.now() };
  await saveVocab(list);
  return list[idx];
}

export async function removeWord(id) {
  const list = await getVocab();
  const next = list.filter((x) => x.id !== id);
  await saveVocab(next);
  return next;
}

export async function findWord(word) {
  const key = normalizeWord(word);
  const list = await getVocab();
  return list.find((x) => normalizeWord(x.word) === key) || null;
}

export function domainAllowed(hostname, allowlistStr) {
  const hosts = String(allowlistStr || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const h = String(hostname || '').toLowerCase();
  return hosts.some((d) => h === d || h.endsWith(`.${d}`));
}
