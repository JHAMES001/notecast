const { VALID_QUIZ_MODES, buildGenerateSystemPrompt } = require("../lib/quizModePrompts");

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";
const MAX_INPUT_CHARS = 24000;
const VALID_QUESTION_COUNTS = [10, 15, 30];
const DEFAULT_QUESTION_COUNT = 10;

// Light validation that each question has the shape script.js's
// render/check functions actually rely on — a malformed question here
// would silently break rendering or answer-checking client-side, so
// it's worth catching before it ever reaches the browser.
function isValidQuestion(q) {
  if (!q || typeof q !== "object") return false;
  if (typeof q.question !== "string" || !q.question.trim()) return false;

  if (q.type === "multiple-choice") {
    return (
      Array.isArray(q.options) &&
      q.options.length === 4 &&
      q.options.every((o) => typeof o === "string") &&
      Number.isInteger(q.correctIndex) &&
      q.correctIndex >= 0 &&
      q.correctIndex <= 3
    );
  }
  if (q.type === "identification") {
    return typeof q.answer === "string" && q.answer.trim().length > 0;
  }
  if (q.type === "enumeration") {
    return (
      Array.isArray(q.answer) &&
      q.answer.length > 0 &&
      q.answer.every((a) => typeof a === "string" && a.trim().length > 0)
    );
  }
  return false;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server misconfigured: GROQ_API_KEY not set" });
    return;
  }

  try {
    const { text, quizMode, questionCount } = req.body;

    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    if (!VALID_QUIZ_MODES.includes(quizMode)) {
      res.status(400).json({
        error: `Invalid quizMode "${quizMode}". Must be one of: ${VALID_QUIZ_MODES.join(", ")}`,
      });
      return;
    }

    const resolvedCount = VALID_QUESTION_COUNTS.includes(Number(questionCount))
      ? Number(questionCount)
      : DEFAULT_QUESTION_COUNT;

    const trimmedText = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
    const systemPrompt = buildGenerateSystemPrompt(quizMode, resolvedCount);

    const groqResponse = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.6,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: trimmedText },
        ],
      }),
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      res.status(502).json({ error: "Groq API error", detail: errText });
      return;
    }

    const groqData = await groqResponse.json();
    const raw = groqData.choices?.[0]?.message?.content || "{}";

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      res.status(502).json({ error: "Model returned invalid JSON", raw });
      return;
    }

    const rawQuestions = Array.isArray(parsed.questions) ? parsed.questions : [];
    const questions = rawQuestions.filter(isValidQuestion);

    if (!questions.length) {
      res.status(502).json({
        error: "The model didn't return any usable questions. Try again, or pick a different quiz mode.",
      });
      return;
    }

    res.status(200).json({ questions, requested: resolvedCount, received: questions.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};