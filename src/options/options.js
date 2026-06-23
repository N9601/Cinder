const FIELDS = [
  'geminiKey',
  'geminiModel',
  'geminiFinalModel',
  'obsidianUrl',
  'obsidianToken',
  'inboxFolder',
  'chunkMinutes'
];

async function load() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  for (const k of FIELDS) {
    const el = document.getElementById(k);
    if (!el) continue;
    if (settings[k] !== undefined && settings[k] !== null) el.value = settings[k];
  }
}

document.getElementById('save').addEventListener('click', async () => {
  const settings = {};
  for (const k of FIELDS) {
    const el = document.getElementById(k);
    if (!el) continue;
    const v = el.value;
    settings[k] = el.type === 'number' ? Number(v) : v;
  }
  await chrome.storage.local.set({ settings });
  const s = document.getElementById('status');
  s.textContent = 'Saved.';
  setTimeout(() => (s.textContent = ''), 1500);
});

load();
