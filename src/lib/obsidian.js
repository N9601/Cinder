// Obsidian Local REST API client.
// Plugin: https://github.com/coddingtonbear/obsidian-local-rest-api
// Default base URLs: https://127.0.0.1:27124 (HTTPS, self-signed)
//                    http://127.0.0.1:27123  (HTTP, if enabled in plugin settings)

function cleanToken(raw) {
  // Tolerate the user pasting the full Authorization header value
  // ("Bearer xyz…") or accidentally including quotes/whitespace.
  return String(raw || '').trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '');
}

async function obsFetch(baseUrl, token, path, opts = {}) {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${cleanToken(token)}`,
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Obsidian ${res.status}: ${text.slice(0, 300)}`);
  }
  return res;
}

// Recursively walks the vault and returns a flat list of all .md note paths.
// We cap traversal depth and total entries to keep things responsive even on
// big vaults; the final-pass prompt only needs a sample for [[wikilink]] hints.
export async function getVaultIndex({ baseUrl, token, maxDepth = 6, maxEntries = 2000 }) {
  const collected = [];

  async function walk(folderPath, depth) {
    if (depth > maxDepth || collected.length >= maxEntries) return;
    const safePath = folderPath.split('/').map(encodeURIComponent).join('/');
    const res = await obsFetch(baseUrl, token, `/vault/${safePath}`, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
    const data = await res.json();
    for (const entry of data.files || []) {
      if (collected.length >= maxEntries) return;
      if (entry.endsWith('/')) {
        await walk(`${folderPath}${entry}`, depth + 1);
      } else if (entry.toLowerCase().endsWith('.md')) {
        collected.push(`${folderPath}${entry}`);
      }
    }
  }

  await walk('', 0);
  return collected;
}

export async function saveNote({ baseUrl, token, path, content }) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  await obsFetch(baseUrl, token, `/vault/${encoded}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/markdown' },
    body: content
  });
}
