import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const env = loadEnv(mode, root, "AVL_");
  return {
    base: "/avl-desktop/",
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      proxy: {
        "/avl-desktop/socket": {
          target: env.AVL_DESKTOP_URL ?? "http://127.0.0.1:8080",
          headers: env.AVL_DESKTOP_TOKEN ? { authorization: `Bearer ${env.AVL_DESKTOP_TOKEN}` } : undefined,
          rewrite: () => "/v1/view",
          ws: true,
        },
      },
    },
  };
});
