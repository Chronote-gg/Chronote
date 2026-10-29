import type { Locator, Page } from "@playwright/test";
import { testIds } from "./testIds";

export class ServerSelectPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto("/portal/select-server");
  }

  root(): Locator {
    return this.page.getByTestId(testIds.serverSelect.root);
  }

  firstServerCard(): Locator {
    return this.page.getByTestId(testIds.serverSelect.card).first();
  }

  serverCardByName(name: string): Locator {
    return this.page.getByTestId(testIds.serverSelect.card).filter({
      hasText: name,
    });
  }

  private async waitForPortal(): Promise<void> {
    await this.page.waitForURL(/\/portal\/meetings\?/);
    await this.page
      .getByTestId(testIds.library.page)
      .waitFor({ state: "visible" });
  }

  async openFirstServer(): Promise<void> {
    await this.root().waitFor({ state: "visible" });
    const card = this.firstServerCard();
    await card.getByTestId(testIds.serverSelect.open).click();
    await this.waitForPortal();
  }

  async openServerByName(name: string): Promise<void> {
    await this.root().waitFor({ state: "visible" });
    const card = this.serverCardByName(name).first();
    await card.getByTestId(testIds.serverSelect.open).click();
    await this.waitForPortal();
  }
}
