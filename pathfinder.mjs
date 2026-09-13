/**
 * astro-pathfinder — a dev-only component inspector for Astro.
 *
 * Hover anything on the dev server and a corner panel names the .astro
 * files that produced it, innermost first, each row clickable straight
 * into your editor.
 *
 * Off by default. `INSPECT=1 astro dev` turns it on; every other command,
 * including every build, gets the no-op integration below and never sees
 * the Vite plugin or the client script at all.
 *
 * WHY THIS EXISTS: Astro used to do this itself. The compiler had an
 * `annotateSourceFile` option that stamped data-astro-source-file /
 * data-astro-source-loc onto every element in dev, and the dev toolbar's
 * audit app still reads those attributes (astro/dist/runtime/client/
 * dev-toolbar/apps/audit/annotations.js). Astro still passes the flag
 * (astro/dist/core/compile/compile.js). But Astro 7 compiles through
 * @astrojs/compiler-rs, and the Rust compiler accepts the flag and does
 * nothing with it -- the native binary contains no "astro-source" string
 * and a dev page carries no such attribute. So we mark boundaries here.
 *
 * TWO LAYERS OF MARKING, answering two different questions.
 *
 * 1. COMPONENT BOUNDARIES, as HTML comments wrapping each template:
 *
 *        ---<!--src:src/components/Button.astro:34-->  ...  <!--/src-->
 *
 *    Walked in the browser, these give the *render* chain: which
 *    component emitted this region of output, out to the page route.
 *    They see components that emit no elements of their own -- a wrapper
 *    that renders only text, a <Fragment set:html> -- which layer 2
 *    cannot.
 *
 * 2. PER-ELEMENT STAMPS, as a data-pf attribute on each element's
 *    opening tag, carrying the file and line where that tag is written:
 *
 *        <button data-pf="src/pages/index.astro:47" class="b">
 *
 *    These give *lexical authorship*, and they exist because layer 1
 *    alone gets slot content wrong. Markup written inline in a parent and
 *    passed into a component's slot is rendered inside the callee, so the
 *    comment stack attributes it to the component rather than to the file
 *    it was typed in. A stamp is applied at parse time in the file that
 *    contains the tag, so slots stop being a special case at all -- they
 *    never arise. This is what Astro's own Go compiler used to do.
 *
 * The client uses the stamp for the top row (exact file, exact line) and
 * the comment chain for the rest.
 *
 * HOW LAYER 1 IS APPLIED: a Vite `load` hook for .astro files, which reads
 * the file itself. `load`, not `transform`, on purpose. Astro's own .astro
 * handling is a `transform` at enforce:'pre' (astro/dist/vite-plugin-astro
 * /index.js), so a competing pre-transform would be an ordering fight we
 * could lose silently. Astro has no `load` for the bare .astro file -- it
 * lets Vite read from disk -- so claiming `load` puts us unambiguously
 * first, and Astro's transform then compiles the source we handed back.
 *
 * HOW LAYER 2 IS APPLIED: @astrojs/compiler-rs's own `parse()`, which
 * returns an oxc/ESTree-shaped AST with byte offsets on every node. Every
 * insertion -- both comments and every stamp -- is collected as an offset
 * and applied back-to-front in one pass, so earlier offsets stay valid and
 * no bookkeeping is needed. The stamp goes immediately after the tag NAME,
 * which is safe for self-closing tags and expression attributes alike.
 *
 * The parser ships with Astro, but it is resolved at runtime rather than
 * declared as a dependency, and pathfinder degrades to comments-only with
 * a warning if it cannot be reached (pnpm's strict store, an unusual
 * layout). Layer 1 keeps working; only slot precision is lost.
 *
 * NOTHING SHIFTS A LINE NUMBER. The opening comment goes at the END of the
 * closing `---` line rather than on a line of its own, and stamps are
 * inline. Template line numbers stay byte-for-byte what they were, so
 * compiler errors and stack traces stay honest.
 *
 * Displayed paths are relative to Astro's OWN `config.root`, handed to us
 * in astro:config:setup -- never to this file's location. That is what
 * lets the same two files work vendored into a project's integrations/
 * directory and installed under node_modules/, where a path derived from
 * import.meta.url would resolve to ../../src/components/Button.astro or
 * worse.
 *
 * TWO SHAPES GET SPECIAL TREATMENT, both for the same reason -- a comment
 * before a document's root puts the browser in quirks mode:
 *   - template opens with <!doctype html> (typically the base layout):
 *     the comment goes immediately AFTER the doctype, still on its line.
 *   - template opens with a bare <html> and no doctype (redirect stubs,
 *     standalone error documents): no comment at all. There is nowhere
 *     safe to put it. Stamps are unaffected and still applied.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Shared with the client half via a prelude -- see injectScript below. */
const MARKS = { open: 'src:', close: '/src', stamp: 'data-pf' };

const CLIENT = fileURLToPath(new URL('./pathfinder-client.js', import.meta.url));

/** A line that is exactly `---`, so a `---` inside a frontmatter docblock can't match. */
const FENCE = /^---[ \t]*$/gm;
const DOCTYPE = /^\s*<!doctype[^>]*>/i;
const BARE_HTML = /^\s*<html[\s>]/i;

/**
 * Tags whose attributes Astro itself reads or whose element it replaces.
 * <script>/<style> are hoisted and keyed off their attributes; <slot> is
 * substituted away. None of them are worth a stamp, and all three are
 * places an extra attribute could plausibly change behaviour.
 */
const SKIP_TAGS = new Set(['script', 'style', 'slot']);

/** Byte offset where the template begins, or null if frontmatter never closes. */
function templateStart(source) {
	if (!source.startsWith('---')) return 0;
	FENCE.lastIndex = 3;
	const fence = FENCE.exec(source);
	return fence ? fence.index + fence[0].length : null;
}

/** `{start, end}` of each stampable opening tag's NAME, from the template only. */
async function openingTags(source, parse) {
	let result;
	try {
		result = await parse(source, { position: true });
	} catch {
		return [];
	}
	// A file the parser only partly understood is a file we don't inject
	// into -- a stamp placed off a bad offset would corrupt real markup.
	if (result.diagnostics?.length) return [];

	const hits = [];
	const stack = [result.ast?.body];
	while (stack.length) {
		const n = stack.pop();
		if (!n || typeof n !== 'object') continue;
		if (Array.isArray(n)) {
			stack.push(...n);
			continue;
		}
		if (n.type === 'JSXOpeningElement') {
			const nm = n.name;
			// Lowercase JSXIdentifier = an HTML element. Capitalised names are
			// components, which carry their own stamps from their own file;
			// member expressions (<Astro.self />) are neither.
			if (nm?.type === 'JSXIdentifier' && /^[a-z]/.test(nm.name) && !SKIP_TAGS.has(nm.name)) {
				hits.push({ start: nm.start, end: nm.end });
			}
		}
		for (const k of Object.keys(n)) if (k !== 'type') stack.push(n[k]);
	}
	return hits;
}

/** Returns the marked source, or null when there is nothing safe to add. */
async function markSource(source, relPath, parse) {
	// Astro's own built-ins (<Image>, <Picture>) are real .astro files and
	// mark up fine, but they are not files you would ever edit -- a row
	// naming one is a row you can't act on. Their markup is attributed to
	// whichever of the project's components called them, which is the
	// useful answer. Also covers this package itself when installed.
	if (relPath.startsWith('node_modules/') || relPath.startsWith('..')) return null;

	const inserts = [];

	const start = templateStart(source);
	if (start !== null) {
		let at = start;
		const template = source.slice(at);
		const doctype = DOCTYPE.exec(template);
		if (doctype) at += doctype[0].length;

		if (doctype || !BARE_HTML.test(template)) {
			const line = source.slice(0, at).split('\n').length;
			inserts.push({ at, text: `<!--${MARKS.open}${relPath}:${line}-->` });
			inserts.push({ at: source.length, text: `<!--${MARKS.close}-->` });
		}
	}

	if (parse) {
		for (const tag of await openingTags(source, parse)) {
			const line = source.slice(0, tag.start).split('\n').length;
			inserts.push({ at: tag.end, text: ` ${MARKS.stamp}="${relPath}:${line}"` });
		}
	}

	if (!inserts.length) return null;

	// Back-to-front, so every offset still refers to the original source.
	inserts.sort((a, b) => b.at - a.at);
	let out = source;
	for (const { at, text } of inserts) out = out.slice(0, at) + text + out.slice(at);
	return out;
}

function markerPlugin(root, parse) {
	return {
		name: 'astro-pathfinder-markers',
		enforce: 'pre',
		async load(id) {
			// Virtual modules and the ?astro&type=style|script sub-requests
			// are Astro's own; only the bare file on disk is ours.
			if (id[0] === '\0' || id.includes('?') || !id.endsWith('.astro')) return null;
			let source;
			try {
				source = readFileSync(id, 'utf-8');
			} catch {
				return null;
			}
			return markSource(source, relative(root, id), parse);
		},
	};
}

export default function pathfinder() {
	if (!process.env.INSPECT) return { name: 'astro-pathfinder', hooks: {} };

	return {
		name: 'astro-pathfinder',
		hooks: {
			'astro:config:setup': async ({ command, config, updateConfig, injectScript, logger }) => {
				if (command !== 'dev') return;

				// Ships with Astro; resolved rather than depended on. Without it
				// the comment layer still works and only slot precision is lost,
				// so this degrades instead of failing.
				let parse = null;
				try {
					({ parse } = await import('@astrojs/compiler-rs'));
				} catch {
					logger.warn(
						'@astrojs/compiler-rs not resolvable — per-element stamps are off, ' +
							'so slotted markup will name its component rather than its caller',
					);
				}

				updateConfig({
					vite: { plugins: [markerPlugin(fileURLToPath(config.root), parse)] },
				});

				// Inlined rather than imported by path: injectScript takes
				// source, so there is no specifier for Vite to resolve and
				// no way for the two halves to disagree about MARKS.
				injectScript(
					'page',
					`globalThis.__PATHFINDER_MARKS__ = ${JSON.stringify(MARKS)};\n` +
						readFileSync(CLIENT, 'utf-8'),
				);

				logger.info('pathfinder on — hover to locate, ctrl+alt+i to toggle');
			},
		},
	};
}
