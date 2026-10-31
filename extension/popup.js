// Popup entry: reads the backend URL/token from extension storage, then runs the shared dashboard.
const DEFAULT_BACKEND = "http://127.0.0.1:3210";

chrome.storage.sync.get({ backendUrl: DEFAULT_BACKEND, apiToken: "" }, ({ backendUrl, apiToken }) => {
  document.getElementById("backend-url").value = backendUrl;
  document.getElementById("backend-token").value = apiToken;
  initDashboard({ apiBase: backendUrl, token: apiToken });
});

document.getElementById("save-backend").addEventListener("click", () => {
  const backendUrl = document.getElementById("backend-url").value.trim().replace(/\/$/, "") || DEFAULT_BACKEND;
  const apiToken = document.getElementById("backend-token").value.trim();
  chrome.storage.sync.set({ backendUrl, apiToken }, () => window.location.reload());
});
