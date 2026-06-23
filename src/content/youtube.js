// Cinder content script: detects YouTube watch pages, tracks watched-time
// (forward play only — pauses and scrubs don't accumulate), and fires chunk
// events to the background worker at the configured interval.

(function () {
  if (window.__cinderInjected) return;
  window.__cinderInjected = true;

  const DEFAULT_CHUNK_MIN = 5;
  let chunkLengthSec = DEFAULT_CHUNK_MIN * 60;

  chrome.storage.local.get('settings').then(({ settings = {} }) => {
    if (settings.chunkMinutes) chunkLengthSec = Number(settings.chunkMinutes) * 60;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings?.newValue?.chunkMinutes) {
      chunkLengthSec = Number(changes.settings.newValue.chunkMinutes) * 60;
    }
  });

  let currentVideoId = null;
  let lastWallMs = null;
  let lastPlayerSec = null;
  let watchedAccumSec = 0;
  let chunkStartSec = 0;

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

  function startTrackingForVideo(videoId) {
    currentVideoId = videoId;
    resetTracker(0);
  }

  function emitChunk(t0, t1) {
    const { title, channel } = pageMeta();
    chrome.runtime.sendMessage({
      type: 'CHUNK',
      videoId: currentVideoId,
      videoUrl: `https://www.youtube.com/watch?v=${currentVideoId}`,
      title,
      channel,
      startSec: Math.max(0, Math.floor(t0)),
      endSec: Math.max(0, Math.floor(t1))
    }).catch(() => {});
  }

  function tick() {
    const id = videoIdFromUrl(location.href);
    if (!id) { currentVideoId = null; return; }
    if (id !== currentVideoId) startTrackingForVideo(id);

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
        // Scrub or seek: re-baseline the chunk start without emitting.
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

  setInterval(tick, 2000);

  // Flush leftover progress as a final partial chunk when the user leaves.
  function flushPartial() {
    if (watchedAccumSec > 30 && currentVideoId) {
      const player = getPlayer();
      const t1 = player ? player.currentTime : chunkStartSec + watchedAccumSec;
      emitChunk(chunkStartSec, t1);
      watchedAccumSec = 0;
      chunkStartSec = t1;
    }
  }

  window.addEventListener('beforeunload', flushPartial);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPartial();
  });

  const player = getPlayer();
  if (player) player.addEventListener('ended', flushPartial);
})();
