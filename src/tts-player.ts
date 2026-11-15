import { BridgeClient } from "./bridge-client";
import { ClaudianMobileSettings } from "./types";

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

export class MobileTtsPlayer {
  private queue: string[] = [];
  private isPlaying = false;
  private generation = 0;
  private activeAudio: HTMLAudioElement | null = null;
  private activeSource: AudioBufferSourceNode | null = null;
  private activeAbort: AbortController | null = null;

  onSpeakingChange?: (speaking: boolean) => void;
  onInterruptRequested?: () => void;

  constructor(
    private bridge: BridgeClient,
    private getSettings: () => ClaudianMobileSettings,
    private getAudioContext?: () => AudioContext | null
  ) {
    this.setupMediaSession();
  }

  private setupMediaSession(): void {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "Claudian Voice",
        artist: "Claudian Mobile",
      });
      navigator.mediaSession.setActionHandler("pause", () => {
        this.onInterruptRequested?.();
      });
      navigator.mediaSession.setActionHandler("stop", () => {
        this.onInterruptRequested?.();
      });
    } catch {
      // ignore if unsupported
    }
  }

  get speaking(): boolean {
    return this.isPlaying || this.queue.length > 0;
  }

  enqueue(text: string): void {
    const cleaned = stripMarkdownForSpeech(text);
    if (!cleaned) return;
    this.queue.push(cleaned);
    if (!this.isPlaying) {
      void this.drain();
    }
  }

  private async playWav(buffer: ArrayBuffer, signal: AbortSignal): Promise<void> {
    // Only use shared AudioContext when voiceBargeIn is enabled; HTMLAudioElement
    // uses full-volume loudspeaker routing on iOS when mic is released.
    const ctx = this.getSettings().voiceBargeIn ? this.getAudioContext?.() : null;
    if (ctx) {
      try {
        if (ctx.state === "suspended") await ctx.resume();
        const audioBuf = await ctx.decodeAudioData(buffer.slice(0));
        return await new Promise<void>((resolve, reject) => {
          if (signal.aborted) return reject(new Error("Aborted"));
          const src = ctx.createBufferSource();
          src.buffer = audioBuf;
          src.connect(ctx.destination);
          this.activeSource = src;
          let settled = false;

          const cleanup = () => {
            if (this.activeSource === src) this.activeSource = null;
            signal.removeEventListener("abort", onAbort);
          };
          const onAbort = () => {
            if (settled) return;
            settled = true;
            try {
              src.stop();
            } catch {
              // ignore
            }
            cleanup();
            reject(new Error("Aborted"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          src.onended = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
          };
          src.start(0);
        });
      } catch (err) {
        if (signal.aborted) throw err;
        // Fall through to HTMLAudioElement
      }
    }

    return new Promise((resolve, reject) => {
      const blob = new Blob([buffer], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.activeAudio = audio;
      let settled = false;

      const cleanup = () => {
        if (this.activeAudio === audio) this.activeAudio = null;
        URL.revokeObjectURL(url);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        audio.pause();
        audio.src = "";
        cleanup();
        reject(new Error("Aborted"));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      audio.onended = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      audio.onerror = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("Audio playback failed"));
      };
      audio.play().catch((err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private speakWebSpeech(text: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        reject(new Error("Web Speech unavailable"));
        return;
      }
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = this.getSettings().speechRate || 1.05;
      const onAbort = () => {
        window.speechSynthesis.cancel();
        reject(new Error("Aborted"));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      utter.onend = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      utter.onerror = () => {
        signal.removeEventListener("abort", onAbort);
        reject(new Error("Web Speech error"));
      };
      window.speechSynthesis.speak(utter);
    });
  }

  private async drain(): Promise<void> {
    if (this.isPlaying) return;
    this.isPlaying = true;
    const myGen = this.generation;
    this.onSpeakingChange?.(true);

    try {
      let prefetched: Promise<ArrayBuffer> | null = null;
      while (this.queue.length > 0 && this.generation === myGen) {
        const text = this.queue.shift()!;
        const s = this.getSettings();
        const ctrl = new AbortController();
        this.activeAbort = ctrl;

        try {
          if (s.ttsEngine === "bridge-kokoro") {
            const bufPromise = prefetched ?? this.bridge.synthesizeTts(text);
            prefetched = null;
            if (this.queue.length > 0) {
              prefetched = this.bridge.synthesizeTts(this.queue[0]);
            }
            const buf = await bufPromise;
            if (this.generation !== myGen || ctrl.signal.aborted) break;
            await this.playWav(buf, ctrl.signal);
          } else {
            await this.speakWebSpeech(text, ctrl.signal);
          }
        } catch (err) {
          if (ctrl.signal.aborted || this.generation !== myGen) break;
          if (s.ttsEngine === "bridge-kokoro") {
            try {
              await this.speakWebSpeech(text, ctrl.signal);
            } catch {
              // ignore
            }
          }
        } finally {
          if (this.activeAbort === ctrl) this.activeAbort = null;
        }
      }
    } finally {
      this.isPlaying = false;
      this.onSpeakingChange?.(false);
    }
  }

  stop(): void {
    this.generation++;
    this.queue = [];
    this.activeAbort?.abort();
    this.activeAbort = null;
    if (this.activeSource) {
      try {
        this.activeSource.stop();
      } catch {
        // ignore
      }
      this.activeSource = null;
    }
    if (this.activeAudio) {
      this.activeAudio.pause();
      this.activeAudio.src = "";
      this.activeAudio = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    this.isPlaying = false;
    this.onSpeakingChange?.(false);
  }
}
