import { failRuntimeStartup } from "../../services/runtimeShutdownService";
import { bootstrapApp } from "../bootstrap";

bootstrapApp("bot").catch(failRuntimeStartup);
