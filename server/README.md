# jdv reference server

The reference server is a [Deno](https://deno.com/) application that connects to
R over a local JSON Lines (JSONL) transport and serves the browser viewer from
`web/`. The viewer bundles [Tabulator](https://github.com/olifolkerd/tabulator)
6.5.0 (MIT) and [Apache Arrow JavaScript](https://github.com/apache/arrow-js)
21.2.0 (Apache-2.0); their licenses, notices, and provenance are in
`web/vendor/`.

## Start from a URL

Deno 2.8 or newer is required:

```sh
deno run --allow-net --allow-read --allow-write --allow-env --no-config https://raw.githubusercontent.com/eitsupi/jdv/main/server/main.ts
```

On Windows, R connects through a named pipe by default, which requires `-A`. Add
`--tcp` to use localhost TCP with the scoped permissions above instead:

```sh
deno run -A --no-config https://raw.githubusercontent.com/eitsupi/jdv/main/server/main.ts
deno run --allow-net --allow-read --allow-write --allow-env --no-config https://raw.githubusercontent.com/eitsupi/jdv/main/server/main.ts --tcp
```

The permissions can be narrowed further to loopback networking and the cache
directory, for example on macOS and Linux:

```sh
if [ "$(uname -s)" = Darwin ]; then
  export JDV_CACHE_DIR="$HOME/Library/Caches/jdv"
else
  export JDV_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/jdv"
fi
mkdir -p "$JDV_CACHE_DIR"
deno run \
  --allow-net=127.0.0.1 \
  --allow-read="$JDV_CACHE_DIR" \
  --allow-write="$JDV_CACHE_DIR" \
  --allow-env=JDV_CACHE_DIR \
  --no-config \
  https://raw.githubusercontent.com/eitsupi/jdv/main/server/main.ts --tcp
```

Deno's network permission for a Unix socket must name its exact path, which
includes a random identifier, so this narrowed form uses TCP. Without any
permission flags, Deno prompts for each permission in the terminal as it is
needed.

## Options and security

The command prints one JSON line to standard output with `url` and `socketPath`.
Open the printed URL in a browser, then call `jdv::jdv_view(x)` in R. Data
frames and matrices open as tables; other R objects open in the tree viewer. The
server listens for browser traffic on `127.0.0.1` only. Its R listener uses a
Unix-domain socket on Unix systems and a Windows named pipe on Windows. The
cache directory and discovery file are private to the current user on Unix; the
socket has mode `0600`. Windows named-pipe access follows the OS default ACL,
which Deno does not let this server harden. The Windows pipe uses byte-type
mode; message-type pipes are unsupported.

The scoped `--tcp` command binds the R listener to an available loopback port;
the ready line and discovery file report its `tcp://` address. To choose a fixed
HTTP port, use `--http-port PORT`; the R TCP port remains ephemeral. TCP is
unauthenticated and may be reachable by other users on the same machine.
`--token VALUE` optionally protects the browser WebSocket connection; the token
is included in the printed URL and discovery file. Static viewer assets remain
available on loopback without the token.

The discovery file is written atomically to the standard jdv user cache
directory. `--cache-dir PATH` or `JDV_CACHE_DIR` selects a different directory.
When using a custom host cache directory, configure R with the matching
`options(jdv.discovery_path = ...)` or `JDV_ADDRESS` setting so it connects to
the same discovery address. On shutdown the server removes the discovery file
only when it still contains that server's process id and private instance id.

## Sequential Arrow views

Arrow tables and record batch readers, nanoarrow array streams, and polars data
frames open as forward-only views. The viewer requests bounded Arrow IPC pages
with **Load next** and keeps the row total unknown until the stream ends.
Sequential views do not support random paging, sorting, or filtering.

### Page cache

The host retains opaque Arrow IPC pages per producer session, view, and
generation, so switching views, reloading, or opening another tab can restore
received rows without another R request. Valid late replies after cancellation,
timeout, or browser detachment are also retained. Reading cached pages does not
take the stream's owner lease; advancing the R stream still does.

The default memory budget is 256 MiB total and 64 MiB per view. Each page costs
its raw byte length plus 1,024 bytes for bounded metadata, including zero-row
pages. Oldest pages are evicted first. This is accounting for retained pages,
not a JavaScript process-heap guarantee. An oversized page can be evicted
immediately; its page index, row watermark, and EOF state remain available so
the viewer can identify rows no longer retained. Closing a view, replacing its
generation, cascading a parent close, or disconnecting a producer clears its
cache.

Set byte counts with `--stream-cache-bytes` and `--stream-cache-view-bytes`; a
zero value disables the feature. For example, append
`--stream-cache-bytes 134217728 --stream-cache-view-bytes 33554432` to one of
the startup commands above.

Embedders can use `streamCacheBytes` and `streamCacheViewBytes` in
`startServer()` options. The viewer detects `welcome.capabilities.stream_cache`
and uses the host-only `stream/cache/info` and `stream/cache/get` methods.
Catalogs default to 64 pages, are capped at 128, and paginate with a monotonic
page cursor. The catalog reports lost prefixes and gaps. Cache gets use the
ordinary bounded binary frame and carry their page metadata in
`result.cache_page`. A new append sends `after_page`; a stale cursor returns
`cache_changed` before R is contacted. Older hosts without the capability keep
the existing forward-only behavior. See `?jdv_spec` in R for the protocol
contract.

The browser retains formatted display pages separately, with 8 MiB and 32 pages
per view and 32 MiB across views. Host-retained pages can be decoded again after
display eviction. Cache replies have a separate 32 MiB WebSocket queue admission
limit; exceeding it closes and detaches that browser without clearing the R
session or host page cache. Existing welcome messages, notifications, and live R
replies retain their delivery behavior. A send failure detaches the browser on
any output path. Once a range is no longer retained by the host, the
forward-only R source cannot fetch it again.

## Viewer

The viewer lists active producer sessions, grid views, and object trees. Tree
child values and drillable grid cells can be opened as independent grid or tree
views; closing a child releases it while keeping its parent available. Grid Open
buttons are shown only for columns marked `drillable`: unclassed, `AsIs`, or
`vctrs_list_of` list columns, data-frame columns, and matrix columns. Record
columns, `POSIXlt`, other classed lists, and atomic columns do not expose cell
controls. The UI always sends the original R row index after sorting, filtering,
or paging. The view breadcrumb restores the parent's query, page, and horizontal
scroll, or its object path and child-page offset.

A child open waiting for R is shown separately from page loading. Snapshot sort,
filter, and page changes keep working without canceling that original cell
request. Its child opens automatically when R handles it at the prompt, provided
the same parent view and generation remain selected. Snapshot queries run in the
browser from the cached payload; Paged queries use the WebSocket request path.
Sorting and filtering are translated to the shared query semantics, and remote
pagination fills a requested page if R reduces an individual response to fit its
output budget. Wide tables keep all schema entries but request only a fixed
width viewport column window (up to 256 columns) as the user scrolls. The viewer
requires datetime filter values to include `Z` or a numeric timezone offset in
both modes. The R request contract can interpret offset-free datetimes using the
session timezone, but the viewer applies the same explicit input rule to
Snapshot and Paged tables because it cannot infer that timezone from a cached
Snapshot.

### Resource Tree explorer

A session whose `hello` declared `capabilities.resources: true` gets an
explorer. On windows at least 900px wide the explorer is a sidebar: a
fixed-width column on the left that scrolls on its own and fits the window
height, so a long listing never moves the session list, the view list, or the
viewer, which stay in the main column. On narrower windows it is a collapsible
panel (open by default) above the viewer with a limited height and its own
scrolling. When no session declared the capability there is no sidebar and the
page keeps its single full-width column. The explorer is shown whether or not a
view is selected, and a session without views still has one, including a session
that was already connected when the page loaded. A session that did not declare
the capability shows nothing extra. The explorer lists the root with
`resources/children` when the session appears and fetches the children of a node
only when the user expands it. Several nodes can stay expanded at once.
`Load more` requests the next page at the announced `next_offset`, so a page
that holds only hidden nodes still offers the next one. Entries with an id
already listed under the same parent since the last fetch from offset 0 are
dropped as duplicates; entries without an id are never treated as duplicates.

Nodes with `hidden: true` are not shown until the `Show hidden` toggle is
checked. Only that field decides; labels such as a leading `.` are not
inspected, and the toggle filters what was already fetched without a new
request. `Open` is offered for `viewable` nodes and sends `resources/open`; the
resulting view is the one the producer registered with `view/open` (reason
`resource`), shown in the grid or tree viewer, and the response is used only to
find it. The button stays disabled while the request is in flight and a failed
open is not retried. Views opened this way have a `Close view` button in the
view list; closing one leaves the explorer unchanged. A node with `unavailable`
shows that token and cannot be expanded or opened. `kind` selects a short
symbol, and an unrecognized token is shown as `unknown`.

`Refresh` fetches the root and every visible expanded node again from offset 0
and keeps expansion and open views. A node that had several pages loaded is read
again page by page until it covers what was loaded before and every expanded
child has been found again (or the listing ends); the old listing stays on
screen until then. Nodes under a collapsed parent are fetched again when they
are next expanded. The browser tags each fetch with a local counter, unrelated
to a view generation; a response from before a refresh or a collapse is
discarded. When the session closes, the explorer and its requests are discarded.

UI state (expansion, loaded pages, paging) is kept per path, the list of node
ids from the root, so a node that the producer lists under two parents has
independent state under each. The state of a node is discarded only when its
parent's listing has been read to the end (`next_offset` null) and the node is
not in it; reading only some pages never discards anything.

### Nested Arrow cells

The sequential viewer can inspect list, large-list, fixed-size-list, struct,
map, and nested dictionary values directly from retained IPC pages. It uses
browser-only breadcrumbs and child pages of at most 200 entries; it does not
request R object navigation or convert the stream to an R data frame. Exact
64-bit integers, decimals, and timestamps keep their physical-buffer precision
inside nested values as well.

Paths stop at 32 steps, dictionary resolution rejects cycles or more than 32
hops, and labels and summaries are limited to 4,096 code units, including any
truncation marker. Null and unsupported values are leaves. Columns omitted from
IPC show their existing unsupported reason; the browser cannot reconstruct them.
A missing local IPC page can be restored from the host cache without consuming
more stream rows. If neither cache retains it, inspection reports that the page
is unavailable. The separate raw IPC cache retains at most eight pages and 32
MiB in aggregate, plus the single active inspector page.

## Browser WebSocket protocol

The WebSocket endpoint is `/ws`. It accepts frames only when `Host` names the
server's loopback host and port and `Origin` exactly matches the advertised HTTP
origin. The UI and endpoint use the advertised `127.0.0.1` origin; other origins
and DNS-rebound host names are rejected. This checks browser origin; it is not
authentication against other local processes.

On connect, a client receives a `welcome` object containing protocol version 1
and the current producer sessions and cached view descriptors. Later server
events use `session/open`, `session/closed`, `view/open`, `view/closed`, and
`notification` message types. A `view/open` message preserves the original R
protocol message, including the complete `data` payload for Snapshot views.

Send requests with a unique string id per WebSocket client and session:

```json
{
  "type": "request",
  "id": "page-1",
  "session": "r-1234-1",
  "method": "grid/rows",
  "params": { "view": "v-1", "generation": 1, "offset": 0, "limit": 200 }
}
```

The server accepts `grid/rows`, `view/schema`, `object/children`, `object/open`,
`view/close`, `view/refresh`, `view/track`, `stream/next`, `stream/cache/info`,
and `stream/cache/get`. Object requests carry the view generation and a typed
path rooted at that view. `object/children` is tree-only. Grid `object/open`
paths start with `{"kind":"cell","source_row":204,"column":2}`: the row is the
original zero-based source position and the column is its zero-based schema
position. The browser displays row numbers starting at one. Optional suffix
steps use tree path forms. The column must have `drillable: true`, and the
grid's `capabilities.children` must be true. Object child pages are capped at
500 entries; paths are capped at 32 steps. Opening a child registers a captured
value as a new view. Closing a child releases that view without closing its
parent. Responses use `type: "response"` and carry the original client id. A
`busy` event is informational and does not cancel the request. A client may send
`{"type":"cancel","id":"page-1","session":"r-1234-1"}`; it is forwarded as an R
`cancel` notification when the request was already sent. Unsent `grid/rows` and
`object/children` requests use separate coalescing rules. For the same client,
session, view, and generation, an unsent `grid/rows` request is replaced by the
latest page request. An unsent `object/children` request is replaced only by a
new request with the same full typed path; a different path stays in its own
lane. A request already sent to R is allowed to finish; later requests in the
same lane wait behind it.

`view/refresh` takes only `view` and `generation` and asks R to rebuild the view
as the next generation; it is offered by views whose descriptor has
`capabilities.refresh: true`. R sends the new `view/open` (after closing the
view's children) before the response. A newer `view/open` normally cancels
requests for the older generation, but a `view/refresh` that was already sent
keeps its response: the hub delivers its success or error unless the request
timed out, was cancelled, or the client or session went away. A success is
checked against the request (same view, `previous_generation` equal to the
requested generation, and `generation` one higher) and a mismatch becomes an
`invalid_request` error. The response only acknowledges the operation; clients
update what they show from `view/open` and must not roll back to an older
generation because of a late acknowledgement. An unsent refresh for an older
generation is invalidated like any other stale request. The bundled viewer shows
a Refresh button for these views and reopens the selected view on the new
generation with its sort, filter, selection, scroll position, and tree path
reset.

When R follows a variable, it rebuilds the view by itself and sends the usual
`view/open` for the new generation. If that fails, it sends a
`view/update_failed` notification (`view`, `generation`, `code`, `message`) and
keeps the previous generation. The hub forwards it to browsers only while
`generation` is the one it holds for that view. The bundled viewer keeps the
last display and shows the failure in its status line.

A view that follows a variable carries `tracking` (`name` and a `state` of
`active`, `paused`, or `lost`) in its `view/open`. `view/track` takes `view`,
`generation`, and a boolean `enabled` to pause or resume following. Like a sent
`view/refresh`, a sent `view/track` keeps its response when the view moves to a
newer generation, because resuming may rebuild the view; the response is checked
for the same view, the requested or the next generation, and a valid `tracking`
object. R announces a change that comes without a new `view/open` (following
lost, paused, or resumed without a rebuild) with a `view/tracking` notification
(`view`, `generation`, `tracking`). The hub keeps its cached descriptor in step,
so a browser that connects later sees the current state, and forwards the
notification only while `generation` is the one it holds. The bundled viewer
shows the state next to the Refresh button and offers a pause and resume toggle
while following is not lost.

The server also accepts the optional resource tree requests `resources/children`
and `resources/open`. They are session scope requests: `params` carries no
`view` or `generation`, so they work while a session has no views, and closing a
view or moving it to a new generation never cancels them. They end with the
requesting client (disconnect or `cancel`), a timeout, or the session, and they
use the same request, queue, byte, ACK, wake, deadline, and cancellation limits
as view requests, including the 32 active request cap. A session accepts them
only when its `hello` declared `capabilities.resources: true`; otherwise the
server answers `unsupported` without contacting the producer, while an unknown
method still gets `method_not_found`. `resources/children` takes an optional
`node` (omitted, `null`, or a non-empty id of at most 16,384 UTF-8 bytes), a
non-negative safe integer `offset`, and an integer `limit` from 1 through 500;
other values return `invalid_request`. `resources/open` requires a node id. The
server checks a successful `resources/children` result: `node` and `offset` must
repeat the request, `children` must be an array of at most `limit` entries,
`total_children` must be a non-negative safe integer or `null`, and
`next_offset` must be `null` or equal `offset` plus a non-empty page length. A
mismatch, or any binary body, becomes an `invalid_request` error. A
`resources/open` view is registered from the producer's `view/open`
notification, which arrives before the response; the response alone never
creates a view. Unsent `resources/children` requests are replaced only by a
request from the same client for the same session, node, and offset, so a
request for another page stays queued. `resources/open` is never coalesced
because every open creates a new view.

A producer that declares `capabilities.resource_changes: true` (which requires
`resources: true`; a hello that declares it without `resources`, or with a
non-Boolean value, is rejected) can announce that its resource tree may have
changed. A browser sends the session scope request `resources/subscribe` with
`params: {"enabled": <Boolean>}` and no other member; the result is
`{"enabled": <Boolean>}`. A session without the capability answers `unsupported`
without contacting the producer. A client has at most one such request active at
a time (another gets `busy`), and it uses the same request, queue, byte, ACK,
wake, and deadline limits as the other session requests. The hub owns the
subscription wishes of the browsers and keeps one producer-side subscription for
the session:

- The first subscriber makes the hub send `resources/subscribe` with
  `enabled: true` to the producer, and the client gets its success only after
  the producer succeeded. When the producer is already subscribed, the client is
  answered without a producer request. A client that subscribes while the
  producer is being changed waits for that request.
- An unsubscribe takes effect for the client at once. When the last subscriber
  leaves, by unsubscribing or by disconnecting, the hub sends `enabled: false`.
  One client leaving never stops another one.
- Only one producer request is outstanding. The hub compares what the clients
  want with what the producer is known to be doing and sends the next request
  when they differ, so a disconnect, `cancel`, or timeout while a request runs
  is undone after it ends. A `cancel` or timeout of a subscribe withdraws that
  client's wish, but a `cancel` or timeout of an unsubscribe only ends the wait
  and the client stays unsubscribed. A producer request that times out leaves
  the producer state unknown, and the hub then asks for the state it wants.
- A producer error is returned to the clients waiting for that request and the
  known producer state does not change. The hub does not retry on its own; the
  next subscribe or unsubscribe starts a new request.
- The subscription ends with the session, and it is not part of `welcome`.

The producer's `resources/changed` notification is checked (the capability was
declared and `params` is an object; unknown members are ignored) and is sent
only to the clients whose subscribe succeeded, as
`{"type": "notification", "session": <id>, "message": {"method":
"resources/changed", "params": {}}}`.
It is dropped when nobody is subscribed or the notification is malformed, and it
never takes the generic notification path. It carries no view or generation and
is neither stored nor replayed, so a client lists the tree after its subscribe
succeeds and again when it receives the notification.

Browser WebSocket input frames are limited to 64 KiB. Incoming producer JSONL
frames are limited to 10 MiB.

A producer hello has `protocol: 1`, a unique session id, and a `producer` object
with string `name` and `version` fields. An optional `runtime` object has the
same string fields. Session ids are 1–128 ASCII bytes and may contain only
letters, digits, `.`, `_`, `:`, and `-`. A session id already in use is rejected
with `in_use` while the connected session stays active.

The hello must include positive safe integer limits for `max_unacked_frames`,
`max_unacked_bytes`, `queue_messages`, `queue_bytes`, `max_request_bytes`, and
`max_message_bytes`. `capabilities` is an optional object of Boolean session
features; the only one the server uses is `resources`. A non-object
`capabilities` or a non-Boolean `resources` rejects the hello, and unknown
members are ignored. `wake` is an optional boolean that defaults to `false`; the
host sends periodic `wake` notifications only when it is `true`. The host clamps
its unacknowledged wire window to 128 frames and 512 KiB, with up to 32 frames
and 16 KiB reserved for cancellation while preserving ordinary capacity under
smaller negotiated limits. It also clamps active requests to 32 and retained
request bytes to 16 MiB. A request stays in the retained queue until its
terminal producer reply, even if the browser cancels it or its deadline expires.

Every producer acknowledges complete host frames with
`{"method":"ack","params":{"frames":N}}`, where `N` is the cumulative frame
count for that connection. A valid ACK releases wire frame and byte credit
through `N`; repeated ACKs are harmless, and invalid or future counts do not
release credit. A terminal request reply releases only that request's slot and
retained queue bytes. This separation lets the server send `wake` every 50 ms
when the producer negotiated wake support, including while an R producer is
inside an ordinary top-level wait and cannot dispatch requests until it returns
to the prompt. Frames are serialized, limited to 128 per second and 16 per send
batch. The host pauses wakes and new requests when negotiated credit is
exhausted, surfaces a busy event, and does not retry requests.

## Development

The server uses only Deno APIs and Node's built-in `node:net` adapter for named
pipes. No repository checkout, import map, or project configuration is needed
when started by URL.

Use the versions in `mise.toml` for development:

```sh
mise install
mise exec -- deno task fmt
mise exec -- deno task lint
mise exec -- deno task check
mise exec -- deno task test:unit
```

The configuration pins Deno 2.9.7 and arf 0.7.0-beta.2. In a shell with mise
activated, `deno task` uses the same pinned tools without the `mise exec --`
prefix. The repository `deno.json` defines the task split, a test-only Astral
import alias, and exclusions for formatting the vendored Tabulator and Arrow
bundles. Test and type-check tasks enforce the committed `deno.lock`. The host
uses relative imports, so URL startup remains self-contained with `--no-config`.

The arf test helper evaluates silently by default, which returns values but does
not run R task callbacks. Checks that depend on variable tracking use
`evalVisible()`, which runs through R's normal REPL (`arf ipc eval --visible`,
available since arf 0.7.0-beta.1) so the callbacks fire; its response has no
`value` or `error`.

`test:unit` lists only Deno tests that need no R, arf, or Chromium. R numeric
and query fixtures, installed-package integration, interactive transport, Arrow
round-trips, browser tests, and arf-controlled regressions belong to `test:e2e`.
In particular, the Arrow capability probe is never loaded by the unit task. The
interactive transport regression uses an arf headless R session against a real
TCP server. Where the headless console remains in a framed `browser()` wait, the
test keeps console input open to continue the frame. It also checks request
progress while an R function is sleeping, without manual RPC polling.

With arf 0.7.0-beta.2, the headless console returns EOF from `browser()` on
every platform (earlier versions did so only on Windows), so the interactive
regression holds R with a function-scoped `Sys.sleep()` instead. Holding a
`browser()` prompt is not yet tested.

For the integration task, install jdv into a scratch library and install the
optional R packages arrow, nanoarrow, jsonlite, bit64, and polars. Set
`JDV_TEST_R_LIB` to the scratch library and `JDV_TEST_BROWSER` to an existing
Chromium executable for Astral:

```sh
JDV_TEST_R_LIB=/path/to/scratch-library \
JDV_TEST_BROWSER=/path/to/existing/chromium \
mise exec -- deno task test:e2e
```

On GitHub Actions, Astral obtains its compatible Chromium binary when
`JDV_TEST_BROWSER` is unset. Local browser tests require an existing executable
and fail before acquisition when that variable (or an explicit helper path) is
missing. Binary acquisition has a separate five-minute deadline; endpoint
discovery, connection, page operations, and owned-process cleanup have shorter
bounds and phase diagnostics. In PowerShell, set `$env:JDV_TEST_R_LIB` and
`$env:JDV_TEST_BROWSER` before invoking the test task.

The manual `Test server` workflow runs formatting, linting, type checks, and
`test:unit` on Ubuntu, Windows, and macOS. Its mise tool subset installs only
Deno. The separate manual `E2E test` workflow installs the pinned Deno and arf
tools, R, the package and its optional producers, and Astral-managed Chromium on
all three platforms. It runs `test:e2e`, including all arf-controlled files;
prerequisite checks fail rather than silently skipping them when tools or
required R packages are missing. The default installed-package connection uses a
named pipe on Windows, while the interactive regression selects TCP.

The browser tests use `jsr:@astral/astral@^0.5`, resolved by the committed
`deno.lock`. CI leaves `JDV_TEST_BROWSER` unset and sets
`ASTRAL_BIN_ARGS="--no-sandbox --disable-dev-shm-usage"`. Astral supplies the
browser binary; the test helper owns its process and connects through Astral's
public API. Local tests can reuse an existing browser with `JDV_TEST_BROWSER`,
and `JDV_TEST_BROWSER_LIBS` can supply a Linux shared-library directory. Browser
wire assertions use CDP WebSocket events, including binary frame payloads,
rather than inferring responses from rendered text.

### Real R end-to-end tests

The `e2e_test.ts`, `cell_e2e_test.ts`, and `tree_e2e_test.ts` regressions use
arf to control a headless R process. They run the installed jdv package against
the real Deno server and route R traffic through a test-only TCP relay that
records compact JSON frame metadata. The relay is outside the production server
and lets tests check request counts, Snapshot descriptors, and Paged responses
without changing server behavior.

Build or install jdv into a scratch library with devtools, then run the full E2E
task with that library and an existing Chromium executable selected:

```sh
JDV_TEST_R_LIB=/path/to/scratch-library \
JDV_TEST_BROWSER=/path/to/existing/chromium \
mise exec -- deno task test:e2e
```

`mise install` provisions arf for local development, and the manual `E2E test`
workflow provisions it on each platform. These three files are included in
`deno task test:e2e`; the Deno-only workflow does not load them. The test
process prepends the selected scratch library to `.libPaths()`, loads jdv from
that exact library, and logs the package and DLL paths once. These tests cover
Snapshot queries without R requests, Paged queries without serializing the full
table at registration, request handling while R is in a top-level wait,
immediate same-process reconnection after host disconnect, and agreement between
the two query modes. The reconnect case also checks that the old table and
shared registry entries are released before the new Paged request succeeds. The
tests do not use the `jdv_rpc(NULL)` polling loop from the unit integration
fixture.

### Refresh bundled sources

Run these commands from the repository root. The vendor scripts accept paths to
local upstream checkouts. To refresh cJSON, check out the pinned `v1.7.19`
source and pass its directory:

```sh
r-pkg/dev/vendor-cjson.sh --from-upstream /path/to/cJSON
```

To regenerate the nanoarrow bundle, check out revision
`ea215b000788ec2e94fc88bad5249290c94b01cd` and pass that checkout:

```sh
python3 r-pkg/dev/vendor-nanoarrow.py \
  --upstream-dir /path/to/nanoarrow
```

The nanoarrow generator runs the upstream bundler, omits C++ wrappers, and
mechanically aggregates the flatcc headers. Its provenance file and SHA-256
manifests are regenerated with the bundle.
