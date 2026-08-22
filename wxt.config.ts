import { defineConfig } from "wxt";
import react from "@vitejs/plugin-react";

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "VLESS — On-Device Browser Agent",
    description:
      "Privacy-preserving AI that sees your screen, understands your intent, and automates web tasks — without sending a single pixel to the cloud.",
    permissions: [
      "activeTab",
      "scripting",
      "storage",
      "sidePanel",
      "tabs",
      "tabCapture",
      "webNavigation",
    ],
    host_permissions: ["<all_urls>"],
    side_panel: {
      default_path: "sidepanel.html",
    },
    icons: {
      16: "icons/icon-16.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    },
    action: {
      default_icon: {
        16: "icons/icon-16.png",
        48: "icons/icon-48.png",
      },
    },
  },
  vite: () => ({
    plugins: [react()],
  }),
});
