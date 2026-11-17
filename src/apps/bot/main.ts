import { failWorkerStartup } from "../../services/workerShutdown";
import { bootstrapApp } from "../bootstrap";

bootstrapApp("bot").catch(failWorkerStartup);
