# Report font

The PDF report is written in Kazakh by default. jsPDF's built-in fonts are
WinAnsi-only, so Cyrillic through them comes out as mojibake — the report has to
carry a Unicode font of its own.

Three files, all of them load-bearing:

- `notoSans.base64.json` — what the code actually imports. It is a dynamic
  import, so the ~575 KB lands in its own chunk that is fetched only when
  someone exports a report, not on first paint.
- `NotoSans-Regular.ttf` — the source the JSON is generated from. It is **not**
  imported by anything and is not a leftover: it is the input to the
  regeneration one-liner documented in `../pdf.ts`, which has to be runnable
  from a fresh clone. Re-run it after replacing this file:

  ```
  node -e 'const fs=require("fs");fs.writeFileSync("lib/export/fonts/notoSans.base64.json",JSON.stringify({ttf:fs.readFileSync("lib/export/fonts/NotoSans-Regular.ttf").toString("base64")})+"\n")'
  ```

- `OFL.txt` — Noto Sans is under the SIL Open Font License, which requires the
  licence to travel with the font. Required, not optional.

Upstream: Noto Sans Regular, https://fonts.google.com/noto/specimen/Noto+Sans
