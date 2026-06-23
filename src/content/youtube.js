// Cinder content script.
//
// Two modes, both running continuously:
// - Passive detection: whenever a YouTube watch URL is loaded, report the
//   videoId + metadata to the background worker so the side panel knows what
//   the user is on. This costs nothing — no API calls.
// - Active capture: only runs when this video's `captureActive` flag is set in
//   chrome.storage.local (the side panel writes it). When active, watched-time
//   (forward play only) is tracked and chunks fire to the worker every N min.

(function () {
  if (window.__cinderInjected) return;
  window.__cinderInjected = true;
  console.log('[Cinder] content script injected on', location.href);

  // If the extension is reloaded while this tab is open, our chrome.runtime
  // handle becomes invalid. Stop ticking instead of throwing every 2 seconds.
  function isContextDead() {
    return !chrome.runtime?.id;
  }

  const STORAGE_PREFIX = 'cinder_video_';
  const DEFAULT_CHUNK_MIN = 5;

  let chunkLengthSec = DEFAULT_CHUNK_MIN * 60;
  let currentVideoId = null;
  let captureActive = false;

  // Tracker state — only meaningful when captureActive is true.
  let lastWallMs = null;
  let lastPlayerSec = null;
  let watchedAccumSec = 0;
  let chunkStartSec = 0;

  chrome.storage.local.get('settings').then(({ settings = {} }) => {
    if (settings.chunkMinutes) chunkLengthSec = Number(settings.chunkMinutes) * 60;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings?.newValue?.chunkMinutes) {
      chunkLengthSec = Number(changes.settings.newValue.chunkMinutes) * 60;
    }
    if (currentVideoId) {
      const key = STORAGE_PREFIX + currentVideoId;
      if (changes[key]) {
        const newActive = !!changes[key].newValue?.captureActive;
        if (newActive !== captureActive) onCaptureToggle(newActive);
      }
    }
  });

  function videoIdFromUrl(href) {
    try { return new URL(href).searchParams.get('v'); } catch { return null; }
  }

  function pageMeta() {
    const titleEl = document.querySelector(
      'h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string'
    );
    const channelEl = document.querySelector('ytd-channel-name a, #channel-name a');
    return {
      title: (titleEl?.textContent || document.title.replace(/ - YouTube$/, '')).trim(),
      channel: (channelEl?.textContent || '').trim()
    };
  }

  function getPlayer() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  function resetTracker(playerSec) {
    lastWallMs = null;
    lastPlayerSec = null;
    watchedAccumSec = 0;
    chunkStartSec = playerSec ?? 0;
  }

  function onCaptureToggle(active) {
    captureActive = active;
    if (active) {
      resetTracker(getPlayer()?.currentTime ?? 0);
    } else {
      flushPartial();
      resetTracker(0);
    }
  }

  async function reportVideo(videoId) {
    const { title, channel } = pageMeta();
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    chrome.runtime.sendMessage({
      type: 'VIDEO_DETECTED',
      videoId, videoUrl, title, channel
    }).catch(() => {});
    // Sync our local captureActive with whatever the worker just wrote.
    const r = await chrome.storage.local.get(STORAGE_PREFIX + videoId);
    captureActive = !!r[STORAGE_PREFIX + videoId]?.captureActive;
  }

  async function onVideoChanged(newId) {
    currentVideoId = newId;
    resetTracker(0);
    if (newId) await reportVideo(newId);
    else captureActive = false;
  }

  function emitChunk(t0, t1) {
    if (!currentVideoId) return;
    const { title, channel } = pageMeta();
    chrome.runtime.sendMessage({
      type: 'CHUNK',
      videoId: currentVideoId,
      videoUrl: `https://www.youtube.com/watch?v=${currentVideoId}`,
      title, channel,
      startSec: Math.max(0, Math.floor(t0)),
      endSec: Math.max(0, Math.floor(t1))
    }).catch(() => {});
  }

  function tick() {
    if (isContextDead()) return;
    const id = videoIdFromUrl(location.href);
    if (id !== currentVideoId) { onVideoChanged(id); return; }
    if (!id || !captureActive) return;

    const player = getPlayer();
    if (!player || player.paused || player.ended) {
      lastWallMs = null;
      lastPlayerSec = null;
      return;
    }

    const now = performance.now();
    const playerSec = player.currentTime;

    if (lastWallMs !== null && lastPlayerSec !== null) {
      const wallDelta = (now - lastWallMs) / 1000;
      const playerDelta = playerSec - lastPlayerSec;
      // Accept forward play up to ~4x speed; anything bigger is a scrub.
      if (playerDelta > 0 && playerDelta < wallDelta * 4 + 0.5) {
        watchedAccumSec += playerDelta;
      } else {
        chunkStartSec = playerSec;
        watchedAccumSec = 0;
      }
    } else {
      chunkStartSec = playerSec;
    }

    lastWallMs = now;
    lastPlayerSec = playerSec;

    if (watchedAccumSec >= chunkLengthSec) {
      const t0 = chunkStartSec;
      const t1 = playerSec;
      watchedAccumSec = 0;
      chunkStartSec = playerSec;
      emitChunk(t0, t1);
    }
  }

  function flushPartial() {
    if (captureActive && watchedAccumSec > 30 && currentVideoId) {
      const player = getPlayer();
      const t1 = player ? player.currentTime : chunkStartSec + watchedAccumSec;
      emitChunk(chunkStartSec, t1);
      watchedAccumSec = 0;
      chunkStartSec = t1;
    }
  }

  setInterval(tick, 2000);

  window.addEventListener('beforeunload', flushPartial);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPartial();
  });

  const player = getPlayer();
  if (player) player.addEventListener('ended', flushPartial);

  // Initial run — detect right away rather than waiting 2s.
  const initialId = videoIdFromUrl(location.href);
  if (initialId) onVideoChanged(initialId);
})();
