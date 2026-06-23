// Gemini REST API wrapper with model-chain fallback.
// Sends a YouTube URL directly as file_data so the model processes the actual
// audio + visuals (no transcription step needed).
// Docs: https://ai.google.dev/gemini-api/docs/video-understanding

import { chunkPrompt, finalPrompt, instantPrompt } from './prompts.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const RETRYABLE_STATUSES = new Set([429, 503]);

async function callOnce({ model, apiKey, parts, temperature = 0.4 }) {
  const url = `${BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = { contents: [{ parts }], generationConfig: { temperature } };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Gemini ${res.status} (${model}): ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    err.model = model;
    throw err;
  }
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts
    ?.map(p => p.text).filter(Boolean).join('\n') || '';
  if (!text) {
    const err = new Error(`Gemini (${model}) returned an empty response.`);
    err.status = 200;
    err.model = model;
    throw err;
  }
  return text;
}

function isFallbackEligible(err) {
  if (RETRYABLE_STATUSES.has(err.status)) return true;
  // 404 — model not available for this key, try the next one.
  if (err.status === 404) return true;
  // 400 sometimes wraps "model not found" or quota messages.
  if (err.status === 400 && /not.?found|unsupported|quota|exhausted/i.test(err.body || '')) return true;
  if (typeof err.body === 'string' && /quota|rate.?limit|exhausted|RESOURCE_EXHAUSTED/i.test(err.body)) return true;
  return false;
}

async function callWithFallback({ models, apiKey, parts, temperature }) {
  if (!models || models.length === 0) {
    throw new Error('No Gemini models configured.');
  }
  const errors = [];
  for (const model of models) {
    try {
      const text = await callOnce({ model, apiKey, parts, temperature });
      return { text, model, skipped: errors.map(e => e.model) };
    } catch (err) {
      errors.push({ model, message: err.message, status: err.status });
      if (!isFallbackEligible(err)) throw err;
    }
  }
  throw new Error(`All Gemini models exhausted: ${errors.map(e => `${e.model}(${e.status})`).join(' → ')}`);
}

export async function processChunk({ videoUrl, title, startSec, endSec, apiKey, models }) {
  const parts = [
    {
      file_data: { file_uri: videoUrl, mime_type: 'video/youtube' },
      video_metadata: {
        start_offset: `${Math.floor(startSec)}s`,
        end_offset: `${Math.floor(endSec)}s`
      }
    },
    { text: chunkPrompt({ title, startSec, endSec }) }
  ];
  return callWithFallback({ models, apiKey, parts });
}

export async function processFinal({ chunks, title, channel, videoUrl, vaultIndex, apiKey, models }) {
  const parts = [
    { text: finalPrompt({ chunks, title, channel, videoUrl, vaultIndex }) }
  ];
  return callWithFallback({ models, apiKey, parts, temperature: 0.5 });
}

export async function processInstant({ videoUrl, title, channel, vaultIndex, apiKey, models }) {
  // No video_metadata clip range — Gemini processes the whole video.
  const parts = [
    { file_data: { file_uri: videoUrl, mime_type: 'video/youtube' } },
    { text: instantPrompt({ title, channel, videoUrl, vaultIndex }) }
  ];
  return callWithFallback({ models, apiKey, parts, temperature: 0.5 });
}
