.jdv_tree_path_limit <- 32L
.jdv_tree_page_limit <- 500L
.jdv_tree_text_limit <- 1000L
.jdv_tree_children_limit <- 32L

.jdv_tree_info <- function(x) .Call(C_jdv_tree_info, x)

.jdv_tree_names <- function(x) {
  tryCatch(.Call(C_jdv_tree_names, x), error = function(error) character())
}

.jdv_tree_vector_names <- function(x, indices) {
  if (!length(indices)) {
    return(character())
  }
  .Call(C_jdv_tree_vector_names, x, as.double(indices[[1L]]), length(indices))
}

.jdv_tree_storage_type <- function(info) {
  if (identical(info$type, "s4")) info$storage_type else info$type
}

.jdv_tree_step <- function(step) {
  if (is.list(step) && "kind" %in% names(step)) {
    query_error(
      "invalid_request",
      "Cell steps are only allowed first in grid paths."
    )
  }
  .jdv_fields(step, c("type", "index", "name"), "type")
  type <- query_string(step$type, 16L)
  if (identical(type, "index")) {
    .jdv_fields(step, c("type", "index"), c("type", "index"))
    index <- query_integer(step$index, "path index", 1)
    return(list(type = type, index = index))
  }
  if (type %in% c("binding", "slot", "attr")) {
    .jdv_fields(step, c("type", "name"), c("type", "name"))
    name <- query_string(step$name, .jdv_tree_text_limit)
    return(list(type = type, name = name))
  }
  query_error("invalid_request", "Unknown typed tree path step.")
}

.jdv_tree_path <- function(path) {
  if (
    !is.list(path) ||
      (is.object(path) && !inherits(path, "jdv_json_array")) ||
      !is.null(names(path)) ||
      length(path) > .jdv_tree_path_limit
  ) {
    query_error("invalid_request", "Tree path must be a bounded array.")
  }
  lapply(path, .jdv_tree_step)
}

.jdv_tree_same_reference <- function(x, y) {
  info <- .jdv_tree_info(x)
  isTRUE(info$reference) && isTRUE(.Call(C_jdv_tree_same, x, y))
}

.jdv_tree_ancestry <- function(entry) {
  values <- list(entry$tree_value)
  parent <- entry$parent_entry
  while (!is.null(parent)) {
    values[[length(values) + 1L]] <- parent$tree_value
    parent <- parent$parent_entry
  }
  values
}

.jdv_tree_resolve <- function(root, path, ancestry = list()) {
  value <- root
  seen <- c(list(root), ancestry)
  # The value each step started from, so a caller can name the steps.
  containers <- list()
  for (step in path) {
    containers[[length(containers) + 1L]] <- value
    kind <- step$type
    index <- if (identical(kind, "index")) step$index else 0L
    name <- if (!identical(kind, "index")) step$name else ""
    found <- tryCatch(
      .Call(C_jdv_tree_child, value, kind, index, name),
      error = function(error) {
        list(status = "error", value = NULL, message = conditionMessage(error))
      }
    )
    if (
      !identical(found$status, "value") && !identical(found$status, "forced")
    ) {
      return(list(status = found$status, value = NULL, seen = seen))
    }
    value <- found$value
    if (
      any(vapply(
        seen,
        function(previous) .jdv_tree_same_reference(value, previous),
        logical(1L)
      ))
    ) {
      return(list(status = "cycle", value = NULL, seen = seen))
    }
    seen[[length(seen) + 1L]] <- value
  }
  list(status = "value", value = value, seen = seen, containers = containers)
}

.jdv_title_limit <- 4096L

# Preserve Unicode when quoting text in a non-UTF-8 locale while retaining
# encodeString()'s escapes for quotes, backslashes, and control characters.
.jdv_encode_string <- function(x, quote = "") {
  if (isTRUE(l10n_info()[["UTF-8"]])) {
    return(encodeString(x, quote = quote))
  }
  escape_points <- c(1:31, 92L, 127:159)
  escapes <- c(
    sprintf("\\%03o", 1:31),
    "\\\\",
    "\\177",
    sprintf("\\u%04x", 128:159)
  )
  escapes[7:13] <- c("\\a", "\\b", "\\t", "\\n", "\\v", "\\f", "\\r")
  if (nzchar(quote)) {
    escape_points <- c(escape_points, utf8ToInt(quote)[[1L]])
    escapes <- c(escapes, paste0("\\", quote))
  }
  encode_one <- function(value) {
    if (is.na(value) || identical(Encoding(value), "bytes")) {
      return(encodeString(value, quote = quote))
    }
    utf8_value <- tryCatch(enc2utf8(value), error = function(error) NULL)
    if (is.null(utf8_value) || !validUTF8(utf8_value)) {
      return(encodeString(value, quote = quote))
    }
    points <- utf8ToInt(utf8_value)
    at <- match(points, escape_points)
    replace <- !is.na(at)
    if (!any(replace)) {
      return(paste0(quote, utf8_value, quote))
    }
    escaped <- intToUtf8(points, multiple = TRUE)
    escaped[replace] <- escapes[at[replace]]
    paste0(
      if (nzchar(quote)) quote else "",
      paste0(escaped, collapse = ""),
      if (nzchar(quote)) quote else ""
    )
  }
  vapply(x, encode_one, character(1L), USE.NAMES = FALSE)
}

# Display titles for child views. They only label a child for the user and are
# never parsed back or evaluated.
.jdv_title_symbol <- function(name) {
  if (identical(make.names(name), name)) {
    return(name)
  }
  paste0("`", gsub("`", "\\`", .jdv_encode_string(name), fixed = TRUE), "`")
}

.jdv_title_string <- function(name) .jdv_encode_string(name, quote = '"')

# The name of element `index` when it is a usable key: present, nonempty, and
# unique among `names`.
.jdv_title_key_name <- function(names, index) {
  if (is.null(names) || index > length(names)) {
    return(NULL)
  }
  name <- names[[index]]
  if (is.na(name) || !nzchar(name) || sum(names == name, na.rm = TRUE) != 1L) {
    return(NULL)
  }
  name
}

.jdv_title_step <- function(title, step, container) {
  type <- step$type
  if (identical(type, "binding")) {
    return(paste0(title, "$", .jdv_title_symbol(step$name)))
  }
  if (identical(type, "slot")) {
    return(paste0(title, "@", .jdv_title_symbol(step$name)))
  }
  if (identical(type, "attr")) {
    return(paste0("attr(", title, ", ", .jdv_title_string(step$name), ")"))
  }
  names <- tryCatch(
    attr(container, "names", exact = TRUE),
    error = function(error) NULL
  )
  if (!is.character(names)) {
    names <- NULL
  }
  name <- .jdv_title_key_name(names, step$index)
  if (is.null(name)) {
    return(paste0(title, "[[", format(step$index, scientific = FALSE), "]]"))
  }
  atomic <- is.atomic(container)
  if (atomic) {
    return(paste0(title, "[[", .jdv_title_string(name), "]]"))
  }
  paste0(title, "$", .jdv_title_symbol(name))
}

# The title of the child opened at `path` below `entry`, or NULL when the
# parent has no title. `resolved` is the .jdv_tree_resolve() result for the
# steps after a leading cell step.
.jdv_child_title <- function(entry, path, resolved) {
  title <- entry$title
  if (is.null(title)) {
    return(NULL)
  }
  steps <- path
  if (identical(path[[1L]]$kind, "cell")) {
    cell <- path[[1L]]
    steps <- path[-1L]
    names <- vapply(
      entry$schema,
      function(column) as.character(column$name %||% ""),
      character(1L)
    )
    key <- .jdv_title_key_name(names, cell$column + 1L)
    column <- if (is.null(key)) {
      format(cell$column + 1, scientific = FALSE)
    } else {
      .jdv_title_string(key)
    }
    title <- paste0(
      title,
      "[",
      format(cell$row_index, scientific = FALSE),
      ", ",
      column,
      "]"
    )
  }
  for (i in seq_along(steps)) {
    title <- .jdv_title_step(title, steps[[i]], resolved$containers[[i]])
    if (nchar(title, type = "bytes") > 2L * .jdv_title_limit) {
      break
    }
  }
  # Truncate on characters, as other display text is, then fit the byte limit.
  title <- substr(enc2utf8(title), 1L, .jdv_title_limit)
  while (nchar(title, type = "bytes") > .jdv_title_limit) {
    title <- substr(title, 1L, nchar(title) - 1L)
  }
  title
}

.jdv_tree_class <- function(info) {
  klass <- info$class
  if (!length(klass)) {
    klass <- if (isTRUE(info$is_matrix)) {
      c("matrix", "array")
    } else if (isTRUE(info$is_array)) {
      "array"
    } else {
      switch(
        info$type,
        double = "numeric",
        closure = "function",
        builtin = "function",
        special = "function",
        null = "NULL",
        symbol = "name",
        language = "call",
        info$type
      )
    }
  }
  klass <- lapply(
    as.list(klass),
    function(item) {
      if (is.na(item)) "" else enc2utf8(substr(item, 1L, .jdv_tree_text_limit))
    }
  )
  .jdv_json_values(klass)
}

.jdv_tree_atomic_types <- c(
  "logical",
  "integer",
  "double",
  "complex",
  "character",
  "raw"
)

# The value of `typeof()` for the described object.
.jdv_tree_typeof <- function(info) {
  switch(
    info$storage_type,
    null = "NULL",
    s4 = "S4",
    dots = "...",
    info$storage_type
  )
}

.jdv_tree_class_text <- function(info) {
  if (length(info$class)) {
    paste(
      vapply(
        info$class,
        function(item) {
          if (is.na(item)) "" else substr(item, 1L, .jdv_tree_text_limit)
        },
        character(1L)
      ),
      collapse = "/"
    )
  } else {
    info$type
  }
}

# Factor levels are read as a stored attribute, never through `levels()`.
.jdv_tree_levels <- function(x) {
  found <- .Call(C_jdv_tree_child, x, "attr", 0, "levels")
  if (identical(found$status, "value") && is.character(found$value)) {
    found$value
  } else {
    character()
  }
}

# Format the selected elements in one pass. Only the requested range is read.
.jdv_tree_class_display <- function(x, indices) {
  expected <- length(indices)
  tryCatch(
    suppressMessages(suppressWarnings({
      slice <- query_slice(x, indices)
      valid_slice <- identical(class(slice), class(x)) &&
        typeof(slice) == typeof(x) &&
        length(slice) == expected &&
        is.null(dim(slice))
      if (!valid_slice) {
        return(NULL)
      }
      value <- col_display(slice)
      if (
        is.character(value) && is.null(dim(value)) && length(value) == expected
      ) {
        value
      } else {
        NULL
      }
    })),
    error = function(error) NULL
  )
}

.jdv_tree_text_cleanup <- function(text) {
  text[is.na(text)] <- "NA"
  text <- enc2utf8(text)
  text[!validUTF8(text)] <- "<invalid string>"
  substr(text, 1L, 160L)
}

.jdv_tree_has_list_format <- function(x, info) {
  if (
    !identical(info$type, "list") ||
      !is.object(x) ||
      isS4(x) ||
      inherits(x, "data.frame") ||
      "AsIs" %in% info$class
  ) {
    return(FALSE)
  }
  classes <- info$class[!is.na(info$class) & nzchar(info$class)]
  if (!length(classes)) {
    return(FALSE)
  }
  for (class in classes) {
    if (
      !identical(class, "default") &&
        !is.null(utils::getS3method("format", class, optional = TRUE))
    ) {
      return(TRUE)
    }
  }
  FALSE
}

.jdv_tree_element_text <- function(x, info, first, count) {
  if (identical(info$type, "integer") && "factor" %in% info$class) {
    values <- .Call(
      C_jdv_tree_vector_page,
      x,
      as.double(first),
      as.double(count)
    )
    levels <- .jdv_tree_levels(x)
    text <- rep.int("NA", length(values))
    present <- !is.na(values)
    valid <- present & values >= 1L & values <= length(levels)
    text[valid] <- levels[values[valid]]
    invalid <- present & !valid
    text[invalid] <- paste0("<invalid code ", values[invalid], ">")
  } else {
    classed_atomic <- is.object(x) &&
      !isS4(x) &&
      is.atomic(x) &&
      is.null(dim(x))
    displayed <- if (classed_atomic) {
      .jdv_tree_class_display(x, seq.int(first, length.out = count))
    } else {
      NULL
    }
    if (!is.null(displayed)) {
      text <- displayed
    } else {
      values <- .Call(
        C_jdv_tree_vector_page,
        x,
        as.double(first),
        as.double(count)
      )
      text <- as.character(values)
    }
  }
  .jdv_tree_text_cleanup(text)
}

# Atomic previews are character vectors. Eligible list previews return the
# validated logical length with the formatted values so summaries share it.
.jdv_tree_scalar_preview <- function(
  x,
  info = .jdv_tree_info(x),
  list_format = .jdv_tree_has_list_format(x, info)
) {
  if (!isTRUE(info$type %in% .jdv_tree_atomic_types) && !list_format) {
    return(NULL)
  }
  if (list_format) {
    n <- tryCatch(
      suppressMessages(suppressWarnings({
        value_count <- length(x)
        if (
          !is.numeric(value_count) ||
            is.object(value_count) ||
            isS4(value_count) ||
            !is.null(dim(value_count)) ||
            length(value_count) != 1L
        ) {
          NULL
        } else {
          value_count <- as.double(value_count)
          if (
            is.na(value_count) ||
              !is.finite(value_count) ||
              value_count < 0 ||
              value_count != floor(value_count)
          ) {
            NULL
          } else {
            value_count
          }
        }
      })),
      error = function(error) NULL
    )
    if (is.null(n)) {
      return(list(length = NULL, values = NULL))
    }
    total <- n
    count <- as.integer(min(5, n))
    values <- if (count) {
      preview <- .jdv_tree_class_display(x, seq_len(count))
      if (is.null(preview)) NULL else .jdv_tree_text_cleanup(preview)
    } else {
      character()
    }
    return(list(length = total, values = values))
  }
  n <- as.integer(min(5, max(0, info$length)))
  if (!n) {
    return(character())
  }
  tryCatch(
    .jdv_tree_element_text(x, info, 1L, n),
    error = function(error) rep.int("<unavailable>", n)
  )
}

# `count_environment = FALSE` leaves the binding count out of an environment
# summary; counting needs a full `ls()`, which a caller that summarizes many
# values cannot afford.
.jdv_tree_summary <- function(
  x,
  depth = 0L,
  info = .jdv_tree_info(x),
  count_environment = TRUE
) {
  type <- info$type
  class_text <- .jdv_tree_class_text(info)
  list_format <- .jdv_tree_has_list_format(x, info)
  if (list_format && depth >= 3L) {
    return(enc2utf8(substr(class_text, 1L, .jdv_tree_text_limit)))
  }
  preview <- if (depth < 3L) {
    .jdv_tree_scalar_preview(x, info, list_format)
  } else {
    NULL
  }
  if (list_format) {
    if (is.null(preview$length)) {
      return(enc2utf8(substr(class_text, 1L, .jdv_tree_text_limit)))
    }
    count <- preview$length
    unit <- if (count == 1) "value" else "values"
    text <- paste0(
      class_text,
      " (",
      format(count, scientific = FALSE),
      " ",
      unit,
      ")"
    )
    if (length(preview$values)) {
      text <- paste0(text, ": ", paste(preview$values, collapse = ", "))
    }
    return(enc2utf8(substr(text, 1L, .jdv_tree_text_limit)))
  }
  if (identical(type, "environment") && !count_environment) {
    return(enc2utf8(substr(class_text, 1L, .jdv_tree_text_limit)))
  }
  count <- if (identical(type, "environment")) {
    length(base::ls(envir = x, all.names = TRUE))
  } else {
    max(0, info$length)
  }
  text <- paste0(class_text, " (", format(count, scientific = FALSE), ")")
  if (!is.null(preview) && length(preview)) {
    text <- paste0(text, ": ", paste(preview, collapse = ", "))
  }
  enc2utf8(substr(text, 1L, .jdv_tree_text_limit))
}

.jdv_tree_child_names <- function(x, type) {
  if (identical(type, "environment")) {
    return(base::ls(envir = x, all.names = TRUE))
  }
  if (identical(type, "s4")) {
    return(.jdv_tree_names(x))
  }
  if (type %in% c("list", "expression", "pairlist", "dots")) {
    count <- .jdv_tree_info(x)$length
    if (count <= 0 || count > .Machine$integer.max) {
      return(character())
    }
    return(as.character(seq_len(as.integer(count))))
  }
  if (
    type %in% c("logical", "integer", "double", "complex", "character", "raw")
  ) {
    count <- .jdv_tree_info(x)$length
    if (count <= 0 || count > .Machine$integer.max) {
      return(character())
    }
    return(as.character(seq_len(as.integer(count))))
  }
  .jdv_tree_names(x)
}

# Attribute children are listed after the elements. Environment bindings and
# S4 slots are the content of those objects, so `attributes` does not hide them.
.jdv_tree_total <- function(
  x,
  type,
  attributes = TRUE,
  info = .jdv_tree_info(x)
) {
  if (identical(type, "environment")) {
    return(length(base::ls(envir = x, all.names = TRUE)))
  }
  show_names <- attributes || identical(type, "s4")
  storage_type <- .jdv_tree_storage_type(info)
  if (
    storage_type %in%
      c("list", "expression", "pairlist", "dots", .jdv_tree_atomic_types)
  ) {
    n <- info$length
    if (n < 0) {
      query_error(
        "limit_exceeded",
        "Pairlist is cyclic or exceeds the safe traversal limit."
      )
    }
    return(n + if (show_names) length(.jdv_tree_names(x)) else 0L)
  }
  if (show_names) length(.jdv_tree_names(x)) else 0L
}

# Elements of an atomic vector are leaves, and a single unattributed element
# is fully described by its parent's summary.
.jdv_tree_has_children <- function(x, info, attributes, depth) {
  if (depth >= .jdv_tree_path_limit) {
    return(FALSE)
  }
  if (info$type %in% .jdv_tree_atomic_types) {
    return(info$length > 1 || (attributes && length(.jdv_tree_names(x)) > 0L))
  }
  .jdv_tree_total(x, info$type, attributes, info) > 0L
}

.jdv_tree_step_for <- function(x, type, label, index) {
  if (identical(type, "environment")) {
    return(list(type = "binding", name = label))
  }
  if (identical(type, "s4")) {
    return(list(type = "slot", name = label))
  }
  list(type = "attr", name = label)
}

# Cheap constructors for pages of trusted, internally built values.
.jdv_tree_object <- function(x) {
  class(x) <- "jdv_json_object"
  x
}

.jdv_tree_array <- function(x) {
  class(x) <- "jdv_json_array"
  x
}

# Children for the elements of an atomic vector are leaves. The whole page is
# read and formatted at once instead of resolving each element on its own.
.jdv_tree_atomic_children <- function(x, info, path, indices, labels) {
  texts <- tryCatch(
    .jdv_tree_element_text(x, info, indices[[1L]], length(indices)),
    error = function(error) NULL
  )
  # An element is a plain scalar: it keeps the class attribute but not dim.
  class_json <- .jdv_tree_class(list(
    class = info$class,
    type = info$type,
    is_matrix = FALSE
  ))
  type <- .jdv_tree_typeof(info)
  class_text <- .jdv_tree_class_text(info)
  prefix <- lapply(path, jdv_json_object)
  lapply(seq_along(indices), function(k) {
    i <- indices[[k]]
    child <- list(
      index = as.double(i),
      label = enc2utf8(substr(labels[[k]], 1L, .jdv_tree_text_limit)),
      class = class_json,
      type = type,
      summary = if (is.null(texts)) {
        "unavailable"
      } else {
        enc2utf8(substr(
          paste0(class_text, " (1): ", texts[[k]]),
          1L,
          .jdv_tree_text_limit
        ))
      },
      has_children = FALSE,
      viewable = !is.null(texts),
      path = .jdv_tree_array(c(
        prefix,
        list(.jdv_tree_object(list(type = "index", index = i)))
      ))
    )
    if (is.null(texts)) child$unavailable <- "unavailable"
    child
  })
}

# Read one environment binding without evaluating it, through the same C path
# as object paths and binding tracking. The status is value, forced, delayed,
# active, missing, unbound, opaque, or error; only value and forced carry an
# object.
.jdv_tree_binding_read <- function(env, name) {
  tryCatch(
    .Call(C_jdv_tree_child, env, "binding", 0, name),
    error = function(error) list(status = "error", value = NULL)
  )
}

# The token that explains why a child read with `status` cannot be opened, or
# NULL when the status carries an object.
.jdv_tree_unavailable_token <- function(status, name_too_long = FALSE) {
  if (identical(status, "value") || identical(status, "forced")) {
    return(NULL)
  }
  switch(
    status,
    unavailable = if (name_too_long) "path_limit" else "unavailable",
    delayed = "delayed_binding",
    active = "active_binding",
    missing = "missing_binding",
    unbound = "unavailable",
    s4_data_opaque = "opaque_data_slot",
    promise = "promise",
    error = "unavailable",
    "unavailable"
  )
}

.jdv_tree_list_children <- function(
  x,
  path,
  offset,
  limit,
  ancestry = list(),
  attributes = TRUE
) {
  info <- .jdv_tree_info(x)
  storage_type <- .jdv_tree_storage_type(info)
  vector_like <- storage_type %in%
    c("list", "expression", "pairlist", "dots", .jdv_tree_atomic_types)
  base_length <- max(0, info$length)
  total <- .jdv_tree_total(x, info$type, attributes, info)
  start <- min(offset, total)
  indices <- if (start >= total || limit == 0L) {
    integer()
  } else {
    seq.int(start + 1L, min(total, start + limit))
  }
  labels <- if (identical(info$type, "environment")) {
    names <- .jdv_tree_child_names(x, info$type)
    if (!length(indices)) character() else names[indices]
  } else if (vector_like) {
    element_idx <- indices[indices <= base_length]
    out <- if (length(element_idx)) {
      paste0("[", element_idx, "]")
    } else {
      character()
    }
    vector_names <- tryCatch(
      .jdv_tree_vector_names(x, element_idx),
      error = function(error) character()
    )
    if (length(vector_names) == length(element_idx)) {
      named <- !is.na(vector_names)
      out[named] <- vector_names[named]
    }
    extra <- indices[indices > base_length]
    if (length(extra)) {
      out <- c(out, .jdv_tree_names(x)[extra - base_length])
    }
    out
  } else {
    names <- .jdv_tree_child_names(x, info$type)
    if (!length(indices)) character() else names[indices]
  }
  build_child <- function(i) {
    label <- labels[[i - start]]
    indexed <- vector_like && i <= base_length
    step <- if (indexed) {
      list(type = "index", index = i)
    } else {
      .jdv_tree_step_for(x, info$type, label, i)
    }
    child_path <- c(path, list(step))
    name_too_long <- !identical(step$type, "index") &&
      nchar(step$name, type = "chars") > .jdv_tree_text_limit
    got <- if (name_too_long) {
      list(status = "unavailable", value = NULL)
    } else {
      tryCatch(
        .Call(
          C_jdv_tree_child,
          x,
          step$type,
          if (identical(step$type, "index")) as.double(step$index) else 0,
          if (!identical(step$type, "index")) step$name else ""
        ),
        error = function(error) list(status = "error", value = NULL)
      )
    }
    unavailable <- .jdv_tree_unavailable_token(got$status, name_too_long)
    child_value <- got$value
    child_info <- NULL
    cycle <- is.null(unavailable) &&
      any(vapply(
        c(ancestry, list(x)),
        function(previous) .jdv_tree_same_reference(child_value, previous),
        logical(1L)
      ))
    if (cycle) {
      unavailable <- "cycle"
    }
    summary <- unavailable
    has_children <- FALSE
    if (is.null(unavailable)) {
      metadata <- tryCatch(
        {
          child_info <- .jdv_tree_info(child_value)
          list(
            summary = .jdv_tree_summary(
              child_value,
              length(child_path),
              child_info
            ),
            has_children = .jdv_tree_has_children(
              child_value,
              child_info,
              attributes,
              length(child_path)
            )
          )
        },
        error = function(error) NULL
      )
      if (is.null(metadata)) {
        unavailable <- "unavailable"
        summary <- unavailable
        child_info <- NULL
      } else {
        summary <- metadata$summary
        has_children <- metadata$has_children
      }
    }
    child <- list(
      index = as.double(i),
      label = enc2utf8(substr(label, 1L, .jdv_tree_text_limit)),
      class = if (is.null(child_info)) {
        .jdv_json_values(list())
      } else {
        .jdv_tree_class(child_info)
      },
      type = if (is.null(child_info)) NULL else .jdv_tree_typeof(child_info),
      summary = enc2utf8(substr(summary, 1L, .jdv_tree_text_limit)),
      has_children = has_children,
      viewable = is.null(unavailable)
    )
    if (is.null(child_info)) {
      child$type <- NULL
    }
    if (!name_too_long) {
      child$path <- .jdv_json_values(lapply(child_path, jdv_json_object))
    }
    if (!is.null(unavailable)) child$unavailable <- unavailable
    child
  }
  atomic <- info$type %in% .jdv_tree_atomic_types
  elements <- if (atomic) indices[indices <= base_length] else indices[0L]
  others <- indices[!indices %in% elements]
  children <- c(
    if (length(elements)) {
      .jdv_tree_atomic_children(
        x,
        info,
        path,
        elements,
        labels[elements - start]
      )
    },
    lapply(others, build_child)
  )
  list(
    children = .jdv_tree_array(lapply(children, .jdv_tree_object)),
    total_children = as.double(total)
  )
}

.jdv_tree_entry_is_current <- function(entry) {
  exists(entry$id, envir = .jdv_state$entries, inherits = FALSE) &&
    identical(
      get(entry$id, envir = .jdv_state$entries, inherits = FALSE),
      entry
    ) &&
    !entry$closed
}

.jdv_tree_descendant_count <- function(entry) {
  ids <- entry$children %||% character()
  total <- 0L
  for (id in ids) {
    if (!exists(id, envir = .jdv_state$entries, inherits = FALSE)) {
      next
    }
    child <- get(id, envir = .jdv_state$entries, inherits = FALSE)
    if (
      isTRUE(child$closed) ||
        !identical(child$parent_entry, entry) ||
        !identical(child$parent_generation, entry$generation)
    ) {
      next
    }
    total <- total + 1L + .jdv_tree_descendant_count(child)
  }
  total
}

.jdv_tree_descriptor <- function(
  id,
  generation,
  title,
  parent = NULL,
  value = NULL,
  reason = "register",
  tracking = NULL
) {
  capabilities <- stats::setNames(
    as.list(c(
      TRUE,
      FALSE,
      FALSE,
      TRUE,
      FALSE,
      TRUE,
      TRUE,
      .jdv_track_capability(tracking)
    )),
    c(
      "seek",
      "sort",
      "filter",
      "known_total",
      "next",
      "children",
      "refresh",
      "track"
    )
  )
  params <- list(
    view = id,
    kind = "tree",
    access = "random",
    encoding = "jdv-json",
    capabilities = jdv_json_object(capabilities),
    generation = generation,
    title = title,
    reason = reason,
    path = jdv_json_array()
  )
  info <- .jdv_tree_info(value)
  params$class <- .jdv_tree_class(info)
  params$type <- .jdv_tree_typeof(info)
  if (!is.null(parent)) {
    params$parent <- parent$id
  }
  if (!is.null(tracking)) {
    params$tracking <- tracking
  }
  list(method = "view/open", params = jdv_json_object(params))
}

.jdv_tree_new_entry <- function(
  x,
  id,
  generation,
  title,
  parent = NULL,
  sequence = NULL
) {
  entry <- new.env(parent = emptyenv())
  entry$id <- id
  entry$title <- title
  entry$generation <- generation
  entry$mode <- "tree"
  entry$source <- x
  entry$tree_value <- x
  entry$captured <- x
  entry$holder <- NULL
  entry$fingerprint <- NULL
  entry$nrow <- NULL
  entry$ncol <- NULL
  entry$schema <- NULL
  entry$collation <- NULL
  entry$parent <- if (is.null(parent)) NULL else parent$id
  entry$parent_entry <- parent
  entry$parent_generation <- if (is.null(parent)) NULL else parent$generation
  entry$children <- character()
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

.jdv_tree_register <- function(
  x,
  title = NULL,
  parent = NULL,
  reason = "register",
  tracking = NULL,
  title_slot = TRUE
) {
  .jdv_assert_active()
  if (!is.null(title)) {
    title <- query_string(title, 4096L)
  }
  # A child's title, or a title with `title_slot = FALSE`, is a display name
  # only; it never takes a title slot.
  title_key <- if (is.null(title) || !is.null(parent) || !title_slot) {
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
  id <- if (!is.null(previous)) {
    previous$id
  } else {
    paste0(
      "v-",
      format(.jdv_state$next_id + 1, scientific = FALSE, trim = TRUE)
    )
  }
  generation <- if (is.null(previous)) 1 else previous$generation + 1
  if (!is.null(parent)) {
    if (!.jdv_tree_entry_is_current(parent)) {
      query_error("view_not_found", "Parent view is no longer active.")
    }
    if (
      .jdv_tree_descendant_count(.jdv_tree_lineage_root(parent)) >=
        .jdv_tree_children_limit
    ) {
      query_error(
        "limit_exceeded",
        "Parent view already has the maximum number of children."
      )
    }
  }
  descriptor <- .jdv_tree_descriptor(
    id,
    generation,
    title,
    parent,
    x,
    reason,
    tracking
  )
  open <- .jdv_json_encode(descriptor, .jdv_max_message_bytes())
  .jdv_assert_active()

  if (
    !is.null(previous) &&
      exists(id, envir = .jdv_state$entries, inherits = FALSE)
  ) {
    old <- get(id, envir = .jdv_state$entries, inherits = FALSE)
    .jdv_close_children(old, notify = TRUE)
    .jdv_close_entry(old)
  }
  pins <- character()
  cursor <- parent
  while (!is.null(cursor)) {
    pins <- c(pins, cursor$id)
    cursor <- cursor$parent_entry
  }
  max_tables <- .jdv_option_limit("jdv.max_tables", 64)
  active <- length(ls(.jdv_state$entries, all.names = TRUE))
  while (
    active >= max_tables &&
      !exists(id, envir = .jdv_state$entries, inherits = FALSE)
  ) {
    candidates <- lapply(
      setdiff(ls(.jdv_state$entries, all.names = TRUE), c(id, pins)),
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
    active <- length(ls(.jdv_state$entries, all.names = TRUE))
  }
  .jdv_assert_active()
  if (!is.null(parent) && !.jdv_tree_entry_is_current(parent)) {
    query_error(
      "view_not_found",
      "Parent view was closed while opening the child."
    )
  }

  entry <- .jdv_tree_new_entry(x, id, generation, title, parent)
  if (is.null(previous)) {
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
  if (!is.null(parent)) {
    if (
      !.jdv_tree_entry_is_current(parent) ||
        !identical(parent$generation, entry$parent_generation) ||
        .jdv_tree_descendant_count(.jdv_tree_lineage_root(parent)) >=
          .jdv_tree_children_limit
    ) {
      .jdv_close_internal(id, expected = entry)
      query_error(
        "view_not_found",
        "Parent view changed while opening the child."
      )
    }
    parent$children <- c(parent$children, id)
  }
  list(id = id, generation = generation, open = open, descriptor = descriptor)
}

.jdv_tree_register_child <- function(
  x,
  parent,
  mode = "auto",
  collation = NULL,
  title = NULL
) {
  .jdv_assert_not_refreshing()
  if (!.jdv_tree_entry_is_current(parent)) {
    query_error("view_not_found", "Parent view is no longer active.")
  }
  if (
    .jdv_tree_descendant_count(.jdv_tree_lineage_root(parent)) >=
      .jdv_tree_children_limit
  ) {
    query_error(
      "limit_exceeded",
      "Parent view already has the maximum number of children."
    )
  }
  source <- jdv_source(x)
  if (identical(source$kind, "tree")) {
    return(.jdv_tree_register(
      source$data,
      title = title,
      parent = parent,
      reason = "child"
    ))
  }

  old_pins <- .jdv_state$eviction_pins
  cursor <- parent
  while (!is.null(cursor)) {
    .jdv_state$eviction_pins <- unique(c(.jdv_state$eviction_pins, cursor$id))
    cursor <- cursor$parent_entry
  }
  on.exit(.jdv_state$eviction_pins <- old_pins, add = TRUE)
  registered <- .jdv_register_internal(
    x,
    title = NULL,
    mode = mode,
    collation = collation,
    emit = FALSE,
    reason = "child"
  )
  child <- get(registered$id, envir = .jdv_state$entries, inherits = FALSE)
  committed <- FALSE
  on.exit(
    if (!committed) .jdv_close_internal(child$id, expected = child),
    add = TRUE
  )
  if (
    !.jdv_tree_entry_is_current(parent) ||
      .jdv_tree_descendant_count(.jdv_tree_lineage_root(parent)) >=
        .jdv_tree_children_limit
  ) {
    query_error(
      "view_not_found",
      "Parent view changed while opening the child."
    )
  }
  child$parent <- parent$id
  child$parent_entry <- parent
  child$parent_generation <- parent$generation
  child$children <- character()
  child$path <- list()
  child$title <- title
  parsed <- .jdv_json_parse(
    registered$open,
    limit = max(1024, .jdv_max_message_bytes())
  )
  if (!is.null(title)) {
    parsed$params$title <- title
  }
  parsed$params$parent <- parent$id
  parsed$params$path <- jdv_json_array()
  registered$open <- .jdv_json_encode(parsed)
  if (
    !.jdv_tree_entry_is_current(parent) ||
      !identical(parent$generation, child$parent_generation)
  ) {
    query_error(
      "view_not_found",
      "Parent view changed while opening the child."
    )
  }
  parent$children <- c(parent$children, child$id)
  committed <- TRUE
  registered
}

.jdv_tree_lineage_root <- function(entry) {
  cursor <- entry
  repeat {
    if (!.jdv_tree_entry_is_current(cursor)) {
      query_error("view_not_found", "Parent lineage is no longer active.")
    }
    parent <- cursor$parent_entry
    if (is.null(parent)) {
      return(cursor)
    }
    if (!identical(cursor$parent_generation, parent$generation)) {
      query_error("stale_generation", "Parent lineage generation changed.")
    }
    cursor <- parent
  }
}
