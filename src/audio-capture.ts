import { ClaudianMobileSettings } from "./types";

function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === 16000) return input;
  const ratio = inputRate / 16000;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += input[j];
      count++;
    }
    out[i] = count > 0 ? sum / count : input[Math.min(start, input.length - 1)];
  }
  return out;
}

function encodeWav16kMono(samples: Float32Array): ArrayBuffer {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export class MobileAudioCapture {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;

  private mode: "idle" | "ptt" | "vad" = "idle";
  private pttChunks: Float32Array[] = [];

  private vadPaused = false;
  private bargeInMode = false;
  private vadInSpeech = false;
  private vadSpeechChunks: Float32Array[] = [];
  private vadPreRoll: Float32Array[] = [];
  private vadSpeechStartMs = 0;
  private vadLastVoiceMs = 0;
  private vadOnsetMs = 0;
  private onVadUtterance?: (wav: ArrayBuffer) => void;
  private onVadSpeechStart?: () => void;

  constructor(private getSettings: () => ClaudianMobileSettings) {}

  private hpPrevX = 0;
  private hpPrevY = 0;
  private lpPrevY = 0;
  private noiseFloorRms = 0.005;

  private analyzeSpeechBand(buf: Float32Array): { bandRms: number; isSpeechBand: boolean } {
    if (buf.length === 0) return { bandRms: 0, isSpeechBand: false };
    let bandSumSq = 0;
    let crossings = 0;
    let prevBand = 0;
    const hpAlpha = 0.92;
    const lpBeta = 0.58;

    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      const hp = hpAlpha * (this.hpPrevY + x - this.hpPrevX);
      this.hpPrevX = x;
      this.hpPrevY = hp;

      const lp = this.lpPrevY + lpBeta * (hp - this.lpPrevY);
      this.lpPrevY = lp;

      bandSumSq += lp * lp;
      if (i > 0 && ((lp >= 0 && prevBand < 0) || (lp < 0 && prevBand >= 0))) {
        crossings++;
      }
      prevBand = lp;
    }

    const bandRms = Math.sqrt(bandSumSq / buf.length);
    const zcr = crossings / buf.length;
    return { bandRms, isSpeechBand: zcr >= 0.02 && zcr <= 0.32 };
  }

  getAudioContext(): AudioContext | null {
    return this.ctx;
  }

  private async ensureGraph(): Promise<void> {
    if (this.stream && this.ctx && this.processor) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // On Android, echoCancellation: true forces MODE_IN_COMMUNICATION (quiet earpiece/call stream).
        // Only enable it when voiceBargeIn is on; otherwise keep normal loud media speaker routing.
        echoCancellation: this.getSettings().voiceBargeIn,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const ctx = new AudioContext();
    this.ctx = ctx;
    if (ctx.state === "suspended") await ctx.resume();
    this.source = ctx.createMediaStreamSource(this.stream);
    this.processor = ctx.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (ev) => {
      const down = downsampleTo16k(ev.inputBuffer.getChannelData(0), ctx.sampleRate);
      if (this.mode === "ptt") {
        this.pttChunks.push(down);
      } else if (this.mode === "vad" && !this.vadPaused) {
        this.processVadFrame(down);
      }
    };

    // Keep audio graph alive with zero gain (helps iOS WebView stay active)
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(silentGain);
    silentGain.connect(ctx.destination);
  }

  private processVadFrame(frame: Float32Array): void {
    const s = this.getSettings();
    const now = performance.now();
    const { bandRms, isSpeechBand } = this.analyzeSpeechBand(frame);
    // Use higher threshold, speech-band ZCR gate, & longer onset during TTS playback
    const threshold = this.bargeInMode
      ? Math.max(s.vadThreshold * 2.3, this.noiseFloorRms * 3.5, 0.025)
      : Math.max(s.vadThreshold, this.noiseFloorRms * 2.4);
    const onsetRequiredMs = this.bargeInMode ? 220 : 120;
    const isVoice = isSpeechBand && bandRms >= threshold;

    if (!this.vadInSpeech && !isVoice) {
      const rate = bandRms < this.noiseFloorRms ? 0.08 : 0.02;
      this.noiseFloorRms = Math.min(0.06, Math.max(0.002, this.noiseFloorRms * (1 - rate) + bandRms * rate));
    }

    if (!this.vadInSpeech) {
      this.vadPreRoll.push(frame);
      if (this.vadPreRoll.length > 4) this.vadPreRoll.shift();
      if (isVoice) {
        if (this.vadOnsetMs === 0) this.vadOnsetMs = now;
        else if (now - this.vadOnsetMs >= onsetRequiredMs) {
          this.vadInSpeech = true;
          this.vadSpeechStartMs = this.vadOnsetMs;
          this.vadLastVoiceMs = now;
          this.vadSpeechChunks = [...this.vadPreRoll];
          this.vadPreRoll = [];
          this.onVadSpeechStart?.();
        }
      } else {
        this.vadOnsetMs = 0;
      }
      return;
    }

    this.vadSpeechChunks.push(frame);
    if (isVoice) {
      this.vadLastVoiceMs = now;
    } else if (now - this.vadLastVoiceMs >= s.vadSilenceMs) {
      const durationMs = this.vadLastVoiceMs - this.vadSpeechStartMs;
      const chunks = this.vadSpeechChunks;
      this.vadInSpeech = false;
      this.vadSpeechChunks = [];
      this.vadOnsetMs = 0;
      if (durationMs >= s.minSpeechMs && chunks.length > 0) {
        this.onVadUtterance?.(encodeWav16kMono(concatFloat32(chunks)));
      }
    }
  }

  async startPushToTalk(): Promise<void> {
    this.pttChunks = [];
    this.mode = "ptt";
    await this.ensureGraph();
  }

  stopPushToTalk(): ArrayBuffer | null {
    if (this.mode !== "ptt") return null;
    this.mode = "idle";
    const chunks = this.pttChunks;
    this.pttChunks = [];
    this.teardown();
    if (!chunks.length) return null;
    const merged = concatFloat32(chunks);
    return merged.length >= 1600 ? encodeWav16kMono(merged) : null;
  }

  async startVad(opts: {
    onUtterance: (wav: ArrayBuffer) => void;
    onSpeechStart?: () => void;
  }): Promise<void> {
    this.vadOnsetMs = 0;
    this.vadInSpeech = false;
    this.vadSpeechChunks = [];
    this.vadPreRoll = [];
    this.vadPaused = false;
    this.bargeInMode = false;
    this.onVadUtterance = opts.onUtterance;
    this.onVadSpeechStart = opts.onSpeechStart;
    this.mode = "vad";
    await this.ensureGraph();
  }

  setBargeInMode(enabled: boolean): void {
    this.bargeInMode = enabled;
    if (enabled) {
      // Allow VAD to listen for user interruption while TTS is playing
      this.vadPaused = false;
      this.vadOnsetMs = 0;
    }
  }

  pauseVad(): void {
    this.vadPaused = true;
    this.vadInSpeech = false;
    this.vadSpeechChunks = [];
    this.vadPreRoll = [];
    this.vadOnsetMs = 0;
  }

  resumeVad(): void {
    this.vadPaused = false;
    this.bargeInMode = false;
    this.vadInSpeech = false;
    this.vadSpeechChunks = [];
    this.vadPreRoll = [];
    this.vadOnsetMs = 0;
  }

  stopVad(): void {
    this.mode = "idle";
    this.vadPaused = false;
    this.bargeInMode = false;
    this.onVadUtterance = undefined;
    this.onVadSpeechStart = undefined;
    this.teardown();
  }

  private teardown(): void {
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
    } catch {
      // ignore
    }
    this.processor = null;
    this.source = null;
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
  }

  dispose(): void {
    this.stopPushToTalk();
    this.stopVad();
  }
}
