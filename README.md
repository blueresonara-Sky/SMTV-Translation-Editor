# SMTV Translation Editor

Desktop Electron app for editing and rearranging Persian subtitle rows inside a 3-column Word `.docx` subtitle table.

## Features

- Drag-and-drop `.docx` input
- Preserves row count and blank rows
- Rewrites only the Persian column
- Offline rules engine first
- Optional Gemini review for flagged groups
- Optional JSON sidecar report

## Setup

```bash
cmd /c npm install
cmd /c npm start
```

If you want Gemini review, set `GEMINI_API_KEY` in your environment before launching the app.

## Usage

1. Launch the app.
2. Drag a `.docx` subtitle file into the window or use the file picker.
3. Choose `Offline only` or `Offline + Gemini review`.
4. Click `Run editing`.
5. The tool saves a new file next to the original with the configured suffix.

## Notes

- The first version targets the sample-style Word table format: a 3-column table with English in column 2 and Persian in column 3.
- Subtitle rows before the first Persian subtitle row are treated as header rows and left untouched.
- Gemini is used only for groups the offline engine flags as ambiguous, and all Gemini output is revalidated locally before being written.
