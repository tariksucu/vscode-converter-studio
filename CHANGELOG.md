# Changelog

## 1.0.0

First release.

- **Convert with Converter Studio…** in the Explorer's context menu (one or several files), on an
  editor tab and in the Command Palette (the active file, or files you choose).
- The format picker lists the targets Converter Studio's API offers for the selected files, with
  suggestions first: images to WebP or AVIF, HEIC and RAW photos to JPG or PNG, SVG to PNG,
  documents to PDF, scanned PDFs to text (OCR).
- Results are saved next to the originals under the name Converter Studio gives them; a taken name
  gets a number, or (`converterStudio.existingFiles: ask`) you choose to overwrite, keep both or
  skip.
- Progress notification with Cancel; three files converted at once; uploads of large files in
  parts.
- Asks before a conversion that costs more than `converterStudio.maxCredits` (default 20).
- The API key is kept in VS Code's secret storage: **Set API Key** checks it first, **Remove API
  Key**, **Show Plan and Credits**.
- `converterStudio.convert` takes `{ "to", "options", "files" }` for keybindings and other
  extensions.
