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
 * HOW: a Vite `load` hook for .astro files, which reads the file itself
 * and wraps the template in HTML comments:
 *
 *     ---<!--src:src/components/Button.astro:34-->   ...  <!--/src-->
 *
 * `load`, not `transform`, on purpose. Astro's own .astro handling is a
 * `transform` at enforce:'pre' (astro/dist/vite-plugin-astro/index.js),
 * so a competing pre-transform would be an ordering fight we could lose
 * silently. Astro has no `load` for the bare .astro file -- it lets Vite
 * read from disk -- so claiming `load` puts us unambiguously first, and
 * Astro's transform then compiles the source we handed back.
 *
 * The opening marker goes at the END of the closing `---` line rather
 * than on a line of its own, so the template's line numbers are byte-for
 * -byte what they were. Compiler errors and stack traces stay honest.
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
 *     marker goes immediately AFTER the doctype, still on its line.
 *   - template opens with a bare <html> and no doctype (redirect stubs,
 *     standalone error documents): skipped entirely. There is nowhere
 *     safe to put it, and those are not pages anyone inspects.
 *
 * KNOWN LIMITATION: plain markup written inline in a parent and passed
 * into a component's slot lands inside that component's comment range,
 * so the top row names the component rather than the caller. The caller
 * is still on the next row -- the chain is shallow-wrong, never absent.
 * Components passed as slots are fine: they carry their own markers.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Shared with the client half via a prelude -- see injectScript below. */
const MARKS = { open: 'src:', close: '/src' };

const CLIENT = fileURLToPath(new URL('./pathfinder-client.js', import.meta.url));

/** A line that is exactly `---`, so a `---` inside a frontmatter docblock can't match. */
const FENCE = /^---[ \t]*$/gm;
const DOCTYPE = /^\s*<!doctype[^>]*>/i;
const BARE_HTML = /^\s*<html[\s>]/i;

/** Returns the marked source, or null when this file can't be marked safely. */
function markTemplate(source, relPath) {
	// Astro's own built-ins (<Image>, <Picture>) are real .astro files and
	// mark up fine, but they are not files you would ever edit -- a row
	// naming one is a row you can't act on. Their markup is attributed to
	// whichever of the project's components called them, which is the
	// useful answer. Also covers this package itself when installed.
	if (relPath.startsWith('node_modules/') || relPath.startsWith('..')) return null;
	if (!source.startsWith('---')) return null;

	FENCE.lastIndex = 3;
	const fence = FENCE.exec(source);
	if (!fence) return null;

	let at = fence.index + fence[0].length;
	const template = source.slice(at);

	const doctype = DOCTYPE.exec(template);
	if (doctype) at += doctype[0].length;
	else if (BARE_HTML.test(template)) return null;

	const line = source.slice(0, at).split('\n').length;

	return (
		source.slice(0, at) +
		`<!--${MARKS.open}${relPath}:${line}-->` +
		source.slice(at) +
		`<!--${MARKS.close}-->`
	);
}

function markerPlugin(root) {
	return {
		name: 'astro-pathfinder-markers',
		enforce: 'pre',
		load(id) {
			// Virtual modules and the ?astro&type=style|script sub-requests
			// are Astro's own; only the bare file on disk is ours.
			if (id[0] === '\0' || id.includes('?') || !id.endsWith('.astro')) return null;
			let source;
			try {
				source = readFileSync(id, 'utf-8');
			} catch {
				return null;
			}
			return markTemplate(source, relative(root, id));
		},
	};
}

export default function pathfinder() {
	if (!process.env.INSPECT) return { name: 'astro-pathfinder', hooks: {} };

	return {
		name: 'astro-pathfinder',
		hooks: {
			'astro:config:setup': ({ command, config, updateConfig, injectScript, logger }) => {
				if (command !== 'dev') return;

				updateConfig({ vite: { plugins: [markerPlugin(fileURLToPath(config.root))] } });

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
