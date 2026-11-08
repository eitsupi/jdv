# Bindings created by these tests start with this prefix, so the checks ignore
# whatever else the global environment holds.
res_prefix <- "jdvres_"

# Assign bindings in the global environment and remove them when the test
# ends. Pass promises and active bindings through res_assign_special().
res_assign <- function(..., .env = parent.frame()) {
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

res_cleanup <- function(names, .env = parent.frame()) {
  skip_if_not_installed("withr")
  withr::defer(
    suppressWarnings(rm(list = names, envir = globalenv())),
    envir = .env
  )
}

# An embedded session that has no views, which is what a host sees right after
# it connects.
res_session <- function(.env = parent.frame()) {
  skip_if_not_installed("withr")
  jdv_disconnect()
  withr::defer(jdv_disconnect(), envir = .env)
  first <- jdv_register(mtcars)
  jdv_close(first$id)
  jdv_notifications()
  invisible(NULL)
}

res_rpc <- function(method, params = NULL, id = "res-1") {
  request <- list(id = id, method = method)
  if (!is.null(params)) {
    request$params <- if (length(params)) params else jdv_json_object()
  }
  .jdv_json_parse(jdv_rpc(.jdv_json_encode(request)))
}

res_children <- function(...) res_rpc("resources/children", list(...))

# Every child of the root, paging through next_offset.
res_all <- function(limit = 500) {
  children <- list()
  offset <- 0
  repeat {
    response <- res_children(offset = offset, limit = limit)
    expect_null(response$error)
    children <- c(children, response$result$children)
    if (is.null(response$result$next_offset)) {
      break
    }
    offset <- response$result$next_offset
  }
  children
}

res_mine <- function(children = res_all()) {
  keep <- vapply(
    children,
    function(child) grepl("^\\.?jdvres_", child$label),
    logical(1L)
  )
  children[keep]
}

res_by_label <- function(children = res_mine()) {
  stats::setNames(children, vapply(children, `[[`, "", "label"))
}

res_text <- function(x) paste(unlist(x), collapse = " ")

res_methods <- function(messages = jdv_notifications()) {
  notification_methods(messages)
}

test_that("the root lists global bindings with kind, summary, and class", {
  skip_if_not(.jdv_track_supported(), "reading bindings needs R 4.6.0 or later")
  res_session()
  res_assign(
    jdvres_df = mtcars,
    jdvres_mat = matrix(1:6, nrow = 2L),
    jdvres_list = list(a = 1, b = "x"),
    jdvres_chr = c("a", "b"),
    jdvres_factor = factor(c("u", "v")),
    jdvres_fun = function(x) x,
    jdvres_prim = sum,
    jdvres_env = new.env(),
    jdvres_self = globalenv(),
    jdvres_null = NULL
  )
  listed <- res_by_label()
  expect_setequal(
    names(listed),
    c(
      "jdvres_df",
      "jdvres_mat",
      "jdvres_list",
      "jdvres_chr",
      "jdvres_factor",
      "jdvres_fun",
      "jdvres_prim",
      "jdvres_env",
      "jdvres_self",
      "jdvres_null"
    )
  )
  kinds <- vapply(listed, `[[`, "", "kind")
  expect_identical(
    kinds[order(names(kinds))],
    c(
      jdvres_chr = "value",
      jdvres_df = "table",
      jdvres_env = "object",
      jdvres_factor = "value",
      jdvres_fun = "function",
      jdvres_list = "object",
      jdvres_mat = "table",
      jdvres_null = "object",
      jdvres_prim = "function",
      jdvres_self = "object"
    )
  )
  for (child in listed) {
    expect_false(child$has_children)
    expect_true(child$viewable)
    expect_null(child$unavailable)
    expect_null(child$hidden)
    expect_identical(child$id, paste0("b:", child$label))
    expect_lte(nchar(child$summary), 1000L)
  }
  expect_identical(listed$jdvres_df$class, list("data.frame"))
  expect_identical(listed$jdvres_df$type, "list")
  expect_identical(listed$jdvres_df$summary, "data.frame [32 \u00d7 11]")
  expect_identical(listed$jdvres_mat$summary, "matrix integer [2 \u00d7 3]")
  expect_identical(listed$jdvres_list$summary, "list (2)")
  expect_identical(listed$jdvres_chr$summary, "character (2)")
  expect_identical(listed$jdvres_factor$summary, "factor (2)")
  expect_identical(listed$jdvres_fun$summary, "function")
  expect_identical(listed$jdvres_prim$summary, "function")
  expect_identical(listed$jdvres_mat$class, list("matrix", "array"))
  # An environment summary has no binding count, so listing never walks one.
  expect_identical(listed$jdvres_self$summary, "environment")
  expect_identical(listed$jdvres_env$summary, "environment")
})

test_that("listing never calls methods defined for the listed objects", {
  skip_if_not(.jdv_track_supported(), "reading bindings needs R 4.6.0 or later")
  res_session()
  calls <- new.env()
  calls$n <- 0L
  hit <- function(...) {
    calls$n <- calls$n + 1L
    stop("a method must not run while listing")
  }
  rows <- data.frame(a = 1:3, b = c("x", "y", "z"))
  class(rows) <- c("jdvres_cls", "data.frame")
  mat <- structure(matrix(1:6, 2L), class = "jdvres_cls")
  vec <- structure(c(1.5, 2.5, 3.5, 4.5), class = "jdvres_cls")
  lst <- structure(list(1, 2, 3), class = "jdvres_cls")
  fun <- structure(function(x) x, class = "jdvres_cls")
  env <- structure(new.env(), class = "jdvres_cls")
  res_assign(
    jdvres_dfc = rows,
    jdvres_matc = mat,
    jdvres_vecc = vec,
    jdvres_lstc = lst,
    jdvres_func = fun,
    jdvres_envc = env
  )
  methods::setClass("JdvresS4", representation(x = "numeric"))
  withr::defer(methods::removeClass("JdvresS4"))
  s4 <- methods::new("JdvresS4", x = 1)
  generics <- c(
    "length",
    "format",
    "print",
    "dim",
    "names",
    "levels",
    "toString",
    "as.character",
    "[",
    "[[",
    "$",
    "nrow",
    "summary",
    "dimnames",
    "row.names"
  )
  methods_s3 <- paste0(generics, ".jdvres_cls")
  for (name in methods_s3) {
    assign(name, hit, envir = globalenv())
  }
  withr::defer(rm(list = methods_s3, envir = globalenv()))
  for (generic in c("length", "names", "dim")) {
    methods::setMethod(generic, "JdvresS4", function(x) hit())
  }
  methods::setMethod("show", "JdvresS4", function(object) hit())
  methods::setMethod("[", "JdvresS4", function(x, i, j, ..., drop = TRUE) hit())
  withr::defer(
    for (generic in c("length", "names", "dim", "show", "[")) {
      methods::removeMethod(generic, "JdvresS4")
    }
  )
  res_assign(jdvres_s4 = s4)

  listed <- res_by_label()
  # Page through the root as a host would.
  paged <- res_all(limit = 7)
  expect_gte(length(paged), length(listed))
  expect_identical(calls$n, 0L)
  expect_identical(
    listed$jdvres_dfc$summary,
    "jdvres_cls/data.frame [3 \u00d7 2]"
  )
  expect_identical(
    listed$jdvres_matc$summary,
    "jdvres_cls integer [2 \u00d7 3]"
  )
  expect_identical(listed$jdvres_vecc$summary, "jdvres_cls (4)")
  expect_identical(listed$jdvres_lstc$summary, "jdvres_cls (3)")
  expect_identical(listed$jdvres_func$summary, "jdvres_cls")
  expect_identical(listed$jdvres_envc$summary, "jdvres_cls")
  expect_identical(listed$jdvres_s4$summary, "JdvresS4")
})

test_that("dot names are hidden and every name is listed", {
  res_session()
  res_assign(.jdvres_hidden = 1, jdvres_shown = 2)
  listed <- res_by_label()
  expect_true(listed$.jdvres_hidden$hidden)
  expect_null(listed$jdvres_shown$hidden)
  expect_identical(listed$.jdvres_hidden$viewable, .jdv_track_supported())
  expect_identical(listed$.jdvres_hidden$id, "b:.jdvres_hidden")
})

test_that("children are ordered by UTF-8 bytes in every locale", {
  res_session()
  res_assign(
    jdvres_b = 1,
    jdvres_Z = 1,
    jdvres_a = 1,
    jdvres_B = 1,
    jdvres_00 = 1,
    `jdvres_é` = 1,
    `jdvres_あ` = 1
  )
  expected <- c(
    "jdvres_00",
    "jdvres_B",
    "jdvres_Z",
    "jdvres_a",
    "jdvres_b",
    "jdvres_é",
    "jdvres_あ"
  )
  labels <- function() vapply(res_mine(), `[[`, "", "label")
  expect_identical(enc2utf8(labels()), expected)
  old <- Sys.getlocale("LC_COLLATE")
  on.exit(Sys.setlocale("LC_COLLATE", old), add = TRUE)
  for (locale in c("C", "en_US.UTF-8", "C.UTF-8", "ja_JP.UTF-8")) {
    if (nzchar(suppressWarnings(Sys.setlocale("LC_COLLATE", locale)))) {
      expect_identical(enc2utf8(labels()), expected, info = locale)
    }
  }
})

test_that("paging reports totals and the next offset", {
  res_session()
  res_assign(jdvres_p1 = 1, jdvres_p2 = 2, jdvres_p3 = 3)
  all <- res_all()
  total <- length(all)
  expect_gte(total, 3L)

  first <- res_children(offset = 0, limit = 2)$result
  expect_null(first$node)
  expect_equal(first$offset, 0L)
  expect_length(first$children, 2L)
  expect_equal(first$total_children, total)
  expect_equal(first$next_offset, 2L)
  expect_identical(
    vapply(first$children, `[[`, "", "id"),
    vapply(all[1:2], `[[`, "", "id")
  )

  last <- res_children(offset = total - 1, limit = 2)$result
  expect_length(last$children, 1L)
  expect_null(last$next_offset)
  exact <- res_children(offset = total - 2, limit = 2)$result
  expect_length(exact$children, 2L)
  expect_null(exact$next_offset)

  # An offset past the end is not clamped.
  beyond <- res_children(offset = total + 10, limit = 5)$result
  expect_equal(beyond$offset, total + 10L)
  expect_length(beyond$children, 0L)
  expect_equal(beyond$total_children, total)
  expect_null(beyond$next_offset)
  at_end <- res_children(offset = total)$result
  expect_length(at_end$children, 0L)

  # A request without params uses the defaults.
  defaults <- res_rpc("resources/children")$result
  expect_equal(defaults$offset, 0L)
  expect_length(defaults$children, min(total, 200L))
})

test_that("invalid paging parameters and nodes are rejected", {
  res_session()
  code <- function(...) res_children(...)$error$code
  expect_identical(code(limit = 0), "invalid_request")
  expect_identical(code(limit = 501), "invalid_request")
  expect_identical(code(limit = 1.5), "invalid_request")
  expect_identical(code(limit = "10"), "invalid_request")
  expect_identical(code(offset = -1), "invalid_request")
  expect_identical(code(offset = 0.5), "invalid_request")
  expect_identical(code(offset = 2^53), "invalid_request")
  expect_identical(code(offset = "0"), "invalid_request")
  # Unknown members are ignored.
  expect_null(code(unknown = 1))
  expect_identical(code(node = 1), "invalid_request")
  expect_identical(code(node = ""), "invalid_request")
  expect_identical(code(node = "b:"), "invalid_request")
  expect_identical(code(node = "x:jdvres_a"), "invalid_request")
  expect_identical(code(node = "h:zz"), "invalid_request")
  expect_identical(code(node = "h:abc"), "invalid_request")
  expect_identical(code(node = strrep("a", 16385L)), "invalid_request")
  expect_identical(code(limit = 500), NULL)
})

test_that("a node is a leaf that must still exist", {
  res_session()
  res_assign(jdvres_leaf = 1)
  response <- res_children(node = "b:jdvres_leaf", offset = 3)
  expect_null(response$error)
  expect_identical(response$result$node, "b:jdvres_leaf")
  expect_equal(response$result$offset, 3L)
  expect_length(response$result$children, 0L)
  expect_equal(response$result$total_children, 0L)
  expect_null(response$result$next_offset)
  expect_identical(
    res_children(node = "b:jdvres_gone")$error$code,
    "unavailable"
  )
  expect_equal(
    res_rpc("resources/children", list(node = NULL))$result$offset,
    0L
  )
})

test_that("a session without views serves the resource tree", {
  jdv_disconnect()
  on.exit(jdv_disconnect(), add = TRUE)
  first <- jdv_register(mtcars)
  hello <- .jdv_json_parse(jdv_notifications()[[1L]])$params
  expect_identical(
    unclass(hello$capabilities),
    list(resources = TRUE, resource_changes = TRUE)
  )
  jdv_close(first$id)
  jdv_notifications()
  expect_identical(jdv_connection()$owner, "embedded")
  expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
  expect_null(res_children(limit = 1)$error)
})

test_that("unevaluated promises and active bindings are never evaluated", {
  res_session()
  counter <- new.env()
  counter$n <- 0L
  delayedAssign(
    "jdvres_promise",
    {
      counter$n <- counter$n + 1L
      data.frame(a = 1)
    },
    assign.env = globalenv()
  )
  makeActiveBinding(
    "jdvres_active",
    function() {
      counter$n <- counter$n + 1L
      data.frame(a = 1)
    },
    globalenv()
  )
  res_assign(jdvres_plain = 1)
  res_cleanup(c("jdvres_promise", "jdvres_active"))

  listed <- res_by_label()
  expect_identical(listed$jdvres_active$unavailable, "active_binding")
  expect_false(listed$jdvres_active$viewable)
  expect_identical(listed$jdvres_active$kind, "unknown")
  expect_identical(listed$jdvres_plain$viewable, .jdv_track_supported())
  expect_identical(
    listed$jdvres_promise$unavailable,
    if (.jdv_track_supported()) "delayed_binding" else "opaque_binding"
  )
  expect_false(listed$jdvres_promise$viewable)

  for (id in c("b:jdvres_promise", "b:jdvres_active")) {
    opened <- res_rpc("resources/open", list(node = id))
    expect_identical(opened$error$code, "unavailable")
    expect_equal(res_children(node = id)$result$total_children, 0)
  }
  expect_identical(counter$n, 0L)
  expect_identical(res_methods(), character())
  expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
})

test_that("a forced promise is listed and opened as its value", {
  skip_if_not(.jdv_track_supported(), "needs R 4.6.0 or later")
  res_session()
  delayedAssign("jdvres_forced", mtcars, assign.env = globalenv())
  res_cleanup("jdvres_forced")
  expect_false(res_by_label()$jdvres_forced$viewable)
  force(get("jdvres_forced", envir = globalenv()))
  expect_true(res_by_label()$jdvres_forced$viewable)
  opened <- res_rpc("resources/open", list(node = "b:jdvres_forced"))
  expect_null(opened$error)
  expect_identical(opened$result$kind, "grid")
})

test_that("an older R lists names only and keeps values opaque", {
  res_session()
  res_assign(jdvres_value = mtcars)
  local_mocked_bindings(
    .jdv_tree_binding_read = function(env, name) {
      list(status = "opaque", value = NULL)
    }
  )
  child <- res_by_label()$jdvres_value
  expect_false(child$viewable)
  expect_false(child$has_children)
  expect_identical(child$kind, "unknown")
  expect_identical(child$unavailable, "opaque_binding")
  expect_identical(child$id, "b:jdvres_value")
  opened <- res_rpc("resources/open", list(node = "b:jdvres_value"))
  expect_identical(opened$error$code, "unavailable")
})

test_that("an older R lists every name, with ids, hidden flags, and paging", {
  res_session()
  res_assign(.jdvres_a = 1, jdvres_b = mtcars, jdvres_c = "x")
  local_mocked_bindings(
    .jdv_tree_binding_read = function(env, name) {
      list(status = "opaque", value = NULL)
    }
  )
  listed <- res_by_label()
  expect_identical(
    names(listed),
    c(".jdvres_a", "jdvres_b", "jdvres_c")[
      order(c(".jdvres_a", "jdvres_b", "jdvres_c"), method = "radix")
    ]
  )
  for (child in listed) {
    expect_identical(child$kind, "unknown")
    expect_false(child$viewable)
    expect_identical(child$unavailable, "opaque_binding")
    expect_identical(child$id, paste0("b:", child$label))
  }
  expect_true(listed$.jdvres_a$hidden)
  expect_null(listed$jdvres_b$hidden)
  page <- res_children(offset = 0, limit = 2)$result
  expect_length(page$children, 2L)
  expect_equal(page$next_offset, 2L)
  expect_identical(
    res_rpc("resources/open", list(node = "b:jdvres_c"))$error$code,
    "unavailable"
  )
  expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
})

test_that("ids round-trip non-ASCII, long, and non-UTF-8 names", {
  res_session()
  long <- paste0(res_prefix, strrep("x", 3000L))
  unicode <- paste0(res_prefix, "あé\U0001f600")
  res_assign(long = data.frame(a = 1:2), unicode = data.frame(a = 1:3))
  assign(long, data.frame(a = 1:2), envir = globalenv())
  assign(unicode, data.frame(a = 1:3), envir = globalenv())
  res_cleanup(c(long, unicode, "long", "unicode"))

  listed <- res_mine()
  labels <- vapply(listed, `[[`, "", "label")
  long_child <- listed[[match(substr(long, 1L, 1000L), labels)]]
  expect_identical(nchar(long_child$label), 1000L)
  expect_identical(long_child$id, paste0("b:", long))
  expect_identical(long_child$viewable, .jdv_track_supported())
  unicode_child <- listed[[match(unicode, enc2utf8(labels))]]
  expect_identical(enc2utf8(unicode_child$id), paste0("b:", unicode))

  if (.jdv_track_supported()) {
    opened <- res_rpc("resources/open", list(node = long_child$id))
    expect_null(opened$error)
    expect_equal(opened$result$nrow, 2)
    opened <- res_rpc("resources/open", list(node = unicode_child$id))
    expect_null(opened$error)
    expect_equal(opened$result$nrow, 3)
  }

  # Bytes that are not UTF-8 travel as hex.
  bytes <- paste0(res_prefix, "\xff\xfe")
  Encoding(bytes) <- "bytes"
  bytes <- rawToChar(charToRaw(bytes))
  id <- .jdv_resource_id(bytes)
  expect_identical(
    id,
    paste0(
      "h:",
      paste(sprintf("%02x", as.integer(charToRaw(bytes))), collapse = "")
    )
  )
  expect_identical(charToRaw(.jdv_resource_name(id)), charToRaw(bytes))
  assigned <- tryCatch(
    {
      assign(bytes, mtcars, envir = globalenv())
      TRUE
    },
    error = function(error) FALSE
  )
  if (assigned) {
    res_cleanup(bytes)
    child <- Filter(function(child) identical(child$id, id), res_mine())
    expect_length(child, 1L)
    expect_identical(child[[1L]]$viewable, .jdv_track_supported())
    if (.jdv_track_supported()) {
      expect_null(res_rpc("resources/open", list(node = id))$error)
    }
  }
})

test_that("an id past the limit is omitted with id_limit", {
  expect_null(.jdv_resource_id(strrep("a", 16384L)))
  expect_identical(
    .jdv_resource_id(strrep("a", 16381L)),
    paste0("b:", strrep("a", 16381L))
  )
  # Non-UTF-8 bytes double in size as hex.
  bytes <- rawToChar(as.raw(rep(0xff, 9000L)))
  expect_null(.jdv_resource_id(bytes))
  child <- .jdv_resource_child(bytes)
  expect_null(child$id)
  expect_false(child$viewable)
  expect_false(child$has_children)
  expect_identical(child$unavailable, "id_limit")
  expect_identical(child$kind, "unknown")
})

test_that("resources/open opens grid and tree views with reason resource", {
  skip_if_not(.jdv_track_supported(), "reading bindings needs R 4.6.0 or later")
  res_session()
  res_assign(
    jdvres_df = mtcars,
    jdvres_list = list(a = 1, b = list(c = 2)),
    jdvres_fun = function(x) x
  )
  grid <- res_rpc("resources/open", list(node = "b:jdvres_df"))
  expect_null(grid$error)
  expect_identical(grid$result$kind, "grid")
  expect_identical(grid$result$reason, "resource")
  expect_null(grid$result$parent)
  expect_equal(grid$result$nrow, 32)
  tree <- res_rpc("resources/open", list(node = "b:jdvres_list"))
  expect_null(tree$error)
  expect_identical(tree$result$kind, "tree")
  expect_identical(tree$result$reason, "resource")
  fun <- res_rpc("resources/open", list(node = "b:jdvres_fun"))
  expect_null(fun$error)
  expect_identical(fun$result$kind, "tree")

  messages <- jdv_notifications()
  expect_identical(res_methods(messages), rep("view/open", 3L))
  opened <- lapply(messages, .jdv_json_parse)
  expect_identical(
    vapply(opened, function(message) message$params$view, ""),
    c(grid$result$view, tree$result$view, fun$result$view)
  )
  expect_identical(
    vapply(opened, function(message) message$params$reason, ""),
    rep("resource", 3L)
  )
})

test_that("every open creates a new view that follows the binding", {
  skip_if_not(.jdv_track_supported(), "binding tracking needs R 4.6.0 or later")
  res_session()
  res_assign(jdvres_df = mtcars)
  first <- res_rpc("resources/open", list(node = "b:jdvres_df"))
  second <- res_rpc("resources/open", list(node = "b:jdvres_df"))
  expect_null(first$error)
  expect_null(second$error)
  expect_false(identical(first$result$view, second$result$view))
  expect_identical(
    unclass(first$result$tracking),
    list(name = "jdvres_df", state = "active")
  )
  expect_true(first$result$capabilities$track)
  expect_true(first$result$capabilities$refresh)
  entry <- get(first$result$view, envir = .jdv_state$entries)
  expect_identical(entry$track_name, "jdvres_df")
  expect_false(is.null(entry$track_ref))
  jdv_notifications()

  # The binding is followed: reassigning it updates both views.
  assign("jdvres_df", mtcars[1:3, ], envir = globalenv())
  expect_true(.jdv_track_poll())
  updated <- lapply(jdv_notifications(), .jdv_json_parse)
  expect_identical(
    vapply(updated, function(message) message$params$reason, ""),
    rep("tracked", 2L)
  )
  expect_equal(updated[[1L]]$params$nrow, 3)

  # Opening again reads the current value, and refresh follows the binding.
  assign("jdvres_df", mtcars[1:5, ], envir = globalenv())
  third <- res_rpc("resources/open", list(node = "b:jdvres_df"))
  expect_equal(third$result$nrow, 5)
  refreshed <- refresh_json(first$result$view, 2)
  expect_null(refreshed$error)
  expect_equal(get(first$result$view, envir = .jdv_state$entries)$nrow, 5)
})

test_that("open honors mode and collation like object/open", {
  skip_if_not(.jdv_track_supported(), "reading bindings needs R 4.6.0 or later")
  res_session()
  res_assign(jdvres_df = mtcars)
  paged <- res_rpc(
    "resources/open",
    list(node = "b:jdvres_df", mode = "paged", collation = "locale")
  )
  expect_null(paged$error)
  expect_identical(paged$result$access, "random")
  expect_identical(paged$result$collation, "locale")
  snapshot <- res_rpc(
    "resources/open",
    list(node = "b:jdvres_df", mode = "snapshot", collation = "C")
  )
  expect_identical(snapshot$result$access, "snapshot")
  expect_identical(snapshot$result$collation, "C")
  for (params in list(
    list(node = "b:jdvres_df", mode = "bogus"),
    list(node = "b:jdvres_df", mode = 1),
    list(node = "b:jdvres_df", collation = "bogus"),
    list(mode = "paged")
  )) {
    expect_identical(
      res_rpc("resources/open", params)$error$code,
      "invalid_request"
    )
  }
  expect_identical(res_rpc("resources/open")$error$code, "invalid_request")
})

test_that("unknown request members are ignored", {
  skip_if_not(.jdv_track_supported(), "reading bindings needs R 4.6.0 or later")
  res_session()
  res_assign(jdvres_df = mtcars)
  expect_null(res_children(limit = 1, extra = TRUE)$error)
  opened <- res_rpc("resources/open", list(node = "b:jdvres_df", extra = TRUE))
  expect_null(opened$error)
  expect_identical(opened$result$reason, "resource")
})

test_that("resource views carry the variable name as a display title", {
  skip_if_not(.jdv_track_supported(), "reading bindings needs R 4.6.0 or later")
  res_session()
  res_assign(jdvres_df = mtcars, `jdvres non syntactic` = list(a = 1))
  plain <- res_rpc("resources/open", list(node = "b:jdvres_df"))$result
  again <- res_rpc("resources/open", list(node = "b:jdvres_df"))$result
  odd <- res_rpc("resources/open", list(node = "b:jdvres non syntactic"))$result
  expect_identical(plain$title, "jdvres_df")
  expect_identical(again$title, "jdvres_df")
  expect_false(identical(plain$view, again$view))
  expect_identical(odd$title, "`jdvres non syntactic`")
  expect_identical(odd$kind, "tree")
  # A display title never takes a title slot.
  expect_length(ls(.jdv_state$titles, all.names = TRUE), 0L)

  # It does not replace a view that holds the title, and vice versa.
  held <- register_view(mtcars, title = "jdvres_df")
  expect_true(exists(plain$view, envir = .jdv_state$entries))
  expect_true(exists(again$view, envir = .jdv_state$entries))
  expect_false(identical(held$id, plain$view))
  third <- res_rpc("resources/open", list(node = "b:jdvres_df"))$result
  expect_identical(third$title, "jdvres_df")
  expect_false(third$view %in% c(held$id, plain$view, again$view))
  replaced <- register_view(mtcars[1:2, ], title = "jdvres_df")
  expect_identical(replaced$id, held$id)
  expect_equal(replaced$generation, 2)
  for (view in c(plain$view, again$view, third$view)) {
    expect_true(exists(view, envir = .jdv_state$entries))
  }
  # Closing a resource view leaves the slot of the titled view alone.
  jdv_close(plain$view)
  expect_equal(get(held$id, envir = .jdv_state$entries)$generation, 2)
  expect_length(ls(.jdv_state$titles, all.names = TRUE), 1L)
})

test_that("open rejects ids that are not ours or no longer exist", {
  skip_if_not(.jdv_track_supported(), "reading bindings needs R 4.6.0 or later")
  res_session()
  res_assign(jdvres_df = mtcars)
  for (node in list(
    "",
    "jdvres_df",
    "b:",
    "h:",
    "h:0",
    "h:gg",
    "h:00",
    1,
    TRUE
  )) {
    expect_identical(
      res_rpc("resources/open", list(node = node))$error$code,
      "invalid_request",
      info = format(node)
    )
  }
  opened <- res_rpc("resources/open", list(node = "b:jdvres_df"))
  expect_null(opened$error)
  jdv_notifications()
  rm("jdvres_df", envir = globalenv())
  gone <- res_rpc("resources/open", list(node = "b:jdvres_df"))
  expect_identical(gone$error$code, "unavailable")
  expect_identical(jdv_notifications(), character())
  # Recreating the name makes the same id open the new value.
  assign("jdvres_df", mtcars[1:2, ], envir = globalenv())
  again <- res_rpc("resources/open", list(node = "b:jdvres_df"))
  expect_equal(again$result$nrow, 2)
})

test_that("listing never closes views and closing never changes the list", {
  skip_if_not(.jdv_track_supported(), "reading bindings needs R 4.6.0 or later")
  res_session()
  res_assign(jdvres_df = mtcars)
  opened <- res_rpc("resources/open", list(node = "b:jdvres_df"))$result
  jdv_notifications()
  before <- vapply(res_all(), `[[`, "", "id")
  expect_null(res_children(offset = 0, limit = 1)$error)
  expect_identical(jdv_notifications(), character())
  expect_true(exists(opened$view, envir = .jdv_state$entries))
  jdv_close(opened$view)
  jdv_notifications()
  expect_identical(vapply(res_all(), `[[`, "", "id"), before)
})

test_that("open respects the view limit", {
  skip_if_not(.jdv_track_supported(), "reading bindings needs R 4.6.0 or later")
  res_session()
  res_assign(jdvres_df = mtcars)
  old <- options(jdv.max_tables = 2)
  on.exit(options(old), add = TRUE)
  ids <- vapply(
    1:3,
    function(i) {
      res_rpc("resources/open", list(node = "b:jdvres_df"))$result$view
    },
    ""
  )
  expect_length(unique(ids), 3L)
  expect_length(ls(.jdv_state$entries, all.names = TRUE), 2L)
  messages <- jdv_notifications()
  expect_identical(
    res_methods(messages),
    c("view/open", "view/open", "view/closed", "view/open")
  )
  expect_identical(.jdv_json_parse(messages[[3L]])$params$view, ids[[1L]])
})

test_that("a response that cannot be built closes the view silently", {
  skip_if_not(.jdv_track_supported(), "reading bindings needs R 4.6.0 or later")
  res_session()
  res_assign(
    jdvres_wide = as.data.frame(stats::setNames(
      replicate(30L, 1:2, simplify = FALSE),
      paste0("column_with_a_long_name_", 1:30)
    ))
  )
  probe <- res_rpc("resources/open", list(node = "b:jdvres_wide"))
  expect_null(probe$error)
  size <- nchar(jdv_notifications()[[1L]], type = "bytes")
  expect_gt(size, 1024L)
  jdv_close(probe$result$view)
  jdv_notifications()

  # The response is a few bytes larger than the view/open message.
  old <- options(jdv.max_message_bytes = size)
  on.exit(options(old), add = TRUE)
  failed <- res_rpc("resources/open", list(node = "b:jdvres_wide"))
  expect_identical(failed$error$code, "limit_exceeded")
  expect_identical(jdv_notifications(), character())
  expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
})

test_that("a children page too large for one message is shortened", {
  skip_if_not(.jdv_track_supported(), "reading bindings needs R 4.6.0 or later")
  res_session()
  texts <- replicate(
    12L,
    structure(1, class = rep(strrep("w", 150L), 5L)),
    simplify = FALSE
  )
  names(texts) <- sprintf("jdvres_long_%02d", 1:12)
  do.call(res_assign, texts)
  # The long class names each need a few hundred bytes of summary.
  old <- options(jdv.max_message_bytes = 4096)
  on.exit(options(old), add = TRUE)
  offsets <- numeric()
  labels <- character()
  offset <- 0
  repeat {
    response <- res_children(offset = offset, limit = 500)
    expect_null(response$error)
    offsets <- c(offsets, offset)
    labels <- c(labels, vapply(response$result$children, `[[`, "", "label"))
    if (is.null(response$result$next_offset)) {
      break
    }
    expect_gt(length(response$result$children), 0L)
    expect_equal(
      response$result$next_offset,
      offset + length(response$result$children)
    )
    offset <- response$result$next_offset
  }
  expect_gt(length(offsets), 1L)
  expect_true(all(names(texts) %in% labels))
  expect_false(anyDuplicated(labels) > 0L)
})

test_that("one child that cannot fit fails with limit_exceeded", {
  res_session()
  name <- paste0("~", res_prefix, strrep("n", 2000L))
  assign(name, 1, envir = globalenv())
  res_cleanup(name)
  old <- options(jdv.max_message_bytes = 1024)
  on.exit(options(old), add = TRUE)
  offset <- match(name, .jdv_resource_names()) - 1
  failed <- res_children(offset = offset, limit = 1)
  expect_identical(failed$error$code, "limit_exceeded")
})

test_that("jdv.resources = FALSE disables the resource tree for the session", {
  jdv_disconnect()
  on.exit(jdv_disconnect(), add = TRUE)
  old <- options(jdv.resources = FALSE)
  on.exit(options(old), add = TRUE)
  res_assign(jdvres_df = mtcars)
  first <- jdv_register(mtcars)
  hello <- .jdv_json_parse(jdv_notifications()[[1L]])$params
  expect_null(hello$capabilities)
  for (response in list(
    res_children(),
    res_rpc("resources/open", list(node = "b:jdvres_df")),
    res_rpc("resources/children", list(node = "b:jdvres_df"))
  )) {
    expect_identical(response$error$code, "unsupported")
    expect_null(response$result)
    expect_false(grepl("jdvres", res_text(response)))
  }
  expect_identical(res_rpc("resources/unknown")$error$code, "method_not_found")
  expect_identical(jdv_notifications(), character())

  # Enabling the option later does not change the running session.
  options(jdv.resources = TRUE)
  expect_identical(res_children()$error$code, "unsupported")
  jdv_close(first$id)
  jdv_disconnect()
  jdv_register(mtcars)
  hello <- .jdv_json_parse(jdv_notifications()[[1L]])$params
  expect_identical(
    unclass(hello$capabilities),
    list(resources = TRUE, resource_changes = TRUE)
  )
  expect_null(res_children(limit = 1)$error)
})

test_that("changing jdv.resources after hello keeps the session contract", {
  res_session()
  old <- options(jdv.resources = FALSE)
  on.exit(options(old), add = TRUE)
  expect_null(res_children(limit = 1)$error)
  res_assign(jdvres_df = mtcars)
  opened <- res_rpc("resources/open", list(node = "b:jdvres_df"))
  if (.jdv_track_supported()) {
    expect_null(opened$error)
  } else {
    expect_identical(opened$error$code, "unavailable")
  }
})

test_that("a single non-FALSE value of jdv.resources keeps it enabled", {
  old <- options(jdv.resources = NULL)
  on.exit(options(old), add = TRUE)
  expect_true(.jdv_resources_option())
  options(jdv.resources = TRUE)
  expect_true(.jdv_resources_option())
  options(jdv.resources = FALSE)
  expect_false(.jdv_resources_option())
})

test_that("resources are unsupported without a session", {
  jdv_disconnect()
  expect_identical(res_children()$error$code, "unsupported")
  expect_identical(
    res_rpc("resources/open", list(node = "b:x"))$error$code,
    "unsupported"
  )
})

test_that("handles do not accept resource requests", {
  handle <- jdv_handle(mtcars)
  on.exit(jdv_handle_close(handle), add = TRUE)
  expect_error(
    jdv_handle_request(handle, "resources/children", list()),
    class = "jdv_error_method_not_found"
  )
  expect_error(
    jdv_handle_request(handle, "resources/open", list(node = "b:x")),
    class = "jdv_error_method_not_found"
  )
})

test_that("a viewer connection serves resources before any view", {
  skip_if_not(.jdv_track_supported(), "reading bindings needs R 4.6.0 or later")
  skip_on_cran()
  skip_on_os("windows")
  skip_if_not_installed("callr")
  skip_if_not_installed("jsonlite")
  skip_if_not_installed("withr")
  python <- Sys.which("python3")
  skip_if(!nzchar(python), "python3 is required for the local mock host")

  run_host <- function(enabled, late = FALSE) {
    jdv_disconnect()
    directory <- jdv_test_uds_directory()
    socket_path <- file.path(directory, "s")
    ready_path <- file.path(directory, "ready")
    result_path <- file.path(directory, "result")
    res_assign(jdvres_df = mtcars, jdvres_other = 1)
    host <- callr::r_bg(
      function(python, script, socket_path, ready_path, result_path) {
        system2(
          python,
          c(
            shQuote(script),
            "--socket",
            shQuote(socket_path),
            "--ready",
            shQuote(ready_path),
            "--result",
            shQuote(result_path),
            "--node",
            "b:jdvres_df"
          ),
          stdout = TRUE,
          stderr = TRUE
        )
      },
      args = list(
        python = python,
        script = test_path("fixtures", "resources-host.py"),
        socket_path = socket_path,
        ready_path = ready_path,
        result_path = result_path
      ),
      supervise = TRUE
    )
    old <- options(jdv.address = socket_path, jdv.resources = enabled)
    on.exit(
      {
        options(old)
        try(jdv_disconnect(), silent = TRUE)
        if (host$is_alive()) {
          host$kill()
        }
        try(host$wait(), silent = TRUE)
        unlink(directory, recursive = TRUE)
      },
      add = TRUE
    )
    deadline <- Sys.time() + 10
    while (!file.exists(ready_path) && Sys.time() < deadline) {
      Sys.sleep(0.01)
    }
    expect_true(file.exists(ready_path))
    jdv_connect()
    # The session contract is fixed by hello, not by the option's later value.
    if (late) {
      options(jdv.resources = !enabled)
    }
    deadline <- Sys.time() + 10
    while (!file.exists(result_path) && Sys.time() < deadline) {
      jdv_rpc(NULL)
      Sys.sleep(0.01)
    }
    expect_true(file.exists(result_path))
    jsonlite::fromJSON(result_path, simplifyVector = FALSE)$messages
  }

  for (late in c(FALSE, TRUE)) {
    messages <- run_host(TRUE, late)
    methods <- vapply(messages, function(m) m$method %||% "response", "")
    expect_identical(messages[[1L]]$method, "hello")
    expect_identical(
      messages[[1L]]$params$capabilities,
      list(resources = TRUE, resource_changes = TRUE)
    )
    ids <- vapply(messages, function(m) m$id %||% "", "")
    responses <- messages[ids %in% c("list", "open", "again")]
    expect_null(responses[[1L]]$error)
    expect_gte(length(responses[[1L]]$result$children), 1L)
    # The view/open notification precedes the open response.
    open_at <- which(methods == "view/open")
    expect_length(open_at, 1L)
    expect_lt(open_at, which(ids == "open"))
    expect_identical(messages[[open_at]]$params$reason, "resource")
    expect_identical(
      messages[[which(ids == "open")]]$result$view,
      messages[[open_at]]$params$view
    )
    expect_equal(messages[[which(ids == "again")]]$result$next_offset, 1)
  }

  for (late in c(FALSE, TRUE)) {
    messages <- run_host(FALSE, late)
    expect_identical(messages[[1L]]$method, "hello")
    expect_null(messages[[1L]]$params$capabilities)
    ids <- vapply(messages, function(m) m$id %||% "", "")
    for (id in c("list", "open", "again")) {
      expect_identical(messages[[which(ids == id)]]$error$code, "unsupported")
    }
    expect_false(any(vapply(
      messages,
      function(m) identical(m$method, "view/open"),
      NA
    )))
  }
})
