import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { BridgeClient } from "./bridge-client";
import type ClaudianMobilePlugin from "./main";
import { KOKORO_VOICES } from "./types";

export class ClaudianMobileSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ClaudianMobilePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Claudian Mobile" });

    new Setting(containerEl)
      .setName("Workstation Bridge URL")
      .setDesc("Tailscale or LAN URL of your claudian-bridge server.")
      .addText((txt) =>
        txt
          .setPlaceholder("http://your-workstation-ip:8790")
          .setValue(this.plugin.settings.bridgeUrl)
          .onChange(async (val) => {
            this.plugin.settings.bridgeUrl = val.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Bridge Auth Token")
      .setDesc("Bearer token from ~/.config/claudian-bridge/config.json. Warning: plugin data.json syncs with Obsidian Sync — avoid syncing vaults to untrusted devices.")
      .addText((txt) => {
        txt.inputEl.type = "password";
        txt.inputEl.autocomplete = "off";
        return txt
          .setPlaceholder("Paste token...")
          .setValue(this.plugin.settings.authToken)
          .onChange(async (val) => {
            this.plugin.settings.authToken = val.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Test Bridge Connection")
      .setDesc("Verify connectivity to your workstation Claude, Whisper, and Kokoro.")
      .addButton((btn) =>
        btn.setButtonText("Test").onClick(async () => {
          try {
            const client = new BridgeClient(() => this.plugin.settings);
            const h = await client.health();
            const sessions = await client.listSessions();
            new Notice(
              `Connected! Vault: ${h.vault}, Sessions: ${sessions.length}`
            );
          } catch (err) {
            new Notice(
              `Connection failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        })
      );

    new Setting(containerEl)
      .setName("AI Provider")
      .setDesc("Backend CLI on your workstation")
      .addDropdown((dd) => {
        dd.addOption("claude", "Claude Code (claude)");
        dd.addOption("agy", "Antigravity (agy)");
        dd.addOption("opencode", "OpenCode (opencode)");
        dd.setValue(this.plugin.settings.provider || "claude").onChange(async (val) => {
          this.plugin.settings.provider = val as "claude" | "agy" | "opencode";
          this.plugin.settings.model = val === "claude" ? "haiku" : "";
          await this.plugin.saveSettings();
          this.display();
        });
      });

    const modelSetting = new Setting(containerEl).setName("Model");
    modelSetting.addDropdown((dd) => {
      const cur = this.plugin.settings.model || "";
      dd.addOption(cur, cur || "Default (auto)");
      dd.setValue(cur).onChange(async (val) => {
        this.plugin.settings.model = val;
        await this.plugin.saveSettings();
      });
      void new BridgeClient(() => this.plugin.settings)
        .listModels(this.plugin.settings.provider || "claude")
        .then((models) => {
          if (!models.length) return;
          dd.selectEl.empty();
          for (const m of models) {
            dd.addOption(m.id, m.label || m.id || "Default (auto)");
          }
          const hasCurrent = models.some((m) => m.id === cur);
          const nextVal = hasCurrent ? cur : models[0].id;
          dd.setValue(nextVal);
          if (!hasCurrent) {
            this.plugin.settings.model = nextVal;
            void this.plugin.saveSettings();
          }
        })
        .catch(() => {
          // keep fallback option when bridge is offline
        });
    });

    new Setting(containerEl)
      .setName("TTS Engine")
      .addDropdown((dd) => {
        dd.addOption("bridge-kokoro", "Workstation Kokoro (Synced)");
        dd.addOption("webspeech", "Device Web Speech");
        dd.setValue(this.plugin.settings.ttsEngine).onChange(async (val) => {
          this.plugin.settings.ttsEngine = val as "bridge-kokoro" | "webspeech";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Kokoro Voice")
      .addDropdown((dd) => {
        for (const v of KOKORO_VOICES) dd.addOption(v.id, v.label);
        dd.setValue(this.plugin.settings.kokoroVoice).onChange(async (val) => {
          this.plugin.settings.kokoroVoice = val;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Speech Speed")
      .addSlider((sl) =>
        sl
          .setLimits(0.75, 1.5, 0.05)
          .setValue(this.plugin.settings.speechRate)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.speechRate = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-speak voice replies")
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.autoSpeakReplies)
          .onChange(async (val) => {
            this.plugin.settings.autoSpeakReplies = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Voice barge-in while speaking")
      .setDesc(
        "Keep mic open during playback to interrupt by talking. On by default (recommended with headphones). Turn off for full loudspeaker volume on iOS."
      )
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.voiceBargeIn)
          .onChange(async (val) => {
            this.plugin.settings.voiceBargeIn = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Concise mobile replies")
      .setDesc("Append a system instruction so Claude Code replies concisely on mobile.")
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.conciseMobilePrompt)
          .onChange(async (val) => {
            this.plugin.settings.conciseMobilePrompt = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Mobile system prompt")
      .setDesc("Appended to Claude Code when concise mobile replies is enabled.")
      .addTextArea((txt) =>
        txt
          .setValue(this.plugin.settings.mobileSystemPrompt)
          .onChange(async (val) => {
            this.plugin.settings.mobileSystemPrompt = val;
            await this.plugin.saveSettings();
          })
      );
  }
}
