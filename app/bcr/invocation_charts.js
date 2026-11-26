goog.module("bcrfrontend.invocationCharts");

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

/**
 * @param {?Object<string, *>} sample
 * @param {!Metric} metric
 * @return {?number}
 */
function metricValue(sample, metric) {
	const raw = sample?.[metric.field];
	if (raw == null) return null;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value / metric.divisor : null;
}

/** @type {?Intl.NumberFormat} */
let numberFormat = null;

/**
 * @param {number} value
 * @param {!Metric} metric
 * @return {string}
 */
function metricLabel(value, metric) {
	numberFormat ??= new Intl.NumberFormat(undefined, {
		maximumFractionDigits: 3,
	});
	return numberFormat.format(value) + " " + metric.unit;
}

exports = { METRICS, metricValue, metricLabel };
