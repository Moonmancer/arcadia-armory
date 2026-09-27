// Isolated-world content script: the only part with access to browser.storage.
// page.js runs in the page's MAIN world (it needs the calculator's globals) and
// talks to this script via window.postMessage.
"use strict";

const STORAGE_KEY = "armory";
const INBOX_KEY = "armoryInbox"; // item list handed over by the control panel (cp.js)

// Apply the "Armory" theme (the default) as early as possible to avoid a flash
// of the calculator's own colors; page.js keeps it in sync with the theme select.
browser.storage.local.get(STORAGE_KEY).then((stored) => {
	const theme = (stored[STORAGE_KEY] && stored[STORAGE_KEY].settings && stored[STORAGE_KEY].settings.theme) || "armory";
	document.documentElement.classList.toggle("aa-theme-armory", theme === "armory");
});

function toPage(type, data) {
	window.postMessage({ aa: "toPage", type, data }, window.location.origin);
}

window.addEventListener("message", async (event) => {
	if (event.source !== window || !event.data || event.data.aa !== "toBridge") {
		return;
	}
	const { type, data } = event.data;
	if (type === "load") {
		const stored = await browser.storage.local.get([STORAGE_KEY, INBOX_KEY]);
		toPage("data", stored[STORAGE_KEY] || null);
		if (stored[INBOX_KEY]) toPage("inbox", stored[INBOX_KEY]);
	} else if (type === "save") {
		// Round-trip through JSON so only plain data from the page is stored.
		await browser.storage.local.set({ [STORAGE_KEY]: JSON.parse(JSON.stringify(data)) });
	} else if (type === "clearInbox") {
		await browser.storage.local.remove(INBOX_KEY);
	}
});

// Keep several open calculator tabs in sync and pick up control panel exports.
browser.storage.onChanged.addListener((changes, area) => {
	if (area !== "local") return;
	if (changes[STORAGE_KEY]) toPage("data", changes[STORAGE_KEY].newValue || null);
	if (changes[INBOX_KEY]) toPage("inbox", changes[INBOX_KEY].newValue || null);
});
