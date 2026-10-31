const paths: Record<string, string> = {
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.7 9a2.4 2.4 0 0 1 4.6 1c0 1.8-2.3 1.8-2.3 3.5M12 17h.01"/>',
  camera:
    '<rect x="3" y="6" width="18" height="14" rx="3"/><path d="m8 6 1-3h6l1 3"/><circle cx="12" cy="13" r="3"/>',
  upload: '<path d="M12 15V3m-4 4 4-4 4 4M4 15v5h16v-5"/>',
  grid: '<path d="m12 3 9 5v8l-9 5-9-5V8Zm0 0v18M3 8l9 5 9-5M3 12l9 5 9-5M7 5l10 6v7M17 5 7 11v7"/>',
  box: '<path d="m12 3 9 5v8l-9 5-9-5V8Zm0 0v18M3 8l9 5 9-5"/>',
  reset: '<path d="M3 10a9 9 0 1 1 1 7M3 4v6h6"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  orbit:
    '<circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="10" ry="5" transform="rotate(-35 12 12)"/><path d="m16 3 4 1-1 4"/>',
  look: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  position:
    '<path d="M3 12h18m-4-4 4 4-4 4M7 8l-4 4 4 4M12 3v3m0 12v3"/><circle cx="12" cy="12" r="3"/>',
  mouse: '<rect x="6" y="2" width="12" height="20" rx="6"/><path d="M12 6v4"/>',
  face: '<path d="M8 2H4a2 2 0 0 0-2 2v4m14-6h4a2 2 0 0 1 2 2v4M2 16v4a2 2 0 0 0 2 2h4m14-6v4a2 2 0 0 1-2 2h-4M7 9h.01M17 9h.01M12 9v5h-2m-2 3s4 3 8 0"/>',
  play: '<path d="m9 5 10 7-10 7Z"/>',
  shield:
    '<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6Z"/><path d="m8 12 3 3 5-6"/>',
  crosshair:
    '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 1v4m0 14v4M1 12h4m14 0h4"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
};
export function icon(name: string) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? ""}</svg>`;
}
export function renderIcons() {
  document.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
    el.innerHTML = icon(el.dataset.icon!);
  });
}
