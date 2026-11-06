import React, { act } from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { StatsBar } from "../components/stats-bar.tsx";
import type { ModelCatalogResponse, TurnUsage } from "../src/core/index.ts";

(globalThis as Record<string, unknown>).React = React;
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });

test("cache hit rate appears only inside expanded session stats, follows the session log, and needs no pricing", async () => {
	const originalFetch = globalThis.fetch;
	const catalog: ModelCatalogResponse = { models: [], providers: [], defaults: null,
		slots: { strong: null, cheap: null, vision: null }, rolePins: {} as ModelCatalogResponse["rolePins"] };
	globalThis.fetch = async (input) => {
		if (input === "/api/models") return Response.json(catalog);
		if (input === "/api/settings") return Response.json({ settings: { models: {} } });
		if (input === "/api/chats/fixture") return Response.json({ settings: {} });
		throw new Error(`unexpected fixture request ${String(input)}`);
	};
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	const turn = (read: number | undefined, write: number | undefined = 0): TurnUsage => ({
		id: "turn", messageId: "message", at: "2026-10-30T00:00:00Z", model: "unknown:unpriced",
		steps: [{ inputTokens: 100, outputTokens: 100_000, cacheReadTokens: read,
			cacheWriteTokens: write, reasoningTokens: 90_000 }],
	});
	const render = (turns: TurnUsage[]) => root.render(<StatsBar chatId="fixture" turns={turns} contextTokens={42_000} />);
	const cacheRow = () => host.querySelector('[data-testid="stats-cache-hit-rate"]');
	const summary = () => host.querySelector<HTMLButtonElement>('[data-testid="stats-summary"]')!;
	try {
		await act(async () => render([turn(900)]));
		const collapsedSummary = summary().textContent;
		assert.equal(collapsedSummary, "42k·—");
		assert.equal(cacheRow(), null);
		assert(!host.textContent?.includes("Cache hit rate"), "no new chip in the collapsed bar");

		await act(async () => summary().click());
		const detail = host.querySelector('[data-testid="stats-detail"]')!;
		assert.equal(cacheRow()?.textContent, "Cache hit rate90.0%");
		assert(detail.contains(cacheRow()));
		const labels = [...detail.querySelectorAll(".flex.justify-between > span:first-child")].map((el) => el.textContent);
		assert.deepEqual(labels.slice(0, 3), ["Context (last call)", "Total cost", "Cache hit rate"]);
		assert.equal(summary().textContent, collapsedSummary);

		await act(async () => render([turn(900), { ...turn(0), id: "second", messageId: "second" }]));
		assert.equal(cacheRow()?.textContent, "Cache hit rate81.8%", "session totals, not the last request or mean percentages");
		assert.equal(summary().textContent, collapsedSummary);

		await act(async () => render([turn(900), { ...turn(0), id: "side", messageId: "gone", kind: "side-question" }]));
		assert.equal(cacheRow()?.textContent, "Cache hit rate81.8%", "side usage stays in the session-wide ratio");
		assert.match(detail.textContent!, /Session-wide, including side questions\./);
		const entries = detail.querySelectorAll("li");
		assert.equal(entries.length, 2);
		assert.ok(entries[0] && entries[1]);
		assert.equal(entries[0].children.length, 4, "each turn has separate number, model, steps, and usage columns");
		assert.equal(entries[0].children[0]?.textContent, "#1");
		assert.equal(entries[0].children[1]?.textContent, "unpriced · unknown");
		assert(!entries[0].textContent?.includes("Side question"), "legacy untagged entries are not classified");
		assert.equal(entries[1].children[0]?.textContent, "#2");
		assert.equal(entries[1].children[1]?.textContent, "Side question · unpriced · unknown");
		assert.match(entries[1].textContent!, /1 steps/);

		for (const turns of [[], [turn(undefined, undefined)], [turn(0)], [turn(0, 900)]]) {
			await act(async () => render(turns));
			assert.equal(cacheRow(), null, "unknown, empty, all-zero and write-only records stay hidden even while expanded");
		}
		await act(async () => render([turn(900)]));
		assert.equal(cacheRow()?.textContent, "Cache hit rate90.0%");
		await act(async () => summary().click());
		assert.equal(host.querySelector('[data-testid="stats-detail"]'), null);
		assert.equal(cacheRow(), null);
		assert.equal(summary().textContent, collapsedSummary);
	} finally {
		await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch;
	}
});
