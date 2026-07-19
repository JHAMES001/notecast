const { VALID_QUIZ_MODES, ANALYZE_SYSTEM_PROMPT } = require("../lib/quizModePrompts");

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";
const MAX_INPUT_CHARS = 24000; // matches generate-script.js's cap

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
    const { text } = req.body;
    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const trimmedText = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;

    const groqResponse = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3, // low temp — this is a classification task, not creative writing
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: ANALYZE_SYSTEM_PROMPT },
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

    // Defensive filtering: only pass through modes the frontend actually
    // knows how to render, even if the model hallucinates something else.
    const rawModes = Array.isArray(parsed.modes) ? parsed.modes : [];
    const modes = rawModes.filter((m) => VALID_QUIZ_MODES.includes(m));

    // Multiple-choice should basically always be offered if there's any
    // usable content at all — don't let a model slip-up leave the user
    // with zero options.
    if (!modes.includes("multiple-choice") && trimmedText.trim().length > 0) {
      modes.unshift("multiple-choice");
    }

    res.status(200).json({ modes });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};