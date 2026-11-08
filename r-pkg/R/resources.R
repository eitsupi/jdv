# Resource tree of the R producer: the bindings of the global environment.
#
# The tree has one level. Every child names a binding, not a value: the id is
# resolved again for each request, so a reassigned binding opens its current
# value and a removed one is unavailable. Bindings are read only through
# .jdv_tree_binding_read(), which never evaluates a promise or an active
# binding, and nothing here calls jdv_source() or another user-visible S3
# generic while listing.

.jdv_resource_id_limit <- 16384L
.jdv_resource_page_limit <- 500L
.jdv_resource_methods <- c("resources/children", "resources/open")

# The resource tree is a session feature fixed when hello is created (see
# .jdv_hello()). It answers only while a session exists.
.jdv_resources_active <- function() {
  isTRUE(.jdv_state$resources) && !identical(.jdv_session_owner(), "none")
}

# Whether `jdv.resources` leaves the resource tree enabled. Only a single
# `FALSE` disables it.
.jdv_resources_option <- function() !isFALSE(getOption("jdv.resources", TRUE))

# A binding name as valid UTF-8, or NULL when it is not.
.jdv_resource_utf8 <- function(name) {
  utf8 <- tryCatch(enc2utf8(name), error = function(error) NULL)
  if (is.null(utf8) || !isTRUE(validUTF8(utf8))) NULL else utf8
}

# The id of a binding name, or NULL when the id would exceed the id limit. A
# name that is valid UTF-8 is carried as text ("b:" prefix); any other name is
# carried as the hex of its bytes ("h:" prefix) so the id still round-trips.
.jdv_resource_id <- function(name) {
  utf8 <- .jdv_resource_utf8(name)
  id <- if (is.null(utf8)) {
    paste0(
      "h:",
      paste(sprintf("%02x", as.integer(charToRaw(name))), collapse = "")
    )
  } else {
    paste0("b:", utf8)
  }
  if (nchar(id, type = "bytes") > .jdv_resource_id_limit) NULL else id
}

# The binding name an id refers to. An id that is not one of ours is an
# invalid request; whether the binding exists is decided by the caller.
.jdv_resource_name <- function(node) {
  invalid <- function() {
    query_error("invalid_request", "Unknown resource node id.")
  }
  if (
    !is.character(node) ||
      (is.object(node) && !inherits(node, "jdv_json_array")) ||
      !is.null(dim(node)) ||
      length(node) != 1L ||
      is.na(node) ||
      nchar(node, type = "bytes") > .jdv_resource_id_limit ||
      !isTRUE(validUTF8(node))
  ) {
    invalid()
  }
  node <- unname(node)
  prefix <- substr(node, 1L, 2L)
  rest <- substr(node, 3L, nchar(node, type = "chars"))
  if (!nzchar(rest)) {
    invalid()
  }
  if (identical(prefix, "b:")) {
    Encoding(rest) <- "UTF-8"
    return(rest)
  }
  if (identical(prefix, "h:") && grepl("^([0-9a-f]{2})+$", rest)) {
    digits <- substring(
      rest,
      seq.int(1L, nchar(rest), by = 2L),
      seq.int(2L, nchar(rest), by = 2L)
    )
    name <- tryCatch(
      rawToChar(as.raw(strtoi(digits, 16L))),
      error = function(error) NULL
    )
    if (!is.null(name) && nzchar(name)) {
      return(name)
    }
  }
  invalid()
}

# Binding names in a locale-independent order: the byte order of their UTF-8
# form, which is the order of code points. ls() is not relied on to sort.
.jdv_resource_names <- function() {
  names <- base::ls(envir = globalenv(), all.names = TRUE, sorted = FALSE)
  if (length(names) < 2L) {
    return(names)
  }
  keys <- vapply(
    names,
    function(name) {
      utf8 <- .jdv_resource_utf8(name)
      if (is.null(utf8)) {
        paste(sprintf("%02x", as.integer(charToRaw(name))), collapse = "")
      } else {
        utf8
      }
    },
    character(1L),
    USE.NAMES = FALSE
  )
  names[order(keys, method = "radix")]
}

# The display kind of a value, decided from its type and class attribute alone.
# jdv_source() and S3 methods are not consulted, so the view that actually
# opens is known only from the view/open descriptor.
.jdv_resource_kind <- function(info) {
  if (info$type %in% c("closure", "builtin", "special")) {
    "function"
  } else if (
    "data.frame" %in% info$class ||
      (isTRUE(info$is_matrix) && info$type %in% .jdv_tree_atomic_types)
  ) {
    "table"
  } else if (info$type %in% .jdv_tree_atomic_types) {
    "value"
  } else {
    "object"
  }
}

# The one-line summary of a listed value, built from `info` and the stored
# `dim` and `row.names` attributes alone. It reads no element and calls no
# function that can dispatch on the class of the value: attr(),
# .row_names_info() and the C reader behind `info` are not generic, whereas
# length(), dim(), names(), levels(), `[` and format() are (?InternalMethods).
# A length is therefore the stored length of the object, which a user-defined
# length() method may disagree with.
.jdv_resource_summary <- function(x, info) {
  label <- .jdv_tree_class_text(info)
  type <- info$type
  stored_length <- function() {
    paste0(" (", format(max(0, info$length), scientific = FALSE), ")")
  }
  text <- if (
    !length(info$class) && type %in% c("closure", "builtin", "special")
  ) {
    "function"
  } else if (identical(type, "environment") || identical(type, "s4")) {
    label
  } else if ("data.frame" %in% info$class && identical(type, "list")) {
    rows <- tryCatch(
      .row_names_info(x, 2L),
      error = function(error) NA_integer_
    )
    if (length(rows) == 1L && !is.na(rows)) {
      paste0(
        label,
        " [",
        format(abs(rows), scientific = FALSE),
        " \u00d7 ",
        format(info$length, scientific = FALSE),
        "]"
      )
    } else {
      paste0(label, stored_length())
    }
  } else if (
    type %in% .jdv_tree_atomic_types &&
      (isTRUE(info$is_array) || isTRUE(info$is_matrix))
  ) {
    dims <- attr(x, "dim", exact = TRUE)
    if (is.numeric(dims) && !is.object(dims) && length(dims) && !anyNA(dims)) {
      shape <- paste(
        format(dims, scientific = FALSE, trim = TRUE),
        collapse = " \u00d7 "
      )
      kind <- if (length(info$class)) {
        label
      } else if (isTRUE(info$is_matrix)) {
        "matrix"
      } else {
        "array"
      }
      paste0(kind, " ", type, " [", shape, "]")
    } else {
      paste0(label, stored_length())
    }
  } else if (
    type %in%
      c(.jdv_tree_atomic_types, "list", "expression", "pairlist", "dots")
  ) {
    paste0(label, stored_length())
  } else {
    label
  }
  enc2utf8(substr(text, 1L, .jdv_tree_text_limit))
}

.jdv_resource_summaries <- c(
  delayed_binding = "Promise that has not been evaluated",
  active_binding = "Active binding",
  missing_binding = "Missing argument",
  opaque_binding = "Value cannot be read without evaluating it on this R",
  unavailable = "Unavailable",
  id_limit = "Name is too long to identify"
)

# The token explaining why a binding read cannot be opened, or NULL.
.jdv_resource_unavailable <- function(status) {
  if (identical(status, "opaque")) {
    return("opaque_binding")
  }
  .jdv_tree_unavailable_token(status)
}

# One child entry for the binding `name` of the global environment.
.jdv_resource_child <- function(name) {
  utf8 <- .jdv_resource_utf8(name)
  label <- if (is.null(utf8)) encodeString(name) else utf8
  child <- list(
    label = enc2utf8(substr(label, 1L, .jdv_tree_text_limit)),
    kind = "unknown",
    has_children = FALSE,
    viewable = FALSE
  )
  id <- .jdv_resource_id(name)
  unavailable <- NULL
  if (is.null(id)) {
    unavailable <- "id_limit"
  } else {
    child$id <- id
    read <- .jdv_tree_binding_read(globalenv(), name)
    unavailable <- .jdv_resource_unavailable(read$status)
    if (is.null(unavailable)) {
      described <- tryCatch(
        {
          info <- .jdv_tree_info(read$value)
          list(
            kind = .jdv_resource_kind(info),
            class = .jdv_tree_class(info),
            type = .jdv_tree_typeof(info),
            summary = .jdv_resource_summary(read$value, info)
          )
        },
        error = function(error) NULL
      )
      if (is.null(described)) {
        unavailable <- "unavailable"
      } else {
        child[names(described)] <- described
        child$viewable <- TRUE
      }
    }
  }
  if (!is.null(unavailable)) {
    child$unavailable <- unavailable
    summary <- unname(.jdv_resource_summaries[unavailable])
    child$summary <- if (is.na(summary)) "Unavailable" else summary
  }
  if (grepl("^\\.", name, useBytes = TRUE)) {
    child$hidden <- TRUE
  }
  .jdv_tree_object(child)
}

# The display-only title of a view opened from a binding: the name written as
# an R symbol, or the escaped label for a name that is not valid UTF-8. It is
# cut to fit the title limit.
.jdv_resource_title <- function(name) {
  utf8 <- .jdv_resource_utf8(name)
  title <- if (is.null(utf8)) encodeString(name) else .jdv_title_symbol(utf8)
  title <- substr(enc2utf8(title), 1L, .jdv_tree_text_limit)
  while (nchar(title, type = "bytes") > .jdv_title_limit) {
    title <- substr(title, 1L, nchar(title) - 1L)
  }
  title
}

.jdv_resources_params <- function(params, allowed, required = character()) {
  if (is.null(params)) {
    params <- list()
  }
  if (
    !is.list(params) ||
      (is.object(params) && !inherits(params, "jdv_json_object"))
  ) {
    query_error("invalid_request", "params must be an object.")
  }
  if (length(params)) {
    # Unknown members are ignored for forward compatibility.
    .jdv_fields(params, allowed, required)
  } else if (length(required)) {
    query_error("invalid_request", "Missing resource request parameter.")
  }
  params
}

.jdv_resources_children <- function(params) {
  params <- .jdv_resources_params(params, c("node", "offset", "limit"))
  offset <- if (is.null(params$offset)) {
    0
  } else {
    query_integer(params$offset, "offset")
  }
  if (offset > 2^53 - 1) {
    query_error("invalid_request", "offset must be a safe integer.")
  }
  limit <- if (is.null(params$limit)) {
    200
  } else {
    query_integer(params$limit, "limit", 1)
  }
  if (limit > .jdv_resource_page_limit) {
    query_error("invalid_request", "limit exceeds the resource page cap.")
  }
  node <- params$node
  if (!is.null(node)) {
    # A node is a leaf: it has no children, but it must still exist.
    name <- .jdv_resource_name(node)
    if (
      identical(.jdv_tree_binding_read(globalenv(), name)$status, "unbound")
    ) {
      query_error("unavailable", "The resource no longer exists.")
    }
    return(list(
      node = node,
      offset = as.double(offset),
      children = jdv_json_array(),
      total_children = 0,
      next_offset = NULL
    ))
  }
  names <- .jdv_resource_names()
  total <- length(names)
  last <- min(total, offset + limit)
  page <- if (offset >= total) character() else names[seq.int(offset + 1, last)]
  list(
    node = NULL,
    offset = as.double(offset),
    children = .jdv_tree_array(lapply(page, .jdv_resource_child)),
    total_children = as.double(total),
    next_offset = if (length(page) && last < total) as.double(last) else NULL
  )
}

# Keep the first `count` children of a children page. Dropping the rest never
# ends the listing, so the page continues at the first dropped child.
.jdv_resources_trim_page <- function(page, count) {
  page$children <- .jdv_tree_array(page$children[seq_len(count)])
  page$next_offset <- page$offset + count
  page
}

.jdv_resources_open <- function(params) {
  params <- .jdv_resources_params(
    params,
    c("node", "mode", "collation"),
    "node"
  )
  name <- .jdv_resource_name(params$node)
  mode <- "auto"
  if ("mode" %in% names(params)) {
    mode <- query_string(params$mode, Inf)
    if (!mode %in% c("auto", "snapshot", "paged")) {
      query_error("invalid_request", "Invalid view mode.")
    }
  }
  collation <- NULL
  if ("collation" %in% names(params)) {
    collation <- query_string(params$collation, Inf)
    if (!collation %in% c("C", "locale")) {
      query_error("invalid_request", "Invalid view collation.")
    }
  }
  read <- .jdv_tree_binding_read(globalenv(), name)
  if (identical(read$status, "unbound")) {
    query_error("unavailable", "The resource no longer exists.")
  }
  if (!read$status %in% c("value", "forced")) {
    query_error(
      "unavailable",
      paste0(
        "The resource cannot be read without evaluating it (",
        read$status,
        ")."
      )
    )
  }
  x <- read$value
  # Follow the variable when R can read bindings safely, the value is not a
  # stream, and the name can be shown in the descriptor; otherwise the view is
  # a plain view of the current value.
  prepared <- NULL
  if (
    .jdv_track_supported() &&
      !is.null(.jdv_resource_utf8(name)) &&
      !identical(jdv_source(x)$access, "sequential")
  ) {
    prepared <- .jdv_track_prepare(globalenv(), name, x)
    if (is.character(prepared)) {
      prepared <- NULL
    }
  }
  registered <- .jdv_register_internal(
    x,
    .jdv_resource_title(name),
    mode,
    collation,
    emit = FALSE,
    reason = "resource",
    title_slot = FALSE,
    tracking = if (!is.null(prepared)) {
      .jdv_tracking_json(prepared$name, "active")
    }
  )
  committed <- FALSE
  on.exit(
    if (!committed) .jdv_close_internal(registered$id, notify = FALSE),
    add = TRUE
  )
  if (!is.null(prepared)) {
    entry <- get(registered$id, envir = .jdv_state$entries, inherits = FALSE)
    .jdv_track_attach(entry, prepared$ref, prepared$name, x)
  }
  descriptor <- registered$descriptor
  if (is.null(descriptor)) {
    descriptor <- .jdv_json_parse(
      registered$open,
      limit = max(1024, .jdv_max_message_bytes())
    )
  }
  result <- descriptor$params
  attr(result, "jdv_child_id") <- registered$id
  # The view/open message is queued once the response is final, before it.
  attr(result, "jdv_child_open") <- registered$open
  committed <- TRUE
  result
}

.jdv_resources_request <- function(method, params) {
  if (!.jdv_resources_active()) {
    query_error("unsupported", "This session does not provide resource trees.")
  }
  if (identical(method, "resources/children")) {
    .jdv_resources_children(params)
  } else {
    .jdv_resources_open(params)
  }
}
