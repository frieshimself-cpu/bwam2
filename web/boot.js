// Website entry: same origin as the API. The extension popup has its own boot (popup.js).
// When the backend has an API_TOKEN, the page asks for it once and keeps it in localStorage.
initDashboard({
  apiBase: "",
  token: localStorage.getItem("apiToken") || "",
  onUnauthorized() {
    const token = window.prompt("This backend needs its API token (printed when it was installed, also in .env):", "");
    if (token && token.trim()) {
      localStorage.setItem("apiToken", token.trim());
      window.location.reload();
    }
  },
});
