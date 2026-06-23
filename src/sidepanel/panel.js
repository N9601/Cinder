const STORAGE_PREFIX = 'cinder_video_';
const $ = (id) => document.getElementById(id);

const els = {
  statusPill: $('status-pill'),
  statusLabel: $('status-label'),
  empty: $('empty-state'),
  videoCard: $('video-card'),
  vcTitle: $('vc-title'),
  vcMeta: $('vc-meta'),
  banner: $('resume-banner'),
  actions: $('actions'),
  primaryBtn: $('primary-btn'),
  saveBtn: $('save-btn'),
  notesCount: $('notes-count'),
  chunks: $('chunks'),
  discardBtn: $('discard-btn'),
  openOptions: $('open-options')
};

const state = {
  videoId: null,
  meta: null,        // { title, channel, videoUrl }
  chunks: [],
  captureActive: false,
  saving: false
};

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
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

async function refresh() {
  const { tab, videoId } = await readActiveVideo();
  state.videoId = videoId;

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

function render() {
  let pillState = 'idle';
  let pillLabel = 'Idle';
  if (state.saving) { pillState = 'saving'; pillLabel = 'Saving…'; }
  else if (state.captureActive) { pillState = 'capturing'; pillLabel = 'Capturing'; }
  els.statusPill.dataset.state = pillState;
  els.statusLabel.textContent = pillLabel;

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
  const showBanner = hasChunks && !state.captureActive && !state.saving;
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
  els.primaryBtn.disabled = state.saving;

  els.saveBtn.classList.toggle('hidden', !hasChunks);
  els.saveBtn.disabled = state.saving;
  els.saveBtn.textContent = state.saving ? 'Saving…' : 'Save to Obsidian';
  els.discardBtn.classList.toggle('hidden', !hasChunks);
  els.discardBtn.disabled = state.saving;

  els.notesCount.textContent = String(state.chunks.length);
  if (state.chunks.length === 0) {
    els.chunks.innerHTML = state.captureActive
      ? '<div class="placeholder">Notes will appear as you watch.</div>'
      : '<div class="placeholder">Press Start capture to begin taking notes.</div>';
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

els.primaryBtn.addEventListener('click', async () => {
  await setCapture(!state.captureActive);
});

els.saveBtn.addEventListener('click', async () => {
  if (!state.videoId) return;
  // Auto-stop capture before saving so the content script flushes any partial.
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

els.discardBtn.addEventListener('click', async () => {
  if (!state.videoId) return;
  if (!confirm('Discard all captured notes for this video?')) return;
  await chrome.runtime.sendMessage({ type: 'DISCARD', videoId: state.videoId });
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
  if (area !== 'local' || !state.videoId) return;
  if (changes[STORAGE_PREFIX + state.videoId]) refresh();
});

chrome.tabs.onActivated.addListener(refresh);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.status === 'complete') refresh();
});

refresh();
