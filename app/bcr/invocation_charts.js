goog.module("bcrfrontend.invocationCharts");

const dom = goog.require("goog.dom");

/** @typedef {{field: string, label: string, unit: string, divisor: number}} */
let Metric;

/** @const {!Array<!Metric>} */
const METRICS = [
	{ field: "durationMs", label: "Build time", unit: "s", divisor: 1000 },
	{ field: "cpuMs", label: "CPU time", unit: "s", divisor: 1000 },
	{ field: "executionMs", label: "Execution time", unit: "s", divisor: 1000 },
	{ field: "criticalPathMs", label: "Critical path", unit: "s", divisor: 1000 },
	{
		field: "actionsExecuted",
		label: "Actions executed",
		unit: "count",
		divisor: 1,
	},
	{ field: "actionsTotal", label: "Total actions", unit: "count", divisor: 1 },
	{
		field: "targetsConfigured",
		label: "Configured targets",
		unit: "count",
		divisor: 1,
	},
	{ field: "outputBytes", label: "Output size", unit: "MiB", divisor: 1048576 },
];

const HOUR = 3600000;
const DAY = 24 * HOUR;

/** @typedef {{totals: !Array<number>, samples: !Array<number>}} */
let StatusMeasurements;

/** @typedef {{time: number, id: string, count: number, totals: !Array<number>, samples: !Array<number>,
 *     byStatus: !Map<string, !StatusMeasurements>}} */
let Bucket;

/**
 * @param {!Bucket} bucket
 * @param {string} status
 * @param {!Array<!Metric>} metrics
 * @return {!StatusMeasurements}
 */
function measurementsFor(bucket, status, metrics) {
	let measurements = bucket.byStatus.get(status);
	if (!measurements) {
		measurements = {
			totals: metrics.map(() => 0),
			samples: metrics.map(() => 0),
		};
		bucket.byStatus.set(status, measurements);
	}
	return measurements;
}

/**
 * @param {!Array<!Object<string, *>>} builds
 * @param {!Set<string>} statuses
 * @param {!Array<!Metric>} metrics
 * @param {number} bin
 * @return {!Array<!Bucket>}
 */
function chartBuckets(builds, statuses, metrics, bin) {
	/** @type {!Array<{build: !Object<string, *>, time: number, id: string}>} */
	const runs = [];
	for (const build of builds) {
		const time = Date.parse(String(build["startedAt"]));
		if (statuses.has(String(build["status"])) && Number.isFinite(time)) {
			runs.push({ build, time, id: String(build["invocationId"]) });
		}
	}
	runs.sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
	/** @type {!Map<number, !Bucket>} */
	const buckets = new Map();
	for (let index = 0; index < runs.length; index++) {
		const { build, time, id } = runs[index];
		const key = bin ? Math.floor(time / bin) * bin : index;
		/** @type {(!Bucket|undefined)} */
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = {
				time: bin ? key : time,
				id: bin ? "" : id,
				count: 0,
				totals: metrics.map(() => 0),
				samples: metrics.map(() => 0),
				byStatus: new Map(),
			};
			buckets.set(key, bucket);
		}
		const measurements = measurementsFor(
			bucket,
			String(build["status"]),
			metrics,
		);
		bucket.count++;
		for (let series = 0; series < metrics.length; series++) {
			const metric = metrics[series];
			const raw = build[metric.field];
			if (raw == null) continue;
			const value = Number(raw);
			if (!Number.isFinite(value) || value < 0) continue;
			bucket.totals[series] += value / metric.divisor;
			bucket.samples[series]++;
			measurements.totals[series] += value / metric.divisor;
			measurements.samples[series]++;
		}
	}
	return Array.from(buckets.values());
}

/**
 * @param {string} unit
 * @param {number} maximum
 * @return {!Element}
 */
function chartAxis(unit, maximum) {
	const axis = dom.createDom("div", "bes-chart-axis text-small color-fg-muted");
	const format = new Intl.NumberFormat(
		undefined,
		maximum < 1
			? { maximumSignificantDigits: 3 }
			: { notation: "compact", maximumFractionDigits: 2 },
	);
	for (let tick = 0; tick <= 4; tick++) {
		axis.appendChild(
			dom.createDom("span", null, format.format((maximum * tick) / 4)),
		);
	}
	return dom.createDom(
		"div",
		"bes-chart-scale",
		dom.createDom("span", "text-small text-bold", unit),
		axis,
	);
}

class GroupBuildChart {
	/**
	 * @param {function(string):string} statusColor
	 * @param {function(string):string} invocationHref
	 * @param {function(string):void} openInvocation
	 */
	constructor(statusColor, invocationHref, openInvocation) {
		/** @private @const */
		this.statusColor_ = statusColor;
		/** @private @const */
		this.invocationHref_ = invocationHref;
		/** @private @const */
		this.openInvocation_ = openInvocation;
		/** @private @const {!Set<string>} */
		this.statuses_ = new Set(["SUCCESS"]);
		/** @private @const {!Array<number>} */
		this.selection_ = [0, -1, -1, -1];
		/** @private @const {!Array<!HTMLSelectElement>} */
		this.selectors_ = [];
		/** @private {!Array<!Object<string, *>>} */
		this.builds_ = [];
		/** @private */
		this.statusKey_ = "";
		/** @private */
		this.buildsKey_ = "";

		/** @private @const */
		this.filters_ = dom.createDom(
			"fieldset",
			{ "class": "bes-chart-status" },
			dom.createDom("legend", "text-bold", "Build status"),
		);
		const selectors = dom.createDom("div", "bes-chart-controls");
		for (let index = 0; index < this.selection_.length; index++) {
			const id = "bes-chart-metric-" + (index + 1);
			const selector = /** @type {!HTMLSelectElement} */ (
				dom.createDom("select", { id, "class": "form-select select-sm" })
			);
			selector.addEventListener("change", () => {
				this.selection_[index] = Number(selector.value);
				this.updateSelectors_();
				this.draw_();
			});
			this.selectors_.push(selector);
			selectors.appendChild(
				dom.createDom(
					"div",
					"bes-chart-control",
					dom.createDom(
						"label",
						{ "for": id, "class": "text-bold" },
						index === 0 ? "Metric" : "Metric " + (index + 1),
					),
					selector,
				),
			);
		}
		/** @private @const {!HTMLSelectElement} */
		this.binning_ = /** @type {!HTMLSelectElement} */ (
			dom.createDom(
				"select",
				{
					id: "bes-chart-binning",
					"class": "form-select select-sm",
				},
				dom.createDom("option", { value: "0" }, "Per build"),
				dom.createDom(
					"option",
					{ value: String(HOUR) },
					"Hourly average (UTC)",
				),
				dom.createDom("option", { value: String(DAY) }, "Daily average (UTC)"),
			)
		);
		this.binning_.addEventListener("change", () => this.draw_());
		selectors.appendChild(
			dom.createDom(
				"div",
				"bes-chart-control",
				dom.createDom(
					"label",
					{ "for": "bes-chart-binning", "class": "text-bold" },
					"Group by",
				),
				this.binning_,
			),
		);
		/** @private @const */
		this.plot_ = dom.createDom("div");
		/** @const */
		this.element = dom.createDom(
			"section",
			"bes-group-chart",
			this.filters_,
			selectors,
			this.plot_,
		);
		this.updateSelectors_();
	}

	/** @param {!Array<!Object<string, *>>} builds */
	setBuilds(builds) {
		const buildsKey = JSON.stringify(builds);
		if (buildsKey === this.buildsKey_) return;
		this.buildsKey_ = buildsKey;
		this.builds_ = builds;
		/** @type {!Set<string>} */
		const reported = new Set(builds.map((build) => String(build["status"])));
		reported.delete("SUCCESS");
		/** @type {!Array<string>} */
		const statuses = Array.from(reported).sort();
		statuses.unshift("SUCCESS");
		const key = JSON.stringify(statuses);
		if (key !== this.statusKey_) {
			this.statusKey_ = key;
			while (this.filters_.children.length > 1)
				this.filters_.lastElementChild.remove();
			for (const status of statuses) {
				const input = /** @type {!HTMLInputElement} */ (
					dom.createDom("input", { type: "checkbox" })
				);
				input.checked = this.statuses_.has(status);
				input.addEventListener("change", () => {
					if (input.checked) this.statuses_.add(status);
					else this.statuses_.delete(status);
					this.draw_();
				});
				this.filters_.appendChild(
					dom.createDom(
						"label",
						"text-mono text-small",
						input,
						dom.createDom("span", {
							"class": "bes-chart-swatch " + this.statusColor_(status),
							"aria-hidden": "true",
						}),
						status,
					),
				);
			}
		}
		this.draw_();
	}

	/** @private */
	updateSelectors_() {
		for (let index = 0; index < this.selectors_.length; index++) {
			const selector = this.selectors_[index];
			dom.removeChildren(selector);
			const otherMetrics = this.selection_.filter(
				(selected, slot) => slot !== index && selected >= 0,
			);
			const units = new Set(
				otherMetrics.map((selected) => METRICS[selected].unit),
			);
			if (index > 0)
				selector.appendChild(dom.createDom("option", { value: "-1" }, "None"));
			for (let choice = 0; choice < METRICS.length; choice++) {
				const metric = METRICS[choice];
				const option = /** @type {!HTMLOptionElement} */ (
					dom.createDom("option", { value: String(choice) }, metric.label)
				);
				option.disabled =
					otherMetrics.includes(choice) ||
					(units.size >= 2 && !units.has(metric.unit));
				selector.appendChild(option);
			}
			selector.value = String(this.selection_[index]);
		}
	}

	/** @private */
	draw_() {
		dom.removeChildren(this.plot_);
		const selected = this.selection_.filter((choice) => choice >= 0);
		/** @type {!Array<!Metric>} */
		const metrics = selected.map((choice) => METRICS[choice]);
		const bin = Number(this.binning_.value);
		const buckets = chartBuckets(this.builds_, this.statuses_, metrics, bin);
		if (
			!buckets.length ||
			!buckets.some((bucket) => bucket.samples.some((count) => count > 0))
		) {
			const message = !this.builds_.length
				? "Waiting for completed builds."
				: buckets.length
					? "No measurements for the selected metrics."
					: "No completed builds match the selected statuses.";
			this.plot_.appendChild(dom.createDom("p", "bes-group-empty", message));
			return;
		}

		/** @type {!Array<string>} */
		const units = Array.from(new Set(metrics.map((metric) => metric.unit)));
		/** @type {!Map<string, number>} */
		const maxima = new Map();
		for (const unit of units) maxima.set(unit, 0);
		for (const bucket of buckets) {
			for (let index = 0; index < metrics.length; index++) {
				const metric = metrics[index];
				if (bucket.samples[index])
					maxima.set(
						metric.unit,
						Math.max(
							maxima.get(metric.unit),
							bucket.totals[index] / bucket.samples[index],
						),
					);
			}
		}
		for (const unit of units) {
			const max = maxima.get(unit) || 1;
			// Round up to an even axis scale with four equal divisions.
			const step = Math.pow(10, Math.floor(Math.log10(max / 4)));
			maxima.set(unit, Math.ceil(max / (4 * step)) * 4 * step);
		}

		const graph = dom.createDom("div", "bes-chart-graph");
		for (const unit of units)
			graph.appendChild(chartAxis(unit, maxima.get(unit)));

		const dayFormat = new Intl.DateTimeFormat(undefined, {
			timeZone: "UTC",
			year: "numeric",
			month: "short",
			day: "numeric",
		});
		const hourFormat = new Intl.DateTimeFormat(undefined, {
			timeZone: "UTC",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
		const valueFormat = new Intl.NumberFormat(undefined, {
			maximumFractionDigits: 3,
		});
		let previousSeparator = NaN;
		for (const bucket of buckets) {
			const separator = bin ? bucket.time : Math.floor(bucket.time / DAY) * DAY;
			if (separator !== previousSeparator) {
				previousSeparator = separator;
				const text =
					dayFormat.format(separator) +
					(bin === HOUR ? " · " + hourFormat.format(separator) : "");
				graph.appendChild(
					dom.createDom(
						"h4",
						"bes-chart-separator text-small color-fg-muted",
						dom.createDom("span", null, text),
					),
				);
			}
			const buildCount =
				bucket.count + (bucket.count === 1 ? " build" : " builds");
			const timestamp = new Date(bucket.time).toISOString();
			const rowTitle = bin
				? timestamp + " · " + buildCount
				: bucket.id + " · " + timestamp;
			const rowLabel = bin
				? buildCount
				: hourFormat.format(bucket.time) + " · " + bucket.id.slice(0, 8);
			const bars = dom.createDom("div", "bes-chart-bars");
			/** @type {!Array<string>} */
			const statuses = Array.from(bucket.byStatus.keys()).sort();
			for (let index = 0; index < metrics.length; index++) {
				const metric = metrics[index];
				const segments = dom.createDom("div", "bes-chart-track");
				const available = bucket.samples[index];
				for (const status of statuses) {
					const measurement = bucket.byStatus.get(status);
					const count = measurement.samples[index];
					if (!count) continue;
					// Each segment contributes to the overall mean in proportion to its sample count.
					const contribution = measurement.totals[index] / available;
					const average = measurement.totals[index] / count;
					const detail =
						metric.label +
						" · " +
						valueFormat.format(average) +
						" " +
						metric.unit;
					const description =
						rowTitle +
						" · " +
						status +
						" · " +
						detail +
						(bin ? " (" + count + " measured)" : "") +
						(statuses.length > 1
							? " · " +
								valueFormat.format(contribution) +
								" " +
								metric.unit +
								" of overall average"
							: "");
					const bar = /** @type {!HTMLElement} */ (
						dom.createDom(bucket.id ? "a" : "span", {
							"class": "bes-chart-segment " + this.statusColor_(status),
							"title": description,
							"aria-label": description,
						})
					);
					if (bucket.id) {
						bar.setAttribute("href", this.invocationHref_(bucket.id));
						bar.addEventListener("click", (event) => {
							const click = /** @type {!MouseEvent} */ (event);
							if (
								click.button !== 0 ||
								click.ctrlKey ||
								click.metaKey ||
								click.shiftKey ||
								click.altKey
							)
								return;
							event.preventDefault();
							this.openInvocation_(bucket.id);
						});
					} else {
						bar.setAttribute("role", "img");
					}
					bar.style.width =
						(contribution / maxima.get(metric.unit)) * 100 + "%";
					if (available === count && contribution === 0)
						bar.style.minWidth = "2px";
					segments.appendChild(bar);
				}
				if (!available)
					segments.appendChild(
						dom.createDom("span", "text-small color-fg-muted", "Unavailable"),
					);
				const lane = dom.createDom("div", "bes-chart-lane");
				if (metrics.length > 1)
					lane.appendChild(
						dom.createDom("span", "text-small color-fg-muted", metric.label),
					);
				lane.appendChild(segments);
				bars.appendChild(lane);
			}
			graph.appendChild(
				dom.createDom(
					"div",
					"bes-chart-row",
					dom.createDom(
						"span",
						{
							"class": "bes-chart-label text-small color-fg-muted",
							"title": rowTitle,
						},
						rowLabel,
					),
					bars,
				),
			);
		}
		this.plot_.appendChild(graph);
	}
}

exports = { GroupBuildChart };
