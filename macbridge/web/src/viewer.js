// Touch viewport for the remote screen.
//
// Gestures:
//   tap                      click              double tap    double click
//   long press               right click        two-finger tap  right click
//   long press, then move    drag with the left button held (select, move windows)
//   one-finger drag          pan the zoomed picture
//   pinch                    zoom the picture
//   two-finger drag          scroll on the Mac
//
// Everything sent to the Mac is expressed as a fraction of the screen, so it
// is independent of zoom, rotation and video resolution.

const SLOP = 9; // px a finger may wander and still count as a tap
const HOLD_MS = 430;
const DOUBLE_MS = 350;
const DOUBLE_DIST = 32;

export function createViewer({ stage, canvas, video, fx, minimap, send }) {
  let aspect = 16 / 10; // screen width / height, updated from the video
  let stageW = 0;
  let stageH = 0;
  let fitW = 0; // size of the whole picture at zoom 1
  let fitH = 0;
  let zoom = 1;
  let tx = 0; // top-left corner of the picture inside the stage, px
  let ty = 0;
  let preferredZoom = 0; // last zoom chosen by the user, 0 = none yet
  let focus = { x: 0.5, y: 0.5 }; // last point the user touched, as fractions
  let displayW = 1440; // logical width of the Mac screen, for the zoom limit
  let mapTimer = null;
  let inertia = 0;

  const points = new Map(); // pointerId -> {x, y}
  let g = null; // current gesture
  let lastTap = null;
  let dragPending = null;
  let dragFrame = 0;

  // ------------------------------------------------------------ geometry

  const maxZoom = () => Math.max(3, Math.min(12, (displayW / Math.max(1, fitW)) * 2.5));

  function clampView() {
    const w = fitW * zoom;
    const h = fitH * zoom;
    tx = w <= stageW ? (stageW - w) / 2 : Math.min(0, Math.max(stageW - w, tx));
    ty = h <= stageH ? (stageH - h) / 2 : Math.min(0, Math.max(stageH - h, ty));
  }

  function render(showMap = true) {
    canvas.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${zoom})`;
    updateMinimap(showMap);
  }

  function layout() {
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // Keep looking at the same spot when the stage changes size (rotation,
    // on-screen keyboard): remember the point under the centre first.
    const centre = fitW ? toScreen(stageW / 2, stageH / 2, false) : { x: 0.5, y: 0.5 };
    const hadSize = fitW > 0;
    stageW = r.width;
    stageH = r.height;
    if (stageW / stageH > aspect) {
      fitH = stageH;
      fitW = stageH * aspect;
    } else {
      fitW = stageW;
      fitH = stageW / aspect;
    }
    canvas.style.width = `${fitW}px`;
    canvas.style.height = `${fitH}px`;
    zoom = Math.min(zoom, maxZoom());
    if (hadSize) centreOn(centre.x, centre.y);
    // Whatever the user touched last (a text field, usually) must stay visible.
    if (hadSize && zoom > 1.01) reveal(focus.x, focus.y);
    clampView();
    render(false);
  }

  function centreOn(x, y) {
    tx = stageW / 2 - x * fitW * zoom;
    ty = stageH / 2 - y * fitH * zoom;
  }

  function reveal(x, y) {
    const px = tx + x * fitW * zoom;
    const py = ty + y * fitH * zoom;
    const m = 36;
    if (px < m || px > stageW - m || py < m || py > stageH - m) centreOn(x, y);
  }

  // Stage pixel -> fraction of the remote screen. Null when outside it.
  function toScreen(px, py, strict = true) {
    const x = (px - tx) / (fitW * zoom);
    const y = (py - ty) / (fitH * zoom);
    if (strict && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  function zoomAt(px, py, nextZoom) {
    const z = Math.min(maxZoom(), Math.max(1, nextZoom));
    const k = z / zoom;
    tx = px - (px - tx) * k;
    ty = py - (py - ty) * k;
    zoom = z;
    clampView();
  }

  function animate() {
    canvas.classList.add('animate');
    clearTimeout(animate.t);
    animate.t = setTimeout(() => canvas.classList.remove('animate'), 260);
  }

  // A comfortable reading zoom: fill the stage height in portrait, but never
  // beyond 1 Mac point = 1 phone point.
  function comfortZoom() {
    const oneToOne = displayW / fitW;
    const fill = stageH / fitH;
    const z = fill > 1.3 ? Math.min(fill, oneToOne) : Math.min(2.2, oneToOne);
    return Math.max(1.6, Math.min(maxZoom(), z));
  }

  function toggleZoom() {
    animate();
    if (zoom > 1.05) {
      preferredZoom = zoom;
      zoom = 1;
    } else {
      zoom = Math.min(maxZoom(), preferredZoom > 1.05 ? preferredZoom : comfortZoom());
      centreOn(focus.x, focus.y);
    }
    clampView();
    render();
  }

  function updateMinimap(show) {
    if (!fitW || zoom <= 1.08) {
      minimap.classList.remove('on');
      return;
    }
    const mw = 84;
    const mh = mw / aspect;
    minimap.style.height = `${mh}px`;
    const box = minimap.firstElementChild;
    const w = fitW * zoom;
    const h = fitH * zoom;
    const l = Math.max(0, -tx / w);
    const t = Math.max(0, -ty / h);
    box.style.left = `${l * mw}px`;
    box.style.top = `${t * mh}px`;
    box.style.width = `${Math.min(1 - l, stageW / w) * mw}px`;
    box.style.height = `${Math.min(1 - t, stageH / h) * mh}px`;
    if (!show) return;
    minimap.classList.add('on');
    clearTimeout(mapTimer);
    mapTimer = setTimeout(() => minimap.classList.remove('on'), 1400);
  }

  // -------------------------------------------------------------- effects

  function ripple(px, py, kind = '') {
    const el = document.createElement('div');
    el.className = `ripple ${kind}`;
    el.style.left = `${px}px`;
    el.style.top = `${py}px`;
    fx.appendChild(el);
    if (kind !== 'hold') setTimeout(() => el.remove(), 450);
    return el;
  }

  // -------------------------------------------------------------- actions

  function click(px, py, right) {
    const p = toScreen(px, py);
    if (!p) return;
    focus = p;
    let n = 1;
    const now = performance.now();
    if (!right) {
      if (lastTap && now - lastTap.t < DOUBLE_MS && Math.hypot(px - lastTap.x, py - lastTap.y) < DOUBLE_DIST) {
        n = 2;
        lastTap = null;
      } else {
        lastTap = { t: now, x: px, y: py };
      }
    }
    send({ t: 'click', x: p.x, y: p.y, b: right ? 1 : 0, n });
    ripple(px, py, right ? 'right' : '');
  }

  function sendDrag(px, py) {
    dragPending = toScreen(px, py, false);
    if (dragFrame) return;
    dragFrame = requestAnimationFrame(() => {
      dragFrame = 0;
      if (dragPending && g?.mode === 'drag') send({ t: 'drag', ...dragPending });
    });
  }

  function stopInertia() {
    cancelAnimationFrame(inertia);
    inertia = 0;
  }

  function fling(vx, vy) {
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(40, now - last);
      last = now;
      tx += vx * dt;
      ty += vy * dt;
      const k = Math.pow(0.994, dt);
      vx *= k;
      vy *= k;
      const bx = tx;
      const by = ty;
      clampView();
      if (bx !== tx) vx = 0;
      if (by !== ty) vy = 0;
      render();
      inertia = Math.hypot(vx, vy) > 0.03 ? requestAnimationFrame(step) : 0;
    };
    inertia = requestAnimationFrame(step);
  }

  // ------------------------------------------------------------- gestures

  const local = (e) => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const twoPoints = () => {
    const [a, b] = [...points.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault(); // keep the on-screen keyboard open while tapping
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {}
    const p = local(e);
    points.set(e.pointerId, p);
    stopInertia();

    if (points.size === 1) {
      g = { mode: 'pending', x0: p.x, y0: p.y, x: p.x, y: p.y, t: performance.now(), vx: 0, vy: 0, mark: null };
      const mine = g;
      g.timer = setTimeout(() => {
        if (g !== mine || g.mode !== 'pending') return;
        g.mode = 'hold';
        g.mark = ripple(g.x0, g.y0, 'hold');
      }, HOLD_MS);
    } else if (points.size === 2 && g && g.mode !== 'drag' && g.mode !== 'done') {
      clearTimeout(g.timer);
      g.mark?.remove();
      const { d, c } = twoPoints();
      g = { mode: 'two', sub: null, d0: d, c0: c, last: c, t: performance.now(), rx: 0, ry: 0 };
    }
  }

  function onMove(e) {
    if (!points.has(e.pointerId) || !g) return;
    const p = local(e);
    points.set(e.pointerId, p);

    if (g.mode === 'two') {
      if (points.size < 2) return;
      const { d, c } = twoPoints();
      if (!g.sub) {
        if (Math.abs(d - g.d0) > 16) g.sub = 'zoom';
        else if (Math.hypot(c.x - g.c0.x, c.y - g.c0.y) > 10) g.sub = 'scroll';
        if (g.sub === 'zoom') g.dPrev = d;
      }
      if (g.sub === 'zoom') {
        // Zoom around the fingers and let the picture follow them.
        tx += c.x - g.last.x;
        ty += c.y - g.last.y;
        zoomAt(c.x, c.y, zoom * (d / g.dPrev));
        g.dPrev = d;
        preferredZoom = zoom;
        render();
      } else if (g.sub === 'scroll') {
        const at = toScreen(g.c0.x, g.c0.y, false);
        const dx = (c.x - g.last.x) / (fitW * zoom);
        const dy = (c.y - g.last.y) / (fitH * zoom);
        if (dx || dy) send({ t: 'scroll', x: at.x, y: at.y, dx, dy });
      }
      g.last = c;
      return;
    }

    const moved = Math.hypot(p.x - g.x0, p.y - g.y0);
    if (g.mode === 'pending' && moved > SLOP) {
      clearTimeout(g.timer);
      g.mode = 'pan';
      g.x = p.x;
      g.y = p.y;
      g.t = performance.now();
      return;
    }
    if (g.mode === 'hold' && moved > SLOP) {
      const start = toScreen(g.x0, g.y0);
      g.mark?.remove();
      if (!start) {
        g.mode = 'done';
        return;
      }
      g.mode = 'drag';
      send({ t: 'down', ...start });
    }
    if (g.mode === 'pan') {
      const now = performance.now();
      const dt = Math.max(1, now - g.t);
      const dx = p.x - g.x;
      const dy = p.y - g.y;
      g.vx = 0.75 * (dx / dt) + 0.25 * g.vx;
      g.vy = 0.75 * (dy / dt) + 0.25 * g.vy;
      g.x = p.x;
      g.y = p.y;
      g.t = now;
      tx += dx;
      ty += dy;
      clampView();
      render();
    } else if (g.mode === 'drag') {
      g.x = p.x;
      g.y = p.y;
      sendDrag(p.x, p.y);
    }
  }

  function onUp(e) {
    if (!points.has(e.pointerId)) return;
    const p = local(e);
    points.delete(e.pointerId);
    if (!g) return;
    const cancelled = e.type === 'pointercancel';

    switch (g.mode) {
      case 'pending':
        clearTimeout(g.timer);
        if (!cancelled) click(g.x0, g.y0, false);
        break;
      case 'hold':
        g.mark?.remove();
        if (!cancelled) click(g.x0, g.y0, true);
        break;
      case 'drag': {
        cancelAnimationFrame(dragFrame);
        dragFrame = 0;
        const end = toScreen(p.x, p.y, false);
        send({ t: 'drag', ...end });
        send({ t: 'up', ...end });
        focus = end;
        break;
      }
      case 'pan':
        if (!cancelled && performance.now() - g.t < 60 && Math.hypot(g.vx, g.vy) > 0.25) fling(g.vx, g.vy);
        break;
      case 'two':
        if (!g.sub && !cancelled && performance.now() - g.t < 320) click(g.c0.x, g.c0.y, true);
        break;
    }
    // After any gesture, wait until every finger is lifted before starting a new one.
    g = points.size ? { mode: 'done' } : null;
  }

  function onWheel(e) {
    e.preventDefault();
    const p = local(e);
    if (e.ctrlKey) {
      zoomAt(p.x, p.y, zoom * Math.exp(-e.deltaY * 0.01));
      preferredZoom = zoom;
      render();
      return;
    }
    const at = toScreen(p.x, p.y);
    if (at) send({ t: 'scroll', x: at.x, y: at.y, dx: -e.deltaX / (fitW * zoom), dy: -e.deltaY / (fitH * zoom) });
  }

  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);
  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  // Switch off the browser's own touch behaviour on the picture (long-press
  // menu, text loupe, double-tap zoom, synthetic clicks); pointer events above
  // still arrive.
  stage.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  // Safari's own pinch-to-zoom of the page
  for (const type of ['gesturestart', 'gesturechange']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }

  const onVideoSize = () => {
    if (!video.videoWidth || !video.videoHeight) return;
    const next = video.videoWidth / video.videoHeight;
    if (Math.abs(next - aspect) > 0.002) {
      aspect = next;
      fitW = 0; // a different screen: forget the old framing
      zoom = 1;
    }
    layout();
  };
  video.addEventListener('loadedmetadata', onVideoSize);
  video.addEventListener('resize', onVideoSize);
  new ResizeObserver(layout).observe(stage);

  return {
    toggleZoom,
    setDisplay(width, height) {
      displayW = width;
      if (width && height && !video.videoWidth) {
        aspect = width / height;
        layout();
      }
    },
    // For tests and diagnostics
    get state() {
      return { zoom, tx, ty, fitW, fitH, stageW, stageH };
    },
  };
}
