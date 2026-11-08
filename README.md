# jdv — A Data Viewer for R

jdv is a lightweight (C-based, zero dependency) data viewer for R.

## Features

jdv has three kinds of views:

- **Data frames:** Sort, filter, and page through data frames and matrices.
- **Lists:** Browse lists and other R objects as a tree.
- **Apache Arrow:** View Arrow data as is, through the Arrow C stream interface.

The viewer also has a resource explorer. Once R connects, it lists the
variables of the global environment, so you can open one without calling
`jdv_view()`.

## Why jdv?

In [vscode-R](https://github.com/REditorSupport/vscode-R),
[jgd](https://github.com/REditorSupport/jgd) proved useful as a development
dependency because it has no dependencies of its own. jdv does the same for
viewing data.

## Usage

Start the reference server with [Deno](https://deno.com/) 2.8 or newer:

```sh
deno run --allow-net --allow-read --allow-write --allow-env --no-config https://raw.githubusercontent.com/eitsupi/jdv/main/server/main.ts
```

> [!NOTE]
> On Windows, R connects through a named pipe by default, which requires `-A`:
>
> ```sh
> deno run -A --no-config https://raw.githubusercontent.com/eitsupi/jdv/main/server/main.ts
> ```
>
> Alternatively, add `--tcp` to the first command to use TCP instead.

Open the printed URL in a browser, then in R:

```r
jdv::jdv_view(penguins)
```

## Examples

Lists open as a tree:

```r
jdv::jdv_view(list(summary = summary(penguins), first_rows = head(penguins)))
```

Arrow data (requires nanoarrow):

```r
jdv::jdv_view(arrow::as_arrow_table(penguins))
jdv::jdv_view(polars::as_polars_df(penguins))
```

Other Arrow sources can be passed as a nanoarrow array stream:

```r
jdv::jdv_view(nanoarrow::as_nanoarrow_array_stream(x))
```

Alternatively, run `jdv::jdv_connect()` and pick a variable in the resource
explorer on the page. Variables are listed without being evaluated, so promises
and active bindings are left alone, and variables starting with a dot are hidden
until you choose to show them. A variable opened this way follows reassignment
on R 4.6 or newer. To turn the explorer off, set `options(jdv.resources = FALSE)`
before connecting.

See `?jdv_view` for the R interface.

## How it works

jdv separates the process that holds the data (the producer) from the host and
the browser viewer. The R package is one producer. It answers requests from a
host over a Unix domain socket, a Windows named pipe, or TCP, using JSON Lines;
Arrow pages are sent as Arrow IPC. The protocol does not depend on R, so a
producer written in another language can use the same host and viewer.

A producer offers data in one of two ways:

- **JSON grids** have a known row count. Either the grid is sent whole and the
  browser sorts and filters it, or the producer sorts and filters the data and
  returns any requested page. In `jdv_view()` these are the Snapshot and Paged
  modes, and the default auto mode picks one based on configured size limits.
- **Arrow streams** are read forward, one page at a time, and the total row
  count does not need to be known. Use them for data that is expensive to
  count, such as query results.

JSON grid columns send missing positions as `na_rows` and non-finite numeric
positions as `special` objects keyed by `nan`, `pos_inf`, and `neg_inf`.
Positions start at zero within each response; Snapshot data and pages share
this format. An empty `na_rows` array means no missing rows, while an absent
channel means missingness could not be extracted.

A producer can also offer a resource tree, a browsable listing of what it can
show. The R package serves the global environment as one.

See `?jdv_spec` and `?jdv_query_spec` for the protocol. The common protocol is
separate from the R producer's extensions. The [reference server](server/README.md)
is one such host.

## Limitations

- Arrow views read forward only and cannot be sorted or filtered.
- TCP connections are not authenticated.

## Acknowledgements

Bundled code:

- [cJSON](https://github.com/DaveGamble/cJSON) for JSON encoding and parsing.
- [nanoarrow](https://github.com/apache/arrow-nanoarrow), including the
  [flatcc](https://github.com/dvidelabs/flatcc) runtime, for Arrow C data and
  IPC.
- [Apache Arrow JavaScript](https://github.com/apache/arrow-js) for reading
  Arrow IPC in the browser.
- [Tabulator](https://github.com/olifolkerd/tabulator) for the browser grid.

Design references:

- [vscode-R](https://github.com/REditorSupport/vscode-R),
  [julia-vscode](https://github.com/julia-vscode/julia-vscode),
  [datasetviewer](https://github.com/vthanik/datasetviewer), and
  [dtsmartr](https://github.com/wagh-nikhil/dtsmartr) for data viewers.
- [later](https://github.com/r-lib/later) for running work from R's event loop.
- [vctrs](https://github.com/r-lib/vctrs) and
  [pillar](https://github.com/r-lib/pillar) for handling and displaying R
  values.
- [Perspective](https://github.com/perspective-dev/perspective),
  [Streamlit](https://github.com/streamlit/streamlit),
  [Lonboard](https://github.com/developmentseed/lonboard), and
  [VegaFusion](https://github.com/vega/vegafusion) for sending Arrow data to the
  browser.

## License

MIT. See [LICENSE.md](LICENSE.md). Bundled code keeps its own license.
