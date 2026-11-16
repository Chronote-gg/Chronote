import { failWorkerStartup } from "./services/workerShutdown";
import { bootstrapApp } from "./apps/bootstrap";

bootstrapApp("all").catch(failWorkerStartup);
