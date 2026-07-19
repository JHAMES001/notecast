// Quiz mode is a static, pre-generated batch — unlike the audio modes,
// there's no back-and-forth with the model after generation. The
// frontend (script.js) checks answers locally, so these prompts must
// produce data shapes that match its render/check logic exactly:
//
//   multiple-choice: { type, question, options: string[4], correctIndex, explanation, topic }
//   identification:  { type, question, answer: string,     explanation, topic }
//   enumeration:      { type, question, answer: string[],   explanation, topic }
//
// identification/enumeration answers are matched with exact (trimmed,
// case-insensitive) string comparison client-side — so the model MUST
// keep those answers short and canonical, not full sentences, or almost
// every correct user answer will get marked wrong.

const VALID_QUIZ_MODES = ["multiple-choice", "identification", "enumeration", "mixed"];

const ANALYZE_SYSTEM_PROMPT = `You analyze study notes to determine which quiz question formats can be built from them.

- "multiple-choice" is viable almost always, for any notes with identifiable facts or concepts.
- "identification" (short-answer / fill-in-the-blank) is viable only if the notes contain specific facts, terms, or definitions with a clear, short, unambiguous correct answer (a word or short phrase) — not vague or open-ended content.
- "enumeration" (list multiple items) is viable only if the notes contain content naturally structured as a list — types of something, steps in a process, examples of a category, causes, effects, parts of a whole, etc. Do not force this if nothing in the notes is genuinely list-like.
- "mixed" is viable only if at least two of the above three are viable.

Return ONLY a JSON object of the form {"modes": [...]} using only values from "multiple-choice", "identification", "enumeration", "mixed" — no extra commentary, no markdown fences. Always include "multiple-choice" unless the notes are unusable for quizzing entirely (empty, gibberish, or far too short).`;

function buildGenerateSystemPrompt(quizMode, questionCount) {
  const shared = `You are generating a ${questionCount}-question quiz strictly from the notes provided below. Do not introduce any fact, term, or concept that isn't in the notes. Every question needs a "topic" field: a short label (2-4 words) naming the general concept it tests, used later to summarize the user's weak areas. Every question also needs an "explanation" field: a clear, correct explanation of the answer. If it's a math question, show the arithmetic the way a person would work it out on paper — common denominators, long division, cross-multiplication, borrowing, whatever applies. Don't skip steps.`;

  const mcqSpec = `Each multiple-choice question: {"type": "multiple-choice", "question": "...", "options": ["...","...","...","..."], "correctIndex": 0, "explanation": "...", "topic": "..."} — exactly 4 plausible options, only one correct, correctIndex is the 0-based index of the correct option.`;

  const idSpec = `Each identification question: {"type": "identification", "question": "...", "answer": "...", "explanation": "...", "topic": "..."} — CRITICAL: "answer" will be matched against the user's typed input with exact (case-insensitive) text comparison, so it MUST be a single word or very short phrase (2-4 words max) with only one natural correct phrasing. Never use a full sentence or an answer with multiple valid wordings.`;

  const enumSpec = `Each enumeration question: {"type": "enumeration", "question": "List the ... (ask them to name/list multiple specific items)", "answer": ["item1", "item2", "..."], "explanation": "...", "topic": "..."} — CRITICAL: each item in "answer" will be matched with exact (case-insensitive) text comparison against what the user types, so keep every item a single word or very short canonical phrase, not a full sentence.`;

  const jsonInstruction = `Return ONLY a JSON object of the form {"questions": [...]} with no extra commentary, no markdown fences.`;

  if (quizMode === "multiple-choice") {
    return `${shared} All ${questionCount} questions must be multiple-choice. ${mcqSpec} ${jsonInstruction}`;
  }
  if (quizMode === "identification") {
    return `${shared} All ${questionCount} questions must be identification (short-answer) questions. ${idSpec} ${jsonInstruction}`;
  }
  if (quizMode === "enumeration") {
    return `${shared} All ${questionCount} questions must be enumeration questions. ${enumSpec} ${jsonInstruction}`;
  }
  if (quizMode === "mixed") {
    return `${shared} Blend a roughly even mix of all three question types across the ${questionCount} questions: multiple-choice, identification, and enumeration. Only use a type if the notes genuinely support it well. ${mcqSpec} ${idSpec} ${enumSpec} ${jsonInstruction}`;
  }
  throw new Error(`Unknown quizMode "${quizMode}"`);
}

module.exports = { VALID_QUIZ_MODES, ANALYZE_SYSTEM_PROMPT, buildGenerateSystemPrompt };