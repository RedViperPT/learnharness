import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { approvedDemoTitle } from "../src/core/demo-consent.ts";
import { buildAnswer, demoOfferInputSchema, demoOfferQuestion, dismissedAnswer } from "../src/core/question-core.ts";
import { danglingQuestionOf, newAnswerResult, nativeInputCause, type LhMessage } from "../src/core/native-messages.ts";
import { inputAppends } from "../src/core/input-events.ts";
import { parseDemoOfferInput } from "../src/core/tool-parts.ts";
import { createTeacherTools, createProberTools, offerDemoTool, type TeacherToolContext } from "../src/agent/tools.ts";
import { demoInputSchema, jobTools } from "../src/agent/tools/jobs.ts";
import type { JobRecord } from "../src/core/contracts/jobs.ts";
import { buildSubagentSteer, patchSteerUi } from "../src/core/contracts/jobs.ts";
import type { JobStore } from "../src/core/ports.ts";

const offer = { title: "Damped oscillator", description: "Vary damping and observe overshoot." };
function call(id = "consent", stopReason = "toolUse"): LhMessage {
	return { ...fauxAssistantMessage([fauxToolCall("offer_demo", offer, { id })],
		{ stopReason: stopReason as "toolUse" }), id: `assistant-${id}` };
}
const decision = (value: string, id = "consent") => newAnswerResult(id, "offer_demo",
	buildAnswer(demoOfferQuestion(id, offer), { values: [value] }, "offer_demo"));
function context(messages: LhMessage[]) {
	const jobs: JobRecord[] = [];
	const spawned: JobRecord[] = [];
	const jobStore = {
		listJobs: () => jobs,
		findJobByToolCallId: (_chat: string, id: string) => jobs.find(job => job.toolCallId === id),
		createJob: (input: Partial<JobRecord>) => {
			const job = { ...input, id: `job-${jobs.length}`, status: "running" } as JobRecord;
			jobs.push(job); return job;
		},
	} as unknown as JobStore;
	const ctx = { chatId: "chat", chatStore: { getChat: () => ({ messages }) }, jobStore,
		spawn: (job: JobRecord) => spawned.push(job) } as unknown as TeacherToolContext;
	return { ctx, jobs, spawned, demo: jobTools(ctx).demo! };
}

test("offer schema and native pending lifecycle accept only well-formed offers", async () => {
	assert.ok(Value.Check(demoOfferInputSchema, offer));
	for (const malformed of [{}, { title: "T" }, { ...offer, description: "  " }, { ...offer, title: "" }]) {
		assert.equal(parseDemoOfferInput(malformed), undefined);
	}
	assert.equal(danglingQuestionOf([call()])?.tool, "offer_demo");
	assert.equal(danglingQuestionOf([call(), decision("build")]), null);
	assert.equal((await offerDemoTool.execute("consent", offer)).terminate, true);
	assert.ok(Value.Check(demoInputSchema, { consentCallId: "consent", brief: "controls" }));
	assert.equal(Value.Check(demoInputSchema, { title: "T", brief: "controls" }), false);
});

for (const value of ["build", "skip"]) test(`${value} is an ungraded ask decision with native learner causality`, () => {
	const result = inputAppends({ messages: [call()] }, { type: "answer", toolCallId: "consent",
		answer: buildAnswer(demoOfferQuestion("consent", offer), { values: [value], confidence: 100 }, "offer_demo") })[0]!;
	assert.equal(result.role, "toolResult");
	if (result.role !== "toolResult") return;
	const answer = result.details as unknown as ReturnType<typeof buildAnswer>;
	assert.equal(answer.kind, "ask");
	assert.equal(answer.answers[0]?.value, value);
	assert.equal(answer.correct, undefined);
	assert.equal(answer.confidence, undefined);
	assert.equal(nativeInputCause(result, [call()]), "learner");
	assert.match(JSON.stringify(result.content), /consentCallId/);
});

test("demo offering and building share the master toggle and remain teacher-only", () => {
	const { ctx } = context([]);
	const enabled = createTeacherTools(ctx);
	const disabled = createTeacherTools(ctx, { demo: false });
	assert.ok(enabled.offer_demo && enabled.demo);
	assert.equal(disabled.offer_demo, undefined);
	assert.equal(disabled.demo, undefined);
	for (const name of ["research", "visual", "pdf"]) assert.ok(disabled[name]);
	const prober = createProberTools(ctx as never);
	assert.equal(prober.offer_demo, undefined);
	assert.equal(prober.demo, undefined);
});

const invalid: [string, LhMessage[]][] = [
	["unknown", []], ["unanswered", [call()]], ["declined", [call(), decision("skip")]],
	["dismissed", [call(), newAnswerResult("consent", "offer_demo", dismissedAnswer("ask", offer.title))]],
	["failed generation", [call("consent", "error"), decision("build")]],
	["aborted generation", [call("consent", "aborted"), decision("build")]],
	["wrong result tool", [call(), { ...decision("build"), toolName: "ask_user_question" } as LhMessage]],
	["failed result", [call(), { ...decision("build"), isError: true } as LhMessage]],
];
for (const [name, messages] of invalid) test(`${name} consent creates zero jobs`, async () => {
	const { demo, jobs, spawned } = context(messages);
	await assert.rejects(() => demo.execute("dispatch", { consentCallId: "consent", brief: "controls" }));
	assert.equal(jobs.length, 0);
	assert.equal(spawned.length, 0);
});

test("approved title is authoritative; admission consumes approval even after failure; fresh approval permits retry", async () => {
	const messages = [call(), decision("build")];
	const { demo, jobs, spawned } = context(messages);
	assert.equal(approvedDemoTitle(messages, "consent"), offer.title);
	const input = { consentCallId: "consent", brief: "Precise controls" };
	// Concurrent callers cannot pass the same synchronous admission boundary twice.
	const results = await Promise.allSettled([demo.execute("dispatch", input), demo.execute("dispatch2", input)]);
	assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
	assert.equal(jobs.length, 1);
	assert.equal(spawned.length, 1);
	assert.equal(jobs[0]!.kind, "demo");
	assert.deepEqual(jobs[0]!.input, { ...input, title: offer.title });
	jobs[0]!.status = "error";
	await assert.rejects(() => demo.execute("retry", input), /already been used/);
	messages.push(call("fresh"), decision("build", "fresh"));
	await demo.execute("retry-approved", { ...input, consentCallId: "fresh" });
	assert.equal(jobs.length, 2);
});

for (const status of ["running", "done", "error"] as const) test(`same-call demo replay acknowledges the existing ${status} job`, async () => {
	const { demo, jobs, spawned } = context([call(), decision("build")]);
	const input = { consentCallId: "consent", brief: "Original brief" };
	const ack = await demo.execute("dispatch", input);
	jobs[0]!.status = status;
	const original = structuredClone(jobs[0]);
	assert.deepEqual(await demo.execute("dispatch", { ...input, brief: "Do not overwrite the saved brief" }), ack);
	assert.deepEqual(jobs, [original]);
	assert.equal(spawned.length, 1);
	await assert.rejects(() => demo.execute("different-call", input), /already been used/);
	assert.deepEqual(jobs, [original]);
	assert.equal(spawned.length, 1);
});

test("consent answers reject free text, unknown values, and multiple decisions", () => {
	for (const answer of [
		{ ...buildAnswer(demoOfferQuestion("consent", offer), { values: ["build"] }), text: "sure" },
		buildAnswer(demoOfferQuestion("consent", offer), { values: ["build", "skip"] }),
		buildAnswer(demoOfferQuestion("consent", offer), { values: ["unknown"] }),
	]) assert.throws(() => inputAppends({ messages: [call()] }, { type: "answer", toolCallId: "consent", answer }), /exactly one/);
});

test("artifact UI pure patch whitelists fields and artifact kinds", () => {
	const demo = buildSubagentSteer({ id: "d", kind: "demo", toolCallId: "dc" }, { title: "D", html: "<p>D</p>", tested: true });
	const visual = buildSubagentSteer({ id: "v", kind: "visual", toolCallId: "vc" }, { svg: "<svg/>" });
	const unknown = { unrelated: true } as never;
	assert.equal(patchSteerUi([demo], demo.id, unknown)[0], demo);
	assert.equal(patchSteerUi([visual], visual.id, { collapsed: true })[0], visual);
	const inverted = patchSteerUi([demo], demo.id, { inverted: true });
	const collapsed = patchSteerUi(inverted, demo.id, { collapsed: true });
	assert.deepEqual((collapsed[0] as typeof demo).details, { ...demo.details as object, ui: { inverted: true, collapsed: true } });
});
