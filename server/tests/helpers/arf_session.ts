/** Test-only control for a real arf headless R session. */
import { dirname, join, resolve } from "node:path";
import { removeCacheDirectory } from "../integration_cleanup.ts";

export interface ArfEvalResult {
  stdout: string | null;
  stderr: string | null;
  value: string | null;
  error: string | null;
  /** Reported by arf 0.7.0-beta.2 and later, for example "ok". */
  status?: string;
}

export interface ArfEvalHandle {
  /** Resolves when R has finished evaluating the submitted expression. */
  result: Promise<ArfEvalResult>;
  wait(timeoutMs?: number): Promise<ArfEvalResult>;
  waitForOutput(
    predicate: (text: string) => boolean,
    timeoutMs?: number,
  ): Promise<string>;
}

export interface ArfSessionOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
}

export type ArfEvaluationOutcome<T> =
  | { state: "resolved"; value: T }
  | { state: "rejected"; error: unknown };

/** Observe a result immediately without changing its rejection for later callers. */
export function observeArfEvaluation<T>(
  result: Promise<T>,
  observer: (outcome: ArfEvaluationOutcome<T>) => void,
): Promise<T> {
  const observation = result.then(
    (value) => observer({ state: "resolved", value }),
    (error: unknown) => observer({ state: "rejected", error }),
  );
  void observation.catch(() => undefined);
  return result;
}

export function combineArfCleanupError(
  primary: unknown,
  cleanup: unknown,
  message: string,
): AggregateError {
  return new AggregateError([primary, cleanup], message, { cause: primary });
}

const decoder = new TextDecoder();

export class ArfSession {
  #process?: Deno.ChildProcess;
  #stdinWriter?: WritableStreamDefaultWriter<Uint8Array>;
  #pid?: number;
  #ipcDirectory?: string;
  #ipcSocket?: string;
  #logFile?: string;
  #lastLogTail = "";
  #stdoutReader?: ReadableStreamDefaultReader<Uint8Array>;
  #stdoutDrain?: Promise<void>;
  #environment?: Record<string, string>;
  #closePromise?: Promise<void>;
  #evalProcesses = new Set<Deno.ChildProcess>();
  #lastEvaluation?: {
    code: string;
    state: "pending" | "resolved" | "rejected";
    result?: ArfEvalResult;
    error?: string;
  };

  /** Wait for a marker created by an evaluation that is still running. */
  async waitForFile(
    path: string,
    timeoutMs = 5_000,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      return await waitForMarkerFile(path, timeoutMs, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const evaluation = this.#lastEvaluation;
      const log = await this.readLog().catch((logError) =>
        `Unable to read arf log: ${String(logError)}`
      );
      throw new Error(
        `${String(error)}\nArf marker-wait diagnostics: ${
          JSON.stringify({
            evaluation: evaluation ?? null,
            arfLogTail: log.split(/\r?\n/).slice(-40),
          })
        }`,
        { cause: error },
      );
    }
  }

  /** Read the current test-session log without closing the live process. */
  async readLog(): Promise<string> {
    const path = this.#logFile;
    if (!path) return this.#lastLogTail;
    try {
      const text = await Deno.readTextFile(path);
      this.#lastLogTail = text.split(/\r?\n/).slice(-40).join("\n");
      return text;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return this.#lastLogTail;
      throw error;
    }
  }

  async start(options: ArfSessionOptions = {}): Promise<void> {
    if (this.#process || this.#closePromise) {
      throw new Error("ArfSession is already started or has been closed.");
    }

    const timeoutMs = options.timeoutMs ?? 30_000;
    this.#environment = options.env === undefined
      ? Deno.env.toObject()
      : { ...options.env };
    this.#environment.RUST_LOG ??= "arf_libr::sys=debug";
    const ipcDirectory = await Deno.makeTempDir({
      prefix: "ja-",
      ...(Deno.build.os === "darwin" ? { dir: "/tmp" } : {}),
    });
    this.#ipcDirectory = ipcDirectory;
    this.#ipcSocket = Deno.build.os === "windows"
      ? `\\\\.\\pipe\\jdv-arf-${crypto.randomUUID()}`
      : join(ipcDirectory, "a.sock");
    this.#logFile = join(ipcDirectory, "arf.log");

    let process: Deno.ChildProcess | undefined;
    try {
      process = new Deno.Command("arf", {
        args: [
          "headless",
          "--json",
          "--ipc-bind",
          this.#ipcSocket,
          "--ipc-eval-unrestricted",
          "--vanilla",
          "--no-history",
          "--no-environ",
          "--no-site-file",
          "--no-init-file",
          "--log-file",
          this.#logFile,
        ],
        env: this.#environment,
        stdin: "piped",
        stdout: "piped",
        stderr: "null",
      }).spawn();
      this.#process = process;
      this.#stdinWriter = process.stdin.getWriter();
      this.#stdoutReader = process.stdout.getReader();
      const ready = await withTimeout(
        this.#readReady(process),
        timeoutMs,
        `arf headless did not start within ${timeoutMs} ms.`,
      );
      this.#pid = ready.pid;
      this.#stdoutDrain = this.#drainStdout();
    } catch (error) {
      this.#process = undefined;
      this.#pid = undefined;
      const cleanupErrors: unknown[] = [];
      try {
        await this.#cleanupProcess(process);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await withTimeout(
          this.#removePrivateFiles(),
          5_000,
          "arf startup private-file cleanup timed out.",
        );
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "arf startup failed and cleanup was incomplete.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  /** Submit an evaluation without waiting for R to return to its prompt. */
  send(
    code: string,
    options: { timeoutMs?: number; visible?: boolean } = {},
  ): ArfEvalHandle {
    if (!this.#pid) throw new Error("ArfSession has not started.");
    const timeoutMs = options.timeoutMs ?? 30_000;
    const evaluation = { code, state: "pending" as const };
    this.#lastEvaluation = evaluation;
    // A caller may wait for an independent marker before attaching to result.
    // Record the outcome immediately while preserving the original promise for
    // wait()/result consumers.
    const result = observeArfEvaluation(
      this.#runEval(code, timeoutMs, options.visible === true),
      (outcome) => {
        if (this.#lastEvaluation === evaluation) {
          this.#lastEvaluation = outcome.state === "resolved"
            ? { ...evaluation, state: "resolved", result: outcome.value }
            : {
              ...evaluation,
              state: "rejected",
              error: String(outcome.error),
            };
        }
      },
    );
    return {
      result,
      wait: (waitTimeoutMs = timeoutMs + 2_000) =>
        withTimeout(
          result,
          waitTimeoutMs,
          `R evaluation did not finish within ${waitTimeoutMs} ms.`,
        ),
      // IPC output is available only after the expression finishes; use a
      // marker file and waitForFile() to observe the start of a long expression.
      waitForOutput: async (predicate, waitTimeoutMs = timeoutMs + 2_000) => {
        const evaluated = await withTimeout(
          result,
          waitTimeoutMs,
          `R evaluation did not finish within ${waitTimeoutMs} ms.`,
        );
        const output = [
          evaluated.stdout,
          evaluated.stderr,
          evaluated.value,
          evaluated.error,
        ].filter((part): part is string => part !== null).join("\n");
        if (!predicate(output)) {
          throw new Error(`R evaluation output did not match: ${output}`);
        }
        return output;
      },
    };
  }

  async eval(
    code: string,
    timeoutMs = 30_000,
  ): Promise<ArfEvalResult> {
    const result = await this.send(code, { timeoutMs }).wait(timeoutMs + 2_000);
    if (result.error !== null) {
      throw new Error(`R eval failed: ${result.error}`);
    }
    return result;
  }

  /**
   * Evaluate through R's normal REPL (`arf ipc eval --visible`), so task
   * callbacks, autoprinting, and `.Last.value` behave as in interactive R.
   * The response's `value` and `error` are null or absent; failures are
   * reported through `status` and `stderr`. Use `eval()` when the value is
   * needed.
   */
  async evalVisible(
    code: string,
    timeoutMs = 30_000,
  ): Promise<ArfEvalResult> {
    const result = await this.send(code, { timeoutMs, visible: true })
      .wait(timeoutMs + 2_000);
    if (
      result.error != null ||
      (result.status !== undefined && result.status !== "ok")
    ) {
      throw new Error(
        `R visible eval failed (${result.status ?? "unknown"}): ${
          result.error ?? result.stderr ?? ""
        }`,
      );
    }
    return result;
  }

  /** Send one line to R's console input, for example `c` at a browser prompt. */
  async sendConsoleInput(line: string): Promise<void> {
    const writer = this.#stdinWriter;
    if (!writer) throw new Error("ArfSession has no open console input.");
    await writer.write(new TextEncoder().encode(`${line}\n`));
  }

  async close(): Promise<void> {
    if (this.#closePromise) return await this.#closePromise;
    this.#closePromise = withTimeout(
      this.#closeSession(),
      45_000,
      "arf session cleanup exceeded 45 seconds.",
    );
    return await this.#closePromise;
  }

  async #closeSession(): Promise<void> {
    const process = this.#process;
    const pid = this.#pid;
    this.#process = undefined;
    this.#pid = undefined;
    const errors: unknown[] = [];
    const attempt = async (label: string, action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        errors.push(
          new Error(`arf cleanup failed: ${label}`, { cause: error }),
        );
      }
    };

    // EOF releases a browser() console read before we ask the busy R process
    // to shut down over IPC.
    await attempt("closing R console input", () => this.#closeStdin(2_000));
    if (this.#evalProcesses.size > 0) {
      try {
        await withTimeout(
          Promise.all([...this.#evalProcesses].map((child) => child.status)),
          5_000,
          "R evaluations did not finish after console EOF.",
        );
      } catch (error) {
        errors.push(error);
        for (const child of this.#evalProcesses) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The IPC evaluation may already have exited.
          }
        }
      }
    }

    if (process && pid !== undefined) {
      let shutdownConfirmed = false;
      try {
        const shutdown = new Deno.Command("arf", {
          args: ["ipc", "shutdown", "--pid", String(pid)],
          env: this.#environment,
          stdout: "null",
          stderr: "null",
        }).spawn();
        try {
          await withTimeout(
            shutdown.status,
            5_000,
            "arf IPC shutdown timed out.",
          );
          shutdownConfirmed = true;
        } catch (shutdownError) {
          errors.push(shutdownError);
          try {
            shutdown.kill("SIGKILL");
          } catch {
            // The shutdown helper may already have exited.
          }
          try {
            await withTimeout(
              shutdown.status,
              5_000,
              "arf shutdown helper remained alive after SIGKILL.",
            );
          } catch (error) {
            errors.push(error);
          }
        }
      } catch (error) {
        errors.push(error);
      }
      if (!shutdownConfirmed) {
        try {
          process.kill("SIGKILL");
        } catch {
          // R may already have exited.
        }
      }
      try {
        await withTimeout(
          process.status,
          5_000,
          "R process did not exit.",
        );
      } catch (gracefulExitError) {
        errors.push(gracefulExitError);
        try {
          process.kill("SIGKILL");
        } catch {
          // R may already have exited.
        }
        try {
          await withTimeout(
            process.status,
            5_000,
            "R process remained alive after SIGKILL.",
          );
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await withTimeout(
          Promise.all([...this.#evalProcesses].map(async (child) => {
            try {
              child.kill("SIGKILL");
            } catch {
              // The IPC eval command may already have exited.
            }
            await child.status;
          })),
          5_000,
          "arf eval children did not exit during cleanup.",
        );
      } catch (error) {
        errors.push(error);
      }
    } else if (process) {
      await attempt(
        "stopping R after startup failure",
        () => this.#cleanupProcess(process),
      );
    }

    await attempt("cancelling arf stdout", async () => {
      const reader = this.#stdoutReader;
      if (reader) {
        await withTimeout(
          reader.cancel(),
          2_000,
          "arf stdout cancellation timed out.",
        );
      }
    });
    if (this.#stdoutDrain) {
      await attempt(
        "waiting for arf stdout reader",
        () =>
          withTimeout(
            this.#stdoutDrain!,
            2_000,
            "arf stdout reader did not stop during cleanup.",
          ),
      );
    }
    this.#stdoutDrain = undefined;
    this.#stdoutReader = undefined;
    await attempt(
      "removing private IPC files",
      () =>
        withTimeout(
          this.#removePrivateFiles(),
          5_000,
          "arf private IPC cleanup timed out.",
        ),
    );
    if (errors.length) {
      throw new AggregateError(errors, "arf session cleanup failed.");
    }
  }

  shutdown(): Promise<void> {
    return this.close();
  }

  async #runEval(
    code: string,
    timeoutMs: number,
    visible = false,
  ): Promise<ArfEvalResult> {
    const pid = this.#pid;
    if (!pid) throw new Error("ArfSession has not started.");
    const command = new Deno.Command("arf", {
      args: [
        "ipc",
        "eval",
        "--pid",
        String(pid),
        ...(visible ? ["--visible"] : []),
        "--timeout",
        String(timeoutMs),
        code,
      ],
      env: this.#environment,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.#evalProcesses.add(command);
    let primaryError: unknown;
    let failed = false;
    let result: ArfEvalResult | undefined;
    try {
      const output = await withTimeout(
        command.output(),
        timeoutMs + 2_000,
        `arf ipc eval exceeded ${timeoutMs + 2_000} ms.`,
        () => {
          try {
            command.kill("SIGKILL");
          } catch {
            // The IPC process may already have exited.
          }
        },
      );
      if (!output.success) {
        throw new Error(
          `arf ipc eval exited with ${output.code}: ${
            decoder.decode(output.stderr)
          }`,
        );
      }
      result = JSON.parse(decoder.decode(output.stdout)) as ArfEvalResult;
    } catch (error) {
      failed = true;
      primaryError = error;
      try {
        await this.close();
      } catch (cleanupError) {
        primaryError = combineArfCleanupError(
          error,
          cleanupError,
          "arf evaluation failed and session cleanup failed.",
        );
      }
    } finally {
      this.#evalProcesses.delete(command);
      try {
        await withTimeout(
          command.status,
          5_000,
          "arf eval helper did not exit after its result was read.",
        );
      } catch (statusError) {
        primaryError = !failed ? statusError : combineArfCleanupError(
          primaryError,
          statusError,
          "arf evaluation and helper shutdown failed.",
        );
        failed = true;
      }
    }
    if (failed) throw primaryError;
    if (result === undefined) {
      throw new Error("arf ipc eval completed without a result.");
    }
    return result;
  }

  async #readReady(
    process: Deno.ChildProcess,
  ): Promise<{ pid: number }> {
    const reader = this.#stdoutReader;
    if (!reader) throw new Error("arf stdout is unavailable.");
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        const status = await process.status;
        throw new Error(`arf exited before ready (exit ${status.code}).`);
      }
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let ready: { pid?: unknown };
        try {
          ready = JSON.parse(line) as { pid?: unknown };
        } catch (error) {
          throw new Error(`Invalid arf ready JSON: ${line}`, { cause: error });
        }
        if (!Number.isSafeInteger(ready.pid) || Number(ready.pid) <= 0) {
          throw new Error(`arf ready JSON has no valid pid: ${line}`);
        }
        return { pid: Number(ready.pid) };
      }
    }
  }

  async #drainStdout(): Promise<void> {
    const reader = this.#stdoutReader;
    if (!reader) return;
    try {
      while (!(await reader.read()).done) {
        // Keep the headless stdout pipe flowing for the full session lifetime.
      }
    } catch {
      // Shutdown closes the pipe.
    }
  }

  async #cleanupProcess(process?: Deno.ChildProcess): Promise<void> {
    if (!process) return;
    const errors: unknown[] = [];
    try {
      process.kill("SIGKILL");
    } catch {
      // The process may already have exited.
    }
    try {
      await withTimeout(
        process.status,
        5_000,
        "arf process did not exit after SIGKILL.",
      );
    } catch (error) {
      errors.push(error);
    }
    if (this.#stdoutReader) {
      try {
        await withTimeout(
          this.#stdoutReader.cancel(),
          2_000,
          "arf stdout cancellation timed out after startup failure.",
        );
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.#stdoutDrain) {
      try {
        await withTimeout(
          this.#stdoutDrain,
          2_000,
          "arf stdout reader did not stop after process cleanup.",
        );
      } catch (error) {
        errors.push(error);
      }
    }
    this.#stdoutDrain = undefined;
    this.#stdoutReader = undefined;
    try {
      await this.#closeStdin(2_000);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      throw new AggregateError(errors, "arf startup process cleanup failed.");
    }
  }

  async #closeStdin(timeoutMs: number): Promise<void> {
    const writer = this.#stdinWriter;
    this.#stdinWriter = undefined;
    if (!writer) return;
    try {
      await withTimeout(
        writer.close(),
        timeoutMs,
        "R console input close timed out.",
      );
    } finally {
      try {
        writer.releaseLock();
      } catch {
        // The stream may already be closed.
      }
    }
  }

  async #removePrivateFiles(): Promise<void> {
    const directory = this.#ipcDirectory;
    if (this.#logFile) {
      await this.readLog().catch(() => undefined);
    }
    this.#ipcDirectory = undefined;
    this.#ipcSocket = undefined;
    this.#logFile = undefined;
    if (directory) {
      await removeCacheDirectory(directory);
    }
  }
}

/** Wait for a marker without relying on platform-specific watcher path spelling. */
export async function waitForMarkerFile(
  path: string,
  timeoutMs = 5_000,
  signal?: AbortSignal,
): Promise<void> {
  const target = resolve(path);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (await fileExists(target)) return;
  const parent = dirname(target);
  const realParent = await Deno.realPath(parent);
  const watcher = Deno.watchFs(realParent);
  const onAbort = () => watcher.close();
  const eventPaths: string[] = [];
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (await fileExists(target)) return;
    await withTimeout(
      (async () => {
        for await (const event of watcher) {
          for (const entry of event.paths) {
            if (eventPaths.length < 8) eventPaths.push(entry);
          }
          // macOS may report a canonical /private/... path while the caller
          // holds the corresponding /var/... alias. Recheck the requested
          // path after every event instead of comparing path strings.
          if (await fileExists(target)) return;
        }
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        throw new Error(
          "Filesystem watcher closed before the marker appeared.",
        );
      })(),
      timeoutMs,
      `R marker file did not appear within ${timeoutMs} ms.`,
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    const resolvedParent = await Deno.realPath(parent).catch(() => null);
    const markerExists = await fileExists(target).catch(() => false);
    throw new Error(
      `R marker wait failed: ${
        JSON.stringify({
          target,
          parent,
          realParent: resolvedParent,
          markerExists,
          eventPaths,
        })
      }`,
      { cause: error },
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
    watcher.close();
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let rejectTimeout!: (reason: Error) => void;
  const timeout = new Promise<never>((_, reject) => rejectTimeout = reject);
  const timer = setTimeout(() => {
    onTimeout?.();
    rejectTimeout(new Error(message));
  }, timeoutMs);
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
