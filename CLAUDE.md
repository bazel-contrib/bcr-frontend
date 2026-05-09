# Conventions and gotchas for this repo

## Soy templates (`*.soy`)

This project uses Closure Templates (Soy) v3. A few common pitfalls:

- **No `and` / `or` / `not` keywords.** Use the symbol operators: `&&`, `||`, `!`. Soy is closer to JS expression syntax than Python.

  ```soy
  {if $a && $b}…{/if}            // correct
  {if $a and $b}…{/if}           // parse error

  {let $x: !$cond /}             // correct
  {let $x: not $cond /}          // parse error
  ```

- **Templates can't be called inside `{if}` conditions.** A template invocation may only sit at the top level of a `{print}`, the RHS of `{let}`, or the value of a `{param}`. To use a computed boolean from another template, hoist the call into a `{let}` first.

- **`strContains` doesn't exist as a function call.** Use the string method form: `$str.indexOf($substr) >= 0`. Methods like `.startsWith(...)`, `.endsWith(...)`, `.indexOf(...)` are available; the standalone `strContains(...)` function is not.

- **Optional `string` params need a non-null guard before method calls.** A `{@param? name: string}` has type `string|null`; calling `.startsWith()` on it without coalescing will fail type checking. Bind a normalized local first:

  ```soy
  {let $safeName: $name ?? '' /}
  {if $safeName.startsWith('bot/')}…{/if}
  ```

- **Quote attribute keys in `dom.createDom()`** when calling from JS. The Closure Compiler renames unquoted `class:` / `style:` keys at ADVANCED, silently dropping them from the DOM. Always write `{ "class": "..." }`, not `{ class: "..." }`. The biome formatter is configured with `javascript.formatter.quoteProperties: "preserve"` so it won't rewrite the quoted form back; if a future config tweak strips quotes, expect ADVANCED-build CSS classes to vanish at runtime with no error.

- **`isLast`, `isFirst`, `index` are not soy builtins.** Use `{for $item, $idx in $list}…{/for}` and compare `$idx` to `length($list) - 1` if you need first/last detection.

## Closure JS

- `goog.module` files; not ES modules. The IDE may suggest converting — ignore the hint.
- Strict typing: array access (`arr[i]`) is typed `T`, not `T|undefined`. But `Array.prototype.find` / `.filter` lambdas often need explicit `@type` JSDoc casts to please the type checker. When the compiler complains "could not determine the type", restructure to a plain `for` loop or annotate the lambda's params.
- `?HTMLInputElement` (not `?Element`) is required for `.value` access on text inputs. Cast at the `querySelector` boundary.
- When passing data into `soy.renderAsElement(template, data)`, prefer **inline object literals** at the call site. Returning the data object from a helper function defeats Closure's bidirectional type inference and produces `JSC_TYPE_MISMATCH` against the soy template's strict record type.

## Build and proto regeneration

- The user runs `bazel` themselves. Don't invoke `bazel build` / `bazel run` from agents; it triggers rebuild thrash for them and we don't have to.
- After editing `*.proto`: regenerate via `bazel run //:proto_assets` (handled by the user).
- After editing Go sources or `go.mod`: the user runs `go mod tidy` / gazelle as needed.

## Bazel rules

- `ctx.actions.run` does not capture stdout. To redirect, either have the tool itself write to a `--output <path>` flag, or use `ctx.actions.run_shell` (less hermetic). The `cmd/bazelisk` wrapper takes the former approach.
- Sandboxed actions don't inherit `$HOME`. Tools that derive a cache directory from `os.UserCacheDir()` must fall back explicitly (see `cmd/bazelisk/bazelisk.go`).
- Parallel `bazel` invocations against the same `$OUTPUT_BASE` serialize on the output-base lock. Pass `--output_user_root=<unique>` per invocation when you need true parallelism, or use `--batch` to skip the server entirely.
