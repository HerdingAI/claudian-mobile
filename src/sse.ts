// Pure SSE parsing for the bridge /chat stream. No Obsidian imports.

export interface SseHandlers {
  onSession?: (sessionId: string) => void;
  onText?: (fullText: string, delta: string) => void;
  onDone?: (sessionId: string | null, fullText: string) => void;
}

// Pull complete blocks out of a growing buffer.
// KNOWN BUG — flips in M5: only "\n\n" is recognized as a block separator, so
// "\r\n\r\n" streams never split until the stream ends.
export function splitSseBuffer(buffer: string): { blocks: string[]; rest: string } {
  const blocks: string[] = [];
  let rest = buffer;
  let sep: number;
  while ((sep = rest.indexOf("\n\n")) !== -1) {
    blocks.push(rest.slice(0, sep));
    rest = rest.slice(sep + 2);
  }
  return { blocks, rest };
}

// Non-streaming fallback: the whole response body split into blocks.
export function splitSseText(text: string): string[] {
  return text.split("\n\n");
}

export function parseSseBlock(block: string): { event: string; data: string } {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    // KNOWN BUG — flips in M5: multiple data: lines overwrite each other
    // (SSE spec says join them with "\n"); only the last one is kept.
    else if (line.startsWith("data:")) data = line.slice(5).trim();
  }
  return { event, data };
}

// Parses one block and calls the matching handler. Throws on an "error" event
// or on malformed JSON in data.
export function dispatchSseBlock(block: string, opts: SseHandlers): void {
  const { event, data } = parseSseBlock(block);
  if (!data) return; // comments/keepalives (": ping") have no data
  const payload = JSON.parse(data);
  if (event === "session" && payload.sessionId) {
    opts.onSession?.(payload.sessionId);
  } else if (event === "text") {
    opts.onText?.(payload.fullText || "", payload.delta || "");
  } else if (event === "done") {
    opts.onDone?.(payload.sessionId || null, payload.text || "");
  } else if (event === "error") {
    throw new Error(payload.error || "Chat error");
  }
  // Unknown events are ignored.
}
