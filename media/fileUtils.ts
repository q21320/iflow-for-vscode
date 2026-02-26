// General-purpose path and file name utilities used across the webview.

const PATH_SHORTEN_THRESHOLD = 60;

export function getFileName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

const FILE_ICON_BY_EXTENSION: Record<string, { glyph: string; className: string }> = {
  json: { glyph: '{}', className: 'file-icon-json' },
  jsonc: { glyph: '{}', className: 'file-icon-json' },
  ts: { glyph: 'TS', className: 'file-icon-ts' },
  tsx: { glyph: 'TS', className: 'file-icon-ts' },
  js: { glyph: 'JS', className: 'file-icon-js' },
  jsx: { glyph: 'JS', className: 'file-icon-js' },
  mjs: { glyph: 'JS', className: 'file-icon-js' },
  cjs: { glyph: 'JS', className: 'file-icon-js' },
  py: { glyph: 'PY', className: 'file-icon-py' },
  go: { glyph: 'GO', className: 'file-icon-go' },
  rs: { glyph: 'RS', className: 'file-icon-rs' },
  java: { glyph: 'JV', className: 'file-icon-java' },
  css: { glyph: '#', className: 'file-icon-css' },
  scss: { glyph: '#', className: 'file-icon-css' },
  less: { glyph: '#', className: 'file-icon-css' },
  html: { glyph: '<>', className: 'file-icon-html' },
  htm: { glyph: '<>', className: 'file-icon-html' },
  md: { glyph: 'MD', className: 'file-icon-md' },
  mdx: { glyph: 'MD', className: 'file-icon-md' },
  yml: { glyph: 'YML', className: 'file-icon-config' },
  yaml: { glyph: 'YML', className: 'file-icon-config' },
  toml: { glyph: 'CFG', className: 'file-icon-config' },
  ini: { glyph: 'CFG', className: 'file-icon-config' },
  sh: { glyph: '$_', className: 'file-icon-shell' },
  bash: { glyph: '$_', className: 'file-icon-shell' },
  zsh: { glyph: '$_', className: 'file-icon-shell' },
  ps1: { glyph: '$_', className: 'file-icon-shell' },
  txt: { glyph: 'TXT', className: 'file-icon-text' },
  log: { glyph: 'LOG', className: 'file-icon-text' },
  png: { glyph: 'IMG', className: 'file-icon-image' },
  jpg: { glyph: 'IMG', className: 'file-icon-image' },
  jpeg: { glyph: 'IMG', className: 'file-icon-image' },
  gif: { glyph: 'IMG', className: 'file-icon-image' },
  webp: { glyph: 'IMG', className: 'file-icon-image' },
  bmp: { glyph: 'IMG', className: 'file-icon-image' },
  svg: { glyph: 'SVG', className: 'file-icon-image' },
  ico: { glyph: 'IMG', className: 'file-icon-image' },
  tiff: { glyph: 'IMG', className: 'file-icon-image' },
  tif: { glyph: 'IMG', className: 'file-icon-image' },
  pdf: { glyph: 'PDF', className: 'file-icon-pdf' },
  lock: { glyph: 'LCK', className: 'file-icon-lock' },
  gitignore: { glyph: 'GIT', className: 'file-icon-config' },
};

function getFileExtension(path: string): string {
  const fileName = getFileName(path).toLowerCase();
  if (!fileName) {
    return '';
  }

  if (fileName.startsWith('.') && fileName.indexOf('.', 1) === -1) {
    return fileName.slice(1);
  }

  const parts = fileName.split('.');
  if (parts.length < 2) {
    return '';
  }

  return parts[parts.length - 1];
}

export function getFileIconClass(path: string): string {
  const extension = getFileExtension(path);
  const matched = FILE_ICON_BY_EXTENSION[extension];
  if (matched) {
    return matched.className;
  }

  return extension ? 'file-icon-file' : 'file-icon-plain';
}

export function getFileIcon(path: string): string {
  const extension = getFileExtension(path);
  const matched = FILE_ICON_BY_EXTENSION[extension];
  if (matched) {
    return matched.glyph;
  }

  return extension ? 'FILE' : 'TXT';
}

export function shortenPath(p: string): string {
  if (p.length <= PATH_SHORTEN_THRESHOLD) {
    return p;
  }
  return `...${p.slice(-57)}`;
}

export function humanizeToolName(name: string): string {
  const normalized = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!normalized) {
    return 'Tool';
  }
  return normalized[0].toUpperCase() + normalized.slice(1);
}
