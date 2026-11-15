import test from "node:test";
import assert from "node:assert/strict";

function extractCompletedSentences(text, cursor) {
  const slice = text.slice(cursor);
  if (!slice) return { sentences: [], nextCursor: cursor };

  const sentences = [];
  const re = /[^.!?\n]+(?:[.!?]+(?=\s|$)|\n+|$)/g;
  let match;
  let consumed = 0;

  while ((match = re.exec(slice)) !== null) {
    const chunk = match[0];
    const endsWithBoundary = /(?:[.!?]|\n)$/.test(chunk.replace(/[ \t]+$/, ""));
    const isAtEnd = match.index + chunk.length === slice.length;
    if (endsWithBoundary && !isAtEnd) {
      const cleaned = chunk.trim();
      if (cleaned) sentences.push(cleaned);
      consumed = match.index + chunk.length;
    } else if (!isAtEnd) {
      consumed = match.index + chunk.length;
    } else {
      break;
    }
  }
  return { sentences, nextCursor: cursor + consumed };
}

test("extractCompletedSentences splits streaming text cleanly", () => {
  const a = extractCompletedSentences("First sentence. Second", 0);
  assert.deepEqual(a.sentences, ["First sentence."]);
  const b = extractCompletedSentences("First sentence. Second one! Third?", a.nextCursor);
  assert.deepEqual(b.sentences, ["Second one!"]);
  const c = extractCompletedSentences("Line one\nLine two\nLine three", 0);
  assert.deepEqual(c.sentences, ["Line one", "Line two"]);
});

function stripMarkdownForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, " (code block omitted) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, "")
    .replace(/(\*\*\*|___)(.+?)\1/g, "$2")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

test("stripMarkdownForSpeech removes markdown notation cleanly", () => {
  const raw = "## Heading\n- Here is **the word** and *italic* with `code` and [a link](https://example.com).";
  assert.equal(
    stripMarkdownForSpeech(raw),
    "Heading Here is the word and italic with code and a link."
  );
});
