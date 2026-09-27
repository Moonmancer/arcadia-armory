// Content script for the control panel's master account item list
// (https://cp.arcadia-online.org/masteraccount/items/). Reads the item table on
// a button click and hands it to the calculator via browser.storage.local.
// Which rows are equipment is decided on the calculator page, because only
// there the calculator's item database is available.
"use strict";

(function () {
	const INBOX_KEY = "armoryInbox";

	const table = [...document.querySelectorAll("table")].find((t) => {
		const heads = [...t.querySelectorAll("thead th")].map((th) => th.textContent.trim().toLowerCase());
		return heads.includes("name") && heads.includes("cards") && heads.includes("location");
	});
	if (!table) return;

	const clean = (s) => s.replace(/\s+/g, " ").trim();

	function columnIndex() {
		const heads = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim().toLowerCase());
		return {
			id: heads.indexOf("id"),
			name: heads.indexOf("name"),
			amount: heads.indexOf("amount"),
			attributes: heads.indexOf("attributes"),
			cards: heads.indexOf("cards"),
			location: heads.indexOf("location"),
		};
	}

	function readRows() {
		const col = columnIndex();
		const entries = [];
		let skippedStacks = 0;
		for (const tr of table.querySelectorAll("tbody tr")) {
			const td = tr.children;
			if (td.length <= Math.max(col.name, col.location)) continue;
			const amount = Number(clean(td[col.amount]?.textContent || "1")) || 1;
			// Equipment never stacks; anything with an amount > 1 is a consumable, card or loot.
			if (amount > 1) {
				skippedStacks++;
				continue;
			}
			const cardCell = td[col.cards];
			const cards = cardCell ? [...cardCell.querySelectorAll("ul.cardlist li")].map((li) => clean(li.textContent)).filter(Boolean) : [];
			const flags = td[col.attributes]
				? [...td[col.attributes].querySelectorAll(".visually-hidden")].map((e) => clean(e.textContent).replace(/^\[|\]$/g, "")).filter((f) => f && f.toLowerCase() !== "none")
				: [];
			entries.push({
				gameId: Number(clean(td[col.id]?.textContent || "")) || null,
				// e.g. "+5 Very Very Strong John Bastille's Fire Claymore" or "+10 Katana [4]"
				rawName: clean(td[col.name].textContent),
				amount,
				cards,
				flags,
				location: clean(td[col.location].textContent),
			});
		}
		return { entries, skippedStacks };
	}

	// --- UI ---------------------------------------------------------------------

	const bar = document.createElement("div");
	bar.className = "aa-cp-bar";
	const button = document.createElement("button");
	button.type = "button";
	button.className = "aa-cp-btn";
	button.textContent = "⚔ Ausrüstung an Arcadia Armory senden";
	const status = document.createElement("span");
	status.className = "aa-cp-status";
	bar.append(button, status);
	table.before(bar);

	button.addEventListener("click", async () => {
		button.disabled = true;
		status.textContent = "Lese Tabelle …";
		try {
			const { entries, skippedStacks } = readRows();
			await browser.storage.local.set({
				[INBOX_KEY]: { source: "Control Panel", at: Date.now(), entries },
			});
			status.textContent = `${entries.length} Einträge übertragen (${skippedStacks} gestapelte übersprungen). Öffne jetzt den Calculator – Ausrüstung wird dort erkannt und importiert.`;
		} catch (e) {
			status.textContent = "Fehler: " + (e && e.message ? e.message : e);
		} finally {
			button.disabled = false;
		}
	});
})();
