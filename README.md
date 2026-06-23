# Cinder

YouTube → Obsidian notes, via Gemini. A Chrome extension that captures YouTube videos on command, sends them to Gemini for structured note generation, and saves the result into your Obsidian vault with `[[wikilinks]]` back to notes you already have.

## What it does

When you click **Start capture** on a YouTube video, Cinder:

1. Tracks watched-time as you play forward (scrubs and pauses don't count).
2. Every N minutes (configurable; 5 by default) sends the YouTube URL + clip range directly to Gemini. Gemini processes the actual audio and visuals — no separate transcription step.
3. Stores the segment notes in the side panel as you watch.
4. When you click **Save to Obsidian**, runs a final pass that consolidates every chunk into one polished note (YAML frontmatter, headings, Mermaid diagrams where they help, `[[wikilinks]]` to notes that already exist in your vault).
5. Writes the note into your chosen inbox folder via the **Local REST API** community plugin.

If you walk away mid-video your captured chunks are preserved in `chrome.storage.local`. Next time you open that video the panel offers Resume / Save now / Discard.

## Why "on command"

Cinder explicitly does **not** record every video you open — that would burn through API quota on entertainment you don't want notes for. Detection is passive; capture is opt-in per video.

## Architecture

```
Cinder/
├── manifest.json
├── icons/                  # toolbar icons + brand SVG
├── src/
│   ├── background/
│   │   └── worker.js       # service worker: chunk → Gemini → store; finalize → vault index → save
│   ├── content/
│   │   └── youtube.js      # passive video detection + watched-time tracker
│   ├── sidepanel/          # side panel UI (dark, capture controls, chunk display)
│   ├── options/            # settings page
│   └── lib/
│       ├── gemini.js       # Gemini REST client with model-fallback chain
│       ├── obsidian.js     # Local REST API client (vault index walker + saveNote)
│       └── prompts.js      # chunk + final-pass prompt templates
└── tools/
    └── render-icons.js     # re-rasterize PNG icons after logo edits
```

Communication: content script ⇄ service worker via `chrome.runtime` messages; side panel reads/writes capture state through `chrome.storage.local` so the content script can pick it up without round-tripping the worker.

## Setup

### 1. Install the Obsidian plugin

Install **Local REST API with MCP** (by Adam Coddington) from Obsidian's community plugins.
In its settings:
- Enable the **non-encrypted HTTP** server (Chrome extensions struggle with the self-signed HTTPS cert).
- Copy the API key.

### 2. Get a Gemini API key

[Google AI Studio → Create API key](https://aistudio.google.com/app/apikey). Worth putting Cinder in its own Google Cloud project so you can budget-cap it independently.

### 3. Load the extension

- `chrome://extensions`
- Toggle **Developer mode** on (top right)
- **Load unpacked** → select this `Cinder/` folder
- Pin the Cinder icon to the toolbar

### 4. Configure

Open Cinder's options page (right-click the toolbar icon → Options) and fill in:

| Setting | Notes |
|---|---|
| Gemini API key | from step 2 |
| Chunk model | runs every chunk during playback — pick a fast model |
| Final model | one call when you save — pick your strongest |
| Obsidian Local REST URL | `http://127.0.0.1:27123` after enabling HTTP in the plugin |
| Obsidian API token | from step 1 |
| Inbox folder | must already exist in your vault |
| Chunk interval (min) | watched-time per chunk; lower = faster feedback, more API calls |

Both model fields are dropdowns, but Cinder auto-expands your choice into a fallback chain — if the primary hits a rate limit or quota, it tries the next-best automatically.

## Usage

1. Open a YouTube video.
2. Click the Cinder icon → side panel opens.
3. Click **Start capture** — status pill goes orange and pulses.
4. Watch normally. Notes appear in the panel every N minutes of forward play.
5. Click **Save to Obsidian** — final consolidated note is written to your inbox folder. Chunks are cleared.

## Data & cost

- **Sent to Gemini**: YouTube URL + clip timestamp ranges + the prompt. No personal vault content goes to Gemini at chunk time.
- **Sent to Gemini at finalize**: also the list of titles of notes already in your vault (so it can pick valid `[[wikilinks]]`).
- **Written to Obsidian**: only the final markdown note, only on Save.
- **Cost**: roughly one chunk-model call per N minutes watched, plus one final-model call per saved note. Tune the chunk interval to your budget.

## Development

Edit the source files in place — Chrome MV3 hot-reloads via the refresh icon on the `chrome://extensions` card.

After editing `icons/logo.svg`, regenerate the PNG icons:

```bash
cd tools
npm install --no-save sharp
node render-icons.js
```

## Known caveats (v0.1)

- **Gemini's `video_metadata` clip-range field format** hasn't been verified end-to-end against current Gemini docs. If the very first chunk call errors with a 400 about `video_metadata`, this is suspect #1.
- **Obsidian vault index walker** assumes the REST plugin returns `{ files: [...] }` with trailing `/` for folders. Untested on large/deeply-nested vaults.
- **16px toolbar icon** is recognizable but thin. A 16-px-optimized SVG with thicker strokes would render sharper.
- **Other platforms** (Udemy, Coursera) aren't supported yet — they're auth-gated so Gemini can't fetch the video by URL. Would need tab-audio capture + Whisper.

## License

Personal project, no license declared. Don't redistribute without asking.
