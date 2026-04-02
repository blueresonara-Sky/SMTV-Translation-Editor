# Category Learning Data

This folder holds category-specific training corpora and cached learned profiles.

Category mapping:
- `aw-ls`: shared profile for `AW` and `LS`
- `nwn`: separate profile for `NWN`
- `bmd`: separate profile for `BMD`

The `.docx` files were imported from the archive files listed in `sources.json`.
Each category folder also contains a generated `style-profile.json` cache that the app loads automatically based on the input filename prefix.
