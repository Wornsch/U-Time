import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const WIENER_LINIEN_ORIGIN = "https://www.wienerlinien.at";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/wl": {
        target: WIENER_LINIEN_ORIGIN,
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api\/wl/, ""),
      },
    },
  },
});
