let wasmReady;
let wasmAttempt = 0;

async function loadWasm() {
	const loader = new URL(import.meta.url);
	loader.searchParams.set("wasmAttempt", String(wasmAttempt++));
	const bindings = new URL("./bcr_invocation_iroh.js", loader);
	const binary = new URL("./bcr_invocation_iroh_bg.wasm", loader);
	bindings.search = binary.search = loader.search;
	const {default: init, InvocationClient} = await import(bindings.href);
	await init({module_or_path: binary});
	return InvocationClient;
}

function openBackend(ticket) {
	let closed = false;
	let connection;
	let retry;
	let wakeRetry;

	function client() {
		if (closed) return Promise.reject(new Error("Connection closed."));
		wasmReady ??= loadWasm().catch((error) => {
			wasmReady = undefined;
			throw error;
		});
		if (!connection) {
			const pending = wasmReady.then((InvocationClient) => InvocationClient.dial(ticket));
			connection = pending;
			pending.catch(() => {
				if (connection === pending) connection = undefined;
			});
		}
		return connection;
	}

	function dropConnection(pending) {
		if (!pending) return;
		if (connection === pending) connection = undefined;
		void pending.then((value) => value.close()).catch(() => {});
	}

	async function readGroup(read) {
		const pending = client();
		try {
			return JSON.parse(await read(await pending));
		} catch (error) {
			dropConnection(pending);
			throw error;
		}
	}

	async function follow(id, cursor, onEvent, onStatus) {
		let wait = 500;
		while (!closed) {
			const pending = client();
			const started = Date.now();
			try {
				const transport = await pending;
				if (closed) return;
				const stream = await transport.watch(id, cursor());
				if (!closed) onStatus("Connected over Iroh · replaying and following " + id, true);
				try {
					await readEvents(stream, (id, data, receivedAt, sentAt) => {
						if (!closed) onEvent(id, data, receivedAt, sentAt);
					});
				} finally {
					stream.free();
				}
			} catch (error) {
				if (closed) return;
				if (/HTTP (400|401|403|404)\b|Invalid Iroh viewer ticket|expected an HTTPS relay URL/.test(error.message)) {
					dropConnection(pending);
					onStatus("The Iroh viewer ticket or invocation was denied.", false, true);
					return;
				}
			}
			if (closed) return;
			dropConnection(pending);
			onStatus("Iroh connection interrupted · reconnecting from the last event", false);
			if (Date.now() - started > 10000) wait = 500;
			await new Promise((resolve) => {
				wakeRetry = resolve;
				retry = setTimeout(resolve, wait);
			});
			wakeRetry = undefined;
			wait = Math.min(8000, wait * 2);
		}
	}

	return {
		list: async (token) => JSON.parse(await (await client()).list(token || undefined)),
		listGroups: () => readGroup((transport) => transport.list_groups()),
		listGroup: (name, token) => readGroup((transport) => transport.list_group(name, token || undefined)),
		groupMetrics: (name, days) => readGroup((transport) => transport.group_metrics(name, days)),
		get: async (id) => JSON.parse(await (await client()).get(id)),
		watch: (...args) => void follow(...args),
		close: () => {
			closed = true;
			clearTimeout(retry);
			wakeRetry?.();
			dropConnection(connection);
		},
	};
}

async function readEvents(stream, onEvent) {
	const decoder = new TextDecoder();
	let pending = "";
	let timing = [];
	for (;;) {
		const chunk = await stream.read();
		if (!chunk) return;
		pending += decoder.decode(chunk, { stream: true });
		if (pending.length > 64 * 1024 * 1024) throw new Error("Invocation event exceeds the viewer limit.");
		// The companion forwards besserver's LF-delimited SSE stream unchanged.
		let start = 0;
		for (let end; (end = pending.indexOf("\n\n", start)) !== -1; start = end + 2) {
			const frame = pending.slice(start, end);
			let id = "";
			let type = "";
			const data = [];
			for (const line of frame.split("\n")) {
				if (line.startsWith("id: ")) id = line.slice(4);
				else if (line.startsWith("event: ")) type = line.slice(7);
				else if (line.startsWith("data: ")) data.push(line.slice(6));
			}
			if (type === "bep-time") timing = data.join("\n").split(" ");
			if (type === "bep" && id) {
				if (timing[0] === id) onEvent(id, data.join("\n"), Number(timing[1]), Number(timing[2]));
				else onEvent(id, data.join("\n"));
				timing = [];
			}
		}
		pending = pending.slice(start);
	}
}

window.bcrIrohInvocation = openBackend;
