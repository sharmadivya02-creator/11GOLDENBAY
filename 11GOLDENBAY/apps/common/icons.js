// icons.js — a tiny hand-built line-icon set (Feather/Lucide-style: 24x24,
// stroke currentColor, round caps). No external icon font or CDN dependency,
// so the app works offline at a hackathon table.

const ICONS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 9.5V20a1 1 0 0 0 1 1H10v-6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v6h3.5a1 1 0 0 0 1-1V9.5"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20c.6-3.6 3.2-5.6 6.5-5.6s5.9 2 6.5 5.6"/><circle cx="17" cy="8.5" r="2.6"/><path d="M15.8 14.6c2.6.3 4.5 2.1 5 5.4"/>',
  heartPulse: '<path d="M12.5 20.2 5.7 13.6C3 11 3.2 6.8 6.2 4.7c2.4-1.7 5.3-1.1 6.8.9 1.5-2 4.4-2.6 6.8-.9 3 2.1 3.2 6.3.5 8.9l-1 1"/><path d="M4 12h3l1.5-3 2 6L12 11h3"/>',
  menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
  chevronRight: '<path d="M9 5.5 15.5 12 9 18.5"/>',
  chevronLeft: '<path d="M15 5.5 8.5 12l6.5 6.5"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  alertTriangle: '<path d="M12 4.2 2.5 20h19L12 4.2Z"/><path d="M12 10.5v4.2"/><circle cx="12" cy="17.5" r="0.4" fill="currentColor" stroke="none"/>',
  pill: '<rect x="4.5" y="9.5" width="15" height="7" rx="3.5" transform="rotate(-40 12 13)"/><path d="M9.8 10.8 14.2 15.2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/>',
  phone: '<path d="M7 3.5 9.5 8 7.2 9.8a12 12 0 0 0 6 6l1.8-2.3 4.5 2.5V20a1.5 1.5 0 0 1-1.6 1.5C10.5 20.8 3.2 13.5 2.5 6.1A1.5 1.5 0 0 1 4 4.5Z"/>',
  hospital: '<rect x="4" y="4" width="16" height="16.5" rx="1.5"/><path d="M12 8v6"/><path d="M9 11h6"/><path d="M8 21v-3.2a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1V21"/>',
  shield: '<path d="M12 3.2 19.5 6v6.3c0 4.4-3.1 7.7-7.5 8.9-4.4-1.2-7.5-4.5-7.5-8.9V6Z"/><path d="M8.7 12 11 14.3l4.3-4.6"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/><path d="M9 21h6"/>',
  bell: '<path d="M6 10.5a6 6 0 0 1 12 0c0 4.2 1.3 5.6 2 6.5H4c.7-.9 2-2.3 2-6.5Z"/><path d="M10 20a2.2 2.2 0 0 0 4 0"/>',
  x: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
  check: '<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>',
  camera: '<path d="M4 8.2A1.2 1.2 0 0 1 5.2 7H8l1.2-1.8h5.6L16 7h2.8A1.2 1.2 0 0 1 20 8.2v10.6A1.2 1.2 0 0 1 18.8 20H5.2A1.2 1.2 0 0 1 4 18.8Z"/><circle cx="12" cy="13" r="3.4"/>',
  edit: '<path d="M14.5 4.5 19.5 9.5 8 21H3v-5Z"/><path d="M12.5 6.5l5 5"/>',
  dots: '<circle cx="12" cy="5.5" r="1.15" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.15" fill="currentColor" stroke="none"/>',
  mapPin: '<path d="M12 21s7-6.6 7-12a7 7 0 1 0-14 0c0 5.4 7 12 7 12Z"/><circle cx="12" cy="9" r="2.4"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>',
  ambulance: '<path d="M3 16V8.5A1.5 1.5 0 0 1 4.5 7h7A1.5 1.5 0 0 1 13 8.5V16"/><path d="M13 11h3.6l2.9 3.2V16"/><path d="M3 16h16.5"/><circle cx="7" cy="17.5" r="1.6"/><circle cx="17" cy="17.5" r="1.6"/><path d="M7 9v3M5.5 10.5h3"/>',
  file: '<path d="M7 3.5h7l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 3.5V8h4"/>',
};

// icon(name, {size, stroke}) → an inline <svg> string.
function icon(name, opts = {}) {
  const size = opts.size || 22;
  const strokeWidth = opts.strokeWidth || 1.8;
  const body = ICONS[name] || '';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
