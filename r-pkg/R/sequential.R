# A sequential view owns only its moved C stream and logical descriptors.
.jdv_sequential_acquire <- function(x) {
  if (!requireNamespace("nanoarrow", quietly = TRUE)) {
    query_error(
      "unsupported",
      "Sequential views require the optional nanoarrow package."
    )
  }
  stream <- getExportedValue("nanoarrow", "as_nanoarrow_array_stream")(x)
  .jdv_stream_move(stream)
}

.jdv_sequential_open <- function(token) .jdv_stream_open(token)
.jdv_sequential_page_row_limit <- function() {
  name <- "jdv.max_page_rows"
  value <- getOption(name, 2000)
  if (
    !is.numeric(value) ||
      length(value) != 1L ||
      is.object(value) ||
      is.na(value) ||
      !is.finite(value) ||
      value != floor(value) ||
      value < 1 ||
      value >= 2^53
  ) {
    query_error("invalid_request", paste0("Invalid option: ", name, "."))
  }
  as.double(value)
}
.jdv_sequential_page <- function(token, max_rows, max_bytes) {
  .jdv_stream_page(token, max_rows, max_bytes)
}
.jdv_sequential_can_release <- function() {
  .Call(C_jdv_arrow_status)[["busy"]] == 0L
}
.jdv_sequential_release_token <- function(token) .Call(C_jdv_arrow_close, token)

.jdv_sequential_flush <- function() {
  if (
    isTRUE(.jdv_state$sequential_releasing) || !.jdv_sequential_can_release()
  ) {
    return(invisible(NULL))
  }
  .jdv_state$sequential_releasing <- TRUE
  on.exit(.jdv_state$sequential_releasing <- FALSE, add = TRUE)
  failure <- NULL
  while (length(.jdv_state$sequential_releases)) {
    token <- .jdv_state$sequential_releases[[1L]]
    .jdv_state$sequential_releases <- .jdv_state$sequential_releases[-1L]
    tryCatch(
      .jdv_sequential_release_token(token),
      error = function(e) failure <<- failure %||% e
    )
  }
  if (!is.null(failure)) {
    stop(failure)
  }
  invisible(NULL)
}

.jdv_sequential_release <- function(entry) {
  token <- entry$stream
  entry$stream <- NULL
  if (!is.null(token)) {
    pending <- .jdv_state$sequential_releases %||% list()
    if (!any(vapply(pending, identical, logical(1L), token))) {
      .jdv_state$sequential_releases <- c(pending, list(token))
    }
  }
  .jdv_sequential_flush()
}

.jdv_sequential_descriptor <- function(content, id, generation, title, reason) {
  list(
    method = "view/open",
    params = list(
      view = id,
      generation = generation,
      title = title,
      reason = reason,
      kind = "grid",
      access = "sequential",
      encoding = "arrow-ipc",
      capabilities = list(
        seek = FALSE,
        sort = FALSE,
        filter = FALSE,
        known_total = FALSE,
        `next` = TRUE,
        children = FALSE,
        refresh = FALSE,
        track = FALSE
      ),
      nrow = NULL,
      max_page_rows = content$page_rows,
      ncol = length(content$schema),
      columns = content$schema
    )
  )
}

.jdv_sequential_register <- function(
  x,
  title = NULL,
  reason = "register",
  title_slot = TRUE
) {
  .jdv_assert_active()
  if (!is.null(title)) {
    title <- query_string(title, 4096L)
  }
  max_tables <- .jdv_option_limit("jdv.max_tables", 64)
  token <- .jdv_sequential_acquire(x)
  committed <- FALSE
  on.exit(
    {
      if (!committed) {
        abandoned <- new.env(parent = emptyenv())
        abandoned$stream <- token
        try(.jdv_sequential_release(abandoned), silent = TRUE)
      }
      .jdv_sequential_flush()
    },
    add = TRUE
  )
  info <- .jdv_sequential_open(token)
  .jdv_assert_active()
  columns <- lapply(info$columns, function(column) {
    column$position <- column$index
    column$sortable <- FALSE
    column$filterable <- FALSE
    column$drillable <- FALSE
    column
  })
  content <- list(
    mode = "sequential",
    source = NULL,
    holder = NULL,
    fingerprint = NULL,
    nrow = NULL,
    ncol = length(columns),
    schema = columns,
    collation = NULL,
    stream = token,
    page_rows = .jdv_sequential_page_row_limit()
  )
  title_key <- if (is.null(title) || !title_slot) {
    NULL
  } else {
    .jdv_title_key(title)
  }
  title_record <- function() {
    if (
      !is.null(title_key) &&
        exists(title_key, .jdv_state$titles, inherits = FALSE)
    ) {
      get(title_key, .jdv_state$titles, inherits = FALSE)
    } else {
      NULL
    }
  }
  current_entry <- function(id) {
    if (exists(id, .jdv_state$entries, inherits = FALSE)) {
      get(id, .jdv_state$entries, inherits = FALSE)
    } else {
      NULL
    }
  }
  installed <- FALSE
  for (attempt in seq_len(32L)) {
    previous <- title_record()
    next_id <- .jdv_state$next_id
    sequence <- .jdv_state$sequence
    id <- if (is.null(previous)) {
      paste0("v-", format(next_id + 1, scientific = FALSE, trim = TRUE))
    } else {
      previous$id
    }
    generation <- if (is.null(previous)) 1 else previous$generation + 1
    old <- current_entry(id)
    stable <- function(expected_sequence = sequence) {
      identical(previous, title_record()) &&
        identical(old, current_entry(id)) &&
        identical(next_id, .jdv_state$next_id) &&
        identical(expected_sequence, .jdv_state$sequence) &&
        (is.null(old) || !isTRUE(old$closed))
    }
    open <- .jdv_json_encode(.jdv_sequential_descriptor(
      content,
      id,
      generation,
      title,
      reason
    ))
    .jdv_assert_active()
    if (!stable()) {
      next
    }
    active <- length(ls(.jdv_state$entries, all.names = TRUE))
    while (active > max_tables || (is.null(old) && active >= max_tables)) {
      candidates <- lapply(
        setdiff(
          ls(.jdv_state$entries, all.names = TRUE),
          c(id, .jdv_state$eviction_pins)
        ),
        function(key) get(key, .jdv_state$entries, inherits = FALSE)
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
      if (!stable()) {
        break
      }
      active <- length(ls(.jdv_state$entries, all.names = TRUE))
    }
    if (!stable()) {
      next
    }
    entry <- .jdv_install(content, title, id, generation)
    .jdv_assert_active()
    if (!stable(sequence + 1)) {
      next
    }
    if (is.null(previous)) {
      .jdv_state$next_id <- next_id + 1
    }
    assign(id, entry, .jdv_state$entries)
    if (!is.null(title_key)) {
      assign(
        title_key,
        list(id = id, generation = generation),
        .jdv_state$titles
      )
    }
    installed <- TRUE
    break
  }
  if (!installed) {
    query_error(
      "in_use",
      "The view registry kept changing while registering this stream."
    )
  }
  committed <- TRUE
  if (!is.null(old)) {
    .jdv_close_children(old, notify = TRUE)
    .jdv_close_entry(old)
  }
  .jdv_assert_active()
  current <- current_entry(id)
  if (is.null(current)) {
    query_error(
      "view_not_found",
      "The stream view was closed during registration."
    )
  }
  if (!identical(current, entry)) {
    query_error(
      "stale_generation",
      "The stream view was replaced during registration."
    )
  }
  list(id = id, generation = generation, open = open)
}

.jdv_sequential_next <- function(entry, params) {
  if (!identical(entry$mode, "sequential")) {
    query_error("unsupported", "This view is not sequential.")
  }
  if (isTRUE(entry$stream_busy)) {
    query_error("in_use", "A stream request is already running for this view.")
  }
  if (!is.null(entry$stream_failure)) {
    query_error(
      "stream_failed",
      entry$stream_failure$message,
      details = list(reason = entry$stream_failure$code)
    )
  }
  max_rows <- if ("max_rows" %in% names(params)) {
    .jdv_binary_integer(params$max_rows, "max_rows", 1)
  } else {
    min(200, entry$page_rows)
  }
  if (max_rows > entry$page_rows) {
    query_error(
      "invalid_request",
      "max_rows exceeds the sequential page row cap."
    )
  }
  max_bytes <- .jdv_binary_body_cap(params)
  if (max_bytes == 0) {
    query_error("limit_exceeded", "The byte budget cannot hold an IPC stream.")
  }
  entry$stream_busy <- TRUE
  on.exit(
    {
      entry$stream_busy <- FALSE
      .jdv_sequential_flush()
    },
    add = TRUE
  )
  page <- tryCatch(
    .jdv_sequential_page(entry$stream, max_rows, max_bytes),
    error = function(e) {
      if (isTRUE(e$terminal)) {
        entry$stream_failure <- list(
          code = e$code %||% "producer_error",
          message = conditionMessage(e)
        )
        .jdv_sequential_release(entry)
      }
      stop(e)
    }
  )
  .jdv_assert_active()
  current <- if (exists(entry$id, .jdv_state$entries, inherits = FALSE)) {
    get(entry$id, .jdv_state$entries)
  } else {
    NULL
  }
  if (!is.null(current) && !identical(current, entry)) {
    query_error(
      "stale_generation",
      "The sequential view generation changed while reading."
    )
  }
  if (entry$closed || is.null(current)) {
    query_error(
      "view_not_found",
      "The sequential view was closed while reading."
    )
  }
  .jdv_binary_result(
    list(
      view = entry$id,
      generation = entry$generation,
      first_row = page$first_row,
      rows_fetched = page$rows_fetched,
      rows_seen = page$rows_seen,
      done = page$done
    ),
    page$payload
  )
}
