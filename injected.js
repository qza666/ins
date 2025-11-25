(function () {
  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    if (!e.data || e.data.type !== "GET_WEBSESSION_ID") return;

    let id = null;
    try {
      id = require("WebSession").getId();
    } catch (err) {
      console.error("getId error:", err);
    }

    window.postMessage({ type: "WEBSESSION_ID", id }, "*");
  });
})();
