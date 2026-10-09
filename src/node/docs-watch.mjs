// Refresh Astro's staged inputs when the author's source docs change.
import path from "node:path";
import { stage } from "./stage.mjs";

export function docsWatchPlugin(config, out, assets) {
  return {
    name: "in-ctrl-docs-watch",
    configureServer(server) {
      server.watcher.add([config.docs, ...(config.home ? [config.home] : [])]);
      let timer;
      const changed = (event, file) => {
        const rel = path.relative(config.docs, file);
        const inside = rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
        if (!inside && file !== config.home) return;
        if (!["add", "change", "unlink", "addDir", "unlinkDir"].includes(event)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          try {
            stage(config, out, assets, { incremental: true });
            const module = server.moduleGraph.getModuleById("\0virtual:in-ctrl/project");
            if (module) server.moduleGraph.invalidateModule(module);
            server.ws.send({ type: "full-reload" });
          } catch (error) {
            server.config.logger.error(`in-ctrl: couldn't refresh docs: ${error.message}`);
          }
        }, 150);
      };
      server.watcher.on("all", changed);
      server.httpServer?.once("close", () => {
        clearTimeout(timer);
        server.watcher.off("all", changed);
      });
    },
  };
}
