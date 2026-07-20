#  Notecast

> **Turn your notes into audio and interactive quizzes.**

Notecast is an AI-powered study tool that transforms your PDFs, Word docs, and PowerPoints into audio discussions and interactive quizzes. Upload your notes, choose how you want to learn, and start studying.

**Try it live:** [notecasting.vercel.app](https://notecasting.vercel.app/)

---

##  Features

- **Upload** – Drag & drop PDF, Word, PowerPoint, or text files
- **Listen** – Hear your notes as a discussion, story, or calm voice
- **Quiz yourself** – Multiple-choice, identification, or enumeration questions
- **Timer** – Challenge yourself with or without a time limit
- **Track progress** – Instant feedback, score tracking, and weak area identification

---

## Tech Stack

- **Frontend:** HTML, CSS, JavaScript · Web Speech API
- **Backend:** Node.js · Express · Groq AI (LLaMA 3)
- **Deployment:** Vercel

---

## Quick Start

```bash
git clone https://github.com/jhames001/notecast.git
cd notecast-backend
npm install
cp .env.example .env
# Add your API_KEY to .env
vercel dev

## Project Structure

notecast-backend/
├── index.html          # App UI
├── style.css           # Design system
├── script.js           # Upload, playback, and quiz logic
├── api/                # Vercel serverless functions
│   ├── extract.js
│   ├── generate-script.js
│   ├── analyze-quiz.js
│   └── generate-quiz.js
└── lib/                # Helpers
    ├── extractText.js
    └── modePrompts.js

## Known Limitations
Uses browser's Web Speech API (voices are OS/browser dependent)

20MB file size limit

~24,000 character text limit

No OCR for scanned PDFs/images

## License
MIT © Jhames Gequinto

