# Iroh invocation viewer

The Rust companion serves the read-only invocation API from a loopback
`besserver` over Iroh. Start `besserver` as usual, then run the companion on
the same machine.

```sh
cargo +1.95.0 run --locked --manifest-path tools/invocation-iroh/Cargo.toml \
  --bin invocation-iroh -- --key-file /path/to/private/iroh.key \
  --backend-port 1974 --invocation <invocation-id>
```

Open Build Events at `/tools/invocations`, paste the printed **Viewer ticket**
into **Backend URL or iroh ticket**, and click **Connect**. The **Runs** view
lists invocations in the ticket's scope. A ticket without `--invocation`
grants access to the whole invocation list and its logs.

For **Invocation Groups** at `/tools/invocations`, connect with a ticket issued
without `--invocation`. That ticket can browse group membership and follow
the active runs.

The endpoint ID is stable across restarts with the same 32-byte private key.
Keep that file private. The printed ticket includes an access credential.
It expires after an hour by default and restart revokes it. Send it only to
people allowed to read the build data. Supply `--relay https://relay.example`
to choose a compatible Iroh relay. A browser connects through the relay.

## Install as systemd user services

Run these commands as the account that will own the services. Before switching
an existing installation over, stop manually launched copies of the backend and
companion so they release the listeners and database lock.

Install or update from prebuilt Linux executables:

```sh
tools/invocation-iroh/systemd/install.sh /path/to/besserver /path/to/invocation-iroh
```

To rebuild both executables from this checkout and then install them with the
same script, use Bazel and the Rust 1.95.0 toolchain:

```sh
tools/invocation-iroh/systemd/update.sh
```

The installer enables and restarts `bcr-besserver.service` and
`bcr-invocation-iroh.service` under the user systemd manager. To start them at
boot and keep them running after logout, enable lingering for the account:

```sh
loginctl enable-linger "$(id -un)"
```

Both services reuse `invocations.sqlite` and `iroh.key` in
`${XDG_STATE_HOME:-$HOME/.local/state}/bcr-invocation-observer`. The companion
creates the key if missing. Reusing the key across updates keeps its endpoint ID
stable.

Get the current ticket after the companion connects to its relay:

```sh
tools/invocation-iroh/systemd/ticket.sh
```

Paste the ticket into **Backend URL or iroh ticket** on `/tools/invocations`. The service
writes it to a private runtime file. The companion rotates it on restart and
once per day, so fetch the current ticket after an update or rotation. The
ticket grants read access to the invocation data in its scope.

BES listens on `127.0.0.1:1973` and the HTTP API on `127.0.0.1:1974`. To
override configuration, create
`${XDG_CONFIG_HOME:-$HOME/.config}/bcr-invocation-observer/environment` with
the settings you need and restart both units. For example:

```ini
BCR_FRONTEND_ORIGIN=http://localhost:8081
BCR_IROH_ARGS="--relay=https://relay.example.com"
```

`BCR_BES_LISTEN` sets the BES address, `BCR_INVOCATION_HTTP_PORT` sets the
loopback API port for both services, and `BCR_BES_ARGS` accepts additional
backend flags such as cache settings. Use `BCR_IROH_ARGS` to configure a relay
or scope tickets to a single invocation with `--invocation`. If you set
`BCR_IROH_TTL_SECONDS`, set the companion's `RuntimeMaxSec` to match with
a systemd drop-in.

```sh
systemctl --user restart bcr-besserver.service bcr-invocation-iroh.service
systemctl --user status bcr-besserver.service bcr-invocation-iroh.service
journalctl --user -u bcr-besserver.service -u bcr-invocation-iroh.service
```

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
