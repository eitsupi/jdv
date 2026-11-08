# Binding tracking. A view shown from a plain variable can follow that variable:
# after each top-level task the binding is read without evaluating it, and a
# different object (SEXP identity) rebuilds the view through the update
# transaction. The environment is held weakly and the baseline object strongly,
# so identity is compared against a live object, never an address.

# Reading a binding safely needs R_GetBindingType(), which exists from R 4.6.
.jdv_track_supported <- function() getRversion() >= "4.6.0"

.jdv_track_same <- function(x, y) isTRUE(.Call(C_jdv_tree_same, x, y))

# The first environment from `env` outward that has a binding for `name`,
# found without evaluating any binding. NULL when there is none.
.jdv_binding_owner <- function(name, env) {
  while (!identical(env, emptyenv())) {
    status <- .Call(C_jdv_tree_child, env, "binding", NULL, name)$status
    if (!identical(status, "unbound")) {
      return(env)
    }
    env <- parent.env(env)
  }
  NULL
}

# Why a name cannot be tracked on this R, or NULL.
.jdv_track_version_reason <- "tracking requires R 4.6.0 or later"

# The shared lookup of jdv_view() and jdv_binding(): where the symbol `name`
# would be tracked from `env` outward, found without evaluating anything.
# Returns list(name, env) for the environment that holds the binding, or the
# reason as a string when there is nothing to track.
.jdv_binding_lookup <- function(name, env) {
  if (!.jdv_track_supported()) {
    return(.jdv_track_version_reason)
  }
  owner <- .jdv_binding_owner(name, env)
  if (is.null(owner)) {
    return("no variable with that name was found")
  }
  list(name = name, env = owner)
}

#' Find the binding behind a variable name
#'
#' [jdv_binding()] looks up a variable name without evaluating anything and
#' returns the value for the `binding` argument of [jdv_register()]. It is meant
#' for code that shows an object on behalf of a caller, such as a replacement
#' for `View()`, so that the view follows the caller's variable as [jdv_view()]
#' does. See the Details of [jdv_view()] for what tracking detects.
#'
#' @param name The name to look up: one string or a symbol, for example
#'   `substitute(x)`. An expression that is not a name, such as a call or a
#'   constant, cannot be tracked and gives `NULL`.
#' @param env The environment to start the search from. The search continues
#'   outward through its parents, and the first environment that has a binding
#'   for `name` is used, as [jdv_view()] does.
#' @return
#' A list `list(name = , env = )` that can be passed to the `binding` argument
#' of [jdv_register()] as it is, where `env` is the environment in which the
#' binding was found. It is `NULL`, without a warning, when the name cannot be
#' tracked: the expression is not a name, no environment from `env` outward has
#' the binding, the binding is a promise that has not been forced, an active
#' binding, or an empty argument, or R is older than 4.6.0.
#' @details
#' Nothing is evaluated: a promise is not forced and an active binding is not
#' called. To track an argument of the calling function, force it first, for
#' example by evaluating it before the call, or [jdv_binding()] returns `NULL`
#' for it.
#'
#' A non-`NULL` result means the binding can be read without evaluation.
#' [jdv_register()] additionally requires that the binding holds exactly the
#' object registered and that the object is not a sequential source; it fails
#' otherwise, so pass the binding only together with the object the variable
#' holds.
#'
#' A name that is not a single non-empty string or a symbol, or an `env` that is
#' not an environment, is an error with class `jdv_error_invalid_argument`; see
#' [jdv_errors].
#' @examples
#' df <- data.frame(a = 1:3)
#' binding <- jdv_binding("df")
#' identical(binding$env, globalenv())
#'
#' # A viewer hook that follows the variable its caller passed.
#' view <- function(x) {
#'   jdv_register(
#'     x,
#'     title = deparse1(substitute(x)),
#'     binding = jdv_binding(substitute(x), parent.frame())
#'   )
#' }
#' view(df)
#' jdv_disconnect()
#' @export
jdv_binding <- function(name, env = parent.frame()) {
  .jdv_assert_active()
  if (!is.environment(env)) {
    jdv_abort("invalid_argument", "'env' must be an environment.")
  }
  if (is.symbol(name)) {
    name <- as.character(name)
  } else if (is.character(name)) {
    if (length(name) != 1L || is.na(name) || !nzchar(name)) {
      jdv_abort(
        "invalid_argument",
        "'name' must be one non-empty string or a symbol."
      )
    }
  } else {
    return(NULL)
  }
  found <- .jdv_binding_lookup(name, env)
  if (is.character(found)) {
    return(NULL)
  }
  ref <- .Call(C_jdv_weakref_make, found$env)
  if (!.jdv_binding_readable(.jdv_binding_read(ref, name))) {
    return(NULL)
  }
  found
}

# Read the binding behind a weak environment reference. `status` is one of
# value, forced, delayed, active, missing, unbound, gone (environment
# collected), or opaque. Only value and forced carry an object.
.jdv_binding_read <- function(ref, name) .Call(C_jdv_binding_read, ref, name)

# Whether a binding read carries an object, so no evaluation is needed.
.jdv_binding_readable <- function(read) read$status %in% c("value", "forced")

# Validate the explicit `binding` argument of jdv_register().
.jdv_binding_spec <- function(binding) {
  if (
    !is.list(binding) ||
      is.object(binding) ||
      !identical(sort(names(binding) %||% character()), c("env", "name")) ||
      anyDuplicated(names(binding))
  ) {
    jdv_abort(
      "invalid_argument",
      "'binding' must be NULL or list(name = <string>, env = <environment>)."
    )
  }
  name <- binding$name
  if (
    !is.character(name) || length(name) != 1L || is.na(name) || !nzchar(name)
  ) {
    jdv_abort(
      "invalid_argument",
      "'binding$name' must be one non-empty string."
    )
  }
  if (!is.environment(binding$env)) {
    jdv_abort("invalid_argument", "'binding$env' must be an environment.")
  }
  list(name = name, env = binding$env)
}

# Check an explicit binding before anything is registered: the binding must be
# readable and hold exactly `x`.
.jdv_binding_verify <- function(x, binding) {
  # A malformed argument is reported the same way on every R version.
  spec <- .jdv_binding_spec(binding)
  if (!.jdv_track_supported()) {
    query_error("unsupported", "Binding tracking requires R 4.6.0 or later.")
  }
  if (identical(jdv_source(x)$access, "sequential")) {
    query_error("unsupported", "Sequential views cannot be tracked.")
  }
  ref <- .Call(C_jdv_weakref_make, spec$env)
  read <- .jdv_binding_read(ref, spec$name)
  if (!.jdv_binding_readable(read)) {
    query_error(
      "unavailable",
      paste0(
        "The binding '",
        spec$name,
        "' cannot be read without evaluating it (",
        read$status,
        ")."
      )
    )
  }
  if (!.jdv_track_same(read$value, x)) {
    query_error(
      "invalid_request",
      "The binding does not hold the object being registered."
    )
  }
  list(ref = ref, name = spec$name)
}

# The `tracking` object of a descriptor, notification, or response. `state` is
# active, paused, or lost. A lost state carries a fixed `reason` token and an
# optional human-readable `message`.
.jdv_tracking_json <- function(name, state, reason = NULL, message = NULL) {
  tracking <- list(name = name, state = state)
  if (!is.null(reason)) {
    tracking$reason <- reason
  }
  if (!is.null(message)) {
    tracking$message <- message
  }
  jdv_json_object(tracking)
}

# Whether the host can still stop or resume tracking: the view has a tracking
# object whose state is not lost.
.jdv_track_capability <- function(tracking) {
  !is.null(tracking) && !identical(tracking$state, "lost")
}

# The tracking state of an entry: NULL when it never tracked a binding.
.jdv_track_state <- function(entry) {
  if (is.null(entry$track_ref)) {
    NULL
  } else if (!is.null(entry$track_lost)) {
    "lost"
  } else if (isTRUE(entry$track_paused)) {
    "paused"
  } else {
    "active"
  }
}

.jdv_track_entry_json <- function(entry) {
  state <- .jdv_track_state(entry)
  if (is.null(state)) {
    return(NULL)
  }
  .jdv_tracking_json(
    entry$track_name,
    state,
    if (identical(state, "lost")) entry$track_lost_token,
    if (identical(state, "lost")) entry$track_lost
  )
}

# Announce the current tracking state of a live entry.
.jdv_track_notify <- function(entry) {
  if (isTRUE(entry$closed)) {
    return(invisible(NULL))
  }
  .jdv_notify(.jdv_json_encode(
    list(
      method = "view/tracking",
      params = list(
        view = entry$id,
        generation = entry$generation,
        tracking = .jdv_track_entry_json(entry)
      )
    ),
    work_limit = 64 * 1024
  ))
}

# Start tracking on a registered entry. `value` is the object currently held
# by the binding, which is the baseline for change detection.
.jdv_track_attach <- function(entry, ref, name, value) {
  entry$track_ref <- ref
  entry$track_name <- name
  entry$track_value <- value
  entry$track_failed <- NULL
  entry$track_lost <- NULL
  entry$track_lost_token <- NULL
  entry$track_paused <- NULL
  .jdv_track_install_callback()
  invisible(NULL)
}

# Check that the symbol `name` of `env` is a binding that holds `value`, which
# is the object a view displays. Returns the weak environment reference
# (list(ref, name)) on success, or the reason tracking is not possible as a
# string.
.jdv_track_prepare <- function(env, name, value) {
  ref <- .Call(C_jdv_weakref_make, env)
  read <- .jdv_binding_read(ref, name)
  if (!.jdv_binding_readable(read)) {
    return(paste0(
      "its binding cannot be read without evaluating it (",
      read$status,
      ")"
    ))
  }
  if (!.jdv_track_same(read$value, value)) {
    return("its binding does not hold the displayed object")
  }
  list(ref = ref, name = name)
}

# Carry tracking state into the replacement of an entry. `baseline` is the new
# object to compare against after a tracked update; NULL keeps the old one.
.jdv_track_carry <- function(entry, replacement, baseline = NULL) {
  if (is.null(entry$track_ref)) {
    return(invisible(NULL))
  }
  replacement$track_ref <- entry$track_ref
  replacement$track_name <- entry$track_name
  replacement$track_lost <- entry$track_lost
  replacement$track_lost_token <- entry$track_lost_token
  replacement$track_paused <- entry$track_paused
  replacement$track_failed <- NULL
  replacement$track_value <- if (is.null(baseline)) {
    entry$track_value
  } else {
    baseline
  }
  invisible(NULL)
}

# `token` is the fixed reason: "removed" or "collected".
.jdv_track_lose <- function(entry, token) {
  entry$track_lost_token <- token
  entry$track_lost <- .jdv_track_lost_message(token)
  entry$track_paused <- NULL
  entry$track_value <- NULL
  entry$track_failed <- NULL
  .jdv_track_notify(entry)
  invisible(NULL)
}

.jdv_track_lost_message <- function(token) {
  if (identical(token, "collected")) {
    "the environment of the binding was garbage collected"
  } else {
    "the binding was removed"
  }
}

.jdv_track_lost_reason <- function(read) {
  if (identical(read$status, "gone")) "collected" else "removed"
}

# The current object of a tracked entry for a manual refresh. Tracking that
# ended, or a binding that cannot be read without evaluation, is unavailable.
.jdv_track_current <- function(entry) {
  if (!is.null(entry$track_lost)) {
    query_error(
      "unavailable",
      paste0("The view is no longer tracked: ", entry$track_lost, ".")
    )
  }
  read <- .jdv_binding_read(entry$track_ref, entry$track_name)
  if (read$status %in% c("gone", "unbound")) {
    .jdv_track_lose(entry, .jdv_track_lost_reason(read))
    query_error(
      "unavailable",
      paste0("The view is no longer tracked: ", entry$track_lost, ".")
    )
  }
  if (!read$status %in% c("value", "forced")) {
    query_error(
      "unavailable",
      paste0(
        "The binding cannot be read without evaluating it (",
        read$status,
        ")."
      )
    )
  }
  read$value
}

.jdv_track_entries <- function() {
  ids <- ls(.jdv_state$entries, all.names = TRUE)
  entries <- lapply(
    ids,
    function(id) get(id, envir = .jdv_state$entries, inherits = FALSE)
  )
  entries <- Filter(
    function(entry) {
      !is.null(entry$track_ref) &&
        is.null(entry$track_lost) &&
        !isTRUE(entry$track_paused) &&
        !isTRUE(entry$closed)
    },
    entries
  )
  entries[order(vapply(entries, `[[`, numeric(1L), "sequence"))]
}

.jdv_track_active <- function() length(.jdv_track_entries()) > 0L

# The task callback exists only while a tracked view does or the session is
# subscribed to resource changes. It is independent of the viewer transport,
# which has its own cleanup callback.
.jdv_track_remove_callback <- function(name = .jdv_state$track_task_callback) {
  if (is.null(name)) {
    return(invisible(NULL))
  }
  try(removeTaskCallback(name), silent = TRUE)
  if (identical(.jdv_state$track_task_callback, name)) {
    .jdv_state$track_task_callback <- NULL
  }
  invisible(NULL)
}

# One poll for everything the task callback watches: tracked views first, then
# the resource tree. The two have separate state and separate error
# boundaries, so a failure of one never stops the other. Returns a list of the
# errors, `track` and `resources`, each NULL when that part succeeded.
.jdv_watch_poll <- function() {
  errors <- list(track = NULL, resources = NULL)
  tryCatch(.jdv_track_poll(), error = function(error) errors$track <<- error)
  # An overflow ended the session, and an unload ends everything.
  ended <- inherits(errors$track, "jdv_notification_overflow") ||
    isTRUE(.jdv_state$unloading)
  if (!ended) {
    tryCatch(
      .jdv_resources_poll(),
      error = function(error) errors$resources <<- error
    )
  }
  errors
}

# Raise the first error of .jdv_watch_poll(), for callers that do not recover.
.jdv_watch_signal <- function(errors) {
  for (error in errors) {
    if (!is.null(error)) {
      stop(error)
    }
  }
  invisible(NULL)
}

.jdv_track_task_callback <- function(expr, value, ok, visible) {
  if (isTRUE(.jdv_state$unloading)) {
    return(FALSE)
  }
  if (!.jdv_track_active() && !isTRUE(.jdv_state$res_subscribed)) {
    .jdv_track_remove_callback()
    return(FALSE)
  }
  errors <- .jdv_watch_poll()
  if (inherits(errors$track, "jdv_notification_overflow")) {
    warning(conditionMessage(errors$track), call. = FALSE)
  } else if (!is.null(errors$track)) {
    warning(
      "Updating tracked jdv views failed: ",
      conditionMessage(errors$track),
      call. = FALSE
    )
  }
  if (inherits(errors$resources, "jdv_notification_overflow")) {
    warning(conditionMessage(errors$resources), call. = FALSE)
  } else if (!is.null(errors$resources)) {
    warning(
      "Watching the jdv resource tree failed: ",
      conditionMessage(errors$resources),
      call. = FALSE
    )
  }
  TRUE
}

.jdv_track_install_callback <- function() {
  .jdv_assert_active()
  if (!is.null(.jdv_state$track_task_callback)) {
    return(invisible(NULL))
  }
  name <- paste0("jdv_track_", Sys.getpid())
  addTaskCallback(.jdv_track_task_callback, name = name)
  if (isTRUE(.jdv_state$unloading)) {
    try(removeTaskCallback(name), silent = TRUE)
    .jdv_assert_active()
  }
  .jdv_state$track_task_callback <- name
  invisible(NULL)
}

# The error code for an update failure notification.
.jdv_track_failure_code <- function(error) {
  code <- error$code
  if (
    is.character(code) &&
      length(code) == 1L &&
      grepl("^[a-z][a-z0-9_]{0,63}$", code)
  ) {
    code
  } else {
    "producer_error"
  }
}

.jdv_track_failure_notice <- function(entry, error) {
  message <- substr(conditionMessage(error), 1L, 512L)
  build <- function(text) {
    list(
      method = "view/update_failed",
      params = list(
        view = entry$id,
        generation = entry$generation,
        code = .jdv_track_failure_code(error),
        message = text
      )
    )
  }
  tryCatch(
    .jdv_json_encode(build(message), work_limit = 64 * 1024),
    error = function(e) {
      .jdv_json_encode(
        build("The view could not be updated."),
        work_limit = 64 * 1024
      )
    }
  )
}

# Compare one tracked entry with its binding and rebuild it when the object
# changed. Bindings that cannot be read without evaluation are skipped and
# checked again on the next poll.
.jdv_track_check <- function(entry) {
  read <- .jdv_binding_read(entry$track_ref, entry$track_name)
  if (read$status %in% c("gone", "unbound")) {
    .jdv_track_lose(entry, .jdv_track_lost_reason(read))
    return(invisible(NULL))
  }
  if (!read$status %in% c("value", "forced")) {
    return(invisible(NULL))
  }
  candidate <- read$value
  if (.jdv_track_same(candidate, entry$track_value)) {
    return(invisible(NULL))
  }
  failed <- entry$track_failed
  if (!is.null(failed) && .jdv_track_same(candidate, failed$value)) {
    return(invisible(NULL))
  }
  tryCatch(
    .jdv_update_view(
      entry,
      candidate,
      entry$intent_mode,
      entry$intent_collation,
      tracked = TRUE,
      reason = "tracked"
    ),
    error = function(error) {
      if (inherits(error, "jdv_notification_overflow")) {
        stop(error)
      }
      code <- .jdv_track_failure_code(error)
      if (
        isTRUE(entry$closed) ||
          code %in% c("view_not_found", "stale_generation", "in_use")
      ) {
        # The view changed under the update; the next poll looks again.
        return(invisible(NULL))
      }
      # Remember the candidate before announcing it so a failing notification
      # cannot make the same candidate fail twice.
      entry$track_failed <- list(value = candidate)
      .jdv_notify(.jdv_track_failure_notice(entry, error))
    }
  )
  invisible(NULL)
}

# Check every tracked view once and update all of the changed ones. Returns
# without work while a request, a refresh, or another poll is running; the
# next poll covers it.
.jdv_track_poll <- function() {
  if (
    isTRUE(.jdv_state$unloading) ||
      isTRUE(.jdv_state$refreshing) ||
      isTRUE(.jdv_state$tracking) ||
      .jdv_state$rpc_depth > 0L ||
      identical(.jdv_session_owner(), "none")
  ) {
    return(invisible(FALSE))
  }
  status <- .jdv_transport_status()
  if (!is.null(status) && isTRUE(status$busy)) {
    return(invisible(FALSE))
  }
  entries <- .jdv_track_entries()
  if (!length(entries)) {
    return(invisible(FALSE))
  }
  .jdv_state$tracking <- TRUE
  on.exit(.jdv_state$tracking <- FALSE, add = TRUE)
  for (entry in entries) {
    .jdv_assert_active()
    if (identical(.jdv_session_owner(), "none") || isTRUE(entry$closed)) {
      next
    }
    current <- if (
      exists(entry$id, envir = .jdv_state$entries, inherits = FALSE)
    ) {
      get(entry$id, envir = .jdv_state$entries, inherits = FALSE)
    }
    if (!identical(current, entry)) {
      next
    }
    .jdv_track_check(entry)
  }
  if (
    identical(.jdv_session_owner(), "transport") && .jdv_state$rpc_depth == 0L
  ) {
    .jdv_transport_flush()
  }
  invisible(TRUE)
}

# view/track: stop or resume following the binding of a view. Stopping keeps
# the binding and the baseline object. Resuming reads the binding once and
# rebuilds the view through the update transaction when the object differs
# from the baseline; a binding that cannot be read without evaluation is
# looked at again by the next poll. Returns the response result.
.jdv_track_set <- function(entry, enabled) {
  result <- function(current) {
    list(
      view = current$id,
      generation = current$generation,
      tracking = .jdv_track_entry_json(current)
    )
  }
  if (is.null(entry$track_ref)) {
    query_error("unsupported", "The view does not track a variable.")
  }
  if (!is.null(entry$track_lost)) {
    query_error(
      "unsupported",
      paste0("The view is no longer tracked: ", entry$track_lost, ".")
    )
  }
  if (identical(enabled, !isTRUE(entry$track_paused))) {
    return(result(entry))
  }
  if (!enabled) {
    entry$track_paused <- TRUE
    .jdv_track_notify(entry)
    return(result(entry))
  }
  entry$track_paused <- NULL
  # A candidate that failed before is tried again on an explicit resume.
  entry$track_failed <- NULL
  .jdv_track_install_callback()
  .jdv_track_check(entry)
  current <- if (
    exists(entry$id, envir = .jdv_state$entries, inherits = FALSE)
  ) {
    get(entry$id, envir = .jdv_state$entries, inherits = FALSE)
  }
  if (!is.null(current) && !identical(current, entry)) {
    # Rebuilt: the new view/open carries the active state.
    return(result(current))
  }
  if (is.null(entry$track_lost)) {
    .jdv_track_notify(entry)
  }
  result(entry)
}
