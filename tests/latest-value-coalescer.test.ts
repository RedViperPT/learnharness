import assert from "node:assert/strict";
import { it } from "node:test";
import { createLatestValueCoalescer } from "../src/server/latest-value-coalescer.ts";

it("emits only the latest value at 100ms without postponing the window on updates", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const received: string[][] = [];
	const updates = createLatestValueCoalescer<string>((batch) => received.push([...batch]));
	updates.queue("text", "first");
	t.mock.timers.tick(99);
	updates.queue("text", "latest");
	assert.deepEqual(received, []);
	t.mock.timers.tick(1);
	assert.deepEqual(received, [["latest"]]);
	updates.queue("text", "next window");
	t.mock.timers.tick(100);
	assert.deepEqual(received, [["latest"], ["next window"]]);
});

it("retains the latest snapshot per key in first-insertion order", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const received: string[][] = [];
	const updates = createLatestValueCoalescer<string>((batch) => received.push([...batch]));
	updates.queue("message", "old message");
	updates.queue("tool:a", "old a");
	updates.queue("message", "new message");
	updates.queue("tool:b", "b");
	updates.queue("tool:a", "new a");
	t.mock.timers.tick(100);
	assert.deepEqual(received, [["new message", "new a", "b"]]);
});

it("flushes synchronously before boundaries and cancels the old timer", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const received: string[] = [];
	const updates = createLatestValueCoalescer<string>((batch) => received.push(...batch));
	updates.queue("text", "partial");
	t.mock.timers.tick(50);
	updates.flush();
	received.push("boundary");
	updates.queue("text", "next");
	t.mock.timers.tick(50);
	assert.deepEqual(received, ["partial", "boundary"], "the cancelled timer cannot flush the next window early");
	t.mock.timers.tick(50);
	assert.deepEqual(received, ["partial", "boundary", "next"]);
	updates.flush();
	t.mock.timers.tick(1_000);
	assert.deepEqual(received, ["partial", "boundary", "next"], "empty/straggler flushes emit nothing");
});

it("preserves the lesson transport's configurable flush interval", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const received: number[] = [];
	const updates = createLatestValueCoalescer<number>((batch) => received.push(...batch), 5);
	updates.queue("message", 1);
	t.mock.timers.tick(4);
	assert.deepEqual(received, []);
	t.mock.timers.tick(1);
	assert.deepEqual(received, [1]);
});
