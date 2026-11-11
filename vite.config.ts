import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { THEME_INIT_SCRIPT } from "@stack-ui/core/theme";

/**
 * Stack UI's theme script (applies the saved light/dark preference before first paint), served as a
 * same-origin file rather than inline, so it works under a Content-Security-Policy that allows only
 * same-origin scripts. The text comes from @stack-ui/core, so there is no second copy to drift.
 */
function stackTheme(): Plugin {
  return {
    name: "stack-ui-theme",
    configureServer(server) {
      server.middlewares.use("/theme.js", (_req, res) => {
        res.setHeader("content-type", "text/javascript; charset=utf-8");
        res.end(THEME_INIT_SCRIPT);
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "theme.js", source: THEME_INIT_SCRIPT });
    },
  };
}

export default defineConfig({
  plugins: [react(), stackTheme()],
});
