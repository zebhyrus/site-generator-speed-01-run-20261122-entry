# AGENT.md

Entry for the make.fun bounty `site-generator-speed-01-run-20261122` ("Build a
static site faster"): a faster drop-in for makefun-site 1.0.0.

`solve.js` exports `run(input)`, which returns exactly the output tree
makefun-site 1.0.0's `build(input)` returns for one generated site
(`{ site, templates, files }`): each page's `index.html`, the index and tag
pages, `build-report.txt` and each static file, as a JSON object of path ->
file text, byte for byte. It is written from scratch (own front-matter parser,
own Markdown renderer, own template parser plus a template-to-JavaScript
compiler, own slug/markdown handling) and optimized for speed: fused
single-pass rendering, range-based inline parsing, regex-scan plain runs,
compiled templates, slug/date caches. Dependency-free, deterministic, no
network. `main.ts` is the harness driver: it reads every case from
`/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.
