# Iroh invocation viewer

The Rust companion serves the read-only invocation API from a loopback
`besserver` over Iroh. Start `besserver` as usual, then run the companion on
the same machine.

```sh
cargo +1.95.0 run --locked --manifest-path tools/invocation-iroh/Cargo.toml \
  --bin invocation-iroh -- --key-file /path/to/private/iroh.key \
  --backend-port 1974 --invocation <invocation-id>
```

Paste the printed **Viewer ticket** into the backend field in the invocation
viewer and enter the invocation ID. Refresh saved runs to list invocations in
the ticket's scope. A ticket without `--invocation` grants access to the
whole invocation list and its logs.

The endpoint ID is stable across restarts with the same 32-byte private key.
Keep that file private. The printed ticket includes an access credential.
It expires after an hour by default and restart revokes it. Send it only to
people allowed to read the build data. Supply `--relay https://relay.example`
to choose a compatible Iroh relay. A browser connects through the relay.

## Build the browser module

```sh
rustup target add --toolchain 1.95.0 wasm32-unknown-unknown
cargo +1.95.0 install wasm-bindgen-cli --version 0.2.122 --locked
RUSTUP_TOOLCHAIN=1.95.0 tools/invocation-iroh/build-browser.sh
bazel build //app/bcr:release
```

The build helper generates the optional Iroh WASM assets under
`app/bcr/iroh_wasm`. The normal frontend release includes them when present.
A hosted deployment needs to serve the generated JavaScript and WebAssembly
assets and permit WebSocket connections to its Iroh relay.

## End-to-end test

Build the frontend archive after generating the WASM module. Use
`--//app/bcr:release_type=dummy` for a small local fixture. Build
`//cmd/besserver`, `//cmd/releaseserver`, and the companion with
`cargo +1.95.0 build --locked --manifest-path tools/invocation-iroh/Cargo.toml --features test-relay`.
With Playwright installed, run:

```sh
BESSERVER=/path/to/besserver RELEASESERVER=/path/to/releaseserver \
FRONTEND_ARCHIVE=/path/to/release.tar IROH_COMPANION=/path/to/invocation-iroh \
IROH_RELAY=/path/to/invocation-iroh-test-relay \
node --test tools/invocation-iroh/tests/e2e.mjs
```

The test runs real Bazel BES ingestion and a local Iroh relay, opens the
compiled viewer in Chromium, and interrupts the backend event stream during a
live build to verify that the viewer reconnects with its saved cursor. It also
checks ticket scope, expiry, and stable identity. Set `CHROME_BIN` to use
an existing Chromium binary or `PLAYWRIGHT_MODULE` to use Playwright from
another installation.
