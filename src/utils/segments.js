// GSM-7 basic table — all chars here cost 1 character
const GSM7_BASIC = new Set('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà');
// GSM-7 extended table — each of these costs 2 characters (escape + char)
const GSM7_EXTENDED = new Set('\f^{}\\[~]|€');

export function sanitizeForGSM7(text) {
  if (!text) return text;
  // Strip leading/trailing invisible chars from clipboard (zero-width space U+200B, BOM U+FEFF,
  // soft hyphen U+00AD, non-breaking space U+00A0, zero-width non-joiner/joiner U+200C/D)
  const trimmed = text.replace(/^[\s ​‌‍﻿­]+|[\s ​‌‍﻿­]+$/g, '');
  const replaced = trimmed
    .replace(/[‘’‚′ʼ]/g, "'")   // smart single quotes → '
    .replace(/[“”„″]/g, '"')           // smart double quotes → "
    .replace(/[—―‒]/g, '-')                 // em/figure dash → -
    .replace(/–/g, '-')                               // en dash → -
    .replace(/…/g, '...')                             // ellipsis → ...
    .replace(/ /g, ' ')                               // non-breaking space → space
    .replace(/•/g, '*')                               // bullet → *
    .replace(/·/g, '.')                               // middle dot → .
    .replace(/[‐‑]/g, '-');                      // hyphen variants → -
  // Replace any remaining non-GSM7 chars with '?', then final trim for any leftover edge whitespace
  return [...replaced].map(c => (GSM7_BASIC.has(c) || GSM7_EXTENDED.has(c) ? c : '?')).join('').trim();
}

export function analyzeMessage(text) {
  if (!text) return { chars: 0, encodedLen: 0, segments: 1, isGsm: true, limit: 160, hasExtended: false };

  let encodedLen = 0;
  let hasExtended = false;
  let isGsm = true;

  for (const c of text) {
    if (GSM7_EXTENDED.has(c)) {
      encodedLen += 2;
      hasExtended = true;
    } else if (GSM7_BASIC.has(c)) {
      encodedLen += 1;
    } else {
      isGsm = false;
      break;
    }
  }

  const chars = [...text].length;

  if (!isGsm) {
    const limit = 70;
    const segments = chars <= limit ? 1 : Math.ceil(chars / 67);
    return { chars, encodedLen: chars, segments, isGsm: false, limit, hasExtended: false };
  }

  const limit = 160;
  const segments = encodedLen <= limit ? 1 : Math.ceil(encodedLen / 153);
  return { chars, encodedLen, segments, isGsm: true, limit, hasExtended };
}
