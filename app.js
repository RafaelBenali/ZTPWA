'use strict';

// --- Character Rules Configuration (Task 2.1) ---
// Updated after Phase 0 zt.ru testing (2026-03-11)
// FAIL: U+2212 (minus), U+20BD (ruble), U+200B (ZWS), U+2033 (double prime),
//       U+FE0F (variation selector), special spaces (tab, thin, em, en),
//       emoji (but NOT (c) (tm) (r) which pass)
// PASS: smart quotes, em/en dash, ellipsis, guillemets, non-breaking space (U+00A0),
//       copyright, trademark, registered, degree, numero, bullet, multiplication,
//       angle brackets, accented Latin, Cyrillic variants
const CHAR_RULES = {
  replacements: {
    '\u2212': '-',      // minus sign → hyphen
    '\u20BD': ' руб.',  // ruble sign → text
    '\u2033': '"',      // double prime → straight double quote
    '\u2009': ' ',      // thin space → regular space
    '\u2003': ' ',      // em space → regular space
    '\u2002': ' ',      // en space → regular space
    '\t':     ' ',      // tab → regular space
  },
  deleteChars: [
    '\u200B', // zero-width space
    '\u200C', // zero-width non-joiner
    '\u200D', // zero-width joiner
    '\uFEFF', // byte order mark
    '\uFE0F', // variation selector (leftover from emoji removal)
    '\uFE0E', // text variation selector
  ],
  // Emoji pattern: match actual emoji but exclude symbols that pass on zt.ru
  // (c) U+00A9, (tm) U+2122, (r) U+00AE are in Extended_Pictographic but pass
  emojiPattern: /(?![\u00A9\u00AE\u2122])[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu,
};

// --- Page Estimate ---
// zt.ru uses rendered pixel height for pagination (server-side).
// 29 lines per page. Line width is proportional-font pixel based, not char-count.
// Tested boundaries (no newlines): RU 2584 = 1 page, 2585 = 2 pages.
// EN 3159 = 1 page. Each newline = 1 forced line.
// Approximation: assign a "width cost" per char, normalize to a line budget.
// RU page budget: 2584 cost units (29 lines * ~89 cost/line)
// EN page budget: 3159 cost units (29 lines * ~109 cost/line)
// Cyrillic chars are ~1.22x wider than Latin (3159/2584 = 1.222)
const PAGE_LINES = 29;
const RU_CHAR_COST = 1.0;
const EN_CHAR_COST = 0.818; // 2584/3159 = 0.818
const LINE_COST = 89; // ~2584 / 29
const PAGE_COST = PAGE_LINES * LINE_COST; // ~2581

function estimatePages(text) {
  if (!text) return { pages: 0, lines: 0 };

  let totalCost = 0;
  const paragraphs = text.split('\n');

  for (let pi = 0; pi < paragraphs.length; pi++) {
    const p = paragraphs[pi];
    if (p.length === 0) {
      totalCost += LINE_COST; // empty line = 1 line
    } else {
      let pCost = 0;
      for (const ch of p) {
        pCost += (ch >= '\u0400' && ch <= '\u04FF') ? RU_CHAR_COST : EN_CHAR_COST;
      }
      totalCost += Math.ceil(pCost / LINE_COST) * LINE_COST;
    }
  }

  const pages = Math.ceil(totalCost / PAGE_COST);
  const lines = Math.round(totalCost / LINE_COST);
  return { pages, lines };
}

// Build lookup sets for fast validation
function buildLookups() {
  const replaceMap = new Map(Object.entries(CHAR_RULES.replacements));
  const deleteSet = new Set(CHAR_RULES.deleteChars);
  return { replaceMap, deleteSet };
}

let lookups = buildLookups();

// --- Validation (Task 2.2) ---
function validateText(text) {
  const results = [];

  // Check single-char replacements and deletes
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (lookups.replaceMap.has(ch)) {
      results.push({ index: i, char: ch, codepoint: ch.codePointAt(0), type: 'replace' });
    } else if (lookups.deleteSet.has(ch)) {
      results.push({ index: i, char: ch, codepoint: ch.codePointAt(0), type: 'delete' });
    }
  }

  // Check emoji pattern
  if (CHAR_RULES.emojiPattern) {
    CHAR_RULES.emojiPattern.lastIndex = 0;
    let match;
    while ((match = CHAR_RULES.emojiPattern.exec(text)) !== null) {
      // Avoid duplicates if already matched by char rules
      if (!results.some((r) => r.index === match.index)) {
        results.push({ index: match.index, char: match[0], codepoint: match[0].codePointAt(0), type: 'delete', length: match[0].length });
      }
    }
  }

  results.sort((a, b) => a.index - b.index);
  return results;
}

// --- Sanitization Engine (Task 4.1) ---
function applyFixes(text) {
  // First, find all invalid chars with their positions
  const invalid = validateText(text);
  if (invalid.length === 0) return { fixedText: text, changes: [] };

  // Build a set of indices to skip (for multi-char emoji, mark all code units)
  const skipIndices = new Map(); // index → invalid entry
  for (const inv of invalid) {
    const len = inv.length || inv.char.length;
    for (let j = 0; j < len; j++) {
      skipIndices.set(inv.index + j, inv);
    }
  }

  const changes = [];
  let fixedChars = [];
  let offset = 0;
  let i = 0;

  while (i < text.length) {
    const inv = skipIndices.get(i);
    if (inv && inv.index === i) {
      const len = inv.length || inv.char.length;
      if (inv.type === 'replace') {
        const replacement = lookups.replaceMap.get(inv.char);
        changes.push({ index: offset, original: inv.char, replacement, type: 'substitution' });
        for (const c of replacement) { fixedChars.push(c); offset++; }
      } else {
        changes.push({ index: offset, original: inv.char, replacement: '', type: 'deletion' });
      }
      i += len;
    } else if (skipIndices.has(i)) {
      // Part of a multi-char sequence already handled
      i++;
    } else {
      fixedChars.push(text[i]);
      offset++;
      i++;
    }
  }

  return { fixedText: fixedChars.join(''), changes };
}

// --- Undo Stack (Task 4.2) ---
const MAX_UNDO = 20;
const undoStack = [];

function pushUndo(text) {
  undoStack.push(text);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function popUndo() {
  return undoStack.pop();
}

function canUndo() {
  return undoStack.length > 0;
}

// --- DOM References ---
const textarea = document.getElementById('textarea');
const overlay = document.getElementById('overlay');
const statusText = document.getElementById('status-text');
const charCount = document.getElementById('char-count');
const btnPaste = document.getElementById('btn-paste');
const btnFix = document.getElementById('btn-fix');
const btnCopy = document.getElementById('btn-copy');
const btnUndo = document.getElementById('btn-undo');
const btnPwa = document.getElementById('btn-pwa');
const pwaModal = document.getElementById('pwa-modal');
const toast = document.getElementById('toast');

// --- State ---
let lastDiffChanges = null; // non-null when showing post-fix diff

// --- Overlay Rendering (Task 3.2) ---
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderOverlay(text, invalidChars, diffChanges) {
  if (!text) {
    overlay.innerHTML = '';
    return;
  }

  // Build a map of index → mark info
  const marks = new Map();    // index → { cls, length }

  if (diffChanges) {
    for (const change of diffChanges) {
      if (change.type === 'substitution') {
        for (let j = 0; j < change.replacement.length; j++) {
          marks.set(change.index + j, { cls: 'substitution', length: 1 });
        }
      } else if (change.type === 'deletion') {
        marks.set(change.index, { cls: 'deletion-marker', length: 0 });
      }
    }
  } else {
    for (const inv of invalidChars) {
      const len = inv.length || inv.char.length;
      marks.set(inv.index, { cls: 'invalid', length: len });
      // Mark subsequent code units as skip
      for (let j = 1; j < len; j++) marks.set(inv.index + j, { cls: 'skip' });
    }
  }

  let html = '';
  for (let i = 0; i < text.length; i++) {
    const m = marks.get(i);
    if (m && m.cls === 'skip') continue;
    if (m && m.cls === 'deletion-marker') {
      html += '<mark class="deletion">\u00B7</mark>' + escapeHtml(text[i]);
    } else if (m && m.length > 1) {
      html += '<mark class="' + m.cls + '">' + escapeHtml(text.slice(i, i + m.length)) + '</mark>';
      i += m.length - 1;
    } else if (m) {
      html += '<mark class="' + m.cls + '">' + escapeHtml(text[i]) + '</mark>';
    } else {
      html += escapeHtml(text[i]);
    }
  }

  // Trailing newline fix: browsers collapse trailing newlines in divs
  if (text.endsWith('\n')) html += '\n';

  overlay.innerHTML = html;
}

function updateValidation() {
  const text = textarea.value;
  const invalid = validateText(text);

  if (lastDiffChanges) {
    renderOverlay(text, invalid, lastDiffChanges);
  } else {
    renderOverlay(text, invalid, null);
  }

  // Status
  const count = invalid.length;
  if (lastDiffChanges) {
    statusText.textContent = 'Исправления применены';
  } else if (count > 0) {
    statusText.textContent = `Найдено недопустимых символов: ${count}`;
  } else if (text.length > 0) {
    statusText.textContent = 'Текст в порядке';
  } else {
    statusText.textContent = 'Готово';
  }

  if (text.length > 0) {
    const est = estimatePages(text);
    charCount.textContent = `${text.length} симв. | ~${est.pages} стр. (~${est.lines} строк)`;
  } else {
    charCount.textContent = '';
  }
  btnUndo.disabled = !canUndo();
}

// --- Scroll Sync (Task 3.3) ---
textarea.addEventListener('scroll', () => {
  overlay.scrollTop = textarea.scrollTop;
  overlay.scrollLeft = textarea.scrollLeft;
});

// --- Resize Sync (Task 3.4) ---
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    overlay.style.width = textarea.offsetWidth + 'px';
    overlay.style.height = textarea.offsetHeight + 'px';
  }).observe(textarea);
}

// --- Input Event (Task 3.5, 4.4) ---
textarea.addEventListener('input', () => {
  // Clear diff highlights on manual edit (Task 4.4)
  lastDiffChanges = null;
  updateValidation();
});

// --- Button Actions (Tasks 5.1–5.5) ---

// Toast helper
function showToast(msg) {
  toast.textContent = msg;
  toast.hidden = false;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => { toast.hidden = true; }, 300);
  }, 1500);
}

// Paste (Task 5.1)
btnPaste.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    textarea.value = text;
    lastDiffChanges = null;
    updateValidation();
  } catch {
    showToast('Нет доступа к буферу. Используйте Ctrl+V');
  }
});

// Fix (Task 5.2)
btnFix.addEventListener('click', () => {
  const text = textarea.value;
  if (!text) return;

  const { fixedText, changes } = applyFixes(text);
  if (changes.length === 0) {
    showToast('Нечего исправлять');
    return;
  }

  pushUndo(text);
  textarea.value = fixedText;
  lastDiffChanges = changes;
  updateValidation();
});

// Copy (Task 5.3)
btnCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(textarea.value);
    showToast('Скопировано!');
  } catch {
    showToast('Не удалось скопировать');
  }
});

// Undo (Task 5.4)
btnUndo.addEventListener('click', () => {
  if (!canUndo()) return;
  textarea.value = popUndo();
  lastDiffChanges = null;
  updateValidation();
});

// PWA modal (Task 5.5)
btnPwa.addEventListener('click', () => {
  pwaModal.hidden = false;
});

pwaModal.addEventListener('click', (e) => {
  if (e.target === pwaModal || e.target.classList.contains('modal-close')) {
    pwaModal.hidden = true;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !pwaModal.hidden) {
    pwaModal.hidden = true;
  }
});

// --- Init ---
updateValidation();
