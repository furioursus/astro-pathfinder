# astro-pathfinder

**Hover anything on your Astro dev server and find out which `.astro` file made it.**

> **TL;DR** — `INSPECT=1 astro dev`, then hover. A panel in the bottom-left names
> the components that produced whatever is under your cursor, innermost first.
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

## Two things to know before trusting a row

- **Slotted inline markup is attributed one level off.** Plain markup written in
  a parent and passed into a component's slot lands inside that component's
  range, so the top row names the component. The parent is the row directly
  below — shallow-wrong, never absent. Components passed as slots are correct.
- **Astro's built-ins (`<Image>`, `<Picture>`) are deliberately unlisted.**
  They're real `.astro` files, but not ones you'd edit. Their markup is
  attributed to whichever of your components called them, which is the answer
  you actually wanted.

## How it works

A Vite `load` hook reads each `.astro` file and wraps its template in HTML
comments:

```
---<!--src:src/components/Button.astro:34-->  …template…  <!--/src-->
```

The client half walks those comments and hands every element the stack of files
open at its start tag.

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
markers balanced in the live DOM, `document.compatMode` still `CSS1Compat`,
chains correct four levels deep including layout nesting order, and a build
producing zero markers and zero injected script. Exercised in both the vendored
and the `node_modules/` shape.

The `peerDependencies` range says `>=7` because that is what has actually been
run. Earlier majors used the Go compiler, which shipped `annotateSourceFile`
natively — on those, you may not need this at all.
