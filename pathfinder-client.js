/**
 * The browser half of astro-pathfinder (pathfinder.mjs).
 *
 * Injected into every page as a `page` script, dev only, only under
 * INSPECT=1. Never reaches a build: the integration's config:setup hook
 * returns before injectScript() unless both of those hold.
 *
 * It reads the two layers pathfinder.mjs writes, and answers with one
 * list built from both.
 *
 * COMMENTS give the render chain -- which component emitted this region:
 *
 *     <!--src:src/components/Button.astro:34-->  ...markup...  <!--/src-->
 *
 * A single document-order walk over elements AND comments, carrying a
 * stack of open files, hands every element the chain of components that
 * produced it. Document order rather than tree containment on purpose:
 * the parser is free to reparent a comment (the base layout's closing
 * marker sits after </html> in source and gets moved inside), and order
 * survives that where containment does not.
 *
 * STAMPS give lexical authorship -- the file the tag was actually typed
 * in, which for slotted markup is NOT the component it renders inside:
 *
 *     <button data-pf="src/pages/index.astro:47" class="b">
 *
 * So the top row comes from the nearest stamp (exact file, exact line)
 * and the rest from the comment chain, with the chain's innermost entry
 * dropped when it names the same file the stamp already did. An element
 * with no stamp -- injected at runtime, or emitted by set:html -- falls
 * back to the comment chain alone, which is what this did before stamps
 * existed.
 *
 * The marker strings come from globalThis.__PATHFINDER_MARKS__, which the
 * integration writes as a prelude to this file -- one source of truth for
 * both halves, so the two can never drift apart.
 */
const MARKS = globalThis.__PATHFINDER_MARKS__ ?? { open: 'src:', close: '/src', stamp: 'data-pf' };

/** Element -> [outermost, ..., innermost] component paths. Rebuilt by scan(). */
let owners = new WeakMap();
let lastScan = 0;

let host, panel, list, empty, box;
let frozen = false;

// The toggle is a preference, not a per-page-load state: flipping it off and
// then navigating shouldn't bring the panel back. localStorage rather than a
// cookie because nothing server-side has any business knowing about it.
const PREF = 'astro-pathfinder:on';
let visible = localStorage.getItem(PREF) !== 'off';

const PANEL_CSS = `
:host { all: initial; }
.panel {
	position: fixed; bottom: 12px; left: 12px; z-index: 2147483646;
	min-width: 240px; max-width: 420px;
	font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
	color: #e6e6e6; background: #16181d; border: 1px solid #31353f;
	border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,.45);
	overflow: hidden;
}
.head {
	display: flex; align-items: center; gap: 8px;
	padding: 6px 9px; background: #1e2128; border-bottom: 1px solid #31353f;
	color: #8b93a3; font-size: 10px; letter-spacing: .04em; text-transform: uppercase;
}
.head .dot { width: 6px; height: 6px; border-radius: 50%; background: #5ac8a0; flex: none; }
.head .hint { margin-left: auto; text-transform: none; letter-spacing: 0; color: #5d6472; }
.frozen .dot { background: #e0b341; }
ul { list-style: none; margin: 0; padding: 4px 0; max-height: 45vh; overflow-y: auto; }
li {
	display: block; width: 100%; box-sizing: border-box; text-align: left;
	padding: 3px 9px; border: 0; background: none; color: inherit;
	font: inherit; cursor: pointer; white-space: nowrap;
}
li:hover { background: #262a33; }
li .dir { color: #6b7280; }
li .file { color: #cfd6e4; }
li:first-child .file { color: #7fd6b4; font-weight: 600; }
li .line { color: #5d6472; }
li .note { color: #c9a227; }
.empty { padding: 7px 9px; color: #6b7280; }
.box {
	position: fixed; z-index: 2147483645; pointer-events: none;
	border: 1px solid rgba(127,214,180,.9); background: rgba(127,214,180,.10);
	border-radius: 2px;
}
.hidden { display: none !important; }
`;

function build() {
	host = document.createElement('div');
	host.setAttribute('data-pathfinder', '');
	const root = host.attachShadow({ mode: 'open' });

	const style = document.createElement('style');
	style.textContent = PANEL_CSS;

	panel = document.createElement('div');
	panel.className = 'panel';
	panel.innerHTML = `
		<div class="head"><span class="dot"></span><span>component</span>
			<span class="hint">ctrl+alt+i</span></div>
		<ul></ul>
		<div class="empty">hover anything</div>`;

	list = panel.querySelector('ul');
	empty = panel.querySelector('.empty');

	box = document.createElement('div');
	box.className = 'box hidden';

	panel.classList.toggle('hidden', !visible);
	root.append(style, panel, box);
	document.body.append(host);

	// Freeze while the pointer is over the panel, so walking the cursor
	// across to click a row cannot change the chain out from under it.
	panel.addEventListener('pointerenter', () => {
		frozen = true;
		panel.classList.add('frozen');
		box.classList.add('hidden');
	});
	panel.addEventListener('pointerleave', () => {
		frozen = false;
		panel.classList.remove('frozen');
	});
}

/** One document-order pass: every element gets the stack of files open at its start tag. */
function scan() {
	owners = new WeakMap();
	const stack = [];
	// Rooted at `document`, NOT documentElement: the outermost markers --
	// the page component's and the base layout's -- are emitted before <html>,
	// and the parser makes a comment in that position a child of Document,
	// a sibling of <html> rather than a descendant. Rooting any deeper
	// loses the two rows you most want.
	const walker = document.createTreeWalker(
		document,
		NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT,
	);
	for (let n = walker.currentNode; n; n = walker.nextNode()) {
		if (n.nodeType === Node.COMMENT_NODE) {
			const v = n.nodeValue;
			if (v.startsWith(MARKS.open)) stack.push(v.slice(MARKS.open.length));
			else if (v === MARKS.close) stack.pop();
		} else if (stack.length && n !== host) {
			owners.set(n, stack.slice());
		}
	}
	lastScan = performance.now();
}

function chainFor(el) {
	for (let n = el; n; n = n.parentElement) {
		const chain = owners.get(n);
		if (chain) return chain;
	}
	return null;
}

/**
 * The element's OWN stamp -- "file:line" of the tag as written -- or null.
 *
 * Deliberately not a walk up the ancestors. An element with no stamp was
 * not authored as markup in any .astro template: it came from set:html,
 * from a runtime insertion, or it is one of the tags pathfinder.mjs skips.
 * The nearest stamped ancestor in those cases is in whatever file happens
 * to wrap the component, which is a confident wrong answer -- an <svg>
 * emitted by Icon.astro's `<Fragment set:html>` would be attributed to the
 * card that rendered the icon. When there is no stamp the comment chain is
 * the authoritative answer, so return null and let it speak.
 */
function stampFor(el) {
	return el.getAttribute?.(MARKS.stamp) ?? null;
}

/**
 * Markers carry "path:line"; rows are {path, line, note}. Island rows have no
 * line at all, which is why rows stopped being strings -- splitting on the last
 * colon quietly mangles a path that has no line appended to it.
 */
function entry(marker) {
	const cut = marker.lastIndexOf(':');
	return { path: marker.slice(0, cut), line: marker.slice(cut + 1), note: null };
}

/**
 * The framework component that rendered `el`, if it sits inside a hydrated
 * island -- Astro puts the source path on <astro-island component-url>.
 *
 * Only reached when `el` carries no stamp of its own. A stamped element inside
 * an island is .astro markup passed into the island's slot: authored in a real
 * file, which the stamp already names correctly.
 *
 * Dev serves these as clean root-relative paths ("/src/components/NavBar.vue").
 * A component outside the project root arrives as "/@fs/<abs path>", which is
 * still openable, so it is unwrapped rather than dropped. HMR can append a
 * query; the editor wants the bare path.
 */
function islandFor(el) {
	const island = el.closest?.('astro-island');
	const url = island?.getAttribute('component-url');
	if (!url) return null;

	let path = url.split('?')[0];
	if (path.startsWith('/@fs/')) path = path.slice('/@fs'.length);
	else if (path.startsWith('/')) path = path.slice(1);
	if (!path) return null;

	// Named exports matter here: one .tsx can export several components, and
	// "default" is noise on every other row.
	const exported = island.getAttribute('component-export');
	return { path, line: null, note: exported && exported !== 'default' ? exported : null };
}

/** The displayed list: innermost first, out to the page route. */
function rowsFor(el) {
	const rows = [];

	const stamp = stampFor(el);
	if (stamp) rows.push(entry(stamp));
	else {
		const island = islandFor(el);
		if (island) rows.push(island);
	}

	const chain = chainFor(el);
	if (chain) {
		for (let i = chain.length - 1; i >= 0; i--) {
			const next = entry(chain[i]);
			// Collapse a repeat of the file directly above it. Usually that is
			// the stamp and the innermost component naming the same file, where
			// the stamp's row is the one worth keeping -- it has the real line.
			if (rows.length && rows[rows.length - 1].path === next.path) continue;
			rows.push(next);
		}
	}
	return rows;
}

function row({ path, line, note }) {
	const slash = path.lastIndexOf('/');
	const target = line ? `${path}:${line}` : path;

	const li = document.createElement('li');
	li.innerHTML =
		`<span class="dir">${path.slice(0, slash + 1)}</span>` +
		`<span class="file">${path.slice(slash + 1)}</span>` +
		(line ? `<span class="line">:${line}</span>` : '') +
		(note ? `<span class="note"> ${note}</span>` : '');
	// Vite's own dev middleware -- same endpoint its error overlay uses.
	li.addEventListener('click', () => {
		fetch(`/__open-in-editor?file=${encodeURIComponent(target)}`);
	});
	return li;
}

function render(rows, el) {
	list.replaceChildren();
	if (!rows.length) {
		empty.classList.remove('hidden');
		box.classList.add('hidden');
		return;
	}
	empty.classList.add('hidden');
	for (const entry of rows) list.append(row(entry));

	const r = el.getBoundingClientRect();
	if (r.width || r.height) {
		box.classList.remove('hidden');
		box.style.cssText +=
			`;top:${r.top}px;left:${r.left}px;width:${r.width}px;height:${r.height}px`;
	} else {
		box.classList.add('hidden');
	}
}

function onOver(e) {
	if (!visible || frozen) return;
	const el = e.target;
	if (!(el instanceof Element) || el === host || host.contains(el)) return;

	let rows = rowsFor(el);
	// A miss usually means markup arrived after the last comment pass.
	// Rescan at most once a second so a genuinely unowned element cannot
	// spin. (Stamps are attributes, so they never go stale this way.)
	if (!rows.length && performance.now() - lastScan > 1000) {
		scan();
		rows = rowsFor(el);
	}
	render(rows, el);
}

function toggle(on) {
	visible = on ?? !visible;
	localStorage.setItem(PREF, visible ? 'on' : 'off');
	panel.classList.toggle('hidden', !visible);
	if (!visible) box.classList.add('hidden');
}

function start() {
	build();
	scan();
	document.addEventListener('mouseover', onOver, true);
	// Ctrl+Alt+I, not Cmd+Alt+I or Cmd+Shift+I -- both of those are Chrome's
	// own DevTools shortcuts on macOS.
	document.addEventListener('keydown', (e) => {
		if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'i') {
			e.preventDefault();
			toggle();
		}
	});
	window.addEventListener('scroll', () => box.classList.add('hidden'), { passive: true });
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
	start();
}
