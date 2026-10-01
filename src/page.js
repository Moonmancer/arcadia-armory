// Runs in the calculator page's MAIN world so it can read the calculator's
// globals (m_Item, m_Card, w_DMG, calc, ...). Persistence goes through
// bridge.js via window.postMessage.
(function () {
	"use strict";

	if (window.__arcadiaArmory || typeof m_Item === "undefined" || !document.calcForm) {
		return;
	}
	window.__arcadiaArmory = true;

	const form = document.calcForm;

	// ---------------------------------------------------------------------------
	// Slot definitions (calculator item type -> equipment select)
	// ---------------------------------------------------------------------------

	const SLOTS = [
		{ key: "A_weapon1", label: "Weapon", short: "Weapon", refine: "A_Weapon_refine", cards: ["A_weapon1_card1", "A_weapon1_card2", "A_weapon1_card3", "A_weapon1_card4"] },
		{ key: "A_weapon2", label: "Left Hand", short: "Left", refine: "A_Weapon2_refine", cards: ["A_weapon2_card1", "A_weapon2_card2", "A_weapon2_card3", "A_weapon2_card4"] },
		{ key: "A_head1", label: "Upper Headgear", short: "Upper", refine: "A_HEAD_REFINE", cards: ["A_head1_card"] },
		{ key: "A_head2", label: "Middle Headgear", short: "Middle", refine: null, cards: ["A_head2_card"] },
		{ key: "A_head3", label: "Lower Headgear", short: "Lower", refine: null, cards: [] },
		{ key: "A_body", label: "Armor", short: "Armor", refine: "A_BODY_REFINE", cards: ["A_body_card"] },
		{ key: "A_left", label: "Shield", short: "Shield", refine: "A_LEFT_REFINE", cards: ["A_left_card"] },
		{ key: "A_shoulder", label: "Garment", short: "Garment", refine: "A_SHOULDER_REFINE", cards: ["A_shoulder_card"] },
		{ key: "A_shoes", label: "Footgear", short: "Footgear", refine: "A_SHOES_REFINE", cards: ["A_shoes_card"] },
		{ key: "A_acces1", label: "Accessory 1", short: "Acc 1", refine: null, cards: ["A_acces1_card"] },
		{ key: "A_acces2", label: "Accessory 2", short: "Acc 2", refine: null, cards: ["A_acces2_card"] },
	];
	const SLOT_BY_KEY = Object.fromEntries(SLOTS.map((s) => [s.key, s]));

	function typeLabel(type) {
		if (type >= 1 && type <= 21) return "Weapon";
		return { 50: "Upper Headgear", 51: "Middle Headgear", 52: "Lower Headgear", 60: "Armor", 61: "Shield", 62: "Garment", 63: "Footgear", 64: "Accessory" }[type] || "?";
	}

	function isEquipType(type) {
		return (type >= 1 && type <= 21) || (type >= 50 && type <= 52) || (type >= 60 && type <= 64);
	}

	function el(name) {
		return form.elements.namedItem(name);
	}

	function hasOption(select, value) {
		const v = String(value);
		for (const o of select.options) {
			if (o.value === v) return true;
		}
		return false;
	}

	// ---------------------------------------------------------------------------
	// Name matching against the calculator's item / card database
	// ---------------------------------------------------------------------------

	function norm(s) {
		return String(s)
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/\[[^\]]*\]/g, " ")
			.replace(/['’`´]/g, "")
			.replace(/[^a-z0-9]+/g, " ")
			.trim();
	}

	// Possessives are ignored in a second index: "Gentleman's Staff" vs. calculator "Gentleman Staff".
	const looseNorm = (s) => norm(String(s).replace(/['’]s\b/gi, ""));

	const itemIndex = new Map(); // normalized name -> [calc item ids]
	const itemIndexLoose = new Map();
	const addTo = (index, key, id) => {
		if (!key) return;
		if (!index.has(key)) index.set(key, []);
		index.get(key).push(id);
	};
	for (const it of m_Item) {
		const name = String(it[8] || "");
		if (!isEquipType(it[1]) || name.startsWith("(")) continue;
		for (const alias of name.split(" / ")) {
			addTo(itemIndex, norm(alias), it[0]);
			addTo(itemIndexLoose, looseNorm(alias), it[0]);
		}
	}

	// Longest first, so the most specific prefix wins.
	const itemNamesByLength = [...itemIndex.keys()].filter((n) => n.length >= 4).sort((a, b) => b.length - a.length);

	// Card names without the " card" suffix. The calculator also models forged
	// weapons through the card slots ("* Element Stone (Fire)", "* Star Crumb").
	const cardIndex = new Map(); // normalized card name -> [calc card ids]
	if (typeof m_Card !== "undefined") {
		for (const cd of m_Card) {
			const name = String(cd[2] || "").replace(/^\*\s*/, "");
			if (!cd[0] || name.startsWith("(") || /^(unused|\d+)$/i.test(name)) continue;
			const n = norm(name).replace(/ card$/, "");
			if (!cardIndex.has(n)) cardIndex.set(n, []);
			cardIndex.get(n).push(cd[0]);
		}
	}

	const FORGE_STONE = { fire: "element stone fire", ice: "element stone water", wind: "element stone wind", earth: "element stone earth" };

	function isWeaponId(id) {
		return m_Item[id] && m_Item[id][1] >= 1 && m_Item[id][1] <= 21;
	}

	// Resolves an item name (refine already stripped) to a calculator item.
	// Returns { calcId, cards } where cards are extra slot contents implied by
	// the name (forged weapons), or null for non-equipment.
	// Game item IDs whose name alone is ambiguous in the calculator. Referenced by
	// calculator name + slot count so the mapping survives calculator updates.
	const GAME_ID_OVERRIDES = {
		1617: { name: "Survivor's Rod (DEX)", slots: 0 },
		1618: { name: "Survivor's Rod (DEX)", slots: 1 },
		1619: { name: "Survivor's Rod (INT)", slots: 0 },
		1620: { name: "Survivor's Rod (INT)", slots: 1 },
		5171: { name: "Valkyrian Helm", slots: 1 }, // "Valkyrie Helm [1]" in game
		5053: { name: "Sphinx Helm", slots: 0 }, // "Sphinx Hat" in game
		5166: { name: "Sphinx Helm", slots: 1 },
		5494: { name: "Sphinx Helm", slots: 0 },
	};

	// Slot counts a calculator entry stands for: "0/1" -> [0, 1], 3 -> [3].
	function calcSlotVariants(id) {
		const v = m_Item[id] && m_Item[id][5];
		if (typeof v === "string") return v.split("/").map((x) => Number(x) || 0);
		return [Number(v) || 0];
	}

	// Calculator slot count; for weapons stored like "3/4" (base/max) -> max.
	function calcSlots(id) {
		const v = m_Item[id] && m_Item[id][5];
		if (typeof v === "string") return Number(v.split("/").pop()) || 0;
		return Number(v) || 0;
	}

	function byGameId(gameId) {
		const o = GAME_ID_OVERRIDES[gameId];
		if (!o) return null;
		// Prefer the entry with that slot count; the calculator often merges variants ("[0/1]").
		const it = m_Item.find((i) => i[8] === o.name && calcSlots(i[0]) === o.slots) || m_Item.find((i) => i[8] === o.name);
		return it ? it[0] : null;
	}

	// Several calculator items can share a name (e.g. with and without slot):
	// prefer the one whose slot count matches "[n]" in the listed name.
	function pick(ids, text) {
		if (ids.length === 1) return ids[0];
		const m = String(text).match(/\[(\d)\]/);
		const slots = m ? Number(m[1]) : 0;
		return ids.find((id) => calcSlots(id) === slots) ?? ids[0];
	}

	function matchItem(text, gameId) {
		const forced = gameId != null ? byGameId(gameId) : null;
		if (forced != null) return { calcId: forced, cards: [] };
		const raw = text.replace(/\([^)]*\)/g, " ").trim();
		const n = norm(raw);
		if (!n || / card$/.test(n) || / costume$/.test(n)) return null;
		if (itemIndex.has(n)) return { calcId: pick(itemIndex.get(n), text), cards: [] };
		const loose = looseNorm(raw);
		if (itemIndexLoose.has(loose)) return { calcId: pick(itemIndexLoose.get(loose), text), cards: [] };

		// Forged weapon: "[Very ]Very Strong [Maker's] [Fire|Ice|Wind|Earth] <Weapon>"
		const forge = raw.replace(/\s*\[[^\]]*\]/g, "").match(/^((?:very\s+)*)(strong\s+)?(?:(.+?)['’]s\s+)?(?:(fire|ice|wind|earth)\s+)?(.+)$/i);
		if (forge && (forge[2] || forge[4])) {
			const base = norm(forge[5]);
			const id = itemIndex.has(base) ? pick(itemIndex.get(base), text) : null;
			if (id != null && isWeaponId(id)) {
				const cards = [];
				if (forge[4]) cards.push(FORGE_STONE[forge[4].toLowerCase()]);
				const crumbs = forge[2] ? Math.min(3, (forge[1].match(/very/gi) || []).length) : 0;
				for (let i = 0; i < crumbs; i++) cards.push("star crumb");
				return { calcId: id, cards };
			}
		}

		// Calculator names are sometimes shortened ("Fuuma Calm Mind" for
		// "Fuuma Calm Mind Shuriken"). Only trust a prefix match when the line is
		// clearly equipment (has card slots), otherwise "Dead Branch", "Wolf Claw"
		// etc. would turn into weapons.
		if (/\[\d\]/.test(text)) {
			for (const name of itemNamesByLength) {
				if (n.startsWith(name + " ")) return { calcId: pick(itemIndex.get(name), text), cards: [] };
			}
		}
		return null;
	}

	function matchCard(text) {
		const n = norm(text).replace(/ card$/, "");
		return cardIndex.has(n) ? n : null;
	}

	// ---------------------------------------------------------------------------
	// Parsing the pasted list
	// ---------------------------------------------------------------------------
	//
	// Expected (control panel item search):
	//   <id>\t<+refine> <name> [slots]\t<amount>\t[options]\t<cards|None>\t<location>
	// where cards may also follow on their own lines and the location on the
	// last line of the entry. Plain lines with just an item name also work.

	const ENTRY_START = /^\s*(\d+)\s*\t\s*([^\t]+?)\s*\t\s*(\d+)\s*(?:\t(.*))?$/;

	// ---------------------------------------------------------------------------
	// Pre-trans WoE blacklist (src/woe-blacklist.js)
	// ---------------------------------------------------------------------------
	//
	// The list names game items ("Zweihander [2] (1171)"). Own copies are checked
	// by their game id; calculator items by name (+ slot count where the calculator
	// has separate entries per slot count).

	const WOE_LIST = (window.__AA_WOE_BLACKLIST && window.__AA_WOE_BLACKLIST.items) || [];
	const WOE_AS_OF = (window.__AA_WOE_BLACKLIST && window.__AA_WOE_BLACKLIST.asOf) || "?";
	const woeGameIds = new Set(WOE_LIST.map((r) => r[2]));
	const woeCalcIds = new Set();
	const woeCardIds = new Set();
	// Slot counts listed per calculator item: the calculator often merges variants
	// ("Hat of the Sun God [0/1]") of which only one may be forbidden.
	const woeSlotsByCalcId = new Map();
	const markWoe = (id, slots) => {
		if (!woeSlotsByCalcId.has(id)) woeSlotsByCalcId.set(id, new Set());
		woeSlotsByCalcId.get(id).add(slots);
	};
	for (const [name, slots, gameId] of WOE_LIST) {
		if (/ card$/i.test(name)) {
			(cardIndex.get(norm(name).replace(/ card$/, "")) || []).forEach((id) => woeCardIds.add(id));
			continue;
		}
		const forced = byGameId(gameId);
		if (forced != null) {
			markWoe(forced, slots);
			continue;
		}
		const ids = itemIndex.get(norm(name)) || itemIndexLoose.get(looseNorm(name)) || [];
		const exact = ids.filter((id) => calcSlotVariants(id).includes(slots));
		(exact.length ? exact : ids).forEach((id) => markWoe(id, slots));
	}
	// A calculator item counts as forbidden only if all of its slot variants are.
	for (const [id, listed] of woeSlotsByCalcId) {
		if (calcSlotVariants(id).every((n) => listed.has(n))) woeCalcIds.add(id);
	}

	function woeBlockedInstance(inst) {
		return inst.gameId != null ? woeGameIds.has(Number(inst.gameId)) : woeCalcIds.has(inst.calcId);
	}

	// Own copies that may be used under the current WoE setting.
	function usableInstances(calcId) {
		const insts = ownedById.get(calcId) || [];
		return state.settings.woe ? insts.filter((i) => !woeBlockedInstance(i)) : insts;
	}

	// Hide a calculator item? Not if an own, allowed copy of it exists (the
	// calculator often merges slot variants of which only one is forbidden).
	function woeHidesItem(calcId) {
		if (!state.settings.woe || !woeCalcIds.has(calcId)) return false;
		return !(ownedById.get(calcId) || []).some((i) => !woeBlockedInstance(i));
	}

	// Text -> raw entries { gameId, rawName, amount, cards: [card texts], location, flags }
	function parseText(text) {
		const lines = String(text).replace(/\r/g, "").split("\n");
		const entries = [];
		let cur = null;

		const finish = () => {
			if (cur) entries.push(cur);
			cur = null;
		};

		const absorb = (chunk) => {
			for (const raw of chunk.split("\t")) {
				const t = raw.trim();
				if (!t || /^\[?none\]?$/i.test(t)) continue;
				if (matchCard(t) || /card$/i.test(t)) cur.cards.push(t);
				else cur.location = t;
			}
		};

		for (const line of lines) {
			const m = line.match(ENTRY_START);
			if (m) {
				finish();
				cur = { gameId: Number(m[1]), rawName: m[2], amount: Number(m[3]) || 1, cards: [], location: "", flags: [] };
				if (m[4]) absorb(m[4]);
			} else if (cur) {
				if (line.trim()) absorb(line);
			} else if (line.trim()) {
				// Plain line without the table layout, e.g. "+7 Blade [3]" or "2x Blade"
				const qty = line.match(/^\s*(\d+)\s*[x×]\s+/i) || line.match(/\s[x×]\s*(\d+)\s*$/i);
				const name = line.replace(/^\s*\d+\s*[x×]\s+/i, "").replace(/\s[x×]\s*\d+\s*$/i, "").trim();
				entries.push({ gameId: null, rawName: name, amount: qty ? Number(qty[1]) : 1, cards: [], location: "", flags: [] });
			}
		}
		finish();
		return entries;
	}

	// Raw entries (from pasted text or the control panel) -> owned equipment.
	function resolveEntries(entries) {
		const items = [];
		const unmatched = [];
		for (const e of entries) {
			const rawName = String(e.rawName || "").trim();
			const refineM = rawName.match(/^\+\s*(\d{1,2})\s+/);
			const match = matchItem(refineM ? rawName.slice(refineM[0].length) : rawName, e.gameId);
			if (!match) {
				if (rawName && !matchCard(rawName)) unmatched.push(rawName);
				continue;
			}
			const cards = [];
			const unknownCards = [];
			for (const c of e.cards || []) {
				const n = matchCard(c);
				if (n) cards.push(n);
				else unknownCards.push(String(c));
			}
			items.push({
				calcId: match.calcId,
				gameId: e.gameId ?? null,
				name: m_Item[match.calcId][8],
				rawName,
				refine: refineM ? Math.min(20, Number(refineM[1])) : 0,
				cards: [...match.cards, ...cards],
				unknownCards,
				location: String(e.location || ""),
				flags: Array.isArray(e.flags) ? e.flags.map(String) : [],
				count: Number(e.amount) || 1,
			});
		}
		return { items: dedupe(items), unmatched: [...new Set(unmatched)] };
	}

	function parseList(text) {
		return resolveEntries(parseText(text));
	}

	function instanceKey(it) {
		return [it.calcId, it.refine, it.cards.slice().sort().join(","), it.location, (it.flags || []).join(",")].join("|");
	}

	function dedupe(items) {
		const map = new Map();
		for (const it of items) {
			const k = instanceKey(it);
			if (map.has(k)) map.get(k).count += it.count;
			else map.set(k, { ...it, uid: Math.random().toString(36).slice(2, 10) });
		}
		return [...map.values()];
	}

	// ---------------------------------------------------------------------------
	// State & persistence
	// ---------------------------------------------------------------------------

	const DEFAULT_SETTINGS = {
		onlyOwned: false, // hide non-owned items in the equipment selects
		preview: "all", // "all" | "owned" | "off": damage preview in the dropdowns
		metric: "dps", // "dps" | "hit" | "def" (damage received, lower is better) | "ehp" (hits survived) | "craft" (success rate)
		combo: true, // replace the equipment selects with a search field
		comboSort: "name", // "name" | "dmg" | "cat" (category, then name): order of the search field's list
		theme: "armory", // calculator theme select: "armory" (add-on grayscale theme) | "system" | "dark" | "light"
		lastAmmo: {}, // last chosen ammo per ammo kind ("arrow" | "bullet" | "grenade") -> A_Arrow value
		woe: false, // hide items disabled in pre-trans WoE (woe-blacklist.js)
		compareBuilds: [], // build ids in the "Build-Vergleich" section below the combat simulator
		party: [], // "Party-Battle" members: { uid, build, skill, start, gospel: { stats, atk } } (skill null = the build's own; start = attacks from this % of the monster's HP, default 100)
		partyEnsembles: [], // ENSEMBLES keys switched on in the Party-Battle
		partyBuffs: [], // PARTY_BUFFS keys switched on in the Party-Battle
		partyMonsterAtk: null, // B_AtkSkill value for the Party-Battle (null = as in the calculator)
		partyEqPlayers: null, // "Players in Range" for Earth Quake in the Party-Battle (null = party size)
		hideUnavailable: false, // hide calculator items / cards marked "[Unavailable]" (own copies stay)
		applyInstance: true, // apply refine + cards of an owned item on selection
		collapsed: [], // collapsed panel categories ("items:Weapon", "compare:A_weapon1", ...)
	};

	const state = {
		items: [],
		unmatched: [],
		builds: [], // saved characters: { id, name, job, code, savedAt }
		snapshots: [], // snapshots of the current character used in the build comparison / Party-Battle: { id, name, job, code, savedAt, snapshot: true }
		settings: { ...DEFAULT_SETTINGS },
	};
	let ownedById = new Map(); // calcId -> [instances]

	function rebuildOwned() {
		ownedById = new Map();
		for (const it of state.items) {
			if (!ownedById.has(it.calcId)) ownedById.set(it.calcId, []);
			ownedById.get(it.calcId).push(it);
		}
	}

	// Every save comes back as a storage change (that is how other open
	// calculator tabs stay in sync). Our own echo is ignored: after quick changes
	// it carries an older state and would undo the later ones.
	const TAB_ID = Math.random().toString(36).slice(2, 10);

	function save() {
		const data = { version: 1, writer: TAB_ID, items: state.items, unmatched: state.unmatched, builds: state.builds, snapshots: state.snapshots, settings: state.settings };
		window.postMessage({ aa: "toBridge", type: "save", data }, window.location.origin);
	}

	window.addEventListener("message", (event) => {
		if (event.source !== window || !event.data || event.data.aa !== "toPage") return;
		if (event.data.type === "inbox") {
			const inbox = event.data.data;
			ui.inbox = inbox && Array.isArray(inbox.entries) ? inbox : null;
			if (ui.inbox) panel.classList.add("aa-open");
			renderPanel();
			return;
		}
		if (event.data.type !== "data") return;
		const d = event.data.data || {};
		if (d.writer === TAB_ID) return; // echo of our own save
		state.items = Array.isArray(d.items) ? d.items : [];
		state.unmatched = Array.isArray(d.unmatched) ? d.unmatched : [];
		state.builds = Array.isArray(d.builds) ? d.builds : [];
		state.snapshots = Array.isArray(d.snapshots) ? d.snapshots : [];
		state.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
		applyTheme(state.settings.theme);
		rebuildOwned();
		invalidate();
		refreshSelects();
		renderPanel();
	});

	// ---------------------------------------------------------------------------
	// Damage simulation using the calculator's own engine
	// ---------------------------------------------------------------------------

	const origCalc = window.calc;
	const origStAllCalc = window.StAllCalc;
	let simulating = false;
	let applying = false; // set while the panel equips an exact instance
	let calcVersion = 0;

	function invalidate() {
		calcVersion++;
		scheduleComboSync();
	}

	window.calc = function () {
		if (!simulating) enforceTwoHand();
		const r = origCalc.apply(this, arguments);
		if (!simulating) {
			invalidate();
			rememberAmmo();
		}
		return r;
	};
	window.StAllCalc = function () {
		if (!simulating) enforceTwoHand();
		const r = origStAllCalc.apply(this, arguments);
		if (!simulating) invalidate();
		return r;
	};

	let metricOverride = null; // "dps" | "hit" | "def" while the optimizer runs

	function currentMetric() {
		return metricOverride || state.settings.metric;
	}

	// Value to maximize for the current metric. "def" uses the calculator's
	// "Average Dmg Received (w/dodge)" of the combat simulator, negated so that
	// higher is better everywhere (sorting, optimizer, colors).
	function measure() {
		if (currentMetric() === "craft") return craftInfo().rate;
		if (currentMetric() === "def") return -damageReceived();
		if (currentMetric() === "ehp") {
			// Effective HP: average hits of the chosen monster attack until K.O. With
			// no damage taken at all, Max HP alone still ranks the items.
			const hp = Number(String((document.getElementById("A_MaxHP") || {}).textContent || "").replace(/[^\d.]/g, "")) || 0;
			return hp / Math.max(damageReceived(), 1e-3);
		}
		const { hit, interval } = attackNow();
		if (currentMetric() === "hit" || !(interval > 0)) return hit;
		return hit / interval;
	}

	// Damage and time of one attack after the last calculation (w_DMG[1], cast +
	// delay). For a skill combo (see SKILL_COMBOS) the whole sequence: the
	// calculator computed its first skill, the others are calculated here too.
	function attackNow() {
		const single = () => ({
			hit: Number(typeof w_DMG !== "undefined" && w_DMG[1]) || 0,
			interval: (Number(typeof wCast !== "undefined" && wCast) || 0) + (Number(typeof wDelay !== "undefined" && wDelay) || 0),
		});
		const combo = activeCombo();
		if (!combo || comboRunning) return single();
		const first = single();
		const sel = form.A_ActiveSkill;
		const lvSel = form.A_ActiveSkillLV;
		const index = sel.selectedIndex;
		const lv = lvSel ? lvSel.value : null;
		const parts = [first];
		comboRunning = true;
		try {
			for (const id of combo.then) {
				if (!hasOption(sel, id)) continue;
				sel.value = String(id);
				if (typeof ClickActiveSkill === "function") quietly(() => ClickActiveSkill());
				origCalc();
				parts.push(single());
			}
		} finally {
			sel.selectedIndex = index;
			if (typeof ClickActiveSkill === "function") quietly(() => ClickActiveSkill());
			if (lvSel && lv != null && hasOption(lvSel, lv)) lvSel.value = lv;
			origCalc();
			comboRunning = false;
		}
		return { hit: parts.reduce((sum, p) => sum + p.hit, 0), interval: parts.reduce((sum, p) => sum + p.interval, 0), parts };
	}

	// "Average Dmg Received (w/dodge)" of the combat simulator: DEF / MDEF,
	// race / element / size reductions, Flee, Perfect Dodge, Parrying ...
	function damageReceived() {
		const cell = document.getElementById("B_Ave2Atk");
		return Number(String(cell ? cell.textContent : "").replace(/[^\d.]/g, "")) || 0;
	}

	// ---------------------------------------------------------------------------
	// Skill combos: sequences the game forces, as one entry in the skill list
	// ---------------------------------------------------------------------------
	//
	// Beast Strafing can only follow a Double Strafe, so Hunter / Sniper get
	// "Double Strafe → Beast Strafing". The entry carries Double Strafe's value
	// (the calculator reads the list as a number and shows that skill); damage
	// and time of the whole sequence are summed by attackNow().
	const SKILL_COMBOS = [{ key: "dsbs", name: "Double Strafe → Beast Strafing", first: 40, then: [391], jobs: ["HUNTER", "SNIPER"] }];
	const COMBO_PREFIX = "combo:";
	let comboRunning = false;

	function activeCombo() {
		const sel = form.A_ActiveSkill;
		const o = sel && sel.selectedOptions[0];
		return o && o.dataset.aaCombo ? SKILL_COMBOS.find((c) => c.key === o.dataset.aaCombo) || null : null;
	}

	function updateSkillCombos() {
		const sel = form.A_ActiveSkill;
		if (!sel) return;
		const J = typeof JOBID !== "undefined" ? JOBID : {};
		for (const c of SKILL_COMBOS) {
			const fits = c.jobs.some((j) => J[j] === n_A_JOB) && hasOption(sel, c.first) && c.then.every((id) => hasOption(sel, id));
			const opt = [...sel.options].find((o) => o.dataset.aaCombo === c.key);
			if (!fits) {
				if (opt) {
					const was = opt.selected;
					opt.remove();
					if (was) sel.value = String(c.first);
				}
				continue;
			}
			if (opt) continue;
			const first = [...sel.options].find((o) => o.value === String(c.first) && !o.dataset.aaCombo);
			const o = new Option(c.name, String(c.first));
			o.dataset.aaCombo = c.key;
			first.after(o);
		}
		updateComboInfo();
	}

	// Line next to the skill list: damage and time of the sequence.
	const comboInfo = h("div", { class: "aa-comboinfo" });
	function updateComboInfo() {
		const sel = form.A_ActiveSkill;
		const combo = activeCombo();
		if (!combo || !sel) {
			comboInfo.remove();
			return;
		}
		const anchor = form.A_ActiveSkillLV || sel;
		if (anchor.nextElementSibling !== comboInfo) anchor.after(comboInfo);
		simulating = true;
		let a;
		try {
			origCalc();
			a = attackNow();
		} finally {
			simulating = false;
		}
		const names = [combo.first, ...combo.then].map((id) => ([...sel.options].find((o) => o.value === String(id) && !o.dataset.aaCombo) || { text: id }).text.trim());
		comboInfo.textContent =
			names.map((n, i) => `${n} ${(a.parts[i] || { hit: 0 }).hit.toFixed(0)}`).join(" + ") +
			` = ${a.hit.toFixed(0)} Schaden in ${a.interval.toFixed(2)} s → ${(a.interval > 0 ? a.hit / a.interval : a.hit).toFixed(1)} DPS`;
		comboInfo.title = "Das Ergebnis des Combat Simulators zeigt nur den ersten Skill; Vorschau, Optimierer und Vergleiche rechnen mit der ganzen Folge.";
	}

	function metricUnit(metric) {
		if (metric === "craft") return "% Erfolg (" + craftInfo().name + ")";
		return { dps: "Schaden/Sek.", hit: "Schaden/Treffer", def: "erlittener Schaden", ehp: "Treffer bis K.O." }[metric] || "";
	}

	// ---------------------------------------------------------------------------
	// Crafting success (metric "craft")
	// ---------------------------------------------------------------------------
	//
	// The calculator's formulas from "Other Info" (Forge/Potion/EDP Creation
	// Success Rate, Cooking Success Rates), fed with the final stats of the last
	// calc() run. Equipment only acts through DEX, LUK, INT and levels, so the
	// rate is kept unclamped (no 0 % / 100 % cut) to still rank items. What is
	// crafted follows "Other Info": Cooking there means cooking, otherwise the
	// class decides (Blacksmith: forging, Alchemist: potions, Assassin Cross:
	// Poison Bottle for EDP, everyone else: cooking). Inputs of the "Other Info"
	// box (skill levels, anvil, potion, ...) are used when it shows them.
	function craftInfo() {
		const num = (name) => Number((el(name) || {}).value) || 0;
		const dexLuk = n_A_DEX + n_A_LUK;
		const adopted = form.A_adopted && form.A_adopted.checked;
		const J = typeof JOBID !== "undefined" ? JOBID : {};
		const other = num("A_Kakutyou");
		if (other !== 30) {
			if (n_A_JOB === J.BLACKSMITH || n_A_JOB === J.WHITESMITH) {
				const anvil = typeof m_Anvil !== "undefined" && m_Anvil[num("A_KakutyouSelNum")];
				const rate = 50 + 5 * num("A_SmithT") + num("A_WepR") + (el("A_KakutyouSelNum") && anvil ? anvil[1] : 0) + 0.2 * n_A_JobLV + 0.1 * dexLuk - 15 * num("A_StarC") - 20 * num("A_ElemS");
				return { name: "Forging", rate: adopted ? 0.7 * rate : rate };
			}
			if (n_A_JOB === J.ALCHEMIST || n_A_JOB === J.CREATOR) {
				const potion = typeof m_Potion !== "undefined" && el("A_KakutyouSelNum") && m_Potion[num("A_KakutyouSelNum")];
				const rate = (100 * num("A_PotionRLevel") + 300 * num("A_PreparePLevel") + 20 * n_A_JobLV + 10 * dexLuk + 5 * n_A_INT + 100 * (potion ? potion[1] : 0) + 100 * num("A_Van")) / 100;
				return { name: "Potion", rate: adopted ? 0.7 * rate : rate };
			}
			if (n_A_JOB === J.ASSASSIN_CROSS) return { name: "EDP (Poison Bottle)", rate: (200 + 4 * n_A_DEX + 2 * n_A_LUK) / 10 };
		}
		// Cooking, average case of the calculator (kit, food level and stat as chosen there).
		const lv = num("Flv");
		const stat = num("FStat");
		let items = 1;
		if (lv === 1 && stat === 4) items = 2;
		if ((lv === 1 && stat !== 4) || (lv === 2 && stat === 4) || (lv === 3 && stat === 4)) items = 3;
		if ((lv === 2 && stat !== 4) || (lv === 3 && [2, 3, 6].includes(stat)) || (lv === 6 && stat === 2)) items = 4;
		if ((lv === 3 && (stat === 1 || stat === 5)) || (lv === 4 && (stat !== 1 || stat !== 5)) || (lv === 5 && stat !== 5) || (lv === 6 && (stat !== 2 || stat !== 5)) || (lv === 7 && stat === 4)) items = 5;
		if ((lv === 4 && (stat === 4 || stat === 5)) || (lv === 5 && stat === 5) || (lv === 6 && stat === 5) || (lv === 7 && stat !== 4) || (lv === 8 && stat !== 5)) items = 6;
		if ((lv === 8 && stat === 5) || lv === 9) items = 7;
		if (lv === 10) items = 8;
		const power = 1200 * (num("CKit") + 1) + 20 * (n_A_BaseLV + 1) + 20 * n_A_DEX - 400 * lv - 10 * (100 - (n_A_LUK + 1)) - 500 * (items - 1);
		return { name: "Cooking", rate: (power + 100 * (6 + Math.min(num("CExp"), 2e3) / 80 + 12) * (adopted ? 0.7 : 1)) / 100 };
	}

	// Measured value as shown to the user (damage received is stored negated).
	function metricShow(value, metric) {
		return metric === "def" ? -value : value;
	}

	// ---------------------------------------------------------------------------
	// Headgears occupying several head slots (src/headgear-slots.js)
	// ---------------------------------------------------------------------------
	//
	// The calculator files every headgear under one slot only. Masks use the
	// game's bits: upper 256, middle 512, lower 1.

	const HEAD_KEYS = { A_head1: 256, A_head2: 512, A_head3: 1 };
	const HEAD_TYPE_MASK = { 50: 256, 51: 512, 52: 1 };
	const headMaskByGameId = new Map();
	const headMaskByCalcId = new Map();
	for (const [name, slots, gameId, mask] of window.__AA_HEADGEAR_SLOTS || []) {
		headMaskByGameId.set(gameId, mask);
		const forced = byGameId(gameId);
		const ids = forced != null ? [forced] : itemIndex.get(norm(name)) || itemIndexLoose.get(looseNorm(name)) || [];
		const exact = ids.filter((id) => calcSlots(id) === slots);
		(exact.length ? exact : ids).forEach((id) => headMaskByCalcId.set(id, mask));
	}

	// Head slots an item occupies (0 for "(no ... headgear)" and non-headgear).
	function headMask(calcId, inst) {
		const item = m_Item[calcId];
		if (!item || !HEAD_TYPE_MASK[item[1]] || String(item[8]).startsWith("(")) return 0;
		if (inst && inst.gameId != null && headMaskByGameId.has(Number(inst.gameId))) return headMaskByGameId.get(Number(inst.gameId));
		return headMaskByCalcId.get(calcId) || HEAD_TYPE_MASK[item[1]];
	}

	function noneValue(select) {
		const opt = [...select.options].find((o) => isNoneOption(o));
		return opt ? opt.value : null;
	}

	// Other head slots that must be emptied when an item with this mask goes into
	// slotKey: the slots it covers, and slots whose item overlaps it.
	function headConflicts(slotKey, mask) {
		const v = {};
		if (!(slotKey in HEAD_KEYS) || !mask) return v;
		for (const key of Object.keys(HEAD_KEYS)) {
			if (key === slotKey) continue;
			const sel = el(key);
			if (!sel) continue;
			const worn = Number(sel.value);
			if (mask & HEAD_KEYS[key] || headMask(worn) & mask) {
				const none = noneValue(sel);
				if (none != null && sel.value !== none) v[key] = none;
			}
		}
		return v;
	}

	// A head slot covered by a multi-slot headgear worn in another slot shows that
	// headgear as a disabled "shadow" entry. Its value is the slot's "(no ...)"
	// item, so the calculator still counts the headgear only once.
	function updateHeadShadows() {
		for (const key of Object.keys(HEAD_KEYS)) {
			const sel = el(key);
			if (!sel || sel.tagName !== "SELECT") continue;
			let cover = null;
			for (const other of Object.keys(HEAD_KEYS)) {
				const o = other !== key && el(other);
				if (!o) continue;
				const id = Number(o.value);
				if (headMask(id) & HEAD_KEYS[key]) cover = String(m_Item[id][8]);
			}
			const shadow = sel.querySelector("option[data-aa-shadow]");
			const current = sel.options[sel.selectedIndex];
			const empty = !current || current === shadow || isNoneOption(current);
			if (cover && empty) {
				if (!shadow || shadow.dataset.aaOrig !== cover) {
					if (shadow) shadow.remove();
					const opt = new Option(cover, noneValue(sel));
					opt.dataset.aaShadow = "1";
					opt.dataset.aaOrig = cover;
					opt.disabled = true;
					sel.insertBefore(opt, sel.firstChild);
				}
				const sh = sel.querySelector("option[data-aa-shadow]");
				if (!sh.selected) sh.selected = true;
			} else if (shadow) {
				const wasSelected = shadow.selected;
				shadow.remove();
				if (wasSelected) sel.value = noneValue(sel);
			}
		}
	}

	// Values that a simulated variant sets on the form. Refine/card keys are
	// included even if their select doesn't exist yet (left hand before dual
	// wielding is enabled); simulate() skips values a select can't take.
	// Head slots covered by a multi-slot headgear are emptied as well.
	// ---------------------------------------------------------------------------
	// Two-handed weapons: no shield
	// ---------------------------------------------------------------------------
	//
	// The calculator has this rule (restrictEquipslot) but it is switched off on
	// Arcadia; here the last one put on wins, the other hand is emptied. Weapon types as there: two-handed sword / spear / axe, bow, katar,
	// Huuma shuriken, guns, plus staves with the "two-handed" effect (195).
	const TWO_HAND_TYPES = new Set([3, 5, 7, 10, 11, 16, 17, 18, 19, 20, 21]);

	function isTwoHanded(calcId) {
		const item = m_Item[calcId];
		if (!item || item[1] < 1 || item[1] > 21) return false;
		if (TWO_HAND_TYPES.has(item[1])) return true;
		for (let i = 11; i + 1 < item.length && item[i] !== 0; i += 2) if (item[i] === 195) return true;
		return false;
	}

	const twoHandedNow = () => Boolean(el("A_weapon1")) && isTwoHanded(Number(el("A_weapon1").value));

	// Shield slot emptied (item, refine, card) for a two-handed weapon.
	function shieldCleared() {
		const v = {};
		const shield = SLOT_BY_KEY.A_left;
		const sel = el(shield.key);
		const none = sel && noneValue(sel);
		if (none == null) return v;
		v[shield.key] = none;
		if (el(shield.refine)) v[shield.refine] = "0";
		for (const c of shield.cards) if (el(c)) v[c] = "0";
		return v;
	}

	// Weapon slot emptied (item, refine, cards) for a shield.
	function weaponCleared() {
		const v = {};
		const weapon = SLOT_BY_KEY.A_weapon1;
		if (!el(weapon.key)) return v;
		v[weapon.key] = "0";
		if (el(weapon.refine)) v[weapon.refine] = "0";
		for (const c of weapon.cards) if (el(c)) v[c] = "0";
		return v;
	}

	const shieldWorn = () => {
		const sel = el("A_left");
		return Boolean(sel) && sel.value !== noneValue(sel);
	};

	// Whatever was put on last wins: a two-handed weapon takes the shield off,
	// a shield takes the two-handed weapon off. Runs before the calculator's own
	// change handler, so it already calculates with the corrected equipment.
	form.addEventListener(
		"change",
		(e) => {
			const name = e.target.name;
			if (simulating || (name !== "A_weapon1" && name !== "A_left")) return;
			if (!twoHandedNow() || !shieldWorn()) return;
			const clear = name === "A_left" ? weaponCleared() : shieldCleared();
			for (const [k, value] of Object.entries(clear)) {
				const sel = el(k);
				if (!sel || sel.value === value) continue;
				sel.value = value;
				if (k === "A_weapon1") sel.dispatchEvent(new Event("change", { bubbles: true })); // weapon type, skills, ammo
			}
		},
		true
	);

	// Before each real calculation (e.g. a loaded build with both): keep the weapon.
	function enforceTwoHand() {
		if (!twoHandedNow() || !shieldWorn()) return;
		for (const [k, value] of Object.entries(shieldCleared())) if (el(k).value !== value) el(k).value = value;
	}

	function handConflicts(slot, calcId) {
		if (slot.key === "A_weapon1" && isTwoHanded(calcId)) return shieldCleared();
		if (slot.key === "A_left" && String(calcId) !== noneValue(el("A_left")) && twoHandedNow()) return weaponCleared();
		return {};
	}

	function variantFor(slot, calcId, inst) {
		const v = { ...headConflicts(slot.key, headMask(calcId, inst)), ...handConflicts(slot, calcId), [slot.key]: String(calcId) };
		if (inst) {
			if (slot.refine) v[slot.refine] = String(inst.refine);
			slot.cards.forEach((name, i) => {
				v[name] = String(resolveCard(el(name), inst.cards[i]));
			});
		}
		return v;
	}

	function resolveCard(select, cardName) {
		if (!cardName) return 0;
		const ids = cardIndex.get(cardName) || [];
		if (!select) return ids[0] || 0;
		for (const id of ids) {
			if (hasOption(select, id)) return id;
		}
		return 0;
	}

	// Calls calculator functions without their UI side effects (skill list
	// rebuild, item description box).
	function quietly(fn) {
		const saved = { ActiveSkillSetPlus: window.ActiveSkillSetPlus, ClickB_Item: window.ClickB_Item };
		window.ActiveSkillSetPlus = () => {};
		window.ClickB_Item = () => {};
		try {
			fn();
		} finally {
			Object.assign(window, saved);
		}
	}

	// The calculator only counts the left-hand weapon while dual wielding is
	// active (n_Nitou), and only then do its refine/card selects exist.
	function setDualWield(value) {
		const w2 = el("A_weapon2");
		if (!w2 || typeof ClickWeaponType2 !== "function") return;
		const on = String(value) !== "0";
		if (on === Boolean(n_Nitou)) return;
		quietly(() => {
			w2.value = String(value);
			ClickWeaponType2(on ? String(value) : 0);
		});
	}

	function setValue(select, value) {
		if (value !== undefined && hasOption(select, value)) select.value = String(value);
		else if (hasOption(select, "0")) select.value = "0";
	}

	// Evaluates each variant (a map select name -> value), restoring the form afterwards.
	function simulate(variants) {
		const touched = new Set();
		variants.forEach((v) => Object.keys(v).forEach((k) => touched.add(k)));
		const dual = touched.has("A_weapon2") && el("A_weapon2");
		if (dual) {
			// Toggling dual wield rebuilds these, so they must always be restored.
			const left = SLOT_BY_KEY.A_weapon2;
			[left.refine, ...left.cards].forEach((k) => touched.add(k));
		}
		const snapshot = {};
		touched.forEach((k) => {
			const s = el(k);
			if (s) snapshot[k] = s.value;
		});

		simulating = true;
		const results = [];
		try {
			for (const v of variants) {
				if (dual) setDualWield("A_weapon2" in v ? v.A_weapon2 : snapshot.A_weapon2);
				for (const k of touched) {
					const s = el(k);
					if (s) setValue(s, k in v ? v[k] : snapshot[k]);
				}
				try {
					origCalc();
					results.push(measure());
				} catch (e) {
					results.push(NaN);
				}
			}
		} finally {
			if (dual) setDualWield(snapshot.A_weapon2);
			for (const k of touched) {
				const s = el(k);
				if (s && k in snapshot) s.value = snapshot[k];
			}
			try {
				origCalc();
			} catch (e) {
				/* the calculator itself failed; nothing we can restore */
			}
			// Our own select rebuilds are not a reason to redecorate, but rebuilt
			// selects (left-hand cards) need their search field back.
			formObserver.takeRecords();
			simulating = false;
			scheduleComboSync();
		}
		return results;
	}

	function baseline() {
		simulating = true;
		try {
			origCalc();
			return measure();
		} finally {
			simulating = false;
		}
	}

	function formatDelta(value, base, metric = currentMetric()) {
		if (!Number.isFinite(value)) return "";
		if (metric === "craft") {
			// Success rate: change in percentage points.
			const d = value - base;
			if (Math.abs(d) < 0.005) return "±0";
			return (d > 0 ? "▲ +" : "▼ −") + Math.abs(d).toFixed(2) + " %P";
		}
		if (metric === "def") {
			// Change of the damage received; ▲ = less damage (better).
			const now = -base;
			const next = -value;
			if (now > 0) {
				const pct = ((next - now) / now) * 100;
				if (Math.abs(pct) < 0.05) return "±0%";
				return (pct < 0 ? "▲ −" : "▼ +") + Math.abs(pct).toFixed(1) + "%";
			}
			const d = next - now;
			if (Math.abs(d) < 0.005) return "±0";
			return (d < 0 ? "▲ −" : "▼ +") + Math.abs(d).toFixed(1);
		}
		if (base > 0) {
			const pct = ((value - base) / base) * 100;
			if (Math.abs(pct) < 0.05) return "±0%";
			return (pct > 0 ? "▲ +" : "▼ −") + Math.abs(pct).toFixed(1) + "%";
		}
		const d = value - base;
		if (Math.abs(d) < 0.005) return "±0";
		return (d > 0 ? "▲ +" : "▼ −") + Math.abs(d).toFixed(1);
	}

	function instanceSummary(inst) {
		const parts = [];
		if (inst.refine) parts.push("+" + inst.refine);
		const counts = {};
		inst.cards.forEach((c) => (counts[c] = (counts[c] || 0) + 1));
		for (const [c, n] of Object.entries(counts)) parts.push((n > 1 ? n + "× " : "") + titleCase(c));
		return parts.join(" · ");
	}

	function titleCase(s) {
		return s.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
	}

	// Best owned instance of calcId for a slot, evaluated with its refine + cards.
	function evaluateOwned(slot, calcId) {
		const insts = usableInstances(calcId);
		if (!insts.length) return null;
		const vals = simulate(insts.map((inst) => variantFor(slot, calcId, state.settings.applyInstance ? inst : null)));
		// Highest damage; on a tie (e.g. headgear refine doesn't affect damage) the
		// better copy: higher refine, then more cards.
		const better = (i, j) => vals[i] - vals[j] || insts[i].refine - insts[j].refine || insts[i].cards.length - insts[j].cards.length;
		let best = 0;
		vals.forEach((v, i) => {
			if (better(i, best) > 0) best = i;
		});
		return { inst: insts[best], value: vals[best] };
	}

	// ---------------------------------------------------------------------------
	// Equipment select decoration: ★ marker, filter, damage preview
	// ---------------------------------------------------------------------------

	function slotSelects() {
		return SLOTS.map((s) => ({ slot: s, select: el(s.key) })).filter((x) => x.select && x.select.tagName === "SELECT");
	}

	function isNoneOption(opt) {
		return opt.value === "0" || /^\(/.test(opt.dataset.aaOrig ?? opt.text);
	}

	function renderOption(opt) {
		if (!("aaOrig" in opt.dataset)) opt.dataset.aaOrig = opt.text;
		const owned = ownedById.has(Number(opt.value)) && !isNoneOption(opt);
		let text = (owned ? "★ " : "") + opt.dataset.aaOrig;
		if (opt.dataset.aaDelta) text += "   " + opt.dataset.aaDelta;
		if (opt.text !== text) opt.text = text;
	}

	function applyFilter(select) {
		const only = state.settings.onlyOwned && state.items.length > 0;
		for (const opt of select.options) {
			if (opt.dataset.aaShadow) continue;
			const id = Number(opt.value);
			const owned = usableInstances(id).length > 0;
			const unavailable = state.settings.hideUnavailable && !owned && /\[Unavailable\]/i.test(optionName(opt));
			const keep = isNoneOption(opt) || opt.selected || ((!only || owned) && !woeHidesItem(id) && !unavailable);
			opt.hidden = !keep;
			opt.disabled = !keep;
			renderOption(opt);
		}
		for (const g of select.querySelectorAll("optgroup")) {
			g.hidden = ![...g.children].some((o) => !o.hidden);
		}
	}

	// Card selects: only the WoE filter applies.
	function applyCardFilter(select) {
		for (const opt of select.options) {
			const woe = state.settings.woe && woeCardIds.has(Number(opt.value));
			const unavailable = state.settings.hideUnavailable && /\[Unavailable\]/i.test(opt.dataset.aaOrig ?? opt.text);
			const keep = opt.selected || (!woe && !unavailable);
			opt.hidden = !keep;
			opt.disabled = !keep;
		}
	}

	function refreshSelects() {
		addLeftCardSets();
		updateWoeHeaderToggle();
		updateHeadShadows();
		for (const { select } of slotSelects()) applyFilter(select);
		for (const name of SLOTS.flatMap((sl) => sl.cards)) {
			const sel = el(name);
			if (sel && sel.tagName === "SELECT") applyCardFilter(sel);
		}
		const shortcuts = el("A_cardshort");
		if (shortcuts) {
			for (const opt of shortcuts.options) {
				if (!opt.value.startsWith(SET_PREFIX)) continue;
				opt.hidden = opt.disabled = equipSetHidden(EQUIP_SETS[Number(opt.value.slice(SET_PREFIX.length))]);
			}
		}
		updateSwapButton();
		syncCombos();
	}

	function annotate(slot, select) {
		if (state.settings.preview === "off") {
			clearAnnotations(select);
			return;
		}
		if (Number(select.dataset.aaVer) === calcVersion) return;

		const base = baseline();
		const plain = [];
		const ownedOpts = [];
		for (const opt of select.options) {
			if (opt.hidden) continue;
			const id = Number(opt.value);
			if (ownedById.has(id) && !isNoneOption(opt)) ownedOpts.push(opt);
			else if (state.settings.preview === "all" || isNoneOption(opt)) plain.push(opt);
			else delete opt.dataset.aaDelta;
		}

		const plainVals = simulate(plain.map((o) => ({ [slot.key]: o.value })));
		plain.forEach((o, i) => {
			o.dataset.aaDelta = o.selected ? "" : formatDelta(plainVals[i], base);
			renderOption(o);
		});
		for (const o of ownedOpts) {
			const r = evaluateOwned(slot, Number(o.value));
			const summary = r && instanceSummary(r.inst);
			o.dataset.aaDelta = r ? formatDelta(r.value, base) + (summary ? `  (${summary})` : "") : "";
			renderOption(o);
		}
		select.dataset.aaVer = String(calcVersion);
	}

	function clearAnnotations(select) {
		for (const opt of select.options) {
			delete opt.dataset.aaDelta;
			renderOption(opt);
		}
		delete select.dataset.aaVer;
	}

	function slotOfTarget(target) {
		if (!target || target.tagName !== "SELECT" || target.form !== form) return null;
		return SLOT_BY_KEY[target.name] || null;
	}

	// Annotate right before the dropdown opens.
	const onOpen = (e) => {
		const slot = slotOfTarget(e.target);
		if (slot) annotate(slot, e.target);
	};
	document.addEventListener("mousedown", onOpen, true);
	document.addEventListener("focusin", onOpen, true);

	// ---------------------------------------------------------------------------
	// Keep the chosen ammo when switching weapons
	// ---------------------------------------------------------------------------
	//
	// ClickWeaponType() rebuilds the ammo select on every weapon change, which
	// resets it to the first entry. Remember the ammo per kind and put it back
	// when the new weapon uses the same kind.

	function ammoKind(weaponId) {
		const type = m_Item[weaponId] ? m_Item[weaponId][1] : 0;
		if (type === 10 || type === 14 || type === 15) return "arrow"; // bows, instruments, whips
		if (type >= 17 && type <= 20) return "bullet"; // guns
		if (type === 21) return "grenade";
		return null;
	}

	let weaponChanging = false;

	function rememberAmmo() {
		const w = el("A_weapon1");
		const arrow = el("A_Arrow");
		const kind = w && ammoKind(Number(w.value));
		if (weaponChanging || !kind || !arrow || arrow.disabled) return;
		if (state.settings.lastAmmo[kind] === arrow.value) return;
		state.settings.lastAmmo = { ...state.settings.lastAmmo, [kind]: arrow.value };
		save();
	}

	document.addEventListener(
		"change",
		(e) => {
			if (e.target.form !== form || e.target.name !== "A_weapon1" || simulating) return;
			// Runs before the calculator's own handler, which resets the ammo.
			weaponChanging = true;
			setTimeout(() => {
				weaponChanging = false;
				const arrow = el("A_Arrow");
				const kind = ammoKind(Number(el("A_weapon1").value));
				const want = kind && state.settings.lastAmmo[kind];
				if (arrow && want != null && arrow.value !== want && hasOption(arrow, want)) {
					arrow.value = want;
					arrow.dispatchEvent(new Event("change", { bubbles: true })); // runs calc()
				}
			}, 0);
		},
		true
	);

	// Selecting an owned item also applies its refine + cards.
	document.addEventListener(
		"change",
		(e) => {
			const slot = slotOfTarget(e.target);
			if (!slot || simulating || applying) return;
			const select = e.target;
			const id = Number(select.value);
			if (state.settings.applyInstance && ownedById.has(id)) {
				const r = evaluateOwned(slot, id);
				if (r) setTimeout(() => applyVariant(slot, variantFor(slot, id, r.inst), false), 0);
			}
			setTimeout(() => {
				const clear = headConflicts(slot.key, headMask(Number(select.value)));
				if (Object.keys(clear).length) applyVariant(slot, clear, false);
				applyFilter(select);
				updateSwapButton();
				select.blur();
			}, 0);
		},
		true
	);

	// Sets values like a user would, firing the calculator's own handlers.
	// Other slots in the variant (head slots emptied by a multi-slot headgear) too.
	function applyVariant(slot, variant, includeItem) {
		// Other slots first (emptied head slots, shield or weapon of the other hand):
		// item before its refine and cards.
		const own = [slot.key, slot.refine, ...slot.cards].filter(Boolean);
		const others = Object.keys(variant).filter((k) => !own.includes(k));
		others.sort((a, b) => Boolean(SLOT_BY_KEY[b]) - Boolean(SLOT_BY_KEY[a]));
		const order = [...others, ...own];
		for (const k of order) {
			if (!(k in variant) || (k === slot.key && !includeItem)) continue;
			const s = el(k);
			if (!s || !hasOption(s, variant[k])) continue;
			if (s.value !== variant[k] || k === slot.key) {
				s.value = variant[k];
				s.dispatchEvent(new Event("change", { bubbles: true }));
			}
		}
		// Card selects only run StAllCalc(); refresh the battle results (combat
		// simulator, damage) as well so the page shows what was just equipped.
		if (!simulating) window.calc();
		refreshSelects();
	}

	// ---------------------------------------------------------------------------
	// Dual wield: swap right- and left-hand weapon (incl. refine + cards)
	// ---------------------------------------------------------------------------

	function handState(slot) {
		const v = {};
		for (const k of [slot.key, slot.refine, ...slot.cards]) {
			const s = el(k);
			v[k] = s ? s.value : "0";
		}
		return v;
	}

	// Why the current right-hand weapon can't go to the left hand, or "".
	function swapBlocker() {
		const right = el("A_weapon1");
		const left = el("A_weapon2");
		if (!right || !left) return "Kein Dual Wield";
		if (right.value === "0" && left.value === "0") return "Keine Waffen angelegt";
		if (!hasOption(left, right.value)) return "Die rechte Waffe kann nicht in die linke Hand";
		return "";
	}

	// Values of one hand moved to the other hand's selects.
	const toVariant = (from, to, values) => Object.fromEntries([from.key, from.refine, ...from.cards].map((k, i) => [[to.key, to.refine, ...to.cards][i], values[k]]));

	function swapHands() {
		if (swapBlocker()) return;
		const R = SLOT_BY_KEY.A_weapon1;
		const L = SLOT_BY_KEY.A_weapon2;
		const right = handState(R);
		const left = handState(L);

		applying = true;
		try {
			applyVariant(R, toVariant(L, R, left), true);
			applyVariant(L, toVariant(R, L, right), true);
		} finally {
			applying = false;
		}
		invalidate();
		refreshSelects();
	}

	const swapBtn = h("button", { type: "button", class: "aa-swap", title: "Waffen links/rechts tauschen (inkl. Verfeinerung und Karten)", onclick: swapHands }, "⇄");
	const swapDelta = h("span", { class: "aa-swapdelta" });
	let swapDeltaVersion = null;

	// Damage change if both hands were swapped, simulated with the calculator.
	function updateSwapDelta(blocker) {
		if (blocker || state.settings.preview === "off") {
			swapDelta.textContent = "";
			swapDeltaVersion = null;
			return;
		}
		if (swapDeltaVersion === calcVersion) return;
		swapDeltaVersion = calcVersion;
		const R = SLOT_BY_KEY.A_weapon1;
		const L = SLOT_BY_KEY.A_weapon2;
		const variant = { ...toVariant(L, R, handState(L)), ...toVariant(R, L, handState(R)) };
		const base = baseline();
		const [value] = simulate([variant]);
		const metric = state.settings.metric;
		const unit = metricUnit(metric);
		swapDelta.textContent = formatDelta(value, base);
		swapDelta.className = "aa-swapdelta " + (value > base ? "aa-up" : value < base ? "aa-down" : "");
		swapDelta.title = Number.isFinite(value) ? `Nach dem Tausch: ${metricShow(value, metric).toFixed(2)} ${unit} (jetzt ${metricShow(base, metric).toFixed(2)})` : "";
	}

	function updateSwapButton() {
		const left = el("A_weapon2");
		if (!left || left.tagName !== "SELECT") {
			swapBtn.remove();
			swapDelta.remove();
			return;
		}
		// Next to the "Left Hand:" label; the select's column is too narrow.
		const label = document.getElementById("A_SobWeaponName");
		if (label && label.textContent.trim()) {
			if (swapBtn.parentNode !== label) label.append(swapBtn);
		} else if (swapBtn.previousElementSibling !== left) {
			left.after(swapBtn);
		}
		const blocker = swapBlocker();
		swapBtn.disabled = Boolean(blocker);
		swapBtn.title = blocker || "Waffen links/rechts tauschen (inkl. Verfeinerung und Karten)";
		if (swapDelta.previousSibling !== swapBtn) swapBtn.after(swapDelta);
		updateSwapDelta(blocker);
	}

	// The calculator rebuilds its selects (job change, dual wield, ...): re-decorate.
	let refreshQueued = false;
	const formObserver = new MutationObserver((records) => {
		if (simulating || refreshQueued) return;
		// Only select rebuilds count: added / removed selects, options or optgroups.
		// Result texts the calculator rewrites after every calc() (HP, ATK, ...) and
		// the add-on's own elements are ignored.
		const ours = (n) => n.nodeType === 1 && (n.matches(".aa-combo, .aa-swap, .aa-swapdelta, .aa-woe-toggle, .aa-statgain, .aa-stat, .aa-bv, .aa-comboinfo, .aa-armoryrow, option[data-aa-shadow], option[data-aa-combo]") || n.closest(".aa-combo, .aa-swapdelta, .aa-woe-toggle, .aa-statgain, .aa-stat, .aa-bv, .aa-comboinfo, .aa-armoryrow"));
		const selectish = (n) => n.nodeType === 1 && !ours(n) && (n.matches("select, option, optgroup") || Boolean(n.querySelector("select")));
		const relevant = (r) => r.target.tagName !== "OPTION" && !ours(r.target) && [...r.addedNodes, ...r.removedNodes].some(selectish);
		if (!records.some(relevant)) return;
		refreshQueued = true;
		setTimeout(() => {
			refreshQueued = false;
			invalidate();
			refreshSelects();
		}, 0);
	});
	formObserver.observe(form, { childList: true, subtree: true });

	// ---------------------------------------------------------------------------
	// Search field ("combo") replacing the equipment selects
	// ---------------------------------------------------------------------------
	//
	// The original select stays in the form (hidden): the calculator keeps reading
	// it, saves/URL loading keep working, and picking a row simply sets its value
	// and fires its change handler.

	const combos = new Map(); // select name -> { slot, select, input, wrap, width, badge }

	// Card selects of every slot, searchable like the slots but only with the
	// calculator's own card list (no owned items).
	const CARD_FIELDS = SLOTS.flatMap((slot) =>
		slot.cards.map((name, i) => ({
			key: name,
			label: slot.cards.length > 1 ? `${slot.label} Card ${i + 1}` : `${slot.label} Card`,
			short: slot.cards.length > 1 ? `Card ${i + 1}` : "Card",
			card: true,
			refine: null,
			cards: [],
		}))
	);

	// "(card shortcuts)": an action select whose calculator function fills several
	// card selects at once (depending on the monster for some entries).
	const SHORTCUT_FIELDS = [
		{ key: "A_cardshort", label: "Weapon Card Shortcuts", short: "Shortcut", shortcut: "Setm_CardShort", refine: null, cards: [] },
		{ key: "A_cardshortLeft", label: "Left Hand Card Shortcuts", short: "Shortcut", shortcut: "Setm_CardShortLeft", refine: null, cards: [] },
	];

	// The enemy select in the side bar; its list is (re)built by the calculator's
	// place/sort filters above it.
	// listOnly: searchable list without damage preview / sorting (choosing one
	// changes the whole character or target, so a delta would say nothing).
	const MONSTER_FIELD = { key: "B_Enemy", label: "Monster", short: "", monster: true, listOnly: true, refine: null, cards: [] };
	const JOB_FIELD = { key: "A_JOB", label: "Class", short: "", listOnly: true, refine: null, cards: [] };
	// Other names of classes (e.g. from other servers) and common shorthands,
	// searchable in the class field and the build search.
	const JOB_ALIASES = {
		"Super Novice": ["SN"],
		"Star Gladiator": ["TKM"],
		"Lord Knight": ["LK"],
		Blacksmith: ["BS"],
		Whitesmith: ["Mastersmith", "WS"],
		"High Priest": ["HP"],
		"High Wizard": ["HW"],
		"Assassin Cross": ["Sinx"],
		Scholar: ["Professor"],
		Minstrel: ["Clown"],
		Biochemist: ["Creator"],
	};
	// Created by the calculator only once "Additional Effects" is opened. Pets are
	// never owned items, so every row gets its damage change (few entries).
	const PET_FIELD = { key: "A8_Skill0", label: "Pet", short: "", noOwned: true, refine: null, cards: [] };

	const stripTags = (html) => String(html || "").replace(/<[^>]*>/g, "").trim();

	// The calculator's own color class of a race / element entry ("RaceDemihuman", "eleWind").
	const classOf = (html) => (String(html || "").match(/class='([^' ]+)/) || [])[1] || "";

	// "Lv 71 · Demi-Human · Wind 2 · Medium · 11,170 HP · Boss" as parts; race and
	// element carry the calculator's color classes.
	function monsterInfo(index) {
		const m = typeof m_Monster !== "undefined" && m_Monster[index];
		if (!m) return [];
		const eleIdx = Math.floor(m[3] / 10);
		const parts = [
			{ text: m[5] != null ? `Lv ${m[5]}` : "" },
			typeof v_Race !== "undefined" ? { text: stripTags(v_Race[m[2]]), cls: classOf(v_Race[m[2]]) } : { text: "" },
			typeof v_Element_ !== "undefined" ? { text: `${String(v_Element_[eleIdx] || "").trim()} ${m[3] % 10}`, cls: typeof v_Element !== "undefined" ? classOf(v_Element[eleIdx]) : "" } : { text: "" },
			{ text: typeof v_Size !== "undefined" ? v_Size[m[4]] : "" },
			{ text: Number(m[6]) ? Number(m[6]).toLocaleString("en-US") + " HP" : "" },
			{ text: m[19] === 1 ? "Boss" : "" },
		];
		return parts.filter((p) => p.text);
	}

	function renderSub(sub) {
		if (!Array.isArray(sub)) return sub;
		return sub.flatMap((p, i) => [i ? " · " : "", p.cls ? h("span", { class: p.cls }, p.text) : p.text]);
	}

	function comboSelects() {
		const extra = [...CARD_FIELDS, ...SHORTCUT_FIELDS, MONSTER_FIELD, JOB_FIELD, PET_FIELD].map((d) => ({ slot: d, select: el(d.key) })).filter((x) => x.select && x.select.tagName === "SELECT");
		return [...slotSelects(), ...extra];
	}

	// ---------------------------------------------------------------------------
	// Equipment sets in the card shortcut list
	// ---------------------------------------------------------------------------
	//
	// Setm_CardShort() only sets cards, so these entries (value "aa-set-<n>") are
	// handled by the add-on: it equips each part in its slot, using the best own
	// copy (refine + cards) where there is one. The set bonus is applied by the
	// calculator once all parts are worn.

	const EQUIP_SETS = [
		{ name: "Goibne's Set", items: ["Goibne's Helm", "Goibne's Armor", "Goibne's Spaulders", "Goibne's Greaves"] },
		{ name: "Morrigane's Set", items: ["Morrigane's Helm", "Morrigane's Manteau", "Morrigane's Belt", "Morrigane's Pendant"] },
		{ name: "Valkyrian Set", items: ["Valkyrian Helm", "Valkyrian Armor", "Valkyrian Manteau", "Valkyrian Shoes"] },
		{ name: "Morpheus's Set", items: ["Morpheus's Hood", "Morpheus's Shawl", "Morpheus's Ring", "Morpheus's Bracelet"] },
		{ name: "Odin's Blessing + Magni's Cap + Stone Buckler", items: ["Odin's Blessing", "Magni's Cap", "Stone Buckler"] },
		{ name: "Odin's Blessing + Falcon Muffler + Fricco's Shoes", items: ["Odin's Blessing", "Falcon Muffler", "Fricco's Shoes"] },
		{ name: "Odin's Blessing + Vali's Manteau + Vidar's Boots", items: ["Odin's Blessing", "Vali's Manteau", "Vidar's Boots"] },
		{ name: "Odin's Blessing + Frigg's Circlet + Valkyrja's Shield", items: ["Odin's Blessing", "Frigg's Circlet", "Valkyrja's Shield"] },
		{ name: "Odin's Blessing + Ulle's Cap", items: ["Odin's Blessing", "Ulle's Cap"] },
		{ name: "Diabolus Robe + Diabolus Ring", items: ["Diabolus Robe [Unavailable]", "Diabolus Ring [Unavailable]"] },
		{ name: "Diabolus Armor + Diabolus Ring", items: ["Diabolus Armor [Unavailable]", "Diabolus Ring [Unavailable]"] },
		{ name: "Diabolus Manteau + Diabolus Boots", items: ["Diabolus Manteau [Unavailable]", "Diabolus Boots [Unavailable]"] },
	];
	const SET_PREFIX = "aa-set-";
	const SLOT_FOR_TYPE = { 50: ["A_head1"], 51: ["A_head2"], 52: ["A_head3"], 60: ["A_body"], 61: ["A_left"], 62: ["A_shoulder"], 63: ["A_shoes"], 64: ["A_acces1", "A_acces2"] };

	// [{ slot, variant }] for every part the current class can wear.
	function setParts(set) {
		const used = new Set();
		const parts = [];
		for (const itemName of set.items) {
			const item = m_Item.find((i) => i[8] === itemName);
			if (!item || woeHidesItem(item[0])) continue; // forbidden in pre-trans WoE (when that filter is on)
			const keys = item[1] >= 1 && item[1] <= 21 ? ["A_weapon1", "A_weapon2"] : SLOT_FOR_TYPE[item[1]] || [];
			const key = keys.find((k) => !used.has(k) && el(k) && hasOption(el(k), item[0]));
			if (!key) continue;
			used.add(key);
			const slot = SLOT_BY_KEY[key];
			const best = state.settings.applyInstance ? evaluateOwned(slot, item[0]) : null;
			parts.push({ slot, variant: variantFor(slot, item[0], best && best.inst) });
		}
		return parts;
	}

	// A set entry is pointless when the WoE filter removes all of its parts.
	// ... or when "Hide unavailable" is on and a part is [Unavailable] (and not owned).
	function equipSetHidden(set) {
		const items = set.items.map((n) => m_Item.find((i) => i[8] === n));
		if (state.settings.woe && items.every((item) => !item || woeHidesItem(item[0]))) return true;
		return state.settings.hideUnavailable && items.some((item) => item && /\[Unavailable\]/i.test(item[8]) && !ownedById.has(item[0]));
	}

	function applyEquipSet(index) {
		const set = EQUIP_SETS[index];
		if (!set) return;
		applying = true; // exactly these copies
		try {
			for (const { slot, variant } of setParts(set)) applyVariant(slot, variant, true);
		} finally {
			applying = false;
		}
		invalidate();
		refreshSelects();
	}

	// Extra card shortcuts in the calculator's own format ([name, card1..card4]),
	// so Setm_CardShort / Setm_CardShortLeft apply them like the built-in ones.
	const CARD_SETS = [
		["Lizzy Set [Lizzi + Lizzie + Lizzy]", ["Lizzi", "Lizzie", "Lizzy"]], // slots 1-3, slot 4 is kept
	];
	const CARD_SET_ROWS = new Set(); // their indexes in m_CardShort

	// The left hand list is rebuilt from the first 50 shortcuts whenever dual
	// wield turns on, so the extra sets are appended again each time.
	function addLeftCardSets() {
		const left = el("A_cardshortLeft");
		if (!left) return;
		for (const i of CARD_SET_ROWS) if (!hasOption(left, i)) left.add(new Option(m_CardShort[i][0], i));
	}

	(function addCardSets() {
		if (typeof m_CardShort === "undefined") return;
		const select = el("A_cardshort");
		for (const [name, cards] of CARD_SETS) {
			const ids = cards.map((c) => (m_Card.find((x) => x[2] === c) || [])[0]);
			if (ids.some((id) => id == null)) continue;
			m_CardShort.push([name, ...ids, ...Array(4 - ids.length).fill(0)]);
			CARD_SET_ROWS.add(m_CardShort.length - 1);
			if (select) select.add(new Option(name, m_CardShort.length - 1));
		}
		addLeftCardSets();
		// The calculator writes all four slots; for these sets keep the cards in
		// the slots the set leaves free.
		for (const [fn, field, weapon] of [
			["Setm_CardShort", "A_cardshort", "A_weapon1"],
			["Setm_CardShortLeft", "A_cardshortLeft", "A_weapon2"],
		]) {
			const orig = window[fn];
			if (typeof orig !== "function") continue;
			window[fn] = function (...args) {
				const row = Number((el(field) || {}).value);
				const keep = CARD_SET_ROWS.has(row)
					? [1, 2, 3, 4].filter((n) => !m_CardShort[row][n] && el(`${weapon}_card${n}`)).map((n) => [el(`${weapon}_card${n}`), el(`${weapon}_card${n}`).value])
					: [];
				const r = orig.apply(this, args);
				for (const [sel, value] of keep) sel.value = value;
				return r;
			};
		}
	})();

	(function addEquipSets() {
		const select = el("A_cardshort");
		if (!select) return;
		EQUIP_SETS.forEach((set, i) => select.add(new Option(set.name, SET_PREFIX + i), 1 + i));
	})();

	// Picking a set entry must not reach the calculator's handler (it expects a number).
	document.addEventListener(
		"change",
		(e) => {
			const t = e.target;
			if (t.form !== form || t.name !== "A_cardshort" || !String(t.value).startsWith(SET_PREFIX)) return;
			e.stopImmediatePropagation();
			const index = Number(t.value.slice(SET_PREFIX.length));
			t.value = "0";
			applyEquipSet(index);
		},
		true
	);

	// Damage values for shortcut rows: card shortcuts via the calculator's function,
	// equipment sets by simulating all their parts at once.
	function shortcutValues(field, rows) {
		const out = new Array(rows.length);
		const sets = [];
		const cards = [];
		rows.forEach((r, i) => (String(r.value).startsWith(SET_PREFIX) ? sets : cards).push(i));
		const cv = simulateShortcut(field, cards.map((i) => rows[i].value));
		cards.forEach((i, k) => (out[i] = cv[k]));
		const variants = sets.map((i) => Object.assign({}, ...setParts(EQUIP_SETS[Number(String(rows[i].value).slice(SET_PREFIX.length))]).map((p) => p.variant)));
		const sv = simulate(variants);
		sets.forEach((i, k) => (out[i] = sv[k]));
		return out;
	}

	// Damage for each shortcut value, running the calculator's own shortcut function.
	function simulateShortcut(field, values) {
		const apply = window[field.shortcut];
		const keys = [field.key, ...CARD_FIELDS.map((d) => d.key)].filter((k) => el(k));
		const snapshot = Object.fromEntries(keys.map((k) => [k, el(k).value]));
		const restore = () => keys.forEach((k) => (el(k).value = snapshot[k]));
		const results = [];
		simulating = true;
		try {
			for (const v of values) {
				restore();
				el(field.key).value = v;
				try {
					if (typeof apply === "function") quietly(apply);
					origCalc();
					results.push(measure());
				} catch (e) {
					results.push(NaN);
				}
			}
		} finally {
			restore();
			try {
				origCalc();
			} catch (e) {
				/* nothing we can restore */
			}
			formObserver.takeRecords();
			simulating = false;
		}
		return results;
	}
	const comboCache = new WeakMap(); // select -> { key, rows }
	let comboOpen = null; // combo + { rows, shown, active } while the list is open

	const dropdown = h("div", { class: "aa-cdrop", role: "listbox" });
	dropdown.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the input
	document.body.append(dropdown);

	let comboSyncQueued = false;
	function scheduleComboSync() {
		if (comboSyncQueued) return;
		comboSyncQueued = true;
		setTimeout(() => {
			comboSyncQueued = false;
			if (simulating) return;
			updateHeadShadows();
			syncCombos();
			updateSwapButton();
			updateSkillCombos();
			updateStatSteppers();
			updateStatGains();
			renderBuildCompare();
		}, 0);
	}

	// Like norm(), but keeps text in brackets ("[4 Race Card]", "[1]") searchable.
	function searchNorm(s) {
		return String(s)
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/['’`´]/g, "")
			.replace(/[^a-z0-9]+/g, " ")
			.trim();
	}

	function optionName(opt) {
		return opt.dataset.aaOrig ?? opt.text;
	}

	// Text shown in the field for the current selection.
	function currentLabel(slot, select) {
		const opt = select.options[select.selectedIndex];
		if (!opt) return "";
		const none = isNoneOption(opt);
		const refineSel = slot.refine && el(slot.refine);
		const refine = refineSel && !none ? Number(refineSel.value) : 0;
		// Only equipment slots can hold owned items; other fields' values are unrelated ids.
		if (opt.dataset.aaShadow) return optionName(opt); // covered by a multi-slot headgear
		const owned = Boolean(SLOT_BY_KEY[slot.key]) && ownedById.has(Number(opt.value)) && !none;
		return (owned ? "★ " : "") + (refine ? `+${refine} ` : "") + optionName(opt);
	}

	function syncCombos() {
		const enabled = state.settings.combo;
		for (const { slot, select } of comboSelects()) {
			let c = combos.get(slot.key);
			if (c && (c.select !== select || !c.wrap.isConnected)) {
				c.wrap.remove();
				combos.delete(slot.key);
				c = null;
			}
			if (!enabled) {
				select.classList.remove("aa-hidden-select");
				continue;
			}
			if (!c) c = createCombo(slot, select);
			const selOpt = select.options[select.selectedIndex];
			c.wrap.classList.toggle("aa-shadowed", Boolean(selOpt && selOpt.dataset.aaShadow));
			// Mirror what the calculator does to the (hidden) select.
			c.wrap.style.display = select.style.display === "none" ? "none" : "";
			c.input.disabled = select.disabled;
			const editing = document.activeElement === c.input || (comboOpen && comboOpen.input === c.input);
			if (!editing) c.input.value = currentLabel(slot, select);
			// The calculator sizes its selects in px or % of the cell; % must go on the wrapper.
			const w = select.style.width && select.style.width !== "auto" ? select.style.width : c.width;
			c.wrap.style.width = w.endsWith("%") ? w : "";
			c.input.style.width = w.endsWith("%") ? "100%" : w;
			// Leave room for the slot badge inside the field (0 while the section is hidden).
			// "important" so it beats panel.css, which must override the calculator's field rules.
			if (!c.badge) c.input.style.setProperty("padding-left", "6px", "important");
			else if (c.badge.offsetWidth) c.input.style.setProperty("padding-left", c.badge.offsetWidth + 8 + "px", "important");
			c.input.title = `${slot.label}: ${c.input.value}`;
		}
		if (!enabled) {
			combos.forEach((c) => c.wrap.remove());
			combos.clear();
			closeCombo();
		}
		alignRightColumn();
		alignCardColumn();
	}

	// The armor card selects are auto-sized to their longest card name, so the
	// column came out ragged; give their search fields one common width.
	function alignCardColumn() {
		const fields = CARD_FIELDS.filter((d) => !d.key.startsWith("A_weapon")).map((d) => combos.get(d.key)).filter((c) => c && !c.wrap.style.width);
		const width = Math.max(0, ...fields.map((c) => parseFloat(c.width) || 0));
		if (width) fields.forEach((c) => (c.input.style.width = width + "px"));
	}

	// Rows without a refine select (middle/lower headgear, accessories) are indented
	// by a fixed 49px in the calculator, which is only roughly the width of "+ [0]".
	// Align their fields exactly with the rows that have a refine select.
	const UNREFINED = ["A_head2", "A_head3", "A_acces1", "A_acces2"];
	function alignRightColumn() {
		const ref = combos.get("A_body") || combos.get("A_head1");
		const refX = ref && ref.wrap.offsetParent ? ref.wrap.getBoundingClientRect().left : null;
		for (const key of UNREFINED) {
			const sel = el(key);
			const td = sel && sel.closest("td");
			if (!td) continue;
			if (!("aaPad" in td.dataset)) td.dataset.aaPad = td.style.paddingLeft;
			const c = combos.get(key);
			if (refX == null || !c || !c.wrap.offsetParent) {
				td.style.paddingLeft = td.dataset.aaPad; // back to the calculator's own indent
				continue;
			}
			const delta = refX - c.wrap.getBoundingClientRect().left;
			if (Math.abs(delta) > 0.5) td.style.paddingLeft = parseFloat(getComputedStyle(td).paddingLeft) + delta + "px";
		}
	}

	function createCombo(slot, select) {
		const width = Math.max(140, Math.round(select.getBoundingClientRect().width)) + "px";
		const input = h("input", { type: "text", class: "aa-cinput", spellcheck: "false", autocomplete: "off", role: "combobox", "aria-expanded": "false", title: slot.label });
		const badge = slot.short ? h("span", { class: "aa-cslot" }, slot.short) : null;
		const wrap = h("span", { class: "aa-combo" }, badge, input, h("span", { class: "aa-ccaret" }, "▾"));
		select.after(wrap);
		select.classList.add("aa-hidden-select");
		const c = { slot, select, input, wrap, width, badge };
		combos.set(slot.key, c);

		input.addEventListener("focus", () => {
			if (comboOpen && comboOpen.input === input) return; // focus came back from the list header
			input.select();
			openCombo(c, "");
		});
		input.addEventListener("mousedown", () => {
			if (document.activeElement === input && !comboOpen) openCombo(c, "");
		});
		input.addEventListener("input", () => {
			if (!comboOpen) openCombo(c, input.value);
			else filterCombo(input.value);
		});
		input.addEventListener("keydown", (e) => {
			if (!comboOpen) {
				if (e.key === "ArrowDown" || e.key === "Enter") {
					openCombo(c, "");
					e.preventDefault();
				}
				return;
			}
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				moveActive(e.key === "ArrowDown" ? 1 : -1);
				e.preventDefault();
			} else if (e.key === "Enter") {
				const row = comboOpen.shown[comboOpen.active];
				if (row) pickRow(comboOpen, row);
				e.preventDefault();
			} else if (e.key === "Escape") {
				closeCombo();
				input.value = currentLabel(slot, select);
				input.blur();
				e.preventDefault();
			}
		});
		input.addEventListener("blur", (e) => {
			// Clicking a label in the list header moves focus to its checkbox: stay open.
			if (e.relatedTarget && dropdown.contains(e.relatedTarget)) {
				setTimeout(() => input.focus({ preventScroll: true }), 0);
				return;
			}
			closeCombo();
			input.value = currentLabel(slot, select);
		});
		return c;
	}

	// All choices of a slot with their damage value, cached per calculator state.
	function comboRows(slot, select) {
		const s = state.settings;
		const key = [calcVersion, select.options.length, s.preview, s.metric, s.applyInstance, s.onlyOwned, s.woe, s.hideUnavailable, state.items.length].join("|");
		const cached = comboCache.get(select);
		if (cached && cached.key === key) return cached.rows;

		const rows = [];
		// Entries hidden by a filter (WoE, unavailable, own only) as { search, n }:
		// n = rows they would produce (one per own copy), to show how many matches
		// the filters remove.
		rows.hiddenSearch = [];
		const isSlot = Boolean(SLOT_BY_KEY[slot.key]);
		for (const opt of select.options) {
			if (opt.dataset.aaShadow) continue;
			const g = opt.parentElement && opt.parentElement.tagName === "OPTGROUP" ? opt.parentElement.label : "";
			const copies = isSlot && s.applyInstance && !isNoneOption(opt) ? (ownedById.get(Number(opt.value)) || []).length : 0;
			if (opt.hidden && !opt.selected) {
				rows.hiddenSearch.push({ search: " " + searchNorm(optionName(opt) + " " + g), n: copies || 1 });
				continue;
			}
			// Visible item, but some own copies are forbidden in pre-trans WoE.
			// (With no usable copy left the item still shows as one plain row.)
			const blocked = copies ? copies - (usableInstances(Number(opt.value)).length || 1) : 0;
			if (blocked > 0) rows.hiddenSearch.push({ search: " " + searchNorm(optionName(opt) + " " + g), n: blocked });
			const id = Number(opt.value);
			const name = optionName(opt);
			const group = opt.parentElement && opt.parentElement.tagName === "OPTGROUP" ? opt.parentElement.label : "";
			if (isNoneOption(opt)) {
				rows.push({ kind: "none", value: opt.value, name, group: "", sub: "", owned: false });
				continue;
			}
			const insts = SLOT_BY_KEY[slot.key] ? usableInstances(id) : null;
			if (slot.monster) {
				const info = monsterInfo(id);
				rows.push({ kind: "plain", value: opt.value, id, name, group, owned: false, sub: info, subText: info.map((p) => p.text).join(" ") });
			} else if (insts && insts.length && s.applyInstance) {
				// One row per owned copy, evaluated with its own refine + cards.
				for (const inst of insts) {
					const sub = [instanceSummary({ ...inst, refine: 0 }) || "keine Karten", inst.location].filter(Boolean).join(" · ") + (inst.count > 1 ? ` · ×${inst.count}` : "");
					rows.push({ kind: "inst", value: opt.value, id, inst, name: (inst.refine ? `+${inst.refine} ` : "") + name, group, owned: true, sub });
				}
			} else {
				rows.push({ kind: "plain", value: opt.value, id, name, group, owned: Boolean(insts && insts.length), sub: "" });
			}
		}
		for (const r of rows) {
			const aliases = slot === JOB_FIELD ? JOB_ALIASES[r.name] : null;
			if (aliases && !r.sub) r.sub = "auch: " + aliases.join(", ");
			r.search = " " + searchNorm([r.name, r.group, r.subText ?? r.sub, ...(aliases || [])].join(" "));
			r.variant = r.kind === "inst" ? variantFor(slot, r.id, r.inst) : SLOT_BY_KEY[slot.key] ? variantFor(slot, Number(r.value), null) : { [slot.key]: r.value };
			r.current = slot.shortcut ? false : isCurrentVariant(r.variant);
		}

		if (s.preview !== "off" && !slot.listOnly) {
			const base = baseline();
			const sims = slot.shortcut ? rows.filter((r) => r.kind !== "none" && s.preview === "all") : rows.filter((r) => s.preview === "all" || slot.noOwned || r.owned || r.kind === "none");
			const vals = slot.shortcut ? shortcutValues(slot, sims) : simulate(sims.map((r) => r.variant));
			sims.forEach((r, i) => {
				r.dmg = vals[i];
				r.delta = r.current ? "" : formatDelta(r.dmg, base);
				r.dir = Number.isFinite(r.dmg) ? Math.sign(Math.round((r.dmg - base) * 1000)) : 0;
			});
		}
		comboCache.set(select, { key, rows });
		return rows;
	}

	function isCurrentVariant(variant) {
		return Object.entries(variant).every(([k, v]) => {
			const sel = el(k);
			return sel ? sel.value === v : v === "0";
		});
	}

	function openCombo(c, query) {
		const rows = comboRows(c.slot, c.select);
		comboOpen = { ...c, rows, shown: [], active: 0 };
		c.input.setAttribute("aria-expanded", "true");
		filterCombo(query);
		positionDropdown();
		dropdown.classList.add("aa-open");
	}

	function closeCombo() {
		if (!comboOpen) return;
		comboOpen.input.setAttribute("aria-expanded", "false");
		comboOpen = null;
		dropdown.classList.remove("aa-open");
		dropdown.replaceChildren();
	}

	const MAX_ROWS = 300;

	function filterCombo(query) {
		const o = comboOpen;
		if (!o) return;
		const q = searchNorm(query.replace(/^★\s*/, ""));
		// Right after opening the field still shows the current item: no filter then.
		const showAll = !q || q === searchNorm(currentLabel(o.slot, o.select).replace(/^★\s*/, ""));
		const tokens = q.split(" ").filter(Boolean);
		let shown = showAll ? o.rows.slice() : o.rows.filter((r) => tokens.every((t) => r.search.includes(" " + t)));
		const hidden = o.rows.hiddenSearch || [];
		o.filteredCount = hidden.filter((e) => showAll || tokens.every((t) => e.search.includes(" " + t))).reduce((sum, e) => sum + e.n, 0);
		if (state.settings.comboSort === "dmg" && !o.slot.listOnly) {
			shown.sort((a, b) => (b.kind === "none") - (a.kind === "none") || (Number.isFinite(b.dmg) ? b.dmg : -Infinity) - (Number.isFinite(a.dmg) ? a.dmg : -Infinity));
		} else if (!o.slot.listOnly && !o.slot.shortcut) {
			// "name": A-Z over all categories. "cat": categories (e.g. "Two-handed
			// Sword") in the calculator's order, A-Z inside. The "+7" of own copies
			// doesn't count; copies of one item keep their order (stable sort).
			const byCat = state.settings.comboSort === "cat";
			const catOrder = new Map();
			if (byCat) o.rows.forEach((r) => catOrder.has(r.group || "") || catOrder.set(r.group || "", catOrder.size));
			const key = (r) => r.name.replace(/^\+\d+\s+/, "");
			shown.sort(
				(a, b) =>
					(b.kind === "none") - (a.kind === "none") ||
					(byCat ? catOrder.get(a.group || "") - catOrder.get(b.group || "") : 0) ||
					key(a).localeCompare(key(b), "en", { sensitivity: "base" })
			);
		}
		o.shown = shown;
		const cur = shown.findIndex((r) => r.current);
		o.active = showAll && cur >= 0 && cur < MAX_ROWS ? cur : 0;
		renderDropdown();
	}

	function renderDropdown() {
		const o = comboOpen;
		const s = state.settings;
		const setAndReopen = (k, v) => {
			const q = o.input.value;
			s[k] = v;
			save();
			if (k === "onlyOwned") {
				invalidate();
				refreshSelects();
			}
			const c = combos.get(o.slot.key);
			closeCombo();
			if (c) openCombo(c, q);
		};
		const head = h(
			"div",
			{ class: "aa-chead" },
			h("span", { class: "aa-dim" }, h("strong", { class: "aa-cslotname" }, o.slot.label), ` · ${o.shown.length} Treffer`, o.filteredCount ? h("span", { class: "aa-cfiltered", title: "Passende Einträge, die ein Filter ausblendet (Pre-trans WoE, Hide unavailable, nur eigene)" }, ` · ${o.filteredCount} gefiltert`) : null),
			o.slot.card || o.slot.shortcut || o.slot.listOnly || o.slot.noOwned ? null : h("label", null, h("input", { type: "checkbox", checked: s.onlyOwned, disabled: !state.items.length, onchange: (e) => setAndReopen("onlyOwned", e.target.checked) }), " nur eigene"),
			o.slot.listOnly ? null : h(
				"button",
				{ type: "button", class: "aa-btn aa-small", title: "Sortierung umschalten: Name → Schaden → Kategorie", onclick: () => setAndReopen("comboSort", { name: "dmg", dmg: "cat", cat: "name" }[s.comboSort] || "name") },
				{ dmg: "Sortiert: Schaden", cat: "Sortiert: Kategorie" }[s.comboSort] || "Sortiert: Name"
			)
		);
		const list = h(
			"div",
			{ class: "aa-clist" },
			o.shown.slice(0, MAX_ROWS).map((r, i) =>
				h(
					"div",
					{
						class: "aa-crow" + (i === o.active ? " aa-active" : "") + (r.current ? " aa-current" : ""),
						role: "option",
						"data-i": String(i),
						onmousedown: (e) => {
							if (e.button === 0) pickRow(o, r);
						},
						onmousemove: () => setActive(i, false),
					},
					h("span", { class: "aa-cstar" }, r.owned ? "★" : ""),
					h("div", { class: "aa-cmain" }, h("div", { class: "aa-cname" }, r.name, r.group ? h("span", { class: "aa-ctag" }, r.group) : null), r.sub && r.sub.length ? h("div", { class: "aa-dim" }, renderSub(r.sub)) : null),
					h("span", { class: "aa-cdelta " + (r.dir > 0 ? "aa-up" : r.dir < 0 ? "aa-down" : "") }, r.current ? "aktuell" : r.delta || "")
				)
			),
			o.shown.length > MAX_ROWS ? h("div", { class: "aa-crow aa-dim" }, `… ${o.shown.length - MAX_ROWS} weitere – Suche verfeinern`) : null,
			o.shown.length === 0 ? h("div", { class: "aa-crow aa-dim" }, o.filteredCount ? `Keine Treffer – ${o.filteredCount} durch Filter ausgeblendet` : "Keine Treffer") : null
		);
		dropdown.replaceChildren(head, list);
		scrollActiveIntoView();
	}

	function setActive(i, scroll) {
		const o = comboOpen;
		if (!o || i === o.active) return;
		const rows = dropdown.querySelectorAll(".aa-crow[data-i]");
		if (rows[o.active]) rows[o.active].classList.remove("aa-active");
		o.active = i;
		if (rows[i]) rows[i].classList.add("aa-active");
		if (scroll) scrollActiveIntoView();
	}

	function moveActive(step) {
		const o = comboOpen;
		const n = Math.min(o.shown.length, MAX_ROWS);
		if (n) setActive((o.active + step + n) % n, true);
	}

	function scrollActiveIntoView() {
		const row = dropdown.querySelector(".aa-crow.aa-active");
		const list = dropdown.querySelector(".aa-clist");
		if (!row || !list) return;
		if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
		else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
	}

	function positionDropdown() {
		if (!comboOpen) return;
		const r = comboOpen.input.getBoundingClientRect();
		const width = Math.min(window.innerWidth - 16, Math.max(r.width, 440));
		const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
		const below = window.innerHeight - r.bottom - 8;
		const above = r.top - 8;
		const openUp = below < 240 && above > below;
		const maxH = Math.max(160, Math.min(420, openUp ? above : below));
		Object.assign(dropdown.style, {
			left: left + "px",
			width: width + "px",
			maxHeight: maxH + "px",
			top: openUp ? "" : r.bottom + 2 + "px",
			bottom: openUp ? window.innerHeight - r.top + 2 + "px" : "",
		});
	}
	window.addEventListener("resize", () => {
		positionDropdown();
		alignRightColumn();
	});
	window.addEventListener(
		"scroll",
		(e) => {
			if (!dropdown.contains(e.target)) positionDropdown();
		},
		true
	);

	function pickRow(o, row) {
		const { slot, select, input } = o;
		closeCombo();
		if (row.kind === "inst") {
			applying = true; // exactly this copy, not the "best" one
			try {
				applyVariant(slot, row.variant, true);
			} finally {
				applying = false;
			}
		} else if (select.value !== row.value || slot.shortcut) {
			select.value = row.value;
			select.dispatchEvent(new Event("change", { bubbles: true }));
		}
		refreshSelects();
		input.value = currentLabel(slot, select);
		input.blur();
	}

	// ---------------------------------------------------------------------------
	// Panel UI
	// ---------------------------------------------------------------------------

	function h(tag, attrs, ...children) {
		const node = document.createElement(tag);
		for (const [k, v] of Object.entries(attrs || {})) {
			if (k === "class") node.className = v;
			else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
			else if (v === true) node.setAttribute(k, "");
			else if (v !== false && v != null) node.setAttribute(k, v);
		}
		for (const c of children.flat(Infinity)) {
			if (c == null || c === false) continue;
			node.append(c instanceof Node ? c : document.createTextNode(String(c)));
		}
		return node;
	}

	const ui = { tab: "import", compare: null, lastImport: null, inbox: null, scroll: {}, renderedTab: null, optimized: null, buildImport: null };

	function applyImport(res, replace) {
		state.items = replace ? res.items : dedupe([...state.items, ...res.items]);
		state.unmatched = res.unmatched;
		ui.lastImport = { found: res.items.length, skipped: res.unmatched.length };
		rebuildOwned();
		save();
		invalidate();
		refreshSelects();
		ui.tab = "items";
		renderPanel();
	}

	function clearInbox() {
		ui.inbox = null;
		window.postMessage({ aa: "toBridge", type: "clearInbox" }, window.location.origin);
	}

	// List sent from the control panel item page (cp.js).
	function renderInbox() {
		if (!ui.inbox) return null;
		const { entries, source, at } = ui.inbox;
		const when = at ? new Date(at).toLocaleString() : "";
		const take = (replace) => {
			const res = resolveEntries(entries);
			clearInbox();
			applyImport(res, replace);
		};
		return h(
			"div",
			{ class: "aa-inbox" },
			h("strong", null, `Neue Liste vom ${source || "Control Panel"}`),
			h("div", { class: "aa-dim" }, `${entries.length} Einträge${when ? " · " + when : ""}`),
			h(
				"div",
				{ class: "aa-row" },
				h("button", { type: "button", class: "aa-btn aa-primary", onclick: () => take(true) }, "Ersetzen"),
				h("button", { type: "button", class: "aa-btn", onclick: () => take(false) }, "Hinzufügen"),
				h("button", { type: "button", class: "aa-btn", onclick: () => (clearInbox(), renderPanel()) }, "Verwerfen")
			)
		);
	}

	const toggleBtn = h("button", { class: "aa-toggle", type: "button", title: "Arcadia Armory", onclick: () => panel.classList.toggle("aa-open") }, "⚔ Armory");
	const panel = h("div", { class: "aa-panel" });
	document.body.append(toggleBtn, panel);

	function renderPanel() {
		// Rebuilding the panel would reset its scroll position; keep it per tab.
		const oldBody = panel.querySelector(".aa-body");
		if (oldBody && ui.renderedTab) ui.scroll[ui.renderedTab] = oldBody.scrollTop;
		panel.replaceChildren(
			h(
				"div",
				{ class: "aa-head" },
				h("strong", null, "Arcadia Armory"),
				h("span", { class: "aa-count" }, `${state.items.length} Exemplare`),
				h("button", { type: "button", class: "aa-x", title: "Schließen", onclick: () => panel.classList.remove("aa-open") }, "×")
			),
			h(
				"div",
				{ class: "aa-tabs" },
				tabBtn("import", "Import"),
				tabBtn("items", "Meine Items"),
				tabBtn("compare", "Vergleich"),
				tabBtn("builds", "Builds")
			),
			renderInbox() || "",
			h("div", { class: "aa-body" }, ui.tab === "import" ? renderImport() : ui.tab === "items" ? renderItems() : ui.tab === "builds" ? renderBuilds() : renderCompare())
		);
		ui.renderedTab = ui.tab;
		panel.querySelector(".aa-body").scrollTop = ui.scroll[ui.tab] || 0;
	}

	// Collapsible category; the collapsed state is stored with the settings.
	function isCollapsed(key) {
		return (state.settings.collapsed || []).includes(key);
	}

	function setCollapsed(keys, collapsed) {
		const set = new Set(state.settings.collapsed || []);
		keys.forEach((k) => (collapsed ? set.add(k) : set.delete(k)));
		state.settings.collapsed = [...set];
		save();
		renderPanel();
	}

	function groupBlock(key, title, count, renderItemsFn) {
		const collapsed = isCollapsed(key);
		return h(
			"div",
			{ class: "aa-group" + (collapsed ? " aa-collapsed" : "") },
			h(
				"button",
				{ type: "button", class: "aa-gtitle", "aria-expanded": String(!collapsed), onclick: () => setCollapsed([key], !collapsed) },
				h("span", { class: "aa-caret" }, collapsed ? "▸" : "▾"),
				title,
				h("span", { class: "aa-gcount" }, String(count))
			),
			collapsed ? null : renderItemsFn()
		);
	}

	function groupToolbar(keys) {
		if (keys.length < 2) return null;
		return h(
			"div",
			{ class: "aa-row aa-gtools" },
			h("button", { type: "button", class: "aa-btn aa-small", onclick: () => setCollapsed(keys, false) }, "Alle aufklappen"),
			h("button", { type: "button", class: "aa-btn aa-small", onclick: () => setCollapsed(keys, true) }, "Alle zuklappen")
		);
	}

	function tabBtn(id, label) {
		return h("button", { type: "button", class: "aa-tab" + (ui.tab === id ? " aa-active" : ""), onclick: () => ((ui.tab = id), renderPanel()) }, label);
	}

	function renderImport() {
		const ta = h("textarea", { class: "aa-ta", placeholder: "Item-Liste hier einfügen (z. B. aus der Item-Suche im Control Panel) …", spellcheck: "false" });
		const run = (replace) => applyImport(parseList(ta.value), replace);
		return [
			ta,
			h(
				"div",
				{ class: "aa-row" },
				h("button", { type: "button", class: "aa-btn aa-primary", onclick: () => run(true) }, "Importieren (ersetzen)"),
				h("button", { type: "button", class: "aa-btn", onclick: () => run(false) }, "Hinzufügen")
			),
			h("p", { class: "aa-hint" }, "Waffen und Ausrüstung werden erkannt und gespeichert, alles andere wird übersprungen. Verfeinerung und Karten pro Exemplar werden übernommen."),
			h("p", { class: "aa-hint" }, "Bequemer: Im Control Panel unter „My Master Account Item List“ auf „⚔ Ausrüstung an Arcadia Armory senden“ klicken."),
			state.unmatched.length
				? h("details", { class: "aa-details" }, h("summary", null, `${state.unmatched.length} Einträge beim letzten Import übersprungen`), h("ul", null, state.unmatched.map((u) => h("li", null, u))))
				: null,
		];
	}

	// ---------------------------------------------------------------------------
	// Stat suggestion: what +1 in each stat would bring, and what it costs
	// ---------------------------------------------------------------------------

	const STAT_KEYS = ["A_STR", "A_AGI", "A_VIT", "A_INT", "A_DEX", "A_LUK"];
	const statGain = new Map(); // stat key -> <span> next to the calculator's "+ 0" bonus
	let statGainVersion = null;

	// Status points needed to raise a stat from x to x + 1 (calculator's StCalc2).
	const statCost = (x) => Math.floor((x - 1) / 10) + 2;

	function updateStatGains() {
		const off = state.settings.preview === "off";
		for (const key of STAT_KEYS) {
			const anchor = document.getElementById(key + "p");
			if (!anchor) continue;
			let span = statGain.get(key);
			if (!span) {
				span = h("span", { class: "aa-statgain", onclick: () => raiseStat(key) });
				statGain.set(key, span);
			}
			if (anchor.nextSibling !== span) anchor.after(span);
			if (off) span.textContent = "";
		}
		if (off || statGainVersion === calcVersion) return;
		statGainVersion = calcVersion;

		const metric = state.settings.metric;
		const remaining = Number((document.getElementById("A_STPOINT") || {}).textContent) || 0;
		const rows = STAT_KEYS.map((key) => {
			const sel = el(key);
			const cur = sel ? Number(sel.value) : 0;
			return { key, cur, next: sel && hasOption(sel, cur + 1) ? String(cur + 1) : null, cost: statCost(cur + 1) };
		});
		const base = baseline();
		const open = rows.filter((r) => r.next);
		const vals = simulate(open.map((r) => ({ [r.key]: r.next })));
		open.forEach((r, i) => (r.value = vals[i]));
		// Best gain per status point among the stats that are affordable now.
		let best = null;
		for (const r of open) {
			const perPoint = (r.value - base) / r.cost;
			if (r.cost <= remaining && perPoint > 1e-9 && (!best || perPoint > best.perPoint)) best = { key: r.key, perPoint };
		}
		for (const r of rows) {
			const span = statGain.get(r.key);
			if (!span) continue;
			if (!r.next) {
				span.textContent = "";
				continue;
			}
			const name = r.key.slice(2);
			const affordable = r.cost <= remaining;
			span.textContent = `${best && best.key === r.key ? "★ " : ""}+1: ${formatDelta(r.value, base)} · ${r.cost} P.`;
			span.className = "aa-statgain " + (r.value > base ? "aa-up" : r.value < base ? "aa-down" : "") + (best && best.key === r.key ? " aa-statbest" : "") + (affordable ? "" : " aa-statpoor");
			span.title =
				`${name} ${r.cur} → ${r.next} kostet ${r.cost} Statuspunkte${affordable ? "" : ` (nur ${remaining} übrig)`}: ` +
				`${metricShow(base, metric).toFixed(2)} → ${metricShow(r.value, metric).toFixed(2)} ${metricUnit(metric)}. Klick: +1 setzen.`;
		}
	}

	// ---------------------------------------------------------------------------
	// Stat fields as [-][value][+]
	// ---------------------------------------------------------------------------
	//
	// The calculator's selects stay in the form (hidden); the stepper only sets
	// their value and fires their change handler. Values 1-99, and never beyond
	// what the calculator's list offers.

	const statSteppers = new Map(); // stat key -> { wrap, input, minus, plus }

	function statRange(sel) {
		const vals = [...sel.options].map((o) => Number(o.value)).filter(Number.isFinite);
		return { min: Math.max(1, Math.min(...vals)), max: Math.min(99, Math.max(...vals)) };
	}

	function setStat(key, value) {
		const sel = el(key);
		if (!sel) return;
		const { min, max } = statRange(sel);
		const v = Math.min(max, Math.max(min, Math.round(Number(value)) || min));
		if (hasOption(sel, v) && sel.value !== String(v)) {
			sel.value = String(v);
			sel.dispatchEvent(new Event("change", { bubbles: true }));
		}
		const st = statSteppers.get(key);
		if (st) st.input.value = sel.value; // also shows the clamped value (0 → 1, 150 → 99)
		syncStatStepper(key);
	}

	function statStepper(key) {
		let st = statSteppers.get(key);
		if (st) return st;
		const step = (d) => (e) => setStat(key, Number(el(key).value) + (e.shiftKey ? 10 * d : d));
		const input = h("input", { type: "text", class: "aa-statval", inputmode: "numeric", maxlength: "3", "aria-label": key.slice(2), title: "1–99 · Enter übernimmt · ↑/↓ ±1" });
		input.addEventListener("input", () => (input.value = input.value.replace(/\D/g, "").slice(0, 3)));
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				setStat(key, input.value);
			} else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
				e.preventDefault();
				setStat(key, Number(el(key).value) + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1));
				input.select();
			} else if (e.key === "Escape") {
				input.value = el(key).value;
				input.blur();
			}
		});
		input.addEventListener("focus", () => input.select());
		input.addEventListener("blur", () => setStat(key, input.value));
		const minus = h("button", { type: "button", class: "aa-statbtn", tabindex: "-1", title: "−1 (Shift: −10)", onclick: step(-1) }, "−");
		const plus = h("button", { type: "button", class: "aa-statbtn", tabindex: "-1", title: "+1 (Shift: +10)", onclick: step(1) }, "+");
		st = { wrap: h("span", { class: "aa-stat" }, minus, input, plus), input, minus, plus };
		statSteppers.set(key, st);
		return st;
	}

	function syncStatStepper(key) {
		const sel = el(key);
		const st = statSteppers.get(key);
		if (!sel || !st) return;
		const { min, max } = statRange(sel);
		const v = Number(sel.value);
		if (document.activeElement !== st.input) st.input.value = sel.value;
		st.minus.disabled = !(v > min);
		st.plus.disabled = !(v < max);
	}

	function updateStatSteppers() {
		for (const key of STAT_KEYS) {
			const sel = el(key);
			if (!sel || sel.tagName !== "SELECT") continue;
			const st = statStepper(key);
			if (sel.previousElementSibling !== st.wrap) sel.before(st.wrap);
			sel.classList.add("aa-hidden-select");
			syncStatStepper(key);
		}
	}
	updateStatSteppers();

	function raiseStat(key) {
		const sel = el(key);
		if (!sel || !hasOption(sel, Number(sel.value) + 1)) return;
		sel.value = String(Number(sel.value) + 1);
		sel.dispatchEvent(new Event("change", { bubbles: true }));
	}

	// Changes a setting from anywhere (panel, header toggle) and redraws what depends on it.
	function applySetting(k, v) {
		state.settings[k] = v;
		save();
		invalidate();
		slotSelects().forEach(({ select }) => clearAnnotations(select));
		refreshSelects();
		renderPanel();
	}

	// Filter switches in the "Equipment & Cards" header, right after the title
	// (copies of the ones in the panel settings).
	const headerToggle = (key, label, title) =>
		h("label", { class: "aa-woe-toggle", title, "data-setting": key }, h("input", { type: "checkbox", onchange: (e) => applySetting(key, e.target.checked) }), " " + label);
	const headerToggles = h(
		"span",
		{ class: "aa-woe-toggle aa-header-toggles" },
		headerToggle("woe", "Pre-trans WoE", `Blendet die ${WOE_LIST.length} in Pre-trans WoE verbotenen Items und Karten aus (Liste von Arcadia, Stand ${WOE_AS_OF}).`),
		headerToggle("hideUnavailable", "Hide unavailable", "Blendet Items und Karten aus, die der Calculator als [Unavailable] markiert (eigene Exemplare bleiben sichtbar)."),
		h(
			"label",
			{ title: "Maßstab für Schadensvorschau, Vergleich und Hände-Tausch" },
			"Maßstab: ",
			h(
				"select",
				{ class: "aa-header-metric", onchange: (e) => applySetting("metric", e.target.value) },
				h("option", { value: "dps" }, "Ø Schaden/Sek."),
				h("option", { value: "hit" }, "Ø Schaden/Treffer"),
				h("option", { value: "def" }, "Ø erlittener Schaden"),
				h("option", { value: "ehp", title: "Max HP ÷ Ø erlittener Schaden vom gewählten Monster-Angriff (inkl. DEF, Reduktionen, Ausweichen): Treffer bis K.O." }, "Effektive HP"),
				h("option", { value: "craft", title: "Forging, Potions, EDP (Poison Bottle) oder Cooking – je nach Klasse bzw. „Other Info“" }, "Herstellungs-Erfolg")
			)
		)
	);
	function updateWoeHeaderToggle() {
		const anchor = document.getElementById("episode");
		if (anchor && headerToggles.nextElementSibling !== anchor) anchor.before(headerToggles);
		for (const label of headerToggles.querySelectorAll("label[data-setting]")) {
			const box = label.querySelector("input");
			const on = Boolean(state.settings[label.dataset.setting]);
			if (box.checked !== on) box.checked = on;
		}
		const metric = headerToggles.querySelector(".aa-header-metric");
		if (metric.value !== state.settings.metric) metric.value = state.settings.metric;
	}

	function settingsBlock() {
		const s = state.settings;
		const set = applySetting;
		return h(
			"div",
			{ class: "aa-settings" },
			h("label", null, h("input", { type: "checkbox", checked: s.onlyOwned, onchange: (e) => set("onlyOwned", e.target.checked) }), " Nur eigene Items in der Auswahl"),
			h("label", null, h("input", { type: "checkbox", checked: s.applyInstance, onchange: (e) => set("applyInstance", e.target.checked) }), " Verfeinerung + Karten eigener Items übernehmen"),
			h("label", null, h("input", { type: "checkbox", checked: s.combo, onchange: (e) => set("combo", e.target.checked) }), " Suchfeld statt Auswahlliste"),
			h(
				"label",
				{ title: `Blendet die ${WOE_LIST.length} in Pre-trans WoE verbotenen Items und Karten aus (Liste von Arcadia, Stand ${WOE_AS_OF}).` },
				h("input", { type: "checkbox", checked: s.woe, onchange: (e) => set("woe", e.target.checked) }),
				" Pre-trans WoE: verbotene Items ausblenden"
			),
			h(
				"label",
				{ title: "Blendet Items und Karten aus, die der Calculator als [Unavailable] markiert (eigene Exemplare bleiben sichtbar)." },
				h("input", { type: "checkbox", checked: s.hideUnavailable, onchange: (e) => set("hideUnavailable", e.target.checked) }),
				" Hide unavailable: nicht verfügbare Items ausblenden"
			),
			h(
				"label",
				null,
				"Schadensvorschau: ",
				h(
					"select",
					{ onchange: (e) => set("preview", e.target.value) },
					h("option", { value: "all", selected: s.preview === "all" }, "alle Items"),
					h("option", { value: "owned", selected: s.preview === "owned" }, "nur eigene"),
					h("option", { value: "off", selected: s.preview === "off" }, "aus")
				)
			),
			h(
				"label",
				null,
				"Maßstab: ",
				h(
					"select",
					{ onchange: (e) => set("metric", e.target.value) },
					h("option", { value: "dps", selected: s.metric === "dps" }, "Ø Schaden / Sekunde"),
					h("option", { value: "hit", selected: s.metric === "hit" }, "Ø Schaden / Treffer"),
					h("option", { value: "def", selected: s.metric === "def" }, "Ø erlittener Schaden (Verteidigung)"),
					h("option", { value: "ehp", selected: s.metric === "ehp" }, "Effektive HP (Max HP ÷ erlittener Schaden)"),
					h("option", { value: "craft", selected: s.metric === "craft" }, "Herstellungs-Erfolg (Forging / Potion / EDP / Cooking)")
				)
			)
		);
	}

	function renderItems() {
		const ORDER = ["Weapon", "Upper Headgear", "Middle Headgear", "Lower Headgear", "Armor", "Shield", "Garment", "Footgear", "Accessory"];
		const groups = new Map(ORDER.map((g) => [g, []]));
		for (const it of state.items) {
			const g = typeLabel(m_Item[it.calcId] ? m_Item[it.calcId][1] : 0);
			if (!groups.has(g)) groups.set(g, []);
			groups.get(g).push(it);
		}
		for (const [g, items] of groups) {
			if (!items.length) groups.delete(g);
			else items.sort((a, b) => a.name.localeCompare(b.name) || b.refine - a.refine);
		}
		const remove = (uid) => {
			state.items = state.items.filter((i) => i.uid !== uid);
			rebuildOwned();
			save();
			invalidate();
			refreshSelects();
			renderPanel();
		};
		return [
			ui.lastImport ? h("p", { class: "aa-ok" }, `${ui.lastImport.found} Ausrüstungs-Exemplare erkannt, ${ui.lastImport.skipped} übersprungen.`) : null,
			settingsBlock(),
			state.items.length === 0 ? h("p", { class: "aa-hint" }, "Noch nichts importiert.") : null,
			groupToolbar([...groups.keys()].map((g) => "items:" + g)),
			[...groups].map(([g, items]) =>
				groupBlock("items:" + g, g, items.length, () =>
					items.map((it) =>
						h(
							"div",
							{ class: "aa-item" },
							h(
								"div",
								{ class: "aa-iname" },
								(it.refine ? `+${it.refine} ` : "") + it.name,
								it.count > 1 ? h("span", { class: "aa-dim" }, ` ×${it.count}`) : null,
								h("div", { class: "aa-dim" }, [instanceSummary({ ...it, refine: 0 }) || "keine Karten", it.unknownCards.length ? ` · unbekannt: ${it.unknownCards.join(", ")}` : "", it.flags && it.flags.length ? ` · ${it.flags.join(", ")}` : "", woeBlockedInstance(it) ? " · WoE-verboten" : "", it.location ? ` · ${it.location}` : ""].join(""))
							),
							h("button", { type: "button", class: "aa-x", title: "Entfernen", onclick: () => remove(it.uid) }, "×")
						)
					)
				)
			),
			state.items.length
				? h(
						"button",
						{
							type: "button",
							class: "aa-btn aa-danger",
							onclick: () => {
								if (!confirm("Alle importierten Items löschen?")) return;
								state.items = [];
								state.unmatched = [];
								rebuildOwned();
								save();
								invalidate();
								refreshSelects();
								renderPanel();
							},
						},
						"Alle löschen"
				  )
				: null,
		];
	}

	function computeCompare() {
		const base = baseline();
		const rows = [];
		const notEquippable = new Set(state.items.filter((i) => !(state.settings.woe && woeBlockedInstance(i))).map((i) => i.uid));
		for (const { slot, select } of slotSelects()) {
			const entries = [];
			for (const calcId of ownedById.keys()) {
				const insts = usableInstances(calcId);
				if (!insts.length || !hasOption(select, calcId)) continue;
				const variants = insts.map((inst) => variantFor(slot, calcId, inst));
				const vals = simulate(variants);
				insts.forEach((inst, i) => {
					notEquippable.delete(inst.uid);
					const current = Object.entries(variants[i]).every(([k, v]) => el(k) && el(k).value === v);
					entries.push({ inst, value: vals[i], current });
				});
			}
			entries.sort((a, b) => b.value - a.value);
			if (entries.length) rows.push({ slot, base, entries });
		}
		ui.compare = { rows, base, notEquippable: state.items.filter((i) => notEquippable.has(i.uid)), version: calcVersion };
	}

	// ---------------------------------------------------------------------------
	// Optimizer: equip the own copies with the highest DPS / damage per hit
	// ---------------------------------------------------------------------------

	// Items that may be worn only once at a time, whatever the number of copies owned.
	const WEAR_ONCE = new Set(["The Sign"]);

	const OPT_ORDER = ["A_weapon1", "A_weapon2", "A_head1", "A_head2", "A_head3", "A_body", "A_left", "A_shoulder", "A_shoes", "A_acces1", "A_acces2"];

	// Current values of all equipment selects (item, refine, cards) to undo a run.
	function equipmentSnapshot() {
		return OPT_ORDER.map((key) => {
			const slot = SLOT_BY_KEY[key];
			return { key, values: el(key) ? handState(slot) : null };
		});
	}

	function restoreSnapshot(snapshot) {
		applying = true;
		try {
			for (const { key, values } of snapshot) {
				if (values && el(key)) applyVariant(SLOT_BY_KEY[key], values, true);
			}
		} finally {
			applying = false;
		}
		invalidate();
		refreshSelects();
	}

	// Calculator equipment sets (w_SE) whose parts are all owned and wearable now:
	// [{ key, slot, id, inst }] per set, best own copy per part. Sets already worn
	// completely are skipped.
	function setPlans(chosen) {
		if (typeof w_SE === "undefined") return [];
		const plans = [];
		for (const entry of w_SE) {
			const parts = entry.slice(1, entry.indexOf("NULL"));
			if (parts.length < 2 || !parts.every((id) => usableInstances(id).length)) continue;
			const used = new Set();
			const plan = [];
			for (const id of parts) {
				const type = m_Item[id] ? m_Item[id][1] : 0;
				const keys = type >= 1 && type <= 21 ? ["A_weapon1", "A_weapon2"] : SLOT_FOR_TYPE[type] || [];
				const key = keys.find((k) => !used.has(k) && el(k) && hasOption(el(k), id));
				const best = key && evaluateOwned(SLOT_BY_KEY[key], id);
				if (!best) break;
				// Don't take a copy that is already worn in a slot outside this set.
				const takenElsewhere = [...chosen].filter(([k, i]) => i.uid === best.inst.uid && !used.has(k) && k !== key).length;
				if (takenElsewhere >= (best.inst.count || 1)) break;
				used.add(key);
				plan.push({ key, slot: SLOT_BY_KEY[key], id, inst: best.inst });
			}
			if (plan.length !== parts.length) continue;
			if (plan.every((p) => el(p.key).value === String(p.id))) continue;
			const weapon = plan.find((p) => p.key === "A_weapon1");
			if (weapon && isTwoHanded(weapon.id) && plan.some((p) => p.key === "A_left")) continue;
			plan.sort((a, b) => (a.key === "A_weapon1") - (b.key === "A_weapon1")); // the weapon part wins over "shield empties the weapon"
			plans.push(plan);
		}
		return plans;
	}

	// Coordinate descent over the slots: per slot put on the best own copy given
	// the rest of the equipment, repeated until nothing improves (sets / combos).
	function optimizeEquipment(metric) {
		const snapshot = equipmentSnapshot();
		metricOverride = metric;
		const chosen = new Map(); // slot key -> instance
		const changes = [];
		let start = 0;
		let end = 0;
		try {
			start = baseline();
			for (let pass = 0; pass < 3; pass++) {
				let improved = false;
				for (const key of OPT_ORDER) {
					const select = el(key);
					if (!select || select.tagName !== "SELECT") continue;
					const slot = SLOT_BY_KEY[key];
					// Copies still available: never wear one copy more often than owned.
					const usedElsewhere = (inst) => [...chosen].filter(([k, i]) => k !== key && i.uid === inst.uid).length;
					// WEAR_ONCE items: not if another slot already holds that item.
					const wornElsewhere = (calcId) => OPT_ORDER.some((k) => k !== key && el(k) && Number(el(k).value) === calcId);
					const cands = [];
					for (const calcId of ownedById.keys()) {
						if (!hasOption(select, calcId)) continue;
						if (WEAR_ONCE.has(m_Item[calcId][8]) && wornElsewhere(calcId)) continue;
						for (const inst of usableInstances(calcId)) {
							if (usedElsewhere(inst) < (inst.count || 1)) cands.push({ inst, variant: variantFor(slot, calcId, inst) });
						}
					}
					if (!cands.length) continue;
					const base = baseline();
					const vals = simulate(cands.map((c) => c.variant));
					let best = -1;
					vals.forEach((v, i) => {
						if (Number.isFinite(v) && v > base + Math.abs(base) * 1e-9 + 1e-9 && (best < 0 || v > vals[best])) best = i;
					});
					if (best < 0) continue;
					applying = true;
					try {
						applyVariant(slot, cands[best].variant, true);
					} finally {
						applying = false;
					}
					chosen.set(key, cands[best].inst);
					improved = true;
				}
				// Sets: parts that are only strong together (e.g. Shackles + Bloodied
				// Shackle Ball = ATK +50) are never picked one slot at a time.
				for (const plan of setPlans(chosen)) {
					const variant = Object.assign({}, ...plan.map((p) => variantFor(p.slot, p.id, p.inst)));
					const base = baseline();
					const [value] = simulate([variant]);
					if (!(Number.isFinite(value) && value > base + Math.abs(base) * 1e-9 + 1e-9)) continue;
					applying = true;
					try {
						for (const p of plan) applyVariant(p.slot, variantFor(p.slot, p.id, p.inst), true);
					} finally {
						applying = false;
					}
					plan.forEach((p) => chosen.set(p.key, p.inst));
					improved = true;
				}
				if (!improved) break;
			}
			end = baseline();
		} finally {
			metricOverride = null;
		}
		for (const [key, inst] of chosen) changes.push({ slot: SLOT_BY_KEY[key].label, inst });
		changes.sort((a, b) => OPT_ORDER.indexOf(SLOTS.find((x) => x.label === a.slot).key) - OPT_ORDER.indexOf(SLOTS.find((x) => x.label === b.slot).key));
		invalidate();
		refreshSelects();
		ui.optimized = { metric, start, end, changes, snapshot };
		computeCompare();
		renderPanel();
	}

	function renderOptimizer() {
		const o = ui.optimized;
		const unit = metricUnit;
		// The run takes a few seconds; let the browser paint the busy state first.
		const run = (metric) => (e) => {
			e.target.closest(".aa-opt").querySelectorAll("button").forEach((b) => (b.disabled = true));
			e.target.textContent = "Rechne …";
			setTimeout(() => optimizeEquipment(metric), 30);
		};
		return h(
			"div",
			{ class: "aa-opt" },
			h(
				"div",
				{ class: "aa-row" },
				h("button", { type: "button", class: "aa-btn aa-primary", disabled: !state.items.length, title: "Legt deine Exemplare mit dem höchsten Ø Schaden pro Sekunde an", onclick: run("dps") }, "Beste DPS anlegen"),
				h("button", { type: "button", class: "aa-btn aa-primary", disabled: !state.items.length, title: "Legt deine Exemplare mit dem höchsten Ø Schaden pro Treffer an", onclick: run("hit") }, "Bester Einzelschaden anlegen"),
				h("button", { type: "button", class: "aa-btn aa-primary", disabled: !state.items.length, title: "Legt deine Exemplare an, mit denen du vom gewählten Monster am wenigsten Schaden erleidest (Combat Simulator, inkl. Ausweichen)", onclick: run("def") }, "Beste Verteidigung anlegen"),
				h("button", { type: "button", class: "aa-btn aa-primary", disabled: !state.items.length, title: "Legt deine Exemplare an, mit denen du die meisten Treffer des gewählten Monsters aushältst (Max HP ÷ Ø erlittener Schaden)", onclick: run("ehp") }, "Beste effektive HP anlegen"),
				h("button", { type: "button", class: "aa-btn aa-primary", disabled: !state.items.length, title: "Legt deine Exemplare mit der höchsten Erfolgschance an: Forging, Potions, EDP oder Cooking – je nach Klasse bzw. „Other Info“", onclick: run("craft") }, "Beste Herstellung anlegen")
			),
			o
				? h(
						"div",
						{ class: "aa-optresult" },
						h(
							"div",
							null,
							o.changes.length ? `${o.changes.length} Slot(s) geändert · ` : "Keine Verbesserung gefunden · ",
							h("span", { class: o.end > o.start ? "aa-up" : "" }, formatDelta(o.end, o.start, o.metric)),
							` (${metricShow(o.start, o.metric).toFixed(2)} → ${metricShow(o.end, o.metric).toFixed(2)} ${unit(o.metric)})`
						),
						o.changes.length
							? h(
									"ul",
									null,
									o.changes.map((c) => h("li", null, `${c.slot}: ${(c.inst.refine ? `+${c.inst.refine} ` : "") + c.inst.name}${instanceSummary({ ...c.inst, refine: 0 }) ? " (" + instanceSummary({ ...c.inst, refine: 0 }) + ")" : ""}`))
							  )
							: null,
						o.changes.length
							? h("button", { type: "button", class: "aa-btn aa-small", onclick: () => (restoreSnapshot(o.snapshot), (ui.optimized = null), computeCompare(), renderPanel()) }, "Rückgängig")
							: null
				  )
				: null
		);
	}

	function renderCompare() {
		if (ui.compare && ui.compare.version !== calcVersion) ui.compare.stale = true;
		const c = ui.compare;
		return [
			h("p", { class: "aa-hint" }, "Simuliert jedes eigene Exemplar im passenden Slot mit dem aktuellen Charakter, Skill und Monster."),
			renderOptimizer(),
			h("button", { type: "button", class: "aa-btn", onclick: () => (computeCompare(), renderPanel()) }, c ? "Neu berechnen" : "Berechnen"),
			c && c.stale ? h("p", { class: "aa-warn" }, "Der Charakter wurde seitdem geändert – neu berechnen für aktuelle Werte.") : null,
			c
				? h(
						"div",
						null,
						h("p", { class: "aa-dim" }, `Aktuell: ${metricShow(c.base, state.settings.metric).toFixed(2)} ${metricUnit(state.settings.metric)}`),
						groupToolbar(c.rows.map((row) => "compare:" + row.slot.key)),
						c.rows.map((row) =>
							groupBlock("compare:" + row.slot.key, row.slot.label, row.entries.length, () =>
								row.entries.map((e) =>
									h(
										"div",
										{ class: "aa-item" + (e.current ? " aa-current" : "") },
										h("span", { class: "aa-delta " + (e.value > row.base ? "aa-up" : e.value < row.base ? "aa-down" : "") }, formatDelta(e.value, row.base)),
										h("div", { class: "aa-iname" }, (e.inst.refine ? `+${e.inst.refine} ` : "") + e.inst.name, h("div", { class: "aa-dim" }, instanceSummary({ ...e.inst, refine: 0 }) || "keine Karten")),
										h(
											"button",
											{
												type: "button",
												class: "aa-btn aa-small",
												onclick: () => {
													const v = variantFor(row.slot, e.inst.calcId, e.inst);
													applying = true; // keep the change listener from picking another instance
													try {
														applyVariant(row.slot, v, true);
													} finally {
														applying = false;
													}
													computeCompare();
													renderPanel();
												},
											},
											"Anlegen"
										)
									)
								)
							)
						),
						c.notEquippable.length
							? h("details", { class: "aa-details" }, h("summary", null, `${c.notEquippable.length} Exemplare für die aktuelle Klasse nicht ausrüstbar`), h("ul", null, c.notEquippable.map((i) => h("li", null, i.name))))
							: null
				  )
				: null,
		];
	}

	// ---------------------------------------------------------------------------
	// Saved builds
	// ---------------------------------------------------------------------------
	//
	// A build is the calculator's own "Save as URL" code (class, levels, stats,
	// equipment with refine and cards, ammo, skill, buffs). The monster is kept
	// as it is when loading or comparing, so builds are compared on one target.

	// A skill combo (SKILL_COMBOS) isn't part of the calculator's URL code; it is
	// kept as a suffix that loadBuildCode() takes off again.
	const COMBO_MARK = "|aa-combo=";

	// Current character as URL code, without URLOUT's alert and address change.
	function captureBuild() {
		const combo = activeCombo();
		return captureCalcCode() + (combo ? COMBO_MARK + combo.key : "");
	}

	function captureCalcCode() {
		const href = location.href;
		const field = form.elements.namedItem("URL_TEXT");
		const old = field ? field.value : "";
		const alert = window.alert;
		window.alert = () => {};
		try {
			URLOUT();
			return field ? field.value.split("#")[1] || "" : "";
		} finally {
			window.alert = alert;
			if (field) field.value = old;
			history.replaceState(history.state, "", href);
		}
	}

	// Loads a URL code through the calculator's "Load URL from another Calc",
	// keeping the current monster.
	// Collapsible buff sections of the calculator: open-state variable and the
	// function that opens / closes it. URLIN() closes them all.
	const SECTIONS = [
		["n_SkillSW", "BufSW"],
		["n_Skill3SW", "Buf3SW"],
		["n_Skill4SW", "Buf4SW"],
		["n_Skill6SW", "Buf6SW"],
		["n_Skill7SW", "Buf7SW"],
		["n_Skill8SW", "Buf8SW"],
		["n_Skill9SW", "Buf9SW"],
		["n_Skill10SW", "Buf10SW"],
		["n_debufSW", "debufSW"],
		["n_BbufSW", "EnemyBufSW"],
	];

	function loadBuildCode(fullCode) {
		const input = document.getElementById("otherURL_TEXT");
		if (!input || typeof URLIN !== "function") return false;
		const [code, comboKey] = String(fullCode).split(COMBO_MARK);
		const old = input.value;
		const enemy = form.B_Enemy ? form.B_Enemy.value : null;
		input.value = location.href.split("#")[0] + "#" + code;
		const open = SECTIONS.filter(([v]) => window[v]);
		applying = true;
		try {
			URLIN(1);
			// Sections that were open stay open (drawn with the loaded values).
			for (const [v, fn] of open) if (!window[v] && typeof window[fn] === "function") quietly(() => window[fn](1));
			if (enemy != null && form.B_Enemy.value !== enemy) {
				form.B_Enemy.value = enemy;
				if (typeof Bskill === "function") Bskill();
			}
			if (comboKey) {
				updateSkillCombos();
				const opt = [...form.A_ActiveSkill.options].find((o) => o.dataset.aaCombo === comboKey);
				if (opt) opt.selected = true;
			}
			window.calc();
		} finally {
			applying = false;
			input.value = old;
		}
		invalidate();
		refreshSelects();
		return true;
	}

	function jobName() {
		const o = form.A_JOB && form.A_JOB.selectedOptions[0];
		return o ? o.text.trim() : "";
	}

	function saveBuild(name, replaceId) {
		const code = captureBuild();
		if (!code) return;
		const entry = { id: replaceId || Math.random().toString(36).slice(2, 10), name, job: jobName(), code, savedAt: Date.now() };
		const i = state.builds.findIndex((b) => b.id === replaceId);
		if (i >= 0) state.builds[i] = entry;
		else state.builds.push(entry);
		save();
		renderPanel();
		renderBuildCompare();
	}

	// ---------------------------------------------------------------------------
	// "Save & Load" box: a row to save / load the character as Armory build
	// ---------------------------------------------------------------------------

	const armoryNames = h("datalist", { id: "aa-armory-builds" });
	const armoryInput = h("input", {
		type: "text",
		class: "aa-armoryname",
		list: "aa-armory-builds",
		placeholder: "Build-Name – zum Speichern frei wählbar, zum Laden einen gespeicherten wählen",
		autocomplete: "off",
	});
	const armoryStatus = h("span", { class: "aa-armorystatus aa-dim" });
	const armoryRow = h(
		"span",
		{ class: "aa-armoryrow" },
		h("br"),
		h("input", { type: "button", class: "saveURL", value: "Armory: Speichern", title: "Aktuellen Charakter als Build im Armory speichern", onclick: () => armorySave() }),
		" ",
		h("input", { type: "button", class: "loadURL", value: "Armory: Laden", title: "Gespeicherten Armory-Build in den Calculator laden", onclick: () => armoryLoad() }),
		" ",
		armoryInput,
		armoryNames,
		" ",
		armoryStatus
	);
	armoryInput.addEventListener("focus", updateArmoryNames);
	armoryInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			armoryLoad();
		}
	});

	function updateArmoryNames() {
		armoryNames.replaceChildren(...state.builds.map((b) => h("option", { value: b.name, label: b.job })));
	}

	function findBuildByName(name) {
		const n = name.trim().toLowerCase();
		return state.builds.find((b) => b.name.toLowerCase() === n) || null;
	}

	function armoryMessage(text, warn) {
		armoryStatus.textContent = text;
		armoryStatus.className = "aa-armorystatus " + (warn ? "aa-warn" : "aa-dim");
	}

	function armorySave() {
		const name = armoryInput.value.trim() || `${jobName()} ${state.builds.length + 1}`;
		const existing = findBuildByName(name);
		if (existing && !confirm(`„${existing.name}“ mit dem aktuellen Charakter überschreiben?`)) return;
		saveBuild(existing ? existing.name : name, existing ? existing.id : undefined);
		armoryInput.value = existing ? existing.name : name;
		updateArmoryNames();
		armoryMessage(existing ? `„${existing.name}“ überschrieben.` : `Als „${name}“ gespeichert.`);
	}

	function armoryLoad() {
		const b = findBuildByName(armoryInput.value);
		if (!b) return armoryMessage(armoryInput.value.trim() ? `Kein Build „${armoryInput.value.trim()}“ gespeichert.` : "Erst einen Build-Namen wählen.", true);
		loadBuildCode(b.code);
		renderPanel();
		armoryMessage(`„${b.name}“ geladen.`);
	}

	function placeArmoryRow() {
		if (armoryRow.isConnected) return;
		const anchor = document.getElementById("otherURL_TEXT");
		if (anchor) anchor.after(armoryRow);
	}
	placeArmoryRow();

	// The calculator's own "Local Save" slots (localStorage "Slot<value>").
	function calcSaveSlots() {
		const sel = form.A_SaveSlotLocal;
		if (!sel) return [];
		const slots = [];
		for (const opt of sel.options) {
			let data = null;
			try {
				data = JSON.parse(localStorage.getItem(`Slot${opt.value}`));
			} catch (e) {
				/* empty or deleted slot */
			}
			if (Array.isArray(data)) slots.push({ value: opt.value, label: opt.text, name: String(data[440] || opt.text.replace(/^Save \d+:\s*/, "")).trim() });
		}
		return slots;
	}

	// Imports the "Local Save" slots as builds, loading each through the
	// calculator's LoadLocal() and storing it in the URL format. Restores the
	// current character, monster, slot selection and slot name afterwards.
	function importCalcSaves() {
		const sel = form.A_SaveSlotLocal;
		const slots = calcSaveSlots();
		if (!sel || !slots.length || typeof LoadLocal !== "function") return { added: 0, skipped: 0 };
		const current = captureBuild();
		const oldSlot = sel.value;
		const nameField = form.elements.namedItem("SlotName");
		const oldName = nameField ? nameField.value : null;
		const enemy = form.B_Enemy ? form.B_Enemy.value : null;
		const alert = window.alert;
		let added = 0;
		let skipped = 0;
		applying = true;
		window.alert = () => {};
		try {
			for (const slot of slots) {
				sel.value = slot.value;
				LoadLocal();
				const code = captureBuild();
				if (!code || state.builds.some((b) => b.code === code)) {
					skipped++;
					continue;
				}
				state.builds.push({ id: Math.random().toString(36).slice(2, 10), name: slot.name, job: jobName(), code, savedAt: Date.now(), source: slot.label.split(":")[0] });
				added++;
			}
		} finally {
			window.alert = alert;
			applying = false;
			sel.value = oldSlot;
			if (nameField) nameField.value = oldName;
			if (enemy != null) form.B_Enemy.value = enemy;
			loadBuildCode(current);
		}
		save();
		return { added, skipped };
	}

	// Values of every metric for the current character.
	function currentMetrics() {
		const row = {};
		for (const m of ["dps", "hit", "def"]) {
			metricOverride = m;
			try {
				row[m] = baseline();
			} finally {
				metricOverride = null;
			}
		}
		row.hp = (document.getElementById("A_MaxHP") || {}).textContent || "";
		return row;
	}

	// Static copy of the calculator's combat result box (#cresults): selects
	// become their text, the "All Damage Skills / ReCalculate" row is dropped and
	// ids / names / handlers are removed so the original stays the only one.
	function snapshotCombatBox() {
		const box = document.getElementById("cresults");
		if (!box) return null;
		const copy = box.cloneNode(true);
		const origSelects = box.querySelectorAll("select");
		copy.querySelectorAll("select").forEach((sel, i) => {
			const o = origSelects[i] && origSelects[i].selectedOptions[0];
			sel.replaceWith(h("span", { class: "aa-bvval" }, o ? o.text.trim() : ""));
		});
		const first = copy.querySelector("#all_dmgSkills");
		if (first) first.closest("tr").remove();
		// Character values that are not part of the box: Max HP, Max SP, ASPD.
		const body = copy.tBodies[0] || copy;
		const stat = (label, id) => {
			const v = document.getElementById(id);
			return h("tr", { class: "aa-bvstat" }, h("td", { class: "right" }, label), h("td", null, v ? v.textContent.trim() : "–"));
		};
		body.prepend(stat("Max HP", "A_MaxHP"), stat("Max SP", "A_MaxSP"), stat("ASPD", "A_ASPD"));
		copy.querySelectorAll("input, button, script").forEach((n) => n.remove());
		for (const n of [copy, ...copy.querySelectorAll("*")]) {
			for (const a of [...n.attributes]) {
				if (a.name === "id" || a.name === "name" || a.name === "for" || a.name.startsWith("on")) n.removeAttribute(a.name);
			}
		}
		copy.style.float = "none";
		copy.classList.add("aa-bvbox");
		return copy;
	}

	// The character currently set up in the calculator, usable like a saved build
	// in the build comparison and the Party-Battle. Its code is taken when the
	// calculation starts, so the comparison shows the state of that moment.
	// "Aktueller Charakter" in the build searches takes a snapshot of the current
	// character: a build that only lives in the build comparison / Party-Battle
	// and can be loaded or overwritten with the current character again.
	const CURRENT_ID = "current";
	const currentPseudo = () => ({ id: CURRENT_ID, name: "Aktueller Charakter", job: jobName(), current: true });
	const lookupBuild = (id) => state.builds.find((b) => b.id === id) || state.snapshots.find((b) => b.id === id);

	function snapshotLabel(at) {
		const d = new Date(at);
		return `Snapshot ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	}

	function takeSnapshot() {
		const at = Date.now();
		const snap = { id: "snap-" + Math.random().toString(36).slice(2, 10), name: snapshotLabel(at), job: jobName(), code: captureBuild(), savedAt: at, snapshot: true };
		state.snapshots = [...state.snapshots, snap];
		save();
		return snap;
	}

	// Overwrites a snapshot with the current character and recalculates where it is used.
	function overwriteSnapshot(id) {
		const snap = state.snapshots.find((x) => x.id === id);
		if (!snap) return;
		snap.code = captureBuild();
		snap.job = jobName();
		snap.savedAt = Date.now();
		snap.name = snapshotLabel(snap.savedAt);
		partySkills.delete(id);
		save();
		if (state.settings.compareBuilds.includes(id)) {
			evaluateBuilds([snap]).forEach((v, k) => bv.results.set(k, v));
			renderBuildCompare();
		}
		if (state.settings.party.some((m) => m.build === id)) evaluateParty();
	}

	// Snapshots that are in neither section anymore are dropped, and so are
	// entries whose build no longer exists.
	function pruneSnapshots() {
		const used = new Set([...state.settings.compareBuilds, ...state.settings.party.map((m) => m.build)]);
		state.snapshots = state.snapshots.filter((x) => used.has(x.id));
		state.settings.compareBuilds = state.settings.compareBuilds.filter((id) => lookupBuild(id));
		state.settings.party = state.settings.party.filter((m) => lookupBuild(m.build));
	}

	// Metrics and combat box of each build against the current monster; the
	// current character is restored afterwards.
	function evaluateBuilds(builds) {
		const current = captureBuild();
		const out = new Map();
		try {
			for (const b of builds) {
				loadBuildCode(b.code);
				out.set(b.id, { ...currentMetrics(), box: snapshotCombatBox() });
			}
		} finally {
			loadBuildCode(current);
			// The loads rebuilt selects; refreshSelects() already ran, so these are not
			// a change the user made (would mark the comparison as outdated).
			formObserver.takeRecords();
		}
		return out;
	}

	function renderBuilds() {
		const nameInput = h("input", { type: "text", class: "aa-bname", placeholder: `Name, z. B. „${jobName()} MVP“`, maxlength: "60" });
		const saveNew = () => saveBuild(nameInput.value.trim() || `${jobName()} ${state.builds.length + 1}`);
		nameInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") saveNew();
		});
		return [
			h("p", { class: "aa-hint" }, "Speichert den kompletten Charakter (Klasse, Stats, Ausrüstung mit Refine und Karten, Skill, Buffs). Laden behält das aktuell gewählte Monster. Zum Vergleichen: Abschnitt „Build-Vergleich“ unter dem Combat Simulator."),
			h("div", { class: "aa-row" }, nameInput, h("button", { type: "button", class: "aa-btn aa-primary", onclick: saveNew }, "Speichern")),
			(() => {
				const slots = calcSaveSlots();
				if (!slots.length) return null;
				return h(
					"div",
					{ class: "aa-row" },
					h(
						"button",
						{
							type: "button",
							class: "aa-btn",
							title: "Übernimmt die „Local Save“-Slots des Calculators als Builds (bereits übernommene werden übersprungen)",
							onclick: (e) => {
								e.target.disabled = true;
								e.target.textContent = "Importiere …";
								setTimeout(() => {
									ui.buildImport = importCalcSaves();
									renderPanel();
									renderBuildCompare();
								}, 30);
							},
						},
						`${slots.length} Calculator-Saves importieren`
					),
					ui.buildImport ? h("span", { class: "aa-dim" }, `${ui.buildImport.added} übernommen, ${ui.buildImport.skipped} schon vorhanden`) : null
				);
			})(),
			state.builds.length === 0 ? h("p", { class: "aa-hint" }, "Noch keine Builds gespeichert.") : null,
			h(
				"div",
				{ class: "aa-group" },
				state.builds.map((b) =>
					h(
						"div",
						{ class: "aa-item" },
						h("div", { class: "aa-iname" }, b.name, h("div", { class: "aa-dim" }, `${b.job} · ${b.source ? b.source + " · " : ""}${new Date(b.savedAt).toLocaleString()}`)),
						h("button", { type: "button", class: "aa-btn aa-small", title: "Diesen Build in den Calculator laden", onclick: () => (loadBuildCode(b.code), renderPanel()) }, "Laden"),
						h("button", { type: "button", class: "aa-btn aa-small", title: "Mit dem aktuellen Charakter überschreiben", onclick: () => confirm(`„${b.name}“ mit dem aktuellen Charakter überschreiben?`) && saveBuild(b.name, b.id) }, "Aktualisieren"),
						h(
							"button",
							{
								type: "button",
								class: "aa-x",
								title: "Löschen",
								onclick: () => {
									if (!confirm(`Build „${b.name}“ löschen?`)) return;
									state.builds = state.builds.filter((x) => x.id !== b.id);
									state.settings.compareBuilds = state.settings.compareBuilds.filter((id) => id !== b.id);
									state.settings.party = state.settings.party.filter((m) => m.build !== b.id);
									bv.results.delete(b.id);
									save();
									renderPanel();
									renderBuildCompare();
								},
							},
							"×"
						)
					)
				)
			),
		];
	}

	// ---------------------------------------------------------------------------
	// "Build-Vergleich" section below the combat simulator
	// ---------------------------------------------------------------------------

	// Search field for saved builds (name or class). One element per section that
	// survives the section's redraws, so typing isn't interrupted by a
	// recalculation. getBuilds() gives the builds that can be picked.
	function buildSearch({ getBuilds, onPick, placeholder }) {
		const input = h("input", { type: "text", class: "aa-bsinput", placeholder, autocomplete: "off", spellcheck: "false" });
		const list = h("div", { class: "aa-bslist" });
		const wrap = h("span", { class: "aa-bsearch" }, input, list);
		let shown = [];
		let active = 0;
		const close = () => {
			list.classList.remove("aa-open");
			list.replaceChildren();
		};
		const pick = (b) => {
			input.value = "";
			close();
			onPick(b);
		};
		const render = () => {
			const tokens = searchNorm(input.value).split(" ").filter(Boolean);
			const all = getBuilds();
			shown = all.filter((b) => {
				const hay = " " + searchNorm(`${b.name} ${b.job} ${(JOB_ALIASES[b.job] || []).join(" ")}`);
				return tokens.every((t) => hay.includes(" " + t) || hay.includes(t));
			});
			active = Math.min(active, Math.max(0, shown.length - 1));
			list.replaceChildren(
				...(shown.length
					? shown.map((b, i) =>
							h(
								"div",
								{
									class: "aa-crow" + (i === active ? " aa-active" : ""),
									onmousedown: (e) => e.preventDefault(),
									onclick: () => pick(b),
								},
								h("div", { class: "aa-cmain" }, h("div", { class: "aa-cname" }, b.name), h("div", { class: "aa-dim" }, b.job))
							)
					  )
					: [h("div", { class: "aa-bsempty aa-dim" }, all.length ? "Kein Build passt" : "Keine Builds verfügbar")])
			);
			list.classList.add("aa-open");
			const el = list.children[active];
			if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
		};
		input.addEventListener("focus", () => {
			active = 0;
			render();
		});
		input.addEventListener("input", () => {
			active = 0;
			render();
		});
		input.addEventListener("blur", close);
		// Also on any click outside (a blur doesn't always arrive, e.g. when the
		// field lost the focus while the window was in the background).
		document.addEventListener("mousedown", (e) => {
			if (list.classList.contains("aa-open") && !wrap.contains(e.target)) close();
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				if (!list.classList.contains("aa-open")) return render();
				active = Math.max(0, Math.min(shown.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
				render();
			} else if (e.key === "Enter") {
				e.preventDefault();
				if (shown[active]) pick(shown[active]);
			} else if (e.key === "Escape") {
				input.value = "";
				close();
				input.blur();
			}
		});
		return wrap;
	}

	const bv = { results: new Map(), enemy: null }; // build id -> { metrics, box }; enemy they were computed for
	const bvBody = h("div", { class: "main aa-bv" });

	// A section's search field stays where it is when the section is redrawn:
	// taking a focused field out of the page (even to put it back) drops the
	// focus, so a redraw during a click into it lost the input. Only the parts
	// next to and below it are replaced.
	function sectionLayout(body, search) {
		const extra = h("span", { class: "aa-barextra" });
		const rest = h("div", { class: "aa-sectionrest" });
		const bar = h("div", { class: "aa-bvbar" }, search, extra);
		return {
			render(barItems, restItems) {
				if (bar.parentNode !== body) body.replaceChildren(bar, rest);
				extra.replaceChildren(...barItems.filter((x) => x != null && x !== ""));
				rest.replaceChildren(...restItems.filter((x) => x != null && x !== ""));
			},
		};
	}
	const bvSection = h("div", { class: "aa-bv" }, h("br"), h("h3", { class: "theader4 aa-bvtitle" }, "⚔ Build-Vergleich"), bvBody);

	function placeBuildCompare() {
		if (!bvSection.isConnected) {
			const title = [...document.querySelectorAll("h3")].find((x) => /Combat Simulator/.test(x.textContent));
			const block = title && title.nextElementSibling;
			if (block) block.after(bvSection);
		}
		if (bvSection.isConnected && bvSection.nextElementSibling !== partySection) bvSection.after(partySection);
	}

	function computeBuildCompare() {
		const builds = state.settings.compareBuilds.map(lookupBuild).filter(Boolean);
		bv.results = evaluateBuilds(builds);
		bv.enemy = form.B_Enemy ? form.B_Enemy.value : null;
		renderBuildCompare();
	}

	function addToCompare(id) {
		if (!id || state.settings.compareBuilds.includes(id)) return;
		state.settings.compareBuilds = [...state.settings.compareBuilds, id];
		save();
		const b = lookupBuild(id);
		if (b) {
			const enemy = form.B_Enemy ? form.B_Enemy.value : null;
			if (bv.enemy != null && bv.enemy !== enemy) computeBuildCompare(); // others are outdated too
			else {
				evaluateBuilds([b]).forEach((v, k) => bv.results.set(k, v));
				bv.enemy = enemy;
			}
		}
		renderBuildCompare();
	}

	function removeFromCompare(id) {
		state.settings.compareBuilds = state.settings.compareBuilds.filter((x) => x !== id);
		bv.results.delete(id);
		pruneSnapshots();
		save();
		renderBuildCompare();
	}

	const bvSearch = buildSearch({
		getBuilds: () => [currentPseudo(), ...state.builds.filter((b) => !state.settings.compareBuilds.includes(b.id))],
		onPick: (b) => addToCompare(b.current ? takeSnapshot().id : b.id),
		placeholder: "Build zum Vergleich hinzufügen – Name oder Klasse …",
	});

	const bvLayout = sectionLayout(bvBody, bvSearch);

	function renderBuildCompare() {
		placeBuildCompare();
		const chosen = state.settings.compareBuilds.map(lookupBuild).filter(Boolean);
		const monster = form.B_Enemy ? form.B_Enemy.selectedOptions[0].text : "";
		const enemy = form.B_Enemy ? form.B_Enemy.value : null;
		const stale = chosen.length > 0 && (bv.enemy !== enemy || chosen.some((b) => !bv.results.has(b.id)));

		const card = (b) => {
			const res = bv.results.get(b.id);
			return h(
				"div",
				{ class: "aa-bvcard" },
				h(
					"div",
					{ class: "aa-bvhead" },
					h("div", { class: "aa-bvname" }, h("strong", null, b.name), h("div", { class: "aa-dim" }, b.job)),
					h("button", { type: "button", class: "aa-btn aa-small", title: "Diesen Build in den Calculator laden", onclick: () => loadBuildCode(b.code) }, "Laden"),
					b.snapshot ? h("button", { type: "button", class: "aa-btn aa-small", title: "Snapshot mit dem aktuellen Charakter überschreiben", onclick: () => overwriteSnapshot(b.id) }, "Überschreiben") : null,
					h("button", { type: "button", class: "aa-x", title: "Aus dem Vergleich entfernen", onclick: () => removeFromCompare(b.id) }, "×")
				),
				res && res.box ? res.box : h("p", { class: "aa-hint aa-bvempty" }, "Noch nicht berechnet – „Neu berechnen“ klicken.")
			);
		};

		bvLayout.render(
			[
				chosen.length ? h("button", { type: "button", class: "aa-btn aa-small" + (stale ? " aa-primary" : ""), onclick: computeBuildCompare }, "Neu berechnen") : null,
				h("span", { class: "aa-dim" }, `Gegen: ${monster}`),
				stale ? h("span", { class: "aa-warn" }, "Monster geändert – neu berechnen") : null,
			],
			[
				state.builds.length === 0 && !chosen.length
					? h("p", { class: "aa-hint" }, "Den aktuellen Charakter oder gespeicherte Builds hinzufügen. Builds speichern: Armory-Panel → „Builds“ (oder die Calculator-Saves importieren).")
					: "",
				chosen.length ? h("div", { class: "aa-bvcards" }, chosen.map(card)) : "",
			]
		);
		renderParty();
	}

	// ---------------------------------------------------------------------------
	// "Party-Battle" section: several builds (also the same one twice), each with
	// its own attack skill, against the current monster
	// ---------------------------------------------------------------------------

	const pb = { results: new Map(), enemy: null, hp: 0, played: [], songs: [] }; // member uid -> { dps, hit, interval, skill | song }
	const partySkills = new Map(); // build id -> { options: [{ value, text }], own: value of the saved skill }
	const partyBody = h("div", { class: "main aa-bv aa-party" });
	const partySection = h("div", { class: "aa-bv" }, h("br"), h("h3", { class: "theader4 aa-bvtitle" }, "⚔ Party-Battle"), partyBody);

	const partyMembers = () => state.settings.party.map((m) => ({ ...m, b: lookupBuild(m.build) })).filter((m) => m.b);

	// Support songs of Bard / Clown and Dancer / Gypsy, as the calculator's
	// "Music and Dance Skills" keep them in n_A_Buf3: song level, the performer's
	// stats the effect scales with and Music / Dance Lessons. A performing member
	// deals no damage; every other member gets the songs (not the performer
	// itself, as in the game). Ensembles need two performers and are left out.
	const SONGS = [
		{ key: "whistle", name: "A Whistle", bard: true, lv: 0, lessons: 30, stats: [[20, "AGI"], [19, "LUK"]] },
		{ key: "acos", name: "Assassin Cross of Sunset", bard: true, lv: 1, lessons: 31, stats: [[21, "AGI"]] },
		{ key: "bragi", name: "A Poem of Bragi", bard: true, lv: 2, lessons: 32, stats: [[22, "DEX"], [29, "INT", 150]] },
		{ key: "idun", name: "The Apple of Idun", bard: true, lv: 3, lessons: 33, stats: [[23, "VIT"]] },
		{ key: "humming", name: "Humming", bard: false, lv: 4, lessons: 34, stats: [[24, "DEX"]] },
		{ key: "kiss", name: "Fortune's Kiss", bard: false, lv: 5, lessons: 35, stats: [[25, "LUK"]] },
		{ key: "service", name: "Service for You", bard: false, lv: 6, lessons: 36, stats: [[26, "INT"]] },
		{ key: "pdfm", name: "Please Don't Forget Me", bard: false, lv: 37, lessons: 27, stats: [[38, "DEX"], [39, "AGI"]] },
	];
	// Ensembles (Bard/Minstrel + Dancer/Gypsy together), level 5. Mr. Kim A Rich
	// Man (EXP only) is left out.
	const ENSEMBLES = [
		{ key: "siegfried", name: "Invulnerable Siegfried", idx: 7, info: "Element-Resistenz +80 %, Status-Resistenz" },
		{ key: "drum", name: "A Drum on the Battlefield", idx: 9, info: "ATK +150, DEF +12" },
		{ key: "nibelungen", name: "The Ring of Nibelungen", idx: 10, info: "ATK +175 mit Level-4-Waffen" },
	];
	const SONG_PREFIX = "song:";
	const songOf = (skill) => (typeof skill === "string" && skill.startsWith(SONG_PREFIX) ? SONGS.find((x) => x.key === skill.slice(SONG_PREFIX.length)) : null);

	// true = Bard / Clown, false = Dancer / Gypsy, null = no performer.
	function performerKind(job) {
		const J = typeof JOBID !== "undefined" ? JOBID : {};
		if (job === J.BARD || job === J.CLOWN) return true;
		if (job === J.DANCER || job === J.GYPSY) return false;
		return null;
	}

	// Song as the loaded (performing) build plays it: level 10, its final stats,
	// its Music / Dance Lessons level (10 when the calculator has no such field).
	function songFromCurrent(song) {
		const lessonsId = typeof SKILLID !== "undefined" ? (song.bard ? SKILLID.BA_MUSICALLESSON : SKILLID.DC_DANCINGLESSON) : null;
		const known = typeof m_JobBuff !== "undefined" && m_JobBuff[n_A_JOB] && m_JobBuff[n_A_JOB].includes(lessonsId);
		const stat = { AGI: n_A_AGI, LUK: n_A_LUK, DEX: n_A_DEX, INT: n_A_INT, VIT: n_A_VIT };
		return {
			song,
			lessons: known && typeof SkillSearch === "function" ? SkillSearch(lessonsId) : 10,
			stats: song.stats.map(([idx, name, max]) => [idx, Math.max(1, Math.min(max || 200, Math.round(stat[name]) || 1))]),
		};
	}

	// Puts the played songs on the loaded build; the "Music and Dance Skills"
	// section (if open) is redrawn from these values so calc() reads them.
	function applySongs(played, ensembles = []) {
		if ((!played.length && !ensembles.length) || typeof n_A_Buf3 === "undefined") return;
		for (const e of ensembles) n_A_Buf3[e.idx] = 5;
		for (const p of played) {
			n_A_Buf3[p.song.lv] = 10;
			n_A_Buf3[p.song.lessons] = p.lessons;
			for (const [idx, value] of p.stats) n_A_Buf3[idx] = value;
		}
		// Redraw all song rows, so their stat fields are rebuilt from these values.
		if (typeof SWs3sw !== "undefined") SWs3sw.fill(0);
		if (typeof Buf3SW === "function" && typeof n_Skill3SW !== "undefined") quietly(() => Buf3SW(n_Skill3SW));
	}

	// Gospel effects of a Paladin ("Supportive / Party Skills"): n_A_Buf2[16] =
	// All Stats +20, n_A_Buf2[19] = ATK +100%. Per member: null = as the build
	// was saved, true / false = switched on / off in the Party-Battle.
	const GOSPEL = { stats: 16, atk: 19 };

	function buildGospel() {
		return typeof n_A_Buf2 === "undefined" ? { stats: false, atk: false } : { stats: Boolean(n_A_Buf2[GOSPEL.stats]), atk: Boolean(n_A_Buf2[GOSPEL.atk]) };
	}

	// Buffs of the party for everyone (n_A_Buf2 index → value as in the
	// calculator's "Supportive / Party Skills"). A switched-on buff is put on top
	// of what the build saved; switched off, the build keeps its own.
	const PARTY_BUFFS = [
		{ key: "gloria", name: "Gloria", idx: 3, value: 1, info: "LUK +30" },
		{ key: "angelus", name: "Angelus", idx: 4, value: 10, info: "Level 10: VIT-DEF +50 %" },
		{ key: "ar", name: "Adrenaline Rush", idx: 6, value: 1, info: "Regular AR: ASPD mit Axt / Keule" },
		{ key: "wp", name: "Weapon Perfection", idx: 7, value: 1, info: "kein Größen-Malus" },
		{ key: "pt", name: "Power-Thrust", idx: 8, value: 1, info: "ATK +5 % für die Party" },
	];

	// Sets n_A_Buf2 values on the loaded build ({ index: value }); an open
	// "Supportive / Party Skills" section is read by calc(), so it is redrawn.
	function applyBuf2(values) {
		if (typeof n_A_Buf2 === "undefined") return;
		let changed = false;
		for (const [idx, v] of Object.entries(values)) {
			if (Number(n_A_Buf2[idx]) === v) continue;
			n_A_Buf2[idx] = v;
			changed = true;
		}
		if (changed && typeof BufSW === "function" && typeof n_SkillSW !== "undefined" && n_SkillSW) quietly(() => BufSW(n_SkillSW));
	}

	// Gospel of the member and the party buffs.
	function applyGospel(g) {
		const values = {};
		for (const b of PARTY_BUFFS) if (state.settings.partyBuffs.includes(b.key) && typeof n_A_Buf2 !== "undefined" && Number(n_A_Buf2[b.idx]) < b.value) values[b.idx] = b.value;
		for (const [k, idx] of Object.entries(GOSPEL)) if (g && g[k] != null) values[idx] = g[k] ? 1 : 0;
		applyBuf2(values);
	}

	// Puts the member's attack skill on the loaded build (max level, as the
	// calculator does when a skill is picked).
	function applyPartySkill(skill) {
		const sel = form.A_ActiveSkill;
		if (skill == null || songOf(skill) || !sel) return;
		updateSkillCombos();
		if (String(skill).startsWith(COMBO_PREFIX)) {
			const opt = [...sel.options].find((o) => o.dataset.aaCombo === String(skill).slice(COMBO_PREFIX.length));
			if (!opt || opt.selected) return;
			opt.selected = true;
		} else {
			if (!hasOption(sel, skill) || (sel.value === String(skill) && !activeCombo())) return;
			sel.value = String(skill);
		}
		if (typeof ClickActiveSkill === "function") quietly(() => ClickActiveSkill());
	}

	// Ensembles in effect: switched on and both a Bard/Minstrel and a Dancer/Gypsy
	// are members (their kind is known once a build was loaded once).
	function partyEnsembleState() {
		const kinds = new Set(partyMembers().map((m) => (partySkills.get(m.build) || {}).kind).filter((k) => k != null));
		const possible = kinds.has(true) && kinds.has(false);
		return { possible, active: possible ? ENSEMBLES.filter((e) => state.settings.partyEnsembles.includes(e.key)) : [] };
	}

	// Monster attack the Party-Battle uses: its own choice or the calculator's.
	function partyAtkNow() {
		const v = state.settings.partyMonsterAtk;
		const sel = form.B_AtkSkill;
		if (v != null && sel && hasOption(sel, v)) return String(v);
		return sel ? sel.value : null;
	}

	// Sets the monster attack like the calculator's own list does: some attacks
	// need an extra field (e.g. "Players in Range" for Brandish Spear) that
	// BClickAtkSkill() creates; its closing calc() is skipped here.
	function setMonsterAtk(value, subValue) {
		const sel = form.B_AtkSkill;
		if (!sel || value == null || !hasOption(sel, value)) return;
		const sub = form.BSkillSubNum;
		if (sel.value === String(value) && (subValue == null || (sub && "value" in sub && String(sub.value) === String(subValue)))) return;
		sel.value = String(value);
		if (typeof BClickAtkSkill === "function") {
			const calcFn = window.calc;
			window.calc = () => {};
			try {
				BClickAtkSkill();
			} finally {
				window.calc = calcFn;
			}
		}
		if (subValue != null && form.BSkillSubNum && "value" in form.BSkillSubNum) form.BSkillSubNum.value = subValue;
	}

	// Earth Quake (melee / ranged) splits its damage over the players in range.
	const EARTHQUAKE = new Set(["444", "445"]);

	// "Players in Range" for Earth Quake: own value or the number of members
	// (performers count, they are hit as well).
	function partyEqPlayers() {
		const n = state.settings.partyEqPlayers ?? state.settings.party.filter((m) => lookupBuild(m.build)).length;
		return String(Math.max(1, Math.min(99, Math.round(Number(n)) || 1)));
	}

	// Value of the monster attack's extra field for the Party-Battle.
	function partyAtkSub(atk, calcSub) {
		if (EARTHQUAKE.has(String(atk))) return partyEqPlayers();
		return state.settings.partyMonsterAtk == null ? calcSub : null;
	}

	// The Party-Battle's monster attack on the loaded build (a build brings the
	// attack it was saved with; "as in the calculator" = the one chosen there).
	let partyAtk = { value: null, sub: null };
	function applyMonsterAtk() {
		setMonsterAtk(partyAtk.value, partyAtk.sub);
	}

	// Damage taken by the loaded build (after the last calculation).
	function takenNow() {
		const recv = damageReceived();
		const hp = Number(String((document.getElementById("A_MaxHP") || {}).textContent || "").replace(/[^\d.]/g, "")) || 0;
		return { recv, maxHp: hp, hits: recv > 0 ? hp / recv : Infinity };
	}

	function evaluateParty() {
		const members = partyMembers();
		const current = captureBuild();
		const atkBefore = form.B_AtkSkill ? form.B_AtkSkill.value : null;
		const subBefore = form.BSkillSubNum && "value" in form.BSkillSubNum ? form.BSkillSubNum.value : null;
		pb.atk = partyAtkNow();
		pb.pending = false;
		partyAtk = { value: pb.atk, sub: partyAtkSub(pb.atk, subBefore) };
		pb.eq = EARTHQUAKE.has(String(pb.atk)) ? partyAtk.sub : null;
		pb.results = new Map();
		pb.enemy = form.B_Enemy ? form.B_Enemy.value : null;
		const cacheSkills = (m) => {
			const sel = form.A_ActiveSkill;
			if (!sel || partySkills.has(m.build)) return;
			updateSkillCombos();
			const kind = performerKind(n_A_JOB);
			const ownCombo = activeCombo();
			partySkills.set(m.build, {
				gospel: buildGospel(),
				own: ownCombo ? COMBO_PREFIX + ownCombo.key : sel.value,
				options: [...sel.options].filter((o) => !o.disabled).map((o) => ({ value: o.dataset.aaCombo ? COMBO_PREFIX + o.dataset.aaCombo : o.value, text: o.text.trim() })),
				songs: kind == null ? [] : SONGS.filter((x) => x.bard === kind),
				kind,
			});
		};
		try {
			// 1) Performers: which songs, with which stats.
			const played = [];
			for (const m of members) {
				const song = songOf(m.skill);
				if (!song && partySkills.has(m.build)) continue;
				loadBuildCode(m.b.code);
				cacheSkills(m);
				if (!song || performerKind(n_A_JOB) !== song.bard) continue;
				applyGospel(m.gospel);
				simulating = true;
				try {
					origCalc(); // stats with Gospel for the song
				} finally {
					simulating = false;
				}
				played.push({ ...songFromCurrent(song), uid: m.uid });
				applyMonsterAtk();
				simulating = true;
				try {
					origCalc();
				} finally {
					simulating = false;
				}
				pb.results.set(m.uid, { hit: 0, interval: 0, dps: 0, song: song.name, ...takenNow() });
			}
			const ensembles = partyEnsembleState().active;
			pb.ensembles = ensembles.map((e) => e.name);
			pb.played = played;
			pb.songs = played.map((p) => p.song.name);
			// 2) Everyone else, with the songs of the other members.
			for (const m of members) {
				if (pb.results.has(m.uid)) continue;
				loadBuildCode(m.b.code);
				cacheSkills(m);
				applyPartySkill(m.skill);
				applySongs(
					played.filter((p) => p.uid !== m.uid),
					ensembles
				);
				applyGospel(m.gospel);
				applyMonsterAtk();
				const sel = form.A_ActiveSkill;
				simulating = true;
				try {
					origCalc();
				} finally {
					simulating = false;
				}
				const { hit, interval } = attackNow();
				pb.results.set(m.uid, { hit, interval, dps: interval > 0 ? hit / interval : hit, skill: sel && sel.selectedOptions[0] ? sel.selectedOptions[0].text.trim() : "", ...takenNow() });
			}
		} finally {
			loadBuildCode(current);
			if (form.B_AtkSkill && atkBefore != null && form.B_AtkSkill.value !== atkBefore) {
				setMonsterAtk(atkBefore, subBefore);
				window.calc();
			}
			formObserver.takeRecords();
		}
		pb.hp = typeof n_B !== "undefined" ? Number(n_B[6]) || 0 : 0;
		renderParty();
	}

	function addPartyMember(buildId) {
		if (!lookupBuild(buildId)) return;
		state.settings.party = [...state.settings.party, { uid: Math.random().toString(36).slice(2, 10), build: buildId, skill: null }];
		save();
		evaluateParty();
	}

	function updatePartyMember(uid, patch) {
		state.settings.party = state.settings.party.map((m) => (m.uid === uid ? { ...m, ...patch } : m));
		save();
		evaluateParty();
	}

	function removePartyMember(uid) {
		state.settings.party = state.settings.party.filter((m) => m.uid !== uid);
		pb.results.delete(uid);
		pruneSnapshots();
		save();
		renderParty();
	}

	// Loads the member as calculated here: its skill and the songs the others play.
	function loadPartyMember(m) {
		const atk = partyAtkNow();
		const sub = partyAtkSub(atk, form.BSkillSubNum && "value" in form.BSkillSubNum ? form.BSkillSubNum.value : null);
		loadBuildCode(m.b.code);
		applyPartySkill(m.skill);
		if (!songOf(m.skill)) applySongs((pb.played || []).filter((p) => p.uid !== m.uid), partyEnsembleState().active);
		applyGospel(m.gospel);
		setMonsterAtk(atk, sub);
		window.calc();
	}

	// Fight with late starters: a member attacks once the monster's HP is at or
	// below its start %. Between two start marks only the members already in
	// deal damage. Returns the kill time, each member's damage and start time.
	function partyFight(entries, hp) {
		const cuts = [...new Set(entries.map((e) => e.start).filter((x) => x > 0 && x < 100))].sort((a, b) => b - a);
		cuts.push(0);
		const dealt = new Map(entries.map((e) => [e.uid, 0]));
		const startAt = new Map();
		let cur = 100;
		let t = 0;
		for (const next of cuts) {
			const active = entries.filter((e) => e.start >= cur && e.dps > 0);
			const dps = active.reduce((sum, e) => sum + e.dps, 0);
			if (!(dps > 0)) return { time: Infinity, dealt, startAt, stuckAt: cur };
			for (const e of active) if (!startAt.has(e.uid)) startAt.set(e.uid, t);
			const dt = ((cur - next) / 100) * hp / dps;
			for (const e of active) dealt.set(e.uid, dealt.get(e.uid) + e.dps * dt);
			t += dt;
			cur = next;
		}
		return { time: t, dealt, startAt };
	}

	function setPartyStart(uid, value) {
		const v = Math.max(1, Math.min(100, Math.round(Number(value)) || 100));
		state.settings.party = state.settings.party.map((m) => (m.uid === uid ? { ...m, start: v } : m));
		save();
		renderParty(); // no recalculation needed: only the timeline changes
	}

	function formatDuration(sec) {
		if (!Number.isFinite(sec)) return "–";
		if (sec < 60) return sec.toFixed(1) + " s";
		const m = Math.floor(sec / 60);
		if (m < 60) return `${m}:${String(Math.round(sec - 60 * m)).padStart(2, "0")} min`;
		return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")} h`;
	}

	const partySearch = buildSearch({
		getBuilds: () => [currentPseudo(), ...state.builds],
		onPick: (b) => addPartyMember(b.current ? takeSnapshot().id : b.id),
		placeholder: "Build zur Party hinzufügen – Name oder Klasse …",
	});

	const partyLayout = sectionLayout(partyBody, partySearch);

	function renderParty() {
		placeBuildCompare();
		const members = partyMembers();
		if (members.length && !pb.autoRan && !simulating) {
			pb.autoRan = true;
			setTimeout(evaluateParty, 0); // after a reload: skill lists and values
		}
		// Another monster or monster attack (e.g. picked in the calculator's own
		// list): the values are outdated, calculate again right away.
		if (members.length && pb.results.size && !pb.pending && !simulating && (pb.atk !== partyAtkNow() || pb.enemy !== (form.B_Enemy ? form.B_Enemy.value : null) || (pb.eq != null && pb.eq !== partyEqPlayers()))) {
			pb.pending = true;
			setTimeout(evaluateParty, 0);
		}
		const enemy = form.B_Enemy ? form.B_Enemy.value : null;
		const stale = members.length > 0 && (pb.enemy !== enemy || members.some((m) => !pb.results.has(m.uid)));
		const monster = form.B_Enemy && form.B_Enemy.selectedOptions[0] ? form.B_Enemy.selectedOptions[0].text.trim() : "";
		const known = members.map((m) => pb.results.get(m.uid)).filter(Boolean);
		const total = known.reduce((sum, r) => sum + r.dps, 0);
		const hp = pb.hp || (typeof n_B !== "undefined" ? Number(n_B[6]) || 0 : 0);
		const startOf = (m) => m.start ?? 100;
		const fight = partyFight(
			members.filter((m) => pb.results.has(m.uid)).map((m) => ({ uid: m.uid, dps: pb.results.get(m.uid).dps, start: startOf(m) })),
			hp
		);
		const ttk = fight.time;
		const late = members.some((m) => startOf(m) < 100 && pb.results.get(m.uid) && pb.results.get(m.uid).dps > 0);

		const atkSel = form.B_AtkSkill;
		const monsterAtkSelect = h(
			"label",
			{ title: "Angriff des Monsters, gegen den der erlittene Schaden je Mitglied gerechnet wird" },
			"Monster-Angriff: ",
			h(
				"select",
				{
					class: "aa-pbatk",
					onchange: (e) => {
						state.settings.partyMonsterAtk = e.target.value === "" ? null : e.target.value;
						save();
						evaluateParty();
					},
				},
				h("option", { value: "", selected: state.settings.partyMonsterAtk == null }, `wie im Calculator (${atkSel && atkSel.selectedOptions[0] ? atkSel.selectedOptions[0].text.trim() : "–"})`),
				atkSel ? [...atkSel.options].map((o) => h("option", { value: o.value, selected: state.settings.partyMonsterAtk === o.value }, o.text.trim())) : null
			)
		);
		// Earth Quake: players in range, preset to the party size.
		const eqInput = h("input", {
			type: "number",
			class: "aa-pbeq",
			min: "1",
			max: "99",
			placeholder: String(members.length),
			value: state.settings.partyEqPlayers ?? "",
			title: "Leer = Anzahl der Party-Mitglieder. Mehr eintragen, wenn weitere Spieler im Bereich stehen.",
			onchange: (e) => {
				const v = e.target.value.trim();
				state.settings.partyEqPlayers = v === "" ? null : Math.max(1, Math.min(99, Math.round(Number(v)) || 1));
				save();
				evaluateParty();
			},
		});
		const eqPlayers = EARTHQUAKE.has(String(partyAtkNow()))
			? h("label", { title: "Earth Quake teilt seinen Schaden auf alle Spieler im Bereich auf" }, "Spieler im Bereich: ", eqInput, h("span", { class: "aa-dim" }, state.settings.partyEqPlayers == null ? " (= Party)" : ""))
			: "";
		const ens = partyEnsembleState();
		const ensembleToggles = h(
			"span",
			{ class: "aa-pbens", title: ens.possible ? "Ensembles (Level 5) wirken auf alle Mitglieder außer den Performern" : "Braucht einen Bard/Minstrel und eine Dancer/Gypsy in der Party" },
			"Ensembles: ",
			ENSEMBLES.map((e) =>
				h(
					"label",
					{ class: ens.possible ? "" : "aa-dim", title: e.info },
					h("input", {
						type: "checkbox",
						checked: state.settings.partyEnsembles.includes(e.key),
						disabled: !ens.possible,
						onchange: (ev) => {
							const on = new Set(state.settings.partyEnsembles);
							ev.target.checked ? on.add(e.key) : on.delete(e.key);
							state.settings.partyEnsembles = ENSEMBLES.map((x) => x.key).filter((k) => on.has(k));
							save();
							evaluateParty();
						},
					}),
					" ♫ " + e.name
				)
			)
		);
		const buffToggles = h(
			"span",
			{ class: "aa-pbens", title: "Buffs für alle Mitglieder (zusätzlich zu dem, was die Builds gespeichert haben)" },
			"Party-Buffs: ",
			PARTY_BUFFS.map((b) =>
				h(
					"label",
					{ title: b.info },
					h("input", {
						type: "checkbox",
						checked: state.settings.partyBuffs.includes(b.key),
						onchange: (ev) => {
							const on = new Set(state.settings.partyBuffs);
							ev.target.checked ? on.add(b.key) : on.delete(b.key);
							state.settings.partyBuffs = PARTY_BUFFS.map((x) => x.key).filter((k) => on.has(k));
							save();
							evaluateParty();
						},
					}),
					" " + b.name
				)
			)
		);
		const stat = (label, value, title) => h("div", { class: "aa-pbstat", title: title || "" }, h("span", { class: "aa-dim" }, label), h("strong", null, value));
		const monsterCard = h(
			"div",
			{ class: "aa-pbmonster" },
			h("div", { class: "aa-pbmname" }, monster),
			h("div", { class: "aa-dim" }, renderSub(monsterInfo(Number(enemy)).filter((p) => !/ HP$/.test(p.text)))),
			stat("HP", hp ? hp.toLocaleString("en-US") : "–"),
			stat("Party-DPS", total ? total.toFixed(1) : "–", "Summe der Ø Schaden/Sek. aller Mitglieder (alle greifen an)"),
			late ? stat("Ø Party-DPS", Number.isFinite(ttk) && ttk > 0 ? (hp / ttk).toFixed(1) : "–", "HP ÷ Zeit bis Kill – mit den späteren Einstiegen") : "",
			stat("Zeit bis Kill", Number.isFinite(ttk) ? formatDuration(ttk) : fight.stuckAt != null && total > 0 ? `nie (bis ${fight.stuckAt} % greift keiner an)` : "–", late ? "abschnittsweise: zwischen zwei Einstiegen greifen nur die Mitglieder an, die schon dabei sind" : "HP ÷ Party-DPS"),
			stat("Kills/Min.", Number.isFinite(ttk) && ttk > 0 ? (60 / ttk).toFixed(2) : "–", "ohne Laufwege und Respawn"),
			stat("Mitglieder", String(members.length)),
			pb.songs && pb.songs.length ? h("div", { class: "aa-dim aa-pbsongs" }, "♪ " + pb.songs.join(", ")) : "",
			pb.ensembles && pb.ensembles.length ? h("div", { class: "aa-dim aa-pbsongs" }, "♫ " + pb.ensembles.join(", ")) : ""
		);

		const takenCells = (r) => [
			h("td", { class: "aa-num" }, r && r.maxHp ? r.maxHp.toLocaleString("en-US") : "–"),
			h("td", { class: "aa-num", title: "Ø erlittener Schaden pro Angriff des Monsters (inkl. Ausweichen)" }, r ? r.recv.toFixed(1) : "–"),
			h("td", { class: "aa-num", title: r ? `Max HP ${r.maxHp.toLocaleString("en-US")} ÷ erlittener Schaden` : "" }, r ? (Number.isFinite(r.hits) ? r.hits.toFixed(1) : "∞") : "–"),
		];
		const gospelCell = (m, key, label) => {
			const own = (partySkills.get(m.build) || {}).gospel;
			const set = m.gospel && m.gospel[key] != null ? m.gospel[key] : null;
			const on = set != null ? set : Boolean(own && own[key]);
			return h(
				"td",
				{ class: "aa-pbgospel", title: `Gospel ${label}` + (set == null ? " – wie im Build gespeichert" : " – im Party-Battle gesetzt") },
				h("input", {
					type: "checkbox",
					checked: on,
					onchange: (e) => updatePartyMember(m.uid, { gospel: { ...(m.gospel || {}), [key]: e.target.checked } }),
				})
			);
		};
		const row = (m) => {
			const r = pb.results.get(m.uid);
			const skills = partySkills.get(m.build);
			const skillSel = h(
				"select",
				{ class: "aa-pbskill", title: "Angriffs-Skill dieses Mitglieds – oder ein Support-Song für die anderen", onchange: (e) => updatePartyMember(m.uid, { skill: e.target.value === "" ? null : e.target.value }) },
				h("option", { value: "", selected: m.skill == null }, skills ? `Build-Skill (${(skills.options.find((o) => o.value === skills.own) || { text: "?" }).text})` : "Build-Skill"),
				// Lists are known after the first calculation; until then keep the stored choice.
				!skills && m.skill != null ? h("option", { value: m.skill, selected: true }, songOf(m.skill) ? "♪ " + songOf(m.skill).name : r && r.skill ? r.skill : "gewählter Skill") : null,
				skills && skills.songs && skills.songs.length
					? h("optgroup", { label: "Support-Songs (für die anderen)" }, skills.songs.map((x) => h("option", { value: SONG_PREFIX + x.key, selected: m.skill === SONG_PREFIX + x.key }, "♪ " + x.name)))
					: null,
				skills ? h("optgroup", { label: "Angriff" }, skills.options.map((o) => h("option", { value: o.value, selected: m.skill === o.value }, o.text))) : null
			);
			const share = r && hp > 0 && Number.isFinite(ttk) ? ((fight.dealt.get(m.uid) || 0) / hp) * 100 : r && total > 0 ? (r.dps / total) * 100 : 0;
			const startIn = h("input", {
				type: "number",
				class: "aa-pbstart",
				min: "1",
				max: "100",
				value: String(startOf(m)),
				title: "Greift erst an, wenn das Monster höchstens so viel % seiner HP hat (100 = von Anfang an)",
				onchange: (e) => setPartyStart(m.uid, e.target.value),
			});
			const startCell = h(
				"td",
				{ class: "aa-num aa-pbstartcell", title: fight.startAt.has(m.uid) && startOf(m) < 100 ? `steigt nach ${formatDuration(fight.startAt.get(m.uid))} ein` : "" },
				startIn,
				" %"
			);
			if (r && r.song) {
				return h(
					"tr",
					{ class: "aa-pbsupport" },
					h("td", null, h("strong", null, m.b.name), h("div", { class: "aa-dim" }, m.b.job)),
					h("td", null, skillSel),
					gospelCell(m, "stats", "All Stats +20"),
					gospelCell(m, "atk", "ATK +100%"),
					h("td", { colspan: "4", class: "aa-dim" }, `♪ spielt ${r.song} – wirkt auf alle anderen Mitglieder`),
					takenCells(r),
					h(
						"td",
						{ class: "aa-bvactions" },
						h("button", { type: "button", class: "aa-btn aa-small", title: "Diesen Build in den Calculator laden", onclick: () => loadPartyMember(m) }, "Laden"),
						m.b.snapshot ? h("button", { type: "button", class: "aa-btn aa-small", title: "Snapshot mit dem aktuellen Charakter überschreiben", onclick: () => overwriteSnapshot(m.b.id) }, "Überschreiben") : null,
						h("button", { type: "button", class: "aa-x", title: "Aus der Party entfernen", onclick: () => removePartyMember(m.uid) }, "×")
					)
				);
			}
			return h(
				"tr",
				null,
				h("td", null, h("strong", null, m.b.name), h("div", { class: "aa-dim" }, m.b.job)),
				h("td", null, skillSel),
				gospelCell(m, "stats", "All Stats +20"),
				gospelCell(m, "atk", "ATK +100%"),
				h("td", { class: "aa-num" }, r ? r.hit.toFixed(1) : "–"),
				h("td", { class: "aa-num", title: r && r.interval > 0 ? `alle ${r.interval.toFixed(2)} s` : "" }, r ? r.dps.toFixed(1) : "–"),
				startCell,
				h("td", { class: "aa-pbshare", title: "Anteil am Schaden bis zum Kill" }, r ? [h("span", { class: "aa-pbbar", style: `width:${share.toFixed(1)}%` }), h("span", null, share.toFixed(1) + " %")] : "–"),
				takenCells(r),
				h(
					"td",
					{ class: "aa-bvactions" },
					h("button", { type: "button", class: "aa-btn aa-small", title: "Diesen Build mit dem Skill in den Calculator laden", onclick: () => loadPartyMember(m) }, "Laden"),
					m.b.snapshot ? h("button", { type: "button", class: "aa-btn aa-small", title: "Snapshot mit dem aktuellen Charakter überschreiben", onclick: () => overwriteSnapshot(m.b.id) }, "Überschreiben") : null,
					h("button", { type: "button", class: "aa-x", title: "Aus der Party entfernen", onclick: () => removePartyMember(m.uid) }, "×")
				)
			);
		};

		partyLayout.render(
			[
				members.length ? h("button", { type: "button", class: "aa-btn aa-small" + (stale ? " aa-primary" : ""), onclick: evaluateParty }, "Neu berechnen") : "",
				stale ? h("span", { class: "aa-warn" }, "Monster geändert – neu berechnen") : "",
			],
			[
			members.length ? h("div", { class: "aa-bvbar aa-pbopts" }, monsterAtkSelect, eqPlayers, ensembleToggles, buffToggles) : "",
			members.length
				? h(
						"div",
						{ class: "aa-pblayout" },
						monsterCard,
						h(
							"table",
							{ class: "aa-pbtable" },
							h("thead", null, h("tr", null, h("th", null, "Mitglied"), h("th", null, "Skill"), h("th", { class: "aa-pbgospel", title: "Gospel: All Stats +20" }, "Gospel +20 Stats"), h("th", { class: "aa-pbgospel", title: "Gospel: ATK +100%" }, "Gospel +100% ATK"), h("th", { class: "aa-num", title: "Ø Schaden pro Treffer" }, "Schaden/Treffer"), h("th", { class: "aa-num", title: "Ø Schaden pro Sekunde" }, "DPS"), h("th", { class: "aa-num", title: "Greift ab diesem Anteil der Monster-HP an (Standard 100 %)" }, "DPS ab % HP"), h("th", null, "Anteil"), h("th", { class: "aa-num" }, "Max HP"), h("th", { class: "aa-num", title: "Ø erlittener Schaden pro Angriff des Monsters" }, "erlitten"), h("th", { class: "aa-num", title: "Treffer des Monster-Angriffs bis K.O. (Max HP ÷ erlittener Schaden)" }, "Treffer bis K.O."), h("th", null, ""))),
							h("tbody", null, members.map(row))
						)
				  )
				: h("p", { class: "aa-hint" }, "Den aktuellen Charakter oder gespeicherte Builds hinzufügen – derselbe Build darf mehrfach dabei sein, jedes Mitglied mit eigenem Skill."),
			]
		);
	}

	// ---------------------------------------------------------------------------
	// "Armory" theme in the calculator's theme select
	// ---------------------------------------------------------------------------
	//
	// The select is driven by the <dark-mode-toggle> component, which only knows
	// system/dark/light. "Armory" switches it to dark and adds a grayscale layer
	// on top (theme-armory.css, scoped to html.aa-theme-armory).

	const themeSelect = document.getElementById("theme");
	const darkToggle = document.querySelector("dark-mode-toggle");
	if (themeSelect && !themeSelect.querySelector('option[value="armory"]')) themeSelect.append(new Option("Armory", "armory"));
	let appliedTheme = null;

	function applyTheme(theme) {
		const armory = theme === "armory";
		document.documentElement.classList.toggle("aa-theme-armory", armory);
		if (!armory || appliedTheme === theme) {
			appliedTheme = theme;
			return;
		}
		appliedTheme = theme;
		if (darkToggle) {
			try {
				darkToggle.permanent = true;
				darkToggle.mode = "dark";
			} catch (e) {
				/* component not ready; the grayscale layer still applies */
			}
		}
		if (themeSelect) themeSelect.value = "armory";
	}

	document.addEventListener(
		"change",
		(e) => {
			if (!themeSelect || e.target !== themeSelect) return;
			if (themeSelect.value === "armory") {
				e.stopImmediatePropagation(); // the component would reject the unknown mode
				state.settings.theme = "armory";
				save();
				applyTheme("armory");
			} else {
				state.settings.theme = themeSelect.value;
				save();
				applyTheme(themeSelect.value);
			}
		},
		true
	);
	// The component resets the select to dark/light/system whenever it updates.
	document.addEventListener("colorschemechange", () => {
		if (themeSelect && state.settings.theme === "armory") themeSelect.value = "armory";
	});

	renderPanel();
	window.postMessage({ aa: "toBridge", type: "load" }, window.location.origin);
})();
