// 16x16 stroke icons (drawn for SeamMap) and the SVG "tabs" painted on the left of graph cards.

const P = {
  // Roles / kinds
  controller: '<path d="M2 8h4.5l3-4H14M6.5 8l3 4H14"/><path d="M12 2.5 14 4l-2 1.5M12 10.5l2 1.5-2 1.5"/>',
  routes: '<path d="M8 1.5v13M8 3h4.5L14 4.75 12.5 6.5H8M8 8.5H3.5L2 10.25 3.5 12H8"/>',
  middleware: '<path d="M8 2 14 5 8 8 2 5Z"/><path d="m2 8 6 3 6-3M2 11l6 3 6-3"/>',
  request: '<rect x="3" y="2" width="10" height="12" rx="1.5"/><path d="m5.5 6.2 1.6 1.6L10.5 4.5M5.5 10.5h5"/>',
  resource: '<path d="M6 2.5c-1.5 0-2 .7-2 2V6c0 1-.6 1.6-1.5 2 .9.4 1.5 1 1.5 2v1.5c0 1.3.5 2 2 2M10 2.5c1.5 0 2 .7 2 2V6c0 1 .6 1.6 1.5 2-.9.4-1.5 1-1.5 2v1.5c0 1.3-.5 2-2 2"/>',
  policy: '<path d="M8 1.5 13.5 3.5v4c0 3.5-2.5 6-5.5 7-3-1-5.5-3.5-5.5-7v-4Z"/><path d="m5.8 8 1.6 1.6 2.9-3"/>',
  service: '<circle cx="8" cy="8" r="2.4"/><path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"/>',
  repository: '<rect x="2" y="2.5" width="12" height="3.5" rx="1"/><path d="M3 6v6.5c0 .6.4 1 1 1h8c.6 0 1-.4 1-1V6M6.5 9h3"/>',
  job: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
  event: '<path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8Z"/>',
  listener: '<path d="M4 11V7a4 4 0 0 1 8 0v4l1.5 1.5h-11ZM6.5 14.5h3"/>',
  provider: '<path d="M5.5 1.5v3.5M10.5 1.5v3.5M3.5 5h9v2.5a4.5 4.5 0 0 1-9 0ZM8 12v2.5"/>',
  php: '<path d="M4 1.5h5L12.5 5v9.5H4ZM9 1.5V5h3.5"/>',
  model: '<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>',
  endpoint: '<circle cx="3.5" cy="8" r="1.8"/><circle cx="12.5" cy="8" r="1.8"/><path d="M5.3 8h5.4M8 4v8"/>',
  lambda: '<path d="M4 2.5h2l6 11M8.6 7.6 4 13.5"/>',
  alert: '<path d="M8 2 14.5 13.5h-13ZM8 6.5v3M8 11.6v.1"/>',
  page: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 5.5h13M3.8 4h.1M5.6 4h.1"/>',
  layout: '<rect x="1.5" y="2" width="13" height="12" rx="1.5"/><path d="M1.5 6h13M6 6v8"/>',
  component: '<path d="M8 1.5 13.5 4.7v6.6L8 14.5l-5.5-3.2V4.7Z"/><path d="m2.5 4.7 5.5 3.2 5.5-3.2M8 8v6.5"/>',
  hook: '<path d="M10.5 1.5V8a3.5 3.5 0 0 1-7 0V6.5l2.2 2.2"/>',
  lib: '<path d="M2 9a6 6 0 0 1 12 0M4.6 9a3.4 3.4 0 0 1 6.8 0M8 9v5.5"/>',
  js: '<path d="M4 1.5h5L12.5 5v9.5H4ZM9 1.5V5h3.5"/><path d="M6.6 8.5 5.2 10l1.4 1.5M9.4 8.5l1.4 1.5-1.4 1.5"/>',
  class: '<rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="M10.3 6.1a2.6 2.6 0 1 0 0 3.8"/>',
  method: '<path d="M10.8 2.5c-2 0-2.6 1-2.9 2.5L6.4 12c-.3 1.5-.9 2-2.4 2M5 6.5h5.6"/>',
  closure: '<path d="M5.5 2.5c-1.5 0-2 .8-2 2v2L2 8l1.5 1.5v2c0 1.2.5 2 2 2M10.5 2.5c1.5 0 2 .8 2 2v2L14 8l-1.5 1.5v2c0 1.2-.5 2-2 2"/>',
  // UI
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3 8h10"/>',
  fit: '<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/>',
  target: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2"/><path d="M8 .8v2M8 13.2v2M.8 8h2M13.2 8h2"/>',
  collapse: '<path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4"/>',
  relayout: '<path d="M13.5 6.5A5.5 5.5 0 0 0 3.2 5M2.5 9.5A5.5 5.5 0 0 0 12.8 11"/><path d="M3 2v3h3M13 14v-3h-3"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9 13 13M3 13l1.1-1.1M11.9 4.1 13 3"/>',
  moon: '<path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5 5.8 5.8 0 1 0 13.5 9.6Z"/>',
  help: '<circle cx="8" cy="8" r="6.5"/><path d="M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4M8 11.6v.1"/>',
  sidebar: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M10 2.5v11"/>',
  external: '<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3c0 .6-.4 1-1 1H3.5c-.6 0-1-.4-1-1V5c0-.6.4-1 1-1h3"/>',
  copy: '<rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M11 5V3.5c0-.6-.4-1-1-1H3.5c-.6 0-1 .4-1 1V10c0 .6.4 1 1 1H5"/>',
  expand: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/><path d="M8 5.5v5M5.5 8h5"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  file: '<path d="M4 1.5h5L12.5 5v9.5H4ZM9 1.5V5h3.5"/>',
  map: '<path d="M1.5 4 5.5 2l5 2 4-2v10l-4 2-5-2-4 2Z"/><path d="M5.5 2v10M10.5 4v10"/>',
  arrowRight: '<path d="M3 8h10M9 4l4 4-4 4"/>',
  flow: '<circle cx="3" cy="3.5" r="1.5"/><circle cx="13" cy="12.5" r="1.5"/><path d="M4.5 3.5H9a2 2 0 0 1 2 2v5"/>',
  sparkle: '<path d="M8 1.5 9.4 6.6 14.5 8l-5.1 1.4L8 14.5 6.6 9.4 1.5 8l5.1-1.4Z"/>',
  shield: '<path d="M8 1.5 13.5 3.5v4c0 3.5-2.5 6-5.5 7-3-1-5.5-3.5-5.5-7v-4Z"/><path d="M8 5v4.5M8 11.4v.1"/>',
};

/** Inline SVG icon for the HTML UI (inherits currentColor). */
export function icon(name, size = 16, extraClass = '') {
  return `<svg class="ico ${extraClass}" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? P.file}</svg>`;
}

const cache = new Map();
const uri = (svg) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Width of the coloured tab drawn on the left of a card. */
export const TAB_W = 30;
export const BADGE_W = 58;

/**
 * Left tab of a graph card: a 3px role-coloured stripe, a tinted square and the role
 * icon. Drawn at the card's exact height so it never stretches; clipped to the rounded card.
 */
export function cardTab(iconName, color, h, marker = false) {
  const key = `t|${iconName}|${color}|${h}|${marker}`;
  let u = cache.get(key);
  if (!u) {
    const y = (h - 14) / 2;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${TAB_W}" height="${h}" viewBox="0 0 ${TAB_W} ${h}">` +
      `<rect width="${TAB_W}" height="${h}" fill="${hexToRgba(color, 0.13)}"/>` +
      `<rect width="3" height="${h}" fill="${color}"/>` +
      `<g transform="translate(9.5 ${y}) scale(0.875)" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${P[iconName] ?? P.file}</g>` +
      (marker ? `<circle cx="${TAB_W - 5}" cy="5" r="2.4" fill="${color}"/>` : '') +
      `</svg>`;
    u = uri(svg);
    cache.set(key, u);
  }
  return u;
}

/** Left badge of an endpoint card: tinted block with the HTTP method in monospace. */
export function methodTab(text, color, h, dashed = false) {
  const key = `m|${text}|${color}|${h}|${dashed}`;
  let u = cache.get(key);
  if (!u) {
    const size = text.length > 5 ? 10 : 11.5;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${BADGE_W}" height="${h}" viewBox="0 0 ${BADGE_W} ${h}">` +
      `<rect width="${BADGE_W}" height="${h}" fill="${hexToRgba(color, dashed ? 0.08 : 0.15)}"/>` +
      `<rect width="3" height="${h}" fill="${color}"${dashed ? ' fill-opacity="0.6"' : ''}/>` +
      `<text x="${(BADGE_W + 3) / 2}" y="${h / 2 + size * 0.36}" text-anchor="middle" font-family="IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace" font-weight="700" font-size="${size}" letter-spacing="0.4" fill="${color}">${text}</text>` +
      `</svg>`;
    u = uri(svg);
    cache.set(key, u);
  }
  return u;
}
