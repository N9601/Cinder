function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function chunkPrompt({ title, startSec, endSec }) {
  return `You are processing a segment of a YouTube video.

Video title: ${title}
Segment: ${fmt(startSec)} – ${fmt(endSec)}

Watch this segment and produce concise, structured notes:
- Pull out key concepts, claims, definitions, examples, and any numbers/citations the speaker gives.
- Use markdown bullet points. No filler like "in this segment the speaker says".
- If the segment introduces a process, hierarchy, or comparison that benefits from a diagram, include a brief Mermaid block. Skip diagrams when prose is sufficient.
- Output markdown only. No preamble, no closing remarks.`;
}

export function finalPrompt({ chunks, title, channel, videoUrl, vaultIndex }) {
  const chunkBody = chunks
    .map((c, i) => `### Segment ${i + 1} (${fmt(c.startSec)} – ${fmt(c.endSec)})\n${c.text}`)
    .join('\n\n');

  const indexSample = vaultIndex
    .slice(0, 500)
    .map(p => `- ${p.replace(/\.md$/, '')}`)
    .join('\n');

  return `You are producing a final, polished Obsidian note that consolidates raw segment-level notes from a YouTube video.

Video: ${title}
Channel: ${channel}
URL: ${videoUrl}

EXISTING VAULT NOTES (only link to titles that appear in this list):
${indexSample || '(vault index unavailable — do not invent wikilinks)'}

RAW SEGMENT NOTES:
${chunkBody}

Produce a single markdown note with:
- A YAML frontmatter block with: title, channel, source (the video URL), date (leave as a placeholder \`{{date}}\`), and tags inferred from content.
- Clear top-level headings reflecting the actual structure of the video, not segment numbers.
- Bullet points and short prose. No walls of text.
- Mermaid diagrams (flowchart/sequence) where they aid comprehension. Do not invent diagrams for content that does not benefit.
- Wherever a concept matches an existing vault note from the list above, link it as [[Exact Note Title]]. Do NOT invent links to notes that aren't in the list.
- A "Related" section at the bottom listing the [[wikilinks]] you used.

Output the markdown note only, with no surrounding commentary or code fences around the whole thing.`;
}
