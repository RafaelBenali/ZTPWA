'use strict';

// Character rules based on zt.ru testing (2026-03-11)
const CHAR_RULES = {
  replacements: {
    '\u2212': '-',      // minus sign
    '\u20BD': ' \u0440\u0443\u0431.',  // ruble sign
    '\u2033': '"',      // double prime
    '\u2009': ' ',      // thin space
    '\u2003': ' ',      // em space
    '\u2002': ' ',      // en space
    '\t':     ' ',      // tab
  },
  deleteChars: [
    '\u200B', // zero-width space
    '\u200C', // zero-width non-joiner
    '\u200D', // zero-width joiner
    '\uFEFF', // byte order mark
    '\uFE0F', // variation selector
    '\uFE0E', // text variation selector
  ],
  emojiPattern: /(?![\u00A9\u00AE\u2122])[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu,
};

// Page estimate: zt.ru paginates by rendered pixel height, 29 lines/page.
// Cyrillic chars ~1.22x wider than Latin. Boundaries: RU 2584, EN 3159 chars.
const PAGE_LINES = 29;
const RU_CHAR_COST = 1.0;
const EN_CHAR_COST = 0.818;
const LINE_COST = 89;
const PAGE_COST = PAGE_LINES * LINE_COST;

function estimatePages(text) {
  if (!text) return { pages: 0, lines: 0 };
  let totalCost = 0;
  const paragraphs = text.split('\n');
  for (const p of paragraphs) {
    if (p.length === 0) {
      totalCost += LINE_COST;
    } else {
      let pCost = 0;
      for (const ch of p) {
        pCost += (ch >= '\u0400' && ch <= '\u04FF') ? RU_CHAR_COST : EN_CHAR_COST;
      }
      totalCost += Math.ceil(pCost / LINE_COST) * LINE_COST;
    }
  }
  return {
    pages: Math.ceil(totalCost / PAGE_COST),
    lines: Math.round(totalCost / LINE_COST),
  };
}

// Validation lookups
function buildLookups() {
  return {
    replaceMap: new Map(Object.entries(CHAR_RULES.replacements)),
    deleteSet: new Set(CHAR_RULES.deleteChars),
  };
}

const lookups = buildLookups();

function validateText(text) {
  const results = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (lookups.replaceMap.has(ch)) {
      results.push({ index: i, char: ch, codepoint: ch.codePointAt(0), type: 'replace' });
    } else if (lookups.deleteSet.has(ch)) {
      results.push({ index: i, char: ch, codepoint: ch.codePointAt(0), type: 'delete' });
    }
  }
  if (CHAR_RULES.emojiPattern) {
    CHAR_RULES.emojiPattern.lastIndex = 0;
    let match;
    while ((match = CHAR_RULES.emojiPattern.exec(text)) !== null) {
      if (!results.some((r) => r.index === match.index)) {
        results.push({ index: match.index, char: match[0], codepoint: match[0].codePointAt(0), type: 'delete', length: match[0].length });
      }
    }
  }
  results.sort((a, b) => a.index - b.index);
  return results;
}

// Sanitization
function applyFixes(text) {
  const invalid = validateText(text);
  if (invalid.length === 0) return { fixedText: text, changes: [] };

  const skipIndices = new Map();
  for (const inv of invalid) {
    const len = inv.length || inv.char.length;
    for (let j = 0; j < len; j++) skipIndices.set(inv.index + j, inv);
  }

  const changes = [];
  const fixedChars = [];
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
      i++;
    } else {
      fixedChars.push(text[i]);
      offset++;
      i++;
    }
  }

  return { fixedText: fixedChars.join(''), changes };
}

// Undo stack
const MAX_UNDO = 20;
const undoStack = [];
function pushUndo(text) { undoStack.push(text); if (undoStack.length > MAX_UNDO) undoStack.shift(); }
function popUndo() { return undoStack.pop(); }
function canUndo() { return undoStack.length > 0; }

// DOM
const textarea = document.getElementById('textarea');
const overlay = document.getElementById('overlay');
const statusText = document.getElementById('status-text');
const charCount = document.getElementById('char-count');
const btnPaste = document.getElementById('btn-paste');
const btnFix = document.getElementById('btn-fix');
const btnCopy = document.getElementById('btn-copy');
const btnUndo = document.getElementById('btn-undo');
const btnInfo = document.getElementById('btn-info');
const btnPwa = document.getElementById('btn-pwa');
const infoModal = document.getElementById('info-modal');
const pwaModal = document.getElementById('pwa-modal');
const toast = document.getElementById('toast');

let lastDiffChanges = null;

// Overlay rendering
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderOverlay(text, invalidChars, diffChanges) {
  if (!text) { overlay.innerHTML = ''; return; }

  const marks = new Map();

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

  if (text.endsWith('\n')) html += '\n';
  overlay.innerHTML = html;
}

function updateValidation() {
  const text = textarea.value;
  const invalid = validateText(text);
  renderOverlay(text, invalid, lastDiffChanges || null);

  const count = invalid.length;
  if (lastDiffChanges) {
    statusText.textContent = 'Исправления применены';
  } else if (count > 0) {
    statusText.textContent = 'Найдено недопустимых символов: ' + count;
  } else if (text.length > 0) {
    statusText.textContent = 'Текст в порядке';
  } else {
    statusText.textContent = 'Готово';
  }

  if (text.length > 0) {
    const est = estimatePages(text);
    charCount.textContent = text.length + ' симв. | ~' + est.pages + ' стр. (~' + est.lines + ' строк)';
  } else {
    charCount.textContent = '';
  }
  btnUndo.disabled = !canUndo();
}

// Scroll and resize sync
textarea.addEventListener('scroll', () => {
  overlay.scrollTop = textarea.scrollTop;
  overlay.scrollLeft = textarea.scrollLeft;
});

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    overlay.style.width = textarea.offsetWidth + 'px';
    overlay.style.height = textarea.offsetHeight + 'px';
  }).observe(textarea);
}

// Input: clear diff on manual edit
textarea.addEventListener('input', () => {
  lastDiffChanges = null;
  updateValidation();
});

// Toast
function showToast(msg) {
  toast.textContent = msg;
  toast.hidden = false;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => { toast.hidden = true; }, 300);
  }, 1500);
}

// Buttons
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

btnFix.addEventListener('click', () => {
  const text = textarea.value;
  if (!text) return;
  const { fixedText, changes } = applyFixes(text);
  if (changes.length === 0) { showToast('Нечего исправлять'); return; }
  pushUndo(text);
  textarea.value = fixedText;
  lastDiffChanges = changes;
  updateValidation();
});

btnCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(textarea.value);
    showToast('Скопировано!');
  } catch {
    showToast('Не удалось скопировать');
  }
});

btnUndo.addEventListener('click', () => {
  if (!canUndo()) return;
  textarea.value = popUndo();
  lastDiffChanges = null;
  updateValidation();
});

// Modals
btnInfo.addEventListener('click', () => { infoModal.hidden = false; });
btnPwa.addEventListener('click', () => { pwaModal.hidden = false; });

for (const modal of [infoModal, pwaModal]) {
  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.classList.contains('modal-close')) {
      modal.hidden = true;
    }
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { infoModal.hidden = true; pwaModal.hidden = true; }
});

updateValidation();
