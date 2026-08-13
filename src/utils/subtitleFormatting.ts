const SAFE_COLOR_PATTERN = '#[0-9a-f]{6}';

const SUBTITLE_HTML_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: '\u00a0',
  quot: '"',
});

function decodeHtmlCharacterReferences(value: string): string {
  return value.replace(
    /&(?:#([0-9]{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]+));/gi,
    (match, decimal: string | undefined, hexadecimal: string | undefined, name: string | undefined) => {
      if (name) return SUBTITLE_HTML_ENTITIES[name.toLowerCase()] ?? match;

      const codePoint = Number.parseInt(decimal ?? hexadecimal ?? '', decimal ? 10 : 16);
      if (!Number.isSafeInteger(codePoint)
          || codePoint <= 0
          || codePoint > 0x10ffff
          || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return match;
      return String.fromCodePoint(codePoint);
    },
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeSubtitleLines(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .flatMap((line) => {
      const trimmedLine = line.trim();
      if (!trimmedLine) return [];

      // SRT/VTT files regularly put two speakers on the same cue. Only split
      // later dashes when the cue is explicitly formatted as dialogue.
      if (/^-\s+/.test(trimmedLine)) {
        return trimmedLine.replace(/\s+-\s+(?=\S)/g, '\n- ').split('\n');
      }

      return [trimmedLine];
    })
    .join('\n');
}

function renderAssFormattingBlock(block: string, body: string): string {
  const commands = body.split('\\').filter(Boolean);
  if (commands.length === 0) return block;

  const tags: string[] = [];
  for (const rawCommand of commands) {
    const command = rawCommand.trim();
    const style = /^(b|i|u)(0|1)$/i.exec(command);
    if (style) {
      const tag = style[1].toLowerCase();
      tags.push(style[2] === '1' ? `<${tag}>` : `</${tag}>`);
      continue;
    }

    // These ASS commands affect placement or reset styles. The custom player
    // cannot reproduce them, so do not expose the implementation marker.
    if (/^(?:an[1-9]|a\d+|q\d+|r.*)$/i.test(command)) continue;

    // Unknown blocks stay visible and escaped; they never expand the allowlist.
    return block;
  }

  return tags.join('');
}

/** Converts subtitle markup to a deliberately small, safe HTML subset. */
export function formatSubtitleTextToSafeHtml(value: string): string {
  // Decode text entities first, then escape everything. Only exact subtitle
  // patterns below can produce HTML, including when upstream sends &lt; tags.
  const decodedText = decodeHtmlCharacterReferences(String(value ?? ''));
  let safeHtml = escapeHtml(normalizeSubtitleLines(decodedText));

  safeHtml = safeHtml
    .replace(/\{(\\[^{}]+)\}/g, (block, body: string) => renderAssFormattingBlock(block, body))
    .replace(/\\N/gi, '<br>');

  // Colors must be paired and use exactly six hexadecimal digits. No other
  // attributes or free-form CSS are accepted.
  const bbColor = new RegExp(`\\[color=(${SAFE_COLOR_PATTERN})\\]([\\s\\S]*?)\\[\\/color\\]`, 'gi');
  safeHtml = safeHtml.replace(bbColor, (_match, color: string, content: string) => (
    `<span style="color:${color}">${content}</span>`
  ));

  const htmlColor = new RegExp(
    `&lt;font\\s+color=(?:&quot;|')(${SAFE_COLOR_PATTERN})(?:&quot;|')&gt;([\\s\\S]*?)&lt;\\/font&gt;`,
    'gi',
  );
  safeHtml = safeHtml.replace(htmlColor, (_match, color: string, content: string) => (
    `<span style="color:${color}">${content}</span>`
  ));

  safeHtml = safeHtml
    .replace(/&lt;(\/?)(b|i|u)&gt;/gi, (_match, slash: string, tag: string) => (
      `<${slash}${tag.toLowerCase()}>`
    ))
    .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
    .replace(/\[(\/)?(b|i|u)\]/gi, (_match, slash: string | undefined, tag: string) => (
      `<${slash ? '/' : ''}${tag.toLowerCase()}>`
    ))
    .replace(/\[br\]/gi, '<br>')
    .replace(/\n/g, '<br>');

  return safeHtml;
}
