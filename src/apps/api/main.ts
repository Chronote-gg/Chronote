import { bootstrapApp } from "../bootstrap";

bootstrapApp("api").catch((error) => {
  console.error("API startup failed.", error);
  process.exit(1);
});
