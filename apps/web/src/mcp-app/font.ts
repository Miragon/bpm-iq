/**
 * The bpmn icon font, CSP-proof. MCP-App hosts run the iframe under a strict
 * CSP whose font-src blocks even data: URLs, so the @font-face in bpmn.css
 * never loads there (palette/context-pad show tofu). A FontFace constructed
 * from an ArrayBuffer is no URL load — no CSP directive applies.
 *
 * The woff2 bytes are NOT bundled twice: the inlined bpmn.css already carries
 * them as a data: URI, so we read that rule back from the stylesheet, decode
 * it ourselves (atob, not fetch — a fetch would fall under connect-src) and
 * register the font programmatically. In a plain browser both paths load;
 * same family, no visible difference.
 */
export async function loadBpmnFont(): Promise<void> {
  let dataUri: string | undefined;
  for (const sheet of document.styleSheets) {
    for (const rule of sheet.cssRules) {
      if (rule instanceof CSSFontFaceRule && /\bbpmn\b/i.test(rule.style.getPropertyValue("font-family"))) {
        const src = rule.style.getPropertyValue("src");
        // the src list may carry several formats — FontFace needs a modern one
        dataUri =
          /url\("?(data:font\/woff2[^")]+)"?\)/.exec(src)?.[1] ??
          /url\("?(data:font\/woff[^")]+)"?\)/.exec(src)?.[1] ??
          /url\("?(data:font\/ttf[^")]+)"?\)/.exec(src)?.[1];
        if (dataUri) break;
      }
    }
    if (dataUri) break;
  }
  if (!dataUri) return; // no inlined font rule — nothing to rescue
  const bin = atob(dataUri.slice(dataUri.indexOf("base64,") + 7));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const face = new FontFace("bpmn", bytes.buffer);
  await face.load();
  document.fonts.add(face);
}
