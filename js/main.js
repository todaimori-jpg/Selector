import { App } from "./ui/app.js";

const app = new App();
window.selector = app; // handy from the console while tuning

try {
  await app.boot();
} catch (e) {
  document.querySelector("#statusLine").textContent = `Startup failed: ${e.message}`;
  console.error(e);
}

// Service worker is optional: file:// and Pages project subpaths both resolve relatively.
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(new URL("sw.js", location.href).href, {
      scope: new URL(".", location.href).pathname,
    }).catch(() => { /* offline support simply stays off */ });
  });
}
