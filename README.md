# SMTV Translation Editor

Windows desktop app for editing Non-English subtitle rows inside 3-column Word `.docx` subtitle tables.

It keeps the subtitle table structure intact, rewrites only the Non-English column, and can use either local logic or AI review with `Gemini` or `OpenAI`.

## Download

1. Open the latest GitHub release
2. Download the Windows `.zip`
3. Extract it
4. Run `SMTV Translation Editor.exe`

## Run From Source

If you prefer to run the app directly from source:

1. Install Node.js
2. Clone the repository
3. Run `npm install`
4. Run `npm start`

## What It Does

- Opens subtitle `.docx` files that use a 3-column table layout
- Preserves row count and table structure
- Keeps blank Non-English rows blank
- Rewrites only the Non-English column
- Generates safer subtitle layouts from full sentence groups
- Optionally uses AI for phrase protection, layout guidance, and light editing
- Saves a new `.docx` beside the original
- Can optionally write a `.report.json` for debugging and review

## How To Use

1. Launch `SMTV Translation Editor.exe`
2. Drop a `.docx` file into the window or use `Choose File`
3. Select `Offline only` or `Offline + AI review`
4. If using AI, choose `Gemini` or `OpenAI`
5. Enter the API key if needed
6. Click `Run editing`
7. Open the output file saved beside the original

## Features

- Drag-and-drop `.docx` input
- Local subtitle planning and validation
- Optional batched AI review
- `Gemini` and `OpenAI` provider support
- Saved API keys and model settings
- Output suffix with timestamp
- Visible app version/build in the UI
- Startup update check against the GitHub repo
- Category-aware learning profiles
- Optional JSON report output

## How It Works

1. Read the subtitle Word table
2. Group rows into sentence blocks
3. Build safe Non-English split units
4. Generate multiple valid layout candidates
5. Score and choose the best local layout
6. Optionally send batches to AI for:
   - phrase protection
   - layout guidance
   - candidate choice
   - light Non-English smoothing
7. Validate the final rows
8. Save a new `.docx`

## File Format

This app currently targets subtitle files stored as:

- a Word `.docx`
- one main 3-column table
- English in column 2
- Non-English in column 3

## Notes

- Subtitle/header rows before the first Non-English subtitle row are preserved
- Source/meta rows are isolated from normal subtitle planning when possible
- Blank Non-English rows are preserved and not auto-filled
- AI output is always validated locally before being applied

## Current Version

`v0.2.0`
