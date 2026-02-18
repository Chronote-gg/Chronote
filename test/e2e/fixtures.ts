import { test as base, expect } from "@playwright/test";
import {
  AskPage,
  BillingPage,
  AdminConfigPage,
  HomePage,
  JoinPage,
  LibraryPage,
  PortalNav,
  ServerSelectPage,
  SettingsPage,
} from "./pages";

type Fixtures = {
  homePage: HomePage;
  joinPage: JoinPage;
  serverSelectPage: ServerSelectPage;
  nav: PortalNav;
  libraryPage: LibraryPage;
  askPage: AskPage;
  billingPage: BillingPage;
  settingsPage: SettingsPage;
  adminConfigPage: AdminConfigPage;
};

export const test = base.extend<Fixtures>({
  homePage: async ({ page }, use) => {
    await use(new HomePage(page));
  },
  joinPage: async ({ page }, use) => {
    await use(new JoinPage(page));
  },
  serverSelectPage: async ({ page }, use) => {
    await use(new ServerSelectPage(page));
  },
  nav: async ({ page }, use) => {
    await use(new PortalNav(page));
  },
  libraryPage: async ({ page }, use) => {
    await use(new LibraryPage(page));
  },
  askPage: async ({ page }, use) => {
    await use(new AskPage(page));
  },
  billingPage: async ({ page }, use) => {
    await use(new BillingPage(page));
  },
  settingsPage: async ({ page }, use) => {
    await use(new SettingsPage(page));
  },
  adminConfigPage: async ({ page }, use) => {
    await use(new AdminConfigPage(page));
  },
});

export { expect };
