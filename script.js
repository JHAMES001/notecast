// ---------------------------------------------------------------------
// Notecast frontend state machine
// Flow: upload -> extracting -> mode picker -> generating -> player
// ---------------------------------------------------------------------

const SUPPORTED_EXTENSIONS = ["pdf", "docx", "pptx", "txt", "md"];
// Vercel serverless functions have a hard 4.5MB request-body limit that
// can't be raised. We send files as base64 inside JSON, which inflates
// size by ~33%, so the real ceiling on the raw file is roughly 3.3MB.
// 3MB leaves a safety margin for the JSON wrapper overhead.
const MAX_FILE_BYTES = 3 * 1024 * 1024;

// fetch().json() throws a cryptic "Unexpected token... is not valid JSON"
// error whenever the server/platform returns plain text instead of JSON —
// e.g. Vercel's raw "Request Entity Too Large" or "A server error has
// occurred" pages for platform-level failures that never reach our own
// code. This wraps that so those cases produce a readable message instead.
async function parseJsonSafe(res) {
  const raw = await res.text();
  try {
    return JSON.parse(raw);
  } catch {
    if (res.status === 413) {
      throw new Error("That file is too large for the server to accept. Try a smaller file.");
    }
    throw new Error(
      `The server sent back something unexpected (status ${res.status}). Please try again in a moment.`
    );
  }
}

const state = {
  filename: null,
  extractedText: null,
  selection: {}, // { mode, voiceCount?, depth?, storyType?, quizMode? }
  script: null, // [{ speaker, text }]
  speakers: [],
  playback: {
    index: 0,
    isPlaying: false,
    isPaused: false,
    voiceMap: {}, // speaker -> SpeechSynthesisVoice
  },
  quiz: {
    questions: [],
    currentIndex: 0,
    score: 0,
    wrongQuestions: [], // indices of wrong answers
    isPaused: false,
    answered: false,
    mode: null, // 'multiple-choice', 'identification', 'enumeration', 'mixed'
    selectedOption: null, // for MCQ
    userInput: '', // for ID/Enum
    timer: null, // { type: 'perQuestion', seconds } | { type: 'overall', minutes } | null
    perQuestionRemaining: 0,
    perQuestionIntervalId: null,
    overallRemaining: 0,
    overallIntervalId: null,
  },
};

// --- DOM refs -----------------------------------------------------------

const sections = {
  upload: document.getElementById("upload-section"),
  extracting: document.getElementById("extracting-section"),
  mode: document.getElementById("mode-section"),
  generating: document.getElementById("generating-section"),
  player: document.getElementById("player-section"),
  quiz: document.getElementById("quiz-section"),
};

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const uploadError = document.getElementById("upload-error");
const extractingFilename = document.getElementById("extracting-filename");
const fileChipName = document.getElementById("file-chip-name");
const changeFileBtn = document.getElementById("change-file");
const generatingText = document.getElementById("generating-text");
const transcriptEl = document.getElementById("transcript");
const waveformEl = document.getElementById("waveform");
const playPauseBtn = document.getElementById("play-pause-btn");
const playIcon = document.getElementById("play-icon");
const pauseIcon = document.getElementById("pause-icon");
const playerStatus = document.getElementById("player-status");
const restartBtn = document.getElementById("restart-btn");
const homeBtn = document.getElementById("home-btn");
const backToUploadBtn = document.getElementById("back-to-upload");
const backToModesBtn = document.getElementById("back-to-modes");
const voicePickerEl = document.getElementById("voice-picker");
const voicePickerHint = document.getElementById("voice-picker-hint");
const modeTreeEl = document.getElementById("mode-tree");
const modeConfirmEl = document.getElementById("mode-confirm");
const modeConfirmText = document.getElementById("mode-confirm-text");
const confirmGenerateBtn = document.getElementById("confirm-generate-btn");
const confirmChangeBtn = document.getElementById("confirm-change-btn");

// --- Quiz DOM refs ---
const quizSection = document.getElementById("quiz-section");
const quizProgress = document.getElementById("quiz-progress");
const quizQuestion = document.getElementById("quiz-question");
const quizAnswerArea = document.getElementById("quiz-answer-area");
const quizFeedback = document.getElementById("quiz-feedback");
const quizSubmitBtn = document.getElementById("quiz-submit-btn");
const quizNextBtn = document.getElementById("quiz-next-btn");
const quizPauseBtn = document.getElementById("quiz-pause-btn");
const quizContinueBtn = document.getElementById("quiz-continue-btn");
const quizSummary = document.getElementById("quiz-summary");
const quizFinalScore = document.getElementById("quiz-final-score");
const quizStrongAreas = document.getElementById("quiz-strong-areas");
const quizWeakAreas = document.getElementById("quiz-weak-areas");
const quizSuggestion = document.getElementById("quiz-suggestion");
const quizDrillBtn = document.getElementById("quiz-drill-btn");
const quizSwitchModeBtn = document.getElementById("quiz-switch-mode-btn");
const quizStopBtn = document.getElementById("quiz-stop-btn");
const quizModeOptions = document.getElementById("quiz-mode-options");
const quizModeLoading = document.getElementById("quiz-mode-loading");
const backToModesFromQuiz = document.getElementById("back-to-modes-from-quiz");
const quizCountOptions = document.getElementById("quiz-count-options");
const quizTimerChoiceOptions = document.getElementById("quiz-timer-choice-options");
const quizTimerTypeOptions = document.getElementById("quiz-timer-type-options");
const quizPerQuestionOptions = document.getElementById("quiz-per-question-options");
const quizOverallTimerOptions = document.getElementById("quiz-overall-timer-options");
const quizCustomMinutesInput = document.getElementById("quiz-custom-minutes");
const quizCustomMinutesBtn = document.getElementById("quiz-custom-minutes-btn");
const quizTimerDisplay = document.getElementById("quiz-timer-display");
const quizScoreEl = document.getElementById("quiz-score");

function showSection(name) {
  for (const key in sections) {
    sections[key].dataset.state = key === name ? "active" : "hidden";
  }
}

// --- Step 1: Upload ------------------------------------------------------

dropzone.addEventListener("click", () => fileInput.click());

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (file) handleFile(file);
});

function showUploadError(message) {
  uploadError.textContent = message;
  uploadError.hidden = false;
}

function clearUploadError() {
  uploadError.hidden = true;
}

async function handleFile(file) {
  clearUploadError();

  const ext = file.name.split(".").pop().toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    showUploadError(
      `"${ext}" isn't supported yet. Try a PDF, Word, or PowerPoint file.`
    );
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    showUploadError("That file is over 3MB — the hosting platform caps uploads at that size. Try a smaller file, or export a version without large embedded images.");
    return;
  }

  state.filename = file.name;
  extractingFilename.textContent = file.name;
  showSection("extracting");

  try {
    const base64 = await fileToBase64(file);
    const res = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: file.name, fileData: base64 }),
    });
    const data = await parseJsonSafe(res);

    if (!res.ok) {
      throw new Error(data.error || "Couldn't read that file.");
    }

    state.extractedText = data.text;
    fileChipName.textContent = file.name;
    resetModePicker();
    showSection("mode");
  } catch (err) {
    showSection("upload");
    showUploadError(err.message || "Something went wrong reading that file.");
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result is "data:<mime>;base64,<data>" — strip the prefix
      const base64 = reader.result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsDataURL(file);
  });
}

changeFileBtn.addEventListener("click", () => {
  state.filename = null;
  state.extractedText = null;
  fileInput.value = "";
  showSection("upload");
});

// --- Navigation: home + back buttons -----------------------------------

function goHome() {
  window.speechSynthesis.cancel();
  state.filename = null;
  state.extractedText = null;
  state.script = null;
  state.speakers = [];
  fileInput.value = "";
  clearUploadError();
  resetQuizState();
  showSection("upload");
}

homeBtn.addEventListener("click", goHome);
backToUploadBtn.addEventListener("click", goHome);

backToModesBtn.addEventListener("click", () => {
  window.speechSynthesis.cancel();
  state.script = null;
  resetModePicker();
  showSection("mode");
});

// --- Step 2: Mode picker --------------------------------------------------

function resetModePicker() {
  state.selection = {};
  document.getElementById("mode-error").hidden = true;
  modeConfirmEl.hidden = true;
  modeTreeEl.hidden = false;
  document.querySelectorAll(".mode-panel").forEach((p) => (p.hidden = true));
  document.querySelectorAll(".mode-trigger").forEach((t) =>
    t.setAttribute("aria-expanded", "false")
  );
  document.querySelectorAll(".option-btn.selected").forEach((b) =>
    b.classList.remove("selected")
  );
  document.querySelectorAll('[data-step="depth"]').forEach((row) => (row.hidden = true));
  // Reset quiz panel content
  quizModeOptions.innerHTML = '';
  quizModeLoading.hidden = true;
  resetQuizPickerSteps();
  resetQuizState();
}

// Hides and clears the question-count/timer sub-steps of the quiz
// picker, so re-opening quiz mode (or picking a different file) doesn't
// leave a stale selection lingering from a previous run.
function resetQuizPickerSteps() {
  quizCountOptions.hidden = true;
  quizTimerChoiceOptions.hidden = true;
  quizTimerTypeOptions.hidden = true;
  quizPerQuestionOptions.hidden = true;
  quizOverallTimerOptions.hidden = true;
  [quizCountOptions, quizTimerChoiceOptions, quizTimerTypeOptions, quizPerQuestionOptions, quizOverallTimerOptions]
    .forEach((row) => row.querySelectorAll(".option-btn.selected").forEach((b) => b.classList.remove("selected")));
  quizCustomMinutesInput.value = "";
}

document.querySelectorAll(".mode-trigger[data-target]").forEach((trigger) => {
  trigger.addEventListener("click", () => {
    const targetId = trigger.dataset.target;
    const panel = document.getElementById(targetId);
    const isOpen = !panel.hidden;

    // accordion: close all other panels first
    document.querySelectorAll(".mode-panel").forEach((p) => (p.hidden = true));
    document.querySelectorAll(".mode-trigger[data-target]").forEach((t) =>
      t.setAttribute("aria-expanded", "false")
    );

    if (!isOpen) {
      panel.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      // If it's the quiz panel, analyse notes
      if (targetId === "panel-quiz") {
        analyseNotesForQuiz();
      }
    }
  });
});

// Calm mode: single click, no sub-options, straight to confirmation
document.querySelector('[data-immediate="calm"]').addEventListener("click", () => {
  state.selection = { mode: "calm" };
  showModeConfirm();
});

// Discussion mode: voiceCount -> depth
const discussionPanel = document.getElementById("panel-discussion");
discussionPanel.querySelectorAll('[data-step="voiceCount"] .option-btn').forEach((btn) => {
  btn.addEventListener("click", () => {
    discussionPanel
      .querySelectorAll('[data-step="voiceCount"] .option-btn')
      .forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    state.selection = { mode: "discussion", voiceCount: btn.dataset.value };
    discussionPanel.querySelector('[data-step="depth"]').hidden = false;
  });
});
discussionPanel.querySelectorAll('[data-step="depth"] .option-btn').forEach((btn) => {
  btn.addEventListener("click", () => {
    discussionPanel
      .querySelectorAll('[data-step="depth"] .option-btn')
      .forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    state.selection.depth = btn.dataset.value;
    showModeConfirm();
  });
});

// Story mode: storyType only
const storyPanel = document.getElementById("panel-story");
storyPanel.querySelectorAll(".option-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    storyPanel.querySelectorAll(".option-btn").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    state.selection = { mode: "story", storyType: btn.dataset.value };
    showModeConfirm();
  });
});

// --- Quiz analysis ---
async function analyseNotesForQuiz() {
  quizModeLoading.hidden = false;
  quizModeOptions.innerHTML = '';
  resetQuizPickerSteps();

  try {
    const res = await fetch('/api/analyze-quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: state.extractedText }),
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.error || 'Analysis failed');

    const modes = data.modes || [];
    if (!modes.length) {
      quizModeOptions.innerHTML = '<p class="error-text">No quiz modes available for these notes.</p>';
      return;
    }

    const modeLabels = {
      'multiple-choice': 'Multiple Choice',
      'identification': 'Identification',
      'enumeration': 'Enumeration',
      'mixed': 'Mixed Mode',
    };
    modes.forEach((mode) => {
      const btn = document.createElement('button');
      btn.className = 'option-btn';
      btn.dataset.value = mode;
      btn.textContent = modeLabels[mode] || mode;
      btn.type = 'button';
      btn.addEventListener('click', () => {
        quizModeOptions.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        state.selection = { mode: 'quiz', quizMode: mode };
        // Reveal the next step (question count) instead of confirming
        // right away — timer settings still need to be chosen first.
        quizTimerChoiceOptions.hidden = true;
        quizTimerTypeOptions.hidden = true;
        quizPerQuestionOptions.hidden = true;
        quizOverallTimerOptions.hidden = true;
        quizCountOptions.hidden = false;
      });
      quizModeOptions.appendChild(btn);
    });
  } catch (err) {
    quizModeOptions.innerHTML = `<p class="error-text">${err.message}</p>`;
  } finally {
    quizModeLoading.hidden = true;
  }
}

// Question count -> reveal timer choice
quizCountOptions.querySelectorAll(".option-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    quizCountOptions.querySelectorAll(".option-btn").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    state.selection.questionCount = Number(btn.dataset.value);
    quizTimerTypeOptions.hidden = true;
    quizPerQuestionOptions.hidden = true;
    quizOverallTimerOptions.hidden = true;
    quizTimerChoiceOptions.hidden = false;
  });
});

// Timer choice: no timer -> confirm now; with timer -> reveal timer type
quizTimerChoiceOptions.querySelectorAll(".option-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    quizTimerChoiceOptions.querySelectorAll(".option-btn").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    if (btn.dataset.value === "none") {
      state.selection.timer = null;
      showModeConfirm();
    } else {
      quizPerQuestionOptions.hidden = true;
      quizOverallTimerOptions.hidden = true;
      quizTimerTypeOptions.hidden = false;
    }
  });
});

// Timer type: per-question -> reveal seconds; overall -> reveal minutes picker
quizTimerTypeOptions.querySelectorAll(".option-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    quizTimerTypeOptions.querySelectorAll(".option-btn").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    if (btn.dataset.value === "perQuestion") {
      quizOverallTimerOptions.hidden = true;
      quizPerQuestionOptions.hidden = false;
    } else {
      quizPerQuestionOptions.hidden = true;
      quizOverallTimerOptions.hidden = false;
    }
  });
});

// Per-question seconds -> confirm
quizPerQuestionOptions.querySelectorAll(".option-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    quizPerQuestionOptions.querySelectorAll(".option-btn").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    state.selection.timer = { type: "perQuestion", seconds: Number(btn.dataset.value) };
    showModeConfirm();
  });
});

// Overall quiz timer: preset minutes -> confirm
quizOverallTimerOptions.querySelectorAll(".option-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    quizOverallTimerOptions.querySelectorAll(".option-btn").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    state.selection.timer = { type: "overall", minutes: Number(btn.dataset.value) };
    showModeConfirm();
  });
});

// Overall quiz timer: custom minutes -> confirm
quizCustomMinutesBtn.addEventListener("click", () => {
  const minutes = Number(quizCustomMinutesInput.value);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 180) {
    quizCustomMinutesInput.focus();
    return;
  }
  quizOverallTimerOptions.querySelectorAll(".option-btn").forEach((b) => b.classList.remove("selected"));
  state.selection.timer = { type: "overall", minutes };
  showModeConfirm();
});

// --- Step 3: Confirmation (prevents an accidental tap from firing a
// real API call) --------------------------------------------------------

const MODE_LABELS = {
  "discussion.oneVoice.inDepth": "a 1-voice, in-depth discussion",
  "discussion.oneVoice.general": "a 1-voice, general discussion",
  "discussion.twoVoice.inDepth": "a 2-voice, in-depth discussion",
  "discussion.twoVoice.general": "a 2-voice, general discussion",
  "story.bedtime": "a bedtime story",
  "story.drama": "a drama",
  calm: "calm mode",
};

function describeSelection(selection) {
  if (selection.mode === "discussion") {
    const key = `discussion.${selection.voiceCount}.${selection.depth}`;
    return MODE_LABELS[key] || "a discussion";
  }
  if (selection.mode === "story") {
    return MODE_LABELS[`story.${selection.storyType}`] || "a story";
  }
  if (selection.mode === "calm") {
    return MODE_LABELS.calm;
  }
  if (selection.mode === "quiz") {
    const quizModeLabels = {
      'multiple-choice': 'Multiple Choice',
      'identification': 'Identification',
      'enumeration': 'Enumeration',
      'mixed': 'Mixed Mode',
    };
    const base = `a ${selection.questionCount || 10}-question ${quizModeLabels[selection.quizMode] || 'quiz'} quiz`;
    if (!selection.timer) return `${base}, no timer`;
    if (selection.timer.type === "perQuestion") return `${base}, ${selection.timer.seconds}s per question`;
    if (selection.timer.type === "overall") return `${base}, ${selection.timer.minutes}-minute overall timer`;
    return base;
  }
  return "this mode";
}

function showModeConfirm() {
  modeTreeEl.hidden = true;
  modeConfirmText.innerHTML = `Generate <strong>${describeSelection(state.selection)}</strong> from "${state.filename}"?`;
  modeConfirmEl.hidden = false;
}

confirmGenerateBtn.addEventListener("click", () => {
  if (state.selection.mode === 'quiz') {
    generateQuiz();
  } else {
    generateScript();
  }
});

confirmChangeBtn.addEventListener("click", () => {
  resetModePicker();
});

// --- Step 4: Generate script (audio) --------------------------------------

async function generateScript() {
  document.getElementById("mode-error").hidden = true;
  showSection("generating");

  try {
    const res = await fetch("/api/generate-script", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: state.extractedText,
        ...state.selection,
      }),
    });
    const data = await parseJsonSafe(res);

    if (!res.ok) {
      throw new Error(data.error || "Couldn't generate a script for that.");
    }

    state.script = data.script;
    state.speakers = data.speakers;
    state.playback.baseStyle = data.voiceStyle || { rate: 1, pitch: 1 };
    buildTranscript();
    assignVoices();
    showSection("player");
    resetPlayback();
  } catch (err) {
    showSection("mode");
    const errorEl = document.getElementById("mode-error");
    errorEl.textContent = err.message || "Something went wrong generating the script.";
    errorEl.hidden = false;
  }
}

// --- Quiz generation -------------------------------------------------------

async function generateQuiz() {
  document.getElementById('mode-error').hidden = true;
  showSection('generating');
  generatingText.textContent = 'Generating your quiz…';

  try {
    const res = await fetch('/api/generate-quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: state.extractedText,
        quizMode: state.selection.quizMode,
        questionCount: state.selection.questionCount || 10,
      }),
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.error || 'Could not generate quiz.');

    state.quiz.questions = data.questions;
    state.quiz.currentIndex = 0;
    state.quiz.score = 0;
    state.quiz.wrongQuestions = [];
    state.quiz.answered = false;
    state.quiz.isPaused = false;
    state.quiz.mode = state.selection.quizMode;
    state.quiz.timer = state.selection.timer || null;

    showSection('quiz');
    startOverallTimerIfNeeded();
    renderQuizQuestion();
  } catch (err) {
    showSection('mode');
    const errorEl = document.getElementById('mode-error');
    errorEl.textContent = err.message || 'Something went wrong generating the quiz.';
    errorEl.hidden = false;
  } finally {
    generatingText.textContent = 'Writing your script…'; // reset
  }
}

// --- Step 4: Transcript + voices -------------------------------------------

function buildTranscript() {
  transcriptEl.innerHTML = "";
  state.script.forEach((line, i) => {
    const row = document.createElement("div");
    row.className = "transcript-line";
    row.id = `line-${i}`;
    row.innerHTML = `<span class="speaker-tag">${escapeHtml(line.speaker)}</span><span>${escapeHtml(line.text)}</span>`;
    transcriptEl.appendChild(row);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Browsers don't expose real gender metadata for voices, but most
// system/Edge voice names follow known conventions. This is a rough
// label to help with picking, not a guarantee.
const MALE_NAME_HINTS = ["david", "mark", "guy", "ryan", "christopher", "eric", "james", "roger", "andrew", "george", "daniel", "tony"];
const FEMALE_NAME_HINTS = ["zira", "aria", "jenny", "michelle", "ana", "emma", "samantha", "susan", "karen", "victoria", "zoe", "sara", "catherine", "hazel", "linda", "female"];

function guessVoiceGender(voiceName) {
  const lower = voiceName.toLowerCase();
  if (MALE_NAME_HINTS.some((hint) => lower.includes(hint))) return "male-leaning";
  if (FEMALE_NAME_HINTS.some((hint) => lower.includes(hint))) return "female-leaning";
  return null;
}

// Maps each distinct speaker name to a distinct system voice. When a
// speaker's label hints at a gender (e.g. "man", "woman", or a
// recognizably gendered name from the script), we try to match a voice
// leaning that way first. Gendered speakers are matched BEFORE neutral
// ones (like "narrator") claim a voice, so a generic first-pass narrator
// doesn't accidentally take the only male- or female-leaning voice
// before the speakers who actually need it get a turn.
// Some browsers (notably Edge) expose noticeably more natural-sounding
// "Online (Natural)" neural voices alongside legacy robotic ones, through
// the exact same free API. When present, prefer them — costs nothing,
// sounds meaningfully better.
function voiceQualityScore(voice) {
  const name = voice.name.toLowerCase();
  if (name.includes("online") || name.includes("natural")) return 2;
  if (name.includes("neural")) return 2;
  return 0;
}

function assignVoices() {
  const voices = window.speechSynthesis.getVoices();
  const englishVoices = voices.filter((v) => v.lang.startsWith("en"));
  const unsorted = englishVoices.length ? englishVoices : voices;
  const pool = [...unsorted].sort((a, b) => voiceQualityScore(b) - voiceQualityScore(a));

  state.playback.voicePool = pool;
  state.playback.voiceMap = {};

  const usedVoiceNames = new Set();
  const gendered = state.speakers.filter((s) => guessSpeakerGender(s));
  const neutral = state.speakers.filter((s) => !guessSpeakerGender(s));
  const orderedSpeakers = [...gendered, ...neutral];

  orderedSpeakers.forEach((speaker) => {
    const wantedGender = guessSpeakerGender(speaker);
    let chosen = null;

    if (wantedGender) {
      chosen = pool.find(
        (v) => !usedVoiceNames.has(v.name) && guessVoiceGender(v.name) === wantedGender
      );
    }
    if (!chosen) {
      chosen = pool.find((v) => !usedVoiceNames.has(v.name)) || pool[0] || null;
    }
    if (chosen) usedVoiceNames.add(chosen.name);

    const originalIndex = state.speakers.indexOf(speaker);
    state.playback.voiceMap[speaker] = {
      voice: chosen,
      pitchDelta: originalIndex % 2 === 0 ? 0 : 0.15, // fallback differentiator if voices repeat
    };
  });

  buildVoicePicker();
}

// Guesses a speaker's intended gender from their script label (e.g.
// "man", "woman", "narrator" -> null since narrators are neutral).
function guessSpeakerGender(speakerLabel) {
  const lower = speakerLabel.toLowerCase();
  if (["man", "male", "father", "husband", "boy", "king", "he"].some((w) => lower.includes(w))) {
    return "male-leaning";
  }
  if (["woman", "female", "mother", "wife", "girl", "queen", "she"].some((w) => lower.includes(w))) {
    return "female-leaning";
  }
  return null;
}

function buildVoicePicker() {
  const pool = state.playback.voicePool || [];
  voicePickerEl.innerHTML = "";

  if (!pool.length) {
    voicePickerHint.hidden = true;
    return; // no voices loaded yet
  }
  voicePickerHint.hidden = false;

  state.speakers.forEach((speaker) => {
    const row = document.createElement("div");
    row.className = "voice-picker-row";

    const label = document.createElement("label");
    label.textContent = speaker;
    label.setAttribute("for", `voice-select-${speaker}`);

    const select = document.createElement("select");
    select.id = `voice-select-${speaker}`;

    pool.forEach((voice, i) => {
      const option = document.createElement("option");
      option.value = i;
      const gender = guessVoiceGender(voice.name);
      option.textContent = gender ? `${voice.name} (${gender})` : voice.name;
      const current = state.playback.voiceMap[speaker]?.voice;
      if (current && current.name === voice.name && current.lang === voice.lang) {
        option.selected = true;
      }
      select.appendChild(option);
    });

    select.addEventListener("change", () => {
      state.playback.voiceMap[speaker].voice = pool[Number(select.value)];
    });

    row.appendChild(label);
    row.appendChild(select);
    voicePickerEl.appendChild(row);
  });
}

// speechSynthesis.getVoices() can load asynchronously on first page load
if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    if (state.script) assignVoices();
  };
}

// Splits a line of text into individual sentences so each one can get
// its own brief pause and its own intonation, instead of the whole line
// being read as one flat, unbroken block — a big source of the "robotic"
// feel even with a good voice. Ellipses are protected from being split
// mid-way (so "..." stays one pause-beat, not three fragments).
function splitIntoSentences(text) {
  const ELLIPSIS_TOKEN = "\u0000";
  const protectedText = text.replace(/\.\.\./g, ELLIPSIS_TOKEN);
  const rawParts = protectedText.split(/(?<=[.!?])\s+/);
  return rawParts
    .map((p) => p.replace(new RegExp(ELLIPSIS_TOKEN, "g"), "..."))
    .map((p) => p.trim())
    .filter(Boolean);
}

// Adjusts rate/pitch per sentence based on punctuation (question lift,
// exclamation energy), dramatic pause-beats (slower), and a small
// rhythmic wobble across consecutive sentences so pacing doesn't sound
// perfectly metronomic — real speech never holds one exact pace.
function sentenceStyle(sentence, baseStyle, pitchDelta, sentenceIndex) {
  let rate = baseStyle.rate;
  let pitch = baseStyle.pitch + (pitchDelta || 0);
  const trimmed = sentence.trim();

  if (trimmed.endsWith("?")) pitch += 0.06;
  if (trimmed.endsWith("!")) {
    rate += 0.05;
    pitch += 0.04;
  }
  if (/^\.\.\.+$/.test(trimmed) || trimmed.startsWith("...")) {
    rate -= 0.15; // pause-beat lines land slower and heavier
  }

  const wobble = ((sentenceIndex % 3) - 1) * 0.015; // -0.015, 0, +0.015 cycling
  rate += wobble;

  return {
    rate: Math.min(2, Math.max(0.1, rate)),
    pitch: Math.min(2, Math.max(0, pitch)),
  };
}

// --- Step 5: Playback -------------------------------------------------------

function resetPlayback() {
  window.speechSynthesis.cancel();
  state.playback.index = 0;
  state.playback.isPlaying = false;
  state.playback.isPaused = false;
  state.playback.resumeFn = null;
  updatePlayerUI();
  clearHighlight();
}

function updatePlayerUI() {
  const { isPlaying } = state.playback;
  playIcon.hidden = isPlaying;
  pauseIcon.hidden = !isPlaying;
  playPauseBtn.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
  waveformEl.classList.toggle("speaking", isPlaying);

  if (state.playback.index >= state.script.length) {
    playerStatus.textContent = "Finished";
  } else if (isPlaying) {
    playerStatus.textContent = `Reading line ${state.playback.index + 1} of ${state.script.length}`;
  } else if (state.playback.isPaused) {
    playerStatus.textContent = "Paused";
  } else {
    playerStatus.textContent = "Ready";
  }
}

function clearHighlight() {
  document.querySelectorAll(".transcript-line.current").forEach((el) =>
    el.classList.remove("current")
  );
}

function highlightLine(i) {
  clearHighlight();
  const el = document.getElementById(`line-${i}`);
  if (el) {
    el.classList.add("current");
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

// Speaks one sentence, then (after a natural pause — longer for dramatic
// beats) moves to the next. Stores a resume point on state.playback so
// pausing mid-gap between sentences can be resumed correctly rather than
// silently stalling.
function speakSentenceQueue(sentences, chunkIndex, voiceConfig, baseStyle, onDone) {
  if (chunkIndex >= sentences.length) {
    onDone();
    return;
  }

  const sentence = sentences[chunkIndex];
  const utterance = new SpeechSynthesisUtterance(sentence);
  if (voiceConfig.voice) utterance.voice = voiceConfig.voice;
  const style = sentenceStyle(sentence, baseStyle, voiceConfig.pitchDelta, chunkIndex);
  utterance.rate = style.rate;
  utterance.pitch = style.pitch;

  utterance.onend = () => {
    if (!state.playback.isPlaying) return; // paused mid-utterance
    const isPauseBeat = /^\.\.\.+$/.test(sentence.trim()) || sentence.trim().startsWith("...");
    const gapMs = isPauseBeat ? 550 : 130;

    state.playback.resumeFn = () =>
      speakSentenceQueue(sentences, chunkIndex + 1, voiceConfig, baseStyle, onDone);

    setTimeout(() => {
      if (!state.playback.isPlaying) return; // paused during the gap
      state.playback.resumeFn = null;
      speakSentenceQueue(sentences, chunkIndex + 1, voiceConfig, baseStyle, onDone);
    }, gapMs);
  };

  utterance.onerror = () => {
    state.playback.isPlaying = false;
    updatePlayerUI();
  };

  window.speechSynthesis.speak(utterance);
}

function speakLine(i) {
  if (i >= state.script.length) {
    state.playback.isPlaying = false;
    updatePlayerUI();
    return;
  }

  const line = state.script[i];
  const voiceConfig = state.playback.voiceMap[line.speaker] || {};
  const baseStyle = state.playback.baseStyle || { rate: 1, pitch: 1 };
  const sentences = splitIntoSentences(line.text);
  const chunks = sentences.length ? sentences : [line.text];

  highlightLine(i);
  updatePlayerUI();

  speakSentenceQueue(chunks, 0, voiceConfig, baseStyle, () => {
    if (!state.playback.isPlaying) return;
    state.playback.index = i + 1;
    speakLine(state.playback.index);
  });
}

playPauseBtn.addEventListener("click", () => {
  const { isPlaying, isPaused } = state.playback;

  if (isPlaying) {
    // pause — native pause handles the common case (mid-utterance);
    // resumeFn (set in speakSentenceQueue) covers the rarer case of
    // pausing during the brief gap between sentences.
    window.speechSynthesis.pause();
    state.playback.isPlaying = false;
    state.playback.isPaused = true;
    updatePlayerUI();
    return;
  }

  if (isPaused) {
    state.playback.isPlaying = true;
    state.playback.isPaused = false;
    if (state.playback.resumeFn) {
      // We were paused during the brief gap between sentences —
      // continue from exactly there, regardless of what
      // speechSynthesis.paused reports (it can be unreliable when
      // nothing was actually mid-utterance).
      const fn = state.playback.resumeFn;
      state.playback.resumeFn = null;
      fn();
    } else if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    } else {
      speakLine(state.playback.index); // safety net fallback
    }
    updatePlayerUI();
    return;
  }

  // start fresh (or continue after finishing)
  if (state.playback.index >= state.script.length) {
    state.playback.index = 0;
  }
  state.playback.isPlaying = true;
  speakLine(state.playback.index);
});

restartBtn.addEventListener("click", () => {
  resetPlayback();
});

// ==================== QUIZ LOGIC ====================

function resetQuizState() {
  stopAllQuizTimers();
  state.quiz = {
    questions: [],
    currentIndex: 0,
    score: 0,
    wrongQuestions: [],
    isPaused: false,
    answered: false,
    mode: null,
    selectedOption: null,
    userInput: '',
    timer: null,
    perQuestionRemaining: 0,
    perQuestionIntervalId: null,
    overallRemaining: 0,
    overallIntervalId: null,
  };
  quizTimerDisplay.hidden = true;
  quizTimerDisplay.classList.remove("urgent");
  quizScoreEl.textContent = '';
}

// --- Timer engine -----------------------------------------------------

function formatTimerText(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `⏱ ${m}:${String(s).padStart(2, "0")}`;
}

function stopPerQuestionTimer() {
  if (state.quiz.perQuestionIntervalId) {
    clearInterval(state.quiz.perQuestionIntervalId);
    state.quiz.perQuestionIntervalId = null;
  }
}

function stopOverallTimer() {
  if (state.quiz.overallIntervalId) {
    clearInterval(state.quiz.overallIntervalId);
    state.quiz.overallIntervalId = null;
  }
}

function stopAllQuizTimers() {
  stopPerQuestionTimer();
  stopOverallTimer();
}

// Starts (or restarts) the per-question countdown. Called at the end of
// renderQuizQuestion() whenever a per-question timer is configured.
function startPerQuestionTimer() {
  stopPerQuestionTimer();
  if (!state.quiz.timer || state.quiz.timer.type !== "perQuestion") {
    // Only force-hide when there's no timer at all. If an overall timer
    // is active, it manages the display independently — don't stomp on
    // it just because a new question rendered.
    if (!state.quiz.timer) quizTimerDisplay.hidden = true;
    return;
  }

  state.quiz.perQuestionRemaining = state.quiz.timer.seconds;
  quizTimerDisplay.hidden = false;
  quizTimerDisplay.classList.remove("urgent");
  quizTimerDisplay.textContent = formatTimerText(state.quiz.perQuestionRemaining);

  state.quiz.perQuestionIntervalId = setInterval(() => {
    if (state.quiz.isPaused) return;
    state.quiz.perQuestionRemaining--;
    quizTimerDisplay.textContent = formatTimerText(Math.max(0, state.quiz.perQuestionRemaining));
    quizTimerDisplay.classList.toggle("urgent", state.quiz.perQuestionRemaining <= 3);

    if (state.quiz.perQuestionRemaining <= 0) {
      stopPerQuestionTimer();
      handleTimeUp();
    }
  }, 1000);
}

// Starts the overall quiz countdown once, when the quiz begins. Runs
// independently of question navigation — question changes don't reset it.
function startOverallTimerIfNeeded() {
  stopOverallTimer();
  if (!state.quiz.timer || state.quiz.timer.type !== "overall") {
    quizTimerDisplay.hidden = true;
    return;
  }

  state.quiz.overallRemaining = state.quiz.timer.minutes * 60;
  quizTimerDisplay.hidden = false;
  quizTimerDisplay.classList.remove("urgent");
  quizTimerDisplay.textContent = formatTimerText(state.quiz.overallRemaining);

  state.quiz.overallIntervalId = setInterval(() => {
    if (state.quiz.isPaused) return;
    state.quiz.overallRemaining--;
    quizTimerDisplay.textContent = formatTimerText(Math.max(0, state.quiz.overallRemaining));
    quizTimerDisplay.classList.toggle("urgent", state.quiz.overallRemaining <= 30);

    if (state.quiz.overallRemaining <= 0) {
      stopOverallTimer();
      playAlarmBeep();
      showQuizSummary();
    }
  }, 1000);
}

// A short, free, no-assets-needed alarm sound using the Web Audio API —
// three quick beeps, like a kitchen timer going off.
function playAlarmBeep() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    [0, 0.22, 0.44].forEach((delay) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.2);
    });
  } catch {
    // If Web Audio isn't available for some reason, fail silently —
    // the visual timer display already communicated time's up.
  }
}

// Called when a per-question timer hits zero without an answer having
// been submitted. Treats the question as wrong, shows a "time's up"
// version of the feedback, then auto-advances after a short delay.
function handleTimeUp() {
  if (state.quiz.answered) return; // race: they submitted right as it hit 0
  const q = state.quiz.questions[state.quiz.currentIndex];
  state.quiz.answered = true;
  state.quiz.wrongQuestions.push(state.quiz.currentIndex);
  updateQuizScoreDisplay();

  quizFeedback.hidden = false;
  quizFeedback.className = 'quiz-feedback incorrect';
  let correctDisplay = '';
  if (q.type === 'multiple-choice') correctDisplay = q.options[q.correctIndex];
  else if (q.type === 'identification') correctDisplay = q.answer;
  else if (q.type === 'enumeration') correctDisplay = q.answer.join(', ');
  quizFeedback.innerHTML = `
    <strong>⏰ Time's up!</strong> The correct answer is: <strong>${correctDisplay}</strong><br>
    <span class="explanation">${q.explanation || ''}</span>
  `;
  quizSubmitBtn.hidden = true;
  quizNextBtn.hidden = true; // auto-advancing, no need for a manual click

  setTimeout(() => {
    state.quiz.currentIndex++;
    if (state.quiz.currentIndex >= state.quiz.questions.length) {
      showQuizSummary();
    } else {
      renderQuizQuestion();
    }
  }, 1800);
}

function updateQuizScoreDisplay() {
  const answeredSoFar = state.quiz.score + state.quiz.wrongQuestions.length;
  quizScoreEl.textContent = `Score: ${state.quiz.score}/${answeredSoFar}`;
}

// Render current quiz question
function renderQuizQuestion() {
  const { questions, currentIndex, mode } = state.quiz;
  if (currentIndex >= questions.length) {
    showQuizSummary();
    return;
  }

  const q = questions[currentIndex];
  quizProgress.textContent = `Question ${currentIndex + 1} of ${questions.length}`;
  quizQuestion.textContent = q.question;

  // Reset answer area and feedback
  quizAnswerArea.innerHTML = '';
  quizFeedback.hidden = true;
  quizSubmitBtn.hidden = false;
  quizNextBtn.hidden = true;
  quizPauseBtn.hidden = false;
  quizContinueBtn.hidden = true;
  state.quiz.answered = false;
  state.quiz.selectedOption = null;
  state.quiz.userInput = '';

  if (q.type === 'multiple-choice') {
    renderMCQ(q);
  } else if (q.type === 'identification') {
    renderIdentification(q);
  } else if (q.type === 'enumeration') {
    renderEnumeration(q);
  } else {
    // fallback
    renderIdentification(q);
  }

  updateQuizScoreDisplay();
  startPerQuestionTimer();
}

function renderMCQ(q) {
  const div = document.createElement('div');
  div.className = 'quiz-mcq-options';
  q.options.forEach((option, idx) => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.textContent = `${String.fromCharCode(65 + idx)}. ${option}`;
    btn.dataset.index = idx;
    btn.type = 'button';
    btn.addEventListener('click', () => {
      div.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.quiz.selectedOption = idx;
    });
    div.appendChild(btn);
  });
  quizAnswerArea.appendChild(div);
}

function renderIdentification(q) {
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Type your answer…';
  input.className = 'quiz-text-input';
  input.addEventListener('input', (e) => {
    state.quiz.userInput = e.target.value.trim();
  });
  quizAnswerArea.appendChild(input);
  requestAnimationFrame(() => input.focus());
}

function renderEnumeration(q) {
  const textarea = document.createElement('textarea');
  textarea.placeholder = 'List items, one per line or separated by commas…';
  textarea.className = 'quiz-text-input';
  textarea.rows = 4;
  textarea.addEventListener('input', (e) => {
    state.quiz.userInput = e.target.value;
  });
  quizAnswerArea.appendChild(textarea);
  requestAnimationFrame(() => textarea.focus());
}

// Submit answer
quizSubmitBtn.addEventListener('click', () => {
  const q = state.quiz.questions[state.quiz.currentIndex];
  if (state.quiz.answered) return;

  let userAnswer = null;
  if (q.type === 'multiple-choice') {
    userAnswer = state.quiz.selectedOption;
    if (userAnswer === null || userAnswer === undefined) {
      quizFeedback.textContent = 'Please select an option.';
      quizFeedback.className = 'quiz-feedback';
      quizFeedback.hidden = false;
      return;
    }
  } else {
    userAnswer = state.quiz.userInput || '';
    if (!userAnswer.trim()) {
      quizFeedback.textContent = 'Please enter an answer.';
      quizFeedback.className = 'quiz-feedback';
      quizFeedback.hidden = false;
      return;
    }
  }

  const isCorrect = checkAnswer(q, userAnswer);
  state.quiz.answered = true;
  stopPerQuestionTimer();
  if (isCorrect) {
    state.quiz.score++;
  } else {
    state.quiz.wrongQuestions.push(state.quiz.currentIndex);
  }
  updateQuizScoreDisplay();

  showFeedback(q, isCorrect, userAnswer);
  quizSubmitBtn.hidden = true;
  quizNextBtn.hidden = false;
});

function checkAnswer(q, userAnswer) {
  if (q.type === 'multiple-choice') {
    return userAnswer === q.correctIndex;
  } else if (q.type === 'identification') {
    return userAnswer.trim().toLowerCase() === q.answer.trim().toLowerCase();
  } else if (q.type === 'enumeration') {
    const userItems = userAnswer.split(/[,;\n]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    const expectedItems = q.answer.map(s => s.trim().toLowerCase());
    return expectedItems.every(item => userItems.includes(item));
  }
  return false;
}

function showFeedback(q, isCorrect, userAnswer) {
  quizFeedback.hidden = false;
  if (isCorrect) {
    quizFeedback.className = 'quiz-feedback correct';
    quizFeedback.innerHTML = `<strong>✅ Correct!</strong> ${q.explanation || ''}`;
  } else {
    quizFeedback.className = 'quiz-feedback incorrect';
    let correctDisplay = '';
    if (q.type === 'multiple-choice') {
      correctDisplay = q.options[q.correctIndex];
    } else if (q.type === 'identification') {
      correctDisplay = q.answer;
    } else if (q.type === 'enumeration') {
      correctDisplay = q.answer.join(', ');
    }
    quizFeedback.innerHTML = `
      <strong>❌ Incorrect.</strong> The correct answer is: <strong>${correctDisplay}</strong><br>
      <span class="explanation">${q.explanation || ''}</span>
    `;
  }
}

// Next question
quizNextBtn.addEventListener('click', () => {
  state.quiz.currentIndex++;
  if (state.quiz.currentIndex >= state.quiz.questions.length) {
    showQuizSummary();
  } else {
    renderQuizQuestion();
  }
});

// Pause / Continue
quizPauseBtn.addEventListener('click', () => {
  state.quiz.isPaused = true;
  quizPauseBtn.hidden = true;
  quizContinueBtn.hidden = false;
  if (state.quiz.answered) {
    quizFeedback.hidden = false;
  } else {
    quizFeedback.hidden = false;
    quizFeedback.className = 'quiz-feedback';
    quizFeedback.textContent = '⏸️ Quiz paused. Click Continue to resume.';
  }
});

quizContinueBtn.addEventListener('click', () => {
  state.quiz.isPaused = false;
  quizPauseBtn.hidden = false;
  quizContinueBtn.hidden = true;
  if (quizFeedback.textContent.includes('paused')) {
    quizFeedback.hidden = true;
  }
});

// Summary
function showQuizSummary() {
  stopAllQuizTimers();
  quizTimerDisplay.hidden = true;

  // Hide question elements
  quizProgress.hidden = true;
  quizScoreEl.hidden = true;
  quizQuestion.hidden = true;
  quizAnswerArea.hidden = true;
  quizFeedback.hidden = true;
  quizSubmitBtn.hidden = true;
  quizNextBtn.hidden = true;
  quizPauseBtn.hidden = true;
  quizContinueBtn.hidden = true;

  // currentIndex only advances once a question has been fully answered
  // (submitted or timed out), so everything before it — capped at the
  // batch size — is exactly what's actually been answered so far. This
  // matters because an overall timer can end the quiz mid-question,
  // before the in-progress question counts as answered.
  const answeredCount = Math.min(state.quiz.currentIndex, state.quiz.questions.length);
  const score = state.quiz.score;
  quizFinalScore.textContent = `Score: ${score}/${answeredCount}`;

  const wrongSet = new Set(state.quiz.wrongQuestions);
  const topicTally = {};
  for (let i = 0; i < answeredCount; i++) {
    const q = state.quiz.questions[i];
    if (!q) continue;
    const topic = q.topic || "General";
    if (!topicTally[topic]) topicTally[topic] = { correct: 0, wrong: 0 };
    if (wrongSet.has(i)) topicTally[topic].wrong++;
    else topicTally[topic].correct++;
  }

  const strongTopics = Object.entries(topicTally)
    .filter(([, t]) => t.wrong === 0)
    .map(([topic]) => topic);
  const weakTopics = Object.entries(topicTally)
    .filter(([, t]) => t.wrong > 0)
    .sort((a, b) => b[1].wrong - a[1].wrong);

  if (strongTopics.length) {
    quizStrongAreas.innerHTML = `<span class="quiz-areas-label">Strong on</span>${strongTopics.join(", ")}`;
    quizStrongAreas.hidden = false;
  } else {
    quizStrongAreas.hidden = true;
  }

  if (weakTopics.length) {
    const weakList = weakTopics.map(([topic, t]) => `${topic} (${t.wrong} wrong)`).join(", ");
    quizWeakAreas.innerHTML = `<span class="quiz-areas-label">Needs work</span>${weakList}`;
    quizWeakAreas.hidden = false;

    const topWeak = weakTopics.slice(0, 3).map(([topic]) => topic).join(", ");
    quizSuggestion.innerHTML = `Focus on: <strong>${topWeak}</strong> — that's where the wrong answers concentrated this round.`;
    quizSuggestion.hidden = false;
  } else {
    quizWeakAreas.hidden = true;
    quizSuggestion.innerHTML = `🎉 No weak areas this round — solid across everything covered.`;
    quizSuggestion.hidden = false;
  }

  quizSummary.hidden = false;
}

// Summary buttons
quizDrillBtn.addEventListener('click', () => {
  const wrongQ = state.quiz.wrongQuestions.map(idx => state.quiz.questions[idx]);
  if (wrongQ.length === 0) {
    // No wrong questions, restart all
    state.quiz.questions = [...state.quiz.questions];
  } else {
    state.quiz.questions = wrongQ;
  }
  state.quiz.currentIndex = 0;
  state.quiz.score = 0;
  state.quiz.wrongQuestions = [];
  state.quiz.answered = false;
  quizSummary.hidden = true;
  // Show question elements again
  quizProgress.hidden = false;
  quizScoreEl.hidden = false;
  quizQuestion.hidden = false;
  quizAnswerArea.hidden = false;
  // Restart the overall timer fresh for this drill session (per-question
  // timers restart naturally inside renderQuizQuestion -> startPerQuestionTimer)
  startOverallTimerIfNeeded();
  renderQuizQuestion();
});

quizSwitchModeBtn.addEventListener('click', () => {
  resetQuizState();
  showSection('mode');
  resetModePicker();
});

quizStopBtn.addEventListener('click', () => {
  goHome();
});

backToModesFromQuiz.addEventListener('click', () => {
  resetQuizState();
  showSection('mode');
  resetModePicker();
});