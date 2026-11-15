export type VoiceState =
  | "idle"
  | "listening"
  | "recording"
  | "transcribing"
  | "thinking"
  | "speaking";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface BridgeSession {
  id: string;
  title: string;
  sessionId: string | null;
  selectedModel: string;
  lastActivityAt: number;
}

export interface ClaudianMobileSettings {
  bridgeUrl: string;
  authToken: string;
  provider: "claude" | "agy" | "opencode";
  model: string;
  sttLanguage: string;
  ttsEngine: "bridge-kokoro" | "webspeech";
  kokoroVoice: string;
  speechRate: number;
  autoSpeakReplies: boolean;
  vadThreshold: number;
  vadSilenceMs: number;
  minSpeechMs: number;
  lastSessionId: string;
  conciseMobilePrompt: boolean;
  mobileSystemPrompt: string;
  voiceBargeIn: boolean;
}

export const DEFAULT_MOBILE_SETTINGS: ClaudianMobileSettings = {
  bridgeUrl: "http://127.0.0.1:8790",
  authToken: "",
  provider: "claude",
  model: "haiku",
  sttLanguage: "en",
  ttsEngine: "bridge-kokoro",
  kokoroVoice: "af_heart",
  speechRate: 1.05,
  autoSpeakReplies: true,
  vadThreshold: 0.015,
  vadSilenceMs: 1800,
  minSpeechMs: 350,
  lastSessionId: "",
  conciseMobilePrompt: true,
  mobileSystemPrompt:
    "You are responding in Claudian Mobile. Keep replies concise, direct, and conversational for a phone screen or spoken audio. Avoid tables and heavy formatting unless explicitly asked.",
  voiceBargeIn: true,
};

export const KOKORO_VOICES = [
  { id: "af_heart", label: "Heart (US Female, Warm)" },
  { id: "af_bella", label: "Bella (US Female, Clear)" },
  { id: "af_nicole", label: "Nicole (US Female, Soft)" },
  { id: "af_sarah", label: "Sarah (US Female, Crisp)" },
  { id: "am_adam", label: "Adam (US Male, Deep)" },
  { id: "am_michael", label: "Michael (US Male, Natural)" },
  { id: "bf_emma", label: "Emma (UK Female)" },
  { id: "bm_george", label: "George (UK Male)" },
];
