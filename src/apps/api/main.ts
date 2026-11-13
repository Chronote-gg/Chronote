import { failWorkerStartup } from "../../services/workerShutdown";
import { bootstrapApp } from "../bootstrap";

bootstrapApp("api").catch(failWorkerStartup);
