const { getModeConfig } = require("../lib/modePrompts");

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

// Safety cap so one huge PDF doesn't blow the model's context window.
// v1 keeps this simple; chunking long documents into multiple script
// segments is a good next iteration once the single-pass version works.
const MAX_INPUT_CHARS = 24000;

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
    const { text, mode, voiceCount, depth, storyType } = req.body;

    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const modeConfig = getModeConfig({ mode, voiceCount, depth, storyType });
    const trimmedText =
      text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;

    const groqResponse = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.7,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              modeConfig.systemPrompt +
              ` Return ONLY a JSON object of the form {"script": [...]} with no extra commentary, no markdown fences.`,
          },
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

    const script = Array.isArray(parsed.script) ? parsed.script : parsed;

    // The model decides the real cast (e.g. drama mode may introduce
    // "man"/"woman" instead of a flat "narrator") — derive the actual
    // speaker list from what it produced, in order of first appearance,
    // rather than trusting the mode's static default list. Falls back
    // to the default if the script came back empty or malformed.
    const seen = new Set();
    const actualSpeakers = [];
    for (const line of script) {
      if (line && typeof line.speaker === "string" && !seen.has(line.speaker)) {
        seen.add(line.speaker);
        actualSpeakers.push(line.speaker);
      }
    }
    const speakers = actualSpeakers.length ? actualSpeakers : modeConfig.speakers;

    res.status(200).json({
      mode: modeConfig.key,
      speakers,
      voiceStyle: modeConfig.voiceStyle,
      script,
      truncated: text.length > MAX_INPUT_CHARS,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};