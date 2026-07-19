const { PDFParse } = require("pdf-parse");
const mammoth = require("mammoth");
const JSZip = require("jszip");
const { parseStringPromise } = require("xml2js");

// Pulls plain text out of a PowerPoint file by reading each slideN.xml
// inside the .pptx zip and collecting every <a:t> text run.
async function extractPptxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)[0], 10);
      const numB = parseInt(b.match(/\d+/)[0], 10);
      return numA - numB;
    });

  const slideTexts = [];
  for (const fileName of slideFiles) {
    const xml = await zip.files[fileName].async("string");
    const parsed = await parseStringPromise(xml);
    const texts = [];

    // Walk the parsed XML tree looking for any a:t nodes (text runs).
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (node["a:t"]) {
        for (const t of node["a:t"]) {
          if (typeof t === "string") texts.push(t);
        }
      }
      for (const key of Object.keys(node)) {
        const val = node[key];
        if (Array.isArray(val)) val.forEach(walk);
        else if (typeof val === "object") walk(val);
      }
    };
    walk(parsed);

    const slideNumber = parseInt(fileName.match(/\d+/)[0], 10);
    slideTexts.push({ slide: slideNumber, text: texts.join(" ").trim() });
  }

  return slideTexts;
}

// Detects file type from the filename extension and routes to the right
// parser. Returns { text, meta } where meta carries per-page/slide
// structure when available (useful later for citing "from slide 4").
async function extractText(buffer, filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();

  if (ext === "pdf") {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy();
    // pdf-parse inserts "-- N of M --" page-break markers; strip them so
    // the LLM sees clean prose instead of pagination noise.
    const cleaned = result.text.replace(/^--\s*\d+\s*of\s*\d+\s*--$/gm, "").trim();
    return {
      text: cleaned,
      meta: { type: "pdf", pages: result.pages ? result.pages.length : undefined },
    };
  }

  if (ext === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    return {
      text: result.value.trim(),
      meta: { type: "docx", warnings: result.messages.length },
    };
  }

  if (ext === "pptx") {
    const slides = await extractPptxText(buffer);
    const combined = slides
      .map((s) => `[Slide ${s.slide}]\n${s.text}`)
      .join("\n\n");
    return {
      text: combined.trim(),
      meta: { type: "pptx", slideCount: slides.length, slides },
    };
  }

  if (ext === "txt" || ext === "md") {
    return {
      text: buffer.toString("utf-8").trim(),
      meta: { type: ext },
    };
  }

  throw new Error(
    `Unsupported file type ".${ext}". Supported: pdf, docx, pptx, txt, md`
  );
}

module.exports = { extractText, extractPptxText };
