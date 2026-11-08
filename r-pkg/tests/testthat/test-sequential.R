sequential_fixture <- function(.env = parent.frame()) {
  state <- new.env(parent = emptyenv())
  state$tokens <- list()
  state$calls <- 0L
  state$released <- 0L
  state$busy <- FALSE
  state$failure <- NULL
  state$on_page <- NULL
  state$on_release <- NULL
  local_mocked_bindings(
    .jdv_sequential_acquire = function(x) {
      token <- new.env(parent = emptyenv())
      token$seen <- 0
      token$closed <- FALSE
      state$tokens[[length(state$tokens) + 1L]] <- token
      token
    },
    .jdv_sequential_open = function(token) {
      list(
        columns = list(
          list(
            index = 0,
            name = "duplicate",
            type = "int64",
            unsupported = NULL,
            ipc_index = 0
          ),
          list(
            index = 1,
            name = "duplicate",
            type = "union",
            unsupported = "union",
            ipc_index = NULL
          )
        )
      )
    },
    .jdv_sequential_page = function(token, max_rows, max_bytes) {
      state$calls <- state$calls + 1L
      state$busy <- TRUE
      on.exit(state$busy <- FALSE, add = TRUE)
      if (is.function(state$on_page)) {
        state$on_page()
      }
      if (!is.null(state$failure)) {
        stop(state$failure)
      }
      first <- token$seen
      count <- min(max_rows, max(0, 5 - first))
      token$seen <- first + count
      list(
        payload = as.raw(c(1, 2)),
        first_row = first,
        rows_fetched = count,
        rows_seen = token$seen,
        done = count == 0
      )
    },
    .jdv_sequential_can_release = function() !state$busy,
    .jdv_sequential_release_token = function(token) {
      if (token$closed) {
        stop("double release")
      }
      token$closed <- TRUE
      state$released <- state$released + 1L
      state$busy <- TRUE
      on.exit(state$busy <- FALSE, add = TRUE)
      if (is.function(state$on_release)) state$on_release()
      TRUE
    },
    .package = "jdv",
    .env = .env
  )
  state
}

sequential_request <- function(
  view,
  params = list(),
  public = FALSE,
  method = "stream/next"
) {
  request <- .jdv_json_encode(list(
    id = "next",
    method = method,
    params = c(
      list(view = view$id, generation = view$generation %||% 1),
      params
    )
  ))
  if (public) {
    jdv_rpc(request)
  } else {
    .jdv_rpc_internal(request, allow_binary = TRUE)
  }
}
sequential_error <- function(value) .jdv_json_parse(value)$error$code

# The backend is tested independently of producer S3 dispatch and native IPC.
test_that(
  "sequential registration is schema-only and public RPC cannot consume",
  {
    state <- sequential_fixture()
    on.exit(.jdv_close_internal(notify = FALSE), add = TRUE)
    view <- .jdv_sequential_register(NULL)
    descriptor <- .jdv_json_parse(view$open)$params
    expect_identical(descriptor$kind, "grid")
    expect_identical(descriptor$access, "sequential")
    expect_identical(descriptor$encoding, "arrow-ipc")
    expect_false(descriptor$capabilities$known_total)
    expect_true(descriptor$capabilities[["next"]])
    expect_false(descriptor$capabilities$refresh)
    expect_null(descriptor$nrow)
    expect_identical(descriptor$ncol, 2)
    expect_null(descriptor$mapping)
    expect_null(descriptor$schema)
    expect_identical(
      vapply(
        descriptor$columns,
        function(column) {
          if (is.null(column$ipc_index)) {
            NA_integer_
          } else {
            as.integer(column$ipc_index)
          }
        },
        integer(1L)
      ),
      c(0L, NA_integer_)
    )
    expect_identical(descriptor$columns[[2L]]$unsupported, "union")
    entry <- get(view$id, .jdv_state$entries)
    expect_null(entry$source)
    expect_null(entry$holder)
    expect_identical(state$calls, 0L)
    expect_identical(
      sequential_error(sequential_request(view, public = TRUE)),
      "unsupported"
    )
    expect_identical(state$calls, 0L)
    first <- sequential_request(view, list(max_rows = 2))
    expect_s3_class(first, "jdv_binary_packet")
    result <- .jdv_json_parse(first$header)$result
    expect_identical(result$first_row, 0)
    expect_identical(result$rows_fetched, 2)
    expect_identical(result$rows_seen, 2)
    expect_false(result$done)
    invisible(sequential_request(view, list(max_rows = 3)))
    last <- .jdv_json_parse(sequential_request(view)$header)$result
    expect_identical(last$first_row, 5)
    expect_identical(last$rows_fetched, 0)
    expect_true(last$done)
  }
)

test_that("sequential validation and recoverable errors preserve the stream", {
  state <- sequential_fixture()
  on.exit(.jdv_close_internal(notify = FALSE), add = TRUE)
  view <- .jdv_sequential_register(NULL)
  for (params in list(
    list(offset = 0),
    list(sort = list()),
    list(filter = NULL),
    list(count = TRUE),
    list(max_rows = 0),
    list(max_rows = 2001),
    list(max_rows = "2"),
    list(max_bytes = NULL)
  )) {
    expect_identical(
      sequential_error(sequential_request(view, params)),
      "invalid_request"
    )
  }
  expect_identical(state$calls, 0L)
  expect_identical(
    sequential_error(sequential_request(view, list(max_bytes = 0))),
    "limit_exceeded"
  )
  expect_identical(state$calls, 0L)
  state$failure <- structure(
    list(
      message = "retry encoding",
      call = NULL,
      code = "producer_error",
      terminal = FALSE
    ),
    class = c("jdv_stream_error", "error", "condition")
  )
  expect_identical(sequential_error(sequential_request(view)), "producer_error")
  expect_identical(state$released, 0L)
  state$failure <- NULL
  expect_s3_class(sequential_request(view), "jdv_binary_packet")
  expect_identical(
    sequential_error(sequential_request(view, method = "grid/rows")),
    "unsupported"
  )
  schema <- .jdv_json_parse(sequential_request(
    view,
    method = "view/schema"
  ))$result
  expect_null(schema$schema)
  expect_null(schema$mapping)
  expect_identical(schema$columns[[1L]]$ipc_index, 0)
})

test_that("terminal stream errors release once and retain the failure reason", {
  state <- sequential_fixture()
  on.exit(.jdv_close_internal(notify = FALSE), add = TRUE)
  view <- .jdv_sequential_register(NULL)
  state$failure <- structure(
    list(
      message = "one row exceeds budget",
      call = NULL,
      code = "limit_exceeded",
      terminal = TRUE
    ),
    class = c("jdv_stream_error", "error", "condition")
  )
  expect_identical(sequential_error(sequential_request(view)), "limit_exceeded")
  expect_identical(state$released, 1L)
  expect_identical(sequential_error(sequential_request(view)), "stream_failed")
  expect_identical(state$calls, 1L)
  .jdv_close_internal(view$id)
  expect_identical(state$released, 1L)
})

test_that("a display-only title never takes a title slot", {
  sequential_fixture()
  on.exit(.jdv_close_internal(notify = FALSE), add = TRUE)
  held <- .jdv_sequential_register(NULL, title = "stream")
  first <- .jdv_sequential_register(NULL, title = "stream", title_slot = FALSE)
  second <- .jdv_sequential_register(NULL, title = "stream", title_slot = FALSE)
  expect_false(first$id %in% c(held$id, second$id))
  expect_true(exists(held$id, envir = .jdv_state$entries))
  expect_identical(.jdv_json_parse(second$open)$params$title, "stream")
})

test_that("replacement, eviction and deferred release follow view lifetime", {
  state <- sequential_fixture()
  on.exit(.jdv_close_internal(notify = FALSE), add = TRUE)
  first <- .jdv_sequential_register(NULL, title = "stream")
  second <- .jdv_sequential_register(NULL, title = "stream")
  expect_identical(first$id, second$id)
  expect_identical(state$released, 1L)
  expect_identical(
    sequential_error(sequential_request(first)),
    "stale_generation"
  )
  other <- .jdv_sequential_register(NULL)
  state$on_page <- function() .jdv_close_internal(other$id)
  expect_s3_class(
    sequential_request(list(id = second$id, generation = 2)),
    "jdv_binary_packet"
  )
  expect_identical(state$released, 2L)
  expect_length(.jdv_state$sequential_releases, 0L)
  state$on_page <- NULL
  state$on_release <- function() .jdv_close_internal(notify = FALSE)
  .jdv_close_internal(second$id)
  expect_identical(state$released, 3L)
  expect_length(.jdv_state$sequential_releases, 0L)
})

test_that(
  "a close or generation change during next cannot publish stale bytes",
  {
    state <- sequential_fixture()
    on.exit(.jdv_close_internal(notify = FALSE), add = TRUE)
    view <- .jdv_sequential_register(NULL, title = "live")
    state$on_page <- function() .jdv_close_internal(view$id)
    expect_identical(
      sequential_error(sequential_request(view)),
      "view_not_found"
    )
    expect_identical(state$released, 1L)
    state$on_page <- NULL
    view <- .jdv_sequential_register(NULL, title = "new")
    state$on_page <- function() register_view(list(value = 1), title = "new")
    expect_identical(
      sequential_error(sequential_request(view)),
      "stale_generation"
    )
    expect_identical(state$released, 2L)
  }
)

test_that("schema and descriptor failures release staged streams without replacing a view", {
  state <- sequential_fixture()
  on.exit(.jdv_close_internal(notify = FALSE), add = TRUE)
  view <- .jdv_sequential_register(NULL, title = "retained")
  local_mocked_bindings(
    .jdv_sequential_open = function(token) stop("schema failed"),
    .package = "jdv"
  )
  expect_error(
    .jdv_sequential_register(NULL, title = "retained"),
    "schema failed"
  )
  expect_identical(state$released, 1L)
  expect_false(state$tokens[[1L]]$closed)
  expect_identical(get(view$id, .jdv_state$entries)$generation, 1)
})

test_that("eviction and mixed tree cascades release stream children once", {
  state <- sequential_fixture()
  on.exit(.jdv_close_internal(notify = FALSE), add = TRUE)
  old <- options(jdv.max_tables = 2L)
  on.exit(options(old), add = TRUE)
  first <- .jdv_sequential_register(NULL)
  second <- .jdv_sequential_register(NULL)
  third <- .jdv_sequential_register(NULL)
  expect_true(state$tokens[[1L]]$closed)
  expect_false(exists(first$id, .jdv_state$entries))
  expect_identical(state$released, 1L)
  .jdv_close_internal(notify = FALSE)
  original_source <- jdv_source
  local_mocked_bindings(
    jdv_source = function(x, ...) {
      if (inherits(x, "jdvSequentialFixture")) {
        list(kind = "grid", access = "sequential", data = x)
      } else {
        original_source(x, ...)
      }
    },
    .package = "jdv"
  )
  parent <- register_view(list(
    child = structure(list(), class = "jdvSequentialFixture")
  ))
  response <- .jdv_json_parse(jdv_rpc(.jdv_json_encode(list(
    id = 1,
    method = "object/open",
    params = list(
      view = parent$id,
      generation = 1,
      path = list(list(type = "index", index = 1))
    )
  ))))
  expect_identical(response$result$access, "sequential")
  expect_identical(response$result$parent, parent$id)
  .jdv_close_internal(parent$id)
  expect_identical(state$released, 4L)
  expect_length(ls(.jdv_state$entries), 0L)
})

test_that(
  "descriptor callbacks cannot publish a duplicate or reversed generation",
  {
    state <- sequential_fixture()
    on.exit(.jdv_close_internal(notify = FALSE), add = TRUE)
    first <- .jdv_sequential_register(NULL, title = "transaction")
    original_encode <- .jdv_json_encode
    changed <- FALSE
    local_mocked_bindings(
      .jdv_json_encode = function(x, ...) {
        if (
          !changed &&
            identical(x$method, "view/open") &&
            identical(x$params$access, "sequential")
        ) {
          changed <<- TRUE
          register_view(list(intervening = 1), title = "transaction")
        }
        original_encode(x, ...)
      },
      .package = "jdv"
    )
    current <- .jdv_sequential_register(NULL, title = "transaction")
    expect_identical(current$id, first$id)
    expect_identical(.jdv_json_parse(current$open)$params$generation, 3)
    expect_identical(get(current$id, .jdv_state$entries)$generation, 3)
    expect_identical(state$released, 1L)
  }
)

test_that("eviction callbacks revalidate a title before committing a stream", {
  state <- sequential_fixture()
  on.exit(.jdv_close_internal(notify = FALSE), add = TRUE)
  old <- options(jdv.max_tables = 2L)
  on.exit(options(old), add = TRUE)
  .jdv_sequential_register(NULL, title = "anchor")
  register_view(list(other = 1), title = "other")
  state$on_release <- function() {
    state$on_release <- NULL
    register_view(list(intervening = 2), title = "target")
  }
  current <- .jdv_sequential_register(NULL, title = "target")
  expect_identical(.jdv_json_parse(current$open)$params$generation, 2)
  expect_identical(get(current$id, .jdv_state$entries)$mode, "sequential")
  expect_identical(state$released, 1L)
})

test_that(
  "release callbacks cannot return an already replaced or closed descriptor",
  {
    state <- sequential_fixture()
    on.exit(.jdv_close_internal(notify = FALSE), add = TRUE)
    for (replace in c(TRUE, FALSE)) {
      first <- .jdv_sequential_register(NULL, title = "release")
      state$on_release <- function() {
        state$on_release <- NULL
        if (replace) {
          register_view(list(replacement = 1), title = "release")
        } else {
          .jdv_close_internal(first$id)
        }
      }
      error <- tryCatch(
        .jdv_sequential_register(NULL, title = "release"),
        error = identity
      )
      expect_s3_class(error, "jdv_query_error")
      expect_identical(
        error$code,
        if (replace) "stale_generation" else "view_not_found"
      )
      if (replace) {
        expect_identical(get(first$id, .jdv_state$entries)$generation, 3)
        .jdv_close_internal(first$id)
      }
    }
    expect_identical(state$released, 4L)
    expect_length(.jdv_state$sequential_releases, 0L)
  }
)

test_that(
  "sequential descriptors retain the page row cap captured at registration",
  {
    state <- sequential_fixture()
    on.exit(.jdv_close_internal(notify = FALSE), add = TRUE)
    previous <- options(jdv.max_page_rows = 2501)
    on.exit(options(previous), add = TRUE)
    view <- .jdv_sequential_register(NULL)
    descriptor <- .jdv_json_parse(view$open)$params
    expect_identical(descriptor$max_page_rows, 2501)
    options(jdv.max_page_rows = 2000L)
    expect_identical(get(view$id, .jdv_state$entries)$page_rows, 2501)
    expect_identical(
      sequential_error(sequential_request(view, list(max_rows = 2502))),
      "invalid_request"
    )
    accepted <- sequential_request(view, list(max_rows = 2001))
    expect_s3_class(accepted, "jdv_binary_packet")
    expect_identical(.jdv_json_parse(accepted$header)$result$rows_fetched, 5)
    expect_identical(state$calls, 1L)
    page <- sequential_request(view)
    expect_s3_class(page, "jdv_binary_packet")
    expect_identical(.jdv_json_parse(page$header)$result$rows_fetched, 0)
    expect_identical(.jdv_json_parse(view$open)$params$max_page_rows, 2501)
    options(jdv.max_page_rows = 10000L)
    wide <- .jdv_sequential_register(NULL)
    expect_identical(.jdv_json_parse(wide$open)$params$max_page_rows, 10000)
    options(jdv.max_page_rows = 2^53)
    expect_error(.jdv_sequential_page_row_limit(), "Invalid option")
  }
)

test_that("a sequential view announces the register reason", {
  sequential_fixture()
  on.exit(.jdv_close_internal(notify = FALSE), add = TRUE)
  registered <- .jdv_sequential_register(NULL)
  expect_identical(.jdv_json_parse(registered$open)$params$reason, "register")
})

test_that("sequential RPC can return pages larger than 2000 rows", {
  skip_if_not_installed("nanoarrow")
  previous <- options(jdv.max_page_rows = 2101)
  on.exit(options(previous), add = TRUE)
  stream <- nanoarrow::as_nanoarrow_array_stream(data.frame(
    value = seq_len(2101L)
  ))
  view <- register_view(stream)
  on.exit(.jdv_close_internal(view$id), add = TRUE)
  descriptor <- .jdv_json_parse(view$open)$params
  expect_identical(descriptor$max_page_rows, 2101)
  response <- .jdv_rpc_internal(
    .jdv_json_encode(list(
      id = "large-page",
      method = "stream/next",
      params = list(
        view = view$id,
        generation = view$generation,
        max_rows = 2001
      )
    )),
    allow_binary = TRUE
  )
  expect_s3_class(response, "jdv_binary_packet")
  expect_identical(.jdv_json_parse(response$header)$result$rows_fetched, 2001)
  expect_identical(
    sequential_error(sequential_request(view, list(max_rows = 2102))),
    "invalid_request"
  )
})
