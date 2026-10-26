import { failRuntimeStartup } from "./services/runtimeShutdownService";
import { bootstrapApp } from "./apps/bootstrap";

bootstrapApp("all").catch(failRuntimeStartup);
