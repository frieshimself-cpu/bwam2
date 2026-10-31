// Website entry: same origin as the API. The extension popup has its own boot (popup.js).
initDashboard({ apiBase: "", token: localStorage.getItem("apiToken") || "" });
