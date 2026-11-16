import { requestUrl } from "obsidian";
import { buildAuthHeaders, normalizeBaseUrl } from "./bridge-url";
import { dispatchSseBlock, splitSseBuffer, splitSseText, SseHandlers } from "./sse";
import { BridgeSession, ChatMessage, ClaudianMobileSettings } from "./types";

export class BridgeClient {
  constructor(private getSettings: () => ClaudianMobileSettings) {}

  private baseUrl(): string {
    return normalizeBaseUrl(this.getSettings().bridgeUrl);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return buildAuthHeaders(this.getSettings().authToken, extra);
  }

  private isTransientError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    if (/\b(400|401|403|404)\b/.test(msg)) return false;
    return true;
  }

  private async withRetry<T>(
    fn: () => Promise<T>,
    retries = 2,
    delayMs = 600
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt === retries || !this.isTransientError(err)) throw err;
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  async health(): Promise<{
    ok: boolean;
    vault: string;
    claude: boolean;
    stt: boolean;
    tts: boolean;
  }> {
    return this.withRetry(async () => {
      const res = await requestUrl({
        url: `${this.baseUrl()}/health`,
        method: "GET",
      });
      return res.json;
    });
  }

  async listModels(provider: string): Promise<Array<{ id: string; label: string }>> {
    return this.withRetry(async () => {
      const enc = encodeURIComponent(provider || "claude");
      const res = await requestUrl({
        url: `${this.baseUrl()}/models?provider=${enc}`,
        method: "GET",
        headers: this.headers(),
      });
      return res.json.models ?? [];
    });
  }

  async listSessions(): Promise<BridgeSession[]> {
    return this.withRetry(async () => {
      const res = await requestUrl({
        url: `${this.baseUrl()}/sessions`,
        method: "GET",
        headers: this.headers(),
      });
      return res.json.sessions ?? [];
    });
  }

  async getSessionMessages(sessionId: string): Promise<ChatMessage[]> {
    return this.withRetry(async () => {
      const res = await requestUrl({
        url: `${this.baseUrl()}/sessions/${encodeURIComponent(sessionId)}/messages`,
        method: "GET",
        headers: this.headers(),
      });
      return res.json.messages ?? [];
    });
  }

  async transcribeWav(wav: ArrayBuffer): Promise<string> {
    const s = this.getSettings();
    const lang = encodeURIComponent(s.sttLanguage || "en");
    return this.withRetry(async () => {
      const res = await requestUrl({
        url: `${this.baseUrl()}/stt?language=${lang}`,
        method: "POST",
        headers: this.headers({ "Content-Type": "audio/wav" }),
        body: wav,
      });
      if (!res.json.ok) {
        throw new Error(res.json.error || "STT failed");
      }
      return String(res.json.text || "").trim();
    });
  }

  async synthesizeTts(text: string): Promise<ArrayBuffer> {
    const s = this.getSettings();
    return this.withRetry(async () => {
      const res = await requestUrl({
        url: `${this.baseUrl()}/tts`,
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          text,
          voice: s.kokoroVoice || "af_heart",
          speed: s.speechRate || 1.05,
        }),
      });
      return res.arrayBuffer;
    });
  }

  private parseSseBlock(block: string, opts: SseHandlers): void {
    dispatchSseBlock(block, opts);
  }

  async streamChat(opts: {
    prompt: string;
    sessionId?: string | null;
    signal?: AbortSignal;
    onSession?: (sessionId: string) => void;
    onText?: (fullText: string, delta: string) => void;
    onPermissionRequest?: (req: { id: string; jobId: string; tool: string; summary: string; risk: string }) => void;
    onPermissionResolved?: (id: string) => void;
    onDone?: (sessionId: string | null, fullText: string) => void;
  }): Promise<void> {
    const s = this.getSettings();
    const payloadBody = JSON.stringify({
      prompt: opts.prompt,
      sessionId: opts.sessionId || undefined,
      provider: s.provider || "claude",
      model: s.model || undefined,
      systemPrompt:
        s.conciseMobilePrompt && s.mobileSystemPrompt?.trim()
          ? s.mobileSystemPrompt.trim()
          : undefined,
    });

    try {
      const idempotencyKey =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const createRes = await fetch(`${this.baseUrl()}/jobs`, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }),
        body: payloadBody,
        signal: opts.signal,
      });
      if (!createRes.ok) {
        throw new Error(`Bridge job error (${createRes.status})`);
      }
      const created = (await createRes.json()) as { job?: { id?: string } };
      const jobId = created.job?.id;
      if (!jobId) throw new Error("Missing job id from bridge");

      let lastEventId = 0;
      let doneReceived = false;
      const wrappedOpts = {
        ...opts,
        onEventId: (id: number) => {
          if (id > lastEventId) lastEventId = id;
        },
        onDone: (sid: string | null, text: string) => {
          doneReceived = true;
          opts.onDone?.(sid, text);
        },
      };

      for (let attempt = 0; attempt < 3 && !doneReceived; attempt++) {
        try {
          const evHeaders = lastEventId > 0 ? this.headers({ "Last-Event-ID": String(lastEventId) }) : this.headers();
          const resp = await fetch(`${this.baseUrl()}/jobs/${encodeURIComponent(jobId)}/events`, {
            method: "GET",
            headers: evHeaders,
            signal: opts.signal,
          });
          if (!resp.ok || !resp.body) throw new Error(`Job events error (${resp.status})`);
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const split = splitSseBuffer(buffer);
            buffer = split.rest;
            for (const block of split.blocks) this.parseSseBlock(block, wrappedOpts);
          }
          if (buffer.trim()) this.parseSseBlock(buffer, wrappedOpts);
        } catch (err) {
          if (opts.signal?.aborted || doneReceived || attempt === 2) throw err;
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      return;
    } catch (fetchErr) {
      throw fetchErr;
    }
  }

  async resolveApproval(approvalId: string, decision: "allow" | "deny"): Promise<void> {
    const res = await requestUrl({
      url: `${this.baseUrl()}/approvals/${encodeURIComponent(approvalId)}`,
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ decision }),
    });
    if (res.status >= 400) throw new Error(`Approval failed (${res.status})`);
  }
}
