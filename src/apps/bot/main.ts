import { bootstrapApp } from "../bootstrap";

bootstrapApp("bot").catch((error) => {
  console.error("Bot startup failed.", error);
  process.exit(1);
});
