## Resubmission

This is a resubmission. In response to the review of the previous submission:

- Replaced the `\dontrun{}` example of `jdv_rpc()`. The example now runs a
  short request through the embedding API, which needs no external software.
  The part that polls an external viewer application in a loop needs that
  application to be running, so it is wrapped in `if (interactive())` instead.
  No `\dontrun{}` remains in the package.
- Added Paul Hsieh to `Authors@R` with the roles `ctb` and `cph`. His portable
  `stdint.h` (BSD license) is part of the flatcc runtime bundled in
  `src/nanoarrow/`. I checked the copyright notices of all bundled C sources
  again: the other holders (Dave Gamble and cJSON contributors, the Apache
  Software Foundation, and Mikkel F. Jørgensen) were already listed.
  `inst/COPYRIGHTS` now also describes the separately licensed headers in the
  bundled flatcc runtime and reproduces the BSD license of `pstdint.h`. The
  original notices in the source files are kept unchanged.

Since the previous submission, the package also gained an optional resource
tree that lets the viewer list the objects in the global environment and open
them.

## R CMD check results

0 errors | 0 warnings | 1 note

- This is a new release.

## Additional notes

- 'polars' in Suggests is distributed from R-multiverse (see
  `Additional_repositories`); all tests that use it are skipped when it is
  not installed.
- The package bundles cJSON (MIT, `src/cjson/`) and the nanoarrow C library
  with flatcc (Apache-2.0, `src/nanoarrow/`). Copyright holders are listed in
  `Authors@R` and details are in `inst/COPYRIGHTS`. nanoarrow is a development
  snapshot because the released version cannot write dictionary arrays to
  Arrow IPC streams, which this package needs.
