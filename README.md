# astro-pathfinder

**Hover anything on your Astro dev server and find out which `.astro` file made it.**

> **TL;DR** — `INSPECT=1 astro dev`, then hover. A panel in the bottom-left names
> the components that produced whatever is under your cursor, innermost first,
> with the top row exact to the line.
> Click a row to open that file in your editor. `ctrl+alt+i` toggles it. It is a
> hard no-op in every build — not stripped, never constructed.

```
src/components/Pagination.astro:37   ← the file you almost always want
src/layouts/BaseLayout.astro:66
src/layouts/ContentLayout.astro:72
src/pages/topics/index.astro:19
```

Top row is the innermost component. Each row below it is that one's caller, out
to the page route.

## Why this exists

**Astro used to do this itself, and quietly stopped.**

The compiler had an `annotateSourceFile` option that stamped
`data-astro-source-file` / `data-astro-source-loc` onto every element in dev.
The dev toolbar's audit app still reads exactly those two attributes. Astro
still passes the flag in `astro/dist/core/compile/compile.js`.

It does nothing. **Astro 7 compiles through `@astrojs/compiler-rs`, and the Rust
compiler accepts the option and emits no annotations.** The native binary
contains no `astro-source` string at all, and a dev page carries no such
attribute. There is no setting that brings it back.

Check whether a later Astro has restored it before reaching for this:

```bash
strings node_modules/@astrojs/compiler-binding-*/astro.*.node | grep -i astro-source
```

Empty output means the annotation is still gone and this package is still the
answer. Hits mean the built-in path may be viable again — confirm by curling a
dev page and grepping for `data-astro-source-file`.

## Compatibility

**Astro 7 or newer.** On Astro 6 and earlier pathfinder disables itself with a
message, because those versions don't need it and it would break them:

- They compile through `@astrojs/compiler` (Go), where `annotateSourceFile` is
  really implemented — Astro already stamps `data-astro-source-file` on every
  element in dev and the toolbar reads it. Measured on Astro 6.4.2: 89
  annotations on one page, no help required.
- Their frontmatter parser eats the character immediately after the closing
  `---`, which is exactly where the opening comment goes — turning `<!--src:…`
  into visible `!--src:…` text on the page. 19 of 20 markers mangled before the
  guard existed.

The stamp layer also needs `@astrojs/compiler-rs`, which ships with Astro 7+. If
it can't be resolved, pathfinder logs why and runs comments-only.

## Install

Two supported shapes. Both work; pick by whether the project can reach this repo
at install time.

### As a dependency

```bash
npm i -D github:furioursus/astro-pathfinder
```

```js
import pathfinder from 'astro-pathfinder';
```

### Vendored

Copy `pathfinder.mjs` and `pathfinder-client.js` anywhere in the project — they
have no dependencies beyond `node:` builtins and no opinion about where they
live, because paths resolve against Astro's `config.root` rather than their own
location.

```js
// astro.config.mjs
import pathfinder from './integrations/pathfinder.mjs';

export default defineConfig({
  integrations: [pathfinder()],
});
```

Worth doing if you'd rather your CI not reach GitHub at install time for a
dev-only overlay, or if you want to read the thing you're running — it's two
files and they're meant to be read.

### Then add a script

```json
"dev:inspect": "INSPECT=1 astro dev"
```

If your `dev` script has a `predev` hook (data fetch, codegen), give
`dev:inspect` a matching `predev:inspect` so it isn't silently skipped.

## Using it

| | |
| :--- | :--- |
| **Hover** | Updates the chain and outlines the element |
| **Click a row** | Opens that file at that line, via Vite's own `/__open-in-editor` |
| **Pointer onto the panel** | Freezes the chain, so walking over to click can't change it |
| **Inside a framework island** | Top row names the `.vue`/`.jsx`/`.svelte` component |
| **`ctrl+alt+i`** | Real on/off — panel, outline and hover tracking all stop. Persists in `localStorage` |

`ctrl+alt+i` rather than anything with `cmd`, because Chrome on macOS already
owns `cmd+alt+i` and `cmd+shift+i` for DevTools.

## What it can and can't see

- **Slotted markup is attributed correctly.** Markup written inline in a parent
  and passed into a component's slot names the file it was *typed* in, not the
  component it renders inside. This was wrong before v0.2.0.
- **`set:html` content has no line of its own.** An element injected as a raw
  HTML string — `<Fragment set:html={svg} />` — was never written as markup
  anywhere, so it carries no stamp. The top row falls back to the component that
  emitted it, which is the right answer; you just don't get a line number.
- **Astro's built-ins (`<Image>`, `<Picture>`) are deliberately unlisted.**
  They're real `.astro` files, but not ones you'd edit. Their markup is
  attributed to whichever of your components called them, which is the answer
  you actually wanted.
- **`<script>`, `<style>` and `<slot>` are never stamped.** Astro reads those
  tags' attributes or substitutes the element away entirely; an extra attribute
  there is a behaviour risk for no benefit.
- **Markup inside a hydrated framework island names the framework component.**
  Hover a button Vue rendered and the top row is `src/components/NavBar.vue`,
  read off the island's own `component-url`. No line number — the element was
  never written as markup in a file pathfinder parses — but the row still opens
  the file. A named export is shown beside the path.
- **A framework component with no `client:*` directive can't be named.** Astro
  only emits `<astro-island>` for hydrated components; a statically-rendered one
  leaves no trace in the HTML, so the chain starts at the `.astro` file that
  rendered it.
- **`.astro` markup passed into an island's slot names its own file, not the
  island.** It carries a stamp, and an element's own stamp always wins.

## How it works

Two layers, answering two different questions.

**Component boundaries**, as HTML comments wrapping each template, written by a
Vite `load` hook:

```
---<!--src:src/components/Button.astro:34-->  …template…  <!--/src-->
```

Walked in the browser, these give the **render chain** — which component emitted
this region of output. They see components that emit no elements of their own,
which the second layer can't.

**Per-element stamps**, an attribute on each element's opening tag carrying the
file and line where that tag is written:

```html
<button data-pf="src/pages/index.astro:47" class="b">
```

These give **lexical authorship**, and they're why slots work. Markup passed into
a component's slot is *rendered* inside the callee, so the comment stack alone
attributes it to the component rather than the file it was typed in. A stamp is
applied at parse time in the file that contains the tag, so slots stop being a
special case — they never arise. This is what Astro's own Go compiler did.

The client uses the stamp for the top row (exact file, exact line) and the
comment chain for the rest, dropping the chain's innermost entry when it names
the file the stamp already did. An element with no stamp that sits inside a
hydrated island gets a **third** source for the top row: Astro puts the
component's path on `<astro-island component-url>`, so a Vue/React/Svelte
component can be named even though pathfinder never parsed it.

Stamps come from `@astrojs/compiler-rs`'s own `parse()`, which returns an
oxc/ESTree AST with offsets on every node — **offsets whose convention is not
stable across compiler versions.** compiler-rs 0.3.x reports UTF-8 *byte*
offsets; 0.4.x reports JS string indices. The two agree on a pure-ASCII file and
diverge silently from the first non-ASCII character onward: one `≥` fifty lines
up was enough to shift every stamp in a real file by two, landing them
mid-attribute and producing markup that wouldn't compile. So no offset is used
before it's checked against the source — both interpretations are tried, the one
that lands on `<tagname` wins, and a tag whose offsets match neither is simply
left unstamped. A future compiler inventing a third convention degrades to
comments-only instead of corrupting files. Every insertion — both comments
and every stamp — is collected as an offset and applied back-to-front in one
pass, so earlier offsets stay valid. The stamp goes immediately after the tag
*name*, which is safe for self-closing tags and expression attributes alike. The
parser ships with Astro but is resolved at runtime rather than depended on; if it
can't be reached, pathfinder logs a warning and falls back to comments only.

Three decisions hold the whole thing up. All three fail *silently* if you change
them, which is why they're spelled out here and in the source:

- **A `load` hook, never a `transform`.** Astro's own `.astro` handling is a
  `transform` at `enforce: 'pre'`, so competing there is an ordering fight you
  lose intermittently and invisibly. Astro has no `load` for the bare `.astro`
  file — it falls through to Vite reading from disk — so claiming `load` puts
  this unambiguously first, and Astro's transform then compiles what it gets
  handed back.
- **Never a comment before a document's root.** That's quirks mode, and it
  presents as a baffling CSS bug. The marker goes *after* `<!doctype html>`, and
  any component whose template opens with a bare `<html>` and no doctype is
  skipped entirely.
- **Document order with a stack, not tree containment**, with the `TreeWalker`
  rooted at `document` rather than `document.documentElement`. The outermost two
  markers are emitted before `<html>` and become its *siblings*, and the parser
  reparents the base layout's closing marker from after `</html>`. Order
  survives both. Containment doesn't.

The opening marker sits at the **end** of the closing `---` line rather than on
a line of its own, so template line numbers are byte-for-byte unchanged and
compiler errors stay honest. Displayed paths are relative to Astro's own
`config.root`, never to this file's location — that's what lets the same two
files work vendored *and* installed under `node_modules/`.

## It does not reach your build

The integration returns a no-op unless `INSPECT=1` **and** the command is `dev`,
so in a build the Vite plugin and the client script are never even constructed.

Prove it in your own project rather than taking this on faith:

```bash
INSPECT=1 astro build
grep -rc '<!--src:' dist/ | grep -v ':0$'   # expect no output
```

## Verified on

Astro 7.3.2 / Node 22 / macOS as the primary target, then deliberately tried
against four **real** projects of different shapes rather than a scaffolded toy:

| Project shape | Astro | compiler-rs | Result |
| :--- | :--- | :--- | :--- |
| 140 components, 18,374 pages, static | 7.3.2 | 0.4.0 | full — 566 stamps, chains 4–5 deep |
| 161 components + 69 Vue islands | 7.2.1 | 0.3.2 | full — islands named, found the byte-offset bug |
| SSR, `output: 'server'` + adapter | 7.2.9 | 0.4.0 | full — 0 mangled markers |
| Cloudflare adapter, small | 6.4.2 | absent | correctly disables itself |

On the primary project: all 140 files parse clean, 1,216 stamps, 0 line-count
changes, 0.77ms/file; markers balanced in the live DOM; `document.compatMode`
still `CSS1Compat`; slot-written markup naming its own file and line;
`set:html` content correctly falling back to the emitting component; and **all
373 HTML files of a sample build byte-identical** between `INSPECT=1 astro build`
and a clean build, with only `.ics` `DTSTAMP` and Pagefind's nondeterministic
chunks differing.

The `peerDependencies` range says `>=7` because that is what has actually been
run, and because Astro 6 and earlier genuinely don't need this.

## License

MIT — see [LICENSE](LICENSE).
