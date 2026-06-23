const $title = document.getElementById('video-title');
const $banner = document.getElementById('resume-banner');
const $chunks = document.getElementById('chunks');
const $finalize = document.getElementById('finalize-btn');
const $discard = document.getElementById('discard-btn');
const $options = document.getElementById('open-options');

let currentVideoId = null;

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function renderChunks(chunks) {
  $chunks.innerHTML = '';
  if (!chunks?.length) {
    const p = document.createElement('div');
    p.className = 'placeholder';
    p.textContent = 'Notes will appear here as you watch.';
    $chunks.appendChild(p);
    return;
  }
  for (const c of chunks) {
    const div = document.createElement('div');
    div.className = 'chunk';
    const head = document.createElement('div');
    head.className = 'chunk-time';
    head.textContent = `${fmtTime(c.startSec)} – ${fmtTime(c.endSec)}`;
    const body = document.createElement('div');
    body.textContent = c.text;
    div.append(head, body);
    $chunks.appendChild(div);
  }
  $chunks.scrollTop = $chunks.scrollHeight;
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let videoId = null;
  try {
    if (tab?.url) videoId = new URL(tab.url).searchParams.get('v');
  } catch { /* not a watch URL */ }

  currentVideoId = videoId;

  if (!videoId) {
    $title.textContent = 'No YouTube video detected.';
    $banner.classList.add('hidden');
    $finalize.disabled = true;
    $discard.disabled = true;
    renderChunks([]);
    return;
  }

  const stored = await chrome.runtime.sendMessage({ type: 'GET_VIDEO', videoId });
  if (!stored) {
    $title.textContent = tab.title?.replace(/ - YouTube$/, '') || 'YouTube video';
    $banner.classList.add('hidden');
    $finalize.disabled = true;
    $discard.disabled = true;
    renderChunks([]);
    return;
  }

  $title.textContent = stored.title;
  const hasChunks = stored.chunks?.length > 0;
  $finalize.disabled = !hasChunks;
  $discard.disabled = !hasChunks;

  const minutesAgo = (Date.now() - (stored.lastUpdated || stored.createdAt)) / 60000;
  const isFresh = minutesAgo < 5;
  $banner.classList.toggle('hidden', isFresh || !hasChunks);
  renderChunks(stored.chunks);
}

$finalize.addEventListener('click', async () => {
  if (!currentVideoId) return;
  const originalText = $finalize.textContent;
  $finalize.disabled = true;
  $finalize.textContent = 'Saving…';
  const res = await chrome.runtime.sendMessage({ type: 'FINALIZE', videoId: currentVideoId });
  if (res?.error) {
    alert(`Could not save: ${res.error}`);
    $finalize.disabled = false;
  } else {
    alert(`Saved to: ${res.path}`);
    refresh();
  }
  $finalize.textContent = originalText;
});

$discard.addEventListener('click', async () => {
  if (!currentVideoId) return;
  if (!confirm('Discard all captured chunks for this video?')) return;
  await chrome.runtime.sendMessage({ type: 'DISCARD', videoId: currentVideoId });
  refresh();
});

$banner.addEventListener('click', (e) => {
  const action = e.target?.dataset?.action;
  if (!action) return;
  if (action === 'resume') $banner.classList.add('hidden');
  if (action === 'finalize') $finalize.click();
  if (action === 'discard') $discard.click();
});

$options.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CHUNK_READY' && msg.videoId === currentVideoId) refresh();
});

chrome.tabs.onActivated.addListener(refresh);
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.url || info.status === 'complete') refresh();
});

refresh();
