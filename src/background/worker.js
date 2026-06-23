import { processChunk, processFinal, processInstant } from '../lib/gemini.js';
import { getVaultIndex, saveNote } from '../lib/obsidian.js';

const HISTORY_KEY = 'cinder_history';
const HISTORY_LIMIT = 100;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

const STORAGE_PREFIX = 'cinder_video_';
const keyFor = (videoId) => `${STORAGE_PREFIX}${videoId}`;

// When the user picks a single model in the options dropdown, expand it to
// a sensible fallback cascade so quota/rate-limit errors don't block the run.
const FALLBACK_CHAINS = {
  'gemini-3-pro':          ['gemini-3-pro', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  'gemini-2.5-pro':        ['gemini-2.5-pro', 'gemini-2.5-flash'],
  'gemini-2.5-flash':      ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  'gemini-2.5-flash-lite': ['gemini-2.5-flash-lite']
};
const DEFAULT_CHUNK_CHAIN = FALLBACK_CHAINS['gemini-2.5-flash'];
const DEFAULT_FINAL_CHAIN = FALLBACK_CHAINS['gemini-3-pro'];

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return settings;
}

function expandChain(primary, defaultChain) {
  if (!primary) return defaultChain;
  // If the value is already comma-separated (legacy format), honor it as-is.
  if (typeof primary === 'string' && primary.includes(',')) {
    const arr = primary.split(',').map(s => s.trim()).filter(Boolean);
    return arr.length ? arr : defaultChain;
  }
  return FALLBACK_CHAINS[primary] || [primary, ...defaultChain.filter(m => m !== primary)];
}

async function loadVideo(videoId) {
  const k = keyFor(videoId);
  const r = await chrome.storage.local.get(k);
  return r[k] || null;
}

async function saveVideo(videoId, data) {
  await chrome.storage.local.set({ [keyFor(videoId)]: data });
}

async function clearVideo(videoId) {
  await chrome.storage.local.remove(keyFor(videoId));
}

async function appendHistory(entry) {
  const r = await chrome.storage.local.get(HISTORY_KEY);
  const history = Array.isArray(r[HISTORY_KEY]) ? r[HISTORY_KEY] : [];
  history.unshift({ ...entry, savedAt: entry.savedAt || Date.now() });
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
  await chrome.storage.local.set({ [HISTORY_KEY]: history });
}

async function loadHistory() {
  const r = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(r[HISTORY_KEY]) ? r[HISTORY_KEY] : [];
}

async function clearHistory() {
  await chrome.storage.local.remove(HISTORY_KEY);
}

async function handleVideoDetected({ videoId, videoUrl, title, channel }) {
  const existing = await loadVideo(videoId);
  const stored = existing || {
    videoId, videoUrl, title, channel,
    chunks: [],
    captureActive: false,
    createdAt: Date.now()
  };
  // Keep metadata fresh in case YT's title/channel finished hydrating after our first read.
  stored.title = title || stored.title;
  stored.channel = channel || stored.channel;
  stored.videoUrl = videoUrl || stored.videoUrl;
  await saveVideo(videoId, stored);
  return { ok: true };
}

async function handleChunk({ videoId, videoUrl, title, channel, startSec, endSec }) {
  const settings = await getSettings();
  if (!settings.geminiKey) {
    return { error: 'Gemini API key not set. Open Cinder options.' };
  }
  const models = expandChain(settings.geminiModel, DEFAULT_CHUNK_CHAIN);
  const { text, model } = await processChunk({
    videoUrl, title, startSec, endSec,
    apiKey: settings.geminiKey,
    models
  });
  const stored = (await loadVideo(videoId)) || {
    videoId, videoUrl, title, channel, chunks: [], captureActive: false, createdAt: Date.now()
  };
  stored.chunks.push({ startSec, endSec, text, model, addedAt: Date.now() });
  stored.lastUpdated = Date.now();
  await saveVideo(videoId, stored);
  chrome.runtime.sendMessage({
    type: 'CHUNK_READY',
    videoId,
    chunk: stored.chunks[stored.chunks.length - 1]
  }).catch(() => {});
  return { ok: true, model };
}

async function handleFinalize({ videoId }) {
  const settings = await getSettings();
  const stored = await loadVideo(videoId);
  if (!stored) return { error: 'No captured chunks for this video.' };
  if (!stored.chunks?.length) return { error: 'Nothing to save — no chunks captured.' };
  if (!settings.geminiKey) return { error: 'Gemini API key not set.' };
  if (!settings.obsidianUrl || !settings.obsidianToken) {
    return { error: 'Obsidian REST URL and token must be set.' };
  }

  let vaultIndex = [];
  try {
    vaultIndex = await getVaultIndex({
      baseUrl: settings.obsidianUrl,
      token: settings.obsidianToken
    });
  } catch (e) {
    return { error: `Vault index fetch failed: ${e.message}` };
  }

  const finalChain = expandChain(
    settings.geminiFinalModel || settings.geminiModel,
    DEFAULT_FINAL_CHAIN
  );

  let finalMarkdown, finalModel;
  try {
    const result = await processFinal({
      chunks: stored.chunks,
      title: stored.title,
      channel: stored.channel,
      videoUrl: stored.videoUrl,
      vaultIndex,
      apiKey: settings.geminiKey,
      models: finalChain
    });
    finalMarkdown = result.text;
    finalModel = result.model;
  } catch (e) {
    return { error: `Final pass failed: ${e.message}` };
  }

  const safeTitle = stored.title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 100).trim() || 'Untitled';
  const folder = (settings.inboxFolder || 'Inbox').replace(/^\/+|\/+$/g, '');
  const path = `${folder}/${safeTitle}.md`;

  try {
    await saveNote({
      baseUrl: settings.obsidianUrl,
      token: settings.obsidianToken,
      path,
      content: finalMarkdown
    });
  } catch (e) {
    return { error: `Obsidian save failed: ${e.message}` };
  }

  await appendHistory({
    videoId, title: stored.title, channel: stored.channel,
    videoUrl: stored.videoUrl, notePath: path, model: finalModel,
    method: 'capture', chunkCount: stored.chunks.length
  });
  await clearVideo(videoId);
  return { ok: true, path, model: finalModel };
}

async function handleInstant({ videoId, videoUrl, title, channel }) {
  const settings = await getSettings();
  if (!settings.geminiKey) return { error: 'Gemini API key not set.' };
  if (!settings.obsidianUrl || !settings.obsidianToken) {
    return { error: 'Obsidian REST URL and token must be set.' };
  }
  if (!videoUrl) return { error: 'No YouTube video URL.' };

  let vaultIndex = [];
  try {
    vaultIndex = await getVaultIndex({
      baseUrl: settings.obsidianUrl,
      token: settings.obsidianToken
    });
  } catch (e) {
    return { error: `Vault index fetch failed: ${e.message}` };
  }

  const finalChain = expandChain(
    settings.geminiFinalModel || settings.geminiModel,
    DEFAULT_FINAL_CHAIN
  );

  let markdown, model;
  try {
    const result = await processInstant({
      videoUrl, title, channel, vaultIndex,
      apiKey: settings.geminiKey,
      models: finalChain
    });
    markdown = result.text;
    model = result.model;
  } catch (e) {
    return { error: `Instant generation failed: ${e.message}` };
  }

  const safeTitle = (title || 'Untitled').replace(/[\\/:*?"<>|]/g, '-').slice(0, 100).trim() || 'Untitled';
  const folder = (settings.inboxFolder || 'Inbox').replace(/^\/+|\/+$/g, '');
  const path = `${folder}/${safeTitle}.md`;

  try {
    await saveNote({
      baseUrl: settings.obsidianUrl,
      token: settings.obsidianToken,
      path,
      content: markdown
    });
  } catch (e) {
    return { error: `Obsidian save failed: ${e.message}` };
  }

  await appendHistory({
    videoId, title, channel, videoUrl,
    notePath: path, model, method: 'instant'
  });
  return { ok: true, path, model };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'VIDEO_DETECTED':  sendResponse(await handleVideoDetected(msg)); break;
        case 'CHUNK':           sendResponse(await handleChunk(msg)); break;
        case 'FINALIZE':        sendResponse(await handleFinalize(msg)); break;
        case 'INSTANT_NOTES':   sendResponse(await handleInstant(msg)); break;
        case 'DISCARD':         await clearVideo(msg.videoId); sendResponse({ ok: true }); break;
        case 'GET_VIDEO':       sendResponse(await loadVideo(msg.videoId)); break;
        case 'GET_HISTORY':     sendResponse(await loadHistory()); break;
        case 'CLEAR_HISTORY':   await clearHistory(); sendResponse({ ok: true }); break;
        default:                sendResponse({ error: 'Unknown message type' });
      }
    } catch (err) {
      sendResponse({ error: String(err?.message || err) });
    }
  })();
  return true;
});
