[![site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/zebhyrus/site-generator-speed-01-run-20261122-entry/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/zebhyrus/site-generator-speed-01-run-20261122-entry/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# site-generator-speed-01-run-20261122-entry

A faster drop-in for makefun-site 1.0.0: `run(input)` returns exactly the output
tree makefun-site's `build(input)` returns for one generated site (each page's
`index.html`, the index and tag pages, `build-report.txt`, each static file),
byte for byte, in less CPU time.

It is written from scratch against makefun-site's own README and code: its
front matter, template dialect, Markdown subset, slug rule and report are its
own, not Hugo's, Zola's or Eleventy's, and its Markdown is not CommonMark.

Speed comes from fusing the reference's separate lex/parse/render passes into
single passes, from range-based inline rendering (no string slicing), from
run-accumulated HTML escaping (no per-character regex), from compiling each
template once into a JavaScript function, and from avoiding repeated work
(slug and date caches, shared card objects). No dependencies, no network, no
clock, no randomness: the output is a function of the input alone.

## Run it

```sh
# from this directory, on Node 22
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

`main.ts` reads every case from `$MAKEFUN_INPUT_DIR/cases.json` (a JSON array
of `{id, input}`), answers each one with `run` from `solve.js`, and writes
`$MAKEFUN_OUTPUT_DIR/answers.json` (a JSON array of the answers, one per case,
in the cases' order). It defaults to `/input` and `/output`.

## Layout

- `solve.js` — the whole generator: front matter, Markdown, templates and the
  build pipeline. Dependency-free ES module; `run(input)` is the entry point.
- `main.ts` — the harness driver: reads `/input/cases.json`, writes
  `/output/answers.json`.
- `package.json` — marks the entry as an ES module.
