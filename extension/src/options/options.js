import { getSettings, saveSettings, DEFAULT_SETTINGS, toContentSettings, isValidLlmBaseUrl, LLM_PRESETS } from '../lib/storage.js';

const ids = [
  'translateSource',
  'fontSize',
  'enableSelection',
  'sentenceDefault',
  'hotkeysHint',
  'enableLLM',
  'llmBaseUrl',
  'llmModel',
  'llmApiKey',
  'domainAllowlist',
];

const $ = (id) => document.getElementById(id);

function fill(settings) {
  $('translateSource').value = settings.translateSource;
  $('fontSize').value = settings.fontSize;
  $('fontSizeVal').textContent = `${settings.fontSize}px`;
  $('enableSelection').checked = !!settings.enableSelection;
  $('sentenceDefault').checked = !!settings.sentenceDefault;
  $('hotkeysHint').checked = !!settings.hotkeysHint;
  $('enableLLM').checked = !!settings.enableLLM;
  $('llmBaseUrl').value = settings.llmBaseUrl || '';
  $('llmModel').value = settings.llmModel || '';
  $('llmApiKey').value = settings.llmApiKey || '';
  $('domainAllowlist').value = settings.domainAllowlist || DEFAULT_SETTINGS.domainAllowlist;
}

function collect() {
  return {
    translateSource: $('translateSource').value,
    fontSize: Number($('fontSize').value) || 15,
    enableSelection: $('enableSelection').checked,
    sentenceDefault: $('sentenceDefault').checked,
    hotkeysHint: $('hotkeysHint').checked,
    enableLLM: $('enableLLM').checked,
    llmBaseUrl: $('llmBaseUrl').value.trim(),
    llmModel: $('llmModel').value.trim(),
    llmApiKey: $('llmApiKey').value.trim(),
    domainAllowlist: $('domainAllowlist').value.trim(),
  };
}

$('fontSize').addEventListener('input', () => {
  $('fontSizeVal').textContent = `${$('fontSize').value}px`;
});

$('btn-save').addEventListener('click', async () => {
  const patch = collect();
  if (patch.llmBaseUrl && !isValidLlmBaseUrl(patch.llmBaseUrl)) {
    $('msg').textContent = 'LLM Base URL 必须是 https:// 地址';
    $('msg').className = 'msg err';
    return;
  }
  try {
    await saveSettings(patch);
    // 只广播 UI 配置，绝不把 API Key 发给 content script
    const safePatch = toContentSettings(patch);
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings: safePatch }).catch(() => {});
    }
    $('msg').textContent = '已保存';
    $('msg').className = 'msg ok';
    setTimeout(() => {
      $('msg').textContent = '';
      $('msg').className = 'msg';
    }, 1600);
  } catch (e) {
    $('msg').textContent = `保存失败：${e.message}`;
    $('msg').className = 'msg err';
  }
});

document.querySelectorAll('[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const p = LLM_PRESETS[btn.dataset.preset];
    if (!p) return;
    $('llmBaseUrl').value = p.llmBaseUrl;
    $('llmModel').value = p.llmModel;
    $('enableLLM').checked = true;
  });
});

$('btn-test-llm')?.addEventListener('click', async () => {
  const msg = $('llm-test-msg');
  msg.textContent = '测试中…';
  msg.className = 'msg';
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'TEST_LLM',
      llmBaseUrl: $('llmBaseUrl').value.trim(),
      llmModel: $('llmModel').value.trim(),
      llmApiKey: $('llmApiKey').value.trim(),
    });
    if (res && res.ok) {
      msg.textContent = '连上了：' + (res.model || 'ok');
      msg.className = 'msg ok';
    } else {
      msg.textContent = (res && res.error) || '连接失败';
      msg.className = 'msg err';
    }
  } catch (e) {
    msg.textContent = '连接失败：' + e.message;
    msg.className = 'msg err';
  }
});

getSettings().then(fill);
