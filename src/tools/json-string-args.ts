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

/** The arguments with each named field parsed by parseJsonContainer; the same object when no field changed. */
export function parseJsonFields<T>(args: T, fields: readonly string[]): T {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
	const record = args as Record<string, unknown>;
	let changed: Record<string, unknown> | undefined;
	for (const field of fields) {
		const parsed = parseJsonContainer(record[field]);
		if (parsed !== record[field]) {
			changed ??= { ...record };
			changed[field] = parsed;
		}
	}
	return (changed ?? args) as T;
}

/** T64: subagent arguments with children, and each child's schema, parsed when sent as a JSON string. */
export function parseLaunchJsonFields<T>(args: T): T {
	const parsed = parseJsonFields(args, ["children"]);
	const children = (parsed as { children?: unknown } | null)?.children;
	if (!Array.isArray(children)) return parsed;
	const parsedChildren = children.map((child) => parseJsonFields(child, ["schema"]));
	if (parsedChildren.every((child, i) => child === children[i])) return parsed;
	return { ...(parsed as object), children: parsedChildren } as T;
}
