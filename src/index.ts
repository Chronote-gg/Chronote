import { bootstrapApp } from "./apps/bootstrap";

bootstrapApp("all").catch((error) => {
  console.error("Startup failed.", error);
  process.exit(1);
});
