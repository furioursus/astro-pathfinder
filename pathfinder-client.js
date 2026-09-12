/**
 * The browser half of astro-pathfinder (pathfinder.mjs).
 *
 * Injected into every page as a `page` script, dev only, only under
 * INSPECT=1. Never reaches a build: the integration's config:setup hook
 * returns before injectScript() unless both of those hold.
 *
 * What it reads: the HTML comments the inspector's Vite `load` hook wraps
 * around every .astro component's template --
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
 * The marker strings come from globalThis.__PATHFINDER_MARKS__, which the
 * integration writes as a prelude to this file -- one source of truth for
 * both halves, so the two can never drift apart.
 */
const MARKS = globalThis.__PATHFINDER_MARKS__ ?? { open: 'src:', close: '/src' };

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

function row(entry) {
	// entry is "src/components/Button.astro:34"
	const cut = entry.lastIndexOf(':');
	const path = entry.slice(0, cut);
	const line = entry.slice(cut + 1);
	const slash = path.lastIndexOf('/');

	const li = document.createElement('li');
	li.innerHTML =
		`<span class="dir">${path.slice(0, slash + 1)}</span>` +
		`<span class="file">${path.slice(slash + 1)}</span>` +
		`<span class="line">:${line}</span>`;
	// Vite's own dev middleware -- same endpoint its error overlay uses.
	li.addEventListener('click', () => {
		fetch(`/__open-in-editor?file=${encodeURIComponent(entry)}`);
	});
	return li;
}

function render(chain, el) {
	list.replaceChildren();
	if (!chain || !chain.length) {
		empty.classList.remove('hidden');
		box.classList.add('hidden');
		return;
	}
	empty.classList.add('hidden');
	// Innermost first: the file you almost always want is the top row.
	for (let i = chain.length - 1; i >= 0; i--) list.append(row(chain[i]));

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

	let chain = chainFor(el);
	// A miss usually means markup arrived after the last pass. Rescan at
	// most once a second so a genuinely unowned element cannot spin.
	if (!chain && performance.now() - lastScan > 1000) {
		scan();
		chain = chainFor(el);
	}
	render(chain, el);
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
