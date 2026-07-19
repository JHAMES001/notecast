# notecast

A web app that turns your PDF/Word/PowerPoint notes into audio, read back
to you in the mode you choose: Discussion, Storytelling, or Calm.

```
notecast-backend/
├── index.html          ← the app UI
├── style.css            ← design system ("reading lamp at night")
├── script.js             ← upload, mode picker, and playback logic
├── api/
│   ├── extract.js       ← Vercel function: file → plain text
│   └── generate-script.js ← Vercel function: text + mode → speaker script
└── lib/
    ├── extractText.js   ← PDF/DOCX/PPTX/TXT/MD parsing
    └── modePrompts.js   ← the 7 mode-tree leaves → system prompts
```

## 1. Install

```bash
cd notecast-backend
npm install
```

## 2. Set your Groq key

```bash
copy .env.example .env
```

Edit `.env` and paste in your real key:
```
GROQ_API_KEY=gsk_your_real_key_here
```

## 3. Run it locally

```bash
npm install -g vercel   # one-time, if you don't have it
vercel dev
```

This serves the whole app — frontend and API together — usually at
`http://localhost:3000`. Open that in your browser (Chrome recommended,
since the Web Speech API has the best support there).

## 4. Try it

1. Drag a PDF/DOCX/PPTX onto the dropzone, or click to browse.
2. Once it's read, pick a mode: Discussion → voice count → depth,
   Story → bedtime/drama, or Calm (single click, no sub-options).
3. Wait for the script to generate, then hit play. The transcript
   highlights the current line as it's read aloud.

## Known limits (v1, by design)

- **Voices**: uses the browser's built-in Web Speech API voices — free,
  but robotic and limited by whatever voices your OS/browser exposes.
  Different speakers are assigned different system voices where
  available, with a pitch offset as a fallback. Upgrading to a paid
  TTS API (e.g. ElevenLabs) later only requires changing the playback
  code in `script.js` — extraction and script generation stay the same.
- **File size cap**: 20MB per upload.
- **Text length cap**: ~24,000 characters sent to the model per request.
  Longer documents get truncated for now (`generate-script.js` returns
  `truncated: true` when this happens) — chunking into multiple script
  segments is a good next step.
- **Scanned PDFs / image-only slides** aren't supported yet — no OCR.
- Supported formats: `.pdf`, `.docx`, `.pptx`, `.txt`, `.md`.
- Playback doesn't yet persist across page reloads — refreshing mid-story
  starts you back at upload.

## 5. Deploy

Push this repo to GitHub, then go to vercel.com → **Add New Project** →
import the repo. No config needed — Vercel auto-detects the `api/`
folder as functions and serves `index.html` as the site. Add your
`GROQ_API_KEY` under **Settings → Environment Variables** before or
after the first deploy (redeploy if added after).

## Important: keep this project out of OneDrive (or any synced folder)

If this folder lives inside OneDrive, Dropbox, or Google Drive, `npm install`
can fail or corrupt `node_modules` because the sync client locks files
while npm is writing thousands of small files. Keep it somewhere local
and unsynced, e.g. `C:\Users\<you>\Projects\notecast-backend`.

## What's next

- A native mobile app (React Native + Expo) that calls these same two
  `/api` endpoints, using `expo-speech` instead of the Web Speech API.
- Chunking long documents instead of truncating them.
- Optional: upgrade to a paid TTS API for more natural voices.

## Appendix: testing the API directly

Useful if you want to test extraction or script generation without the
UI (e.g. debugging a specific file).

**Extraction:**
```powershell
$fileBytes = [System.IO.File]::ReadAllBytes("your-notes.pdf")
$base64 = [System.Convert]::ToBase64String($fileBytes)
$body = @{ filename = "your-notes.pdf"; fileData = $base64 } | ConvertTo-Json
$utf8Bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
Invoke-RestMethod -Uri http://localhost:3000/api/extract -Method Post -Body $utf8Bytes -ContentType "application/json" -Headers @{Expect=""}
```

**Script generation** (valid `mode`/`voiceCount`/`depth`/`storyType`
combinations are listed in the table below):

```powershell
$body = @{
  text = "your extracted text here"
  mode = "discussion"
  voiceCount = "twoVoice"
  depth = "general"
} | ConvertTo-Json
$utf8Bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
Invoke-RestMethod -Uri http://localhost:3000/api/generate-script -Method Post -Body $utf8Bytes -ContentType "application/json" -Headers @{Expect=""}
```

| mode         | voiceCount           | depth                | storyType         |
|--------------|-----------------------|------------------------|--------------------|
| `discussion` | `oneVoice`/`twoVoice` | `inDepth`/`general`  | —                  |
| `story`      | —                      | —                      | `bedtime`/`drama` |
| `calm`       | —                      | —                      | —                  |

Note the `-Headers @{Expect=""}` and UTF-8 byte conversion — both are
needed on Windows PowerShell to avoid a header-encoding quirk between
PowerShell and Vercel's local dev server.
