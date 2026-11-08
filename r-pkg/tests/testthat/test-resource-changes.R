# Change notifications of the resource tree. Bindings created by these tests
# start with "jdvchg_"; whatever else the global environment holds is stable
# while a test runs.

chg_session <- function(.env = parent.frame()) {
  skip_if_not_installed("withr")
  jdv_disconnect()
  withr::defer(jdv_disconnect(), envir = .env)
  first <- jdv_register(mtcars)
  jdv_close(first$id)
  jdv_notifications()
  invisible(NULL)
}

chg_assign <- function(..., .env = parent.frame()) {
  skip_if_not_installed("withr")
  values <- list(...)
  for (name in names(values)) {
    assign(name, values[[name]], envir = globalenv())
  }
  withr::defer(
    suppressWarnings(rm(list = names(values), envir = globalenv())),
    envir = .env
  )
  invisible(names(values))
}

chg_rpc <- function(method, params = NULL, id = "chg-1") {
  request <- list(id = id, method = method)
  if (!is.null(params)) {
    request$params <- if (length(params)) params else jdv_json_object()
  }
  .jdv_json_parse(jdv_rpc(.jdv_json_encode(request)))
}

chg_subscribe <- function(enabled = TRUE) {
  chg_rpc("resources/subscribe", list(enabled = enabled))
}

# Run one observation, as the task callback does, and return the methods of the
# notifications it queued.
chg_observe <- function() {
  jdv_rpc(NULL)
  vapply(
    lapply(jdv_notifications(), .jdv_json_parse),
    function(message) message$method,
    ""
  )
}

chg_hello <- function() {
  withr::local_options(list(jdv.resources = TRUE))
  jdv_disconnect()
  withr::defer(jdv_disconnect())
  jdv_register(mtcars)
  .jdv_json_parse(jdv_notifications()[[1L]])
}

test_that("hello declares resource_changes with resources", {
  skip_if_not_installed("withr")
  hello <- chg_hello()
  expect_identical(hello$method, "hello")
  expect_identical(
    unclass(hello$params$capabilities),
    list(resources = TRUE, resource_changes = TRUE)
  )
  withr::local_options(list(jdv.resources = FALSE))
  jdv_disconnect()
  jdv_register(mtcars)
  hello <- .jdv_json_parse(jdv_notifications()[[1L]])
  expect_null(hello$params$capabilities)
  response <- chg_subscribe()
  expect_identical(response$error$code, "unsupported")
  expect_false(isTRUE(.jdv_state$res_subscribed))
  jdv_disconnect()
})

test_that("subscribe validates enabled and is idempotent", {
  chg_session()
  for (params in list(
    list(),
    list(enabled = "true"),
    list(enabled = 1),
    list(enabled = NA),
    list(enabled = c(TRUE, FALSE)),
    list(other = TRUE)
  )) {
    response <- chg_rpc("resources/subscribe", params)
    expect_identical(response$error$code, "invalid_request")
  }
  expect_identical(chg_rpc("resources/subscribe")$error$code, "invalid_request")
  expect_false(.jdv_state$res_subscribed)

  # Unknown members are ignored.
  on <- chg_rpc("resources/subscribe", list(enabled = TRUE, extra = 1))
  expect_null(on$error)
  expect_true(on$result$enabled)
  expect_true(chg_subscribe(TRUE)$result$enabled)
  expect_true(.jdv_state$res_subscribed)
  off <- chg_subscribe(FALSE)
  expect_false(off$result$enabled)
  expect_false(chg_subscribe(FALSE)$result$enabled)
  expect_false(.jdv_state$res_subscribed)
  expect_null(.jdv_state$res_baseline)
})

test_that("a session starts unsubscribed and an ended session forgets it", {
  chg_session()
  expect_false(.jdv_state$res_subscribed)
  expect_null(.jdv_state$track_task_callback)
  chg_assign(jdvchg_a = 1)
  expect_identical(chg_observe(), character())

  expect_true(chg_subscribe()$result$enabled)
  expect_false(is.null(.jdv_state$track_task_callback))
  jdv_disconnect()
  expect_false(.jdv_state$res_subscribed)
  expect_null(.jdv_state$res_baseline)
  expect_false(.jdv_state$res_pending)
  expect_null(.jdv_state$track_task_callback)

  # A new session does not inherit the subscription.
  jdv_register(mtcars)
  jdv_notifications()
  expect_false(.jdv_state$res_subscribed)
  jdv_disconnect()
})

test_that("an unsubscribed session installs no watch and sends nothing", {
  chg_session()
  expect_null(.jdv_state$track_task_callback)
  chg_assign(jdvchg_a = 1)
  expect_identical(chg_observe(), character())
  assign("jdvchg_b", 2, envir = globalenv())
  withr::defer(suppressWarnings(rm("jdvchg_b", envir = globalenv())))
  expect_identical(chg_observe(), character())
  expect_false(.jdv_resources_poll())
  expect_null(.jdv_state$track_task_callback)

  chg_subscribe()
  chg_subscribe(FALSE)
  expect_null(.jdv_state$track_task_callback)
})

test_that("additions, removals, and listing changes are reported", {
  skip_if_not(.jdv_track_supported(), "reading bindings needs R 4.6.0 or later")
  chg_session()
  chg_assign(jdvchg_a = 1, jdvchg_df = mtcars)
  expect_true(chg_subscribe()$result$enabled)
  expect_identical(chg_observe(), character())

  assign("jdvchg_new", 1, envir = globalenv())
  withr::defer(suppressWarnings(rm("jdvchg_new", envir = globalenv())))
  expect_identical(chg_observe(), "resources/changed")
  expect_identical(chg_observe(), character())

  rm("jdvchg_new", envir = globalenv())
  expect_identical(chg_observe(), "resources/changed")

  assign("jdvchg_df", mtcars[1:3, ], envir = globalenv())
  expect_identical(chg_observe(), "resources/changed")
  assign("jdvchg_df", as.matrix(mtcars), envir = globalenv())
  expect_identical(chg_observe(), "resources/changed")
  assign("jdvchg_a", structure(1, class = "jdvchg_cls"), envir = globalenv())
  expect_identical(chg_observe(), "resources/changed")
  assign("jdvchg_a", "text", envir = globalenv())
  expect_identical(chg_observe(), "resources/changed")
  expect_identical(chg_observe(), character())
})

test_that("a promise that is forced changes the listing", {
  skip_if_not(.jdv_track_supported(), "reading bindings needs R 4.6.0 or later")
  chg_session()
  delayedAssign("jdvchg_p", mtcars, assign.env = globalenv())
  withr::defer(suppressWarnings(rm("jdvchg_p", envir = globalenv())))
  chg_subscribe()
  expect_identical(chg_observe(), character())
  force(get("jdvchg_p", envir = globalenv()))
  expect_identical(chg_observe(), "resources/changed")
})

test_that("a reassignment that lists the same is not reported", {
  skip_if_not(.jdv_track_supported(), "reading bindings needs R 4.6.0 or later")
  chg_session()
  chg_assign(jdvchg_x = 1)
  chg_subscribe()
  assign("jdvchg_x", 2, envir = globalenv())
  expect_identical(chg_observe(), character())
  assign("jdvchg_x", 3, envir = globalenv())
  expect_identical(chg_observe(), character())
})

test_that("watching evaluates no binding and calls no method", {
  chg_session()
  counter <- new.env()
  counter$active <- 0L
  counter$promise <- 0L
  counter$s3 <- 0L
  makeActiveBinding(
    "jdvchg_active",
    function() {
      counter$active <- counter$active + 1L
      1
    },
    globalenv()
  )
  delayedAssign(
    "jdvchg_promise",
    {
      counter$promise <- counter$promise + 1L
      1
    },
    assign.env = globalenv()
  )
  withr::defer(suppressWarnings(rm(
    list = c("jdvchg_active", "jdvchg_promise"),
    envir = globalenv()
  )))
  # Every generic the listing must not call counts a call.
  object <- structure(list(1, 2), class = "jdvchg_probe")
  local_mocked_s3 <- function() {
    for (generic in c("length", "dim", "names", "format", "print", "[")) {
      registerS3method(
        generic,
        "jdvchg_probe",
        function(x, ...) {
          counter$s3 <- counter$s3 + 1L
          NULL
        },
        envir = baseenv()
      )
    }
  }
  local_mocked_s3()
  chg_assign(jdvchg_obj = object)
  chg_subscribe()
  assign("jdvchg_obj2", object, envir = globalenv())
  withr::defer(suppressWarnings(rm("jdvchg_obj2", envir = globalenv())))
  expect_identical(chg_observe(), "resources/changed")
  expect_identical(counter$active, 0L)
  expect_identical(counter$promise, 0L)
  expect_identical(counter$s3, 0L)
})

test_that("undelivered notifications merge into one until taken", {
  chg_session()
  chg_subscribe()
  names <- paste0("jdvchg_m", seq_len(300))
  withr::defer(suppressWarnings(rm(list = names, envir = globalenv())))
  for (name in names) {
    assign(name, 1, envir = globalenv())
    jdv_rpc(NULL)
  }
  messages <- jdv_notifications()
  expect_length(messages, 1L)
  expect_identical(.jdv_json_parse(messages)$method, "resources/changed")
  expect_identical(.jdv_state$queue_bytes, 0)

  # Once taken, the next change is reported again.
  rm(list = names[[1L]], envir = globalenv())
  expect_identical(chg_observe(), "resources/changed")
})

test_that("merging keeps other notifications and the byte count", {
  chg_session()
  chg_assign(jdvchg_a = 1)
  chg_subscribe()
  expect_identical(chg_observe(), character())
  id <- jdv_register(mtcars)$id
  assign("jdvchg_b", 1, envir = globalenv())
  withr::defer(suppressWarnings(rm("jdvchg_b", envir = globalenv())))
  jdv_rpc(NULL)
  jdv_close(id)
  assign("jdvchg_c", 1, envir = globalenv())
  withr::defer(suppressWarnings(rm("jdvchg_c", envir = globalenv())))
  jdv_rpc(NULL)
  expect_true(.jdv_state$res_pending)
  bytes <- sum(nchar(unlist(.jdv_state$queue), type = "bytes"))
  expect_equal(.jdv_state$queue_bytes, bytes)
  methods <- vapply(
    lapply(jdv_notifications(), .jdv_json_parse),
    function(message) message$method,
    ""
  )
  expect_identical(methods, c("view/open", "resources/changed", "view/closed"))
  expect_false(.jdv_state$res_pending)
})

test_that("a changed notification does not use up the queue", {
  chg_session()
  withr::local_options(list(jdv.notification_max_messages = 4))
  jdv_disconnect()
  jdv_register(mtcars)
  jdv_notifications()
  chg_subscribe()
  for (i in 1:20) {
    assign(paste0("jdvchg_o", i), 1, envir = globalenv())
    expect_no_error(jdv_rpc(NULL))
  }
  withr::defer(suppressWarnings(rm(
    list = paste0("jdvchg_o", 1:20),
    envir = globalenv()
  )))
  expect_true(
    jdv_connection()$connected || jdv_connection()$owner == "embedded"
  )
  expect_length(jdv_notifications(), 1L)
})

test_that("an overflow ends the subscription with the session", {
  chg_session()
  chg_subscribe()
  expect_false(is.null(.jdv_state$track_task_callback))
  chg_assign(jdvchg_a = 1)
  withr::local_options(list(jdv.notification_max_messages = 1))
  .jdv_queue_reset(.jdv_notification_limits())
  .jdv_notify("{}")
  assign("jdvchg_b", 1, envir = globalenv())
  withr::defer(suppressWarnings(rm("jdvchg_b", envir = globalenv())))
  expect_error(jdv_rpc(NULL), class = "jdv_notification_overflow")
  expect_false(.jdv_state$res_subscribed)
  expect_null(.jdv_state$res_baseline)
  expect_null(.jdv_state$track_task_callback)
})

test_that("the poll waits while a request or refresh runs", {
  chg_session()
  chg_subscribe()
  chg_assign(jdvchg_a = 1)
  .jdv_state$rpc_depth <- 1L
  expect_false(.jdv_resources_poll())
  .jdv_state$rpc_depth <- 0L
  .jdv_state$refreshing <- TRUE
  expect_false(.jdv_resources_poll())
  .jdv_state$refreshing <- FALSE
  .jdv_state$unloading <- TRUE
  expect_false(.jdv_resources_poll())
  .jdv_state$unloading <- FALSE
  expect_identical(jdv_notifications(), character())
  expect_true(.jdv_resources_poll())
  expect_identical(
    vapply(
      lapply(jdv_notifications(), .jdv_json_parse),
      function(message) message$method,
      ""
    ),
    "resources/changed"
  )
})

test_that("a failed task is observed like a successful one", {
  chg_session()
  chg_assign(jdvchg_a = 1)
  chg_subscribe()
  expect_true(.jdv_track_task_callback(NULL, NULL, FALSE, FALSE))
  expect_false(.jdv_state$res_pending)
  assign("jdvchg_f", 1, envir = globalenv())
  withr::defer(suppressWarnings(rm("jdvchg_f", envir = globalenv())))
  expect_true(.jdv_track_task_callback(NULL, NULL, FALSE, FALSE))
  expect_true(.jdv_state$res_pending)
  expect_length(jdv_notifications(), 1L)
})

test_that("an older R reports name and state changes", {
  chg_session()
  local_mocked_bindings(
    .jdv_tree_binding_read = function(env, name) {
      if (identical(name, "jdvchg_state")) {
        list(status = getOption("jdvchg.status", "opaque"), value = NULL)
      } else {
        list(status = "opaque", value = NULL)
      }
    }
  )
  chg_assign(jdvchg_state = 1)
  chg_subscribe()
  expect_identical(chg_observe(), character())
  withr::local_options(list(jdvchg.status = "active"))
  expect_identical(chg_observe(), "resources/changed")
  assign("jdvchg_added", 1, envir = globalenv())
  withr::defer(suppressWarnings(rm("jdvchg_added", envir = globalenv())))
  expect_identical(chg_observe(), "resources/changed")
  rm("jdvchg_added", envir = globalenv())
  expect_identical(chg_observe(), "resources/changed")
})

track_chg_register <- function(env, name = "x") {
  assign(name, mtcars, envir = env)
  jdv_register(get(name, envir = env), binding = list(name = name, env = env))
}

test_that("subscription and tracking share one callback", {
  skip_if_not(.jdv_track_supported(), "tracking needs R 4.6.0 or later")
  chg_session()
  env <- new.env()

  # Subscription only: the callback watches without any tracked view.
  chg_subscribe()
  name <- .jdv_state$track_task_callback
  expect_true(name %in% getTaskCallbackNames())
  assign("jdvchg_s", 1, envir = globalenv())
  withr::defer(suppressWarnings(rm("jdvchg_s", envir = globalenv())))
  expect_true(.jdv_track_task_callback(NULL, NULL, TRUE, FALSE))
  expect_identical(
    vapply(
      lapply(jdv_notifications(), .jdv_json_parse),
      function(message) message$method,
      ""
    ),
    "resources/changed"
  )

  # A tracked view is added; closing it keeps the subscription watching.
  view <- track_chg_register(env)
  jdv_notifications()
  jdv_close(view$id)
  jdv_notifications()
  expect_true(.jdv_track_task_callback(NULL, NULL, TRUE, FALSE))
  expect_identical(.jdv_state$track_task_callback, name)
  rm("jdvchg_s", envir = globalenv())
  expect_true(.jdv_track_task_callback(NULL, NULL, TRUE, FALSE))
  expect_length(jdv_notifications(), 1L)

  # Unsubscribing removes the callback when no view is tracked.
  chg_subscribe(FALSE)
  expect_null(.jdv_state$track_task_callback)
  expect_false(name %in% getTaskCallbackNames())
})

test_that("unsubscribing keeps tracking and tracking alone needs no watch", {
  skip_if_not(.jdv_track_supported(), "tracking needs R 4.6.0 or later")
  chg_session()
  env <- new.env()
  view <- track_chg_register(env)
  jdv_notifications()
  name <- .jdv_state$track_task_callback
  expect_false(is.null(name))

  # Tracking only: nothing is compared and nothing is reported.
  assign("jdvchg_t", 1, envir = globalenv())
  withr::defer(suppressWarnings(rm("jdvchg_t", envir = globalenv())))
  expect_true(.jdv_track_task_callback(NULL, NULL, TRUE, FALSE))
  expect_identical(jdv_notifications(), character())
  expect_null(.jdv_state$res_baseline)

  chg_subscribe()
  expect_identical(.jdv_state$track_task_callback, name)
  chg_subscribe(FALSE)
  expect_identical(.jdv_state$track_task_callback, name)
  expect_true(name %in% getTaskCallbackNames())
  env$x <- mtcars[1:3, ]
  expect_true(.jdv_track_task_callback(NULL, NULL, TRUE, FALSE))
  expect_identical(
    vapply(
      lapply(jdv_notifications(), .jdv_json_parse),
      function(message) message$method,
      ""
    ),
    "view/open"
  )
  jdv_close(view$id)
})

test_that("a failing tracked update does not stop the resource watch", {
  skip_if_not(.jdv_track_supported(), "tracking needs R 4.6.0 or later")
  chg_session()
  env <- new.env()
  track_chg_register(env)
  jdv_notifications()
  chg_subscribe()
  assign("jdvchg_e", 1, envir = globalenv())
  withr::defer(suppressWarnings(rm("jdvchg_e", envir = globalenv())))
  local_mocked_bindings(.jdv_track_poll = function() stop("tracking is broken"))
  expect_warning(
    expect_true(.jdv_track_task_callback(NULL, NULL, TRUE, FALSE)),
    "tracking is broken"
  )
  expect_true(.jdv_state$res_pending)
  methods <- vapply(
    lapply(jdv_notifications(), .jdv_json_parse),
    function(message) message$method,
    ""
  )
  expect_identical(methods, "resources/changed")
  # The watch is still installed for the next task.
  expect_false(is.null(.jdv_state$track_task_callback))
})

test_that("a failing resource watch does not stop tracking", {
  skip_if_not(.jdv_track_supported(), "tracking needs R 4.6.0 or later")
  chg_session()
  env <- new.env()
  track_chg_register(env)
  jdv_notifications()
  chg_subscribe()
  env$x <- mtcars[1:3, ]
  local_mocked_bindings(.jdv_resources_scan = function() stop("scan is broken"))
  expect_warning(
    expect_true(.jdv_track_task_callback(NULL, NULL, TRUE, FALSE)),
    "scan is broken"
  )
  expect_identical(
    vapply(
      lapply(jdv_notifications(), .jdv_json_parse),
      function(message) message$method,
      ""
    ),
    "view/open"
  )
  expect_true(.jdv_state$res_subscribed)
})

test_that("jdv_rpc(NULL) detects a change for the next jdv_notifications()", {
  chg_session()
  chg_subscribe()
  assign("jdvchg_r", 1, envir = globalenv())
  withr::defer(suppressWarnings(rm("jdvchg_r", envir = globalenv())))
  expect_null(jdv_rpc(NULL))
  methods <- vapply(
    lapply(jdv_notifications(), .jdv_json_parse),
    function(message) message$method,
    ""
  )
  expect_identical(methods, "resources/changed")
})

test_that("the handle API does not accept resources/subscribe", {
  handle <- jdv_handle(mtcars)
  on.exit(jdv_handle_close(handle), add = TRUE)
  expect_error(
    jdv_handle_request(handle, "resources/subscribe", list(enabled = TRUE)),
    class = "jdv_error_method_not_found"
  )
})
