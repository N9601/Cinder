const STORAGE_PREFIX = 'cinder_video_';
const HISTORY_KEY = 'cinder_history';
const $ = (id) => document.getElementById(id);

const els = {
  statusPill: $('status-pill'),
  statusLabel: $('status-label'),
  tabs: document.querySelectorAll('.tab'),
  tabPanels: document.querySelectorAll('.tab-panel'),
  historyCount: $('history-count'),
  empty: $('empty-state'),
  videoCard: $('video-card'),
  vcTitle: $('vc-title'),
  vcMeta: $('vc-meta'),
  banner: $('resume-banner'),
  actions: $('actions'),
  primaryBtn: $('primary-btn'),
  saveBtn: $('save-btn'),
  instantBtn: $('instant-btn'),
  notesCount: $('notes-count'),
  chunks: $('chunks'),
  historyList: $('history-list'),
  clearHistoryBtn: $('clear-history-btn'),
  discardBtn: $('discard-btn'),
  openOptions: $('open-options')
};

const state = {
  tab: 'current',
  videoId: null,
  meta: null,        // { title, channel, videoUrl }
  chunks: [],
  captureActive: false,
  saving: false,
  instanting: false,
  history: []
};

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  const mo = Math.round(day / 30);
  return `${mo} mo${mo === 1 ? '' : 's'} ago`;
}

async function readActiveVideo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return { tab: null, videoId: null };
  let videoId = null;
  try {
    const u = new URL(tab.url);
    if (/(^|\.)youtube\.com$/.test(u.hostname) && u.pathname === '/watch') {
      videoId = u.searchParams.get('v');
    }
  } catch { /* not a URL we care about */ }
  return { tab, videoId };
}

async function loadStored(videoId) {
  if (!videoId) return null;
  const k = STORAGE_PREFIX + videoId;
  const r = await chrome.storage.local.get(k);
  return r[k] || null;
}

async function writeStored(videoId, patch) {
  const k = STORAGE_PREFIX + videoId;
  const r = await chrome.storage.local.get(k);
  const next = { ...(r[k] || {}), ...patch, lastUpdated: Date.now() };
  await chrome.storage.local.set({ [k]: next });
}

async function loadHistory() {
  const r = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(r[HISTORY_KEY]) ? r[HISTORY_KEY] : [];
}

async function refresh() {
  const { tab, videoId } = await readActiveVideo();
  state.videoId = videoId;

  state.history = await loadHistory();

  if (!videoId) {
    state.meta = null;
    state.chunks = [];
    state.captureActive = false;
    render();
    return;
  }

  const stored = await loadStored(videoId);
  if (stored) {
    state.meta = {
      title: stored.title,
      channel: stored.channel,
      videoUrl: stored.videoUrl
    };
    state.chunks = stored.chunks || [];
    state.captureActive = !!stored.captureActive;
  } else {
    state.meta = {
      title: tab?.title?.replace(/ - YouTube$/, '') || 'YouTube video',
      channel: '',
      videoUrl: tab?.url || ''
    };
    state.chunks = [];
    state.captureActive = false;
  }
  render();
}

function renderStatus() {
  let pillState = 'idle';
  let pillLabel = 'Idle';
  if (state.saving) { pillState = 'saving'; pillLabel = 'Saving…'; }
  else if (state.instanting) { pillState = 'saving'; pillLabel = 'Generating…'; }
  else if (state.captureActive) { pillState = 'capturing'; pillLabel = 'Capturing'; }
  els.statusPill.dataset.state = pillState;
  els.statusLabel.textContent = pillLabel;
}

function renderTabs() {
  els.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === state.tab));
  els.tabPanels.forEach(p => p.classList.toggle('hidden', p.dataset.tabPanel !== state.tab));
  els.historyCount.textContent = String(state.history.length);
}

function renderCurrent() {
  if (!state.videoId) {
    els.empty.classList.remove('hidden');
    els.videoCard.classList.add('hidden');
    els.banner.classList.add('hidden');
    els.actions.classList.add('hidden');
    els.discardBtn.classList.add('hidden');
    els.notesCount.textContent = '0';
    els.chunks.innerHTML = '<div class="placeholder">No video selected.</div>';
    return;
  }

  els.empty.classList.add('hidden');
  els.videoCard.classList.remove('hidden');
  els.actions.classList.remove('hidden');
  els.vcTitle.textContent = state.meta?.title || 'YouTube video';
  els.vcMeta.textContent = state.meta?.channel || '';

  const hasChunks = state.chunks.length > 0;
  const busy = state.saving || state.instanting;
  const showBanner = hasChunks && !state.captureActive && !busy;
  els.banner.classList.toggle('hidden', !showBanner);

  if (state.captureActive) {
    els.primaryBtn.textContent = 'Stop capture';
    els.primaryBtn.className = 'btn btn-block btn-danger';
  } else if (hasChunks) {
    els.primaryBtn.textContent = 'Resume capture';
    els.primaryBtn.className = 'btn btn-block btn-primary';
  } else {
    els.primaryBtn.textContent = 'Start capture';
    els.primaryBtn.className = 'btn btn-block btn-primary';
  }
  els.primaryBtn.disabled = busy;

  els.saveBtn.classList.toggle('hidden', !hasChunks);
  els.saveBtn.disabled = busy;
  els.saveBtn.textContent = state.saving ? 'Saving…' : 'Save to Obsidian';

  els.instantBtn.disabled = busy || state.captureActive;
  els.instantBtn.textContent = state.instanting ? 'Generating…' : 'Generate instant notes';

  els.discardBtn.classList.toggle('hidden', !hasChunks);
  els.discardBtn.disabled = busy;

  els.notesCount.textContent = String(state.chunks.length);
  if (state.chunks.length === 0) {
    els.chunks.innerHTML = state.captureActive
      ? '<div class="placeholder">Notes will appear as you watch.</div>'
      : '<div class="placeholder">Press Start capture or Generate instant notes.</div>';
  } else {
    els.chunks.innerHTML = '';
    for (const c of state.chunks) {
      const div = document.createElement('div');
      div.className = 'chunk';
      const meta = document.createElement('div');
      meta.className = 'chunk-meta';
      const tspan = document.createElement('span');
      tspan.className = 'chunk-time';
      tspan.textContent = `${fmtTime(c.startSec)} – ${fmtTime(c.endSec)}`;
      const mspan = document.createElement('span');
      mspan.className = 'chunk-model';
      mspan.textContent = c.model || '';
      meta.append(tspan, mspan);
      const body = document.createElement('div');
      body.textContent = c.text;
      div.append(meta, body);
      els.chunks.appendChild(div);
    }
    els.chunks.scrollTop = els.chunks.scrollHeight;
  }
}

function renderHistory() {
  if (state.history.length === 0) {
    els.historyList.innerHTML = '<div class="placeholder">No saved notes yet.</div>';
    return;
  }
  els.historyList.innerHTML = '';
  for (const entry of state.history) {
    const div = document.createElement('div');
    div.className = 'history-entry';
    div.title = 'Click to open the YouTube video';

    const title = document.createElement('div');
    title.className = 'he-title';
    title.textContent = entry.title || 'Untitled';

    const meta = document.createElement('div');
    meta.className = 'he-meta';
    if (entry.channel) {
      const ch = document.createElement('span');
      ch.textContent = entry.channel;
      meta.append(ch, sep());
    }
    const when = document.createElement('span');
    when.textContent = relativeTime(entry.savedAt || Date.now());
    meta.append(when);
    if (entry.model) {
      meta.append(sep());
      const mdl = document.createElement('span');
      mdl.textContent = entry.model;
      meta.append(mdl);
    }
    if (entry.method) {
      meta.append(document.createTextNode(' '));
      const method = document.createElement('span');
      method.className = `he-method ${entry.method}`;
      method.textContent = entry.method;
      meta.append(method);
    }

    const path = document.createElement('div');
    path.className = 'he-path';
    path.textContent = entry.notePath || '';

    div.append(title, meta, path);
    div.addEventListener('click', () => {
      if (entry.videoUrl) chrome.tabs.create({ url: entry.videoUrl });
    });
    els.historyList.append(div);
  }

  function sep() {
    const s = document.createElement('span');
    s.className = 'sep';
    s.textContent = '·';
    return s;
  }
}

function render() {
  renderStatus();
  renderTabs();
  renderCurrent();
  renderHistory();
}

async function setCapture(active) {
  if (!state.videoId || !state.meta) return;
  await writeStored(state.videoId, {
    videoId: state.videoId,
    videoUrl: state.meta.videoUrl,
    title: state.meta.title,
    channel: state.meta.channel,
    captureActive: active,
    chunks: state.chunks,
    createdAt: state.chunks.length === 0 ? Date.now() : undefined
  });
  state.captureActive = active;
  render();
}

els.tabs.forEach(t => {
  t.addEventListener('click', () => {
    state.tab = t.dataset.tab;
    render();
  });
});

els.primaryBtn.addEventListener('click', async () => {
  await setCapture(!state.captureActive);
});

els.saveBtn.addEventListener('click', async () => {
  if (!state.videoId) return;
  if (state.captureActive) await setCapture(false);
  state.saving = true;
  render();
  const res = await chrome.runtime.sendMessage({ type: 'FINALIZE', videoId: state.videoId });
  state.saving = false;
  if (res?.error) {
    alert(`Could not save: ${res.error}`);
    render();
  } else {
    alert(`Saved to ${res.path}` + (res.model ? `\n(via ${res.model})` : ''));
    await refresh();
  }
});

els.instantBtn.addEventListener('click', async () => {
  if (!state.videoId || !state.meta) return;
  state.instanting = true;
  render();
  const res = await chrome.runtime.sendMessage({
    type: 'INSTANT_NOTES',
    videoId: state.videoId,
    videoUrl: state.meta.videoUrl,
    title: state.meta.title,
    channel: state.meta.channel
  });
  state.instanting = false;
  if (res?.error) {
    alert(`Instant notes failed: ${res.error}`);
    render();
  } else {
    alert(`Saved to ${res.path}` + (res.model ? `\n(via ${res.model})` : ''));
    await refresh();
  }
});

els.discardBtn.addEventListener('click', async () => {
  if (!state.videoId) return;
  if (!confirm('Discard all captured notes for this video?')) return;
  await chrome.runtime.sendMessage({ type: 'DISCARD', videoId: state.videoId });
  await refresh();
});

els.clearHistoryBtn.addEventListener('click', async () => {
  if (state.history.length === 0) return;
  if (!confirm(`Clear all ${state.history.length} history entries? Your Obsidian notes stay; only Cinder's history list is cleared.`)) return;
  await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
  await refresh();
});

els.banner.addEventListener('click', (e) => {
  const action = e.target?.dataset?.action;
  if (!action) return;
  if (action === 'resume') els.primaryBtn.click();
  else if (action === 'finalize') els.saveBtn.click();
  else if (action === 'discard') els.discardBtn.click();
});

els.openOptions.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CHUNK_READY' && msg.videoId === state.videoId) refresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (state.videoId && changes[STORAGE_PREFIX + state.videoId]) refresh();
  if (changes[HISTORY_KEY]) refresh();
});

chrome.tabs.onActivated.addListener(refresh);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.status === 'complete') refresh();
});

refresh();
