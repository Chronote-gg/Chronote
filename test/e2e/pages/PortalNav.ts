import type { Page } from "@playwright/test";
import { testIds } from "./testIds";

export class PortalNav {
  constructor(private readonly page: Page) {}

  async goToLibrary(): Promise<void> {
    await this.page.getByTestId(testIds.nav.library).click();
  }

  async goToAsk(): Promise<void> {
    await this.page.getByTestId(testIds.nav.ask).click();
  }

  async goToBilling(): Promise<void> {
    await this.page.getByTestId(testIds.nav.billing).click();
  }

  async goToSettings(): Promise<void> {
    await this.page.getByTestId(testIds.nav.settings).click();
  }

  async goToAdminConfig(): Promise<void> {
    await this.page.getByTestId(testIds.header.admin).click();
    await this.page.getByTestId(testIds.adminHome.config).click();
  }
}
