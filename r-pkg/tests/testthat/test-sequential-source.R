test_that(
  "Arrow source adapters preserve objects and select sequential registration",
  {
    skip_if_not_installed("arrow")
    skip_if_not_installed("nanoarrow")
    table <- arrow::arrow_table(x = 1:3)
    objects <- list(
      table,
      arrow::as_record_batch_reader(table),
      nanoarrow::as_nanoarrow_array_stream(data.frame(x = 1:3))
    )
    seen <- list()
    local_mocked_bindings(
      .jdv_sequential_register = function(
        x,
        title = NULL,
        reason,
        title_slot = TRUE
      ) {
        seen[[length(seen) + 1L]] <<- x
        list(
          id = "sequential-adapter",
          generation = 1,
          open = '{"method":"view/open","params":{"view":"sequential-adapter"}}'
        )
      },
      .package = "jdv"
    )
    for (object in objects) {
      source <- jdv_source(object)
      expect_identical(source$kind, "grid")
      expect_identical(source$access, "sequential")
      expect_identical(source$data, object)
      expect_identical(register_view(object)$id, "sequential-adapter")
    }
    expect_identical(seen, objects)
  }
)

test_that(
  "Polars default exports enter sequential views without a runtime dependency",
  {
    skip_if_not_installed("polars")
    skip_if_not_installed("nanoarrow")
    frame <- polars::pl$DataFrame(id = 1:3, label = c("a", "b", "c"))
    expect_true(inherits(frame, "polars_data_frame"))
    expect_identical(jdv_source(frame)$access, "sequential")
    view <- register_view(frame)
    on.exit(.jdv_close_internal(view$id), add = TRUE)
    descriptor <- .jdv_json_parse(view$open)$params
    expect_identical(descriptor$kind, "grid")
    expect_identical(descriptor$access, "sequential")
    expect_identical(descriptor$encoding, "arrow-ipc")
    response <- .jdv_rpc_internal(
      .jdv_json_encode(list(
        id = "polars",
        method = "stream/next",
        params = list(view = view$id, generation = 1, max_rows = 2)
      )),
      allow_binary = TRUE
    )
    expect_s3_class(response, "jdv_binary_packet")
    expect_identical(.jdv_json_parse(response$header)$result$rows_fetched, 2)
    stream <- nanoarrow::read_nanoarrow(response$payload, lazy = TRUE)
    output <- nanoarrow::convert_array_stream(stream)
    expect_identical(output$id, 1:2)
    expect_identical(output$label, c("a", "b"))
  }
)

test_that("registration calls get_schema without fetching even one batch", {
  with_arrow_owner(function(owner) {
    calls <- 0L
    source <- owner$stream(
      hook = function(event) if (event == "next") calls <<- calls + 1L
    )
    view <- register_view(source)
    expect_identical(calls, 0L)
    expect_identical(owner$counts()[[3L]], 0L)
    expect_identical(.jdv_json_parse(view$open)$params$access, "sequential")
    .jdv_close_internal(view$id)
    expect_identical(calls, 0L)
    expect_equal(owner$counts(), c(1, 1, 0, 0))
  })
})
