import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import MenuBarPanel from "./MenuBarPanel";

const isMenuBar =
  window.location.hash.replace(/^#/, "") === "menubar" ||
  new URLSearchParams(window.location.search).get("view") === "menubar";

// The main window starts hidden (tauri.conf `visible: false`) so a transparent
// window never flashes white during WebView2 init. Reveal it once the boot
// screen has had a moment to paint offscreen. A hidden webview can throttle
// rAF, so use short timeouts; the second is a safety net so the window always
// becomes visible even if the first misfires. Scheduled before React renders so
// a render error can't strand the window hidden.
if (!isMenuBar && "__TAURI_INTERNALS__" in window) {
  const reveal = () => {
    import("@tauri-apps/api/window")
      .then((mod) => mod.getCurrentWindow().show())
      .catch(() => {});
  };
  window.setTimeout(reveal, 120);
  window.setTimeout(reveal, 1200);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isMenuBar ? <MenuBarPanel /> : <App />}
  </React.StrictMode>,
);