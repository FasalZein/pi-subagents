// Smoke scenario: one child reads a planted code word. It tests the launcher only.
export default {
	name: "smoke",
	prompt:
		'Call the subagent tool once with name "smoke-reader", agent "bench-smoke-reader" and task "Read smoke-note.txt and report the code word.". Do not read any file yourself. When the child\'s result arrives, reply with exactly one line: ANSWER: <code word>',
	expectedAnswer: "lantern-4127",
	// The answer must come through exactly these children, in this order.
	expectedChildRoles: ["bench-smoke-reader"],
	// The parent may call only these tools; a direct read is wrong delegation.
	parentToolAllowlist: ["subagent"],
	// Tools whose source file proves that the extension loaded from the checkout.
	parentLoadTool: "subagent",
	childLoadTool: "subagent_done",
};
