// On-screen keyboard bridge.
//
// A phone browser only shows its keyboard for a focused text field, so there
// is an invisible <textarea>. Whatever the keyboard does to its contents
// (typing, dictation, autocorrection, backspace) is turned into the same
// edits on the Mac by comparing the text before and after each change.

const FILLER = '////////'; // lets Backspace work when nothing was typed yet
const MAX_LEN = 400;

export function createKeyboard({ field, keys, root, send, onToggle }) {
  let prev = FILLER;
  let open = false;
  let blurTimer = null;
  const mods = new Set();

  const modButtons = [...keys.querySelectorAll('[data-mod]')];
  const showMods = () => {
    for (const b of modButtons) b.setAttribute('aria-pressed', String(mods.has(b.dataset.mod)));
  };
  const takeMods = () => {
    const m = [...mods];
    mods.clear();
    showMods();
    return m;
  };

  function reset() {
    field.value = FILLER;
    prev = FILLER;
    caretToEnd();
  }

  function caretToEnd() {
    try {
      field.setSelectionRange(field.value.length, field.value.length);
    } catch {}
  }

  function key(name) {
    send({ t: 'key', k: name, m: takeMods() });
  }

  function typed(text) {
    if (!text) return;
    if (mods.size) {
      // A held modifier turns the next character into a shortcut, e.g. Cmd+C.
      const m = takeMods();
      for (const ch of text) send({ t: 'key', k: ch === '\n' ? 'Enter' : ch, m });
      return;
    }
    // Send line breaks as the Enter key so they submit forms like a real keyboard.
    for (const part of text.split(/(\n)/)) {
      if (part === '\n') send({ t: 'key', k: 'Enter', m: [] });
      else if (part) send({ t: 'text', s: part });
    }
  }

  field.addEventListener('input', (e) => {
    const next = field.value;
    let p = 0;
    const lim = Math.min(prev.length, next.length);
    while (p < lim && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
    // Do not split a surrogate pair (emoji) in half.
    if (p > 0 && p < prev.length && isLowSurrogate(prev.charCodeAt(p))) p--;

    const removed = [...prev.slice(p)].length;
    for (let i = 0; i < removed; i++) key('Backspace');
    typed(next.slice(p));
    prev = next;

    if (!e.isComposing && (next.length > MAX_LEN || next.length < 4 || next.endsWith('\n'))) reset();
  });

  // The caret must stay at the end, otherwise edits could not be mirrored.
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === field && field.selectionStart !== field.value.length) caretToEnd();
  });

  field.addEventListener('focus', () => {
    clearTimeout(blurTimer);
    setOpen(true);
  });
  field.addEventListener('blur', () => {
    // Tapping one of our own buttons may blur the field for a moment.
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (document.activeElement !== field) setOpen(false);
    }, 200);
  });

  function setOpen(v) {
    if (open === v) return;
    open = v;
    keys.hidden = !v;
    root.classList.toggle('kbd-open', v);
    if (!v) takeMods();
    onToggle?.(v);
  }

  function show() {
    reset();
    field.focus({ preventScroll: true });
  }

  function hide() {
    clearTimeout(blurTimer);
    field.blur();
    setOpen(false);
  }

  // ----------------------------------------------------------- extra keys

  let repeatTimer = null;
  const stopRepeat = () => {
    clearTimeout(repeatTimer);
    repeatTimer = null;
  };

  keys.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    e.preventDefault(); // do not take focus away from the text field
    if (b.dataset.mod) {
      if (mods.has(b.dataset.mod)) mods.delete(b.dataset.mod);
      else mods.add(b.dataset.mod);
      showMods();
    } else if (b.dataset.key) {
      const held = [...mods];
      key(b.dataset.key);
      if ('repeat' in b.dataset) {
        const again = () => {
          send({ t: 'key', k: b.dataset.key, m: held });
          repeatTimer = setTimeout(again, 70);
        };
        stopRepeat();
        repeatTimer = setTimeout(again, 420);
      }
    }
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) keys.addEventListener(type, stopRepeat);

  keys.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (b?.dataset.action === 'paste') {
      try {
        const text = await navigator.clipboard.readText();
        if (text) typed(text.replace(/\r\n?/g, '\n').slice(0, 4000));
      } catch {
        // the user declined the paste prompt
      }
    }
    if (open) field.focus({ preventScroll: true });
  });

  reset();
  return {
    toggle: () => (open ? hide() : show()),
    hide,
    get open() {
      return open;
    },
  };
}

const isLowSurrogate = (c) => c >= 0xdc00 && c <= 0xdfff;
