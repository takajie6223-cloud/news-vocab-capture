// 翻译源：local → google → mymemory → 可选 LLM
import { lookupLocal } from './dict.js';

const GOOGLE_URL = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&dt=bd&dj=1&q=';
const MYMEMORY_URL = 'https://api.mymemory.translated.net/get?q=&langpair=en|zh-CN';

function cleanWord(w) {
  return String(w || '').trim().replace(/^[^\w'-]+|[^\w'-]+$/g, '');
}

export async function translateWord(word, settings = {}, sentence = '') {
  const w = cleanWord(word);
  const source = settings.translateSource || 'auto';
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

  const local = lookupLocal(w);
  if (local) {
    results.phonetic = local.phonetic || '';
    results.pos = local.pos || '';
    results.meaning = local.meaning || '';
    results.defEn = local.defEn || '';
    results.source = 'local';
    if (source === 'localOnly') return results;
  }

  if (source === 'localOnly') {
    if (!results.meaning) results.meaning = '';
    return results;
  }

  // 在线词/短语翻译
  const needOnline = !results.meaning || source === 'google' || source === 'mymemory' || source === 'auto';
  if (needOnline) {
    try {
      const g = await googleTranslate(w);
      if (g) {
        if (!results.meaning) results.meaning = g;
        if (!results.source || results.source === 'local') results.source = results.source === 'local' ? 'local+google' : 'google';
        if (results.source === '') results.source = 'google';
      }
    } catch (e) {
      results.errors.push(`google: ${e.message}`);
    }

    if (!results.meaning && source !== 'google') {
      try {
        const m = await myMemoryTranslate(w);
        if (m) {
          results.meaning = m;
          results.source = results.source ? `${results.source}+mymemory` : 'mymemory';
        }
      } catch (e) {
        results.errors.push(`mymemory: ${e.message}`);
      }
    }
  }

  // 可选：LLM 语境释义
  if (settings.enableLLM && sentence && settings.llmApiKey) {
    try {
      const llm = await llmExplain(w, sentence, settings);
      if (llm?.meaning) results.meaning = llm.meaning;
      if (llm?.defEn) results.defEn = llm.defEn;
      if (llm?.pos) results.pos = llm.pos;
      results.source = `${results.source || ''}+llm`.replace(/^\+/, '');
    } catch (e) {
      results.errors.push(`llm: ${e.message}`);
    }
  }

  return results;
}

export async function translateSentence(text, settings = {}) {
  const q = String(text || '').trim();
  if (!q) return { text: '', source: '', errors: [] };
  const source = settings.translateSource || 'auto';
  const out = { text: '', source: '', errors: [] };

  if (source === 'localOnly') {
    out.text = '';
    out.errors.push('localOnly 不支持整句翻译');
    return out;
  }

  if (settings.enableLLM && settings.llmApiKey) {
    try {
      out.text = await llmTranslateSentence(q, settings);
      out.source = 'llm';
      return out;
    } catch (e) {
      out.errors.push(`llm: ${e.message}`);
    }
  }

  if (source === 'mymemory') {
    try {
      out.text = await myMemoryTranslate(q);
      out.source = 'mymemory';
      return out;
    } catch (e) {
      out.errors.push(`mymemory: ${e.message}`);
    }
  }

  try {
    out.text = await googleTranslate(q);
    out.source = 'google';
  } catch (e) {
    out.errors.push(`google: ${e.message}`);
    try {
      out.text = await myMemoryTranslate(q);
      out.source = 'mymemory';
    } catch (e2) {
      out.errors.push(`mymemory: ${e2.message}`);
    }
  }
  return out;
}

async function googleTranslate(text) {
  const url = GOOGLE_URL + encodeURIComponent(text);
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (Array.isArray(data.sentences)) {
    return data.sentences.map((s) => s.trans || '').join('');
  }
  return '';
}

async function myMemoryTranslate(text) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|zh-CN`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const t = data?.responseData?.translatedText;
  if (!t || /MYMEMORY WARNING|INVALID/i.test(t)) throw new Error('mymemory 无效响应');
  return t;
}

async function llmExplain(word, sentence, settings) {
  const base = (settings.llmBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.llmApiKey}`,
    },
    body: JSON.stringify({
      model: settings.llmModel || 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            '你是英语新闻助教。根据给出的英文句子解释目标词。只输出 JSON：{"meaning":"中文核心义（短）","pos":"词性","defEn":"简短英文释义"}',
        },
        { role: 'user', content: `word: ${word}\nsentence: ${sentence}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content || '';
  try {
    const json = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return json;
  } catch {
    return { meaning: raw.slice(0, 80) };
  }
}

async function llmTranslateSentence(text, settings) {
  const base = (settings.llmBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.llmApiKey}`,
    },
    body: JSON.stringify({
      model: settings.llmModel || 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: '把用户给出的英文新闻句子翻译成流畅中文。只输出译文，不要解释。',
        },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data?.choices?.[0]?.message?.content || '').trim();
}
