.onLoad <- function(libname, pkgname) {
  if (
    !isTRUE(.Call(C_jdv_transport_can_unload)) ||
      .Call(C_jdv_arrow_status)[["busy"]] != 0L
  ) {
    stop(
      "A previous jdv native callback is still shutting down.",
      call. = FALSE
    )
  }
}

.onUnload <- function(libpath) {
  .jdv_state$unloading <- TRUE
  .jdv_transport_housekeeping()
  .jdv_transport_close("unloaded")
  .Call(C_jdv_arrow_cleanup)
  .jdv_transport_remove_task_callback()
  .jdv_track_remove_callback()
  .jdv_resources_release()
  .jdv_close_internal(notify = FALSE)
  .jdv_queue_reset()
  .jdv_state$embedded <- FALSE
  .jdv_state$transport <- NULL
  .jdv_state$transport_hello <- FALSE
  .jdv_state$transport_persistent <- FALSE
  .jdv_state$transport_address <- NULL
  .jdv_state$last_disconnect_reason <- "unloaded"
  .jdv_state$transport_close_reason <- NULL
  if (
    !isTRUE(.Call(C_jdv_transport_can_unload)) ||
      .Call(C_jdv_arrow_status)[["busy"]] != 0L
  ) {
    warning(
      paste(
        "The jdv native library remains loaded while native calls are active;",
        "an idle reload/unload can release it later."
      ),
      call. = FALSE
    )
    return(invisible(NULL))
  }
  library.dynam.unload("jdv", libpath)
}
