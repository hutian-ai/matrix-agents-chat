// Compatibility entrypoint; production implementation lives under host/.
export * from "../host/dock-host.js";
import { main } from "../host/dock-host.js";
import { runMain } from "citty";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await runMain(main);
