// Gemini REST API wrapper. Sends a YouTube URL directly as file_data so the
// model processes the actual audio + visuals (no transcription step needed).
// Docs: https://ai.google.dev/gemini-api/docs/video-understanding

import { chunkPrompt, finalPrompt } from './prompts.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function callGemini({ model, apiKey, parts, temperature = 0.4 }) {
  const url = `${BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ parts }],
    generationConfig: { temperature }
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts
    ?.map(p => p.text).filter(Boolean).join('\n') || '';
  if (!text) {
    throw new Error('Gemini returned an empty response.');
  }
  return text;
}

export async function processChunk({ videoUrl, title, startSec, endSec, apiKey, model }) {
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
  return callGemini({ model, apiKey, parts });
}

export async function processFinal({ chunks, title, channel, videoUrl, vaultIndex, apiKey, model }) {
  const parts = [
    { text: finalPrompt({ chunks, title, channel, videoUrl, vaultIndex }) }
  ];
  return callGemini({ model, apiKey, parts, temperature: 0.5 });
}
