const { extractText } = require("../lib/extractText");

// Expects JSON body: { filename: "notes.pdf", fileData: "<base64>" }
// Both the desktop web app and the mobile app read the file into base64
// client-side (FileReader on web, expo-file-system on mobile) so this
// function never has to deal with multipart form parsing.
// Vercel automatically parses a JSON request body into req.body.
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { filename, fileData } = req.body;
    if (!filename || !fileData) {
      res.status(400).json({ error: "filename and fileData are required" });
      return;
    }

    const buffer = Buffer.from(fileData, "base64");
    // Vercel serverless functions have a hard, non-configurable 4.5MB
    // request-body limit. Files arrive here as base64 (already ~33%
    // larger than raw), so if we're even executing this code the request
    // got through — but we still enforce a matching raw-file cap as a
    // defense-in-depth check against the client-side one being bypassed.
    const MAX_BYTES = 3 * 1024 * 1024;
    if (buffer.length > MAX_BYTES) {
      res.status(413).json({ error: "File too large (3MB max — Vercel's platform limit)" });
      return;
    }

    const { text, meta } = await extractText(buffer, filename);

    if (!text) {
      res.status(422).json({
        error: "No extractable text found. The file may be scanned images rather than real text.",
      });
      return;
    }

    res.status(200).json({ text, meta });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};