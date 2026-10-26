import type { Locator, Page } from "@playwright/test";
import { testIds } from "./testIds";

export class SettingsPage {
  constructor(private readonly page: Page) {}

  root(): Locator {
    return this.page.getByTestId(testIds.settings.page);
  }

  addChannelButton(): Locator {
    return this.page.getByTestId(testIds.settings.addChannel);
  }

  refreshChannelsButton(): Locator {
    return this.page.getByTestId(testIds.settings.refreshChannels);
  }

  firstOverride(): Locator {
    return this.overrides()
      .filter({
        has: this.page.getByRole("button", { name: /remove override/i }),
      })
      .first();
  }

  overrides(): Locator {
    return this.page.getByTestId(testIds.settings.override);
  }

  loadingConfig(): Locator {
    return this.page.getByTestId(testIds.settings.loadingConfig).first();
  }

  loadingOverrides(): Locator {
    return this.page.getByTestId(testIds.settings.loadingOverrides).first();
  }

  async waitForLoaded(expectedOverrideName?: string): Promise<void> {
    await this.root().waitFor({ state: "visible" });
    await this.loadingConfig().waitFor({ state: "hidden" });
    await this.loadingOverrides().waitFor({ state: "hidden" });
    if (expectedOverrideName) {
      await this.overrideByName(expectedOverrideName).waitFor({
        state: "visible",
      });
    } else {
      await this.firstOverride().waitFor({ state: "visible" });
    }
  }

  async expandGroup(label: string): Promise<void> {
    const control = this.root().getByRole("button", { name: label }).first();
    if (await control.count()) {
      const expanded = await control.getAttribute("aria-expanded");
      if (expanded !== "true") {
        await control.click();
      }
    }
  }

  groupByName(label: string): Locator {
    const slug = label.toLowerCase().replace(/\s+/g, "-");
    return this.page.getByTestId(`settings-config-group-${slug}`);
  }

  overrideByName(name: string): Locator {
    return this.overrides().filter({ hasText: name }).first();
  }

  removeFirstOverride(): Locator {
    return this.firstOverride().getByRole("button", {
      name: /remove override/i,
    });
  }

  async openFirstOverrideEdit(): Promise<void> {
    await this.firstOverride()
      .getByRole("button", { name: /^Edit / })
      .click();
  }

  modal(): Locator {
    return this.page.getByTestId(testIds.settings.modal).getByRole("dialog");
  }

  modalTitle(): Locator {
    return this.page.getByRole("heading", { name: /channel settings/i });
  }

  tagInput(): Locator {
    return this.modal().getByLabel(/tags/i);
  }

  saveChannelButton(): Locator {
    return this.modal().getByTestId(testIds.settings.saveChannel);
  }

  saveDefaultsButton(): Locator {
    return this.page.getByTestId("settings-save-defaults");
  }

  saveConfigButton(): Locator {
    return this.page.getByTestId(testIds.settings.saveConfig);
  }

  chatTtsToggle(): Locator {
    return this.page.getByRole("button", { name: /chat tts/i });
  }

  chronoteVoiceSelect(): Locator {
    return this.page.getByRole("textbox", { name: /live voice tts voice/i });
  }

  chatTtsVoiceSelect(): Locator {
    return this.page.getByPlaceholder(/chat tts voice/i);
  }

  async selectChronoteVoice(label: string): Promise<void> {
    await this.chronoteVoiceSelect().click();
    await this.page.getByRole("option", { name: label }).click();
  }

  async selectChatTtsVoice(label: string): Promise<void> {
    await this.chatTtsVoiceSelect().click();
    await this.page.getByRole("option", { name: label }).click();
  }
}
