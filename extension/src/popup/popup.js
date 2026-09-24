const $ = (id) => document.getElementById(id);

async function refreshStats() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_TODAY_COUNT' });
    $('total').textContent = res?.total ?? 0;
    $('due').textContent = res?.due ?? 0;
    $('today').textContent = res?.count ?? 0;
  } catch (_) {}
}

$('btn-panel').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' });
  window.close();
});

$('btn-review').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' });
  chrome.runtime.sendMessage({ type: 'REVIEW_MODE' }).catch(() => {});
  window.close();
});

$('btn-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

$('btn-open').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.reuters.com/world/' });
});

refreshStats();
