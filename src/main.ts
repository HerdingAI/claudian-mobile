import { Plugin } from "obsidian";
import { ClaudianMobileView, VIEW_TYPE_CLAUDIAN_MOBILE } from "./chat-view";
import { ClaudianMobileSettingTab } from "./settings";
import { ClaudianMobileSettings, DEFAULT_MOBILE_SETTINGS } from "./types";

export default class ClaudianMobilePlugin extends Plugin {
  settings: ClaudianMobileSettings = { ...DEFAULT_MOBILE_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_CLAUDIAN_MOBILE,
      (leaf) => new ClaudianMobileView(leaf, this)
    );

    this.addRibbonIcon("message-square", "Open Claudian Mobile", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-claudian-mobile",
      name: "Open Claudian Mobile",
      callback: () => void this.activateView(),
    });

    this.addSettingTab(new ClaudianMobileSettingTab(this.app, this));
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN_MOBILE)[0];
    if (leaf) {
      const root = leaf.getRoot();
      if (root === workspace.rightSplit || root === workspace.leftSplit) {
        leaf.detach();
        leaf = undefined as unknown as typeof leaf;
      }
    }
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({
        type: VIEW_TYPE_CLAUDIAN_MOBILE,
        active: true,
      });
    }
    workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_MOBILE_SETTINGS,
      await this.loadData()
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
