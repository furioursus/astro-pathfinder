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

## Install

Two supported shapes. Both work; pick by whether the project can reach this repo
at install time.

### Vendored (recommended for private or CI-built projects)

Copy `pathfinder.mjs` and `pathfinder-client.js` anywhere in the project — they
have no dependencies beyond `node:` builtins and no opinion about where they
live.

```js
// astro.config.mjs
import pathfinder from './integrations/pathfinder.mjs';

export default defineConfig({
  integrations: [pathfinder()],
});
```

### As a dependency

```bash
npm i -D github:furioursus/astro-pathfinder
```

```js
import pathfinder from 'astro-pathfinder';
```

**If this repo is private, vendor instead.** A private git dependency means
every CI build needs credentials to reach GitHub, and the first `npm ci` without
them fails the build — a steep price for a dev-only overlay.

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
the file the stamp already did.

Stamps come from `@astrojs/compiler-rs`'s own `parse()`, which returns an
oxc/ESTree AST with byte offsets on every node. Every insertion — both comments
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

Astro 7.3.2, Node 22, macOS. Measured against a 140-component, 18,374-page site:

- all **140/140** files parse clean, **0** diagnostics, **1,216** stamps injected,
  **0** line-count changes, **0.77ms/file**
- markers balanced in the live DOM, `document.compatMode` still `CSS1Compat`
- chains correct four and five levels deep, including layout nesting order
- slot-written markup naming its own file and line; `set:html` content correctly
  falling back to the emitting component
- **all 373 HTML files of a sample build byte-identical** between
  `INSPECT=1 astro build` and a clean build — only `.ics` `DTSTAMP` and
  Pagefind's nondeterministic chunks differ
- exercised in both the vendored and the `node_modules/` shape

The `peerDependencies` range says `>=7` because that is what has actually been
run. Earlier majors used the Go compiler, which shipped `annotateSourceFile`
natively — on those, you may not need this at all.
