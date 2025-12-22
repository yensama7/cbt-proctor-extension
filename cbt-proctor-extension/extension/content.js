document.addEventListener("visibilitychange", () => {
if (document.hidden) {
    chrome.runtime.sendMessage({
        type: "PAGE_HIDDEN",
        detail: "Tab lost visibility or browser minimized"
    });
}
});