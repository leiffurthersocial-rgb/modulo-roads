/** Tiny DOM helpers and inline SVG icons (no icon font to download). */

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'html') el.innerHTML = String(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

const P = (d: string) => `<path d="${d}"/>`;
const svg = (body: string, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  leaf: svg(P('M5 19c0-8 5-13 14-14 0 9-5 14-13 14z') + P('M5 19l8-8')),
  battery: svg('<rect x="3" y="7" width="16" height="10" rx="2"/>' + P('M21 10v4') + P('M7 12h3l-1 2h3')),
  headlight: svg(P('M10 6c-4 0-6 3-6 6s2 6 6 6c2 0 3-2 3-6s-1-6-3-6z') + P('M16 8h5M16 12h5M16 16h5')),
  cruise: svg('<circle cx="12" cy="13" r="8"/>' + P('M12 13l4-4') + P('M8 5l-2-2M16 5l2-2')),
  auto: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/>' + P('M12 4v6M5 15l5-2M19 15l-5-2')),
  gear: svg('<circle cx="12" cy="12" r="3"/>' + P('M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1')),
  camera: svg('<rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="12" cy="13.5" r="3.5"/>' + P('M8 7l1.5-3h5L16 7')),
  play: svg(P('M7 5l12 7-12 7z')),
  pause: svg(P('M8 5v14M16 5v14')),
  music: svg(P('M9 18V5l11-2v13') + '<circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
  mute: svg(P('M4 9h4l5-4v14l-5-4H4z') + P('M17 9l4 6M21 9l-4 6')),
  sound: svg(P('M4 9h4l5-4v14l-5-4H4z') + P('M17 8c1.5 1 1.5 7 0 8M19.5 5.5c3 2.5 3 10.5 0 13')),
  dice: svg('<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1" fill="currentColor"/><circle cx="15" cy="15" r="1" fill="currentColor"/><circle cx="15" cy="9" r="1" fill="currentColor"/><circle cx="9" cy="15" r="1" fill="currentColor"/>'),
  close: svg(P('M6 6l12 12M18 6L6 18')),
  keyboard: svg('<rect x="2" y="6" width="20" height="12" rx="2"/>' + P('M6 10h1M10 10h1M14 10h1M18 10h1M7 14h10')),
  log: svg(P('M5 4h11l3 3v13H5z') + P('M8 10h8M8 14h8M8 18h5')),
  full: svg(P('M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5')),
  compass: svg('<circle cx="12" cy="12" r="9"/>' + P('M15.5 8.5l-2 5-5 2 2-5z')),
  wiper: svg(P('M3 18a12 12 0 0118 0') + P('M12 18L7 9')),
  flag: `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="4" fill="#d52b1e"/><path d="M13 6h6v7h7v6h-7v7h-6v-7H6v-6h7z" fill="#fff"/></svg>`,
};

export function icon(name: keyof typeof ICONS, cls = 'ico'): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.innerHTML = ICONS[name];
  return s;
}
