"use client";

import { Button } from "@/components/ui/button";
import { MalformedQuestion } from "@/components/malformed-question";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { buildAnswer, demoOfferQuestion, parseDemoOfferInput, type QuestionAnswerData } from "@/src/core";

export function DemoConsentDock({ input, toolCallId, expanded, onExpand, onSubmit, disabled = false }: {
	input: unknown;
	toolCallId: string;
	expanded: boolean;
	onExpand: () => void;
	onSubmit: (answer: QuestionAnswerData) => void;
	disabled?: boolean;
}) {
	const offer = parseDemoOfferInput(input);
	if (!offer) return <MalformedQuestion />;
	if (!expanded) return (
		<button type="button" onClick={onExpand} className="dock-variant flex w-full items-center gap-3 px-4 py-3 text-left">
			<span className="text-xs uppercase text-muted-foreground">Interactive demo</span>
			<span className="truncate text-sm">{offer.title}</span>
		</button>
	);
	const submit = (value: "build" | "skip") => {
		if (disabled) return;
		onSubmit(buildAnswer(demoOfferQuestion(toolCallId, offer), { values: [value] }, "offer_demo"));
	};
	return (
		<div className="dock-variant space-y-3 p-4" data-testid="demo-consent-dock">
			<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Interactive demo</div>
			<div className="font-medium"><ToolContentResponse>{offer.title}</ToolContentResponse></div>
			<div className="text-sm text-muted-foreground"><ToolContentResponse>{offer.description}</ToolContentResponse></div>
			<div className="flex flex-wrap gap-2">
				<Button type="button" disabled={disabled} onClick={() => submit("build")}>Build demo</Button>
				<Button type="button" variant="outline" disabled={disabled} onClick={() => submit("skip")}>Continue without demo</Button>
			</div>
		</div>
	);
}
