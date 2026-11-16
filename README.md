# Claudian Mobile

Mobile-compatible (`isDesktopOnly: false`) Obsidian plugin that brings **Claude Code**, **Antigravity**, and **OpenCode** with **back-and-forth voice interaction** (Push-to-Talk & Hands-Free) to **Obsidian Mobile (iOS & Android)** and **Obsidian Desktop** by connecting over Tailscale or LAN to your workstation's `claudian-bridge` server.

## Features

- **Multi-Provider & Dynamic Models**: Choose **Claude Code** (`claude`), **Antigravity** (`agy`), or **OpenCode** (`opencode`) in Settings; the **Model** dropdown populates dynamically from `GET /models?provider=...`.
- **Same Sessions Everywhere**: Lists and resumes your workstation sessions, loading full message history so you can pick up coding or research threads from your phone.
- **Push-to-Talk & Hands-Free Voice**: Records 16 kHz mono WAV in-memory, streams raw `audio/wav` to your workstation's `faster-whisper` worker (`1800ms` VAD silence), streams replies token-by-token, and speaks completed sentences/lines via **Kokoro TTS** (with device Web Speech fallback).
- **Noise-Resistant Barge-In & Android Loudspeaker Toggle**: Uses a `215 Hz – 3.4 kHz` speech-band filter, ZCR gate (`0.02..0.32`), and adaptive noise floor to ignore non-speech bumps/hiss during barge-in; plays Kokoro WAV via WebAudio `AudioContext` for full speaker volume on Android, with a one-tap **Loud Speaker / Barge-In** toggle and `450ms` post-TTS cooldown.
- **Resilient Reconnect**: Automatically retries transient network/5xx errors and refreshes sessions when returning to the app (`visibilitychange`) or regaining connectivity (`online`).
- **Sync-Ready Configuration**: Configure the Bridge URL and Auth Token once on desktop; Obsidian Sync carries `.obsidian/plugins/claudian-bridge-mobile/` to your phone automatically.

## Prerequisites

1. **Obsidian** (`v1.5.0+` on Desktop, iOS, or Android).
2. **`claudian-bridge` server** running on your workstation (exposes your local AI CLI providers, Whisper STT, and Kokoro TTS over HTTP/SSE with Bearer token auth).
3. **Tailscale or Local LAN** so your phone can reach `http://<your-workstation-ip>:8790`.

## Installation

### Option 1: From GitHub Releases (Recommended)
1. Download `claudian-mobile-0.1.0.zip` (or `manifest.json`, `main.js`, `styles.css`) from the [Releases](https://github.com/HerdingAI/claudian-mobile/releases) page.
2. Extract the files into `<your-vault>/.obsidian/plugins/claudian-bridge-mobile/`.
3. Enable **Claudian Mobile** in **Settings → Community plugins**.

### Option 2: Via BRAT
1. Install the **BRAT** plugin in Obsidian.
2. Click **Add Beta Plugin** and enter `HerdingAI/claudian-mobile`.
3. Enable **Claudian Mobile** in **Settings → Community plugins**.

### Option 3: Build from Source
```bash
git clone https://github.com/HerdingAI/claudian-mobile.git
cd claudian-mobile
npm install
npm test
npm run package
```
Extract `dist/claudian-mobile-0.1.0.zip` into `<your-vault>/.obsidian/plugins/claudian-bridge-mobile/`.

## Setup Guide

### 1. Workstation & Bridge
Start `claudian-bridge` on your workstation and note its Tailscale/LAN URL (e.g., `http://<your-workstation-ip>:8790`) and Bearer auth token from `~/.config/claudian-bridge/config.json`.

### 2. Plugin Settings
Open **Settings → Claudian Mobile** and set:
- **Workstation Bridge URL**: `http://<your-workstation-ip>:8790`
- **Bridge Auth Token**: Your Bearer token from `claudian-bridge`
- **AI Provider & Model**: Choose `claude`, `agy`, or `opencode`, then pick a model.

Tap **Test** to verify connectivity to your bridge, Whisper STT, and Kokoro TTS.

### 3. Mobile Sync (iOS / Android)
1. Install **Tailscale** on your phone and sign into the same tailnet as your workstation.
2. If using **Obsidian Sync**, enable **Installed community plugins** and **Active community plugin list** on both desktop and mobile, then let your vault sync.
3. Open **Claudian Mobile** from the sidebar/ribbon, select a session (or tap `+`), and use the **Mic** (Push-to-Talk) or **Waveform** (Hands-Free) button. Grant microphone permission when prompted.

> **Tip**: For **screen-off** voice calls (like a normal phone call), you can also install the companion **[Claudian Call](https://github.com/HerdingAI/claudian-call)** Android app (also served by [Claudian Bridge](https://github.com/HerdingAI/claudian-bridge) at `http://<your-bridge-host>:8790/apk`).

## Troubleshooting

- **Bridge offline**: Verify Tailscale is connected on your phone and `claudian-bridge` is listening on port `8790`.
- **No audio / quiet speaker on Android**: Toggle **Loud Speaker** mode (disables barge-in mic capture during playback so Android routes audio through the media speaker instead of the call earpiece).
- **401 Unauthorized**: Double-check that your **Bridge Auth Token** matches `~/.config/claudian-bridge/config.json`.

## Claudian Suite

- **[Claudian Bridge](https://github.com/HerdingAI/claudian-bridge)** — Workstation HTTP/SSE server required by Claudian Mobile (exposes Claude Code, Antigravity, OpenCode, `faster-whisper` STT, and Kokoro TTS).
- **[Claudian Call](https://github.com/HerdingAI/claudian-call)** — Native Android companion app for screen-off voice calls over `claudian-bridge`.
- **[Claudian Voice](https://github.com/HerdingAI/claudian-voice)** — Desktop Obsidian plugin adding local `faster-whisper` STT and Kokoro TTS directly to Claudian.

## License

MIT — see [LICENSE](LICENSE).
