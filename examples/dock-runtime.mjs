// Compatibility entrypoint; production implementation lives under host/.
export * from "../host/dock-runtime.mjs";
import { runExecution } from "../host/dock-runtime.mjs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await runExecution();
