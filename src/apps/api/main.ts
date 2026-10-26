import { failRuntimeStartup } from "../../services/runtimeShutdownService";
import { bootstrapApp } from "../bootstrap";

bootstrapApp("api").catch(failRuntimeStartup);
