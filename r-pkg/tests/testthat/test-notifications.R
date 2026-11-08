notification_methods <- function(messages) {
  vapply(
    messages,
    function(message) .jdv_json_parse(message)$method,
    "",
    USE.NAMES = FALSE
  )
}

notification_views <- function(messages) {
  vapply(
    messages,
    function(message) .jdv_json_parse(message)$params$view %||% NA_character_,
    "",
    USE.NAMES = FALSE
  )
}

object_open <- function(view, path, id = 1) {
  request <- list(
    id = id,
    method = "object/open",
    params = list(view = view$id, generation = view$generation, path = path)
  )
  .jdv_json_parse(jdv_rpc(.jdv_json_encode(request)))
}

test_that("an embedded session queues hello before the first view/open", {
  jdv_disconnect()
  on.exit(jdv_disconnect(), add = TRUE)
  expect_identical(jdv_notifications(), character())
  expect_identical(jdv_connection()$owner, "none")
  expect_identical(jdv_connection()$state, "disconnected")

  registered <- jdv_register(mtcars, mode = "paged")
  expect_named(registered, c("id", "generation"))
  expect_identical(registered$generation, 1)
  state <- jdv_connection()
  expect_identical(state$owner, "embedded")
  expect_identical(state$state, "embedded")
  expect_false(state$connected)

  messages <- jdv_notifications()
  expect_type(messages, "character")
  expect_identical(notification_methods(messages), c("hello", "view/open"))
  expect_identical(notification_views(messages)[[2L]], registered$id)
  expect_false(any(grepl("\n", messages, fixed = TRUE)))
  expect_identical(jdv_notifications(), character())

  limits <- .jdv_json_parse(messages[[1L]])$params$limits
  hello <- .jdv_json_parse(messages[[1L]])$params
  expect_setequal(
    names(hello),
    c("protocol", "session", "producer", "wake", "capabilities", "limits")
  )
  expect_identical(unclass(hello$capabilities), list(resources = TRUE))
  expect_identical(hello$producer$name, "jdv")
  expect_identical(
    hello$producer$version,
    as.character(utils::packageVersion("jdv"))
  )
  expect_identical(hello$producer$runtime$name, "R")
  expect_identical(hello$producer$runtime$version, as.character(getRversion()))
  expect_identical(hello$wake, TRUE)
  expect_setequal(
    names(limits),
    c(
      "max_unacked_frames",
      "max_unacked_bytes",
      "queue_messages",
      "queue_bytes",
      "max_request_bytes",
      "max_message_bytes"
    )
  )
  expect_true(all(vapply(limits, function(value) value > 0, logical(1))))
})

test_that("close and eviction notifications are taken without a registration", {
  jdv_disconnect()
  on.exit(jdv_disconnect(), add = TRUE)
  old <- options(jdv.max_tables = 2L)
  on.exit(options(old), add = TRUE)
  first <- jdv_register(data.frame(x = 1), mode = "paged")
  second <- jdv_register(data.frame(x = 2), mode = "paged")
  expect_length(jdv_notifications(), 3L)

  third <- jdv_register(data.frame(x = 3), mode = "paged")
  messages <- jdv_notifications()
  expect_identical(
    notification_methods(messages),
    c("view/closed", "view/open")
  )
  expect_identical(notification_views(messages), c(first$id, third$id))

  jdv_close(second$id)
  messages <- jdv_notifications()
  expect_identical(notification_methods(messages), "view/closed")
  expect_identical(notification_views(messages), second$id)

  # The session outlives the last view so the final close can be taken.
  jdv_close()
  messages <- jdv_notifications()
  expect_identical(notification_views(messages), third$id)
  expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
  expect_identical(jdv_connection()$state, "embedded")
  expect_identical(jdv_notifications(), character())
})

test_that("child views announce themselves and cascade closes in order", {
  jdv_disconnect()
  on.exit(jdv_disconnect(), add = TRUE)
  root <- jdv_register(list(items = list(1, 2)))
  jdv_notifications()
  response <- object_open(root, list(list(type = "index", index = 1)))
  child <- response$result$view
  expect_type(child, "character")

  messages <- jdv_notifications()
  expect_identical(notification_methods(messages), "view/open")
  expect_identical(notification_views(messages), child)
  expect_identical(.jdv_json_parse(messages)$params$parent, root$id)

  jdv_close(root$id)
  messages <- jdv_notifications()
  expect_identical(notification_views(messages), c(child, root$id))
  expect_identical(
    .jdv_json_parse(messages[[1L]])$params$reason,
    "parent_closed"
  )
})

test_that("a failed object/open response leaves no child view/open queued", {
  jdv_disconnect()
  on.exit(jdv_disconnect(), add = TRUE)
  root <- jdv_register(list(items = list(1, 2)))
  jdv_notifications()
  encode <- .jdv_json_encode
  local_mocked_bindings(
    .jdv_json_encode = function(x, ...) {
      if (is.list(x) && is.list(x$result) && !is.null(x$result$view)) {
        stop("injected final response failure")
      }
      encode(x, ...)
    },
    .package = "jdv"
  )
  response <- object_open(root, list(list(type = "index", index = 1)))
  expect_false(is.null(response$error))
  expect_identical(jdv_notifications(), character())
  expect_identical(ls(.jdv_state$entries, all.names = TRUE), root$id)
})

test_that("an embedded session never moves to a viewer connection", {
  jdv_disconnect()
  on.exit(jdv_disconnect(), add = TRUE)
  registered <- jdv_register(data.frame(x = 1), mode = "paged")
  expect_error(jdv_connect("tcp://127.0.0.1:1"), "jdv_disconnect")
  expect_error(jdv_view(data.frame(x = 1)), "jdv_disconnect")
  expect_identical(jdv_connection()$owner, "embedded")
  expect_true(exists(registered$id, .jdv_state$entries, inherits = FALSE))

  state <- jdv_disconnect()
  expect_identical(state$state, "disconnected")
  expect_identical(state$owner, "none")
  expect_identical(state$last_disconnect_reason, "disconnect")
  expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
  expect_identical(jdv_notifications(), character())
  expect_identical(jdv_connection()$owner, "none")
})

test_that("a transport owner refuses jdv_notifications()", {
  jdv_disconnect()
  on.exit(
    {
      .jdv_state$transport <- NULL
      jdv_disconnect()
    },
    add = TRUE
  )
  .jdv_state$transport <- TRUE
  expect_error(jdv_notifications(), "owns the notifications")
  expect_identical(jdv_connection()$owner, "transport")
})

test_that("exceeding the message limit ends the session", {
  jdv_disconnect()
  on.exit(jdv_disconnect(), add = TRUE)
  old <- options(jdv.notification_max_messages = 3L)
  on.exit(options(old), add = TRUE)
  jdv_register(data.frame(x = 1), mode = "paged")
  jdv_register(data.frame(x = 2), mode = "paged")
  expect_error(
    jdv_register(data.frame(x = 3), mode = "paged"),
    class = "jdv_notification_overflow"
  )
  state <- jdv_connection()
  expect_identical(state$state, "disconnected")
  expect_identical(state$owner, "none")
  expect_identical(state$last_disconnect_reason, "notification_overflow")
  expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
  expect_identical(jdv_notifications(), character())

  options(jdv.notification_max_messages = 256L)
  jdv_register(data.frame(x = 4), mode = "paged")
  expect_identical(jdv_connection()$owner, "embedded")
})

test_that("exceeding the byte limit ends the session", {
  jdv_disconnect()
  on.exit(jdv_disconnect(), add = TRUE)
  old <- options(jdv.notification_max_bytes = 1024)
  on.exit(options(old), add = TRUE)
  expect_error(
    jdv_register(mtcars, mode = "snapshot"),
    class = "jdv_notification_overflow"
  )
  state <- jdv_connection()
  expect_identical(state$owner, "none")
  expect_identical(state$last_disconnect_reason, "notification_overflow")
  expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
  expect_identical(jdv_notifications(), character())
})

test_that("an overflow while closing children ends the session", {
  jdv_disconnect()
  on.exit(jdv_disconnect(), add = TRUE)
  root <- jdv_register(list(items = list(1, 2)))
  object_open(root, list(list(type = "index", index = 1)))
  jdv_notifications()
  # The queue is empty now; allow only one more message.
  .jdv_state$queue_max_messages <- 1
  expect_error(jdv_close(root$id), class = "jdv_notification_overflow")
  expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
  expect_identical(
    jdv_connection()$last_disconnect_reason,
    "notification_overflow"
  )
})
