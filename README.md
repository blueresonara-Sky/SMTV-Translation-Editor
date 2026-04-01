# SMTV Translation Editor

Windows desktop app for editing and rearranging Persian subtitle rows inside 3-column Word `.docx` subtitle tables.

The app keeps subtitle timing rows intact, rewrites only the Persian column, and combines:
- a local rule-based subtitle engine
- learned style preferences from sample files
- optional AI review/editing with `Gemini` or `OpenAI`

## What It Does

- Opens subtitle `.docx` files that use a 3-column Word table layout
- Preserves row count and table structure
- Keeps blank Persian rows blank
- Rewrites only the Persian column
- Uses local planning first, then optional AI review/editing
- Saves a new `.docx` beside the original
- Can optionally write a `.report.json` for debugging/review

## How To Run

1. Download and extract the Windows release zip
2. Open the extracted folder
3. Run `SMTV Translation Editor.exe`

## Current AI Support

You can choose:
- `Offline only`
- `Offline + AI review`

AI provider options:
- `Gemini`
- `OpenAI`

The app stores API keys and model settings locally between runs.

AI usage is batched to reduce request count:
- multiple subtitle groups can be sent in one request
- planning, layout choice, and light editing can be handled together

All AI output is still validated locally before it is written to the document.

## Features

- Drag-and-drop `.docx` input
- File picker fallback
- Output suffix with timestamp
- Visible app version/build in the UI
- Startup update check against the GitHub repo
- Category-aware learning profiles
- Optional JSON report output

## How It Works

The app processes files in layers:

1. Read the subtitle Word table
2. Group rows into subtitle sentence blocks
3. Tokenize Persian text into safer split units
4. Generate multiple valid layout candidates
5. Score and choose the best local layout
6. Optionally send batches of groups to AI for:
   - phrase protection
   - layout guidance
   - candidate choice
   - light Persian smoothing
7. Validate the final rows
8. Save a new `.docx`

## File Assumptions

This app currently targets subtitle files stored as:
- a Word `.docx`
- one main 3-column table
- English in column 2
- Persian in column 3

## Usage

1. Launch `SMTV Translation Editor.exe`
2. Drop a `.docx` file into the window or use `Choose File`
3. Select `Offline only` or `Offline + AI review`
4. If using AI, choose `Gemini` or `OpenAI`
5. Enter the API key if needed
6. Click `Run editing`
7. Open the new output file saved beside the original

## Notes

- Subtitle/header rows before the first Persian subtitle row are preserved
- Source/meta rows are isolated from normal subtitle planning when possible
- Blank Persian rows are preserved and not auto-filled
- The app is conservative by design: when a better arrangement cannot be validated safely, it keeps the safer output

## Status

Current release line:
- `v0.2.0`

Main recent improvements:
- provider selection for `Gemini` / `OpenAI`
- saved API keys across runs
- batched AI requests
- better drag-and-drop handling
- persistent packaged-app settings
- better tie-breaking using English row length as a timing hint
