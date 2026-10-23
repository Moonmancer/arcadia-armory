// Content script for the control panel's character list
// (https://cp.arcadia-online.org/masteraccount/characters/). A button copies the
// characters as "Name<TAB>Class<TAB>Base level" lines for the Discord party bot
// (/char import). Characters with the same name on several game accounts get
// the account appended, so the bot can tell them apart.
"use strict";

(function () {
	const LIMIT = 4000; // the bot's import form takes at most 4000 characters

	const headsOf = (t) => [...t.querySelectorAll("thead th, tr:first-child th")].map((th) => th.textContent.replace(/\s+/g, " ").trim().toLowerCase());
	const table = [...document.querySelectorAll("table")].find((t) => {
		const heads = headsOf(t);
		return heads.includes("name") && heads.includes("job class") && heads.some((h) => h.startsWith("base/job"));
	});
	if (!table) return;

	const clean = (s) => s.replace(/\s+/g, " ").trim();

	function readCharacters() {
		const heads = headsOf(table);
		const col = {
			name: heads.indexOf("name"),
			account: heads.indexOf("game account"),
			cls: heads.indexOf("job class"),
			level: heads.findIndex((h) => h.startsWith("base/job")),
		};
		const chars = [];
		for (const tr of table.querySelectorAll("tr")) {
			const td = tr.querySelectorAll("td");
			if (td.length <= Math.max(col.name, col.cls, col.level)) continue;
			// Only trimmed: spaces inside a name count ("Moonlight  Souls" is another character).
			const name = td[col.name].textContent.replace(/\((?:online|offline)\)/i, "").replace(/^\s+|\s+$/g, "");
			const cls = clean(td[col.cls].textContent.replace(/\[(?:male|female)\]/i, ""));
			const level = /(\d{1,3})\s*\/\s*\d{1,3}/.exec(td[col.level].textContent);
			if (!name || !cls || !level) continue;
			chars.push({ name, account: col.account >= 0 ? clean(td[col.account].textContent) : "", cls, level: Number(level[1]) });
		}
		const count = {};
		for (const c of chars) count[c.name] = (count[c.name] || 0) + 1;
		return chars.map((c) => `${count[c.name] > 1 && c.account ? `${c.name} (${c.account})` : c.name}\t${c.cls}\t${c.level}`);
	}

	// Lines in parts of at most LIMIT characters (whole lines only).
	function chunks(lines) {
		const parts = [];
		let cur = [];
		let len = 0;
		for (const line of lines) {
			if (cur.length && len + line.length + 1 > LIMIT) {
				parts.push(cur);
				cur = [];
				len = 0;
			}
			cur.push(line);
			len += line.length + 1;
		}
		if (cur.length) parts.push(cur);
		return parts;
	}

	async function copy(text) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch (e) {
			// Fallback for browsers without the async clipboard in content scripts.
			const ta = document.createElement("textarea");
			ta.value = text;
			ta.style.position = "fixed";
			ta.style.opacity = "0";
			document.body.append(ta);
			ta.select();
			const ok = document.execCommand("copy");
			ta.remove();
			return ok;
		}
	}

	const bar = document.createElement("div");
	bar.className = "aa-cp-bar";
	const button = document.createElement("button");
	button.type = "button";
	button.className = "aa-cp-btn";
	button.textContent = "⚔ Für Discord kopieren (/char import)";
	button.title = "Kopiert Name, Klasse und Base-Level aller Charaktere – eine Zeile pro Charakter";
	const parts = document.createElement("span");
	const status = document.createElement("span");
	status.className = "aa-cp-status";
	bar.append(button, parts, status);
	table.before(bar);

	const say = (text) => (status.textContent = text);

	button.addEventListener("click", async () => {
		const lines = readCharacters();
		parts.replaceChildren();
		if (!lines.length) return say("Keine Charaktere in der Tabelle gefunden.");
		const text = lines.join("\n");
		const ok = await copy(text);
		if (!ok) return say("Kopieren hat nicht geklappt – bitte erneut versuchen.");
		if (text.length <= LIMIT) return say(`${lines.length} Charaktere kopiert (${text.length} Zeichen) – in /char import einfügen.`);
		// Too long for the bot's form: offer the list in parts as well.
		const split = chunks(lines);
		say(`${lines.length} Charaktere kopiert (${text.length} Zeichen) – zu lang für das Formular (max. ${LIMIT}): als .txt bei /char import datei: anhängen oder in Teilen kopieren:`);
		split.forEach((p, i) => {
			const b = document.createElement("button");
			b.type = "button";
			b.className = "aa-cp-btn aa-cp-part";
			b.textContent = `Teil ${i + 1} (${p.length})`;
			b.addEventListener("click", async () => {
				const ok2 = await copy(p.join("\n"));
				say(ok2 ? `Teil ${i + 1} von ${split.length} kopiert (${p.length} Charaktere).` : "Kopieren hat nicht geklappt.");
			});
			parts.append(b);
		});
	});
})();
