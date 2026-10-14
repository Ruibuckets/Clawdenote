/** A fixed-size native cursor keeps the tip precise at every page zoom level. */
export function inkDotCursor(color: string): string {
  const fill = color.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  // The thin contrasting rim keeps white and pale ink visible on any paper tone.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.5" fill="white" stroke="#27352f" stroke-width="0.7"/><circle cx="8" cy="8" r="3" fill="${fill}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 8 8, default`;
}
