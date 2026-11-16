// Pure SSE parsing for the bridge /chat stream. No Obsidian imports.

export interface SseHandlers {
  onEventId?: (id: number) => void;
  onSession?: (sessionId: string) => void;
  onText?: (fullText: string, delta: string) => void;
  onPermissionRequest?: (req: { id: string; jobId: string; tool: string; summary: string; risk: string }) => void;
  onPermissionResolved?: (id: string) => void;
  onDone?: (sessionId: string | null, fullText: string) => void;
}

// Pull complete blocks out of a growing buffer (handles \n\n, \r\n\r\n, and \r\r).
export function splitSseBuffer(buffer: string): { blocks: string[]; rest: string } {
  const blocks: string[] = [];
  let rest = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let sep: number;
  while ((sep = rest.indexOf("\n\n")) !== -1) {
    blocks.push(rest.slice(0, sep));
    rest = rest.slice(sep + 2);
  }
  return { blocks, rest };
}

// Non-streaming fallback: the whole response body split into blocks.
export function splitSseText(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n\n");
}

export function parseSseBlock(block: string): { id?: number; event: string; data: string } {
  let id: number | undefined;
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("id:")) {
      const parsed = Number(line.slice(3).trim());
      if (Number.isFinite(parsed)) id = parsed;
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  return id !== undefined ? { id, event, data: dataLines.join("\n") } : { event, data: dataLines.join("\n") };
}

// Parses one block and calls the matching handler. Throws on an "error" event
// or on malformed JSON in data.
export function dispatchSseBlock(block: string, opts: SseHandlers): void {
  const { id, event, data } = parseSseBlock(block);
  if (id !== undefined) opts.onEventId?.(id);
  if (!data) return; // comments/keepalives (": ping") have no data
  const payload = JSON.parse(data);
  if (event === "session" && payload.sessionId) {
    opts.onSession?.(payload.sessionId);
  } else if (event === "text") {
    opts.onText?.(payload.fullText || "", payload.delta || "");
  } else if (event === "permission_request" && payload.id) {
    opts.onPermissionRequest?.(payload);
  } else if (event === "permission_resolved" && payload.id) {
    opts.onPermissionResolved?.(payload.id);
  } else if (event === "done") {
    opts.onDone?.(payload.sessionId || null, payload.text || "");
  } else if (event === "error") {
    throw new Error(payload.error || "Chat error");
  }
  // Unknown events are ignored.
}
