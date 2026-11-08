# Browser interface

This directory contains the local table viewer, browser request helpers, and the
shared Snapshot query implementation. `index.html` loads Tabulator 6.5.0 from
the local `vendor/` directory; no runtime CDN access is required.

The vendored files are unmodified official Tabulator 6.5.0 distribution
artifacts. Upstream project: <https://github.com/tabulator-tables/tabulator>
(tag `6.5.0`); official documentation: <https://www.tabulator.info/docs/6.x/>.
The minified files were downloaded from these version-pinned package URLs:

- JavaScript:
  <https://unpkg.com/tabulator-tables@6.5.0/dist/js/tabulator.min.js>
- CSS: <https://unpkg.com/tabulator-tables@6.5.0/dist/css/tabulator.min.css>
- License: <https://unpkg.com/tabulator-tables@6.5.0/LICENSE>

The full MIT license is included as `vendor/TABULATOR-LICENSE.txt` and served
from `/assets/vendor/TABULATOR-LICENSE.txt`. SHA-256 checksums are:

- `tabulator.min.js`:
  `297f32de082fe4593d385f3a1b16b901f5208b1702ff9f64f454f3460d911170`
- `tabulator.min.css`:
  `b55e204b2f968cecc4d3663d37858093b31dd22d20f01d76f590726ee18f7e1f`
- `TABULATOR-LICENSE.txt`:
  `191a2ee554684e1064c897b432f0e1bc6dfa714ca045d3f6ea2cf692cbd398b7`

The minified Tabulator JavaScript and CSS and the vendored Arrow JavaScript
bundle should stay excluded from formatting and lint checks with Deno CLI
`--ignore` arguments. Arrow JS 21.2.0 decodes retained IPC pages for nested cell
inspection. Its upstream license, notice, source, and checksums are recorded in
`vendor/ARROW-JS-PROVENANCE.md`.

The viewer keeps each table's complete schema and renders a fixed-width column
window around the horizontal viewport. It requests only the visible window plus
a small overscan and retains access to every source column while scrolling. Sort
and filter controls can refer to columns outside the visible window. Snapshot
requests use the local query helper; Paged requests go through the server
WebSocket and fill the requested page if a response is shortened by R's output
byte limit.

The viewer requires datetime filter values to include `Z` or an explicit numeric
timezone offset in both Snapshot and Paged modes. This UI rule does not change
the R request contract, which can interpret an offset-free datetime using the R
session's timezone. The browser cannot infer that timezone from a cached
Snapshot, so the viewer applies the same explicit-offset input rule to both
modes. Text matching folds ASCII letters only.

Sequential Arrow cells with an IPC column mapping have an Inspect control. The
inspector reads nested values from the page's Arrow buffers and schema, using
the existing bounded child pagination; it does not ask R to reopen or traverse
the value. The browser keeps at most eight IPC pages and 32 MiB across views,
then asks the host page cache for an evicted page when that capability is
available. If neither cache retains the page, inspection reports that state
without advancing the R stream. Only the active inspected page is decoded for
the tree view, and closing or leaving the inspector releases that tree handle.

The Resource Tree explorer is implemented in `app.js` with its bookkeeping in
`resource_tree.js`, which has no DOM dependency so unit tests can exercise it.
It appears only for sessions whose `hello` declared
`capabilities.resources: true` and renders one explorer per session in the
`#resources` section, independently of the selected view. Each node keeps its
expansion state, the children fetched so far, the next offset, and a
browser-local fetch generation that discards responses made obsolete by a
refresh or a collapse. The `hidden` field alone decides whether a node is hidden
by default. Row text (label, class names, summary, unavailable reason) is built
with the same helpers as the Object Tree and always set through `textContent`.
