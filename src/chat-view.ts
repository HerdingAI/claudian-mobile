import {
  ItemView,
  MarkdownRenderer,
  Menu,
  Notice,
  Platform,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import { MobileAudioCapture } from "./audio-capture";
import { BridgeClient } from "./bridge-client";
import type ClaudianMobilePlugin from "./main";
import { extractCompletedSentences, MobileTtsPlayer } from "./tts-player";
import { BridgeSession, ChatMessage, VoiceState } from "./types";

export const VIEW_TYPE_CLAUDIAN_MOBILE = "claudian-mobile-view";

export class ClaudianMobileView extends ItemView {
  private bridge: BridgeClient;
  private capture: MobileAudioCapture;
  private tts: MobileTtsPlayer;

  private sessions: BridgeSession[] = [];
  private activeSessionId: string | null = null;
  private messages: ChatMessage[] = [];
  private state: VoiceState = "idle";
  private handsFree = false;
  private chatDone = true;
  private chatAbort: AbortController | null = null;
  private wakeLock: { release: () => Promise<void> } | null = null;
  private rearmTimer: number | null = null;
  private isFullScreen = Platform.isMobile;
  private bridgeOffline = false;

  private rootEl!: HTMLElement;
  private sessionBtnEl!: HTMLButtonElement;
  private sessionLabelEl!: HTMLSpanElement;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private micBtn!: HTMLButtonElement;
  private handsFreeBtn!: HTMLButtonElement;
  private handsFreeLabelEl!: HTMLSpanElement;
  private speakerModeBtn!: HTMLButtonElement;
  private sendBtn!: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf, private plugin: ClaudianMobilePlugin) {
    super(leaf);
    this.bridge = new BridgeClient(() => this.plugin.settings);
    this.capture = new MobileAudioCapture(() => this.plugin.settings);
    this.tts = new MobileTtsPlayer(
      this.bridge,
      () => this.plugin.settings,
      () => this.capture.getAudioContext()
    );

    this.tts.onSpeakingChange = (speaking) => {
      if (speaking) {
        if (this.handsFree && this.plugin.settings.voiceBargeIn) {
          this.capture.setBargeInMode(true);
        }
        this.setVoiceState("speaking");
      } else {
        this.maybeResumeAfterTurn();
      }
    };

    this.tts.onInterruptRequested = () => {
      this.interruptAndListen();
    };
  }

  getViewType(): string {
    return VIEW_TYPE_CLAUDIAN_MOBILE;
  }

  getDisplayText(): string {
    return "Claudian Mobile";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("claudian-mobile-root");
    this.rootEl = root;
    this.applyFullScreenClass();
    this.attachSwipeBack(root);

    // Compact Header: Back/Swipe-cue, Readable Session Picker, New, Sync
    const header = root.createDiv({ cls: "claudian-mobile-header" });

    const backBtn = header.createEl("button", {
      cls: "claudian-mobile-icon-btn",
      attr: { "aria-label": "Back to note", title: "Back to note (or swipe right)", type: "button" },
    });
    setIcon(backBtn, Platform.isMobile ? "chevron-left" : "maximize-2");
    backBtn.addEventListener("click", () => {
      if (Platform.isMobile) {
        this.goBackToNote();
      } else {
        this.isFullScreen = !this.isFullScreen;
        this.applyFullScreenClass();
      }
    });

    this.sessionBtnEl = header.createEl("button", {
      cls: "claudian-mobile-session-btn",
      attr: { type: "button" },
    });
    this.sessionLabelEl = this.sessionBtnEl.createSpan({
      cls: "claudian-mobile-session-label",
      text: "New conversation",
    });
    const chev = this.sessionBtnEl.createSpan({ cls: "claudian-mobile-session-chev" });
    setIcon(chev, "chevron-down");
    this.sessionBtnEl.addEventListener("click", (e) => this.openSessionMenu(e));

    const newBtn = header.createEl("button", {
      cls: "claudian-mobile-icon-btn",
      attr: { "aria-label": "New chat", title: "New chat", type: "button" },
    });
    setIcon(newBtn, "plus");
    newBtn.addEventListener("click", () => {
      this.activeSessionId = null;
      this.messages = [];
      this.plugin.settings.lastSessionId = "";
      void this.plugin.saveSettings();
      this.updateSessionLabel();
      this.renderMessages();
    });

    const refreshBtn = header.createEl("button", {
      cls: "claudian-mobile-icon-btn",
      attr: { "aria-label": "Sync sessions", title: "Sync sessions", type: "button" },
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => void this.loadSessions());

    // Messages
    this.messagesEl = root.createDiv({ cls: "claudian-mobile-messages" });

    // Compact Claude-style Rounded Composer Pill
    const composer = root.createDiv({ cls: "claudian-mobile-composer" });
    this.inputEl = composer.createEl("textarea", {
      cls: "claudian-mobile-input",
      attr: { placeholder: "Message Claudian...", rows: "1" },
    });
    this.inputEl.addEventListener("input", () => {
      this.inputEl.style.height = "auto";
      this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 108)}px`;
      this.updateSendButton();
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.sendFromInput();
      }
    });

    const toolbar = composer.createDiv({ cls: "claudian-mobile-toolbar" });
    const leftBtns = toolbar.createDiv({ cls: "claudian-mobile-toolbar-left" });

    this.micBtn = leftBtns.createEl("button", {
      cls: "claudian-mobile-pill-btn",
      attr: { "aria-label": "Push-to-Talk", title: "Push-to-Talk", type: "button" },
    });
    setIcon(this.micBtn, "mic");
    this.micBtn.addEventListener("click", () => void this.togglePushToTalk());

    this.handsFreeBtn = leftBtns.createEl("button", {
      cls: "claudian-mobile-pill-btn claudian-mobile-voice-mode-btn",
      attr: { "aria-label": "Voice Mode", title: "Hands-Free Voice Mode", type: "button" },
    });
    setIcon(this.handsFreeBtn, "audio-lines");
    this.handsFreeLabelEl = this.handsFreeBtn.createSpan({
      text: "Voice",
      cls: "claudian-mobile-btn-label",
    });
    this.handsFreeBtn.addEventListener("click", () => void this.toggleHandsFree());

    this.speakerModeBtn = leftBtns.createEl("button", {
      cls: "claudian-mobile-pill-btn claudian-mobile-speaker-btn",
      attr: {
        "aria-label": "Loud Speaker Mode",
        title: "Toggle Loud Speaker Mode (no self-echo; tap to interrupt)",
        type: "button",
      },
    });
    setIcon(this.speakerModeBtn, "volume-2");
    this.speakerModeBtn.toggleClass("is-active", !this.plugin.settings.voiceBargeIn);
    this.speakerModeBtn.addEventListener("click", () => void this.toggleSpeakerMode());

    this.sendBtn = toolbar.createEl("button", {
      cls: "claudian-mobile-send-circle",
      attr: { "aria-label": "Send", type: "button" },
    });
    setIcon(this.sendBtn, "arrow-up");
    this.sendBtn.addEventListener("click", () => {
      if (this.tts.speaking || !this.chatDone) {
        this.interruptAndListen();
      } else {
        void this.sendFromInput();
      }
    });

    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") {
        if (this.bridgeOffline || this.sessions.length === 0) {
          void this.loadSessions();
        } else {
          void this.refreshSessionListOnly();
        }
      }
    });

    this.registerDomEvent(window, "online", () => {
      if (this.bridgeOffline || this.sessions.length === 0) {
        void this.loadSessions();
      } else {
        void this.refreshSessionListOnly();
      }
    });

    await this.loadSessions();
  }

  private applyFullScreenClass(): void {
    if (!this.rootEl) return;
    this.rootEl.toggleClass("is-fullscreen", this.isFullScreen);
  }

  private attachSwipeBack(el: HTMLElement): void {
    let startX = 0;
    let startY = 0;
    let tracking = false;

    el.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        // Edge swipe from left 44px, or general right swipe
        startX = t.clientX;
        startY = t.clientY;
        tracking = startX <= 44;
      },
      { passive: true }
    );

    el.addEventListener(
      "touchmove",
      (e) => {
        if (!tracking || e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        if (dx > 12 && dx > Math.abs(dy) * 1.4) {
          el.style.transform = `translateX(${Math.min(dx * 0.45, 140)}px)`;
        }
      },
      { passive: true }
    );

    el.addEventListener(
      "touchend",
      (e) => {
        if (!tracking) return;
        tracking = false;
        el.style.transform = "";
        const t = e.changedTouches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (dx > 75 && dx > Math.abs(dy) * 1.5) {
          this.goBackToNote();
        }
      },
      { passive: true }
    );
  }

  private goBackToNote(): void {
    const mdLeaf = this.app.workspace.getLeavesOfType("markdown")[0];
    if (mdLeaf) {
      this.isFullScreen = false;
      this.applyFullScreenClass();
      this.app.workspace.setActiveLeaf(mdLeaf, { focus: true });
      return;
    }
    this.isFullScreen = false;
    this.applyFullScreenClass();
  }

  private openSessionMenu(evt: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("New conversation")
        .setIcon("plus")
        .setChecked(!this.activeSessionId)
        .onClick(() => {
          this.activeSessionId = null;
          this.messages = [];
          this.updateSessionLabel();
          this.renderMessages();
        })
    );
    if (this.sessions.length > 0) {
      menu.addSeparator();
      for (const s of this.sessions.slice(0, 15)) {
        menu.addItem((item) =>
          item
            .setTitle(`${s.title.slice(0, 38)} (${s.selectedModel})`)
            .setChecked(s.sessionId === this.activeSessionId)
            .onClick(() => {
              if (s.sessionId) void this.selectSession(s.sessionId);
            })
        );
      }
    }
    menu.showAtMouseEvent(evt);
  }

  private updateSessionLabel(): void {
    if (!this.sessionLabelEl) return;
    if (!this.activeSessionId) {
      this.sessionLabelEl.textContent = "New conversation";
      return;
    }
    const found = this.sessions.find((s) => s.sessionId === this.activeSessionId);
    this.sessionLabelEl.textContent = found
      ? `${found.title.slice(0, 28)} (${found.selectedModel})`
      : "Active conversation";
  }

  async onClose(): Promise<void> {
    this.stopHandsFree();
    this.chatAbort?.abort();
    this.tts.stop();
    this.capture.dispose();
  }

  private async acquireWakeLock(): Promise<void> {
    try {
      const nav = navigator as unknown as {
        wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
      };
      if (nav.wakeLock && !this.wakeLock) {
        this.wakeLock = await nav.wakeLock.request("screen");
      }
    } catch {
      // ignore
    }
  }

  private releaseWakeLock(): void {
    if (this.wakeLock) {
      void this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
  }

  private updateSendButton(): void {
    if (!this.sendBtn) return;
    const busy = this.tts.speaking || !this.chatDone;
    this.sendBtn.empty();
    setIcon(this.sendBtn, busy ? "square" : "arrow-up");
    this.sendBtn.toggleClass("is-stop", busy);
    this.sendBtn.toggleClass(
      "is-ready",
      !busy && this.inputEl.value.trim().length > 0
    );
  }

  private setVoiceState(state: VoiceState, _label?: string): void {
    this.state = state;
    const isPtt = !this.handsFree;

    this.micBtn?.toggleClass("is-recording", isPtt && state === "recording");
    this.micBtn?.toggleClass("is-transcribing", isPtt && state === "transcribing");

    this.handsFreeBtn?.toggleClass("is-active", this.handsFree);
    this.handsFreeBtn?.setAttribute("data-state", this.handsFree ? state : "idle");
    if (this.handsFreeLabelEl) {
      this.handsFreeLabelEl.textContent = !this.handsFree
        ? "Voice"
        : state === "recording"
        ? "Hearing"
        : state === "transcribing"
        ? "STT..."
        : state === "thinking"
        ? "Thinking"
        : state === "speaking"
        ? "Speaking"
        : "Listening";
    }

    this.updateSendButton();
  }

  private clearRearmTimer(): void {
    if (this.rearmTimer !== null) {
      window.clearTimeout(this.rearmTimer);
      this.rearmTimer = null;
    }
  }

  private interruptAndListen(): void {
    this.clearRearmTimer();
    this.chatAbort?.abort();
    this.tts.stop();
    this.chatDone = true;
    if (this.handsFree) {
      if (this.plugin.settings.voiceBargeIn) {
        this.capture.resumeVad();
        this.setVoiceState("listening");
      } else {
        void this.startHandsFreeVad();
      }
    } else {
      this.setVoiceState("idle");
    }
  }

  private maybeResumeAfterTurn(): void {
    if (!this.chatDone || this.tts.speaking) {
      this.clearRearmTimer();
      this.updateSendButton();
      return;
    }
    if (this.handsFree) {
      if (this.plugin.settings.voiceBargeIn) {
        this.capture.resumeVad();
        this.setVoiceState("listening");
      } else {
        // Wait 450ms after TTS ends so Android speaker tail / room echo decays before mic opens
        this.clearRearmTimer();
        this.rearmTimer = window.setTimeout(() => {
          this.rearmTimer = null;
          if (this.handsFree && this.chatDone && !this.tts.speaking) {
            void this.startHandsFreeVad();
          }
        }, 450);
      }
    } else if (this.state !== "recording" && this.state !== "transcribing") {
      this.setVoiceState("idle");
    }
  }

  private async refreshSessionListOnly(): Promise<void> {
    try {
      this.sessions = await this.bridge.listSessions();
      this.updateSessionLabel();
    } catch {
      // ignore
    }
  }

  async loadSessions(): Promise<void> {
    try {
      this.sessions = await this.bridge.listSessions();
      this.bridgeOffline = false;
      const targetSid =
        this.activeSessionId ||
        this.plugin.settings.lastSessionId ||
        this.sessions[0]?.sessionId ||
        null;
      if (targetSid) {
        await this.selectSession(targetSid);
      } else {
        this.updateSessionLabel();
        this.renderMessages();
      }
    } catch {
      this.bridgeOffline = true;
      this.updateSessionLabel();
      this.renderEmptyHint(
        `Bridge offline (${this.plugin.settings.bridgeUrl}). Connect Tailscale & tap sync.`
      );
    }
  }

  private async selectSession(sessionId: string | null): Promise<void> {
    this.activeSessionId = sessionId;
    this.updateSessionLabel();
    if (sessionId) {
      this.plugin.settings.lastSessionId = sessionId;
      await this.plugin.saveSettings();
      try {
        this.messages = await this.bridge.getSessionMessages(sessionId);
      } catch {
        this.messages = [];
      }
    } else {
      this.messages = [];
    }
    this.renderMessages();
  }

  private renderEmptyHint(text: string): void {
    this.messagesEl.empty();
    const wrap = this.messagesEl.createDiv({ cls: "claudian-mobile-empty" });
    wrap.createDiv({ cls: "claudian-mobile-empty-title", text: "Claudian Mobile" });
    wrap.createDiv({ cls: "claudian-mobile-empty-sub", text });
  }

  private renderMessages(): void {
    this.messagesEl.empty();
    if (this.messages.length === 0) {
      this.renderEmptyHint("Ask anything or tap Voice for hands-free conversation.");
      return;
    }
    for (const m of this.messages) {
      const card = this.messagesEl.createDiv({
        cls: `claudian-mobile-msg claudian-mobile-msg-${m.role}`,
      });
      if (m.role === "assistant" && m.text === "...") {
        const dots = card.createDiv({ cls: "claudian-mobile-typing" });
        dots.createSpan();
        dots.createSpan();
        dots.createSpan();
        continue;
      }
      const body = card.createDiv({ cls: "claudian-mobile-msg-body" });
      void MarkdownRenderer.render(this.app, m.text, body, "", this);
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    window.requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }

  private async sendFromInput(): Promise<void> {
    const prompt = this.inputEl.value.trim();
    if (!prompt) return;
    this.inputEl.value = "";
    this.inputEl.style.height = "auto";
    this.updateSendButton();
    await this.sendPrompt(prompt, false);
  }

  private async sendPrompt(prompt: string, speakReply: boolean): Promise<void> {
    this.chatAbort?.abort();
    this.tts.stop();

    this.messages.push({ role: "user", text: prompt });
    const assistantMsg: ChatMessage = { role: "assistant", text: "..." };
    this.messages.push(assistantMsg);
    this.renderMessages();

    this.chatDone = false;
    this.setVoiceState("thinking");
    const ctrl = new AbortController();
    this.chatAbort = ctrl;

    let spokenCursor = 0;

    try {
      await this.bridge.streamChat({
        prompt,
        sessionId: this.activeSessionId,
        signal: ctrl.signal,
        onSession: (sid) => {
          this.activeSessionId = sid;
          this.updateSessionLabel();
          this.plugin.settings.lastSessionId = sid;
          void this.plugin.saveSettings();
        },
        onText: (fullText) => {
          if (ctrl.signal.aborted) return;
          assistantMsg.text = fullText;
          this.renderMessages();
          if (speakReply) {
            const { sentences, nextCursor } = extractCompletedSentences(
              fullText,
              spokenCursor
            );
            spokenCursor = nextCursor;
            for (const s of sentences) this.tts.enqueue(s);
          }
        },
        onDone: (sid, fullText) => {
          if (ctrl.signal.aborted) return;
          if (sid) this.activeSessionId = sid;
          this.updateSessionLabel();
          if (fullText) assistantMsg.text = fullText;
          this.renderMessages();
          void this.refreshSessionListOnly();
          if (speakReply) {
            const rem = (assistantMsg.text || "").slice(spokenCursor).trim();
            spokenCursor = (assistantMsg.text || "").length;
            if (rem && rem !== "...") this.tts.enqueue(rem);
          }
        },
      });
    } catch (err) {
      if (ctrl.signal.aborted) {
        if (assistantMsg.text === "...") {
          assistantMsg.text = "_(Interrupted)_";
          this.renderMessages();
        }
      } else {
        assistantMsg.text = `Error: ${err instanceof Error ? err.message : String(err)}`;
        this.renderMessages();
      }
    } finally {
      if (this.chatAbort === ctrl) {
        this.chatDone = true;
        this.maybeResumeAfterTurn();
      }
    }
  }

  private async togglePushToTalk(): Promise<void> {
    if (this.handsFree) this.stopHandsFree();
    if (this.tts.speaking) this.tts.stop();

    if (this.state === "recording") {
      const wav = this.capture.stopPushToTalk();
      if (!wav) {
        this.setVoiceState("idle");
        return;
      }
      await this.processVoiceWav(wav);
      return;
    }
    if (this.state === "transcribing") return;

    try {
      this.setVoiceState("recording");
      await this.capture.startPushToTalk();
    } catch (err) {
      this.setVoiceState("idle");
      new Notice(`Mic error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async toggleSpeakerMode(): Promise<void> {
    this.plugin.settings.voiceBargeIn = !this.plugin.settings.voiceBargeIn;
    await this.plugin.saveSettings();
    const loudSpeaker = !this.plugin.settings.voiceBargeIn;
    this.speakerModeBtn?.toggleClass("is-active", loudSpeaker);
    new Notice(
      loudSpeaker
        ? "Loud Speaker Mode ON (tap Voice/Stop to interrupt)"
        : "Bluetooth / Barge-In Mode ON (talk anytime to interrupt)"
    );
    if (this.handsFree) {
      this.capture.stopVad();
      void this.startHandsFreeVad();
    }
  }

  private async startHandsFreeVad(): Promise<void> {
    if (!this.handsFree || (!this.plugin.settings.voiceBargeIn && (!this.chatDone || this.tts.speaking))) {
      return;
    }
    this.setVoiceState("listening");
    try {
      await this.capture.startVad({
        onSpeechStart: () => {
          if (this.tts.speaking || !this.chatDone) {
            this.chatAbort?.abort();
            this.tts.stop();
            this.chatDone = true;
          }
          this.setVoiceState("recording");
        },
        onUtterance: (wav) => {
          if (this.plugin.settings.voiceBargeIn) {
            this.capture.pauseVad();
          } else {
            // Release mic track so Android/iOS routes TTS to the loud loudspeaker
            this.capture.stopVad();
          }
          void this.processVoiceWav(wav);
        },
      });
      // If TTS started while getUserMedia was resolving, close mic immediately
      if (!this.handsFree || (!this.plugin.settings.voiceBargeIn && (!this.chatDone || this.tts.speaking))) {
        this.capture.stopVad();
      }
    } catch (err) {
      this.handsFree = false;
      this.releaseWakeLock();
      this.setVoiceState("idle");
      new Notice(`Mic error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async toggleHandsFree(): Promise<void> {
    if (this.handsFree) {
      if (this.tts.speaking || !this.chatDone) {
        this.interruptAndListen();
        return;
      }
      this.stopHandsFree();
      return;
    }
    this.handsFree = true;
    this.chatDone = true;
    void this.acquireWakeLock();
    await this.startHandsFreeVad();
  }

  private stopHandsFree(): void {
    this.clearRearmTimer();
    this.handsFree = false;
    this.releaseWakeLock();
    this.capture.stopVad();
    this.chatAbort?.abort();
    this.tts.stop();
    this.chatDone = true;
    this.setVoiceState("idle");
  }

  private async processVoiceWav(wav: ArrayBuffer): Promise<void> {
    this.setVoiceState("transcribing");
    try {
      const text = await this.bridge.transcribeWav(wav);
      if (!text) {
        this.maybeResumeAfterTurn();
        return;
      }
      await this.sendPrompt(text, this.plugin.settings.autoSpeakReplies);
    } catch (err) {
      new Notice(`STT error: ${err instanceof Error ? err.message : String(err)}`);
      this.maybeResumeAfterTurn();
    }
  }
}
