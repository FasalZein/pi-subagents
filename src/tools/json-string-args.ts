/**
 * T64: some models (the Claude family on this Mac) send an object or array argument as a JSON string.
 * A string that parses as a JSON object or array is that value. Any other string, "42" or "true" too,
 * stays a string, so a schema that expects a string still gets one.
 */
export function parseJsonContainer(value: unknown): unknown {
	if (typeof value !== "string" || !/^\s*[[{]/.test(value)) return value;
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null ? parsed : value;
	} catch {
		return value;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * D05: launch arguments with children parsed when sent as a JSON string; the same value otherwise.
 * Only children is parsed: a JSON-looking string anywhere else (a schema, data) keeps its string type.
 */
export function parseLaunchJsonFields(args: unknown): unknown {
	if (!isRecord(args)) return args;
	const children = parseJsonContainer(args.children);
	return children === args.children ? args : { ...args, children };
}

/**
 * A Pi prepareArguments hook from a parser. The one assertion: Pi validates the returned value against
 * the tool's parameters right after this hook, so the hook does not need to prove the type itself.
 */
export function asPrepareArguments<T>(parse: (args: unknown) => unknown): (args: unknown) => T {
	return (args) => parse(args) as T;
}
