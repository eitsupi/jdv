.jdv_cache_dir <- function() {
  if (identical(.Platform$OS.type, "windows")) {
    root <- Sys.getenv("LOCALAPPDATA", unset = "")
    if (!nzchar(root)) {
      root <- file.path(path.expand("~"), "AppData", "Local")
    }
    return(file.path(root, "jdv"))
  }
  if (identical(Sys.info()[["sysname"]], "Darwin")) {
    return(file.path(path.expand("~"), "Library", "Caches", "jdv"))
  }
  root <- Sys.getenv("XDG_CACHE_HOME", unset = "")
  if (nzchar(root)) {
    return(file.path(root, "jdv"))
  }
  file.path(path.expand("~"), ".cache", "jdv")
}

.jdv_discovery_path <- function() {
  path <- getOption("jdv.discovery_path")
  if (is.null(path)) {
    path <- file.path(.jdv_cache_dir(), "discovery.json")
  }
  if (
    !is.character(path) || length(path) != 1L || is.na(path) || !nzchar(path)
  ) {
    jdv_abort(
      "invalid_argument",
      "Option 'jdv.discovery_path' must be one non-empty path."
    )
  }
  path
}

.jdv_resolve_address <- function() {
  address <- getOption("jdv.address")
  if (!is.null(address)) {
    if (
      !is.character(address) ||
        length(address) != 1L ||
        is.na(address) ||
        !nzchar(address)
    ) {
      jdv_abort(
        "invalid_argument",
        "Option 'jdv.address' must be one non-empty address."
      )
    }
    return(address)
  }
  address <- Sys.getenv("JDV_ADDRESS", unset = "")
  if (nzchar(address)) {
    return(address)
  }

  path <- .jdv_discovery_path()
  info <- file.info(path)
  if (is.na(info$size) || isTRUE(info$isdir) || info$size > 65536) {
    jdv_abort(
      "connect_failed",
      "The viewer discovery file is missing or exceeds 64 KiB."
    )
  }
  bytes <- readBin(path, what = "raw", n = 65536L)
  discovery <- tryCatch(
    .jdv_json_parse(rawToChar(bytes)),
    error = function(error) jdv_abort("connect_failed", conditionMessage(error))
  )
  address <- discovery$socketPath
  if (
    !is.character(address) ||
      length(address) != 1L ||
      is.na(address) ||
      !nzchar(address)
  ) {
    jdv_abort(
      "connect_failed",
      "The viewer discovery file has no valid socketPath."
    )
  }
  address
}

.jdv_transport_limits <- function() {
  list(
    queue_messages = as.integer(.jdv_option_limit(
      "jdv.transport.queue_messages",
      256,
      1
    )),
    queue_bytes = as.integer(.jdv_option_limit(
      "jdv.transport.queue_bytes",
      16 * 1024^2,
      1024
    )),
    max_request_bytes = as.integer(.jdv_max_request_bytes()),
    max_message_bytes = as.integer(.jdv_max_message_bytes()),
    max_receive_bytes = as.integer(min(
      .Machine$integer.max,
      max(64 * 1024, .jdv_max_request_bytes() + 1)
    )),
    max_drain_requests = as.integer(.jdv_option_limit(
      "jdv.transport.max_drain_requests",
      8,
      1
    )),
    send_timeout_ms = as.integer(.jdv_option_limit(
      "jdv.transport.send_timeout_ms",
      1000,
      1
    ))
  )
}

.jdv_transport_status <- function() {
  if (isTRUE(.jdv_state$unloading) || is.null(.jdv_state$transport)) {
    return(NULL)
  }
  status <- .Call(C_jdv_transport_status)
  .jdv_assert_active()
  status
}

.jdv_transport_remove_task_callback <- function(
  name = .jdv_state$transport_task_callback
) {
  if (is.null(name)) {
    return(invisible(NULL))
  }
  try(removeTaskCallback(name), silent = TRUE)
  if (identical(.jdv_state$transport_task_callback, name)) {
    .jdv_state$transport_task_callback <- NULL
  }
  invisible(NULL)
}

.jdv_transport_task_callback <- function(expr, value, ok, visible) {
  if (isTRUE(.jdv_state$unloading)) {
    return(FALSE)
  }
  if (is.null(.jdv_state$transport)) {
    .jdv_transport_remove_task_callback()
    return(FALSE)
  }
  try(.Call(C_jdv_transport_cleanup), silent = TRUE)
  if (is.null(.jdv_state$transport)) {
    .jdv_transport_remove_task_callback()
    return(FALSE)
  }
  TRUE
}

.jdv_transport_install_task_callback <- function(epoch) {
  .jdv_assert_active()
  if (!is.null(.jdv_state$transport_task_callback)) {
    return(invisible(NULL))
  }
  name <- paste0("jdv_transport_", Sys.getpid(), "_", epoch)
  addTaskCallback(.jdv_transport_task_callback, name = name)
  if (isTRUE(.jdv_state$unloading)) {
    try(removeTaskCallback(name), silent = TRUE)
    .jdv_assert_active()
  }
  .jdv_state$transport_task_callback <- name
  invisible(NULL)
}

.jdv_transport_disconnect <- function(epoch) {
  if (!identical(.jdv_state$transport_epoch, epoch)) {
    return(invisible(NULL))
  }
  .jdv_close_internal(notify = FALSE)
  .jdv_queue_reset()
  .jdv_state$transport <- NULL
  .jdv_state$transport_limits <- NULL
  .jdv_state$transport_hello <- FALSE
  .jdv_state$transport_persistent <- FALSE
  .jdv_state$transport_address <- NULL
  # A close nobody requested here is the peer ending the session.
  .jdv_state$last_disconnect_reason <- .jdv_state$transport_close_reason %||%
    "peer_closed"
  .jdv_state$transport_close_reason <- NULL
  .jdv_transport_remove_task_callback()
  invisible(NULL)
}

# Close the native connection and remember why. The first reason wins so the
# disconnect callback reports the original cause. With `after_response`, a
# running request callback still sends its response before the close.
.jdv_transport_close <- function(reason, after_response = FALSE) {
  if (is.null(.jdv_state$transport_close_reason)) {
    .jdv_state$transport_close_reason <- reason
  }
  if (after_response) {
    .Call(C_jdv_transport_close_after_response)
  } else {
    .Call(C_jdv_transport_close)
  }
}

.jdv_connection_state <- function() {
  status <- .jdv_transport_status()
  state <- if (is.null(status)) {
    "disconnected"
  } else if (isTRUE(status$connected) && !isTRUE(status$pending_cleanup)) {
    "connected"
  } else {
    "closing"
  }
  owner <- .jdv_session_owner()
  if (identical(owner, "embedded")) {
    state <- "embedded"
  }
  live <- state %in% c("connected", "closing")
  list(
    state = state,
    connected = identical(state, "connected"),
    owner = owner,
    persistent = live && isTRUE(.jdv_state$transport_persistent),
    address = if (identical(state, "connected")) {
      .jdv_state$transport_address
    },
    last_disconnect_reason = .jdv_state$last_disconnect_reason
  )
}

.jdv_transport_request <- function(message, epoch) {
  had_entries <- length(ls(.jdv_state$entries, all.names = TRUE)) > 0L
  response <- .jdv_transport_request_body(message, epoch)
  if (
    identical(.jdv_state$transport_epoch, epoch) &&
      !isTRUE(.jdv_state$unloading) &&
      !is.null(.jdv_state$transport) &&
      length(.jdv_state$queue)
  ) {
    notifications <- .jdv_queue_take()
    # The native callback accepts one response; send lifecycle JSONL first.
    failed <- function(error) {
      if (identical(.jdv_state$transport_epoch, epoch)) {
        try(.jdv_transport_close("send_failed"), silent = TRUE)
      }
      stop(error)
    }
    tryCatch(
      .jdv_transport_send(notifications),
      error = failed,
      interrupt = failed
    )
  }
  if (
    had_entries &&
      identical(.jdv_state$transport_epoch, epoch) &&
      !isTRUE(.jdv_state$unloading) &&
      !is.null(.jdv_state$transport) &&
      !isTRUE(.jdv_state$transport_persistent) &&
      !length(ls(.jdv_state$entries, all.names = TRUE))
  ) {
    # Only schedule the close here; the native layer sends this response first.
    .jdv_transport_close("last_view_closed", after_response = TRUE)
  }
  response
}

.jdv_transport_request_body <- function(message, epoch) {
  if (isTRUE(.jdv_state$unloading)) {
    return(NULL)
  }
  request <- tryCatch(.jdv_json_parse(message), error = function(e) e)
  if (inherits(request, "error") || !is.list(request)) {
    return(jdv_rpc(message))
  }
  request_id <- tryCatch(.jdv_request_id(request$id), error = function(e) NULL)
  if (is.null(request_id)) {
    return(jdv_rpc(message))
  }

  transport_error <- function(code, message) {
    error <- structure(
      list(message = message, call = NULL, code = code),
      class = c("jdv_rpc_error", "error", "condition")
    )
    .jdv_json_encode_error(.jdv_response(request_id, error = error))
  }
  if (!identical(.jdv_state$transport_epoch, epoch)) {
    return(transport_error("stale_generation", "The connection is stale."))
  }

  deadline <- request$deadline
  if (
    is.numeric(deadline) &&
      length(deadline) == 1L &&
      !is.na(deadline) &&
      is.finite(deadline) &&
      deadline < as.numeric(Sys.time())
  ) {
    return(transport_error("expired", "The request expired before execution."))
  }

  method <- request$method
  if (
    is.character(method) &&
      length(method) == 1L &&
      method %in% c("grid/rows", "view/schema", "view/close", "stream/next")
  ) {
    params <- request$params
    if (
      is.list(params) &&
        is.character(params$view) &&
        length(params$view) == 1L &&
        !is.na(params$view) &&
        is.numeric(params$generation) &&
        !is.object(params$generation) &&
        length(params$generation) == 1L &&
        !is.na(params$generation) &&
        is.finite(params$generation) &&
        params$generation >= 1 &&
        params$generation == floor(params$generation)
    ) {
      id <- params$view
      if (!exists(id, envir = .jdv_state$entries, inherits = FALSE)) {
        return(transport_error("view_not_found", "The view is not open."))
      }
      entry <- get(id, envir = .jdv_state$entries, inherits = FALSE)
      if (entry$closed) {
        return(transport_error("view_not_found", "The view is closed."))
      }
      if (
        !identical(as.numeric(entry$generation), as.numeric(params$generation))
      ) {
        return(transport_error(
          "stale_generation",
          "The table generation is stale."
        ))
      }
    }
  }

  tryCatch(
    .jdv_rpc_internal(message, allow_binary = TRUE),
    error = function(error) {
      if (isTRUE(.jdv_state$unloading)) {
        return(NULL)
      }
      request_id <- tryCatch(
        .jdv_request_id(request$id),
        error = function(e) NULL
      )
      if (is.null(request_id)) {
        return(NULL)
      }
      .jdv_json_encode_error(.jdv_response(request_id, error = error))
    }
  )
}

.jdv_transport_connect <- function(address = NULL) {
  .jdv_assert_active()
  .jdv_transport_housekeeping()
  .jdv_assert_active()
  .jdv_assert_not_embedded()
  status <- .jdv_transport_status()
  if (!is.null(status) && isTRUE(status$connected)) {
    return(invisible(NULL))
  }
  if (!is.null(status) && isTRUE(status$pending_cleanup)) {
    jdv_abort(
      "in_use",
      "The previous viewer connection is still being cleaned up."
    )
  }
  if (!is.null(.jdv_state$transport)) {
    .jdv_transport_disconnect(.jdv_state$transport_epoch)
  }
  if (is.null(address)) {
    address <- .jdv_resolve_address()
  }

  .jdv_state$transport_epoch <- .jdv_state$transport_epoch + 1L
  epoch <- .jdv_state$transport_epoch
  request_callback <- local({
    callback_epoch <- epoch
    function(message) .jdv_transport_request(message, callback_epoch)
  })
  disconnect_callback <- local({
    callback_epoch <- epoch
    function() .jdv_transport_disconnect(callback_epoch)
  })
  .jdv_assert_active()
  tryCatch(
    .Call(
      C_jdv_transport_connect,
      address,
      request_callback,
      disconnect_callback,
      .jdv_transport_limits()
    ),
    error = function(error) {
      if (inherits(error, "jdv_error")) {
        stop(error)
      }
      jdv_abort("connect_failed", conditionMessage(error))
    }
  )
  .jdv_assert_active()
  status <- .Call(C_jdv_transport_status)
  .jdv_assert_active()
  if (!isTRUE(status$connected)) {
    .jdv_transport_disconnect(epoch)
    jdv_abort(
      "connect_failed",
      "The viewer transport disconnected during setup."
    )
  }
  # A new connection must not inherit notifications from an earlier session.
  .jdv_queue_reset(.jdv_notification_limits())
  .jdv_state$transport_limits <- list(
    max_unacked_frames = status$max_receive_frames,
    max_unacked_bytes = status$max_receive_bytes,
    queue_messages = status$queue_messages_limit,
    queue_bytes = status$queue_bytes_limit,
    max_request_bytes = status$max_request_bytes,
    max_message_bytes = .jdv_max_message_bytes()
  )
  .jdv_state$transport <- TRUE
  .jdv_state$transport_hello <- FALSE
  .jdv_state$transport_persistent <- FALSE
  .jdv_state$transport_address <- address
  .jdv_state$transport_close_reason <- NULL
  .jdv_transport_install_task_callback(epoch)
  invisible(NULL)
}

.jdv_transport_housekeeping <- function() {
  if (
    !isTRUE(.jdv_state$unloading) &&
      !is.null(.jdv_state$transport_task_callback)
  ) {
    .Call(C_jdv_transport_housekeeping)
  }
  invisible(NULL)
}

# The resource tree is enabled or disabled for the session when its hello is
# created; changing `jdv.resources` later does not change a running session.
.jdv_hello <- function(limits = .jdv_state$transport_limits) {
  .jdv_state$session_counter <- .jdv_state$session_counter + 1L
  .jdv_state$resources <- .jdv_resources_option()
  params <- list(
    protocol = 1L,
    session = paste0("r-", Sys.getpid(), "-", .jdv_state$session_counter),
    producer = list(
      name = "jdv",
      version = as.character(utils::packageVersion("jdv")),
      runtime = list(name = "R", version = as.character(getRversion()))
    ),
    wake = TRUE
  )
  if (.jdv_state$resources) {
    params$capabilities <- list(resources = TRUE)
  }
  params$limits <- limits
  list(method = "hello", params = params)
}

.jdv_transport_send <- function(messages) {
  .jdv_assert_active()
  if (!length(messages)) {
    return(invisible(NULL))
  }
  if (is.null(.jdv_state$transport)) {
    jdv_abort("not_connected", "The viewer transport is not connected.")
  }
  messages <- enc2utf8(as.character(messages))
  .jdv_assert_active()
  .Call(C_jdv_transport_send, messages)
  .jdv_assert_active()
  invisible(NULL)
}

# Send everything queued to the connected transport, closing it on failure.
.jdv_transport_flush <- function() {
  status <- .jdv_transport_status()
  if (is.null(status) || !isTRUE(status$connected)) {
    return(invisible(NULL))
  }
  messages <- .jdv_queue_take()
  if (!length(messages)) {
    return(invisible(NULL))
  }
  tryCatch(
    .jdv_transport_send(messages),
    error = function(error) {
      if (!isTRUE(.jdv_state$unloading)) {
        try(.jdv_transport_close("send_failed"), silent = TRUE)
        .jdv_transport_housekeeping()
      }
      stop(error)
    }
  )
  invisible(NULL)
}

#' Manage the local jdv viewer connection
#'
#' [jdv_connect()] opens the local viewer connection and sends `hello`
#' immediately, even when no view is open. Such an explicit connection is
#' persistent: it stays open, and keeps handling viewer requests, after the last
#' view is closed. [jdv_disconnect()] closes the connection and every view.
#' [jdv_connection()] reports the current state.
#'
#' @param address Optional viewer address. When omitted, the address is selected
#'   from `options(jdv.address = ...)`, then `JDV_ADDRESS`, then
#'   `discovery.json` under the user cache directory (see [jdv_view()]).
#' @return
#' A list describing the connection after the call. [jdv_connect()] and
#' [jdv_disconnect()] return it invisibly. The members are:
#'   * `state`: `"disconnected"`, `"embedded"` (an embedded notification session
#'     is active; see [jdv_notifications()]), `"connected"`, or `"closing"` (the
#'     connection is closed and its cleanup is still pending).
#'   * `connected`: `TRUE` only in the `"connected"` state.
#'   * `owner`: who receives notifications: `"none"`, `"embedded"` (the host
#'     calls [jdv_notifications()]), or `"transport"` (the built-in viewer
#'     connection).
#'   * `persistent`: `TRUE` for an explicit connection made or promoted by
#'     [jdv_connect()].
#'   * `address`: the connected address, or `NULL`.
#'   * `last_disconnect_reason`: a short string for the most recent disconnect,
#'     or `NULL` if there has been none. Values include `"disconnect"`
#'     ([jdv_disconnect()]), `"last_view_closed"`, `"peer_closed"`,
#'     `"send_failed"`, `"register_failed"`, `"notification_overflow"`, and
#'     `"unloaded"`.
#' @details
#' A connection opened implicitly by [jdv_view()] is closed after its last view
#' is closed. Calling [jdv_connect()] while such a connection is open promotes
#' it to a persistent connection without sending `hello` again. Calling
#' [jdv_connect()] again for the same address, or without an address while
#' connected, changes nothing. Asking for a different address while connected is
#' an error: call [jdv_disconnect()] first. A later [jdv_view()] uses the
#' existing connection and does not repeat `hello`.
#'
#' A peer disconnect, a failed send, or package unload ends the session. jdv
#' does not reconnect automatically, and views are not resent to a later
#' session. [jdv_disconnect()] is idempotent and also ends an embedded session,
#' releasing views registered with [jdv_register()] and discarding its queued
#' notifications. Ownership never moves implicitly: while an embedded session is
#' active, [jdv_connect()] and [jdv_view()] fail until [jdv_disconnect()] is
#' called. [jdv_connection()] has no side effects: it neither connects nor
#' polls.
#'
#' Errors raised on purpose, such as an unreachable address or an address that
#' conflicts with the current connection, carry condition classes that name the
#' reason; see [jdv_errors].
#' @export
jdv_connect <- function(address = NULL) {
  .jdv_assert_active()
  if (
    !is.null(address) &&
      (!is.character(address) ||
        length(address) != 1L ||
        is.na(address) ||
        !nzchar(address))
  ) {
    jdv_abort(
      "invalid_argument",
      "'address' must be NULL or one non-empty address."
    )
  }
  .jdv_transport_housekeeping()
  .jdv_assert_active()
  .jdv_assert_not_embedded()
  status <- .jdv_transport_status()
  if (!is.null(status) && isTRUE(status$pending_cleanup)) {
    jdv_abort(
      "in_use",
      "The previous viewer connection is still being cleaned up."
    )
  }
  if (!is.null(status) && isTRUE(status$connected)) {
    current <- .jdv_state$transport_address
    if (!is.null(address) && !identical(address, current)) {
      jdv_abort(
        "in_use",
        paste0(
          "Already connected to a different address; ",
          "call jdv_disconnect() before connecting to another one."
        )
      )
    }
    .jdv_state$transport_persistent <- TRUE
    return(invisible(.jdv_connection_state()))
  }
  if (is.null(address)) {
    address <- .jdv_resolve_address()
  }
  .jdv_transport_connect(address)
  .jdv_assert_active()
  .jdv_state$transport_persistent <- TRUE
  .jdv_notify(.jdv_json_encode(.jdv_hello()))
  .jdv_transport_flush()
  .jdv_state$transport_hello <- TRUE
  invisible(.jdv_connection_state())
}

#' @rdname jdv_connect
#' @export
jdv_disconnect <- function() {
  .jdv_assert_active()
  .jdv_transport_housekeeping()
  .jdv_assert_active()
  status <- .jdv_transport_status()
  if (!is.null(status) && isTRUE(status$connected)) {
    .jdv_transport_close("disconnect")
  }
  .jdv_assert_active()
  # Release the registry now even if the native cleanup callback is deferred.
  .jdv_close_internal(notify = FALSE)
  .jdv_queue_reset()
  if (isTRUE(.jdv_state$embedded) && is.null(.jdv_state$transport)) {
    .jdv_state$embedded <- FALSE
    .jdv_state$last_disconnect_reason <- "disconnect"
  }
  invisible(.jdv_connection_state())
}

#' @rdname jdv_connect
#' @export
jdv_connection <- function() {
  .jdv_assert_active()
  .jdv_connection_state()
}

#' Take pending notifications for an embedding host
#'
#' An embedding host that drives [jdv_rpc()] itself owns the notification queue
#' of an embedded session. The session starts with the first [jdv_register()]
#' call made while no viewer connection exists, and queues `hello` before the
#' first `view/open`. [jdv_notifications()] removes and returns everything
#' queued so far, in the order the messages were produced. The session, and its
#' queue, outlive the last view so that the final `view/closed` messages can be
#' taken; [jdv_disconnect()] ends it.
#'
#' @return
#' A character vector of JSON notification messages in FIFO order, one message
#' per element and without a trailing newline. It is `character()` when nothing
#' is queued, no session has been started, or the session has ended; the call
#' never starts a session. Taking the messages hands delivery to the caller; the
#' call is not an acknowledgement. It is an error when the built-in viewer
#' connection owns the notifications, which are then sent by the transport.
#' @details
#' Every notification source uses the same queue: registration, closing,
#' eviction when `jdv.max_tables` is reached, closing of child views together
#' with their parent, and the `view/open` of a child created by `object/open`.
#' Deliver the messages before the response of a request handled by [jdv_rpc()]
#' in the same turn. A queue that outgrows `jdv.notification_max_messages`
#' (default `max(256, 4 * jdv.max_tables)`) or `jdv.notification_max_bytes`
#' (default `4 * jdv.max_message_bytes`), both read when the session starts,
#' ends the session instead of discarding messages: every view is closed, the
#' queue is dropped, `last_disconnect_reason` of [jdv_connection()] becomes
#' `"notification_overflow"`, and the operation that overflowed it fails.
#' @examples
#' library(jdv)
#' id <- jdv_register(mtcars)$id
#' notifications <- jdv_notifications()
#' length(notifications)
#' response <- jdv_rpc(sprintf(
#'   '{"id":1,"method":"view/close","params":{"view":"%s","generation":1}}',
#'   id
#' ))
#' jdv_notifications()
#' jdv_disconnect()
#' @export
jdv_notifications <- function() {
  .jdv_assert_active()
  if (identical(.jdv_session_owner(), "transport")) {
    jdv_abort(
      "in_use",
      paste0(
        "The viewer connection owns the notifications; ",
        "jdv_notifications() is only for an embedded session."
      )
    )
  }
  if (!isTRUE(.jdv_state$embedded)) {
    return(character())
  }
  messages <- if (length(.jdv_state$queue)) {
    as.character(unlist(.jdv_state$queue, use.names = FALSE))
  } else {
    character()
  }
  .jdv_queue_reset()
  messages
}

#' Open an object in the local jdv viewer
#'
#' @param x A data frame or matrix for grid views; an Arrow Table or
#'   RecordBatchReader, nanoarrow array stream, or Polars DataFrame for a
#'   sequential grid; or an R object to explore in a tree view.
#' @param title Display title. When omitted, the expression passed as `x` is
#'   used; explicitly passing `NULL` creates an independent table slot.
#' @param mode Grid view mode: `"auto"`, `"snapshot"`, or `"paged"`.
#' @param collation Grid string ordering policy, `"C"` or `"locale"`. When
#'   `NULL` (the default), `getOption("jdv.collation", "C")` supplies the
#'   default. A non-`NULL` value is kept as the view's refresh intent.
#' @param track Whether to follow the variable passed as `x`; see Details. To
#'   follow a variable on behalf of a caller, see [jdv_binding()].
#' @return The view id, invisibly.
#' @details
#' In a grid view, every column is displayed, but only some columns can be
#' filtered by value (for example logical, numeric, character, factor, date,
#' date-time, duration, and integer64 columns). Others, such as list columns and
#' columns of unsupported classes, can only be tested for missing values. See
#' the R column mapping section of [jdv_query_spec] for which columns are
#' supported by the current release.
#'
#' The viewer connection is opened on the first call unless [jdv_connect()]
#' already opened one; in that case the existing connection is used and `hello`
#' is not sent again. An address can be set in `options(jdv.address = ...)` or
#' `JDV_ADDRESS`; otherwise jdv reads `discovery.json` from the user cache
#' directory. The discovery file is limited to 64 KiB and contains a
#' `socketPath` string. Local Unix-domain sockets and Windows named pipes are
#' used by default; TCP is available only when an explicit address selects it. A
#' connection opened implicitly by this function is closed after the last table
#' is closed; a persistent connection from [jdv_connect()] stays open until
#' [jdv_disconnect()].
#'
#' The event gate dispatches only when `sys.nframe() == 0`. This practical
#' function-frame check is not a guarantee that R is idle: on Windows, a timer
#' can run during top-level computation while the function-frame count is zero.
#' A request that reaches an interrupt while running fails with `interrupted`
#' and is never retried automatically. While a sort or filter runs, the event
#' gate restores the interrupt-suspension state it found before calling R
#' methods. If interrupts were already suspended on entry, R may defer Ctrl-C
#' during a long sort or filter until a later check; use the viewer's busy state
#' as an indication that the request is still running. A bare top-level
#' [base::browser()] can service requests; a frontend waiting inside a function
#' frame, such as a function that calls [base::browser()], must let that frame
#' unwind or explicitly call `jdv_rpc(NULL)` before queued work can progress. A
#' script that waits in a loop never returns to top level, so it must poll with
#' `jdv_rpc(NULL)`; see [jdv_rpc()]. Windows GUI and Esc behavior have not been
#' validated. Windows named pipes must use byte-type mode; message-type pipes
#' are unsupported. The named-pipe transport, including binary Arrow pages and
#' requests serviced while an interactive session is idle, is tested on Windows
#' through Rscript and the arf console; Rgui and Rterm are not tested.
#' Named-pipe ACLs are not hardened, and an explicitly selected TCP endpoint has
#' no authentication. Registry entries created with [jdv_register()] share this
#' process-wide registry and are also released if the viewer disconnects.
#' Package unload stops the event source and pending work before releasing table
#' references.
#'
#' **Tracking.** With `track = TRUE` (the default), a call whose argument is a
#' single variable name, such as `jdv_view(df)`, follows that variable. After
#' each top-level R task jdv looks at the variable, and when it holds a
#' different object (for example after `df <- transform(df, ...)`) every changed
#' view is rebuilt as its next generation and the viewer updates by itself.
#' Expressions such as `jdv_view(head(df))` are never re-evaluated and are not
#' tracked; pass `track = FALSE` for a fixed view. The variable is looked up
#' once, without evaluating anything, in the calling environment and then
#' outward, and the view stays bound to the environment where the name was
#' found: a later variable of the same name in an inner scope is ignored, and
#' inside `f <- function(x) jdv_view(x)` the argument `x` of `f` is followed.
#'
#' Detection compares object identity. An object that is modified in place, such
#' as an environment, a reference class or R6 object, or a `data.table` changed
#' with `:=`, keeps its identity and is not noticed; use the viewer's refresh.
#' Assigning the same object again does nothing. Promise and active bindings are
#' never evaluated by the check: they are skipped and looked at again after
#' later tasks. When the variable is removed or its environment is garbage
#' collected, tracking ends and the last view stays; the view can then no longer
#' be refreshed, and re-running [jdv_view()] tracks again. The environment is
#' only weakly referenced, but a displayed object that refers to it, for example
#' a closure, keeps it alive. Views opened from a view, and sequential sources,
#' are not tracked. If an update fails (for example the new object exceeds a
#' limit) the previous view stays and one `view/update_failed` notification is
#' sent; the same object is not retried until the variable changes or the view
#' is refreshed manually. The viewer host can stop and resume following a view
#' with the `view/track` request (see [jdv_spec]).
#'
#' Tracking needs R 4.6.0 or later. Where it is not possible, including when the
#' variable cannot be read safely, the view is still shown and a warning says it
#' is not followed. A manual `view/refresh` request rebuilds from the current
#' value of a tracked variable. Tracking is carried out by an R task callback
#' that exists only while a tracked view does and is independent of the viewer
#' connection. An embedding host that takes notifications with
#' [jdv_notifications()] should call `jdv_rpc(NULL)` and then
#' [jdv_notifications()] from its own task callback, because a callback that
#' runs before the one of jdv would otherwise see updates only after the next
#' command; see [jdv_rpc()].
#' @export
jdv_view <- function(
  x,
  title = NULL,
  mode = c("auto", "snapshot", "paged"),
  collation = NULL,
  track = TRUE
) {
  .jdv_assert_active()
  expr <- substitute(x)
  if (missing(title)) {
    title <- deparse1(expr)
  }
  if (!is.logical(track) || length(track) != 1L || is.na(track)) {
    jdv_abort("invalid_argument", "'track' must be TRUE or FALSE.")
  }
  # Find the binding before x is evaluated, and without evaluating anything.
  untracked <- NULL
  found <- NULL
  if (track && is.symbol(expr)) {
    found <- .jdv_binding_lookup(as.character(expr), parent.frame())
    if (is.character(found)) {
      # Older R cannot track at all, so say so once per session rather than on
      # every call.
      if (identical(found, .jdv_track_version_reason)) {
        if (!isTRUE(.jdv_state$track_version_warned)) {
          .jdv_state$track_version_warned <- TRUE
          untracked <- found
        }
      } else {
        untracked <- found
      }
      found <- NULL
    }
  }
  mode <- .jdv_match_arg(mode, c("auto", "snapshot", "paged"), "'mode'")
  if (!is.null(collation)) {
    collation <- .jdv_match_arg(collation, c("C", "locale"), "'collation'")
  }
  original <- x
  source <- jdv_source(x)
  x <- source$data
  .jdv_transport_housekeeping()
  .jdv_assert_active()
  .jdv_assert_not_embedded()
  status <- .jdv_transport_status()
  if (!is.null(status) && isTRUE(status$pending_cleanup)) {
    jdv_abort(
      "in_use",
      "The previous viewer connection is still being cleaned up."
    )
  }
  if (!is.null(status) && isTRUE(status$busy)) {
    jdv_abort("in_use", "Cannot open a table while a viewer request is active.")
  }
  if (!is.null(status) && !isTRUE(status$connected)) {
    .jdv_transport_disconnect(.jdv_state$transport_epoch)
  }
  was_connected <- !is.null(status) && isTRUE(status$connected)
  had_entries <- length(ls(.jdv_state$entries, all.names = TRUE)) > 0L
  .jdv_transport_connect()
  .jdv_assert_active()
  if (!isTRUE(.jdv_state$transport_hello)) {
    .jdv_notify(.jdv_json_encode(.jdv_hello()))
  }
  prepared <- NULL
  if (!is.null(found) && !identical(source$access, "sequential")) {
    prepared <- .jdv_track_prepare(found$env, found$name, original)
    if (is.character(prepared)) {
      untracked <- prepared
      prepared <- NULL
    }
  }
  registered <- tryCatch(
    .jdv_register_internal(
      x,
      title,
      mode,
      collation,
      tracking = if (!is.null(prepared)) {
        .jdv_tracking_json(prepared$name, "active")
      }
    ),
    error = function(error) {
      if (!isTRUE(.jdv_state$unloading) && !was_connected && !had_entries) {
        try(.jdv_transport_close("register_failed"), silent = TRUE)
        .jdv_transport_housekeeping()
      }
      stop(error)
    }
  )
  .jdv_assert_active()
  messages <- .jdv_queue_take()
  registered_entry <- get(
    registered$id,
    envir = .jdv_state$entries,
    inherits = FALSE
  )
  .jdv_assert_active()
  if (!is.null(prepared)) {
    # The baseline is the object the view was built from, so a binding that
    # changed meanwhile is picked up by the next poll.
    .jdv_track_attach(registered_entry, prepared$ref, prepared$name, original)
  }
  tryCatch(
    .jdv_transport_send(messages),
    error = function(error) {
      .jdv_close_internal(
        registered$id,
        notify = FALSE,
        expected = registered_entry
      )
      if (!isTRUE(.jdv_state$unloading)) {
        try(.jdv_transport_close("send_failed"), silent = TRUE)
        .jdv_transport_housekeeping()
      }
      stop(error)
    }
  )
  .jdv_state$transport_hello <- TRUE
  if (!is.null(untracked)) {
    warning(
      "'",
      deparse1(expr),
      "' is shown but not tracked: ",
      untracked,
      ".",
      call. = FALSE
    )
  }
  invisible(registered$id)
}

#' Close one or all views in the local jdv viewer
#'
#' @param id Optional view id returned by [jdv_view()]. When omitted, all active
#'   views are closed.
#' @return The ids that were closed, invisibly.
#' @details
#' Closing the last table of a connection opened implicitly by [jdv_view()]
#' stops the transport event source and closes the local connection, after the
#' `view/closed` notification (and, for a viewer request, its response) has been
#' sent. A persistent connection from [jdv_connect()] stays open. A close
#' requested from inside a viewer callback is safe; native source cleanup is
#' deferred until the callback returns. In an embedded session (see
#' [jdv_notifications()]) the `view/closed` messages are queued for the host and
#' the session stays open.
#' @export
jdv_close <- function(id = NULL) {
  .jdv_assert_active()
  .jdv_transport_housekeeping()
  .jdv_assert_active()
  if (
    !is.null(id) &&
      (!is.character(id) || length(id) != 1L || is.na(id) || !nzchar(id))
  ) {
    jdv_abort("invalid_argument", "'id' must be NULL or one non-empty view id.")
  }
  ids <- if (is.null(id)) {
    ls(.jdv_state$entries, all.names = TRUE)
  } else if (exists(id, envir = .jdv_state$entries, inherits = FALSE)) {
    id
  } else {
    character()
  }
  if (!length(ids)) {
    if (
      is.null(id) &&
        !is.null(.jdv_state$transport) &&
        !isTRUE(.jdv_state$transport_persistent)
    ) {
      .jdv_assert_active()
      .jdv_transport_close("last_view_closed")
      .jdv_assert_active()
      .jdv_transport_housekeeping()
    }
    return(invisible(character()))
  }

  for (table_id in ids) {
    .jdv_close_internal(table_id, notify = TRUE)
  }
  .jdv_assert_active()
  status <- .jdv_transport_status()
  send_error <- NULL
  if (!is.null(status) && isTRUE(status$connected)) {
    notifications <- .jdv_queue_take()
    send_error <- tryCatch(
      {
        .jdv_transport_send(notifications)
        .jdv_assert_active()
        NULL
      },
      error = identity
    )
    if (!is.null(send_error)) {
      .jdv_assert_active()
      .jdv_transport_close("send_failed")
    } else if (
      !isTRUE(.jdv_state$transport_persistent) &&
        !length(ls(.jdv_state$entries, all.names = TRUE))
    ) {
      .jdv_assert_active()
      .jdv_transport_close("last_view_closed")
    }
  } else if (
    !is.null(.jdv_state$transport) &&
      !length(ls(.jdv_state$entries, all.names = TRUE))
  ) {
    .jdv_state$transport <- NULL
    .jdv_queue_reset()
  }
  if (inherits(send_error, "error")) {
    stop(send_error)
  }
  invisible(ids)
}
