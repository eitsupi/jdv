local({
  socket_directory <- jdv_test_uds_directory()
  on.exit(unlink(socket_directory, recursive = TRUE), add = TRUE)
  # Restore file-owned notification state even when a test fails.
  state <- .jdv_state
  initial_session <- save_notification_session()
  on.exit(restore_notification_session(initial_session), add = TRUE)

  transport_rpc_json <- function(value) {
    skip_if_not_installed("jsonlite")
    jsonlite::fromJSON(value, simplifyVector = FALSE)
  }

  transport_rpc_call <- function(
    method,
    params = list(),
    id = 1,
    extra = list()
  ) {
    request <- c(list(id = id, method = method, params = params), extra)
    jdv_rpc(.jdv_json_encode(request))
  }

  expect_transport_rpc_code <- function(response, expected) {
    parsed <- transport_rpc_json(response)
    expect_identical(parsed$error$code, expected)
    invisible(parsed)
  }

  transport_status_summary <- function() {
    status <- tryCatch(.jdv_transport_status(), error = identity)
    if (inherits(status, "error")) {
      return(conditionMessage(status))
    }
    if (is.null(status)) {
      return("NULL")
    }
    paste(
      paste0(
        names(status),
        "=",
        vapply(
          status,
          function(value) paste(value, collapse = ","),
          character(1)
        )
      ),
      collapse = " "
    )
  }

  run_mock_host <- function(
    socket_path,
    ready_path,
    result_path,
    scenario,
    request_bytes,
    queue_messages = 256L,
    queue_bytes = 16 * 1024^2,
    control_path = ""
  ) {
    python <- Sys.which("python3")
    script <- test_path("fixtures", "transport-host.py")
    callr::r_bg(
      function(
        script,
        python,
        socket_path,
        ready_path,
        result_path,
        scenario,
        request_bytes,
        queue_messages,
        queue_bytes,
        control_path
      ) {
        output <- system2(
          python,
          c(
            shQuote(script),
            "--socket",
            shQuote(socket_path),
            "--ready",
            shQuote(ready_path),
            "--result",
            shQuote(result_path),
            "--scenario",
            shQuote(scenario),
            "--request-bytes",
            as.character(request_bytes),
            "--queue-messages",
            as.character(queue_messages),
            "--queue-bytes",
            as.character(queue_bytes),
            "--control",
            shQuote(control_path)
          ),
          stdout = TRUE,
          stderr = TRUE
        )
        if (!is.null(attr(output, "status")) && attr(output, "status") != 0) {
          stop(paste(output, collapse = "\n"))
        }
      },
      args = list(
        script = script,
        python = python,
        socket_path = socket_path,
        ready_path = ready_path,
        result_path = result_path,
        scenario = scenario,
        request_bytes = request_bytes,
        queue_messages = queue_messages,
        queue_bytes = queue_bytes,
        control_path = control_path
      ),
      supervise = TRUE
    )
  }

  run_tcp_unload_host <- function(ready_path, connected_path, eof_path) {
    python <- Sys.which("python3")
    script <- test_path("fixtures", "transport-tcp-unload-host.py")
    callr::r_bg(
      function(script, python, ready_path, connected_path, eof_path) {
        output <- system2(
          python,
          c(
            shQuote(script),
            shQuote(ready_path),
            shQuote(connected_path),
            shQuote(eof_path)
          ),
          stdout = TRUE,
          stderr = TRUE
        )
        if (!is.null(attr(output, "status")) && attr(output, "status") != 0) {
          stop(paste(output, collapse = "\n"))
        }
      },
      args = list(
        script = script,
        python = python,
        ready_path = ready_path,
        connected_path = connected_path,
        eof_path = eof_path
      ),
      supervise = TRUE
    )
  }

  wait_for_file <- function(path, timeout = 10) {
    deadline <- Sys.time() + timeout
    while (!file.exists(path) && Sys.time() < deadline) {
      Sys.sleep(0.01)
    }
    file.exists(path)
  }

  wait_for_file_without_events <- function(path, timeout = 10) {
    deadline <- Sys.time() + timeout
    while (!file.exists(path) && Sys.time() < deadline) {
      invisible(NULL)
    }
    file.exists(path)
  }

  with_mock_transport <- function(
    scenario,
    x,
    request_bytes = 1024^2,
    before_poll = NULL,
    mode = "paged",
    queue_messages = 256L,
    queue_bytes = 16 * 1024^2
  ) {
    skip_on_cran()
    skip_on_os("windows")
    skip_if_not_installed("callr")
    skip_if_not_installed("jsonlite")
    python <- Sys.which("python3")
    skip_if(!nzchar(python), "python3 is required for the local mock host")

    # An embedded session left by an earlier test would own notifications.
    jdv_disconnect()
    socket_path <- tempfile("jdv-transport-", tmpdir = socket_directory)
    ready_path <- tempfile("jdv-transport-ready-")
    result_path <- tempfile("jdv-transport-result-")
    host <- run_mock_host(
      socket_path,
      ready_path,
      result_path,
      scenario,
      request_bytes,
      queue_messages,
      queue_bytes
    )
    old_transport_options <- options(c(
      "jdv.transport.queue_messages",
      "jdv.transport.queue_bytes"
    ))
    old_address <- getOption("jdv.address")
    options(
      jdv.address = socket_path,
      jdv.transport.queue_messages = queue_messages,
      jdv.transport.queue_bytes = queue_bytes
    )
    on.exit(
      {
        try(jdv_close(), silent = TRUE)
        options(c(old_transport_options, list(jdv.address = old_address)))
        if (host$is_alive()) {
          host$kill()
        }
        try(host$wait(), silent = TRUE)
        unlink(c(
          socket_path,
          ready_path,
          result_path,
          paste0(result_path, ".closed")
        ))
      },
      add = TRUE
    )

    expect_true(wait_for_file(ready_path))
    id <- tryCatch(
      jdv_view(x, mode = mode),
      error = function(error) {
        output <- tryCatch(
          host$read_all_output(),
          error = function(e) character()
        )
        stop(
          paste(
            conditionMessage(error),
            "Transport status:",
            transport_status_summary(),
            "Host alive:",
            host$is_alive(),
            "Host output:",
            paste(output, collapse = "\n"),
            sep = "\n"
          ),
          call. = FALSE
        )
      }
    )
    expect_type(id, "character")
    if (!is.null(before_poll)) {
      before_poll()
    }
    deadline <- Sys.time() + 10
    while (!file.exists(result_path) && Sys.time() < deadline) {
      jdv_rpc(NULL)
      Sys.sleep(0.01)
    }
    expect_true(file.exists(result_path))
    if (!file.exists(result_path)) {
      output <- tryCatch(
        host$read_all_output(),
        error = function(e) character()
      )
      stop(
        paste(
          "Mock host did not write its result.",
          "Transport status:",
          transport_status_summary(),
          "Host alive:",
          host$is_alive(),
          "Host output:",
          paste(output, collapse = "\n"),
          sep = "\n"
        ),
        call. = FALSE
      )
    }
    received <- jsonlite::fromJSON(result_path, simplifyVector = FALSE)
    received$debug_transport_status <- transport_status_summary()
    expect_identical(received$hello$method, "hello")
    expect_setequal(
      names(received$hello$params),
      c("protocol", "session", "producer", "wake", "capabilities", "limits")
    )
    expect_identical(
      received$hello$params$capabilities,
      list(resources = TRUE, resource_changes = TRUE)
    )
    expect_identical(received$hello$params$producer$name, "jdv")
    expect_identical(
      received$hello$params$producer$version,
      as.character(utils::packageVersion("jdv"))
    )
    expect_identical(received$hello$params$producer$runtime$name, "R")
    expect_identical(
      received$hello$params$producer$runtime$version,
      as.character(getRversion())
    )
    expect_identical(received$hello$params$wake, TRUE)
    expect_identical(received$open$method, "view/open")
    expect_identical(received$open$params$view, id)
    expect_identical(received$open$params$title, "x")
    expect_setequal(
      names(received$hello$params$limits),
      c(
        "max_unacked_frames",
        "max_unacked_bytes",
        "queue_messages",
        "queue_bytes",
        "max_request_bytes",
        "max_message_bytes"
      )
    )
    expect_gt(received$hello$params$limits$max_unacked_frames, 0)
    expect_gt(received$hello$params$limits$max_unacked_bytes, 0)
    expect_equal(
      received$hello$params$limits$max_message_bytes,
      as.numeric(.jdv_max_message_bytes())
    )
    expect_equal(
      received$hello$params$limits$queue_messages,
      as.numeric(queue_messages)
    )
    expect_equal(
      received$hello$params$limits$queue_bytes,
      as.numeric(queue_bytes)
    )
    expect_equal(
      received$hello$params$limits$max_unacked_frames,
      as.numeric(
        queue_messages + getOption("jdv.transport.max_drain_requests", 8)
      )
    )
    expect_equal(
      received$hello$params$limits$max_request_bytes,
      as.numeric(.jdv_max_request_bytes())
    )
    expect_equal(
      received$hello$params$limits$max_unacked_bytes,
      as.numeric(max(64 * 1024, .jdv_max_request_bytes() + 1))
    )
    if (scenario == "typed-id" && !length(received$responses)) {
      expect_true(FALSE, info = received$debug_transport_status)
    }
    if (scenario %in% c("queue-overflow-count", "queue-overflow-bytes")) {
      expect_length(
        received$responses,
        length(received$queue_accepted_ids) +
          length(received$queue_rejected_ids)
      )
    } else if (scenario != "duplicate-id") {
      expect_length(
        received$responses,
        if (scenario %in% c("large-snapshot", "disconnect")) {
          0L
        } else if (
          scenario %in%
            c(
              "invalid-encoding-cancel",
              "invalid-compression-cancel",
              "invalid-deadline-cancel",
              "malformed-deadline-cancel",
              "expired-cancel",
              "ack-controls"
            )
        ) {
          if (
            scenario %in%
              c("invalid-deadline-cancel", "malformed-deadline-cancel")
          ) {
            3L
          } else {
            2L
          }
        } else if (scenario %in% c("cancel", "expired")) {
          2L
        } else if (scenario %in% c("cancel-id-reuse", "refresh")) {
          3L
        } else if (scenario == "invalid-cancel") {
          2L
        } else {
          1L
        }
      )
    }
    expected_ids <- if (
      scenario %in% c("invalid-deadline-cancel", "malformed-deadline-cancel")
    ) {
      list(NULL, "protected", "followup")
    } else if (
      scenario %in%
        c(
          "invalid-encoding-cancel",
          "invalid-compression-cancel",
          "expired-cancel"
        )
    ) {
      list("protected", "followup")
    } else if (scenario == "invalid-cancel") {
      list(NULL, "must-survive")
    } else if (scenario == "cancel") {
      list("cancel-me", "followup")
    } else if (scenario == "expired") {
      list("expire-me", "followup")
    } else if (scenario == "ack-controls") {
      list(NULL, "ack-cancel")
    } else if (scenario %in% c("stale-generation", "missing-table")) {
      list(scenario)
    } else if (scenario == "cancel-id-reuse") {
      list("reused", "reused", "followup")
    } else if (scenario == "refresh") {
      list(NULL, "refresh-1", "refresh-stale")
    } else {
      list(
        if (scenario == "maximum-frame") {
          "maximum-frame"
        } else if (scenario == "numeric-id") {
          1e15
        } else if (scenario == "typed-id") {
          1L
        } else if (scenario == "invalid-control") {
          "invalid-control"
        } else if (scenario == "empty-registry-close") {
          "close-table"
        } else {
          "mock-rows-1"
        }
      )
    }
    if (scenario %in% c("queue-overflow-count", "queue-overflow-bytes")) {
      expected_ids <- c(
        received$queue_rejected_ids,
        received$queue_accepted_ids
      )
      expect_identical(lapply(received$responses, `[[`, "id"), expected_ids)
    } else if (
      !scenario %in% c("large-snapshot", "disconnect", "duplicate-id")
    ) {
      expect_identical(lapply(received$responses, `[[`, "id"), expected_ids)
    }
    if (scenario == "ack-controls") {
      ack_frames <- vapply(
        received$acks,
        function(message) message$params$frames,
        numeric(1L)
      )
      expect_true(length(ack_frames) >= 1L)
      expect_identical(ack_frames, sort(unique(ack_frames)))
      expect_identical(tail(ack_frames, 1L), 4)
      expect_identical(received$responses[[1L]]$error$code, "invalid_request")
      expect_identical(received$responses[[2L]]$error$code, "cancelled")
    }
    if (scenario %in% c("stale-generation", "missing-table")) {
      expect_identical(
        received$responses[[1L]]$error$code,
        if (scenario == "stale-generation") {
          "stale_generation"
        } else {
          "view_not_found"
        }
      )
    }
    if (scenario == "fragmented") {
      expect_identical(
        received$responses[[1]]$result$data$source_row,
        list(0L, 1L)
      )
    }

    if (scenario %in% c("disconnect", "duplicate-id")) {
      if (scenario == "duplicate-id") {
        expect_true(received$disconnected)
        expect_true(length(received$responses) <= 1L)
        if (length(received$responses)) {
          expect_identical(
            received$responses[[1]]$error$code,
            "invalid_request"
          )
        }
      }
      cleanup_deadline <- Sys.time() + 5
      while (
        (!is.null(.jdv_transport_status()) ||
          length(ls(.jdv_state$entries, all.names = TRUE)) > 0L) &&
          Sys.time() < cleanup_deadline
      ) {
        jdv_rpc(NULL)
        Sys.sleep(0.01)
      }
      expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
      expect_null(.jdv_transport_status())
      return(invisible(received))
    }

    if (scenario == "empty-registry-close") {
      expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
      expect_identical(jdv_close(), character())
      expect_true(wait_for_file(paste0(result_path, ".closed"), timeout = 5))
      expect_null(jsonlite::fromJSON(
        paste0(result_path, ".closed"),
        simplifyVector = FALSE
      ))
      expect_null(.jdv_transport_status())
      return(invisible(received))
    }

    expect_identical(jdv_close(id), id)
    expect_true(wait_for_file(paste0(result_path, ".closed"), timeout = 5))
    closed <- jsonlite::fromJSON(
      paste0(result_path, ".closed"),
      simplifyVector = FALSE
    )
    expect_identical(closed$method, "view/closed")
    expect_identical(closed$params$view, id)
    expect_identical(.jdv_transport_status(), NULL)
    invisible(received)
  }

  test_that("the local viewer sends hello/open, serves rows, and closes", {
    skip_on_cran()
    skip_if_not_installed("jsonlite")
    skip_if_not_installed("callr")
    received <- with_mock_transport("fragmented", data.frame(value = 11:13))
    expect_identical(
      received$responses[[1]]$result$data$source_row,
      list(0L, 1L)
    )
  })

  test_that(
    "transport rows size explicit wide string pages before extraction",
    {
      skip_on_cran()
      n <- 300L
      text <- rep(strrep("x", 200L), n)
      source <- data.frame(id = seq_len(n))
      for (j in seq_len(150L)) {
        source[[paste0("text", j)]] <- text
      }
      received <- with_mock_transport("explicit-page-sizing", source)
      page <- received$responses[[1L]]$result
      expect_true(page$limit > 0)
      expect_lt(page$limit, n)
      expect_identical(
        unlist(page$data$source_row, use.names = FALSE) + 1,
        as.double(seq.int(n - 3L, length.out = page$limit, by = -1L))
      )
      expect_length(page$data$columns, 151L)
      expect_identical(page$data$columns[[1L]]$schema$name, "text150")
      expect_identical(page$data$columns[[2L]]$schema$name, "id")
      for (column in page$data$columns) {
        dense <- column$data[
          setdiff(names(column$data), c("na_rows", "special"))
        ]
        expect_true(all(vapply(dense, length, integer(1L)) == page$limit))
      }
    }
  )

  test_that("the largest allowed request frame can arrive in one write", {
    skip_on_cran()
    skip_if_not_installed("jsonlite")
    skip_if_not_installed("callr")
    with_mock_transport(
      "maximum-frame",
      data.frame(value = 11:13),
      request_bytes = .jdv_max_request_bytes()
    )
  })

  test_that("full request queues reject only new work and stay connected", {
    skip_on_cran()
    skip_if_not_installed("jsonlite")
    skip_if_not_installed("callr")
    exercise_overflow <- function(scenario, queue_messages, queue_bytes) {
      queued_during_busy <- NULL
      received <- with_mock_transport(
        scenario,
        data.frame(value = 11:13),
        before_poll = function() {
          Sys.sleep(0.4)
          queued_during_busy <<- .jdv_transport_status()
        },
        queue_messages = queue_messages,
        queue_bytes = queue_bytes
      )
      expect_identical(
        queued_during_busy$queued_messages,
        as.double(length(received$queue_accepted_ids))
      )
      expect_true(queued_during_busy$connected)
      expect_lte(queued_during_busy$queued_bytes, queue_bytes)
      expect_identical(
        queued_during_busy$queued_bytes,
        as.double(sum(unlist(received$queue_frame_bytes[
          seq_along(received$queue_accepted_ids)
        ])))
      )
      expect_gt(length(received$queue_rejected_ids), 0L)
      rejected_count <- length(received$queue_rejected_ids)
      for (index in seq_len(rejected_count)) {
        expect_identical(
          received$responses[[index]]$id,
          received$queue_rejected_ids[[index]]
        )
        expect_identical(
          received$responses[[index]]$error$code,
          "limit_exceeded"
        )
      }
      for (index in seq_along(received$queue_accepted_ids)) {
        response <- received$responses[[rejected_count + index]]
        expect_identical(response$id, received$queue_accepted_ids[[index]])
        expect_false("error" %in% names(response))
        expect_identical(response$result$generation, 1L)
      }
    }

    exercise_overflow(
      "queue-overflow-count",
      queue_messages = 2L,
      queue_bytes = 4096L
    )
    exercise_overflow(
      "queue-overflow-bytes",
      queue_messages = 10L,
      queue_bytes = 1100L
    )
  })

  test_that("host EOF closes every registry entry", {
    skip_on_cran()
    skip_if_not_installed("jsonlite")
    skip_if_not_installed("callr")
    with_mock_transport("disconnect", data.frame(value = 11:13))
  })

  test_that(
    "a new viewer API call detects EOF and reconnects without waiting",
    {
      skip_on_cran()
      skip_if_not_installed("jsonlite")
      skip_on_os("windows")
      skip_if_not_installed("callr")
      python <- Sys.which("python3")
      skip_if(!nzchar(python), "python3 is required for the local mock host")

      old_socket <- tempfile("jdv-reconnect-old-", tmpdir = socket_directory)
      old_ready <- tempfile("jdv-reconnect-old-ready-")
      old_result <- tempfile("jdv-reconnect-old-result-")
      close_command <- tempfile("jdv-reconnect-close-command-")
      new_socket <- tempfile("jdv-reconnect-new-", tmpdir = socket_directory)
      new_ready <- tempfile("jdv-reconnect-new-ready-")
      new_result <- tempfile("jdv-reconnect-new-result-")
      old_host <- run_mock_host(
        old_socket,
        old_ready,
        old_result,
        "close-on-command",
        1024^2,
        control_path = close_command
      )
      new_host <- NULL
      old_options <- options(c(
        "jdv.address",
        "jdv.transport.queue_messages",
        "jdv.transport.queue_bytes"
      ))
      on.exit(
        {
          try(jdv_close(), silent = TRUE)
          options(old_options)
          for (host in list(old_host, new_host)) {
            if (!is.null(host)) {
              if (host$is_alive()) {
                host$kill()
              }
              try(host$wait(), silent = TRUE)
            }
          }
          unlink(c(
            old_socket,
            old_ready,
            old_result,
            paste0(old_result, ".closed"),
            close_command,
            new_socket,
            new_ready,
            new_result,
            paste0(new_result, ".sent")
          ))
        },
        add = TRUE
      )

      options(jdv.address = old_socket)
      expect_true(wait_for_file(old_ready))
      counter_before <- .jdv_state$session_counter
      old_id <- jdv_view(
        data.frame(value = 11:13),
        title = "reconnect",
        mode = "paged"
      )
      shared_id <- register_view(
        data.frame(value = 99),
        title = "registered-only",
        mode = "paged"
      )$id
      expect_true(wait_for_file(old_result))
      old_record <- jsonlite::fromJSON(old_result, simplifyVector = FALSE)
      expect_identical(old_record$open$params$generation, 1L)

      new_host <- run_mock_host(
        new_socket,
        new_ready,
        new_result,
        "preflight-frame",
        1024^2
      )
      expect_true(wait_for_file(new_ready))
      observed <- local({
        file.create(close_command)
        expect_true(wait_for_file_without_events(paste0(old_result, ".closed")))
        options(jdv.address = new_socket)
        new_id <- jdv_view(
          data.frame(value = 21:23),
          title = "reconnect",
          mode = "paged"
        )
        expect_false(identical(new_id, old_id))
        entries <- ls(.jdv_state$entries, all.names = TRUE)
        expect_false(old_id %in% entries)
        expect_false(shared_id %in% entries)
        expect_identical(entries, new_id)
        expect_gt(sys.nframe(), 0L)
        expect_true(wait_for_file_without_events(paste0(new_result, ".sent")))
        third_id <- jdv_view(
          data.frame(value = 31:33),
          title = "preflight",
          mode = "paged"
        )
        queued <- .jdv_transport_status()
        expect_false(file.exists(new_result))
        jdv_rpc(NULL)
        list(third_id = third_id, queued = queued)
      })
      expect_identical(observed$queued$queued_messages, 1)
      expect_type(observed$third_id, "character")
      expect_identical(.jdv_state$session_counter, counter_before + 2L)
      expect_false(exists(old_id, envir = .jdv_state$entries, inherits = FALSE))

      expect_true(wait_for_file(new_result))
      new_record <- jsonlite::fromJSON(new_result, simplifyVector = FALSE)
      expect_identical(
        new_record$hello$params$session,
        paste0("r-", Sys.getpid(), "-", counter_before + 2L)
      )
      expect_identical(new_record$open$params$generation, 1L)
      expect_identical(new_record$response$id, "preflight-schema-1")
      expect_false("error" %in% names(new_record$response))
    }
  )

  test_that("a connected transport owns notifications", {
    skip_on_cran()
    skip_if_not_installed("jsonlite")
    skip_if_not_installed("callr")
    jdv_disconnect()
    observed <- NULL
    with_mock_transport(
      "fragmented",
      data.frame(value = 11:13),
      before_poll = function() {
        observed <<- list(
          connection = jdv_connection(),
          error = tryCatch(jdv_notifications(), error = identity)
        )
      }
    )
    expect_identical(observed$connection$owner, "transport")
    expect_identical(observed$connection$state, "connected")
    expect_s3_class(observed$error, "error")
    expect_match(conditionMessage(observed$error), "owns the notifications")
  })

  test_that("a finalizer cannot unload an active transport callback", {
    skip_on_cran()
    skip_if_not_installed("jsonlite")
    skip_on_os("windows")
    skip_if_not_installed("callr")
    skip_if(
      !file.exists(file.path(find.package("jdv"), "Meta", "package.rds")),
      "Active unload requires an installed package"
    )
    python <- Sys.which("python3")
    skip_if(!nzchar(python), "python3 is required for the local mock host")
    socket_path <- tempfile("jdv-active-unload-", tmpdir = socket_directory)
    ready_path <- tempfile("jdv-active-unload-ready-")
    result_path <- tempfile("jdv-active-unload-result-")
    host <- run_mock_host(
      socket_path,
      ready_path,
      result_path,
      "active-unload",
      1024^2
    )
    on.exit(
      {
        if (host$is_alive()) {
          host$kill()
        }
        try(host$wait(), silent = TRUE)
        unlink(c(socket_path, ready_path, result_path))
      },
      add = TRUE
    )
    expect_true(wait_for_file(ready_path))

    child <- callr::r(
      function(libpath, address, result_path) {
        .libPaths(libpath)
        suppressPackageStartupMessages(loadNamespace("jdv"))
        old_namespace <- asNamespace("jdv")
        poll <- get("jdv_rpc", envir = old_namespace)
        assign("jdv_old_namespace", old_namespace, envir = .GlobalEnv)
        assign("jdv_unload_armed", FALSE, envir = .GlobalEnv)
        assign("jdv_unload_reload_error", NULL, envir = .GlobalEnv)
        assign("jdv_unload_method_calls", 0L, envir = .GlobalEnv)
        assign("jdv_unload_attempts", 0L, envir = .GlobalEnv)
        assign("jdv_unload_can_unload", NULL, envir = .GlobalEnv)
        assign("jdv_unload_status", NULL, envir = .GlobalEnv)
        assign("jdv_unload_finalizer_ran", FALSE, envir = .GlobalEnv)
        assign("jdv_unload_parse_succeeded", FALSE, envir = .GlobalEnv)
        finalizer <- local({
          function(e) {
            assign("jdv_unload_finalizer_ran", TRUE, envir = .GlobalEnv)
            parsed <- .Call(
              get("C_jdv_json_parse", envir = old_namespace),
              '{"method":"view/schema","params":{}}',
              1024^2
            )
            assign(
              "jdv_unload_parse_succeeded",
              is.list(parsed),
              envir = .GlobalEnv
            )
            assign(
              "jdv_unload_can_unload",
              .Call(get("C_jdv_transport_can_unload", envir = old_namespace)),
              envir = .GlobalEnv
            )
            assign(
              "jdv_unload_status",
              get(".jdv_transport_status", envir = old_namespace)(),
              envir = .GlobalEnv
            )
            suppressWarnings(unloadNamespace("jdv"))
            reload_error <- tryCatch(loadNamespace("jdv"), error = identity)
            assign("jdv_unload_reload_error", reload_error, envir = .GlobalEnv)
          }
        })
        token <- new.env(parent = emptyenv())
        reg.finalizer(token, finalizer, onexit = TRUE)
        assign(
          "col_display.jdv_unload_vector",
          function(x, ...) {
            assign(
              "jdv_unload_method_calls",
              get("jdv_unload_method_calls", envir = .GlobalEnv) + 1L,
              envir = .GlobalEnv
            )
            if (isTRUE(get("jdv_unload_armed", envir = .GlobalEnv))) {
              assign("jdv_unload_armed", FALSE, envir = .GlobalEnv)
              assign(
                "jdv_unload_attempts",
                get("jdv_unload_attempts", envir = .GlobalEnv) + 1L,
                envir = .GlobalEnv
              )
              gc()
            }
            format(as.integer(x), ...)
          },
          envir = .GlobalEnv
        )
        value <- data.frame(
          value = structure(11:13, class = c("jdv_unload_vector", "integer"))
        )
        options(jdv.address = address)
        jdv::jdv_view(value, mode = "paged")
        rm(token)
        assign("jdv_unload_armed", TRUE, envir = .GlobalEnv)
        deadline <- Sys.time() + 10
        while (
          !file.exists(result_path) &&
            "jdv" %in% loadedNamespaces() &&
            Sys.time() < deadline
        ) {
          try(poll(NULL), silent = TRUE)
          Sys.sleep(0.01)
        }
        while (!file.exists(result_path) && Sys.time() < deadline) {
          Sys.sleep(0.01)
        }
        list(
          namespace_loaded = "jdv" %in% loadedNamespaces(),
          dll_loaded = "jdv" %in% names(getLoadedDLLs()),
          method_calls = get("jdv_unload_method_calls", envir = .GlobalEnv),
          unload_attempts = get("jdv_unload_attempts", envir = .GlobalEnv),
          finalizer_ran = isTRUE(get("jdv_unload_finalizer_ran", .GlobalEnv)),
          parse_succeeded = isTRUE(get(
            "jdv_unload_parse_succeeded",
            .GlobalEnv
          )),
          can_unload = get("jdv_unload_can_unload", envir = .GlobalEnv),
          status = get("jdv_unload_status", envir = .GlobalEnv),
          reload_rejected = inherits(
            get("jdv_unload_reload_error", envir = .GlobalEnv),
            "error"
          ),
          task_callback_present = any(startsWith(
            getTaskCallbackNames(),
            "jdv_transport_"
          )),
          registry_entries = length(ls(old_namespace$.jdv_state$entries))
        )
      },
      args = list(
        libpath = .libPaths(),
        address = socket_path,
        result_path = result_path
      )
    )
    expect_true(wait_for_file(result_path))
    host_result <- jsonlite::fromJSON(result_path, simplifyVector = FALSE)
    expect_true(host_result$disconnected)
    expect_identical(child$method_calls, 2L)
    expect_identical(child$unload_attempts, 1L)
    expect_true(child$finalizer_ran)
    expect_true(child$parse_succeeded)
    expect_false(child$can_unload)
    expect_true(child$status$busy)
    expect_length(host_result$responses, 0L)
    expect_false(child$namespace_loaded)
    expect_true(child$dll_loaded)
    expect_true(child$reload_rejected)
    expect_false(child$task_callback_present)
    expect_identical(child$registry_entries, 0L)
  })

  test_that("native unload closes an active TCP transport", {
    skip_on_cran()
    skip_if_not_installed("jsonlite")
    skip_on_os("windows")
    skip_if_not_installed("callr")
    skip_if(
      !file.exists(file.path(find.package("jdv"), "Meta", "package.rds")),
      "Active unload requires an installed package"
    )
    python <- Sys.which("python3")
    skip_if(!nzchar(python), "python3 is required for the local TCP host")

    run_case <- function(action) {
      ready_path <- tempfile("jdv-tcp-unload-ready-")
      connected_path <- paste0(ready_path, ".connected")
      eof_path <- paste0(ready_path, ".eof")
      host <- run_tcp_unload_host(ready_path, connected_path, eof_path)
      on.exit(
        {
          if (host$is_alive()) {
            host$kill()
          }
          try(host$wait(), silent = TRUE)
          unlink(c(ready_path, connected_path, eof_path))
        },
        add = TRUE
      )
      expect_true(wait_for_file(ready_path))
      address <- readLines(ready_path, warn = FALSE)[[1]]

      child <- callr::r(
        function(libpath, address, connected_path, eof_path, action) {
          .libPaths(libpath)
          loadNamespace("jdv")
          options(jdv.address = address)
          jdv::jdv_view(data.frame(value = 1:3), mode = "paged")
          deadline <- Sys.time() + 5
          while (!file.exists(connected_path) && Sys.time() < deadline) {
            Sys.sleep(0.01)
          }
          stopifnot(file.exists(connected_path))

          hook_eof_seen <- FALSE
          if (action == "namespace") {
            unloadNamespace("jdv")
          } else {
            if (action == "close") {
              close <- get("C_jdv_transport_close", asNamespace("jdv"))
              .Call(close)
            }
            if (action == "hook") {
              unload_hook <- getDLLRegisteredRoutines(getLoadedDLLs()[[
                "jdv"
              ]])[[".C"]][["R_unload_jdv"]]
              .C(unload_hook, 0L)
              .C(unload_hook, 0L)
              deadline <- Sys.time() + 2
              while (!file.exists(eof_path) && Sys.time() < deadline) {
                Sys.sleep(0.01)
              }
              hook_eof_seen <- file.exists(eof_path)
            }
            dyn.unload(getLoadedDLLs()[["jdv"]][["path"]])
          }

          deadline <- Sys.time() + 2
          while (!file.exists(eof_path) && Sys.time() < deadline) {
            Sys.sleep(0.01)
          }
          list(
            eof_seen = file.exists(eof_path),
            hook_eof_seen = hook_eof_seen,
            namespace_loaded = "jdv" %in% loadedNamespaces(),
            dll_loaded = "jdv" %in% names(getLoadedDLLs())
          )
        },
        args = list(
          libpath = .libPaths(),
          address = address,
          connected_path = connected_path,
          eof_path = eof_path,
          action = action
        )
      )
      child
    }

    direct <- run_case("direct")
    expect_true(direct$eof_seen)
    expect_true(direct$namespace_loaded)
    expect_false(direct$dll_loaded)

    namespace <- run_case("namespace")
    expect_true(namespace$eof_seen)
    expect_false(namespace$namespace_loaded)
    expect_false(namespace$dll_loaded)

    closed <- run_case("close")
    expect_true(closed$eof_seen)
    expect_true(closed$namespace_loaded)
    expect_false(closed$dll_loaded)

    registered <- run_case("hook")
    expect_true(registered$hook_eof_seen)
    expect_true(registered$eof_seen)
    expect_true(registered$namespace_loaded)
    expect_false(registered$dll_loaded)
  })

  test_that("close-all stops an active transport with an empty registry", {
    skip_on_cran()
    skip_if_not_installed("jsonlite")
    skip_if_not_installed("callr")
    with_mock_transport("empty-registry-close", data.frame(value = 11:13))
  })

  test_that("multi-megabyte row responses are fully framed", {
    skip_on_cran()
    skip_if_not_installed("jsonlite")
    skip_if_not_installed("callr")
    old_options <- options(
      jdv.max_work_bytes = Inf,
      jdv.max_message_bytes = 32 * 1024^2
    )
    on.exit(options(old_options), add = TRUE)
    value <- strrep("z", 768 * 1024)
    received <- with_mock_transport(
      "large-response",
      data.frame(value = c(value, value))
    )
    rows <- received$responses[[1]]$result$data$columns[[1]]$data$values
    expect_length(rows, 2L)
    expect_identical(nchar(rows[[1]], type = "bytes"), as.integer(768 * 1024))
    expect_identical(rows[[1]], rows[[2]])
  })

  test_that(
    "large forced snapshots send every value beyond request node limits",
    {
      old_options <- options(
        jdv.max_work_bytes = Inf,
        jdv.max_message_bytes = 32 * 1024^2
      )
      on.exit(options(old_options), add = TRUE)
      received <- with_mock_transport(
        "large-snapshot",
        data.frame(first = rep("a", 50000), second = rep("b", 50000)),
        mode = "snapshot"
      )
      expect_gt(received$open_wire_bytes, 500 * 1024)
      expect_identical(received$open$params$nrow, 50000L)
      expect_identical(received$snapshot_value_count, 100000L)
      expect_gt(received$snapshot_node_count, 100000L)
    }
  )

  test_that(
    "safe numeric response ids remain valid when JSON uses an exponent",
    {
      received <- with_mock_transport("numeric-id", data.frame(value = 11:13))
      expect_identical(received$responses[[1]]$id, 1e15)
    }
  )

  test_that(
    "a host that does not read cannot block a large open indefinitely",
    {
      skip_on_cran()
      skip_on_os("windows")
      skip_if_not_installed("callr")
      python <- Sys.which("python3")
      skip_if(!nzchar(python), "python3 is required for the local mock host")
      socket_path <- tempfile(
        "jdv-transport-silent-",
        tmpdir = socket_directory
      )
      ready_path <- tempfile("jdv-transport-ready-")
      result_path <- tempfile("jdv-transport-result-")
      host <- run_mock_host(
        socket_path,
        ready_path,
        result_path,
        "silent",
        1024^2
      )
      old_address <- getOption("jdv.address")
      old_timeout <- getOption("jdv.transport.send_timeout_ms")
      options(jdv.address = socket_path, jdv.transport.send_timeout_ms = 100)
      on.exit(
        {
          try(jdv_close(), silent = TRUE)
          options(
            jdv.address = old_address,
            jdv.transport.send_timeout_ms = old_timeout
          )
          if (host$is_alive()) {
            host$kill()
          }
          try(host$wait(), silent = TRUE)
          unlink(c(
            socket_path,
            ready_path,
            result_path,
            paste0(result_path, ".closed")
          ))
        },
        add = TRUE
      )

      expect_true(wait_for_file(ready_path))
      started <- proc.time()[["elapsed"]]
      error <- tryCatch(
        jdv_view(
          data.frame(value = strrep("x", 8 * 1024^2)),
          mode = "snapshot"
        ),
        error = identity
      )
      elapsed <- proc.time()[["elapsed"]] - started
      expect_s3_class(error, "error")
      expect_lt(elapsed, 3)
      expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
      jdv_rpc(NULL)
      expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
    }
  )

  test_that("cancelled and expired queued work receive terminal responses", {
    skip_on_cran()
    skip_if_not_installed("jsonlite")
    skip_if_not_installed("callr")
    cancelled <- with_mock_transport("cancel", data.frame(value = 11:13))
    expired <- with_mock_transport(
      "expired",
      data.frame(value = 11:13),
      before_poll = function() Sys.sleep(0.3)
    )
    expect_identical(cancelled$responses[[1L]]$error$code, "cancelled")
    expect_identical(expired$responses[[1L]]$error$code, "expired")
  })

  test_that("receiver acknowledges all complete frames cumulatively", {
    skip_on_cran()
    skip_if_not_installed("jsonlite")
    skip_if_not_installed("callr")
    received <- with_mock_transport("ack-controls", data.frame(value = 11:13))
    expect_identical(tail(received$acks, 1L)[[1L]]$params$frames, 4L)
  })

  test_that("stale and closed table requests receive terminal errors", {
    skip_on_cran()
    skip_if_not_installed("jsonlite")
    skip_if_not_installed("callr")
    stale <- with_mock_transport("stale-generation", data.frame(value = 11:13))
    missing <- with_mock_transport("missing-table", data.frame(value = 11:13))
    expect_identical(stale$responses[[1L]]$error$code, "stale_generation")
    expect_identical(missing$responses[[1L]]$error$code, "view_not_found")
  })

  test_that(
    "validly framed requests with invalid parameters get an error reply",
    {
      received <- with_mock_transport(
        "invalid-control",
        data.frame(value = 11:13)
      )
      expect_identical(received$responses[[1]]$error$code, "invalid_request")
    }
  )

  test_that("an invalid cancel id does not cancel a valid queued request", {
    skip_on_cran()
    skip_if_not_installed("jsonlite")
    skip_if_not_installed("callr")
    received <- with_mock_transport("invalid-cancel", data.frame(value = 11:13))
    expect_identical(received$responses[[1]]$error$code, "invalid_request")
    expect_identical(received$responses[[2]]$id, "must-survive")
  })

  test_that("view/refresh over the transport sends view/open before the ACK", {
    skip_on_cran()
    skip_if_not_installed("jsonlite")
    skip_if_not_installed("callr")
    received <- with_mock_transport("refresh", data.frame(value = 11:13))
    expect_identical(received$responses[[1]]$method, "view/open")
    expect_identical(received$responses[[1]]$params$generation, 2L)
    expect_identical(
      received$responses[[1]]$params$view,
      received$open$params$view
    )
    expect_identical(received$responses[[2]]$id, "refresh-1")
    expect_identical(received$responses[[2]]$result$previous_generation, 1L)
    expect_identical(received$responses[[2]]$result$generation, 2L)
    expect_true(received$responses[[2]]$result$refreshed)
    expect_identical(received$responses[[3]]$error$code, "stale_generation")
  })

  test_that(
    "invalid and expired cancel controls do not cancel pending requests",
    {
      with_mock_transport("invalid-encoding-cancel", data.frame(value = 11:13))
      with_mock_transport(
        "invalid-compression-cancel",
        data.frame(value = 11:13)
      )
      with_mock_transport("invalid-deadline-cancel", data.frame(value = 11:13))
      with_mock_transport("expired-cancel", data.frame(value = 11:13))
      received <- with_mock_transport("typed-id", data.frame(value = 11:13))
      expect_identical(received$responses[[1]]$id, 1L)
    }
  )

  test_that("duplicate live request ids close the transport", {
    skip_on_cran()
    skip_if_not_installed("jsonlite")
    skip_if_not_installed("callr")
    with_mock_transport("duplicate-id", data.frame(value = 11:13))
  })

  test_that("synchronous expired requests return a typed error", {
    registered <- register_view(data.frame(value = 1), mode = "paged")
    on.exit(jdv_disconnect(), add = TRUE)
    response <- transport_rpc_call(
      "view/schema",
      list(view = registered$id, generation = 1),
      extra = list(deadline = 1)
    )
    expect_transport_rpc_code(response, "expired")
  })

  test_that("explicit polling without a viewer connection is a no-op", {
    expect_null(jdv_rpc(NULL))
    expect_null(jdv_rpc())
  })

  test_that("closing an embedding-only registration does not connect", {
    registered <- register_view(data.frame(value = 1), mode = "paged")
    on.exit(
      {
        jdv_disconnect()
      },
      add = TRUE
    )
    expect_identical(jdv_close(registered$id), registered$id)
    expect_identical(jdv_close(), character())
    expect_null(.jdv_transport_status())
    expect_null(.jdv_state$transport_task_callback)
  })

  test_that("a failed connection leaves the registry unchanged", {
    skip_on_os("windows")
    old_address <- getOption("jdv.address")
    options(jdv.address = tempfile("jdv-missing-socket-"))
    on.exit(options(jdv.address = old_address), add = TRUE)
    before <- ls(.jdv_state$entries, all.names = TRUE)
    expect_error(jdv_view(data.frame(value = 1), title = "connect-failure"))
    expect_identical(ls(.jdv_state$entries, all.names = TRUE), before)
    expect_null(.jdv_transport_status())
  })

  test_that("viewer discovery follows the user cache and address precedence", {
    old_options <- options(c("jdv.address", "jdv.discovery_path"))
    old_env <- Sys.getenv(
      c("JDV_ADDRESS", "XDG_CACHE_HOME", "LOCALAPPDATA"),
      unset = NA_character_
    )
    on.exit(
      {
        options(old_options)
        for (name in names(old_env)) {
          if (is.na(old_env[[name]])) {
            Sys.unsetenv(name)
          } else {
            do.call(Sys.setenv, setNames(list(old_env[[name]]), name))
          }
        }
      },
      add = TRUE
    )

    discovery_dir <- tempfile("jdv-cache-")
    dir.create(discovery_dir)
    on.exit(unlink(discovery_dir, recursive = TRUE), add = TRUE)
    discovery_file <- file.path(discovery_dir, "discovery.json")
    options(jdv.address = NULL, jdv.discovery_path = NULL)
    Sys.unsetenv("JDV_ADDRESS")
    if (identical(.Platform$OS.type, "windows")) {
      Sys.setenv(LOCALAPPDATA = discovery_dir)
      expected <- file.path(discovery_dir, "jdv", "discovery.json")
    } else if (identical(Sys.info()[["sysname"]], "Darwin")) {
      expected <- file.path(
        path.expand("~"),
        "Library",
        "Caches",
        "jdv",
        "discovery.json"
      )
    } else {
      Sys.setenv(XDG_CACHE_HOME = discovery_dir)
      expected <- file.path(discovery_dir, "jdv", "discovery.json")
    }
    expect_identical(.jdv_discovery_path(), expected)

    options(jdv.discovery_path = discovery_file)
    writeLines('{"socketPath":"unix:///tmp/jdv-mock"}', discovery_file)
    expect_identical(.jdv_resolve_address(), "unix:///tmp/jdv-mock")
    Sys.setenv(JDV_ADDRESS = "tcp://127.0.0.1:43123")
    expect_identical(.jdv_resolve_address(), "tcp://127.0.0.1:43123")
    options(jdv.address = "unix:///tmp/option-address")
    expect_identical(.jdv_resolve_address(), "unix:///tmp/option-address")
  })

  test_that("cancel request ids use the same strict raw-token rules", {
    for (request in c(
      '{"method":"cancel","params":{"id":1.0}}',
      '{"method":"cancel","params":{"id":1e0}}',
      '{"method":"cancel","params":{"id":9007199254740992}}'
    )) {
      expect_transport_rpc_code(jdv_rpc(request), "invalid_request")
    }
    expect_null(jdv_rpc('{"method":"cancel","params":{"id":1}}'))
  })

  test_that(
    "embedded close, eviction, and cascade stay out of a fresh viewer",
    {
      skip_on_cran()
      skip_if_not_installed("jsonlite")
      skip_if_not_installed("callr")
      closed_views <- function(messages) {
        parsed <- lapply(messages, transport_rpc_json)
        parsed <- Filter(function(x) identical(x$method, "view/closed"), parsed)
        vapply(parsed, function(x) x$params$view, "")
      }
      for (action in c("close", "eviction", "cascade")) {
        jdv_disconnect()
        old_options <- options(jdv.max_tables = 2L)
        tryCatch(
          {
            root <- register_view(list(child = list(value = 1L)))
            if (action != "close") {
              child <- transport_rpc_json(transport_rpc_call(
                "object/open",
                list(
                  view = root$id,
                  generation = 1,
                  path = list(list(type = "index", index = 1))
                )
              ))$result
            }
            if (action == "eviction") {
              replacement <- register_view(data.frame(value = 1L))
              expect_setequal(
                closed_views(replacement$notifications),
                c(root$id, child$view)
              )
              expect_false(exists(
                root$id,
                .jdv_state$entries,
                inherits = FALSE
              ))
            } else {
              .jdv_close_internal(root$id, notify = TRUE)
              expect_length(
                closed_views(jdv_notifications()),
                if (action == "cascade") 2L else 1L
              )
            }
            # The embedded session keeps ownership until it is ended explicitly.
            expect_error(jdv_connect("unix:///tmp/jdv-none"), "jdv_disconnect")
            expect_error(jdv_view(data.frame(value = 1L)), "jdv_disconnect")
            expect_identical(jdv_connection()$state, "embedded")
            jdv_disconnect()
            expect_null(.jdv_transport_status())
            expect_identical(jdv_notifications(), character())
            received <- with_mock_transport(
              "fragmented",
              data.frame(value = 11:13)
            )
            expect_identical(received$open$method, "view/open")
            expect_identical(
              received$responses[[1L]]$result$data$source_row,
              list(0L, 1L)
            )
            expect_length(.jdv_state$queue, 0L)
          },
          finally = {
            jdv_disconnect()
            options(old_options)
          }
        )
      }
    }
  )

  test_that(
    "active connections retain cascade and eviction close notifications",
    {
      skip_on_cran()
      skip_if_not_installed("jsonlite")
      skip_on_os("windows")
      skip_if_not_installed("callr")
      skip_if(
        !nzchar(Sys.which("python3")),
        "python3 is required for the local mock host"
      )
      jdv_close()
      socket_path <- tempfile("jdv-notifications-", tmpdir = socket_directory)
      ready_path <- tempfile("jdv-notifications-ready-")
      result_path <- tempfile("jdv-notifications-result-")
      host <- run_mock_host(
        socket_path,
        ready_path,
        result_path,
        "notifications",
        1024^2
      )
      old_options <- options(jdv.address = socket_path, jdv.max_tables = 64L)
      on.exit(
        {
          try(jdv_close(), silent = TRUE)
          options(old_options)
          if (host$is_alive()) {
            host$kill()
          }
          try(host$wait(), silent = TRUE)
          unlink(c(socket_path, ready_path, result_path))
        },
        add = TRUE
      )
      expect_true(wait_for_file(ready_path))
      anchor <- jdv_view(data.frame(value = 1L), title = "active-anchor")
      root <- jdv_view(list(child = list(value = 2L)), title = "active-parent")
      child <- transport_rpc_json(transport_rpc_call(
        "object/open",
        list(
          view = root,
          generation = 1,
          path = list(list(type = "index", index = 1))
        )
      ))$result
      jdv_close(root)
      options(jdv.max_tables = 2L)
      victim <- jdv_view(data.frame(value = 3L), title = "active-victim")
      replacement <- jdv_view(
        data.frame(value = 4L),
        title = "active-replacement"
      )
      jdv_close()
      expect_true(wait_for_file(result_path))
      messages <- jsonlite::fromJSON(
        result_path,
        simplifyVector = FALSE
      )$messages
      closed <- Filter(
        function(message) identical(message$method, "view/closed"),
        messages
      )
      expect_setequal(
        vapply(closed, function(message) message$params$view, ""),
        c(child$view, root, anchor, victim, replacement)
      )
      expect_identical(
        sum(vapply(
          closed,
          function(message) identical(message$params$view, child$view),
          logical(1L)
        )),
        1L
      )
      child_notice <- closed[[
        which(vapply(
          closed,
          function(message) identical(message$params$view, child$view),
          logical(1L)
        ))
      ]]
      expect_identical(child_notice$params$reason, "parent_closed")
      opened <- Filter(
        function(message) identical(message$method, "view/open"),
        messages
      )
      expect_identical(
        vapply(opened, function(message) message$params$view, ""),
        c(anchor, root, child$view, victim, replacement)
      )
    }
  )
  test_that(
    "overlong Unix socket paths report byte limits and clean setup state",
    {
      skip_on_os("windows")
      for (path in c(
        paste0("/", strrep("x", 110)),
        paste0("/", strrep("é", 60))
      )) {
        bytes <- nchar(enc2utf8(path), type = "bytes")
        expect_error(
          .jdv_transport_connect(path),
          paste0(
            "Unix socket path is too long ",
            "\\(",
            bytes,
            " bytes; maximum [0-9]+ bytes"
          )
        )
        expect_null(.jdv_state$transport)
        expect_true(.Call(C_jdv_transport_can_unload))
        expect_false(.Call(C_jdv_transport_status)$connected)
      }
    }
  )

  # Connection lifecycle: explicit (persistent) and implicit connections.
  lifecycle_host <- function() {
    skip_on_cran()
    skip_on_os("windows")
    skip_if_not_installed("callr")
    skip_if_not_installed("jsonlite")
    python <- Sys.which("python3")
    skip_if(!nzchar(python), "python3 is required for the local mock host")
    jdv_disconnect()
    host <- list(
      socket = tempfile("jdv-life-", tmpdir = socket_directory),
      ready = tempfile("jdv-life-ready-"),
      result = tempfile("jdv-life-result-"),
      control = tempfile("jdv-life-control-")
    )
    process <- callr::r_bg(
      function(python, script, socket, ready, result, control) {
        system2(
          python,
          c(
            shQuote(script),
            "--socket",
            shQuote(socket),
            "--ready",
            shQuote(ready),
            "--result",
            shQuote(result),
            "--control",
            shQuote(control)
          ),
          stdout = TRUE,
          stderr = TRUE
        )
      },
      args = list(
        python = python,
        script = test_path("fixtures", "transport-lifecycle-host.py"),
        socket = host$socket,
        ready = host$ready,
        result = host$result,
        control = host$control
      ),
      supervise = TRUE
    )
    old_address <- options(jdv.address = host$socket)
    host$cleanup <- function() {
      try(jdv_disconnect(), silent = TRUE)
      options(old_address)
      if (process$is_alive()) {
        process$kill()
      }
      try(process$wait(), silent = TRUE)
      unlink(c(
        host$socket,
        host$ready,
        host$result,
        host$control,
        paste0(host$result, c(".eof", ".tmp"))
      ))
    }
    host$wait_ready <- function() wait_for_file(host$ready)
    host
  }

  lifecycle_messages <- function(host, count = 0L, timeout = 10) {
    deadline <- Sys.time() + timeout
    repeat {
      messages <- if (file.exists(host$result)) {
        jsonlite::fromJSON(host$result, simplifyVector = FALSE)$messages
      } else {
        list()
      }
      if (length(messages) >= count || Sys.time() > deadline) {
        break
      }
      Sys.sleep(0.01)
    }
    vapply(messages, function(message) message$method %||% "response", "")
  }

  test_that(
    "jdv_connect sends hello with no view and survives the last close",
    {
      host <- lifecycle_host()
      on.exit(host$cleanup(), add = TRUE)
      expect_true(host$wait_ready())
      expect_identical(jdv_connection()$state, "disconnected")
      expect_null(jdv_connection()$address)

      status <- withVisible(jdv_connect())
      expect_false(status$visible)
      expect_identical(status$value$state, "connected")
      expect_true(status$value$connected)
      expect_true(status$value$persistent)
      expect_identical(status$value$address, host$socket)
      expect_identical(lifecycle_messages(host, 1L), "hello")

      first <- jdv_view(mtcars, title = "life-first")
      expect_identical(lifecycle_messages(host, 2L), c("hello", "view/open"))
      expect_identical(jdv_close(), first)
      expect_identical(
        lifecycle_messages(host, 3L),
        c("hello", "view/open", "view/closed")
      )
      expect_identical(jdv_connection()$state, "connected")
      expect_true(jdv_connection()$persistent)

      second <- jdv_view(mtcars, title = "life-second")
      expect_identical(
        lifecycle_messages(host, 4L),
        c("hello", "view/open", "view/closed", "view/open")
      )
      expect_identical(jdv_close(second), second)
      expect_true(jdv_connection()$connected)
      # Closing with no views left also keeps a persistent connection.
      expect_identical(jdv_close(), character())
      expect_true(jdv_connection()$connected)
      expect_false(file.exists(paste0(host$result, ".eof")))
    }
  )

  test_that("an implicit connection closes after the last view/closed", {
    host <- lifecycle_host()
    on.exit(host$cleanup(), add = TRUE)
    expect_true(host$wait_ready())
    id <- jdv_view(mtcars, title = "life-implicit")
    state <- jdv_connection()
    expect_identical(state$state, "connected")
    expect_false(state$persistent)
    expect_identical(state$address, host$socket)
    expect_identical(lifecycle_messages(host, 2L), c("hello", "view/open"))

    jdv_close(id)
    expect_true(wait_for_file(paste0(host$result, ".eof")))
    expect_identical(
      lifecycle_messages(host),
      c("hello", "view/open", "view/closed")
    )
    state <- jdv_connection()
    expect_identical(state$state, "disconnected")
    expect_false(state$connected)
    expect_false(state$persistent)
    expect_null(state$address)
    expect_identical(state$last_disconnect_reason, "last_view_closed")
  })

  test_that(
    "a host view/close ends an implicit connection after its response",
    {
      host <- lifecycle_host()
      on.exit(host$cleanup(), add = TRUE)
      expect_true(host$wait_ready())
      jdv_view(mtcars, title = "life-host-close")
      expect_identical(lifecycle_messages(host, 2L), c("hello", "view/open"))
      file.create(host$control)
      # Requests run at an event gate or an explicit poll; tests are not idle.
      deadline <- Sys.time() + 5
      while (
        !file.exists(paste0(host$result, ".eof")) && Sys.time() < deadline
      ) {
        jdv_rpc(NULL)
        Sys.sleep(0.01)
      }
      expect_true(file.exists(paste0(host$result, ".eof")))
      # The response reaches the host before the peer sees EOF.
      expect_identical(
        lifecycle_messages(host, 3L),
        c("hello", "view/open", "response")
      )
      messages <- jsonlite::fromJSON(
        host$result,
        simplifyVector = FALSE
      )$messages
      expect_identical(messages[[3L]]$id, "host-close-1")
      expect_true(messages[[3L]]$result$closed)
      # Native cleanup runs at the next safe point; poll it explicitly.
      deadline <- Sys.time() + 5
      while (
        !identical(jdv_connection()$state, "disconnected") &&
          Sys.time() < deadline
      ) {
        jdv_rpc(NULL)
        Sys.sleep(0.01)
      }
      expect_identical(jdv_connection()$state, "disconnected")
      expect_identical(
        jdv_connection()$last_disconnect_reason,
        "last_view_closed"
      )
    }
  )

  test_that("a host view/close keeps a persistent connection open", {
    host <- lifecycle_host()
    on.exit(host$cleanup(), add = TRUE)
    expect_true(host$wait_ready())
    jdv_connect()
    jdv_view(mtcars, title = "life-host-close-persistent")
    expect_identical(lifecycle_messages(host, 2L), c("hello", "view/open"))
    file.create(host$control)
    messages <- NULL
    deadline <- Sys.time() + 5
    while (length(messages) < 3L && Sys.time() < deadline) {
      jdv_rpc(NULL)
      Sys.sleep(0.01)
      messages <- jsonlite::fromJSON(
        host$result,
        simplifyVector = FALSE
      )$messages
    }
    expect_identical(messages[[3L]]$id, "host-close-1")
    expect_true(jdv_connection()$connected)
    expect_false(file.exists(paste0(host$result, ".eof")))
  })

  test_that("jdv_connect promotes an implicit connection without a new hello", {
    host <- lifecycle_host()
    on.exit(host$cleanup(), add = TRUE)
    expect_true(host$wait_ready())
    id <- jdv_view(mtcars, title = "life-promote")
    expect_false(jdv_connection()$persistent)
    state <- jdv_connect()
    expect_true(state$persistent)
    expect_identical(state$address, host$socket)
    expect_identical(lifecycle_messages(host, 2L), c("hello", "view/open"))
    jdv_close(id)
    expect_identical(
      lifecycle_messages(host, 3L),
      c("hello", "view/open", "view/closed")
    )
    expect_true(jdv_connection()$connected)
    expect_false(file.exists(paste0(host$result, ".eof")))
  })

  test_that("jdv_view follows a variable and sends the update", {
    skip_if_not(.jdv_track_supported())
    host <- lifecycle_host()
    on.exit(host$cleanup(), add = TRUE)
    expect_true(host$wait_ready())
    df <- mtcars
    expect_no_warning(id <- jdv_view(df))
    entry <- get(id, envir = .jdv_state$entries, inherits = FALSE)
    expect_identical(entry$title, "df")
    expect_identical(entry$track_name, "df")
    expect_identical(.Call(C_jdv_weakref_key, entry$track_ref), environment())
    expect_true(
      "jdv_track_pid" %in% sub("[0-9]+$", "pid", getTaskCallbackNames())
    )
    expect_identical(lifecycle_messages(host, 2L), c("hello", "view/open"))

    df <- df[1:5, ]
    # The embedding-style poll also sends the queue to the transport.
    jdv_rpc(NULL)
    expect_identical(
      lifecycle_messages(host, 3L),
      c("hello", "view/open", "view/open")
    )
    expect_identical(
      get(id, envir = .jdv_state$entries, inherits = FALSE)$generation,
      2
    )

    # The task callback does the same after a top-level task.
    df <- df[1:3, ]
    expect_true(.jdv_track_task_callback(NULL, NULL, TRUE, FALSE))
    expect_identical(
      lifecycle_messages(host, 4L),
      c("hello", "view/open", "view/open", "view/open")
    )
  })

  test_that("resource changes reach the transport and merge until sent", {
    host <- lifecycle_host()
    on.exit(host$cleanup(), add = TRUE)
    expect_true(host$wait_ready())
    jdv_connect()
    expect_identical(lifecycle_messages(host, 1L), "hello")
    response <- .jdv_json_parse(jdv_rpc(.jdv_json_encode(list(
      id = "sub-1",
      method = "resources/subscribe",
      params = list(enabled = TRUE)
    ))))
    expect_true(response$result$enabled)
    on.exit(
      suppressWarnings(rm(
        list = c("jdvtrans_a", "jdvtrans_b"),
        envir = globalenv()
      )),
      add = TRUE
    )

    assign("jdvtrans_a", 1, envir = globalenv())
    jdv_rpc(NULL)
    expect_identical(
      lifecycle_messages(host, 2L),
      c("hello", "resources/changed")
    )
    expect_false(.jdv_state$res_pending)

    # An unchanged listing sends nothing; a later change is sent again.
    jdv_rpc(NULL)
    assign("jdvtrans_b", 1, envir = globalenv())
    jdv_rpc(NULL)
    expect_identical(
      lifecycle_messages(host, 3L),
      c("hello", "resources/changed", "resources/changed")
    )

    # While one is queued and not yet sent, more changes add nothing.
    .jdv_state$res_pending <- FALSE
    .jdv_resources_notify_changed()
    for (i in 1:300) {
      expect_false(.jdv_resources_notify_changed())
    }
    expect_length(.jdv_state$queue, 1L)
    jdv_disconnect()
    expect_false(.jdv_state$res_subscribed)
    expect_false(.jdv_state$res_pending)
  })

  test_that(
    "jdv_view uses NULL collation as option intent and preserves title defaults",
    {
      host <- lifecycle_host()
      on.exit(host$cleanup(), add = TRUE)
      expect_true(host$wait_ready())
      old_collation <- options(jdv.collation = "locale")
      on.exit(options(old_collation), add = TRUE)

      source <- mtcars
      id <- jdv_view(source, track = FALSE)
      entry <- get(id, envir = .jdv_state$entries, inherits = FALSE)
      expect_identical(entry$title, "source")
      expect_identical(entry$collation, "locale")
      expect_null(entry$intent_collation)

      null_title_id <- jdv_view(
        source,
        title = NULL,
        collation = NULL,
        track = FALSE
      )
      null_title <- get(
        null_title_id,
        envir = .jdv_state$entries,
        inherits = FALSE
      )
      expect_null(null_title$title)
      expect_identical(null_title$collation, "locale")
      expect_null(null_title$intent_collation)

      fixed_id <- jdv_view(
        source,
        title = "fixed-collation",
        collation = "locale",
        track = FALSE
      )
      fixed <- get(fixed_id, envir = .jdv_state$entries, inherits = FALSE)
      expect_identical(fixed$collation, "locale")
      expect_identical(fixed$intent_collation, "locale")
    }
  )

  test_that("jdv_view tracks only a plain symbol and only on request", {
    skip_if_not(.jdv_track_supported())
    host <- lifecycle_host()
    on.exit(host$cleanup(), add = TRUE)
    expect_true(host$wait_ready())
    df <- mtcars
    expression_id <- jdv_view(head(df), title = "expression")
    fixed_id <- jdv_view(df, title = "fixed", track = FALSE)
    for (id in c(expression_id, fixed_id)) {
      entry <- get(id, envir = .jdv_state$entries, inherits = FALSE)
      expect_null(entry$track_ref)
    }
    expect_false(.jdv_track_active())
    expect_error(jdv_view(df, track = NA), "'track'")
    expect_error(jdv_view(df, track = "yes"), "'track'")
    df <- df[1:2, ]
    jdv_rpc(NULL)
    expect_identical(
      lifecycle_messages(host, 3L),
      c("hello", "view/open", "view/open")
    )
  })

  test_that("jdv_view fixes the owning environment of the symbol", {
    skip_if_not(.jdv_track_supported())
    host <- lifecycle_host()
    on.exit(host$cleanup(), add = TRUE)
    expect_true(host$wait_ready())
    outer <- environment()
    df <- mtcars
    id <- local({
      id <- jdv_view(df)
      # An inner variable of the same name does not take over.
      df <- mtcars[1:2, ]
      id
    })
    entry <- get(id, envir = .jdv_state$entries, inherits = FALSE)
    expect_identical(.Call(C_jdv_weakref_key, entry$track_ref), outer)
    jdv_rpc(NULL)
    expect_identical(entry$generation, 1)
    df <- mtcars[1:4, ]
    jdv_rpc(NULL)
    expect_identical(
      get(id, envir = .jdv_state$entries, inherits = FALSE)$generation,
      2
    )

    # A formal argument is its own binding, not the caller's variable.
    show <- function(x) jdv_view(x, title = "formal")
    formal_id <- show(df)
    formal <- get(formal_id, envir = .jdv_state$entries, inherits = FALSE)
    expect_false(identical(.Call(C_jdv_weakref_key, formal$track_ref), outer))
    expect_identical(formal$track_name, "x")
    df <- mtcars[1:6, ]
    jdv_rpc(NULL)
    expect_identical(
      get(formal_id, envir = .jdv_state$entries, inherits = FALSE)$generation,
      1
    )
    expect_identical(
      get(id, envir = .jdv_state$entries, inherits = FALSE)$generation,
      3
    )
  })

  test_that("jdv_view warns once when tracking is not possible", {
    host <- lifecycle_host()
    on.exit(host$cleanup(), add = TRUE)
    expect_true(host$wait_ready())
    df <- mtcars
    testthat::local_mocked_bindings(.jdv_track_supported = function() FALSE)
    warned <- .jdv_state$track_version_warned
    on.exit(.jdv_state$track_version_warned <- warned, add = TRUE)
    .jdv_state$track_version_warned <- FALSE
    expect_warning(id <- jdv_view(df, title = "older"), "not tracked.*4\\.6")
    expect_identical(lifecycle_messages(host, 2L), c("hello", "view/open"))
    expect_null(get(id, envir = .jdv_state$entries, inherits = FALSE)$track_ref)
    # The R version warning is given once per session.
    expect_no_warning(jdv_view(df, title = "older again"))
    # No warning for a call that is not tracked on purpose.
    expect_no_warning(jdv_view(df, title = "fixed", track = FALSE))
    expect_no_warning(jdv_view(head(df), title = "expression"))
  })

  test_that("jdv_view shows an unreadable binding and warns", {
    skip_if_not(.jdv_track_supported())
    host <- lifecycle_host()
    on.exit(host$cleanup(), add = TRUE)
    expect_true(host$wait_ready())
    makeActiveBinding("live_table", function() mtcars, environment())
    expect_warning(
      id <- jdv_view(live_table),
      "not tracked.*without evaluating"
    )
    expect_identical(lifecycle_messages(host, 2L), c("hello", "view/open"))
    expect_null(get(id, envir = .jdv_state$entries, inherits = FALSE)$track_ref)
    expect_false(.jdv_track_active())
  })

  test_that("jdv_connect is idempotent and rejects another address", {
    host <- lifecycle_host()
    on.exit(host$cleanup(), add = TRUE)
    expect_true(host$wait_ready())
    expect_error(jdv_connect(c("a", "b")), "one non-empty address")
    jdv_connect()
    expect_identical(jdv_connect()$address, host$socket)
    expect_identical(jdv_connect(host$socket)$address, host$socket)
    expect_error(
      jdv_connect(paste0(host$socket, "-other")),
      "jdv_disconnect\\(\\)"
    )
    # The failed request leaves the connection and its hello untouched.
    expect_true(jdv_connection()$connected)
    expect_identical(lifecycle_messages(host, 1L), "hello")
    Sys.sleep(0.1)
    expect_identical(lifecycle_messages(host), "hello")
  })

  test_that("jdv_disconnect closes every view and is idempotent", {
    host <- lifecycle_host()
    on.exit(host$cleanup(), add = TRUE)
    expect_true(host$wait_ready())
    # Nothing to do when not connected.
    previous_reason <- jdv_connection()$last_disconnect_reason
    state <- withVisible(jdv_disconnect())
    expect_false(state$visible)
    expect_identical(state$value$state, "disconnected")
    expect_identical(state$value$last_disconnect_reason, previous_reason)

    jdv_connect()
    first <- jdv_view(mtcars, title = "life-disc-1")
    second <- jdv_view(mtcars, title = "life-disc-2")
    registered <- register_view(mtcars, title = "life-disc-embedded")
    expect_length(ls(.jdv_state$entries, all.names = TRUE), 3L)

    state <- jdv_disconnect()
    expect_identical(state$state, "disconnected")
    expect_false(state$persistent)
    expect_null(state$address)
    expect_identical(state$last_disconnect_reason, "disconnect")
    expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
    expect_true(wait_for_file(paste0(host$result, ".eof")))
    expect_identical(jdv_disconnect()$state, "disconnected")
    expect_identical(jdv_connection()$last_disconnect_reason, "disconnect")
    expect_identical(jdv_close(first), character())
  })

  test_that("a peer disconnect ends the session without reconnecting", {
    host <- lifecycle_host()
    on.exit(host$cleanup(), add = TRUE)
    expect_true(host$wait_ready())
    jdv_connect()
    jdv_view(mtcars, title = "life-peer")
    expect_identical(lifecycle_messages(host, 2L), c("hello", "view/open"))
    file.create(paste0(host$control, ".close"))
    deadline <- Sys.time() + 5
    while (
      !identical(jdv_connection()$state, "disconnected") &&
        Sys.time() < deadline
    ) {
      jdv_rpc(NULL)
      Sys.sleep(0.01)
    }
    state <- jdv_connection()
    expect_identical(state$state, "disconnected")
    expect_identical(state$last_disconnect_reason, "peer_closed")
    expect_false(state$persistent)
    expect_length(ls(.jdv_state$entries, all.names = TRUE), 0L)
    # No automatic reconnect: the next explicit call starts a new session.
    expect_identical(jdv_connection()$state, "disconnected")
  })
})
