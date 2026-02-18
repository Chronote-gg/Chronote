import type { Locator, Page } from "@playwright/test";
import { testIds } from "./testIds";

export class JoinPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto("/join");
  }

  hero(): Locator {
    return this.page.getByTestId(testIds.join.hero);
  }

  ctaDiscord(): Locator {
    return this.page.getByTestId(testIds.join.ctaDiscord);
  }
}
