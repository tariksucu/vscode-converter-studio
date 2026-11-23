/**
 * The formats this extension converts on the computer, known without asking anyone: the same ids
 * and file extensions as Converter Studio's API (`GET /v1/formats`), so a target means the same
 * thing on this computer, in the desktop app and in the cloud.
 */

export type Kind =
  | 'image'
  | 'raw'
  | 'vector'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'text'
  | 'markup'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'ebook'
  | 'data';

export interface KnownFormat {
  name: string;
  kind: Kind;
  /** Lower case, without the dot. */
  extensions: readonly string[];
}

export const KNOWN_FORMATS: Readonly<Record<string, KnownFormat>> = {
  jpg: { name: 'JPG', kind: 'image', extensions: ['jpg', 'jpeg', 'jpe', 'jfif'] },
  png: { name: 'PNG', kind: 'image', extensions: ['png'] },
  webp: { name: 'WebP', kind: 'image', extensions: ['webp'] },
  avif: { name: 'AVIF', kind: 'image', extensions: ['avif'] },
  heic: { name: 'HEIC', kind: 'image', extensions: ['heic', 'heif'] },
  gif: { name: 'GIF', kind: 'image', extensions: ['gif'] },
  bmp: { name: 'BMP', kind: 'image', extensions: ['bmp'] },
  tiff: { name: 'TIFF', kind: 'image', extensions: ['tiff', 'tif'] },
  ico: { name: 'ICO', kind: 'image', extensions: ['ico'] },
  cr2: { name: 'CR2', kind: 'raw', extensions: ['cr2'] },
  nef: { name: 'NEF', kind: 'raw', extensions: ['nef'] },
  arw: { name: 'ARW', kind: 'raw', extensions: ['arw'] },
  dng: { name: 'DNG', kind: 'raw', extensions: ['dng'] },
  svg: { name: 'SVG', kind: 'vector', extensions: ['svg'] },
  mp4: { name: 'MP4', kind: 'video', extensions: ['mp4', 'm4v'] },
  mov: { name: 'MOV', kind: 'video', extensions: ['mov', 'qt'] },
  mkv: { name: 'MKV', kind: 'video', extensions: ['mkv'] },
  webm: { name: 'WebM', kind: 'video', extensions: ['webm'] },
  avi: { name: 'AVI', kind: 'video', extensions: ['avi'] },
  flv: { name: 'FLV', kind: 'video', extensions: ['flv'] },
  '3gp': { name: '3GP', kind: 'video', extensions: ['3gp', '3g2'] },
  wmv: { name: 'WMV', kind: 'video', extensions: ['wmv'] },
  mp3: { name: 'MP3', kind: 'audio', extensions: ['mp3'] },
  wav: { name: 'WAV', kind: 'audio', extensions: ['wav'] },
  m4a: { name: 'M4A', kind: 'audio', extensions: ['m4a'] },
  aac: { name: 'AAC', kind: 'audio', extensions: ['aac'] },
  flac: { name: 'FLAC', kind: 'audio', extensions: ['flac'] },
  ogg: { name: 'OGG', kind: 'audio', extensions: ['ogg', 'oga'] },
  opus: { name: 'Opus', kind: 'audio', extensions: ['opus'] },
  wma: { name: 'WMA', kind: 'audio', extensions: ['wma'] },
  aiff: { name: 'AIFF', kind: 'audio', extensions: ['aiff', 'aif'] },
  pdf: { name: 'PDF', kind: 'pdf', extensions: ['pdf'] },
  txt: { name: 'TXT', kind: 'text', extensions: ['txt', 'text'] },
  md: { name: 'Markdown', kind: 'markup', extensions: ['md', 'markdown'] },
  html: { name: 'HTML', kind: 'markup', extensions: ['html', 'htm'] },
  docx: { name: 'DOCX', kind: 'document', extensions: ['docx'] },
  doc: { name: 'DOC', kind: 'document', extensions: ['doc'] },
  odt: { name: 'ODT', kind: 'document', extensions: ['odt'] },
  rtf: { name: 'RTF', kind: 'document', extensions: ['rtf'] },
  xlsx: { name: 'XLSX', kind: 'spreadsheet', extensions: ['xlsx'] },
  xls: { name: 'XLS', kind: 'spreadsheet', extensions: ['xls'] },
  ods: { name: 'ODS', kind: 'spreadsheet', extensions: ['ods'] },
  csv: { name: 'CSV', kind: 'spreadsheet', extensions: ['csv'] },
  pptx: { name: 'PPTX', kind: 'presentation', extensions: ['pptx'] },
  ppt: { name: 'PPT', kind: 'presentation', extensions: ['ppt'] },
  odp: { name: 'ODP', kind: 'presentation', extensions: ['odp'] },
  epub: { name: 'EPUB', kind: 'ebook', extensions: ['epub'] },
  json: { name: 'JSON', kind: 'data', extensions: ['json'] },
  yaml: { name: 'YAML', kind: 'data', extensions: ['yaml', 'yml'] },
};

/** The known format of a file name, by its extension; null if unknown. */
export function knownFormatOf(name: string): string | null {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = lower.slice(dot + 1);
  for (const [id, format] of Object.entries(KNOWN_FORMATS))
    if (format.extensions.includes(extension)) return id;
  return null;
}

/** What the picker calls a format. */
export const formatName = (id: string): string => KNOWN_FORMATS[id]?.name ?? id.toUpperCase();
