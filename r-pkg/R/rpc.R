# The registry is deliberately independent of the transport so embedding and
# local-viewer calls use the same table engine.
.jdv_state <- local({
  state <- new.env(parent = emptyenv())
  state$entries <- new.env(hash = TRUE, parent = emptyenv())
  state$titles <- new.env(hash = TRUE, parent = emptyenv())
  state$next_id <- 0
  state$sequence <- 0
  state$eviction_pins <- character()
  state$queue <- list()
  state$queue_bytes <- 0
  state$queue_max_messages <- Inf
  state$queue_max_bytes <- Inf
  state$embedded <- FALSE
  state$rpc_depth <- 0L
  state$refreshing <- FALSE
  state$transport <- NULL
  state$transport_limits <- NULL
  state$transport_epoch <- 0L
  state$transport_hello <- FALSE
  state$transport_persistent <- FALSE
  state$transport_address <- NULL
  state$transport_close_reason <- NULL
  state$last_disconnect_reason <- NULL
  state$session_counter <- 0L
  state$resources <- FALSE
  state$transport_task_callback <- NULL
  state$track_task_callback <- NULL
  state$tracking <- FALSE
  state$unloading <- FALSE
  state
})

# Every error jdv raises on purpose is a `jdv_error` with a `code`. `extra` adds
# classes in front, for internal conditions that need their own handling.
#' Errors signaled by jdv
#'
#' Errors that jdv raises on purpose are conditions of class `jdv_error`. Each
#' also has a class that names its reason, `jdv_error_<code>`, and a `code`
#' field with the same `<code>`, so that a caller can decide what to do without
#' matching the message. The full class vector is
#' `c("jdv_error_<code>", "jdv_error", "error", "condition")`; errors of the
#' query layer, such as those of [jdv_register()], also have the class
#' `jdv_query_error` in front, and a notification queue overflow has the class
#' `jdv_notification_overflow` (see [jdv_notifications()]). Unexpected R errors,
#' for example from a failing `format()` method of the user, are not wrapped.
#'
#' The codes below are the ones R functions can signal. `invalid_request`,
#' `unsupported`, `unavailable`, `limit_exceeded`, `schema_changed`,
#' `producer_error`, `view_not_found`, and `in_use` have the same meaning as the
#' protocol error codes of the same name (see [jdv_spec]). `invalid_argument`,
#' `connect_failed`, `not_connected`, and `shutting_down` exist only in the R
#' API; they are never sent to a viewer.
#'
#' | Code | Signaled when |
#' | --- | --- |
#' | `invalid_argument` | An argument or option has a wrong type or value, such as `track` or `address` of [jdv_view()] and [jdv_connect()], the `id` of [jdv_close()], the shape of the `binding` argument of [jdv_register()], an option that sets the address or discovery file, or the `name` and `env` of [jdv_binding()]. |
#' | `in_use` | Another owner holds the resource. An embedded notification session and a viewer connection exclude each other, [jdv_connect()] is asked for a different address while connected, the previous connection is still being cleaned up, a table is opened while a viewer request is running, or [jdv_rpc()] is called again from inside a request. |
#' | `connect_failed` | The viewer cannot be reached: the discovery file is missing, too large, or unusable, or the connection cannot be made or ends during setup. |
#' | `not_connected` | A message is sent while there is no viewer connection. |
#' | `shutting_down` | A function is called while the package is being unloaded. |
#' | `invalid_request` | The `binding` of [jdv_register()] has the right shape but does not hold the object registered, or a registered object fails validation. |
#' | `unsupported` | The operation is not available for the object, such as tracking a sequential source or tracking on R older than 4.6.0. |
#' | `unavailable` | A binding cannot be read without evaluating it. |
#' | `limit_exceeded` | A configured limit is exceeded, including a notification queue overflow. |
#' | `schema_changed`, `producer_error`, `view_not_found` | Errors of the query layer; see [jdv_query_spec]. |
#'
#' The registry-free handle functions (see [jdv_handle()]) use the same
#' conditions. A malformed handle, mode, collation, or `max_bytes` argument
#' signals `invalid_argument`; malformed request params or typed paths signal
#' `invalid_request`. A closed handle, including a child closed by its parent,
#' signals `view_not_found`. Table fingerprint changes signal `schema_changed`.
#' Sequential sources and unsupported operations on a handle's mode signal
#' `unsupported`. Methods other than `grid/rows` and `object/children` passed to
#' [jdv_handle_request()] signal `method_not_found`; use [jdv_handle_open()] to
#' open a child. A descriptor or single page item that cannot fit its byte limit
#' signals `limit_exceeded`.
#'
#' @examples
#' library(jdv)
#' result <- tryCatch(
#'   jdv_view(mtcars, track = NA),
#'   jdv_error_invalid_argument = function(error) error$code
#' )
#' result
#'
#' # Fall back when no viewer is available, and report anything else.
#' open_view <- function(x) {
#'   tryCatch(
#'     jdv_view(x),
#'     jdv_error_connect_failed = function(error) {
#'       message("No viewer: ", conditionMessage(error))
#'       NULL
#'     },
#'     jdv_error_in_use = function(error) {
#'       message("The viewer is busy: ", conditionMessage(error))
#'       NULL
#'     }
#'   )
#' }
#' @name jdv_errors
NULL

jdv_condition <- function(code, message, details = NULL, extra = character()) {
  structure(
    list(message = message, call = NULL, code = code, details = details),
    class = c(
      extra,
      paste0("jdv_error_", code),
      "jdv_error",
      "error",
      "condition"
    )
  )
}

jdv_abort <- function(code, message) stop(jdv_condition(code, message))

# match.arg() for a public argument or option, failing with invalid_argument.
.jdv_match_arg <- function(arg, choices, name) {
  tryCatch(
    match.arg(arg, choices),
    error = function(error) {
      jdv_abort(
        "invalid_argument",
        paste0(
          name,
          " must be one of ",
          paste0('"', choices, '"', collapse = ", "),
          "."
        )
      )
    }
  )
}

# The error codes of the wire protocol. Other jdv_error codes belong to the R
# API only and are reported to a viewer as `producer_error`.
.jdv_protocol_codes <- c(
  "invalid_request",
  "unsupported",
  "limit_exceeded",
  "schema_changed",
  "producer_error",
  "interrupted",
  "cancelled",
  "expired",
  "unavailable",
  "stale_generation",
  "view_not_found",
  "cache_changed",
  "in_use",
  "stream_failed",
  "method_not_found"
)

.jdv_assert_active <- function() {
  if (isTRUE(.jdv_state$unloading)) {
    jdv_abort("shutting_down", "The jdv namespace is shutting down.")
  }
  invisible(NULL)
}

# Notifications share one FIFO per session. The owner is the built-in transport
# when one is connected; otherwise an embedded session started by the first
# registration, drained with jdv_notifications().
.jdv_notification_limits <- function() {
  max_tables <- .jdv_option_limit("jdv.max_tables", 64)
  list(
    messages = .jdv_option_limit(
      "jdv.notification_max_messages",
      max(256, 4 * max_tables)
    ),
    bytes = .jdv_option_limit(
      "jdv.notification_max_bytes",
      min(.Machine$integer.max, 4 * .jdv_max_message_bytes()),
      1024
    )
  )
}

.jdv_queue_reset <- function(limits = NULL) {
  .jdv_state$queue <- list()
  .jdv_state$queue_bytes <- 0
  if (!is.null(limits)) {
    .jdv_state$queue_max_messages <- limits$messages
    .jdv_state$queue_max_bytes <- limits$bytes
  }
  invisible(NULL)
}

# Take every queued message in FIFO order.
.jdv_queue_take <- function() {
  messages <- if (length(.jdv_state$queue)) {
    unname(unlist(.jdv_state$queue, use.names = FALSE))
  } else {
    character()
  }
  .jdv_queue_reset()
  messages
}

.jdv_session_owner <- function() {
  if (!is.null(.jdv_state$transport)) {
    "transport"
  } else if (isTRUE(.jdv_state$embedded)) {
    "embedded"
  } else {
    "none"
  }
}

# Push one notification. Without a session there is nobody to deliver to. An
# overflow ends the session instead of dropping notifications.
.jdv_notify <- function(message) {
  if (identical(.jdv_session_owner(), "none")) {
    return(invisible(NULL))
  }
  bytes <- nchar(message, type = "bytes")
  if (
    length(.jdv_state$queue) + 1 > .jdv_state$queue_max_messages ||
      .jdv_state$queue_bytes + bytes > .jdv_state$queue_max_bytes
  ) {
    .jdv_session_overflow()
  }
  .jdv_state$queue[[length(.jdv_state$queue) + 1L]] <- message
  .jdv_state$queue_bytes <- .jdv_state$queue_bytes + bytes
  invisible(NULL)
}

.jdv_session_overflow <- function() {
  .jdv_queue_reset()
  .jdv_close_internal(notify = FALSE)
  if (identical(.jdv_session_owner(), "transport")) {
    # The disconnect callback records the reason once cleanup runs.
    .jdv_transport_close("notification_overflow")
  } else {
    .jdv_state$embedded <- FALSE
    .jdv_state$last_disconnect_reason <- "notification_overflow"
  }
  stop(jdv_condition(
    "limit_exceeded",
    paste(
      "The notification queue overflowed; the viewer session was ended",
      "and all views were closed."
    ),
    extra = "jdv_notification_overflow"
  ))
}

# An embedded hello advertises the same complete limits object as a transport
# hello, computed from the options the transport would use, so hosts can
# validate both kinds of session the same way.
.jdv_embedded_hello_limits <- function() {
  limits <- .jdv_transport_limits()
  list(
    max_unacked_frames = as.integer(
      limits$queue_messages + limits$max_drain_requests
    ),
    max_unacked_bytes = limits$max_receive_bytes,
    queue_messages = limits$queue_messages,
    queue_bytes = limits$queue_bytes,
    max_request_bytes = limits$max_request_bytes,
    max_message_bytes = limits$max_message_bytes
  )
}

# Start an embedded session when nothing owns notifications yet. Returns TRUE
# when this call started one.
.jdv_session_ensure <- function() {
  if (!identical(.jdv_session_owner(), "none")) {
    return(FALSE)
  }
  limits <- .jdv_notification_limits()
  .jdv_queue_reset(limits)
  .jdv_state$embedded <- TRUE
  hello <- .jdv_hello(.jdv_embedded_hello_limits())
  tryCatch(
    .jdv_notify(.jdv_json_encode(hello)),
    error = function(error) {
      .jdv_state$embedded <- FALSE
      .jdv_queue_reset()
      stop(error)
    }
  )
  TRUE
}

# Drop an embedded session that a failed first registration left empty.
.jdv_session_discard_empty <- function() {
  if (
    isTRUE(.jdv_state$embedded) &&
      is.null(.jdv_state$transport) &&
      !length(ls(.jdv_state$entries, all.names = TRUE))
  ) {
    .jdv_state$embedded <- FALSE
    .jdv_queue_reset()
  }
  invisible(NULL)
}

.jdv_assert_not_embedded <- function() {
  if (isTRUE(.jdv_state$embedded) && is.null(.jdv_state$transport)) {
    jdv_abort(
      "in_use",
      paste0(
        "An embedded notification session is active; ",
        "call jdv_disconnect() before opening a viewer connection."
      )
    )
  }
  invisible(NULL)
}

jdv_json_array <- function(x = list()) {
  if (!is.list(x) || !is.null(names(x))) {
    stop("JSON arrays must be unnamed lists.", call. = FALSE)
  }
  structure(x, class = "jdv_json_array")
}

jdv_json_object <- function(x = list()) {
  if (!is.list(x) || (length(x) && is.null(names(x)))) {
    stop("JSON objects must be named lists.", call. = FALSE)
  }
  structure(x, class = "jdv_json_object")
}

.jdv_json_values <- function(x) structure(unname(x), class = "jdv_json_array")

.jdv_option_limit <- function(
  name,
  default,
  minimum = 1,
  allow_infinite = FALSE
) {
  value <- getOption(name, default)
  if (
    !is.numeric(value) ||
      length(value) != 1L ||
      is.object(value) ||
      is.na(value) ||
      (!is.finite(value) && !(allow_infinite && identical(value, Inf))) ||
      value != floor(value) ||
      value < minimum ||
      (value > .Machine$integer.max &&
        !(allow_infinite && identical(value, Inf)))
  ) {
    query_error("invalid_request", paste0("Invalid option: ", name, "."))
  }
  as.numeric(value)
}

.jdv_max_message_bytes <- function() {
  .jdv_option_limit("jdv.max_message_bytes", 10 * 1024^2, 1024)
}

.jdv_max_request_bytes <- function() {
  .jdv_option_limit("jdv.max_request_bytes", 1024^2, 128)
}

.jdv_max_work_bytes <- function() {
  .jdv_option_limit("jdv.max_work_bytes", Inf, 1024, allow_infinite = TRUE)
}

.jdv_derived_work_bytes <- function(output_bytes) {
  # Six bytes per output byte covers retained channel copies and transient
  # encoder structures in the measured Snapshot workload; the 4 MiB floor
  # preserves the former 64 MiB allowance at the 10 MiB default.
  6 * as.double(output_bytes) + 4 * 1024^2
}

.jdv_page_work_bytes <- function() {
  min(
    .Machine$integer.max,
    .jdv_derived_work_bytes(.jdv_max_message_bytes()),
    .jdv_max_work_bytes()
  )
}

.jdv_snapshot_work_bytes <- function() {
  output_bytes <- min(.jdv_snapshot_max_bytes(), .jdv_max_message_bytes())
  min(
    .Machine$integer.max,
    .jdv_derived_work_bytes(output_bytes),
    .jdv_max_work_bytes()
  )
}

.jdv_snapshot_max_bytes <- function() {
  .jdv_option_limit("jdv.snapshot_max_bytes", 10 * 1024^2, 1024)
}

.jdv_max_cache_bytes <- function() {
  .jdv_option_limit("jdv.max_cache_bytes", 32 * 1024^2, 1024)
}

.jdv_max_query_rows <- function() {
  .jdv_option_limit("jdv.max_query_rows", Inf, 1, allow_infinite = TRUE)
}

.jdv_json_encode <- function(
  x,
  limit = .jdv_max_message_bytes(),
  work_limit = .jdv_page_work_bytes()
) {
  tryCatch(
    .Call(C_jdv_json_encode, x, as.numeric(limit), as.numeric(work_limit)),
    error = function(e) {
      if (identical(conditionMessage(e), "jdv_json_output_limit")) {
        .jdv_budget_error(
          "JSON message exceeds the configured output byte limit.",
          "output",
          auto_fallback = TRUE
        )
      }
      if (identical(conditionMessage(e), "jdv_json_work_limit")) {
        .jdv_budget_error(
          "JSON construction exceeds the configured work byte budget.",
          "native_work",
          auto_fallback = TRUE
        )
      }
      stop(e)
    }
  )
}

.jdv_json_string_measure <- function(x, max_bytes) {
  tryCatch(
    .Call(C_jdv_json_string_measure, x, as.numeric(max_bytes)),
    error = function(error) NULL
  )
}

.jdv_json_encode_error <- function(x) {
  # Control responses have a separate, fixed allowance so the engine can
  # report a work-budget failure even when the request exhausted that budget.
  .jdv_json_encode(
    x,
    limit = max(1024, .jdv_max_message_bytes()),
    work_limit = 64 * 1024
  )
}

.jdv_json_parse <- function(x, limit = .jdv_max_request_bytes()) {
  tryCatch(
    .Call(C_jdv_json_parse, enc2utf8(x), limit),
    error = function(e) {
      message <- conditionMessage(e)
      code <- if (identical(message, "jdv_json_input_limit")) {
        "limit_exceeded"
      } else {
        "invalid_request"
      }
      query_error(
        code,
        if (code == "limit_exceeded") {
          "JSON request exceeds the byte limit."
        } else {
          "Invalid JSON request."
        }
      )
    }
  )
}

.jdv_title_key <- function(title) {
  paste0(
    "title:",
    paste(as.integer(charToRaw(enc2utf8(title))), collapse = "-")
  )
}

.jdv_fingerprint <- function(x) {
  classes <- lapply(seq_len(ncol(x)), function(j) {
    value <- if (is.matrix(x)) x[integer(), j] else x[[j]]
    class(value)
  })
  list(nrow = nrow(x), ncol = ncol(x), names = colnames(x), classes = classes)
}

.jdv_check_fingerprint <- function(entry) {
  if (is.null(entry$source)) {
    return(invisible(TRUE))
  }
  current <- tryCatch(.jdv_fingerprint(entry$source), error = function(e) NULL)
  if (!identical(current, entry$fingerprint)) {
    query_error(
      "schema_changed",
      "Table dimensions, column names, or column classes changed; register it again."
    )
  }
  invisible(TRUE)
}

.jdv_schema_fields <- function(schema) {
  # A schema is an extensible descriptor. Consumers ignore fields they do
  # not recognize; future optional fields such as drillable remain legal.
  for (field in c("class", "levels")) {
    if (!is.null(schema[[field]])) {
      schema[[field]] <- .jdv_json_values(schema[[field]])
    }
  }
  if (!is.null(schema$class)) {
    schema$native_type <- schema$class
    schema$class <- NULL
  }
  if (identical(schema$type, "factor")) schema$type <- "categorical"
  schema
}

.jdv_schema <- function(schemas) lapply(schemas, .jdv_schema_fields)

.jdv_json_channel_errors <- function(errors) {
  if (is.null(errors)) {
    return(NULL)
  }
  names(errors)[names(errors) == "sortKey"] <- "sort_key"
  names(errors)[names(errors) == "na"] <- "na_rows"
  errors
}

.jdv_json_column <- function(column, snapshot = FALSE, budget = NULL) {
  data <- column$data
  out <- list()
  if (!is.null(budget) && (!is.null(data$na) || !is.null(data$special))) {
    .jdv_budget_charge(
      budget,
      16 * length(data$na %||% data$special) + 64,
      "sparse_channels"
    )
  }
  if (!is.null(data$values)) {
    out$values <- .jdv_json_values(data$values)
  }
  if (!is.null(data$display)) {
    omit <- FALSE
    if (
      column$schema$type %in% c("string", "factor", "int64") &&
        !is.null(data$values) &&
        !is.null(data$na)
    ) {
      keep <- !data$na
      omit <- identical(
        unname(data$display[keep]),
        unname(data$values[keep])
      ) &&
        all(data$display[!keep] == "NA")
    }
    if (!omit) out$display <- .jdv_json_values(data$display)
  }
  if (
    !is.null(data$sortKey) &&
      !column$schema$type %in% c("boolean", "integer", "number", "duration")
  ) {
    out$sort_key <- .jdv_json_values(data$sortKey)
  }
  if (!is.null(data$special)) {
    special <- list()
    for (kind in c("nan", "pos_inf", "neg_inf")) {
      rows <- which(!is.na(data$special) & data$special == kind) - 1L
      if (length(rows)) {
        special[[kind]] <- .jdv_json_values(rows)
      }
    }
    if (length(special)) {
      out$special <- special
    }
  }
  if (!is.null(data$na)) {
    out$na_rows <- .jdv_json_values(which(data$na) - 1L)
  }
  if (snapshot && length(column$errors)) {
    out$errors <- .jdv_json_channel_errors(column$errors)
  }
  out
}

.jdv_page_column <- function(column, budget = NULL) {
  list(
    schema = .jdv_schema_fields(column$schema),
    data = .jdv_json_column(column, budget = budget),
    errors = .jdv_json_channel_errors(column$errors)
  )
}

.jdv_open_content <- function(x, mode, collation, limits = list()) {
  work_limit <- if (mode == "snapshot") {
    limits$snapshot_work_bytes %||% .jdv_snapshot_work_bytes()
  } else {
    limits$page_work_bytes %||% .jdv_page_work_bytes()
  }
  work_budget <- .jdv_budget(work_limit, auto_fallback = TRUE)
  if (mode == "snapshot") {
    snapshot <- snapshot_table(
      x,
      collation = collation,
      limits = limits,
      budget = work_budget
    )
    row_names <- .jdv_explicit_row_names(x)
    retain_source <- any(vapply(
      snapshot$schema,
      function(column) isTRUE(column$drillable),
      logical(1L)
    ))
    return(list(
      mode = mode,
      source = if (retain_source) x else NULL,
      holder = NULL,
      fingerprint = if (retain_source) .jdv_fingerprint(x) else NULL,
      nrow = snapshot$nrow,
      ncol = snapshot$ncol,
      schema = snapshot$schema,
      row_names = row_names,
      data = list(
        source_row = .jdv_json_values(seq_len(snapshot$nrow) - 1L),
        row_labels = if (is.null(row_names)) {
          NULL
        } else {
          .jdv_json_values(row_names)
        },
        columns = lapply(
          snapshot$columns,
          .jdv_json_column,
          snapshot = TRUE,
          budget = work_budget
        )
      ),
      work_used = work_budget$used,
      work_limit = work_budget$limit,
      collation = collation
    ))
  }
  holder <- paged_table(
    x,
    collation = collation,
    limits = limits,
    budget = work_budget
  )
  list(
    mode = mode,
    source = x,
    holder = holder,
    fingerprint = .jdv_fingerprint(x),
    nrow = holder$nrow,
    ncol = holder$ncol,
    schema = holder$schema,
    row_names = NULL,
    data = NULL,
    work_used = work_budget$used,
    work_limit = work_budget$limit,
    collation = collation
  )
}

.jdv_explicit_row_names <- function(x) {
  if (is.data.frame(x)) {
    if (.row_names_info(x, type = 1L) > 0L) rownames(x) else NULL
  } else {
    rownames(x)
  }
}

.jdv_descriptor <- function(
  content,
  id,
  generation,
  title,
  reason,
  tracking = NULL
) {
  capabilities <- list(
    seek = TRUE,
    sort = TRUE,
    filter = TRUE,
    known_total = TRUE,
    children = any(vapply(
      content$schema,
      function(column) isTRUE(column$drillable),
      logical(1L)
    )),
    refresh = TRUE
  )
  capabilities <- append(capabilities, list(FALSE), after = 4L)
  names(capabilities)[[5L]] <- "next"
  capabilities$track <- .jdv_track_capability(tracking)
  params <- list(
    view = id,
    kind = "grid",
    access = if (content$mode == "snapshot") "snapshot" else "random",
    encoding = "jdv-json",
    capabilities = capabilities,
    generation = generation,
    title = title,
    reason = reason,
    collation = content$collation,
    nrow = content$nrow,
    ncol = content$ncol,
    columns = .jdv_schema(content$schema)
  )
  if (!is.null(tracking)) {
    params$tracking <- tracking
  }
  if (content$mode == "snapshot") {
    params$data <- content$data
  }
  list(method = "view/open", params = params)
}

.jdv_install <- function(
  content,
  title,
  id,
  generation,
  captured = NULL,
  intent = NULL,
  sequence = NULL
) {
  entry <- new.env(parent = emptyenv())
  entry$id <- id
  entry$title <- title
  entry$generation <- generation
  entry$mode <- content$mode
  entry$source <- content$source
  entry$holder <- content$holder
  entry$fingerprint <- content$fingerprint
  entry$nrow <- content$nrow
  entry$ncol <- content$ncol
  entry$schema <- content$schema
  entry$collation <- content$collation
  # The value and the mode/collation the caller asked for, so view/refresh can
  # rebuild the view. The effective mode is deliberately not the intent: an
  # automatic choice is made again on every rebuild.
  entry$captured <- captured
  entry$intent_mode <- intent$mode
  entry$intent_collation <- intent$collation
  if (identical(content$mode, "sequential")) {
    entry$stream <- content$stream
    entry$stream_busy <- FALSE
    entry$stream_failure <- NULL
    entry$page_rows <- content$page_rows
  }
  entry$inflight <- 0L
  entry$close_pending <- FALSE
  entry$closed <- FALSE
  if (is.null(sequence)) {
    .jdv_state$sequence <- .jdv_state$sequence + 1
    sequence <- .jdv_state$sequence
  }
  entry$sequence <- sequence
  entry
}

.jdv_close_entry <- function(entry) {
  entry$closed <- TRUE
  if (entry$inflight > 0L) {
    entry$close_pending <- TRUE
  } else {
    if (!is.null(entry$holder) && !entry$holder$closed) {
      query_dispose(entry$holder)
    }
    entry$holder <- NULL
    entry$source <- NULL
    entry$tree_value <- NULL
    entry$captured <- NULL
    entry$track_value <- NULL
    entry$track_failed <- NULL
    entry$fingerprint <- NULL
    entry$close_pending <- FALSE
    if (identical(entry$mode, "sequential")) .jdv_sequential_release(entry)
  }
  invisible(NULL)
}

.jdv_close_children <- function(entry, notify = FALSE) {
  child_ids <- entry$children %||% character()
  entry$children <- character()
  for (child_id in child_ids) {
    if (!exists(child_id, envir = .jdv_state$entries, inherits = FALSE)) {
      next
    }
    child <- get(child_id, envir = .jdv_state$entries, inherits = FALSE)
    if (
      !identical(child$parent_entry, entry) ||
        !identical(child$parent_generation, entry$generation)
    ) {
      next
    }
    tryCatch(
      .jdv_close_internal(child_id, notify = notify, reason = "parent_closed"),
      error = function(error) {
        if (inherits(error, "jdv_notification_overflow")) {
          stop(error)
        }
        if (exists(child_id, envir = .jdv_state$entries, inherits = FALSE)) {
          rm(list = child_id, envir = .jdv_state$entries)
        }
      }
    )
  }
  invisible(NULL)
}

.jdv_close_notification <- function(entry, reason = NULL) {
  event <- list(
    method = "view/closed",
    params = list(view = entry$id, generation = entry$generation)
  )
  if (!is.null(reason)) {
    event$params$reason <- reason
  }
  encoded <- tryCatch(
    .jdv_json_encode(event, work_limit = 64 * 1024),
    error = function(e) NULL
  )
  if (!is.null(encoded)) {
    return(encoded)
  }
  # View IDs are generated as v-N and the reason is a fixed protocol token.
  reason_field <- if (is.null(reason)) {
    ""
  } else {
    paste0(',"reason":"', reason, '"')
  }
  paste0(
    '{"method":"view/closed","params":{"view":"',
    entry$id,
    '","generation":',
    format(entry$generation, scientific = FALSE),
    reason_field,
    "}}"
  )
}

.jdv_close_internal <- function(
  id = NULL,
  notify = FALSE,
  expected = NULL,
  reason = NULL
) {
  ids <- if (is.null(id)) ls(.jdv_state$entries, all.names = TRUE) else id
  for (key in ids) {
    if (exists(key, envir = .jdv_state$entries, inherits = FALSE)) {
      entry <- get(key, envir = .jdv_state$entries, inherits = FALSE)
      if (!is.null(expected) && !identical(entry, expected)) {
        next
      }
      .jdv_close_children(entry, notify = notify)
      rm(list = key, envir = .jdv_state$entries)
      parent <- entry$parent_entry
      if (
        !is.null(parent) &&
          identical(parent$generation, entry$parent_generation) &&
          .jdv_tree_entry_is_current(parent)
      ) {
        parent$children <- setdiff(parent$children, entry$id)
      }
      title_key <- if (is.null(entry$title)) {
        NULL
      } else {
        .jdv_title_key(entry$title)
      }
      if (
        !is.null(title_key) &&
          exists(title_key, envir = .jdv_state$titles, inherits = FALSE) &&
          identical(
            get(title_key, envir = .jdv_state$titles, inherits = FALSE)$id,
            entry$id
          )
      ) {
        rm(list = title_key, envir = .jdv_state$titles)
      }
      .jdv_close_entry(entry)
      # Notify last so an overflow cannot leave this entry half released.
      if (notify) {
        .jdv_notify(.jdv_close_notification(entry, reason))
      }
    }
  }
  invisible(NULL)
}

#' Register an object for a transport-independent viewer
#'
#' @param x A data frame or matrix for grid views; an Arrow Table or
#'   RecordBatchReader, nanoarrow array stream, or Polars DataFrame for a
#'   sequential grid; or an R object to explore in a tree view.
#' @param title Optional title. Reusing a non-NULL title replaces its table
#'   generation; NULL titles always create independent tables.
#' @param mode Grid view mode: `"auto"`, `"snapshot"`, or `"paged"`.
#' @param collation Grid string ordering policy, `"C"` or `"locale"`. When
#'   `NULL` (the default), `getOption("jdv.collation", "C")` supplies the
#'   default. A non-`NULL` value is kept as the view's refresh intent.
#' @param binding Optional `list(name = "x", env = env)` naming a variable that
#'   holds `x`, for embedding hosts. The view then follows that variable as
#'   [jdv_view()] does with `track = TRUE`: when the variable is assigned a
#'   different object, the view is rebuilt as its next generation. The variable
#'   must currently hold exactly the object passed as `x`, and it must be
#'   readable without evaluation (a plain or already forced binding), or the
#'   call fails. Tracking needs R 4.6.0 or later; older versions fail with the
#'   `unsupported` error code. The environment is referenced weakly. Sequential
#'   sources cannot be tracked. See the Details of [jdv_view()] for what is
#'   detected. [jdv_binding()] finds such a binding from a variable name without
#'   evaluating it.
#' @details
#' Sequential sources are exported through the optional nanoarrow package and
#' moved into the viewer without fetching a record batch. Their total row count
#' is unknown. They support forward-only pages, not Snapshot/Paged modes, random
#' access, sorting, or filtering. The mode and collation arguments apply to
#' ordinary R tables. Closing or replacing a view releases its stream and any
#' retained batch. A string call to [jdv_rpc()] cannot consume a sequential
#' page; those pages require the viewer binary transport.
#'
#' Re-registering a title that is still active reuses its view ID and increments
#' its generation. Closing that view removes the title association, so a later
#' registration starts with a new ID and generation one. Re-register after
#' changing values held by a reference object because the lightweight
#' fingerprint does not detect value-only changes. Paged tables capture
#' `getOption("jdv.max_page_rows", 2000)` at registration; changing the option
#' takes effect after re-registering the view. `jdv.max_work_bytes` and
#' `jdv.max_query_rows` are unlimited by default for full sort/filter work;
#' `jdv.max_cache_bytes` defaults to 32 MiB and `jdv.snapshot_max_bytes` to 10
#' MiB. Snapshot construction, registration probes, pages, and JSON encoding
#' retain separate finite derived budgets. Each Paged view also retains its
#' latest filtered/sorted row index outside the cache byte budget, so pages for
#' that query do not repeat its sort/filter work. A new query replaces it; an
#' unfiltered page releases the latest-index slot. Older results may remain in
#' the LRU index cache. Clearing, generation replacement, or closing the view
#' releases both the slot and caches. The latest index adds one potentially
#' large index per open Paged view, while the 32 MiB cache budget continues to
#' govern the LRU source-column, channel, and result-index caches. Auto mode
#' also uses `jdv.snapshot_max_cells` (default 10,000) and caps the snapshot
#' byte estimate by `jdv.max_message_bytes`; if Snapshot-only row-name metadata
#' or snapshot construction exceeds its budget, Auto retries registration as
#' Paged. Page, work, cache, and query-row settings are captured when a table is
#' registered. Snapshot and page work allowances are each the smaller of
#' `INT_MAX`, six times their output allowance plus 4 MiB, and a finite
#' `jdv.max_work_bytes` setting. Snapshot uses the smaller of
#' `jdv.snapshot_max_bytes` and `jdv.max_message_bytes`; page work uses
#' `jdv.max_message_bytes`. When `jdv.max_work_bytes` is finite, query work,
#' page extraction, and response encoding share that per-operation allowance. In
#' the event-loop request path, Interrupt behavior depends on R's suspension
#' state when a transport callback begins; if interrupts were already suspended,
#' a long sort or filter may not stop promptly. The viewer UI should show that R
#' is busy. These estimates do not bound total process memory, source storage,
#' arbitrary user method allocations, R allocator and GC overhead, or transient
#' R-internal string conversion and sorting scratch.
#' @return
#' A list with the view `id` and its `generation`. The `view/open` message, and
#' any `view/closed` messages emitted when the registry evicts or replaces older
#' views, are queued as notifications. With an embedded host, take them with
#' [jdv_notifications()]; see [jdv_spec] for the delivery order. If the
#' notification queue overflows, the session ends, every view is closed, and the
#' call fails.
#' @export
jdv_register <- function(
  x,
  title = NULL,
  mode = c("auto", "snapshot", "paged"),
  collation = NULL,
  binding = NULL
) {
  .jdv_assert_active()
  mode <- .jdv_match_arg(mode, c("auto", "snapshot", "paged"), "'mode'")
  if (!is.null(collation)) {
    collation <- .jdv_match_arg(collation, c("C", "locale"), "'collation'")
  }
  tracking <- if (!is.null(binding)) .jdv_binding_verify(x, binding)
  registered <- .jdv_register_internal(
    x,
    title,
    mode,
    collation,
    tracking = if (!is.null(tracking)) {
      .jdv_tracking_json(tracking$name, "active")
    }
  )
  if (!is.null(tracking)) {
    entry <- get(registered$id, envir = .jdv_state$entries, inherits = FALSE)
    .jdv_track_attach(entry, tracking$ref, tracking$name, x)
  }
  if (
    identical(.jdv_session_owner(), "transport") && .jdv_state$rpc_depth == 0L
  ) {
    # Outside a viewer request nothing else would send the queued messages.
    .jdv_transport_flush()
  }
  list(id = registered$id, generation = registered$generation)
}

# Register without sending. `emit = FALSE` leaves the view/open message out of
# the queue; the caller owns it (see object/open, where it follows the
# response). `reason` is the view/open reason token. Returns the id,
# generation, open JSON, and descriptor if any.
.jdv_register_internal <- function(
  x,
  title,
  mode,
  collation,
  emit = TRUE,
  reason = "register",
  tracking = NULL,
  title_slot = TRUE
) {
  .jdv_assert_active()
  .jdv_assert_not_refreshing()
  collation_intent <- collation
  if (is.null(collation)) {
    collation <- getOption("jdv.collation", "C")
  }
  collation <- .jdv_match_arg(
    collation,
    c("C", "locale"),
    "'collation' or option 'jdv.collation'"
  )
  started <- .jdv_session_ensure()
  completed <- FALSE
  on.exit(if (started && !completed) .jdv_session_discard_empty(), add = TRUE)
  source <- jdv_source(x)
  x <- source$data
  registered <- if (identical(source$kind, "tree")) {
    .jdv_tree_register(
      x,
      title = title,
      reason = reason,
      tracking = tracking,
      title_slot = title_slot
    )
  } else if (identical(source$access, "sequential")) {
    .jdv_sequential_register(
      x,
      title = title,
      reason = reason,
      title_slot = title_slot
    )
  } else {
    .jdv_grid_register(
      x,
      title,
      mode,
      collation,
      collation_intent,
      reason,
      tracking,
      title_slot
    )
  }
  if (emit) {
    .jdv_notify(registered$open)
  }
  completed <- TRUE
  registered
}

.jdv_grid_content <- function(x, mode, collation) {
  if (!is.data.frame(x) && !is.matrix(x)) {
    query_error("invalid_request", "Expected a data frame or matrix.")
  }
  limits <- list(
    page_rows = .jdv_option_limit("jdv.max_page_rows", 2000),
    work_bytes = .jdv_max_work_bytes(),
    page_work_bytes = .jdv_page_work_bytes(),
    snapshot_work_bytes = .jdv_snapshot_work_bytes(),
    cache_bytes = .jdv_max_cache_bytes(),
    query_rows = .jdv_max_query_rows()
  )
  max_message <- .jdv_max_message_bytes()
  .jdv_metadata_budget(
    x,
    min(max_message, limits$page_work_bytes),
    snapshot = FALSE
  )
  actual_mode <- mode
  if (mode == "auto") {
    cells <- as.double(nrow(x)) * max(1, as.double(ncol(x)))
    snapshot_cells <- .jdv_option_limit("jdv.snapshot_max_cells", 10000, 0)
    estimate_limit <- min(max_message, .jdv_snapshot_max_bytes())
    estimate <- if (cells <= snapshot_cells) {
      .jdv_estimate_snapshot_bytes(x, cells, estimate_limit)
    } else {
      estimate_limit + 1
    }
    actual_mode <- if (cells <= snapshot_cells && estimate <= estimate_limit) {
      "snapshot"
    } else {
      "paged"
    }
  }
  if (actual_mode == "snapshot") {
    tryCatch(
      .jdv_metadata_budget(
        x,
        min(max_message, limits$snapshot_work_bytes),
        snapshot = TRUE,
        auto_fallback_row_names = mode == "auto"
      ),
      error = function(e) {
        if (mode == "auto" && isTRUE(e$details$auto_fallback)) {
          actual_mode <<- "paged"
        } else {
          stop(e)
        }
      }
    )
  }
  if (actual_mode == "snapshot" && 2 * as.double(nrow(x)) + 1 > max_message) {
    query_error(
      "limit_exceeded",
      "Snapshot row indices cannot fit within the JSON message byte limit."
    )
  }
  content <- tryCatch(
    .jdv_open_content(x, actual_mode, collation, limits),
    error = function(e) {
      if (
        mode == "auto" &&
          actual_mode == "snapshot" &&
          inherits(e, "jdv_query_error") &&
          isTRUE(e$details$auto_fallback)
      ) {
        actual_mode <<- "paged"
        .jdv_open_content(x, actual_mode, collation, limits)
      } else {
        stop(e)
      }
    }
  )
  list(content = content, limits = limits, max_message = max_message)
}

.jdv_grid_register <- function(
  x,
  title,
  mode,
  collation,
  collation_intent = collation,
  reason = "register",
  tracking = NULL,
  title_slot = TRUE
) {
  if (!is.null(title)) {
    title <- query_string(title, 4096L)
  }
  max_tables <- .jdv_option_limit("jdv.max_tables", 64)
  built <- .jdv_grid_content(x, mode, collation)
  content <- built$content
  limits <- built$limits
  max_message <- built$max_message
  .jdv_assert_active()
  title_key <- if (is.null(title) || !title_slot) {
    NULL
  } else {
    .jdv_title_key(title)
  }
  previous <- if (
    !is.null(title_key) &&
      exists(title_key, envir = .jdv_state$titles, inherits = FALSE)
  ) {
    get(title_key, envir = .jdv_state$titles, inherits = FALSE)
  } else {
    NULL
  }
  id <- if (is.null(title)) {
    paste0(
      "v-",
      format(.jdv_state$next_id + 1, scientific = FALSE, trim = TRUE)
    )
  } else if (!is.null(previous)) {
    previous$id
  } else {
    paste0(
      "v-",
      format(.jdv_state$next_id + 1, scientific = FALSE, trim = TRUE)
    )
  }
  generation <- if (is.null(previous)) 1 else previous$generation + 1
  descriptor <- .jdv_descriptor(
    content,
    id,
    generation,
    title,
    reason,
    tracking
  )
  open <- tryCatch(
    .jdv_json_encode(
      descriptor,
      max_message,
      max(1, content$work_limit - content$work_used)
    ),
    error = function(e) {
      if (
        mode == "auto" &&
          content$mode == "snapshot" &&
          inherits(e, "jdv_query_error") &&
          identical(e$code, "limit_exceeded")
      ) {
        content <<- .jdv_open_content(x, "paged", collation, limits)
        previous <<- if (
          !is.null(title_key) &&
            exists(title_key, envir = .jdv_state$titles, inherits = FALSE)
        ) {
          get(title_key, envir = .jdv_state$titles, inherits = FALSE)
        } else {
          NULL
        }
        id <<- if (is.null(title)) {
          paste0(
            "v-",
            format(.jdv_state$next_id + 1, scientific = FALSE, trim = TRUE)
          )
        } else if (!is.null(previous)) {
          previous$id
        } else {
          paste0(
            "v-",
            format(.jdv_state$next_id + 1, scientific = FALSE, trim = TRUE)
          )
        }
        generation <<- if (is.null(previous)) 1 else previous$generation + 1
        descriptor <<- .jdv_descriptor(
          content,
          id,
          generation,
          title,
          reason,
          tracking
        )
        .jdv_json_encode(
          descriptor,
          max_message,
          max(1, content$work_limit - content$work_used)
        )
      } else {
        stop(e)
      }
    }
  )
  .jdv_assert_active()
  old <- if (exists(id, envir = .jdv_state$entries, inherits = FALSE)) {
    get(id, envir = .jdv_state$entries, inherits = FALSE)
  } else {
    NULL
  }
  .jdv_assert_active()
  active <- length(ls(.jdv_state$entries, all.names = TRUE))
  while (active > max_tables || (is.null(old) && active >= max_tables)) {
    candidates <- lapply(
      setdiff(
        ls(.jdv_state$entries, all.names = TRUE),
        c(id, .jdv_state$eviction_pins)
      ),
      function(key) get(key, envir = .jdv_state$entries, inherits = FALSE)
    )
    if (!length(candidates)) {
      query_error(
        "limit_exceeded",
        "No unpinned view can be evicted for this child."
      )
    }
    oldest <- candidates[[
      which.min(vapply(candidates, `[[`, numeric(1L), "sequence"))
    ]]
    .jdv_close_internal(oldest$id, notify = TRUE)
    .jdv_assert_active()
    active <- length(ls(.jdv_state$entries, all.names = TRUE))
  }
  .jdv_assert_active()
  entry <- .jdv_install(
    content,
    title,
    id,
    generation,
    captured = x,
    intent = list(mode = mode, collation = collation_intent)
  )
  committed <- FALSE
  on.exit(
    if (!committed && isTRUE(.jdv_state$unloading)) {
      .jdv_close_internal(id, expected = entry)
    },
    add = TRUE
  )
  .jdv_assert_active()
  if (is.null(title)) {
    .jdv_state$next_id <- .jdv_state$next_id + 1
  }
  if (is.null(previous) && !is.null(title)) {
    .jdv_state$next_id <- .jdv_state$next_id + 1
  }
  assign(id, entry, envir = .jdv_state$entries)
  if (!is.null(title_key)) {
    assign(
      title_key,
      list(id = id, generation = generation),
      envir = .jdv_state$titles
    )
  }
  .jdv_assert_active()
  if (!is.null(old)) {
    .jdv_close_children(old, notify = TRUE)
    .jdv_close_entry(old)
  }
  .jdv_assert_active()
  committed <- TRUE
  list(id = id, generation = generation, open = open)
}

.jdv_fields <- function(x, allowed, required = allowed) {
  fields <- names(x)
  if (
    !is.list(x) ||
      (is.object(x) && !inherits(x, "jdv_json_object")) ||
      is.null(fields) ||
      anyNA(fields) ||
      any(!nzchar(fields)) ||
      anyDuplicated(fields) ||
      any(!required %in% fields)
  ) {
    query_error("invalid_request", "Invalid RPC object fields.")
  }
  invisible(x)
}

.jdv_request_id <- function(id) {
  if (
    is.character(id) &&
      length(id) == 1L &&
      !is.na(id) &&
      nchar(id, type = "bytes") <= 128L
  ) {
    return(id)
  }
  if (
    typeof(id) %in% c("integer", "double") &&
      !is.object(id) &&
      length(id) == 1L &&
      !is.na(id) &&
      is.finite(id) &&
      id >= 0 &&
      id == floor(id) &&
      id < 2^53
  ) {
    return(unname(id))
  }
  query_error(
    "invalid_request",
    "Request id must be a string or a safe integer."
  )
}

.jdv_id_key <- function(id) {
  paste0(
    typeof(id),
    ":",
    paste(as.integer(charToRaw(enc2utf8(as.character(id)))), collapse = "-")
  )
}

.jdv_rpc_entry <- function(id, generation) {
  if (!is.character(id) || length(id) != 1L || is.na(id)) {
    query_error("invalid_request", "View id must be one string.")
  }
  if (!exists(id, envir = .jdv_state$entries, inherits = FALSE)) {
    query_error("view_not_found", "View is not registered.")
  }
  entry <- get(id, envir = .jdv_state$entries, inherits = FALSE)
  generation <- query_integer(generation, "generation", 1)
  if (generation != entry$generation) {
    query_error(
      "stale_generation",
      "The table generation is no longer current."
    )
  }
  if (entry$closed) {
    query_error("view_not_found", "View is closed.")
  }
  entry$inflight <- entry$inflight + 1L
  entry
}

.jdv_release_entry <- function(entry) {
  entry$inflight <- entry$inflight - 1L
  if (entry$inflight == 0L && entry$close_pending) {
    .jdv_close_entry(entry)
  }
  invisible(NULL)
}

# Resolve a tree path or a grid cell path for object/children and object/open.
# The caller owns entry lifetime and chooses how an opened child is installed.
.jdv_resolve_object_path <- function(entry, raw_path) {
  if (identical(entry$mode, "tree")) {
    path <- .jdv_tree_path(raw_path)
    ancestry <- .jdv_tree_ancestry(entry)
    resolved <- .jdv_tree_resolve(entry$tree_value, path, ancestry)
  } else {
    if (identical(entry$mode, "sequential")) {
      query_error(
        "unsupported",
        "Sequential views do not support object paths."
      )
    }
    path <- .jdv_cell_path(raw_path)
    ancestry <- .jdv_tree_ancestry(entry)
    value <- .jdv_cell_value(entry, path[[1L]])
    resolved <- .jdv_tree_resolve(value, path[-1L], ancestry)
  }
  if (!identical(resolved$status, "value")) {
    query_error(
      "unavailable",
      paste0("Tree path is no longer available: ", resolved$status, ".")
    )
  }
  list(path = path, resolved = resolved)
}

# Shared object/children engine. The entry is already acquired by the caller.
.jdv_request_object_children <- function(entry, params) {
  .jdv_fields(
    params,
    c("view", "generation", "path", "offset", "limit", "attributes"),
    c("view", "generation", "path")
  )
  if (any(names(params) %in% c("mode", "collation"))) {
    query_error(
      "invalid_request",
      "object/children does not accept grid registration options."
    )
  }
  show_attributes <- TRUE
  if ("attributes" %in% names(params)) {
    show_attributes <- params$attributes
    if (
      !is.logical(show_attributes) ||
        is.object(show_attributes) ||
        length(show_attributes) != 1L ||
        is.na(show_attributes)
    ) {
      query_error("invalid_request", "attributes must be a boolean.")
    }
  }
  if (!identical(entry$mode, "tree")) {
    if (identical(entry$mode, "sequential")) {
      query_error(
        "unsupported",
        "Sequential views do not support object paths."
      )
    }
    query_error("unsupported", "Object children requires a tree view.")
  }
  selected <- .jdv_resolve_object_path(entry, params$path)
  path <- selected$path
  if (length(path) >= .jdv_tree_path_limit) {
    query_error("limit_exceeded", "Tree path reached the maximum depth.")
  }
  offset <- if (is.null(params$offset)) {
    0
  } else {
    query_integer(params$offset, "offset")
  }
  limit <- if (is.null(params$limit)) {
    200
  } else {
    query_integer(params$limit, "limit", 1)
  }
  if (limit > .jdv_tree_page_limit) {
    query_error("invalid_request", "limit exceeds the tree page cap.")
  }
  listing <- .jdv_tree_list_children(
    selected$resolved$value,
    path,
    offset,
    limit,
    c(.jdv_tree_ancestry(entry), selected$resolved$seen),
    show_attributes
  )
  list(
    view = entry$id,
    generation = entry$generation,
    path = jdv_json_array(lapply(path, jdv_json_object)),
    offset = as.double(offset),
    children = listing$children,
    total_children = as.double(listing$total_children)
  )
}

# Shared grid/rows engine. The entry is already acquired by the caller.
.jdv_request_table_rows <- function(entry, params) {
  .jdv_fields(
    params,
    c("view", "generation", "offset", "limit", "sort", "filter", "cols"),
    c("view", "generation")
  )
  .jdv_check_fingerprint(entry)
  if (entry$mode != "paged" || is.null(entry$holder)) {
    query_error(
      "unsupported",
      "This view does not support random row requests."
    )
  }
  sort <- if (is.null(params$sort)) list() else params$sort
  filter <- params$filter
  cols <- params$cols
  offset <- if (is.null(params$offset)) 0 else params$offset
  limit <- if (is.null(params$limit)) 200 else params$limit
  budget <- .jdv_budget(entry$holder$limits$page_work_bytes)
  result <- query_page(entry$holder, offset, limit, sort, filter, cols, budget)
  result$data$columns <- lapply(
    result$data$columns,
    .jdv_page_column,
    budget = budget
  )
  output <- list(
    view = entry$id,
    generation = entry$generation,
    total = result$total,
    total_unfiltered = result$total_unfiltered,
    offset = result$offset,
    limit = result$limit,
    data = list(
      source_row = .jdv_json_values(result$data$row_index - 1L),
      row_labels = if (is.null(result$data$row_names)) {
        NULL
      } else {
        .jdv_json_values(result$data$row_names)
      },
      columns = result$data$columns
    )
  )
  attr(output, "jdv_work_budget") <- budget
  output
}

.jdv_process_request <- function(request, request_id) {
  .jdv_fields(
    request,
    c("id", "method", "params", "encoding", "compression", "deadline"),
    c("method")
  )
  method <- query_string(request$method, 128L)
  if (!is.null(request$encoding) && !identical(request$encoding, "json")) {
    query_error("unsupported", "Unsupported message encoding.")
  }
  if (
    !is.null(request$compression) && !identical(request$compression, "none")
  ) {
    query_error("unsupported", "Unsupported message compression.")
  }
  now <- as.numeric(Sys.time())
  if (!is.null(request$deadline)) {
    deadline <- request$deadline
    if (
      !typeof(deadline) %in% c("integer", "double") ||
        is.object(deadline) ||
        length(deadline) != 1L ||
        is.na(deadline) ||
        !is.finite(deadline)
    ) {
      query_error(
        "invalid_request",
        "deadline must be one finite Unix timestamp in seconds."
      )
    }
    if (deadline < now) {
      query_error("expired", "Request deadline has expired.")
    }
  }
  if (method == "wake") {
    return(NULL)
  }
  if (method == "cancel") {
    params <- request$params
    .jdv_fields(params, "id")
    invisible(.jdv_request_id(params$id))
    # Synchronous RPC has no queued request to cancel. The transport queue
    # matches this notification against pending IDs before execution.
    return(NULL)
  }
  if (is.null(request_id)) {
    query_error(
      "invalid_request",
      "Requests that expect a response need an id."
    )
  }
  params <- request$params
  if (startsWith(method, "resources/")) {
    if (!method %in% .jdv_resource_methods) {
      query_error("method_not_found", "Unknown RPC method.")
    }
    return(.jdv_resources_request(method, params))
  }
  if (method == "stream/next") {
    .jdv_fields(
      params,
      c("view", "generation", "max_rows", "max_bytes"),
      c("view", "generation")
    )
    if (
      any(!names(params) %in% c("view", "generation", "max_rows", "max_bytes"))
    ) {
      query_error(
        "invalid_request",
        "Sequential requests do not support random-access parameters."
      )
    }
    entry <- .jdv_rpc_entry(params$view, params$generation)
    on.exit(.jdv_release_entry(entry), add = TRUE)
    return(.jdv_sequential_next(entry, params))
  }
  if (method %in% c("object/children", "object/open")) {
    allowed <- c("view", "generation", "path", "offset", "limit")
    if (method == "object/open") {
      allowed <- c(allowed, "mode", "collation")
    } else {
      allowed <- c(allowed, "attributes")
    }
    .jdv_fields(params, allowed, c("view", "generation", "path"))
    if (
      method == "object/children" &&
        any(names(params) %in% c("mode", "collation"))
    ) {
      query_error(
        "invalid_request",
        "object/children does not accept grid registration options."
      )
    }
    if (method == "object/open" && "attributes" %in% names(params)) {
      query_error(
        "invalid_request",
        "object/open does not accept the attributes option."
      )
    }
    show_attributes <- TRUE
    if ("attributes" %in% names(params)) {
      show_attributes <- params$attributes
      if (
        !is.logical(show_attributes) ||
          is.object(show_attributes) ||
          length(show_attributes) != 1L ||
          is.na(show_attributes)
      ) {
        query_error("invalid_request", "attributes must be a boolean.")
      }
    }
    child_mode <- "auto"
    if ("mode" %in% names(params)) {
      child_mode <- query_string(params$mode, Inf)
      if (!child_mode %in% c("auto", "snapshot", "paged")) {
        query_error("invalid_request", "Invalid child view mode.")
      }
    }
    child_collation <- NULL
    if ("collation" %in% names(params)) {
      child_collation <- query_string(params$collation, Inf)
      if (!child_collation %in% c("C", "locale")) {
        query_error("invalid_request", "Invalid child view collation.")
      }
    }
    entry <- .jdv_rpc_entry(params$view, params$generation)
    on.exit(.jdv_release_entry(entry), add = TRUE)
    if (method == "object/children") {
      return(.jdv_request_object_children(entry, params))
    }
    selected <- .jdv_resolve_object_path(entry, params$path)
    path <- selected$path
    resolved <- selected$resolved
    if (!length(path)) {
      query_error("invalid_request", "object/open requires a non-empty path.")
    }
    parent <- entry
    if (!.jdv_tree_entry_is_current(parent)) {
      query_error("view_not_found", "Parent view is no longer active.")
    }
    registered <- .jdv_tree_register_child(
      resolved$value,
      parent,
      mode = child_mode,
      collation = child_collation,
      title = .jdv_child_title(entry, path, resolved)
    )
    committed <- FALSE
    on.exit(
      if (!committed) {
        .jdv_close_internal(registered$id, notify = FALSE)
      },
      add = TRUE
    )
    descriptor <- registered$descriptor
    if (is.null(descriptor)) {
      descriptor <- .jdv_json_parse(
        registered$open,
        limit = max(1024, .jdv_max_message_bytes())
      )
    }
    result <- descriptor$params
    attr(result, "jdv_child_id") <- registered$id
    # The child's view/open is queued only once the response is final.
    attr(result, "jdv_child_open") <- registered$open
    committed <- TRUE
    return(result)
  }
  if (method == "view/refresh") {
    .jdv_fields(params, c("view", "generation"))
    if (any(!names(params) %in% c("view", "generation"))) {
      query_error(
        "invalid_request",
        "view/refresh accepts only view and generation."
      )
    }
    entry <- .jdv_rpc_entry(params$view, params$generation)
    on.exit(.jdv_release_entry(entry), add = TRUE)
    return(.jdv_refresh_view(entry))
  }
  if (method == "view/track") {
    .jdv_fields(params, c("view", "generation", "enabled"))
    if (any(!names(params) %in% c("view", "generation", "enabled"))) {
      query_error(
        "invalid_request",
        "view/track accepts only view, generation, and enabled."
      )
    }
    enabled <- params$enabled
    if (!is.logical(enabled) || length(enabled) != 1L || is.na(enabled)) {
      query_error("invalid_request", "enabled must be true or false.")
    }
    entry <- .jdv_rpc_entry(params$view, params$generation)
    on.exit(.jdv_release_entry(entry), add = TRUE)
    return(.jdv_track_set(entry, enabled))
  }
  if (method %in% c("grid/rows", "view/schema", "view/close")) {
    .jdv_fields(
      params,
      c("view", "generation", "offset", "limit", "sort", "filter", "cols"),
      c("view", "generation")
    )
    entry <- .jdv_rpc_entry(params$view, params$generation)
    on.exit(.jdv_release_entry(entry), add = TRUE)
    if (method == "view/close") {
      current <- if (
        exists(entry$id, envir = .jdv_state$entries, inherits = FALSE)
      ) {
        get(entry$id, envir = .jdv_state$entries, inherits = FALSE)
      } else {
        NULL
      }
      if (!identical(current, entry)) {
        query_error(
          "stale_generation",
          "The table generation is no longer current."
        )
      }
      .jdv_close_children(entry, notify = TRUE)
      .jdv_close_internal(entry$id, expected = entry)
      return(list(
        view = entry$id,
        generation = entry$generation,
        closed = TRUE
      ))
    }
    if (method == "view/schema") {
      .jdv_check_fingerprint(entry)
      result <- list(
        view = entry$id,
        generation = entry$generation,
        nrow = entry$nrow,
        ncol = entry$ncol,
        columns = .jdv_schema(entry$schema)
      )
      return(result)
    }
    return(.jdv_request_table_rows(entry, params))
  }
  query_error("method_not_found", "Unknown RPC method.")
}

.jdv_response <- function(
  id,
  result = NULL,
  error = NULL,
  warnings = character()
) {
  response <- list(id = id)
  if (is.null(error)) {
    response$result <- result
  } else {
    response$error <- list(
      code = error$code %||% "producer_error",
      message = substr(conditionMessage(error), 1L, 1024L)
    )
    if (!is.null(error$details)) {
      details <- error$details
      if (is.list(details) && "errors" %in% names(details)) {
        details$errors <- .jdv_json_channel_errors(details$errors)
      }
      response$error$details <- details
    }
  }
  response$warnings <- .jdv_json_values(warnings)
  response
}

.jdv_trim_page <- function(page, limit) {
  count <- min(as.integer(limit), length(page$data$source_row))
  take <- function(x) {
    if (is.null(x) || !(json_is_array(x) || inherits(x, "jdv_json_array"))) {
      return(x)
    }
    structure(x[seq_len(count)], class = class(x))
  }
  page$data$source_row <- take(page$data$source_row)
  page$data$row_labels <- take(page$data$row_labels)
  page$data$columns <- lapply(page$data$columns, function(column) {
    for (channel in names(column$data)) {
      if (identical(channel, "na_rows")) {
        rows <- column$data[[channel]]
        column$data[[channel]] <- structure(
          rows[rows < count],
          class = class(rows)
        )
      } else if (identical(channel, "special")) {
        special <- column$data[[channel]]
        for (kind in names(special)) {
          rows <- special[[kind]]
          special[[kind]] <- structure(rows[rows < count], class = class(rows))
          if (!length(special[[kind]])) special[[kind]] <- NULL
        }
        column$data[[channel]] <- if (length(special)) special else NULL
      } else {
        column$data[[channel]] <- take(column$data[[channel]])
      }
    }
    column
  })
  page$limit <- count
  page
}

`%||%` <- function(x, y) if (is.null(x)) y else x

#' Process a viewer request or poll the local transport
#'
#' With no argument or `NULL`, explicitly poll the active transport and process
#' at most the configured drain batch. This recovery path bypasses the event
#' gate and does not run reentrantly. The same call checks the variables that
#' tracked views follow and rebuilds the changed views once (see [jdv_view()]),
#' with or without a transport. An embedding host that takes notifications with
#' [jdv_notifications()] calls `jdv_rpc(NULL)` and then [jdv_notifications()]
#' from its own task callback: R runs task callbacks in registration order, so a
#' host callback that runs before the one of jdv would otherwise miss the update
#' until the next command. A JSON request string is handled synchronously as an
#' embedding API and remains independent of the transport. Notifications such as
#' `wake` and `cancel` return `NULL`. The response never carries notifications:
#' an embedding host takes them with [jdv_notifications()] and delivers them
#' before the response.
#'
#' @section Driving requests from a script:
#' The event gate dispatches viewer requests only at top level, when
#' `sys.nframe() == 0`; see [jdv_view()]. A script run with `Rscript` that waits
#' in a loop, for example with [base::Sys.sleep()], never returns to top level
#' while the loop runs, so no request is processed. Poll explicitly with
#' `jdv_rpc(NULL)` inside the loop instead.
#'
#' @param request One JSON request string, or `NULL` to poll the active viewer.
#' @return A JSON response string or NULL for a notification.
#' @examples
#' \dontrun{
#' # In a script: keep answering the viewer for 60 seconds.
#' jdv_view(mtcars)
#' deadline <- Sys.time() + 60
#' while (Sys.time() < deadline) {
#' jdv_rpc(NULL)
#' Sys.sleep(0.1)
#' }
#' }
#' @export
jdv_rpc <- function(request = NULL) {
  .jdv_rpc_internal(request, allow_binary = FALSE)
}

.jdv_rpc_internal <- function(request = NULL, allow_binary = FALSE) {
  .jdv_assert_active()
  if (is.null(request)) {
    if (.jdv_state$rpc_depth > 0L) {
      jdv_abort("in_use", "RPC re-entry is not supported.")
    }
    .jdv_transport_housekeeping()
    .jdv_assert_active()
    if (!is.null(.jdv_state$transport)) {
      .Call(C_jdv_transport_poll)
      .jdv_assert_active()
    }
    # Tracked bindings are checked here too, so an embedding host that runs
    # its own task callback can take the updates right after this call.
    .jdv_track_poll()
    .jdv_assert_active()
    return(invisible(NULL))
  }
  parsed <- tryCatch(.jdv_json_parse(request), error = function(e) e)
  .jdv_assert_active()
  if (inherits(parsed, "error")) {
    return(.jdv_json_encode_error(.jdv_response(NULL, error = parsed)))
  }
  request_id <- NULL
  if (is.list(parsed) && "id" %in% names(parsed)) {
    request_id <- tryCatch(.jdv_request_id(parsed$id), error = function(e) e)
    if (inherits(request_id, "error")) {
      return(.jdv_json_encode_error(.jdv_response(NULL, error = request_id)))
    }
  }
  if (.jdv_state$rpc_depth > 0L) {
    return(.jdv_json_encode_error(.jdv_response(
      request_id,
      error = structure(
        list(
          message = "RPC re-entry is not supported.",
          call = NULL,
          code = "producer_error"
        ),
        class = c("jdv_rpc_error", "error", "condition")
      )
    )))
  }
  .jdv_state$rpc_depth <- .jdv_state$rpc_depth + 1L
  on.exit(.jdv_state$rpc_depth <- .jdv_state$rpc_depth - 1L, add = TRUE)
  warnings <- character()
  warning_count <- 0L
  record_warning <- function(warning) {
    warning_count <<- warning_count + 1L
    if (length(warnings) < 100L) {
      warnings <<- c(warnings, substr(conditionMessage(warning), 1L, 512L))
    }
    invokeRestart("muffleWarning")
  }
  result <- tryCatch(
    withCallingHandlers(
      {
        if (!allow_binary && identical(parsed$method, "stream/next")) {
          query_error(
            "unsupported",
            "stream/next requires the viewer binary transport."
          )
        }
        .jdv_process_request(parsed, request_id)
      },
      warning = record_warning
    ),
    interrupt = function(e) {
      structure(
        list(
          message = "Request interrupted.",
          call = NULL,
          code = "interrupted"
        ),
        class = c("jdv_rpc_error", "error", "condition")
      )
    },
    error = function(e) e
  )
  .jdv_assert_active()
  if (is.null(request_id)) {
    return(NULL)
  }
  work_budget <- if (is.list(result)) attr(result, "jdv_work_budget") else NULL
  child_id <- if (is.list(result)) attr(result, "jdv_child_id") else NULL
  child_open <- if (is.list(result)) attr(result, "jdv_child_open") else NULL
  if (is.list(result)) {
    attr(result, "jdv_work_budget") <- NULL
    attr(result, "jdv_child_id") <- NULL
    attr(result, "jdv_child_open") <- NULL
  }
  if (inherits(result, "jdv_binary_result")) {
    result <- tryCatch(
      {
        if (!allow_binary) {
          query_error(
            "unsupported",
            "Binary results require the viewer transport."
          )
        }
        binary_warnings <- if (warning_count > length(warnings)) {
          c(warnings, "Additional warnings were omitted.")
        } else {
          warnings
        }
        .jdv_binary_packet(result, parsed, request_id, binary_warnings)
      },
      error = identity
    )
    if (inherits(result, "jdv_binary_packet")) return(result)
  } else if (
    is.list(result) &&
      !inherits(result, "error") &&
      "transfer" %in% names(result)
  ) {
    result <- structure(
      list(
        message = "The transfer field requires a binary payload.",
        call = NULL,
        code = "invalid_request"
      ),
      class = c("jdv_rpc_error", "error", "condition")
    )
  }
  response <- if (inherits(result, "error")) {
    if (!inherits(result, "jdv_query_error")) {
      code <- if (!is.null(result$code)) result$code else "producer_error"
      if (inherits(result, "jdv_error") && !code %in% .jdv_protocol_codes) {
        code <- "producer_error"
      }
      result <- structure(
        list(message = conditionMessage(result), call = NULL, code = code),
        class = c("jdv_rpc_error", "error", "condition")
      )
    }
    .jdv_response(request_id, error = result, warnings = warnings)
  } else {
    if (is.null(result)) {
      return(NULL)
    }
    .jdv_response(request_id, result = result, warnings = warnings)
  }
  if (warning_count > length(warnings)) {
    response$warnings <- .jdv_json_values(c(
      warnings,
      "Additional warnings were omitted."
    ))
  }
  encode_response <- function(value) {
    tryCatch(
      .jdv_json_encode(
        value,
        work_limit = if (is.environment(work_budget)) {
          .jdv_budget_remaining(work_budget)
        } else {
          if (inherits(result, "error")) {
            64 * 1024
          } else {
            .jdv_page_work_bytes()
          }
        }
      ),
      error = function(e) e
    )
  }
  encoded <- encode_response(response)
  if (
    inherits(encoded, "jdv_query_error") &&
      encoded$code == "limit_exceeded" &&
      !inherits(result, "error") &&
      identical(parsed$method, "grid/rows") &&
      is.list(result) &&
      is.list(result$data) &&
      !is.null(result$data$source_row)
  ) {
    page_limit <- query_integer(result$limit, "limit")
    while (page_limit > 1) {
      page_limit <- max(1, floor(page_limit / 2))
      response <- .jdv_response(
        request_id,
        result = .jdv_trim_page(result, page_limit),
        warnings = warnings
      )
      if (warning_count > length(warnings)) {
        response$warnings <- .jdv_json_values(c(
          warnings,
          "Additional warnings were omitted."
        ))
      }
      encoded <- encode_response(response)
      if (!inherits(encoded, "error")) {
        return(encoded)
      }
      if (
        !inherits(encoded, "jdv_query_error") ||
          encoded$code != "limit_exceeded"
      ) {
        break
      }
    }
  }
  if (
    inherits(encoded, "jdv_query_error") &&
      encoded$code == "limit_exceeded" &&
      !inherits(result, "error") &&
      identical(parsed$method, "resources/children") &&
      is.list(result) &&
      length(result$children) > 1L
  ) {
    # A short page is allowed: next_offset says where the listing continues.
    count <- length(result$children)
    while (count > 1L) {
      count <- max(1L, count %/% 2L)
      response <- .jdv_response(
        request_id,
        result = .jdv_resources_trim_page(result, count),
        warnings = warnings
      )
      if (warning_count > length(warnings)) {
        response$warnings <- .jdv_json_values(c(
          warnings,
          "Additional warnings were omitted."
        ))
      }
      encoded <- encode_response(response)
      if (!inherits(encoded, "error")) {
        break
      }
      if (
        !inherits(encoded, "jdv_query_error") ||
          encoded$code != "limit_exceeded"
      ) {
        break
      }
    }
  }
  if (!inherits(encoded, "error")) {
    if (!is.null(child_open)) {
      .jdv_notify(child_open)
    }
    return(encoded)
  }
  limit_failure <- inherits(encoded, "jdv_query_error") &&
    identical(encoded$code, "limit_exceeded")
  fallback_code <- if (limit_failure && !inherits(result, "error")) {
    "limit_exceeded"
  } else if (
    inherits(result, "error") &&
      is.character(result$code) &&
      length(result$code) == 1L &&
      grepl("^[a-z][a-z0-9_]{0,63}$", result$code)
  ) {
    result$code
  } else {
    "producer_error"
  }
  fallback_message <- if (identical(fallback_code, "limit_exceeded")) {
    "Response exceeds the byte limit."
  } else {
    "Response could not be encoded."
  }
  fallback <- .jdv_response(
    request_id,
    error = structure(
      list(message = fallback_message, code = fallback_code),
      class = c("jdv_rpc_error", "error", "condition")
    )
  )
  if (!is.null(child_id)) {
    .jdv_close_internal(child_id, notify = FALSE)
  }
  .jdv_json_encode_error(fallback)
}
