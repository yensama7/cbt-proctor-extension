// config.js — shared by content.js and background.js (importScripts).
//
// Resolves the API base URL. Production deployments push "serverUrl" via
// Chrome Enterprise Policy (chrome.storage.managed, see managed_schema.json)
// so the same extension build works on any subnet without code changes.
// Falls back to localhost for development.

const DEFAULT_SERVER_BASE = "http://localhost:3000";

function getServerBase() {
    return new Promise((resolve) => {
        try {
            chrome.storage.managed.get("serverUrl", (items) => {
                const url = !chrome.runtime.lastError && items && items.serverUrl;
                resolve(url ? String(url).replace(/\/+$/, "") : DEFAULT_SERVER_BASE);
            });
        } catch {
            resolve(DEFAULT_SERVER_BASE);
        }
    });
}
