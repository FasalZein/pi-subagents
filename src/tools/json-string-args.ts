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

/** The arguments with each named field parsed by parseJsonContainer; the same value when no field changed. */
export function parseJsonFields(args: unknown, fields: readonly string[]): unknown {
	if (!isRecord(args)) return args;
	let changed: Record<string, unknown> | undefined;
	for (const field of fields) {
		const parsed = parseJsonContainer(args[field]);
		if (parsed !== args[field]) {
			changed ??= { ...args };
			changed[field] = parsed;
		}
	}
	return changed ?? args;
}

/** T64: launch arguments with children, and each child's schema, parsed when sent as a JSON string. */
export function parseLaunchJsonFields(args: unknown): unknown {
	const parsed = parseJsonFields(args, ["children"]);
	const children = isRecord(parsed) ? parsed.children : undefined;
	if (!Array.isArray(children)) return parsed;
	const parsedChildren = children.map((child) => parseJsonFields(child, ["schema"]));
	if (parsedChildren.every((child, i) => child === children[i])) return parsed;
	return { ...(parsed as Record<string, unknown>), children: parsedChildren };
}

/**
 * A Pi prepareArguments hook from a parser. The one assertion: Pi validates the returned value against
 * the tool's parameters right after this hook, so the hook does not need to prove the type itself.
 */
export function asPrepareArguments<T>(parse: (args: unknown) => unknown): (args: unknown) => T {
	return (args) => parse(args) as T;
}
