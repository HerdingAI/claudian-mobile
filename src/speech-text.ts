// Pure text helpers for TTS. No Obsidian imports so tests can load this directly.

export function stripMarkdownForSpeech(text: string): string {
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

export function extractCompletedSentences(
  text: string,
  cursor: number
): { sentences: string[]; nextCursor: number } {
  const slice = text.slice(cursor);
  if (!slice) return { sentences: [], nextCursor: cursor };

  const sentences: string[] = [];
  const re = /[^.!?\n]+(?:[.!?]+(?=\s|$)|\n+|$)/g;
  let match: RegExpExecArray | null;
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
