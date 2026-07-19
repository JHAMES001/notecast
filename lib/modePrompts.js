// Every leaf of the mode-picker tree resolves to one entry here.
// `speakers` is a DEFAULT/fallback list — the real speakers used are
// whatever the model actually outputs in the script (see generate-script.js,
// which derives the true speaker list from the returned script rather than
// trusting this list blindly). This matters for story modes especially:
// if the source material implies dialogue between distinct people, the
// model should tag them separately instead of flattening everyone into
// one "narrator" voice.
//
// `voiceStyle` gives each mode a distinct baseline rate/pitch so modes
// sound different even before any per-speaker voice is chosen.
//
// discussion.oneVoice.inDepth      discussion.oneVoice.general
// discussion.twoVoice.inDepth      discussion.twoVoice.general
// story.bedtime                    story.drama
// calm

const MODE_CONFIG = {
  "discussion.oneVoice.inDepth": {
    speakers: ["narrator"],
    voiceStyle: { rate: 1.0, pitch: 1.0 },
    systemPrompt: `You are turning source material into an audio script for a single expert narrator speaking in depth, like a professor giving a focused lecture. Do not skip nuance, define technical terms as you introduce them, and build ideas in a logical sequence. Write only what the narrator says, as natural spoken sentences, not bullet points. Output valid JSON: an array of objects shaped like {"speaker": "narrator", "text": "..."}. Split into multiple entries wherever a natural pause or topic shift occurs.`,
  },
  "discussion.oneVoice.general": {
    speakers: ["narrator"],
    voiceStyle: { rate: 1.03, pitch: 1.0 },
    systemPrompt: `You are turning source material into an audio script for a single narrator explaining it casually, like a knowledgeable friend giving a plain-language overview. Favor everyday words and relatable comparisons over jargon. Keep it engaging but not exhaustive. Output valid JSON: an array of objects shaped like {"speaker": "narrator", "text": "..."}. Split into multiple entries at natural pauses.`,
  },
  "discussion.twoVoice.inDepth": {
    speakers: ["professor", "student"],
    voiceStyle: { rate: 1.0, pitch: 1.0 },
    systemPrompt: `You are turning source material into a two-voice audio script: a professor and an inquisitive student having a rigorous, technical discussion. The professor explains concepts in depth and precisely; the student asks sharp clarifying questions that surface nuance a passive summary would miss. Do not simplify away important detail. Output valid JSON: an array of objects shaped like {"speaker": "professor" | "student", "text": "..."}, alternating naturally as a real conversation would.`,
  },
  "discussion.twoVoice.general": {
    speakers: ["host1", "host2"],
    voiceStyle: { rate: 1.05, pitch: 1.0 },
    systemPrompt: `You are turning source material into a two-voice audio script: two friendly co-hosts casually discussing the material, like a podcast. Keep the tone light, use plain language, react to each other's points, and connect ideas to everyday intuition rather than technical precision. Output valid JSON: an array of objects shaped like {"speaker": "host1" | "host2", "text": "..."}, alternating naturally.`,
  },
  "story.bedtime": {
    speakers: ["narrator"],
    voiceStyle: { rate: 0.85, pitch: 0.95 },
    systemPrompt: `You are retelling source material as an actual bedtime story, not a softened summary. This means real narrative shape: open with a gentle scene-setting line ("Once, in fields all across the world..."), give the ideas a small cast of recurring characters to follow (a tired farmer, a curious child, a gentle river) rather than listing facts and definitions in sequence, and let one idea drift softly into the next the way a story does, not the way a lecture does. If the story naturally includes a character speaking (dialogue), give that character their own "speaker" tag (e.g. "man", "woman", "child", or a name) instead of folding their words into "narrator" — real dialogue deserves its own voice. Sentences should be short and slow, many under 12 words, with gentle repetition of calming phrases. Do not use section-like structure, headings, or "now let's look at" transitions - those are lecture patterns, not story patterns. Every fact from the source must still be accurate, just carried inside the story rather than stated as a fact. End on a soft, settling note, as if easing the listener toward sleep. Output valid JSON: an array of objects shaped like {"speaker": "narrator" | "<character>", "text": "..."}, split into short, slow-paced entries.`,
  },
  "story.drama": {
    speakers: ["narrator"],
    voiceStyle: { rate: 1.02, pitch: 1.0 },
    systemPrompt: `You are retelling source material as a heightened radio drama, not a summary with exclamation points. This means real dramatic structure: open in the middle of a stake ("Right now, somewhere, a farmer is watching the sky and praying for rain..."), frame the ideas as a conflict with something to win or lose (survival vs. hunger, fertile soil vs. erosion, abundance vs. collapse), and build toward a turn or reveal rather than listing facts in sequence. If the drama naturally includes distinct characters speaking to each other (e.g. a farmer and his wife, a scientist and a skeptic), give EACH character their own "speaker" tag (e.g. "man", "woman", or a name) instead of folding their dialogue into "narrator" — a radio drama needs distinct voices for distinct people, not one narrator reading everyone's lines. Use short, punchy sentences for tension and occasional longer ones for weight. Include at least one pause beat written as its own short entry (e.g. "...and then, the rains stopped."). Do not use lecture transitions like "now let's examine" - use scene and stakes instead. Every fact from the source must still be accurate, just carried inside the drama rather than stated plainly. Output valid JSON: an array of objects shaped like {"speaker": "narrator" | "<character>", "text": "..."}, split at dramatic beats.`,
  },
  calm: {
    speakers: ["narrator"],
    voiceStyle: { rate: 0.92, pitch: 1.0 },
    systemPrompt: `You are one warm, calm voice explaining source material directly to a single listener, like a patient one-on-one conversation. No performance, no dramatization, just clear, unhurried, human explanation. Output valid JSON: an array of objects shaped like {"speaker": "narrator", "text": "..."}, split into short, natural conversational entries.`,
  },
};

// Builds the mode key from the choices the frontend sends, e.g.
// mode="discussion", voiceCount="twoVoice", depth="inDepth"
// mode="story", storyType="bedtime"
// mode="calm"
function resolveModeKey({ mode, voiceCount, depth, storyType }) {
  if (mode === "discussion") {
    if (!voiceCount || !depth) {
      throw new Error(
        "Discussion mode requires voiceCount (oneVoice|twoVoice) and depth (inDepth|general)"
      );
    }
    return `discussion.${voiceCount}.${depth}`;
  }
  if (mode === "story") {
    if (!storyType) {
      throw new Error("Story mode requires storyType (bedtime|drama)");
    }
    return `story.${storyType}`;
  }
  if (mode === "calm") {
    return "calm";
  }
  throw new Error(`Unknown mode "${mode}"`);
}

function getModeConfig(selection) {
  const key = resolveModeKey(selection);
  const config = MODE_CONFIG[key];
  if (!config) throw new Error(`No config found for resolved mode key "${key}"`);
  return { key, ...config };
}

module.exports = { getModeConfig, resolveModeKey, MODE_CONFIG };