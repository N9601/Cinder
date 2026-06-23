import { processChunk, processFinal } from '../lib/gemini.js';
import { getVaultIndex, saveNote } from '../lib/obsidian.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

const STORAGE_PREFIX = 'cinder_video_';
const keyFor = (videoId) => `${STORAGE_PREFIX}${videoId}`;

const DEFAULT_CHUNK_CHAIN = ['gemini-2.5-flash'];
const DEFAULT_FINAL_CHAIN = ['gemini-2.5-pro', 'gemini-2.5-flash'];

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return settings;
}

function parseChain(raw, fallback) {
  if (!raw) return fallback;
  const arr = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  return arr.length ? arr : fallback;
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
  const models = parseChain(settings.geminiModel, DEFAULT_CHUNK_CHAIN);
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

  const finalChain = parseChain(
    settings.geminiFinalModel,
    parseChain(settings.geminiModel, DEFAULT_FINAL_CHAIN)
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

  await clearVideo(videoId);
  return { ok: true, path, model: finalModel };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'VIDEO_DETECTED': sendResponse(await handleVideoDetected(msg)); break;
        case 'CHUNK':          sendResponse(await handleChunk(msg)); break;
        case 'FINALIZE':       sendResponse(await handleFinalize(msg)); break;
        case 'DISCARD':        await clearVideo(msg.videoId); sendResponse({ ok: true }); break;
        case 'GET_VIDEO':      sendResponse(await loadVideo(msg.videoId)); break;
        default:               sendResponse({ error: 'Unknown message type' });
      }
    } catch (err) {
      sendResponse({ error: String(err?.message || err) });
    }
  })();
  return true;
});
