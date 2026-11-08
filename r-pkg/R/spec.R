#' jdv JSON Lines Protocol Specification
#'
#'
#' This document is organized into four parts: the common protocol, the R
#' producer extension, the reference host, and the browser viewer. The common
#' protocol describes wire behavior without requiring R. The remaining parts
#' identify behavior specific to the current R producer, the reference host, and
#' the browser client.
#'
#' The envelope is JSON-RPC-like, but it is not JSON-RPC 2.0: messages use a
#' `method` and `params`, while successful responses use `id`, `result`, and
#' `warnings`. A request that expects a response has an `id`. Notifications such
#' as `wake`, `cancel`, and `ack` omit the id and have no response.
#'
#'
#' @section Common protocol: Compatibility and encoding:
#'
#'
#' - Each JSON transport message is one UTF-8 JSON value framed as one complete
#'   JSON value per line with a trailing LF. A partial line is retained only up to
#'   the configured request byte limit. An Arrow IPC response may be followed by an
#'   opaque binary body as described below.
#' - The only supported envelope encoding is `json`; the only supported compression
#'   is `none`. Both fields may be omitted to select those defaults. Unknown values
#'   produce an `unsupported` error.
#' - A view id is a string. Column positions, `source_row` values, and sequential
#'   `first_row` offsets are zero-based. `source_row` is the original source-row
#'   position, including after filtering and sorting. Browser row labels display
#'   that position plus one.
#' - Request ids are either strings of at most 128 UTF-8 bytes or JSON integer
#'   literal tokens from 0 through `2^53 - 1`. Fractional and exponent-form numeric
#'   ids are rejected, even when their mathematical value is integral. The same
#'   rule applies to `cancel.params.id`. When a response echoes a valid numeric id,
#'   its JSON encoder may use exponent notation as long as the exact safe-integer
#'   value is preserved.
#' - Envelope and method-parameter objects ignore unknown fields for forward
#'   compatibility. Filter, sort, and `stream/next` parameter objects remain
#'   strict. Duplicate object keys are rejected. Unknown methods return
#'   `method_not_found`.
#' - The page request method is `grid/rows` and identifies its owner with
#'   `params.view`. Lifecycle methods use the view names listed below; the former
#'   `table/open`, `table/closed`, `table/schema`, and `table/close` names are not
#'   aliases.
#' - Unknown optional schema fields must be ignored by clients. Protocol v1 does
#'   not define cell inspection.
#' - The parser rejects malformed JSON number grammar, invalid UTF-8, decoded
#'   U+0000, trailing non-whitespace data, nesting deeper than 128, more than
#'   100,000 JSON nodes, or an object with more than 1,024 members. The literal
#'   six-character content `\u0000` is valid when represented in JSON as
#'   `"\\u0000"`; a JSON escape that decodes to U+0000 is rejected. These
#'   structural limits apply to inbound requests.
#'
#'
#' @section Common protocol: Message envelopes:
#'
#'
#' A view descriptor is sent as a notification:
#'
#' ```json
#' {
#'   "method": "view/open",
#'   "params": {
#'     "view": "v-1",
#'     "generation": 1,
#'     "title": "example",
#'     "reason": "register",
#'     "kind": "grid",
#'     "access": "random",
#'     "encoding": "jdv-json",
#'     "capabilities": {
#'       "seek": true,
#'       "sort": true,
#'       "filter": true,
#'       "known_total": true,
#'       "next": false,
#'       "children": false,
#'       "refresh": true,
#'       "track": false
#'     },
#'     "collation": "C",
#'     "nrow": 100,
#'     "ncol": 2,
#'     "columns": []
#'   }
#' }
#' ```
#'
#' The example omits schema entries for brevity. `view/open` is a producer-to-
#' viewer notification with no request id. `kind` is `grid`; `access` is
#' `snapshot` or `random`; and `encoding` is `jdv-json`. The `capabilities`
#' object and any known capability fields may be omitted; an omitted object or
#' field means `false`. A grid descriptor declares the operations it supports.
#' Each column's `sortable` field constrains sorting, and `filterable`
#' constrains value-based filter operators. Grid `children` is true if and only
#' if at least one column has `drillable: true`. `refresh` tells the host that
#' `view/refresh` is accepted.
#' | Descriptor field                                                   | Grid                                      |
#' | ------------------------------------------------------------------ | ----------------------------------------- |
#' | `view`, `generation`, `kind`, `access`, `encoding`                | Required                                  |
#' | `capabilities`                                                     | Optional; missing flags are false         |
#' | `title`, `reason`                                                  | Optional                                  |
#' | `nrow`, `ncol`, `columns`                                          | Required                                  |
#' | `collation`                                                        | Required for Snapshot and Random access   |
#' | `data`                                                             | Required for snapshot access; otherwise omitted |
#'
#' `view` is a non-empty string and `generation` is a positive safe integer that
#' identifies the current build of that view. `collation` is exactly `"C"` or
#' `"locale"` and selects the string order described under Stable multi-column
#' sort in the \link[=jdv_query_spec]{query specification}.
#'
#' `reason` is a fixed token that tells the host why a `view/open` was sent.
#' More values may be added; a host treats an unknown or missing value as
#' `"register"`.
#'
#' | `reason`     | Sent when                                                                                                                                     |
#' | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
#' | `"register"` | A producer opens or replaces a view. |
#' | `"child"`    | A child view is opened by `object/open`.                                                                                                      |
#' | `"tracked"`  | A producer rebuilds a tracked view automatically.                                                                                               |
#' | `"refresh"`  | A view is rebuilt by `view/refresh`.                                                                                                          |
#' | `"resource"` | A view is opened by `resources/open` (see Resource trees).                                                                                    |
#'
#' A host can bring a view to the front for `"register"`, `"child"`, and
#' `"resource"`, and update it quietly for `"tracked"` and `"refresh"`.
#'
#' Grid-level flags declare the operations available in protocol v1; each
#' column's `sortable` field constrains sorting, and `filterable` constrains
#' value-based filter operators. `filterable` is false for columns of type
#' `list` and `other`, and `is_na` remains valid when a valid missingness mask
#' is available, even when `filterable` is false. Snapshot access may use
#' `nrow: null` when its row count is unknown. Random access requires a
#' non-negative integer `nrow`, `capabilities.seek: true`, and
#' `capabilities.known_total: true`; this lets clients address any requested
#' offset and report the complete row count. Sequential access uses `nrow: null`
#' and is specified separately below. The protocol does not define `total_rows`.
#' The descriptor's `encoding` field does not change the envelope's
#' `encoding: "json"` setting. Snapshot access's `params.data` contains the full
#' data payload as described under the Column payloads section below.
#'
#' Tree descriptors and navigation are an R producer extension described below.
#'
#' A request envelope has this shape:
#'
#' ```json
#' {
#'   "id": 1,
#'   "method": "grid/rows",
#'   "params": {
#'     "view": "v-1",
#'     "generation": 1,
#'     "offset": 0,
#'     "limit": 200
#'   },
#'   "encoding": "json",
#'   "compression": "none",
#'   "deadline": 1791849600.0
#' }
#' ```
#'
#' Only `method` is required at the envelope level. `id` is required for methods
#' that return a result. `params` is required by view methods and `cancel`.
#' Unknown envelope and method-parameter fields are ignored. `encoding`,
#' `compression`, and `deadline` are optional. `deadline`, when provided, must
#' be a finite JSON number containing an absolute Unix timestamp in seconds. A
#' synchronous or queued request that is past its deadline before execution
#' begins receives an `expired` error response.
#'
#' The configured request byte limit applies to the entire JSON text. The parser
#' also validates strict JSON number syntax and rejects duplicate object keys.
#'
#' Warnings are collected up to 100 messages, each truncated to 512 characters.
#' If more warnings occur, the array ends with
#' `"Additional warnings were omitted."`.
#'
#' A successful response is:
#'
#' ```json
#' {
#'   "id": 1,
#'   "result": {},
#'   "warnings": []
#' }
#' ```
#'
#' Every response includes a `warnings` array, including an empty array when no
#' warnings were raised. An error response is:
#'
#' ```json
#' {
#'   "id": 1,
#'   "error": {
#'     "code": "invalid_request",
#'     "message": "Invalid request."
#'   },
#'   "warnings": []
#' }
#' ```
#'
#' Errors raised after request processing begins are returned to the request
#' caller. Their `code` distinguishes the failure class; `message` is bounded
#' text and must not be used as a stable machine-readable discriminator. An
#' error may also include `details`. Every accepted request receives exactly one
#' terminal response. Work cancelled, expired, or stale before it begins
#' receives an error response with code `cancelled`, `expired`, or
#' `stale_generation`; a closed view receives `view_not_found`. The host matches
#' cancellation ids to pending work before execution. `ack` is transport-owned.
#'
#'
#' @section Common protocol: Arrow IPC binary responses:
#'
#'
#' An Arrow IPC body is reserved for a successful, id-bearing response. Its
#' JSONL header has the ordinary response envelope and a `result.transfer`
#' descriptor:
#'
#' ```json
#' {
#'   "id": "jdv-request-id",
#'   "result": {
#'     "view": "v-1",
#'     "generation": 1,
#'     "transfer": { "encoding": "arrow-ipc", "byte_length": 1234 }
#'   },
#'   "warnings": []
#' }
#' ```
#'
#' The header line is followed immediately by exactly `byte_length` opaque
#' bytes, then by the next JSONL message. The receiver must not decode the body
#' as UTF-8, scan it for LF, or call the response handler before all bytes
#' arrive. The descriptor is not valid on notifications, errors, or `ack`.
#' `byte_length` is a non-negative safe integer. The response `id` is the
#' host-issued request id and must be a string. The UTF-8 JSON header is limited
#' to 64 KiB, and the header, its LF, and body together are limited to 10 MiB.
#' The body has an absolute 30-second receive timeout; fragments do not extend
#' it. Invalid lengths, oversized frames, EOF, or timeout close the producer
#' connection and fail pending requests as disconnected. Cancellation, expiry,
#' and stale or unknown response ids still drain a valid body before the next
#' JSONL message is read.
#'
#' There is no checksum or delimiter after the raw body. A sender that declares
#' a shorter length may be detected when the remaining bytes cannot form a valid
#' JSONL frame, but framing alone cannot detect a remainder that happens to be a
#' valid JSONL message.
#'
#' The host forwards a response to the browser as one WebSocket binary message:
#' four bytes containing the UTF-8 JSON header length as an unsigned
#' little-endian integer, followed by the JSON header, followed by the unchanged
#' raw body. The header is rewritten with the browser request id and session.
#' The rewritten header remains limited to 64 KiB, and the complete WebSocket
#' message to 10 MiB. If either limit or the request's `max_bytes` is exceeded,
#' the host returns one `limit_exceeded` error after draining the producer body
#' and continues with the next JSONL frame.
#'
#' For a request that can return a binary body, `params.max_bytes` is optional.
#' When present it must be a non-negative safe integer; zero is valid. Its
#' default is the effective binary body cap. The producer caps a response at the
#' smaller of `params.max_bytes` and its configured message budget after
#' reserving space for the JSON header and framing. The host applies the
#' producer-reported cap and checks the returned byte length against the request
#' before forwarding it. After draining the body, the host checks that the
#' response view and generation match the pending request; a mismatch returns
#' one `invalid_request` or `stale_generation` terminal error.
#'
#' @section Common protocol: Sequential Arrow views:
#'
#'
#' Sequential descriptors have `kind: "grid"`, `access: "sequential"`,
#' `encoding: "arrow-ipc"`, `nrow: null`, and a non-negative integer `ncol`. The
#' common `view`, `generation`, and `columns` fields are also required. Only the
#' `next` capability is true; `seek`, `sort`, `filter`, `known_total`,
#' `children`, `refresh`, and `track` are false. The producer supplies the
#' schema and owns the forward-only Arrow stream for the lifetime of the view
#' generation.
#'
#' Each Arrow IPC body carries its logical schema. The descriptor's `columns`
#' array remains in original source order and retains each column's `index`,
#' `name`, `type`, `unsupported`, `ipc_index`, `position`, `sortable`,
#' `filterable`, and `drillable` fields. `index`, `position`, and non-null
#' `ipc_index` values are zero-based. `unsupported` is null for supported
#' columns and otherwise explains why a column was omitted from IPC; its
#' `ipc_index` is null. Names may repeat and must not be used to identify IPC
#' vectors; use `ipc_index`. Even a page with no supported columns reports its
#' row count in page metadata.
#'
#' `stream/next` accepts only `view`, `generation`, `max_rows`, and `max_bytes`.
#' `max_page_rows` is a required descriptor field containing the positive
#' safe-integer row cap captured when the view is opened. `max_rows` defaults to
#' `min(200, captured cap)` and must be a positive safe integer no larger than
#' that cap. The viewer requests `min(200, descriptor.max_page_rows)` rows and
#' validates returned row counts against that request. The host rejects an
#' invalid or missing `max_page_rows`, and rejects `max_rows` above the captured
#' cap before granting a lease. `max_bytes` uses the shared binary response
#' budget above. Zero is a valid budget but returns `limit_exceeded` before
#' fetching because it cannot hold an IPC stream. Offset, sorting, filtering,
#' and count requests are rejected. Random `grid/rows` is unavailable for
#' sequential views.
#'
#' A successful binary response carries `view`, `generation`, `first_row`,
#' `rows_fetched`, `rows_seen`, `done`, and the reserved `transfer` object.
#' `first_row` is the zero-based source cursor before this page;
#' `rows_seen = first_row + rows_fetched`. Each page is a self-contained IPC
#' stream and never crosses an input batch boundary. `done` becomes true only
#' after the producer's end-of-stream sentinel has been observed. A data page
#' can therefore have `done: false` even when it contains the last rows. A
#' following schema-only zero-row page can report `done: true`. Empty batches
#' are skipped with bounded work; reaching that bound yields zero rows and
#' `done: false`, which clients must not treat as EOF.
#'
#' The host leases a view generation to the first attached browser whose next
#' request is accepted. Other browsers receive `in_use` while that owner remains
#' attached, including between pages. At most one next request is pending per
#' view generation. Cancellation, timeout, or owner detachment does not fail the
#' producer stream and does not rewind a sent request. Its slot remains reserved
#' until the late terminal response is drained and discarded. Detachment
#' releases the lease; a new owner then starts at the current source cursor. No
#' additional host-to-producer failure control is sent. The host validates
#' current generation and budgets before granting a lease. A producer connection
#' loss closes all its views.
#'
#' Producer schema/array/next failures and a single row exceeding the page
#' budget make the producer stream terminally failed and release its resources.
#' Later next requests return `stream_failed`. Ordinary encoder/allocation
#' failures retain the carry and uncommitted offset for retry. Request
#' cancellation and host timeout are separate from these producer failures.
#'
#' @section Common protocol: Methods:
#'
#'
#' | Method            | Direction            | Kind         | Result                                                                        |
#' | ----------------- | -------------------- | ------------ | ----------------------------------------------------------------------------- |
#' | `view/open`       | Producer to viewer   | Notification | Descriptor and, for snapshot access, all column payloads.                    |
#' | `view/schema`     | Host to producer     | Request      | Current dimensions and schema.                                                |
#' | `stream/next`     | Host to producer     | Request      | One forward-only Arrow IPC page and cursor metadata.                          |
#' | `grid/rows`       | Host to producer     | Request      | One selected page from a random-access grid.                                  |
#' | `view/refresh`    | Host to producer     | Request      | Rebuilds a view as the next generation of the same id.                        |
#' | `view/close`      | Host to producer     | Request      | Closes one view generation.                                                   |
#' | `view/closed`     | Producer to host     | Notification | Removes a closed or replaced generation from the host cache.                  |
#' | `hello`           | Producer to host     | Notification | Announces protocol and producer metadata for a new connection.                |
#' | `wake`            | Host to producer     | Notification | No result; asks the producer to check for pending work.                       |
#' | `cancel`          | Host to producer     | Notification | Names pending work for the producer to cancel.                                |
#' | `ack`             | Producer to host     | Notification | Cumulatively acknowledges complete host-to-producer JSONL frames read.       |
#'
#' The optional `resources/children` and `resources/open` methods are described
#' under Resource trees.
#'
#'
#' @section Common protocol: `view/schema`:
#'
#'
#' Parameters are `view` and `generation`. The result contains `view`,
#' `generation`, `nrow`, `ncol`, and `columns`. A generation that is no longer
#' current produces `stale_generation` when handled synchronously. A missing or
#' closed view produces `view_not_found`.
#'
#'
#' @section Common protocol: `view/refresh`:
#'
#'
#' `view/refresh` is a request with an id. Its `params` identify the active view
#' using the required `view` and `generation` fields. The descriptor's
#' `capabilities.refresh` field gates this operation: when it is false or
#' omitted, the host must not offer refresh, and a request that nevertheless
#' reaches the producer fails with `unsupported`. A missing view fails with
#' `view_not_found`; a generation that is no longer current fails with
#' `stale_generation`.
#'
#' On success, the producer replaces the descriptor under the same view id and
#' advances its generation by exactly one. It sends the replacement `view/open`
#' notification before the successful response. The result contains the view id,
#' `previous_generation`, the new `generation`, and `refreshed: true`. The
#' `view/open` is authoritative for the active descriptor; the response confirms
#' the operation and must not restore an older generation in the host or viewer.
#' A failed refresh returns an error without publishing a new generation. The
#' replaced generation does not need a separate `view/closed` notification.
#'
#'
#' @section Common protocol: `view/close` and `view/closed`:
#'
#'
#' `view/close` is a request with an id. Its `params` identify the active view
#' using the required `view` and `generation` fields. A missing view fails with
#' `view_not_found`; a generation that is no longer current fails with
#' `stale_generation`. On success, the producer removes that generation and
#' returns a result containing the same `view` and `generation` with
#' `closed: true`. The response completes an explicit host-initiated close; the
#' producer does not also send `view/closed` for that close.
#'
#' A producer sends `view/closed` as a notification when a view generation
#' becomes unavailable without a matching host-initiated `view/close` request or
#' a successor `view/open` notification replacing it. Its `params` contain
#' `view` and `generation`; an optional `reason` may provide additional
#' producer-defined context. A host removes the cached view only when both
#' identifiers still match its active descriptor. It ignores a notification for
#' a generation that has already been replaced or removed.
#'
#'
#' @section Common protocol: `grid/rows`:
#'
#'
#' Parameters are:
#'
#' | Field        | Required | Meaning                                                                                   |
#' | ------------ | -------- | ----------------------------------------------------------------------------------------- |
#' | `view`       | Yes      | Registered view id.                                                                       |
#' | `generation` | Yes      | Generation returned by `view/open`.                                                       |
#' | `offset`     | No       | Zero-based offset after filtering and sorting; defaults to 0.                             |
#' | `limit`      | No       | Requested page size; defaults to 200 and is clamped to the producer's page row limit. |
#' | `sort`       | No       | Array of `{ "col": zeroBasedPosition, "desc": boolean }` objects; defaults to no sort.    |
#' | `filter`     | No       | Filter AST defined by \link[=jdv_query_spec]{query specification}; defaults to no filter.                      |
#' | `cols`       | No       | Array of zero-based column positions; omitted or `null` selects all columns.              |
#'
#' The result contains `view`, `generation`, `total`, `total_unfiltered`,
#' `offset`, `limit`, and `data`. The returned `offset` equals the requested
#' offset, and the returned `limit` is a safe integer between the number of
#' returned rows and the requested limit. `data` contains `source_row`, optional
#' `row_labels`, and `columns`. The effective `limit` is clamped to the query
#' engine's row limit and may be reduced further to fit the JSON output budget.
#' For an empty page, `source_row` and explicit `row_labels` are empty arrays;
#' `columns` still contains one schema/data/errors wrapper per selected column,
#' with empty channel arrays. Only `cols: []` produces an empty `columns` array.
#'
#' Column selectors are positions rather than names, so duplicate or unusual
#' column names are safe. `cols: []` requests only the row metadata. An omitted
#' or `null` `cols` selects every column. A producer may reduce the effective
#' `limit` to satisfy its response budget; if the fixed page schema or one row
#' cannot fit, the request returns `limit_exceeded`. The R producer estimates a
#' row count for the selected columns against its page work and response budgets
#' before extracting page channels, preserving all selected columns. Snapshot
#' access rejects row requests with `unsupported` because its payload is
#' host-cached.
#'
#'
#' @section Common protocol: `hello`:
#'
#'
#' At the start of each producer-to-host connection, the producer sends a
#' `hello` notification with no request id:
#'
#' ```json
#' {
#'   "method": "hello",
#'   "params": {
#'     "protocol": 1,
#'     "session": "producer-1",
#'     "producer": {
#'       "name": "example-producer",
#'       "version": "1.0.0"
#'     },
#'     "wake": true,
#'     "capabilities": {
#'       "resources": true
#'     },
#'     "limits": {
#'       "max_unacked_frames": 264,
#'       "max_unacked_bytes": 1048577,
#'       "queue_messages": 256,
#'       "queue_bytes": 16777216,
#'       "max_request_bytes": 1048576,
#'       "max_message_bytes": 10485760
#'     }
#'   }
#' }
#' ```
#'
#' `session` is an opaque session identifier. It is 1–128 ASCII bytes and may
#' contain only letters, digits, `.`, `_`, `:`, and `-`. A receiver must not
#' infer a process id or connection counter from it. A host rejects an invalid
#' identifier, and rejects a duplicate active identifier with `in_use`.
#' `producer` identifies the producer: `name` and `version` are UTF-8 strings
#' from 1 through 256 bytes each. `runtime` is optional; when present, it has
#' string `name` and `version` fields, each also 1 through 256 UTF-8 bytes. A
#' receiver rejects the handshake if any supplied metadata value is empty,
#' invalid UTF-8, or exceeds the byte limit. Protocol major version 1 is the v1
#' contract in this document. A peer that does not support the announced major
#' version rejects the handshake with `unsupported`; it must not continue with
#' incompatible message semantics.
#'
#' `wake` is optional and, when present, is a Boolean. An omitted value means
#' `false`; any other type is invalid. When `true`, the host must send periodic
#' `wake` notifications while requests await terminal responses. When omitted or
#' `false`, the host must not send `wake`. A producer that needs periodic wakes
#' sets `wake` to `true`.
#'
#' `capabilities` is optional and, when present, is an object of optional
#' session-level features. Each known member is a Boolean; any other value is
#' invalid. An omitted member or object means `false`. Unknown members are
#' ignored. The only member defined in v1 is `resources`, which declares the
#' resource tree methods (see Resource trees). A host that does not use a
#' feature ignores its member; declaring a feature does not by itself cause any
#' request or notification. Capabilities are fixed for the session when `hello`
#' is sent.
#'
#' `hello` is the first producer message on a new connection. A disconnect
#' closes the views associated with that connection.
#'
#' `params.limits` is required and contains all six required limits, each a
#' positive safe integer: `max_unacked_frames` and `max_unacked_bytes` bound the
#' complete host-to-producer JSONL frames and bytes sent without cumulative
#' acknowledgement; `queue_messages` and `queue_bytes` bound producer-side
#' pending work; `max_request_bytes` and `max_message_bytes` bound one request
#' and one producer message. A host uses the smaller of each reported value and
#' its own configured bound. Missing or invalid limits reject the handshake.
#'
#'
#'
#' @section Common protocol: `wake` and `cancel`:
#'
#'
#' `wake` has no response and no parameters. A host must not send it when
#' `hello.params.wake` is omitted or `false`; when that value is `true`, the
#' host must send wakes repeatedly at a regular interval while one or more
#' requests are awaiting terminal responses. A producer that needs periodic
#' wakes sets `wake` to `true`. A host may choose any regular interval and must
#' keep wakes within applicable frame, byte, and send-rate limits.
#'
#' `cancel` has no response and takes `{ "id": requestId }` in `params`. It
#' identifies a request by the same string-or-safe-integer rules as envelope
#' ids. Ids retain their JSON type, so the string `"1"` does not match numeric
#' id `1`. A producer cancels matching work that has not begun and sends one
#' `cancelled` terminal error. Work already running is not forcibly interrupted
#' by this notification and produces its ordinary terminal response. The
#' producer validates the full control envelope, including encoding,
#' compression, and deadline, before it changes pending work. Unsupported
#' encoding or compression and an expired recognized cancel have no effect and
#' produce no notification response. Malformed JSON, an invalid raw id token, or
#' an invalid deadline type can be rejected during request validation with a
#' best-effort `invalid_request` response whose id is `null`; these errors do
#' not change pending work.
#'
#'
#' @section Common protocol: `ack`:
#'
#'
#' Every producer must send `{"method":"ack","params":{"frames":N}}` after it
#' has read one or more complete frames. `N` is the cumulative number of
#' complete host-to-producer JSONL frames read on that connection, including
#' `wake`, `cancel`, malformed, and rejected frames. It is a safe integer and
#' never decreases. The host releases frame and byte credit through that
#' cumulative frame boundary.
#'
#'
#' @section Common protocol: Column types:
#'
#'
#' The schema `type` of a column is one of the following values. This table and
#' the rules below are the protocol contract; filter operators and operand forms
#' are defined in the \link[=jdv_query_spec]{query specification}.
#'
#' | `type` | Additional schema fields | Value filter operators |
#' | --- | --- | --- |
#' | `boolean` | | `is_true`, `is_false` |
#' | `integer`, `number` | | `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `between` |
#' | `string` | | `contains`, `starts_with`, `ends_with`, `text_equals` |
#' | `categorical` | `levels`, `ordered` | The text operators, and `in` |
#' | `date` | | `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `between` |
#' | `datetime` | `tz` | `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `between` |
#' | `int64` | | `eq`, `between` |
#' | `duration` | `units` | `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `between` |
#' | `list`, `other` | | None |
#'
#' Every column type also accepts `is_na` when a valid missingness mask is
#' available. A client decides what it can do with a column from `type`,
#' `filterable`, `sortable`, and the grid `capabilities` alone. The schema's
#' optional `native_type` field is a producer-defined array of display strings.
#' A client may show those strings as a hint but must not infer semantics from
#' them. How R vectors map to protocol types is described, as informative text,
#' in the R column mapping section of
#' \link[=jdv_query_spec]{query specification}, and can change without a
#' protocol version change.
#'
#' A client that receives a `type` it does not know must treat the column as
#' display-only, exactly like `other`: it follows the column's `sortable` for
#' sorting, offers no value-based filter, and uses only `is_na`. It must not
#' fail, hide the column, or guess from `native_type`. Because of this rule, a
#' new `type` can be added without changing the protocol major version. For the
#' same reason, a later release may add operators or operand forms to a known
#' type; a client offers only the operators it knows for that type and must be
#' prepared for the server to answer a request with an `unsupported` error,
#' which is an ordinary failure of that request and not a protocol violation.
#'
#'
#' @section Common protocol: Column payloads:
#'
#'
#' Column identity is its zero-based `position`; `name` is display metadata and
#' may be empty, duplicated, or otherwise unusual. A schema entry includes
#' `position`, `name`, `type`, `sortable`, and `filterable`; `native_type` is
#' optional and, when present, is a producer-defined array of display strings.
#' Categorical schemas also include `levels` and `ordered`; datetime schemas
#' include `tz`; duration schemas include `units`. Unknown optional schema
#' fields must be ignored by clients so future schema extensions remain
#' compatible; the Column types section defines how to treat an unknown `type`
#' value.
#'
#' A column payload is columnar. Channels may be omitted when unavailable:
#'
#' ```json
#' {
#'   "values": [1, null, null],
#'   "display": ["1", "NaN", "NA"],
#'   "special": {"nan": [1]},
#'   "na_rows": [1, 2]
#' }
#' ```
#'
#' `values`, `display`, and `sort_key`, when present, have one entry for each
#' row in the payload. `na_rows` lists missing row positions in this response,
#' starting at zero, in strictly increasing order without duplicates. Positions
#' must be integers within the payload's row count; they are not `source_row`
#' identifiers. `na_rows` is sent whenever missingness extraction succeeds,
#' including `[]` when no rows are missing. Omission means missingness is
#' unavailable. It is authoritative; clients must not infer missingness from
#' display text. A producer may omit an unavailable channel while keeping other
#' channels usable. Clients use descriptor capabilities and channel availability
#' to decide which operations are available.
#'
#' `special`, when present, is an object with only `nan`, `pos_inf`, and
#' `neg_inf` keys, in that producer order. Each value is a nonempty array of row
#' positions with the same integer, order, uniqueness, and range requirements as
#' `na_rows`. Empty kinds are omitted, and the whole field is omitted when no
#' kind occurs. Kinds must not overlap. NaN positions also occur in `na_rows`
#' when missingness is available, following R's `is.na()` semantics; infinities
#' are not missing. Clients reject invalid position channels as
#' `schema_changed`. The old `na` field and per-row `special` arrays are not
#' part of this format.
#'
#' In snapshot access, `data.columns` entries contain the complete channel data.
#' A random-access response wraps each selected column as `{ "schema": ...,
#' "data": ..., "errors": ... }`, preserving the page-time schema. The `data`
#' object inside that wrapper uses the same channel format. Random-access rows
#' do not include `sort_key`; sorting remains on the producer side.
#'
#' The following encoding rules apply:
#'
#' - `boolean`, `integer`, and finite `number` values use JSON booleans or numbers.
#'   `duration` values are numbers in the schema's `units` (`secs`, `mins`,
#'   `hours`, `days`, or `weeks`), with the same missing and non-finite rules as
#'   `number`; `display` carries the formatted text.
#'   Missing values use JSON `null` and are identified by `na_rows`.
#' - Non-finite doubles use JSON `null` in `values`; `special` identifies NaN
#'   and positive or negative infinity by row position. NA is represented only
#'   by `na_rows`. Numeric comparisons and sorting restore infinities from
#'   `special`; `na_rows` controls missingness and NA-last placement.
#' - `int64` values are canonical base-10 JSON strings, never JSON numbers, to
#'   preserve exact integer precision. `na_rows` identifies missing entries. The
#'   `display` channel may be omitted only when its nonmissing labels equal
#'   `values` and every missing label is `"NA"`. The client reconstructs display
#'   from values, using `"NA"` for missing entries. A producer may retain
#'   `display` when its display text does not meet this rule.
#' - `string` and `categorical` values are strings. The `display` channel may be omitted
#'   under the same equality and missing-label rule. Categorical order and labels come
#'   from `levels` and `ordered` in the schema.
#' - `date` values are ISO `YYYY-MM-DD` strings. `datetime` values are ISO
#'   timestamp strings; the schema's `tz` records the source time-zone setting.
#' - In snapshot access, `sort_key` is present when a value's ordering cannot be
#'   recovered from its `values` and `special` entries. It carries the producer's ordering
#'   key; consumers compare keys rather than recomputing a producer's native
#'   ordering. A `null` sort key is ordered after every non-null key, regardless
#'   of `na_rows`. random-access rows never include sort keys.
#' - `source_row` always reports zero-based positions in original source order.
#'   Snapshot `data` and random-access page `data` may contain one `row_labels`
#'   string per row; an absent or `null` field means there are no explicit row
#'   labels. Grid descriptors do not contain `row_labels`.
#'
#' Snapshot-access payloads contain all table rows in one `data` object.
#' Random-access payloads contain only the requested row slice. The protocol
#' guarantees matching sort and filter semantics, not identical display strings.
#'
#'
#' @section Common protocol: Filter and sort request shape:
#'
#'
#' The filter is the neutral AST defined by
#' \link[=jdv_query_spec]{query specification}, not a UI library's filter model.
#' Objects contain exactly the fields required by their operator. Sort is an
#' array of objects with exactly `col` and `desc`; `desc` is a required scalar
#' Boolean. Duplicate sort and page columns are invalid. Cross-consumer examples
#' of filters, values, and expected original row indices are in the fixture
#' described in the \link[=jdv_query_spec]{query specification}.
#'
#' Numeric filter special values use an explicit object, never a non-JSON
#' number:
#'
#' ```json
#' { "op": "eq", "col": 0, "value": { "special": "pos_inf" } }
#' ```
#'
#' `int64` filter values are canonical decimal strings. Missing and special
#' value semantics follow the \link[=jdv_query_spec]{query specification}.
#'
#'
#' @section Common protocol: Errors and limits:
#'
#'
#' Error codes are stable machine-readable values. The `error` object contains
#' `code` and `message`, with optional `details`. The current codes include:
#'
#' A consumer treats an unrecognized code as a general producer failure and may
#' display the code without requiring code-specific recovery behavior.
#'
#' | Code               | Meaning                                                                                                                                                         |
#' | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
#' | `invalid_request`  | Malformed JSON, missing required fields, strict filter/sort field errors, or invalid parameters.                                                                |
#' | `unsupported`      | A known operation or encoding is not supported for this table or protocol version.                                                                              |
#' | `limit_exceeded`   | A configured request, page, or JSON byte limit was exceeded.                                                                                                    |
#' | `schema_changed`   | The active view schema no longer matches its descriptor, or a required channel is unavailable. |
#' | `producer_error`   | A producer method or other request computation failed.                                                                                                          |
#' | `interrupted`      | Request processing began and was interrupted.                                                                                                                   |
#' | `cancelled`        | The accepted request was cancelled before processing began.                                                                                                     |
#' | `expired`          | The request deadline elapsed before processing began.                                                                                                           |
#' | `unavailable`      | A well-formed object path or resource node no longer resolves or cannot be read safely.                                                                         |
#' | `stale_generation` | The request names a generation that is no longer active.                                                                                                        |
#' | `view_not_found`   | The view id is missing or closed.                                                                                                                               |
#' | `cache_changed`    | A host-only sequential append cursor differs from the observed tail; refresh the host page catalog before advancing.                                            |
#' | `in_use`           | A session id is already active, another browser owns the sequential lease, a next request is still pending, or a reentrant operation cannot proceed.      |
#' | `stream_failed`    | A sequential producer encountered a terminal failure; close or register a new stream to continue.                                                               |
#' | `method_not_found` | No implementation exists for the requested method.                                                                                                              |
#'
#' Request and response size limits are negotiated in `hello`. A producer that
#' cannot satisfy a request or configured budget returns `limit_exceeded`.
#' Per-column channel failures may be reported in the page payload without
#' failing the entire request.
#'
#'
#' @section Common protocol: Resource trees:
#'
#'
#' A resource tree lists the resources a session offers, such as the top-level
#' variables of an interpreter or the catalogs, schemas, and tables of a
#' database connection, so a viewer can browse them without opening a view
#' first. It is optional: a producer declares it with
#' `hello.params.capabilities.resources: true`. A host that does not use
#' resource trees ignores the capability and is not required to handle any
#' method in this section.
#'
#' The resource tree belongs to the session, not to a view. It has no view id
#' and no generation, it is available while the session has no views, and
#' closing, refreshing, or replacing views does not change it. It ends with the
#' session. Inside a view, an object is explored with that view's own methods; a
#' resource tree only lists entry points and opens them as ordinary views.
#'
#' | Method               | Direction        | Kind    | Result                                          |
#' | -------------------- | ---------------- | ------- | ----------------------------------------------- |
#' | `resources/children` | Host to producer | Request | One page of the children of a node or the root. |
#' | `resources/open`     | Host to producer | Request | Opens one node as a new view.                   |
#'
#' A host sends these requests only to a session whose `hello` declared the
#' capability. A producer that did not declare it returns `unsupported` or
#' `method_not_found`.
#'
#' ## Nodes
#'
#' The root has no id and is never listed as a node. Every other node is
#' identified by its `id`, a non-empty string of at most 16,384 UTF-8 bytes
#' chosen by the producer. An id is opaque: a host or viewer stores it and sends
#' it back, but does not parse, build, compare as a path, or display it. An id
#' identifies a node within its session; it is not valid in another session.
#' While a node exists, the producer gives it the same id in every listing, and
#' it never gives that id to a different node. Whether a resource that is
#' removed and created again is the same node is up to the producer; for
#' example, a producer that identifies variables by name treats them as the
#' same. An id names a resource, not a value captured when the page was listed:
#' the producer resolves it again for every request, so a node that still exists
#' may describe or open different content after a change.
#'
#' A child entry has these fields:
#'
#' | Field          | Type           | Required | Meaning                                                                                  |
#' | -------------- | -------------- | -------- | ---------------------------------------------------------------------------------------- |
#' | `id`           | string         | See text | Opaque node id.                                                                          |
#' | `label`        | string         | Yes      | Display name, at most 1,000 Unicode code points.                                         |
#' | `kind`         | string         | Yes      | Display hint token described below.                                                      |
#' | `summary`      | string         | No       | Short description, at most 1,000 Unicode code points.                                    |
#' | `has_children` | Boolean        | Yes      | Whether `resources/children` may list children of this node.                             |
#' | `viewable`     | Boolean        | Yes      | Whether `resources/open` may open this node.                                             |
#' | `hidden`       | Boolean        | No       | Whether a viewer should hide this node by default; omitted means `false`.                |
#' | `unavailable`  | string         | No       | Token explaining why the node cannot be read, expanded, or opened.                       |
#'
#' `has_children` and `viewable` are independent: a node may be both expandable
#' and viewable, either one, or neither. When neither is true, the node is still
#' listed so that the viewer shows it exists. `id` is required unless the node
#' cannot be identified within the id limit; such a node has
#' `has_children: false`, `viewable: false`, and `unavailable: "id_limit"`.
#'
#' `kind` is a hint for icons and grouping and does not decide which view kind
#' opens. Recommended tokens are `container` (holds other resources, such as a
#' schema), `table` (rectangular data), `object` (structured data), `value` (a
#' scalar or simple vector), `function`, and `unknown`. More tokens may be
#' added; a viewer treats an unrecognized token as `unknown`. The kind of view
#' that opens is known only from the `view/open` descriptor. A label is not
#' unique and is not an id.
#'
#' `kind` and `unavailable` tokens are 1 to 64 characters from lowercase ASCII
#' letters, digits, and `_`.
#'
#' `hidden` marks a node that the producer's environment conventionally hides,
#' for example a name with a leading dot in R. Producers still list hidden
#' nodes, and they can be addressed and opened as usual; whether to show them is
#' a viewer option. Hidden nodes count toward `offset`, `limit`,
#' `total_children`, and `next_offset` like any other node, so a page may hold
#' only hidden nodes and still have a next page; a viewer advances by
#' `next_offset`, not by the number of rows it shows. `unavailable` is a short
#' token from a producer-defined vocabulary; a viewer may show it but must not
#' depend on a particular value, except `id_limit` above.
#'
#' Producers may add fields to a child entry. A viewer ignores fields it does
#' not know.
#'
#' ## `resources/children`
#'
#' ```json
#' {
#'   "id": "resources-1",
#'   "method": "resources/children",
#'   "params": { "node": null, "offset": 0, "limit": 200 }
#' }
#' ```
#'
#' `node` is a node id, or `null` or omitted for the root. `offset` is a
#' zero-based, non-negative safe integer that defaults to 0; `limit` is an
#' integer from 1 through 500 that defaults to 200. Other values return
#' `invalid_request`. The result is:
#'
#' ```json
#' {
#'   "node": null,
#'   "offset": 0,
#'   "children": [
#'     {
#'       "id": "t:main.orders",
#'       "label": "orders",
#'       "kind": "table",
#'       "summary": "table, 12 columns",
#'       "has_children": false,
#'       "viewable": true
#'     }
#'   ],
#'   "total_children": 1,
#'   "next_offset": null
#' }
#' ```
#'
#' All five fields are required. `node` and `offset` repeat the request, with
#' `null` for the root; `offset` is not clamped to the end. `children` is an
#' array of at most `limit` entries. `total_children` is the number of children
#' when the request was handled as a non-negative safe integer, or `null` when
#' the producer does not know it. `next_offset` is `null` when this page reaches
#' the end; otherwise it is `offset` plus the number of children returned, and
#' `children` is not empty. A producer may return fewer children than `limit` to
#' stay within its response byte limit, so a short page does not mean the end;
#' only `next_offset: null` does. If not even one child fits, the request fails
#' with `limit_exceeded` rather than returning an empty page that is not the
#' end. An `offset` at or past the end, and a node whose `has_children` is
#' false, return an empty page with `next_offset: null`.
#'
#' Children come in an order that stays the same while the listed resources do
#' not change. The protocol does not otherwise define the order; a producer
#' extension may. A page reflects the resources when it was handled: if
#' resources are added or removed between page requests, a later page may repeat
#' or skip entries, and `total_children` may change. A viewer that appends pages
#' for one parent drops entries whose id it already added for that parent since
#' the listing last started from offset 0; entries without an id are never
#' treated as duplicates. The same node may appear under different parents. A
#' viewer refreshes by requesting again from offset 0. Protocol v1 defines no
#' change notification for resource trees; viewers refresh on request.
#'
#' ## `resources/open`
#'
#' ```json
#' {
#'   "id": "resources-2",
#'   "method": "resources/open",
#'   "params": { "node": "t:main.orders" }
#' }
#' ```
#'
#' `node` is a required node id. A producer extension may accept additional open
#' options. The producer resolves the node and opens it as a new top-level view,
#' sending its `view/open` notification with `reason: "resource"` before the
#' response. The result is that view's `view/open.params` descriptor; as for
#' `object/open`, a host registers the view from the notification, must not
#' create or revive a view from the response, and uses the response only to find
#' the view. If building the response fails, the producer closes the view and
#' does not send its `view/open`.
#'
#' The opened view is a top-level view and has no parent view. It follows the
#' usual view lifecycle and descriptor capabilities, including the producer's
#' view limits. Listing or refreshing the resource tree does not affect any view,
#' and closing a view does not change the resource tree. Opening a node
#' registers a view like any other, so when the producer is at its view limit it
#' may close an existing view to make room, and `view/closed` is sent as usual.
#' Every successful open creates a new view, even for a node that is already
#' open.
#'
#' Opening is not idempotent. After a host cancels a sent `resources/open` or
#' its deadline expires, the view may still be opened and its `view/open` may
#' still arrive. A host does not retry an open automatically.
#'
#' ## Errors
#'
#' An id that is malformed or that the producer does not recognize as one of its
#' own ids returns `invalid_request`. A well-formed id whose resource no longer
#' exists or cannot be read safely returns `unavailable`, as does
#' `resources/open` on a node that is not viewable. A producer need not remember
#' the ids it has issued.
#'
#' Resource tree requests follow the same request, queue, byte, acknowledgement,
#' wake, deadline, and cancellation rules as view requests. Because they name no
#' view, closing a view or moving it to a new generation does not cancel them;
#' they end with the requesting client or the session. Their responses are JSON
#' only and never carry an Arrow IPC binary body.
#'
#'
#' @section R producer extension: Resource trees:
#'
#'
#' The R producer declares `capabilities.resources: true` in `hello` by default
#' and serves the common resource tree with the variables of the global
#' environment. Set `options(jdv.resources = FALSE)` to turn it off: the option
#' is read when the session's `hello` is created and the result holds for the
#' whole session, so changing it later takes effect for the next session. A
#' session without the capability omits the `capabilities` member and answers
#' `resources/children` and `resources/open` with `unsupported`, without
#' revealing any name or summary. The same rule applies to the built-in
#' transport and to an embedded session started by [jdv_register()]. The tree is
#' available as soon as the session exists, also before any view is open.
#' [jdv_handle_request()] does not accept `resources/*` requests and returns
#' `method_not_found`.
#'
#' The root lists the bindings of the global environment, one level only. The
#' search path and the contents of environments are not listed; an environment
#' is opened as a view and explored with `object/children`. Every child has
#' `has_children: false`. Bindings whose name starts with a dot are listed with
#' `hidden: true`. Children are ordered by name in the byte order of their UTF-8
#' form, independent of the locale; for example, `"Z"` comes before `"a"`.
#' Because the global environment changes between requests, the weak consistency
#' of the common protocol applies to paging.
#'
#' An id names a binding, not its value. It is `b:` followed by the UTF-8 name,
#' or `h:` followed by the lowercase hex of the bytes of a name that is not
#' valid UTF-8. A viewer must still treat it as opaque. A name whose id would
#' exceed 16,384 UTF-8 bytes is listed without an `id`, with `viewable: false`
#' and `unavailable: "id_limit"`. An id with an unknown form returns
#' `invalid_request`; a binding that has been removed returns `unavailable`, for
#' both `resources/children` and `resources/open`.
#'
#' | `kind`     | Value                                                                    |
#' | ---------- | ------------------------------------------------------------------------ |
#' | `table`    | A data frame, or an atomic matrix.                                       |
#' | `function` | A closure, builtin, or special.                                          |
#' | `value`    | Any other atomic vector, including a factor.                             |
#' | `object`   | Everything else, such as a list, an environment, `NULL`, or an S4 object. |
#' | `unknown`  | A binding that cannot be read safely, or whose name has no id.           |
#'
#' The kind is decided from the type and the class attribute alone. No
#' `jdv_source()` method or other S3 method is called to choose it, so the view
#' that finally opens is known only from its `view/open` descriptor. The R
#' extension fields `class` and `type` have the same meaning as in
#' `object/children`. `summary` is at most 1,000 code points and is built
#' without calling any S3 or S4 method defined for the value, because the root
#' is listed without the user choosing individual objects: it never reads
#' elements, calls `format()`, or calls a generic such as `length()`, `dim()`,
#' `names()`, or `[`. It is the class (or type) name followed by the stored
#' size: `data.frame [32 × 11]` (rows and columns), `matrix double [3 × 4]`,
#' `double (100)`, `factor (150)`, `list (5)`, `function`, `environment` (no
#' binding count), and the class name of an S4 object. A length is the stored
#' length of the object, not the result of a user-defined `length()` method.
#' The summary after a value is opened with `object/children` is unchanged.
#'
#' A binding is read without evaluating it. Promises that have not been forced,
#' active bindings, and missing arguments are listed with `viewable: false` and
#' `unavailable` set to `delayed_binding`, `active_binding`, or
#' `missing_binding`, and `resources/open` returns `unavailable` for them;
#' neither request evaluates them. A forced promise is read as its value. Before
#' R 4.6.0 the value of a binding cannot be read without evaluation, so the
#' names are listed with `kind: "unknown"`, `viewable: false`, and
#' `unavailable: "opaque_binding"` (or `active_binding` for an active binding),
#' and `resources/open` returns `unavailable`.
#'
#' `resources/open` accepts `node` and the optional `mode` and `collation` of
#' `object/open`, with the same values and errors. It opens the current value of
#' the binding as a new top-level view with `reason: "resource"`. The view's
#' `title` is the variable name written as an R symbol (backquoted when it is
#' not syntactic). It is a display name only and takes no title slot, so it
#' never replaces another view, even one opened with [jdv_view()] under the same
#' title, and opening the same variable again gives another view with the same
#' title. The `view/open` notification is queued before the response, and the
#' view is closed if the response cannot be built. Opening counts against
#' `jdv.max_tables` like any other registration. From R 4.6.0 the view follows
#' the binding as [jdv_view()] does: the descriptor carries `tracking`, refresh
#' reads the current value, and a reassigned variable updates the view. A value
#' that is a sequential stream, or an R version before 4.6.0, gives a view
#' without tracking. Listing never closes a view, and opening may close the
#' oldest view when `jdv.max_tables` is reached.
#'
#' A children page that does not fit `jdv.max_message_bytes` is shortened to
#' fewer children, with `next_offset` pointing at the first child left out. A
#' single child that does not fit returns `limit_exceeded`.
#'
#'
#' @section R producer extension: `object/children`:
#'
#'
#' This method is available only on tree views. A grid with `children: true`
#' uses `object/open` to capture a cell; it does not expose `object/children`.
#'
#' Parameters are `view`, `generation`, `path`, and optionally `offset`,
#' `limit`, and `attributes`. The path is a full typed path from the root value
#' held by the named tree view; an empty path selects that root. `offset` is
#' zero-based and defaults to 0; `limit` defaults to 200 and must be between 1
#' and 500. `attributes` is a Boolean that defaults to `true`; any other value,
#' including `null`, returns `invalid_request`. A path contains at most 32
#' steps. Each step is one of:
#'
#' | Step `type` | Fields  | Meaning                                                |
#' | ----------- | ------- | ------------------------------------------------------ |
#' | `index`     | `index` | One-based position in an unnamed or positional object. |
#' | `binding`   | `name`  | Environment binding name.                              |
#' | `slot`      | `name`  | S4 slot name.                                          |
#' | `attr`      | `name`  | Attribute name.                                        |
#'
#' The result contains the same `view`, `generation`, full `path`, and `offset`,
#' plus `children` and `total_children`. Each child has its one-based `index`,
#' bounded `label`, string-array `class`, `type`, bounded `summary`,
#' `has_children`, `viewable`, and its full typed `path` when the child is
#' addressable. `class` and `type` have the same meaning as in a tree
#' descriptor; a child that is unavailable has an empty `class` and no `type`. A
#' child whose binding, slot, or attribute name exceeds 1,000 characters is not
#' addressable: it has `viewable: false`, `has_children: false`,
#' `unavailable: "path_limit"`, and may omit `path`. Other children include the
#' full typed path. When a value cannot safely be read, the child carries a
#' bounded `unavailable` reason. Child text, each class string, and each summary
#' are at most 1,000 characters. Summaries inspect at most five values or
#' children and at most three levels deep. Environment names are enumerated
#' locally and paged; active and delayed bindings are reported as unavailable
#' without reading their values.
#'
#' Children are the elements of the object followed by its attributes. Within an
#' atomic vector (logical, integer, double, complex, character, or raw), every
#' element is a leaf with `has_children: false`. Its `summary` has the form
#' `<class> (1): <value>`, for example `double (1): 1.5`, and always includes
#' the value regardless of depth. A page of elements is read and formatted as
#' one range, so only the requested range of an ALTREP vector is read.
#' Dimensionless atomic vectors with a class, excluding S4 objects, use the
#' column display format for the requested range; if that formatting fails,
#' their underlying atomic values are shown instead. A missing value is shown as
#' `NA`, and strings and formatted values are cut at 160 characters. A factor
#' element, and every value in a factor's summary, is shown as its level name; a
#' missing code is `NA`, and a code outside the levels is shown as
#' `<invalid code N>`. An atomic vector has children only if it has more than
#' one element, or if attributes are listed and it has any, so a length-one
#' vector without attributes is a leaf.
#'
#' A list object with a class-specific `format` method shows its logical value
#' count as `(N values)` in the summary, using the class's `length` method; one
#' value is written `(1 value)`. The summary may preview up to five formatted
#' values using the class's subset method and the column display format; this
#' preview does not change the count. A zero length shows `(0 values)` without
#' calling subset or format. If `length` fails or returns an invalid value, the
#' summary shows the class without a count. If subset or display fails, the
#' valid count remains. At the summary depth limit, only the class is shown,
#' with no count, and `length` and `format` are not called. `POSIXlt` and
#' classed vctrs records use this rule. Plain lists, data frames, and `AsIs`
#' lists retain their existing summaries. Attributes can change `total_children`
#' without changing this logical value count. This formatting applies only to
#' summaries; listing children does not dispatch list subset methods.
#'
#' With `attributes: false`, the attribute children (`attr` steps) are left out:
#' of every vector and other object, including a vector's `names`, which remains
#' visible as the label of each element. `total_children`, paging, and
#' `has_children` of the listed children follow the setting, and attributes that
#' are present are neither counted nor paged. Environment bindings and S4 slots
#' are the contents of those objects, not attribute children, so the setting
#' does not hide them.
#'
#' Tree navigation never evaluates a promise, active binding, classed `[[`, `$`,
#' or `names` method. Paths are resolved again for each `object/children`
#' request.
#'
#'
#' @section R producer extension: `object/open`:
#'
#'
#' Parameters are `view`, `generation`, a non-empty `path`, and optional `mode`
#' and `collation`. `mode` must be exactly `"auto"`, `"snapshot"`, or `"paged"`;
#' when omitted, it defaults to `"auto"`. `collation` must be exactly `"C"` or
#' `"locale"`; when omitted, it uses the same `getOption("jdv.collation", "C")`
#' default as [jdv_register()]. These options apply when the selected value
#' opens as a grid and do not inherit from the parent view. If the selected
#' value opens as a tree, valid `mode` and `collation` values are ignored.
#' Invalid values, including explicit `null`, return `invalid_request`.
#' `object/children` does not accept these options.
#'
#' On a tree view, every path step uses the `type` discriminant from the table
#' above. On a grid view, the first step must select a drillable cell:
#'
#' ```json
#' {
#'   "view": "v-1",
#'   "generation": 1,
#'   "path": [{ "kind": "cell", "source_row": 204, "column": 2 }],
#'   "mode": "paged",
#'   "collation": "C"
#' }
#' ```
#'
#' `source_row` is the original, zero-based source-row position, independent of
#' sorting, filtering, and pagination. `column` is the zero-based schema
#' position, including when column names are duplicated. `kind: "cell"` is
#' allowed only at the start of a grid path. Remaining steps, if any, use the
#' tree `type` forms above and are resolved within the captured cell value. The
#' complete path, including its cell step, contains at most 32 steps. Grid
#' `object/open` requires `capabilities.children: true` and
#' `columns[column].drillable: true`; malformed selectors or non-drillable
#' columns return `invalid_request`.
#'
#' Each grid column schema includes the Boolean `drillable`, which says whether
#' the column's cells can be selected by `kind: "cell"`. This metadata is
#' independent of `type`, `sortable`, and `filterable`; clients must not infer
#' drillability from the type, `native_type`, or display text. The R columns
#' that are drillable are listed in the R column mapping (informative) section
#' of \link[=jdv_query_spec]{query specification}. Snapshot views retain the R
#' source only when a drillable column needs subsequent cell capture. Retained
#' source references are released when the view closes.
#'
#' `object/open` resolves the selected value once, holding that captured value
#' in the new view. A path that cannot be resolved returns `unavailable`;
#' malformed paths return `invalid_request`, missing views return
#' `view_not_found`, and old generations return `stale_generation`. The result
#' is the child's `view/open.params` descriptor, but the child is registered by
#' the `view/open` notification that precedes the response (see the Notification
#' delivery section); a host must not create or revive a view from the response,
#' and may use it only to find the child. If building the response fails, the
#' child is closed and no `view/open` for it is sent. The child descriptor has
#' `reason: "child"`. If the parent has a `title`, the child's `title` is an R
#' expression built from the parent's `title` and the opened path; if the parent
#' has none, the child has none either. A list element uses `x$name` when its
#' name is nonempty and unique and `` x$`a b` `` when the name is not a
#' syntactic name, and `x[[3]]` (one-based) otherwise. An element of a named
#' atomic vector uses `x[["name"]]` under the same rule. An S4 slot is `x@slot`,
#' an environment binding is `x$name`, an attribute is `attr(x, "names")`, and a
#' grid cell is `df[12, "col"]` with the original zero-based `source_row` 11, or
#' `df[12, 3]` with a one-based column position when the column name is missing,
#' empty, or duplicated. A child of a child continues from the child's `title`,
#' for example `x$a[[2]]@data`. The `title` is truncated to 4,096 bytes. It is a
#' display label only: it is not guaranteed to be valid R, a host must not
#' evaluate it, and it does not identify the view or take a title slot. A tree
#' child starts a new root with an empty path; the descriptor may identify its
#' parent with `parent`. The limit is 32 live descendant views total per root,
#' counting nested tree and grid views across all levels. Closing a child
#' releases its slot for a later child view. Closing, replacing, or evicting a
#' parent closes its descendants; each cascaded child emits `view/closed` with
#' `reason: "parent_closed"`.
#'
#' The browser uses the same child-view navigation for tree and grid parents.
#' Opening controls appear only in drillable cells and use the displayed row's
#' original `source_row` (shown as a one-based row number). The tree viewer
#' shows the root `class`, and a checkbox, checked by default, sets the
#' `attributes` parameter of its `object/children` requests. View breadcrumbs
#' restore the parent's sort, filter, page, horizontal scroll, or tree path and
#' child-page offset. A pending child open is tied to the active parent view and
#' generation, separately from page query epochs: Snapshot sort, filter, and
#' page operations remain local and do not cancel the captured cell request.
#' Returning to the R prompt lets that original request complete without another
#' browser request. Selecting a different view, replacing its generation, or
#' closing it cancels its pending browser requests. Display text and navigation
#' labels are inserted as DOM text.
#'
#' R 4.6 and newer use the public experimental `R_GetBindingType()` and
#' `R_getVarEx()` APIs to distinguish `Value`, `Forced`, `Delayed`, `Unbound`,
#' `Missing`, and `Active` bindings. Only `Value` and `Forced` bindings are
#' read; `Delayed`, `Unbound`, `Missing`, and `Active` bindings are opaque, and
#' delayed expressions are never deparsed. On older R versions only active
#' bindings can be identified; other environment bindings are treated as opaque.
#' For ALTREP values, bounded element or region access may call the class's
#' representation callbacks to read values needed for a page or summary. This
#' does not force delayed promises or invoke active bindings. Tree access does
#' not request `DATAPTR`; the protocol does not guarantee total memory use by an
#' ALTREP implementation. If reading an individual child fails, that child is
#' returned with an `unavailable` reason and sibling children remain available.
#' S4 `.Data` is opaque; slots are inspected as stored values.
#'
#'
#' @section R producer extension: `view/refresh`:
#'
#'
#' The common request, capability gate, generation transition, notification, and
#' response contract is defined above. This section describes how the R producer
#' performs that operation.
#'
#' The view is rebuilt from the value captured when it was registered, so the
#' rebuild shows the same data unless the captured object is a reference object
#' that changed in place. A tracked view (see Binding tracking) is instead
#' rebuilt from the current value of its variable, read without evaluation; it
#' fails with `unavailable` when tracking has ended (the reason is in the
#' message) or the variable is a promise or active binding. A view whose
#' tracking is `"paused"` can be refreshed too: it is rebuilt from the current
#' value of its variable, the new object becomes the baseline, and the state
#' stays `"paused"`. The rebuild happens even if nothing changed and always
#' advances the generation by one. The registration `mode` and `collation` are
#' reused as they were requested: an `"auto"` mode is decided again (a grid may
#' move between Snapshot and Paged, and the effective mode is never frozen), an
#' explicit mode is kept, and a `NULL` collation intent reads `jdv.collation`
#' again. A refresh of a titled view keeps its title association, so a later
#' registration with that title continues from the refreshed generation.
#'
#' The replacement is built first. Only if the view, its generation, and (for a
#' child view) its parent are still current is it published, as one step, under
#' the same view id with the new generation, and the new `view/open` is queued.
#' Then every descendant view is closed, deepest first, with `view/closed`
#' notifications carrying `reason: "parent_closed"`. If releasing the old
#' generation closes the refreshed view, its `view/closed` follows the new
#' `view/open`, so the host never keeps a generation R no longer has. The old
#' generation of the refreshed view itself gets no `view/closed`; its
#' `view/open` successor replaces it. As for any request, these notifications
#' precede the response. A refresh that fails, is interrupted, or finds the view
#' stale leaves the generation and all children unchanged. A [jdv_close()] or
#' [jdv_disconnect()] issued by user code while the replacement is being built
#' keeps its effect: the closed view is not revived and the request fails with
#' `view_not_found`. [jdv_register()], `object/open`, or another refresh
#' attempted by user code during the rebuild fails with `in_use`. If the
#' notification queue overflows, the session ends as described under
#' Notification delivery.
#'
#' Refreshing a child view keeps it a child of the same parent generation (the
#' descriptor repeats `parent`); it is refused with `view_not_found` once the
#' parent was refreshed, replaced, or closed. Sequential views are not
#' refreshable (`unsupported`) because a consumed stream cannot be rewound.
#' Errors are `invalid_request`, `view_not_found`, `stale_generation`,
#' `unsupported`, and the usual `limit_exceeded`, `producer_error`, and
#' `interrupted`.
#'
#' A hub that forwards requests treats a sent `view/refresh` specially. The
#' successful refresh queues the new generation's `view/open` before its own
#' response, and a hub normally discards pending requests of an older generation
#' when it sees a newer `view/open`. The response of a sent `view/refresh` is
#' not discarded for that reason, whether it reports success or failure, as long
#' as the request was not timed out, cancelled, or lost to a disconnect. The hub
#' checks that the response matches the request (same id, view, and requested
#' generation as `previous_generation`, and a generation one higher on success).
#' The `view/open` notifications alone update what is displayed; the response
#' only confirms the operation and must never move the display back to an older
#' generation.
#'
#'
#' @section R producer extension: `view/track` and `view/tracking`:
#'
#'
#' ```json
#' {"id": "track-1", "method": "view/track",
#'  "params": {"view": "v-1", "generation": 3, "enabled": false}}
#' ```
#'
#' | Field        | Request                                          | Result                                                |
#' | ------------ | ------------------------------------------------ | ----------------------------------------------------- |
#' | `view`       | Required; the view id                            | The view id                                           |
#' | `generation` | Required; must be the current generation         | The generation after the request; one higher when rebuilt |
#' | `enabled`    | Required boolean; `false` stops, `true` resumes  | Omitted                                               |
#' | `tracking`   | Omitted                                          | The `tracking` object after the request               |
#'
#' Other fields are rejected with `invalid_request`, as is a non-boolean
#' `enabled`.
#'
#' `enabled: false` changes the state from `"active"` to `"paused"`. The binding
#' and the baseline object are kept, and the variable is not examined while the
#' view is paused. `enabled: true` changes `"paused"` back to `"active"`. At
#' that moment the current value of the variable is read and compared with the
#' baseline. If it differs, the view is rebuilt in the same way as an automatic
#' update: a new `view/open` with `reason: "tracked"`, `tracking.state:
#' "active"`, and the next generation is queued, and the result carries the new
#' generation. If it is the same object, the generation does not change. A value
#' that cannot be read without evaluation (a promise or an active binding) is
#' looked at again later, as for any check. If the rebuild fails, a
#' `view/update_failed` is queued as for an automatic update and the view stays
#' active at the same generation. A request for the state the view already has
#' succeeds and changes nothing. If the variable turns out to be gone, the state
#' becomes `"lost"` (announced as below) and the result reports it.
#'
#' A view that has no `tracking` field, or whose state is `"lost"`, fails with
#' `unsupported`, and the message names the reason. A generation that is not
#' current fails with `stale_generation`, and an unknown view with
#' `view_not_found`. The other errors are `invalid_request`, `producer_error`,
#' and `interrupted`.
#'
#' `view/tracking` is a notification:
#'
#' ```json
#' {"method": "view/tracking",
#'  "params": {"view": "v-1", "generation": 3,
#'             "tracking": {"name": "df", "state": "lost",
#'                          "reason": "removed",
#'                          "message": "the binding was removed"}}}
#' ```
#'
#' R queues it when the state changes without a new `view/open`: when following
#' is lost, and when `view/track` pauses, or resumes without rebuilding. When
#' `view/track` resumes and rebuilds, the new `view/open` carries the state and
#' no `view/tracking` is sent. `generation` is the generation the state belongs
#' to; a host ignores a notification for a generation it no longer shows, and it
#' updates its record of the view's `tracking` and `capabilities.track` (false
#' for `"lost"`). The notification precedes the response of the request that
#' caused it, like every notification. Following is lost when the variable is
#' removed or its environment is garbage collected, which R finds in the task
#' callback, in a `view/refresh`, or when `view/track` resumes.
#'
#' A hub that forwards requests may treat a sent `view/track` like a sent
#' `view/refresh`: a successful rebuild raises the generation by one, and the
#' `view/open` alone updates the display.
#'
#'
#' @section R producer extension: `view/close` and `view/closed`:
#'
#'
#' The common request, response, and notification contract is defined above. In
#' R, a successful `view/close` removes the entry from the active registry
#' immediately. If a request is already using its entry, source and holder
#' cleanup is deferred until that request releases it.
#'
#' When the registry evicts its oldest active table to satisfy `jdv.max_tables`,
#' it queues a `view/closed` notification with the evicted `view` and
#' `generation`. The notification enters the session queue ahead of the
#' associated new `view/open`, and the host delivers both in queue order.
#' [jdv_close()] queues `view/closed` for views it closes. Re-registering an
#' active title replaces the same id with a newer generation; after close or
#' eviction, a later registration uses a new id and generation 1.
#'
#' Closing a tree view removes its child views recursively. A `view/closed`
#' notification for a child closed by its parent includes
#' `reason: "parent_closed"`; the explicitly closed root has no such reason.
#' Replacing or evicting a parent has the same descendant-close effect.
#'
#'
#' @section R producer extension: R-specific descriptor and runtime details:
#'
#'
#' The R producer adds `class` and `type` to tree descriptors. `class` is a
#' string array following [base::class()] semantics for the root object, and
#' `type` is the string returned by [base::typeof()] (for example `"list"`,
#' `"double"`, `"environment"`, or `"S4"`). Its tree descriptors use
#' `kind: "tree"`, `access: "random"`, `encoding: "jdv-json"`, and include a
#' `path` array that is empty at the root. Grid descriptors omit `class` and
#' `type`.
#'
#' R may include a `tracking` object when a view follows a variable. It has the
#' form `{"name": "df", "state": "active"}`: `name` is the variable name and
#' `state` is `"active"`, `"paused"`, or `"lost"`. The lost state includes a
#' `reason` token and optional `message`. A view that does not follow a variable
#' omits `tracking` and sets `capabilities.track` to false. The R producer sends
#' `reason` on every `view/open`; it sets the token according to the table in
#' the common descriptor section.
#'
#' R column channel diagnostics use an empty `errors` array on random-access
#' pages when no channel failed, and a named object of channel-specific messages
#' when errors are present. Snapshot-access columns include `errors` only when a
#' channel failed. Missingness failures use the `na_rows` diagnostic key,
#' matching the wire channel name. Channel failures are reflected in the schema
#' capability flags; failed channel results are not cached.
#'
#' The R package uses base R and its bundled cJSON implementation at runtime; it
#' does not require jsonlite. Consumers can parse and construct JSON with their
#' own tooling and pass a JSON string to [jdv_rpc()]. Inbound requests follow
#' the common parser limits above. Generated R messages are bounded by the
#' outbound byte limit and are not revalidated with the request parser's node or
#' object-member limits.
#'
#' The R producer generates session ids as `r-<pid>-<connection counter>` and
#' does not use or change R's random state. It identifies itself as jdv running
#' on R and sets `wake: true`. Its grid descriptors send all eight known
#' capability flags. The R API emits `hello` on explicit connect or with the
#' first registered view on an implicit connection; a disconnect releases the
#' process-wide view registry.
#'
#' In the R local transport, `wake` checks whether queued requests can run, but
#' a wake does not dispatch work while R is in a function frame or at a
#' receive-only API preflight. A 50 ms interval is a valid host choice but is
#' not required by the protocol. A running R method is not forcibly interrupted
#' by `cancel`.
#'
#' The cJSON writer first tries a 15-significant-digit representation for a
#' finite double and accepts it only when its own read-back is exactly equal to
#' the source; otherwise it falls back to 17 significant digits. The emitted
#' text round-trips to the source double with correctly rounded parsers.
#' Negative zero is written as `0`, without its sign.
#'
#' The nanoarrow adapter obtains the schema during registration without
#' advancing the stream, then transfers stream ownership to the native layer.
#' Close, replacement, eviction, parent cascade, namespace unload, and producer
#' disconnection release the stream and any carried batch exactly once. A
#' release callback may execute R code; registry identity and generation are
#' checked again before publishing a result. Releases requested inside an active
#' producer callback are deferred until that callback finishes. The synchronous
#' [jdv_rpc()] API rejects `stream/next` before consuming the producer; the
#' local transport uses its private binary-capable entry point.
#'
#'
#'
#' R producer budgets, page retries, and interruption behavior are described in
#' the following implementation notes.
#'
#'
#' Per-column channel failures are represented in the page payload and do not
#' necessarily fail the whole request. The request and response byte limits are
#' `jdv.max_request_bytes` (default 1 MiB, minimum 128 bytes) and
#' `jdv.max_message_bytes` (default 10 MiB, minimum 1,024 bytes). The JSON
#' output limit applies to final JSON text, not peak allocation; Arrow IPC
#' bodies use the separate binary-transfer limits above. For finite doubles, the
#' cJSON writer first tries a 15-significant-digit representation and accepts it
#' only when its own double read-back is exactly equal to the source value;
#' otherwise it falls back to 17 significant digits. It releases each completed
#' column tree while appending it to the output.
#'
#' If a Paged response exceeds the output limit, the already-computed result is
#' retried as progressively shorter row prefixes; the R query and user methods
#' are not run again. If even one row cannot fit, `limit_exceeded` is returned
#' with a `warnings` array, which may be empty.
#'
#' Full sort and filter operations have no work or row limit by default because
#' they are explicit user requests. An explicitly finite `jdv.max_work_bytes` or
#' `jdv.max_query_rows` caps that work. Interrupt delivery in the event-loop
#' path depends on the suspension state at callback entry: an interrupt caught
#' during a started request returns `interrupted`, while R may defer delivery if
#' the callback began with interrupts already suspended. The viewer UI should
#' show that R is busy while a request runs.
#'
#' Snapshot construction, Paged registration probes, page extraction, and JSON
#' encoding use separate finite budgets. Each derived budget is the smaller of
#' `INT_MAX`, six times the applicable output allowance plus 4 MiB, and an
#' explicitly configured `jdv.max_work_bytes`. For Snapshot, the output
#' allowance is `min(jdv.snapshot_max_bytes, jdv.max_message_bytes)`; for page
#' work it is `jdv.max_message_bytes`. This preserves a 64 MiB work allowance
#' with the 10 MiB defaults while allowing Snapshot construction to scale with
#' its configured threshold. When `jdv.max_work_bytes` is finite, query work,
#' page extraction, and response encoding draw from the same per-operation
#' allowance. The cache budget limits the combined estimated bytes across
#' column, channel, and index caches; oversized entries are skipped and old
#' entries are evicted. The cache allowance is held by the registered table and
#' is separate from per-operation work. Unfiltered page requests do not
#' materialize a complete row index and are limited by page size.
#'
#' These are conservative engine-work estimates, not process-memory or RSS
#' limits: source storage, arbitrary user method allocations, R allocator and GC
#' overhead, and transient R-internal string conversion or sorting scratch are
#' outside the guarantee. Snapshot checks raw source strings before formatting
#' and checks returned channel sizes before further encoding; Paged registration
#' avoids scanning the full source and charges requested pages and queries.
#' Oversized common metadata is rejected at registration, while explicit Paged
#' row names are checked only for requested rows. If Auto selects Snapshot but
#' full explicit row names exceed Snapshot's metadata budget, registration
#' retries as Paged; forced Snapshot registration returns `limit_exceeded`.
#' Packed matrix columns are summarized by shape for display when copying a wide
#' row would exceed the cell preview bound, and missingness scans are budgeted
#' before allocating masks. Minimal control and error responses have a separate
#' fixed 64 KiB encoder-work allowance, so a depleted request budget can still
#' report its failure.
#'
#'
#' @section R producer extension: Registration API:
#'
#'
#' ```r
#' jdv_register(
#'   x,
#'   title = NULL,
#'   mode = c("auto", "snapshot", "paged"),
#'   collation = NULL
#' )
#'
#' jdv_rpc(request = NULL)
#'
#' jdv_view(x, title = NULL, mode = c("auto", "snapshot", "paged"),
#'   collation = NULL)
#'
#' jdv_close(id = NULL)
#' ```
#'
#' `x` may be a data frame, matrix, or another R object. Data frames and
#' matrices register as grid views. Arrow Table and RecordBatchReader objects,
#' `nanoarrow_array_stream` pointers, and Polars DataFrame objects register as
#' forward-only Arrow grid views through the optional nanoarrow producer
#' adapter. Their `mode` and `collation` arguments do not change sequential
#' access. Other objects use the tree view by default. [jdv_register()] returns
#' `list(id, generation)` and does not open a socket. Its `view/open` message,
#' and every other notification, is queued; see the Notification delivery
#' section.
#'
#' [jdv_view()] registers the view, opens the local connection on first use
#' (unless [jdv_connect()] already did), sends `hello` on a new connection, then
#' the queued notifications (`view/closed`, then `view/open`), and returns the
#' view id invisibly. The R API keeps the return-list key `id` and generates
#' opaque view id strings such as `v-1`; consumers must not interpret the id
#' format. Its default title is the deparsed expression passed as `x`; an
#' explicit `title = NULL` creates a new slot. `jdv_close(id)` closes one view,
#' and [jdv_close()] closes every view. Closing the last view stops a connection
#' that [jdv_view()] opened implicitly, after the close notification and any
#' pending response are sent; a persistent connection from [jdv_connect()] stays
#' open until [jdv_disconnect()]. [jdv_rpc()] with no argument or `NULL`
#' explicitly polls the active connection and drains at most eight requests.
#' This recovery path bypasses the normal event gate and is non-reentrant.
#' Passing a JSON string to [jdv_rpc()] remains a synchronous,
#' transport-independent embedding call.
#'
#' The address is selected from `options(jdv.address = ...)`, then `JDV_ADDRESS`,
#' then `discovery.json` under the user cache directory. On Linux and other Unix
#' systems, the directory is `$XDG_CACHE_HOME/jdv` or `~/.cache/jdv`; on macOS it
#' is `~/Library/Caches/jdv`; on Windows it is `%LOCALAPPDATA%/jdv` or
#' `%USERPROFILE%/AppData/Local/jdv`. The discovery file is at most 64 KiB and
#' contains a string field named `socketPath`. Unix-domain socket paths may be raw
#' absolute paths or `unix:///absolute/path`; Windows named-pipe addresses use
#' `npipe:////./pipe/NAME`. A `tcp://localhost:port`, `tcp://127.0.0.1:port`, or
#' `tcp://[::1]:port` address is accepted only when explicitly configured. TCP has
#' no authentication, and named-pipe ACLs are not hardened. Windows named pipes
#' must use byte-type mode; message-type pipes are unsupported.
#'
#' Host support depends on the R front end's event loop and interrupt behavior.
#' Rgui, RStudio, R.app, Esc/Ctrl-C delivery, and true top-level behavior must
#' be validated in each target host. See [jdv_view()] for the local transport
#' execution gate.
#'
#' A non-`NULL` title identifies one active display slot. Registering that
#' active title again replaces its contents, reuses its view id, and increments
#' its generation. The new view is prepared before the prior view is replaced,
#' so a failed registration leaves the prior registration intact. Closing or
#' evicting a title removes its title mapping; registering it later creates a
#' new id at generation 1. `NULL` titles always create independent
#' registrations. A new slot starts at generation 1. If `jdv.max_tables` is
#' lowered below the active count, registration evicts as many oldest entries as
#' needed to satisfy it.
#'
#' Snapshot registration materializes and encodes its data in the `open`
#' message. After successful message construction, a Snapshot with drillable
#' columns retains its source and registration fingerprint in R for cell
#' inspection. Other Snapshots retain only table metadata. The host is
#' responsible for caching the snapshot data in both cases, and neither has a
#' `grid/rows` endpoint. Paged registration retains the source and its initial
#' schema in R and returns schema and dimensions in `open`; rows are computed on
#' demand.
#'
#' For Paged tables, dimensions, column names, and column classes are checked
#' against the registration fingerprint on requests. Mutation of values through
#' a shared reference cannot be detected reliably. Register the table again
#' whenever values, schema, methods, or options that affect extracted channels
#' change. Re-registration creates a fresh holder and cache. Changing a class
#' method while continuing to use already cached channels does not guarantee
#' refresh.
#'
#' The default collation is `getOption("jdv.collation", "C")`. Current options
#' include `jdv.max_message_bytes` (default 10 MiB, minimum 1,024),
#' `jdv.max_request_bytes` (default 1 MiB, minimum 128), `jdv.max_tables`
#' (default 64), `jdv.max_page_rows` (default 2,000), `jdv.snapshot_max_cells`
#' (default 10,000), `jdv.snapshot_max_bytes` (default 10 MiB),
#' `jdv.max_work_bytes` (default `Inf`), `jdv.max_cache_bytes` (default 32 MiB),
#' and `jdv.max_query_rows` (default `Inf`). `jdv.resources` (default `TRUE`)
#' enables the resource tree for a session (see R producer extension: Resource
#' trees). The work and row limits apply to full sort/filter operations; setting
#' either option to a finite value restores the corresponding `limit_exceeded`
#' guard. Page, work, cache, and query-row settings are captured when a Paged
#' holder is registered; re-register the table to apply changed options. Each
#' open Paged view separately retains its latest filtered/sorted row index
#' outside `jdv.max_cache_bytes`, allowing consecutive pages for that query to
#' reuse the index. A different query or unfiltered page releases the
#' latest-index slot; an older result may remain in the LRU index cache.
#' Clearing query caches, replacing the view generation, or closing the view
#' releases both the slot and caches. This adds at most one potentially large
#' result index per open Paged view; the 32 MiB default remains the budget for
#' the LRU caches, including older result indices.
#'
#' `mode = "auto"` selects Snapshot only when both the cell estimate
#' `nrow * max(1, ncol)` and a deterministic byte estimate fit their thresholds.
#' The byte threshold is `min(jdv.snapshot_max_bytes, jdv.max_message_bytes)`.
#' The cell estimate counts `source_row` even for a zero-column table. Byte
#' estimation samples at most 256 evenly spaced rows; snapshot construction then
#' checks actual source string lengths and generated channel sizes. A sampled
#' estimate can therefore miss a large value, in which case automatic mode
#' discards the incomplete Snapshot attempt and registers a Paged holder. Forced
#' Snapshot mode returns `limit_exceeded` instead.
#'
#'
#' @section R producer extension: Binding tracking and `view/update_failed`:
#'
#'
#' **Protocol contract.** A view that follows a variable carries a `tracking`
#' object in its `view/open` (see Message envelopes). While the state is
#' `"active"`, the view is rebuilt with `reason: "tracked"` and the next
#' generation whenever the variable holds a different object than the view was
#' built from, and that object becomes the new baseline. While the state is
#' `"paused"`, the variable is not examined, so changes do not rebuild the view.
#' When following ends, the state becomes `"lost"` with a `reason`, the last
#' view stays, and `view/tracking` announces it; a later `view/refresh` fails
#' with `unavailable`. The following sections describe how the R package
#' implements this.
#'
#' **R implementation.** A view can follow the variable it was created from.
#' [jdv_view()] does so by default when its argument is a single name, and
#' [jdv_register()] accepts an explicit `binding = list(name = "x", env = env)`
#' for embedding hosts. After each top-level R task, the R task callback reads
#' every tracked variable without evaluating it, compares the object it holds by
#' identity with the one the view was built from, and rebuilds every changed
#' view through the same update as `view/refresh`: a new `view/open` with the
#' next generation (and `parent_closed` closes of its children) is queued, and
#' the baseline moves to the new object. Nothing is scheduled beyond the task
#' callback; a check is skipped while a request or a refresh is running and made
#' at the next opportunity. When the built-in connection owns the session the
#' queue is sent right after the check.
#'
#' Only plain and already forced bindings are read (R 4.6.0 or later). Promise,
#' active, and missing bindings are skipped and looked at again later. If the
#' variable is removed or its environment is garbage collected, tracking ends,
#' the last view stays, and a later `view/refresh` fails with `unavailable`; a
#' recreated variable is not picked up. Objects changed in place (environments,
#' reference objects, `data.table` updates by reference) keep their identity and
#' are not detected; a manual `view/refresh` covers them. The environment is
#' held weakly, but a displayed object that refers to it, such as a closure,
#' keeps it alive. Views opened from another view and sequential views are not
#' tracked. A paused view is skipped by the task callback, which exists only
#' while at least one view is active.
#'
#' **Embedding hosts.** R runs task callbacks in registration order. A host
#' whose own callback takes notifications before the callback of jdv would see
#' an update only after the next command. Such a host calls `jdv_rpc(NULL)`
#' first, which checks tracked variables once even without a viewer connection,
#' and then [jdv_notifications()].
#'
#' When an update cannot be built (a schema, conversion, or size limit, or an R
#' error), the previous generation stays and one notification is queued:
#'
#' ```json
#' {"method": "view/update_failed",
#'  "params": {"view": "v-1", "generation": 3, "code": "limit_exceeded",
#'             "message": "..."}}
#' ```
#'
#' `generation` is the generation still displayed and `code` is one of the usual
#' error codes. The same object is not tried again, and so not reported again,
#' until the variable holds a different object or `view/refresh` is requested. A
#' host that forwards the notification ignores one for a generation it no longer
#' shows. A notification queue overflow ends the session as described under
#' Notification delivery.
#'
#'
#' @section R producer extension: Registry-free R handles:
#'
#' [jdv_handle()] captures a data frame, matrix, or list for an embedding host
#' without registering a viewer slot. Handle operations do not consume
#' `jdv.max_tables`, advance viewer identifiers, evict views, or produce
#' notifications. [jdv_handle_register()] is the exception: it registers the
#' captured value as an ordinary view, with the same registry limit, return
#' value, notification, and transport flush behavior as [jdv_register()]. It
#' uses the captured value directly and does not track a variable binding. The
#' resulting view has a lifetime independent of the handle. Handles work without
#' a session and alongside either an embedded session or a viewer connection.
#' Closing registered views or disconnecting does not close handles. Sequential
#' sources, including Arrow and Polars sources, are unsupported.
#'
#' [jdv_handle_descriptor()] returns a JSON string with the shape of `view/open`
#' params (or the `object/open` result for a child). [jdv_handle_request()]
#' accepts only `grid/rows` and `object/children`, with the same parameter
#' validation and result shapes as their viewer requests. It returns the result
#' itself as JSON, without a response envelope. Omit `view` and `generation`
#' from its R-list params: the handle supplies them, and specifying either is an
#' `invalid_request` error. Result identifiers are opaque handle identifiers,
#' separate from viewer identifiers, with generation `1`. They cannot be used
#' with [jdv_rpc()] or [jdv_close()].
#'
#' [jdv_handle_register()] uses the handle's mode and collation intent when
#' those arguments are `NULL` (the default), and reuses its title unless a title
#' is supplied. A closed handle or parent signals `view_not_found`, an operation
#' on a busy handle signals `in_use`, and a changed table schema signals
#' `schema_changed`.
#'
#' [jdv_handle_open()] takes a typed path and returns a child R handle; call
#' [jdv_handle_descriptor()] on that child to obtain its descriptor JSON. Other
#' methods passed to [jdv_handle_request()], including `object/open`, fail with
#' `method_not_found`. These functions add no wire methods or fields; there is
#' no `view/describe` method.
#'
#' Use `mode = "paged"` for an initial preview bounded by rows, selected `cols`,
#' and output bytes. The `limit` and `cols` params select the page; `max_bytes`
#' bounds the UTF-8 JSON result. Oversized row or child pages shrink by halving
#' their returned item count. A single item that cannot fit fails with
#' `limit_exceeded`. Descriptors are never truncated. Auto mode retains the
#' usual Snapshot selection, and Snapshot descriptors contain the complete
#' captured data and do not support `grid/rows`.
#'
#' Handles do not follow variable bindings or support refresh or tracking; their
#' descriptor capabilities report both as false. Table handles retain the
#' captured source, including in Snapshot mode, and check its dimensions, column
#' names, and column classes against the initial fingerprint. This does not
#' detect every value-only mutation through a shared reference or changes to
#' methods. Close and recreate a handle when those change.
#'
#' [jdv_handle_close()] closes the handle and all its descendants, is
#' idempotent, and emits no notifications. Subsequent use fails with
#' `view_not_found`. A live child retains its parent so that garbage collection
#' of a parent variable does not invalidate the child. Explicit parent close
#' still invalidates descendants. Unreachable handles release their resources
#' through finalizers. Handles belong to the current R session and are not
#' transferable between processes. See [jdv_handle()] for examples and limits.
#'
#' @section R producer extension: Notification delivery:
#'
#'
#' Every notification R produces for a session (`hello`, `view/open`,
#' `view/closed`, including evictions, cascaded child closes, the `view/open` of
#' a child created by `object/open`, `view/update_failed`, and `view/tracking`)
#' goes through one first-in, first-out queue. A session has exactly one owner
#' of that queue, reported by the `owner` field of [jdv_connection()]:
#'
#' - `"transport"`: the built-in connection, whenever one is open. The
#'   transport sends the queue itself, before the response of the request being
#'   handled, so a notification always precedes the response that caused it.
#' - `"embedded"`: a session started by [jdv_register()] when no connection
#'   exists. `hello` is queued before the first `view/open`. The host takes the
#'   queue with [jdv_notifications()], which returns the JSON messages in order.
#'   The session remains after its last view closes so the final `view/closed`
#'   can be taken, and ends with [jdv_disconnect()].
#'
#' Ownership never moves implicitly: [jdv_connect()] and [jdv_view()] fail while
#' an embedded session exists, and [jdv_notifications()] fails while the
#' transport owns the queue. An embedding host delivers every message taken by
#' [jdv_notifications()] in order, and delivers the string returned by
#' [jdv_rpc()] only after the notifications produced by that request. For
#' `object/open`, the child's `view/open` is in the queue when [jdv_rpc()]
#' returns, so the host registers the child from that notification and uses the
#' response only to find it. [jdv_rpc()] never embeds notifications in its
#' response.
#'
#' ```r
#' id <- jdv_register(mtcars)$id
#' deliver(jdv_notifications())         # hello, view/open
#' response <- jdv_rpc(request_json)    # a request received from the viewer
#' deliver(jdv_notifications())         # notifications caused by the request
#' deliver(response)
#' ```
#'
#' The queue is bounded by `jdv.notification_max_messages` (default
#' `max(256, 4 * jdv.max_tables)`) and `jdv.notification_max_bytes` (default
#' `4 * jdv.max_message_bytes`), both read when the session starts. Messages are
#' never dropped silently: when adding one would exceed a limit, the session
#' ends, every view is closed, the queue is discarded, and
#' `last_disconnect_reason` of [jdv_connection()] becomes
#' `"notification_overflow"`. The operation that overflowed fails with an error
#' of class `jdv_notification_overflow`. With the built-in transport the queue
#' is normally sent right away, so an overflow mostly affects an embedded host
#' that does not take its notifications. A host must treat the end of a session,
#' seen as an error from R or as `last_disconnect_reason`, as the loss of every
#' view.
#'
#'
#' @section R producer extension: Local transport and execution gate:
#'
#'
#' The following limits and dispatch rules describe the R producer transport;
#' another producer may implement its execution gate differently. The R
#' transport bounds the pending queue to 256 messages and 16 MiB by default.
#' Each inbound JSON line is limited by `jdv.max_request_bytes` (1 MiB by
#' default), and each outbound line by `jdv.max_message_bytes` (10 MiB by
#' default). A read callback processes at most `max(64 KiB, request limit + 1)`
#' bytes. One native poll or event callback drains at most eight queued
#' requests; each request in that batch passes through its own execution-gate
#' check. Sends have a one-second timeout. Limits can be adjusted with
#' `jdv.transport.queue_messages`, `jdv.transport.queue_bytes`,
#' `jdv.transport.max_drain_requests`, and `jdv.transport.send_timeout_ms`.
#'
#' The event source reads and validates framed input into a bounded C queue. It
#' does not leave a readable descriptor active after hitting its receive quota.
#' If the pending queue is full by message count or bytes, the transport returns
#' `limit_exceeded` for that request alone and keeps the connection and already
#' queued work when the error response is sent successfully. A failed error send
#' still disconnects the host and closes registered tables. Each receive
#' callback is also bounded to
#' `jdv.transport.queue_messages + jdv.transport.max_drain_requests` frames and
#' `max(64 KiB, request limit + 1)` bytes. `cancel` and `wake` notifications
#' count toward the frame limit. A host that exceeds either callback quota is
#' disconnected. Each receive callback acknowledges the cumulative number of
#' complete frames read, including malformed or rejected frames; the host
#' releases frame and byte credit through that boundary. Since the R producer
#' sets `hello.params.wake` to `true`, hosts must send `wake` notifications
#' repeatedly at a regular interval while a request awaits a terminal response.
#' A single wake is insufficient for this R execution gate: a normal package
#' API-entry preflight is receive-only and does not dispatch work, and receiving
#' a wake while R is in a function frame only allows requests to be queued for
#' later dispatch. A 50 ms interval is a valid implementation choice, but the
#' protocol does not require every host to use that interval. Wake frames remain
#' subject to the same applicable credit and rate limits as other traffic. Hosts
#' must keep at most 32 view requests awaiting a response. Before sending a page
#' request that makes an unsent page request obsolete, hosts must replace the
#' unsent request with the newer page. Hosts must bound the cumulative
#' unconfirmed output prefix to the receive callback's frame and byte quotas so
#' multiple writes cannot exceed one callback's budget when coalesced. Each
#' `cancel` and `wake` frame consumes the same frame and byte credit as a
#' request. Before dispatch, the transport removes cancelled and expired queued
#' requests and sends their terminal errors, including while another R method is
#' running. The R adapter returns `view_not_found` for a closed or missing view
#' and `stale_generation` for an obsolete generation. For each request, dispatch
#' requires native `busy == 0` and a single [base::sys.nframe()] evaluation in
#' `R_BaseEnv` to return zero. If the queue is empty, the gate skips that
#' evaluation. A started request that fails, including an interrupt, is terminal
#' and is never retried. A synchronous or queued stale generation returns
#' `stale_generation`. A second live pending request with the same typed id is
#' rejected as `invalid_request` on a best-effort basis and closes the
#' connection to avoid ambiguous responses. Cancelled requests no longer reserve
#' their ids.
#'
#' The gate temporarily saves `R_interrupts_suspended`, sets it to `TRUE` for
#' the single frame-count evaluation, and restores the prior value with
#' unwind-safe cleanup. It does not use `END_SUSPEND_INTERRUPTS`, call `onintr`,
#' or inspect or change private pending-interrupt state. This practical
#' function-frame check is not a guarantee that R is idle: on Windows, a timer
#' can run during a top-level `for` loop while [base::sys.nframe()] is zero, and
#' this dispatch behavior has been observed. The Windows timer interval is about
#' 200 ms. If the request callback begins with interrupts enabled, an interrupt
#' after dequeue becomes an `interrupted` error. If R entered the callback with
#' interrupts already suspended, R may defer delivery; long sort or filter work
#' may therefore not stop promptly. The viewer should show a busy state and
#' offer a retry after a terminal failure.
#'
#' `jdv_rpc(NULL)` is a non-reentrant recovery path that bypasses the normal
#' gate and drains at most the configured batch under `R_UnwindProtect`; it does
#' not use a background `R_ToplevelExec`. Disconnect cleanup is deferred until
#' the callback stack is safe. A public R [base::addTaskCallback()] performs
#' cleanup after a successful top-level task, while explicit polling and later
#' public package entries also check for pending cleanup. This task callback is
#' cleanup-only and does not dispatch requests. It is an event-driven cleanup
#' opportunity, not a general timer. A disconnect closes every registered table,
#' and the next [jdv_view()] call starts a new connection; no in-flight request
#' is retried.
#'
#' On namespace unload, the transport source is stopped, queued requests and
#' registry entries are closed, and the housekeeping callback is removed. If a
#' native callback is still active, the package namespace may unload while the
#' native library remains loaded while native calls are active; an idle reload
#' or unload can release it later. Forced DLL unload while native callbacks are
#' active is unsupported; reloading is rejected while the previous native owner
#' is still active.
#'
#' R evaluation, condition handling, and interrupt state use installed public R
#' APIs. The POSIX input handler uses the installed `R_ext/eventloop.h` external
#' interface, which is not a stable API. No GPL R source or later implementation
#' is copied.
#'
#' @seealso
#' [jdv_register()], [jdv_rpc()], [jdv_view()], [jdv_close()], [jdv_query_spec]
#'
#' @name jdv_spec
#' @aliases jdv_protocol

NULL
#' @section Reference host: Cache for sequential pages:
#'
#'
#' The reference host caches opaque IPC bytes per R session, view, and
#' generation. It does not parse Arrow. Valid pages are saved before delivery
#' decisions, so a reply arriving after cancellation, timeout, or owner
#' detachment can still be read later. Old-generation, over-budget, malformed,
#' or regressing replies are not cached. Page metadata must have non-negative
#' safe-integer row counts, `rows_seen = first_row + rows_fetched`, a Boolean
#' `done`, and no more rows than requested. After EOF, a later next request may
#' return a zero-row EOF at the same cursor; it may not introduce data or
#' reverse EOF.
#'
#' `welcome.capabilities.stream_cache` advertises the host feature:
#'
#' ```json
#' {
#'   "version": 1,
#'   "max_total_bytes": 268435456,
#'   "max_view_bytes": 67108864,
#'   "page_overhead_bytes": 1024
#' }
#' ```
#'
#' A false or absent capability means the host cache is unavailable; sequential
#' viewing continues in forward-only mode without cache-cursor validation. The
#' reference host defaults to 256 MiB across sessions and views, and 64 MiB per
#' view, clamped to the total limit. Startup options `--stream-cache-bytes` and
#' `--stream-cache-view-bytes` accept non-negative safe-integer byte counts;
#' zero for either disables the feature. The corresponding `startServer()`
#' options are `streamCacheBytes` and `streamCacheViewBytes`.
#'
#' Every page, including an empty page, is charged its IPC body length plus
#' 1,024 bytes. Only a copy of that body and the explicit metadata below are
#' retained; full response headers and warnings are not saved. The copy does not
#' retain a larger receive buffer. Both global and per-view limits evict oldest
#' pages first, without refreshing FIFO order on reads. A view's retained pages
#' therefore form a suffix of its observed pages. An oversized insertion can
#' evict the complete suffix including itself. The page counter, row watermark,
#' and EOF flag still advance. Fixed charges bound empty-page metadata as well
#' as payload bytes; this accounting is not an exact process-heap limit.
#'
#' Cache calls use the ordinary browser request envelope, with `session`, `id`,
#' `method`, and `params`, but are handled locally and never forwarded to R:
#'
#' | Method              | Parameters beyond `view` and `generation` | Result                                                    |
#' | ------------------- | ----------------------------------------- | --------------------------------------------------------- |
#' | `stream/cache/info` | Optional `after_page`, optional `limit`   | Bounded JSON page catalog and cursor state.               |
#' | `stream/cache/get`  | Required `page`, optional `max_bytes`     | One cached page in the existing binary response envelope. |
#'
#' Both methods require the current view generation and strict parameter
#' objects. They need no lease, including while another browser owns the stream.
#' Existing active-request id checks run before these operations. Disabled hosts
#' return `unsupported`; a missing retained page returns `unavailable`. A
#' missing or stale view keeps the usual `view_not_found` or `stale_generation`
#' error.
#'
#' The catalog defaults to 64 entries and allows `limit` from 1 through 128.
#' Omitting `after_page` starts at the first retained page (internal cursor -1);
#' when supplied, it must be a non-negative safe integer. Entries are ordered by
#' monotonic, zero-based page number, including distinct zero-row pages. Each
#' entry has `page`, `first_row`, `rows_fetched`, `rows_seen`, `done`, and
#' `byte_length`. An optional `unavailable_before_range: [start, end]`
#' identifies a source-row gap immediately before that page, using zero-based
#' half-open row coordinates. No unbounded history of gaps is kept. Gaps
#' preceding the retained suffix are covered by the lost prefix below. These
#' ranges can overlap that prefix; clients combine them as a union rather than
#' counting overlapping rows twice.
#'
#' The result also contains `view`, `generation`, `next_after` (the last
#' returned page number when more entries exist, otherwise null), `last_page`
#' (-1 before any observed page), `rows_seen`, `done`, and `unavailable_before`.
#' The latter means rows in `[0, unavailable_before)` are no longer held by the
#' host. When all pages have been evicted, it equals the watermark even if the
#' catalog is empty. `last_page`, `rows_seen`, and `done` distinguish this state
#' from a new stream. Catalog JSON is limited to 64 KiB; clients paginate rather
#' than requesting an unbounded index. Eviction between catalog lookup and get
#' returns `unavailable`; clients can refresh the catalog.
#'
#' Get accepts a non-negative safe-integer `page`. Its optional non-negative
#' safe-integer `max_bytes` uses the existing effective binary budget; zero can
#' retrieve a zero-byte body. Insufficient budget returns one `limit_exceeded`
#' error without sending a partial body or consulting R. Binary JSON headers
#' stay within 64 KiB and whole frames within 10 MiB. The result preserves the
#' existing `view`, `generation`, row metadata, and `transfer` fields and adds
#' `cache_page`, an object with the same metadata as a catalog entry. A live
#' cached `stream/next` response gets the same object, even if that page was
#' immediately evicted. Cache reads use an empty warnings array rather than
#' replaying old R warnings.
#'
#' When caching is enabled, `stream/next` requires `after_page`, a safe integer
#' greater than or equal to -1. The host compares it with `last_page` before
#' granting a lease or sending an R frame. A missing value returns
#' `invalid_request`; a mismatch returns `type: "error"`,
#' `code: "cache_changed"`, and `details: {last_page, rows_seen, done}`. The
#' browser refreshes info/get before advancing. The host removes `after_page`
#' before forwarding to R, so it is a host-only cursor. When caching is
#' disabled, sequential viewing remains forward-only and the host does not
#' compare a cache cursor. Omitting `after_page` from `stream/cache/info` still
#' starts the catalog at its first retained page. Reading an older cached page
#' does not rewind the append cursor. Cache reads do not claim a lease, and
#' append requests retain the existing owner and single-pending-request rules.
#'
#' View close, ancestor cascade, generation replacement, and R session
#' disconnect invalidate the corresponding bytes and metadata; late replies
#' cannot resurrect them. The cache is memory-only and is cleared at host
#' shutdown. Cache info/get replies have a separate 32 MiB queued-byte admission
#' limit: exceeding it closes and detaches that browser while the R session and
#' host cache remain available to other browsers. This limit does not apply to
#' existing welcome messages, notifications, or live R replies. Send failures on
#' any output path detach the browser. Repeated close/detach is harmless.
#'
#'
#' @section Browser viewer: Displaying sequential Arrow views:
#'
#'
#' The viewer exposes Load next and an unknown total, without random navigation,
#' sorting, or filtering. It displays gaps between the last received cursor and
#' a new `first_row` as rows advanced but not displayed, including a skipped
#' prefix when a new browser takes over. Per-view-generation progress survives
#' selecting another view and display-cache eviction; zero-row non-EOF pages do
#' not advance that cursor. EOF pages still report any skipped prefix. The
#' display cache counts UTF-16 text bytes plus 64 bytes per row and 16 per cell,
#' capped at 8 MiB and 32 pages per view, with a 32 MiB aggregate display
#' budget. View selection preserves these per-generation caches while they fit.
#' They retain formatted rows rather than both raw IPC and decoded vectors.
#' These counts are separate from the host IPC cache described below and are not
#' a JavaScript heap guarantee. Cell strings and binary hex are visibly
#' truncated beyond 4,096 code units. Decimal fixed-point output that would
#' exceed this limit uses exact coefficient/exponent notation, such as
#' `123e-2147483647`, without expanding the scale. Invalid non-integer or unsafe
#' scales produce an explicit error. Timestamp formatting remains exact. Rows no
#' longer retained by the host cannot be fetched from the producer again.
#' Decimal coefficients and signed/unsigned 64-bit integers are formatted
#' exactly; timestamps use raw integer ticks, including negative fractions and
#' declared time zones, rather than rounded millisecond getters. Nested values
#' show a summary, and omitted columns display their unsupported reason.
#'
#'
#' @section Browser viewer: Inspection of nested Arrow cells:
#'
#'
#' Nested sequential cells are inspected from the page's IPC buffers and schema
#' in this browser. No `object/children`, `object/open`, R conversion, or
#' additional R request is involved. Selecting a cell uses its original
#' one-based source row and original zero-based column position; the
#' descriptor's `ipc_index` selects the decoded vector. Column names are labels
#' only and may repeat.
#'
#' The inspector expands list, large-list, fixed-size-list, struct, and map
#' values. Maps expose entries, then each entry's key and value. Dictionaries
#' are resolved at each position, including dictionaries inside nested values.
#' Breadcrumb paths are arrays of zero-based child positions, so duplicate
#' struct field names remain unambiguous. Parent nulls are leaves regardless of
#' their child buffers. Signed and unsigned 64-bit integers, decimals, and
#' timestamps use the same exact physical-buffer formatting as ordinary Arrow
#' cells, including slices and chunks. Unsupported types are leaves at their
#' position. A column omitted from IPC by the producer's existing support rules
#' instead shows its unsupported reason at the cell root; the browser cannot
#' recover omitted data. Core handling of an unsupported nested node does not
#' imply the R encoder emits that node.
#'
#' Only the requested child page is materialized, with at most 200 children.
#' Paths are limited to 32 steps; values at that depth show a depth-limit reason
#' instead of an expansion control. Dictionary resolution has a separate 32-hop
#' and cycle guard. Labels and summaries are bounded to 4,096 UTF-16 code units,
#' including any truncation marker. Composite summaries use shallow type labels
#' and counts rather than recursively formatting schemas or subtrees. These
#' bounds also apply to very large lists of nulls.
#'
#' Decoded page and cell handles are private browser objects. Their lifetime is
#' owned by the UI's bounded raw IPC cache (at most eight pages and 32 MiB
#' aggregate) and its single active inspector page, separately from the
#' formatted-row cache. If the local page is absent, inspection may restore it
#' from the host cache; if it is no longer retained there, the UI reports it
#' unavailable and does not advance the forward-only R stream.
#'
#'
