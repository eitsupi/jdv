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
