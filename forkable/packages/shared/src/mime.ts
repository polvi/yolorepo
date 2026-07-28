const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
  webmanifest: 'application/manifest+json',
  xml: 'application/xml',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

export function mimeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = path.slice(dot + 1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

export function isHtmlPath(path: string): boolean {
  return mimeFor(path).startsWith('text/html');
}
