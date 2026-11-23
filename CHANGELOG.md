# Changelog

## 1.1.0

Converts on your computer first.

- **On this computer**, the picker's default: JSON to CSV or YAML and CSV to JSON, and PNG, JPG,
  WebP, GIF, BMP, AVIF, ICO and SVG to PNG, JPG or WebP, built in; with the tools installed on the
  computer, video and audio (FFmpeg), Office documents and PDF (LibreOffice), Markdown, HTML, DOCX
  and EPUB (Pandoc), images including HEIC when it is built in (ImageMagick), smaller PDFs and a
  PDF's text (Ghostscript), and text recognition in images and scanned PDFs (Tesseract).
- Tools are found on PATH, in their usual install folders and in `converterStudio.local.toolPaths`
  (user settings only), and asked what they can do. They run with a list of arguments (no shell),
  a time limit (`converterStudio.local.timeoutMinutes`) and Cancel.
- **Converter Studio: Show Tools on This Computer** lists the tools found and what each adds.
- **Converter Studio for desktop** (`converterStudio.desktopApp.enabled`, off by default): hands the
  files to the desktop app (0.1.11 or later), where you press Convert.
- **The cloud** is a choice of its own, marked "uploads, uses credits" in the picker; a conversion
  that fails on the computer offers it and never takes it by itself. `converterStudio.cloud.enabled`
  turns it off, and the extension then never contacts converter.studio.
- Restricted Mode: in an untrusted workspace no tool runs; the built-in conversions, the desktop
  app and the cloud still work.
- `converterStudio.convert` takes `"where": "local" | "desktop" | "cloud"` (default `local`) and
  returns where it ran.

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
