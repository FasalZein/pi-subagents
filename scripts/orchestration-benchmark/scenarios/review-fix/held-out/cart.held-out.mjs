// Held-out test of scenario review-fix. It lives outside the copied workspace, so no
// child can read it. The oracle runs it after the parent ends, with BENCH_WORKDIR set
// to the attempt's workspace copy. It checks the build fix (whole cents) and the
// planted review finding R-2 (a quantity that is not a positive integer throws RangeError).
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const cart = await import(
	pathToFileURL(join(process.env.BENCH_WORKDIR ?? "", "src", "cart.mjs")).href
);

test("build fix: a discount returns whole cents", () => {
	assert.equal(cart.applyDiscount(999, 15), 849);
	assert.equal(cart.applyDiscount(1000, 10), 900);
});

test("R-2: lineTotal rejects a quantity that is not a positive integer", () => {
	for (const quantity of [0, -1, 1.5])
		assert.throws(() => cart.lineTotal(100, quantity), RangeError);
	assert.equal(cart.lineTotal(100, 2), 200);
});

test("R-2: cartTotal rejects a line with a bad quantity", () => {
	assert.throws(
		() => cart.cartTotal([{ priceCents: 100, quantity: -2 }]),
		RangeError,
	);
	assert.equal(cart.cartTotal([{ priceCents: 100, quantity: 2 }]), 200);
});
