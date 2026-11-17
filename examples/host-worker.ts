// Compatibility entrypoint; production implementation lives under host/.
export * from "../host/host-worker.js";
import { main } from "../host/host-worker.js";
import { runMain } from "citty";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await runMain(main);
