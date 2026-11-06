"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { HistoryIcon, MessageCircleQuestionIcon, PlusIcon, SquareIcon, Trash2Icon, XIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { BrailleSpinner } from "@/components/braille-spinner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { SideChatMessage, SideChatQuote, SideChatThread } from "@/src/core";
import { useSideChatSnapshot, useSideChatStore } from "./side-chat-state";
import { navigateToSideQuote } from "./side-selection";
import { SideQuoteContent } from "./side-quote-content";
import { SessionSecondaryPanel } from "./session-secondary-panel";
export { SIDE_PANEL_OVERLAY_THRESHOLD, clampSideChatWidth } from "./session-secondary-panel";
const consumedFocus = new Map<string, number>();
const EMPTY_DRAFT = { text: "", quotes: [] as SideChatQuote[] };

/** Networking belongs to the session store, so hiding/unmounting this view
 * never cancels a side answer or loses the next unsent question. */
export function SideChatPanel({ chatId, obscured = false }: { chatId: string; obscured?: boolean }) {
	const store = useSideChatStore();
	const state = useSideChatSnapshot();
	const [historyOpen, setHistoryOpen] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const cancelDeleteRef = useRef<HTMLButtonElement>(null);
	const following = useRef(true);
	const active = state.activeKey;
	const entry = active ? state.entries[active] : undefined;
	const thread = entry?.thread;
	const isDraft = !!entry && !thread;
	const draft = entry?.draft ?? EMPTY_DRAFT;
	const messages = thread?.messages ?? [];
	const busy = !!entry && (entry.sending || entry.answer !== undefined);
	const liveText = entry?.answer;
	const error = entry?.error || state.validationError;
	const last = messages.at(-1);
	const canRetry = !!thread && !busy && (last?.role === "user" || (last?.role === "assistant" && last.error !== undefined));

	useEffect(() => {
		if (!state.panelOpen || obscured || state.focusRevision === (consumedFocus.get(chatId) ?? 0)) return;
		setHistoryOpen(false);
		setConfirmDelete(false);
		if (historyOpen || !inputRef.current) return;
		consumedFocus.set(chatId, state.focusRevision);
		inputRef.current?.focus({ preventScroll: true });
	}, [chatId, state.panelOpen, state.focusRevision, obscured, historyOpen]);

	useLayoutEffect(() => {
		if (scrollRef.current) scrollRef.current.scrollTop = 0;
		following.current = !thread?.messages.length;
		setConfirmDelete(false);
	}, [active]);

	useLayoutEffect(() => {
		if (following.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
	}, [liveText, messages.length]);

	useEffect(() => {
		if (confirmDelete) cancelDeleteRef.current?.focus({ preventScroll: true });
	}, [confirmDelete]);

	const dismissLayer = () => {
		if (confirmDelete) setConfirmDelete(false);
		else if (historyOpen) setHistoryOpen(false);
		else store?.setOpen(false);
	};

	if (!store || !state.panelOpen) return null;
	const saveDraft = (value: typeof EMPTY_DRAFT) => {
		if (active) store.setDraft(active, value);
	};
	const ask = (retry = false) => {
		if (!active || busy) return;
		following.current = true;
		void store.ask(active, retry ? { retry: true } : undefined);
	};
	const navigate = (quote: SideChatQuote) => {
		const found = navigateToSideQuote(quote);
		if (found && document.getElementById(`side-chat-panel-${chatId}`)?.dataset.layout === "overlay") store.setOpen(false);
		return found;
	};

	return (
		<SessionSecondaryPanel chatId={chatId} id={`side-chat-panel-${chatId}`} label="Side questions" testId="side-chat-panel" obscured={obscured} onEscape={dismissLayer}>
			<header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-3 font-ui">
				<MessageCircleQuestionIcon className="size-4 shrink-0 text-muted-foreground" />
				<strong className="min-w-0 flex-1 text-sm">Side questions</strong>
				<Button size="icon-sm" variant="ghost" aria-label="Side question history" title="History" aria-pressed={historyOpen}
					onClick={() => { setHistoryOpen(!historyOpen); setConfirmDelete(false); }}><HistoryIcon /></Button>
				<Button size="icon-sm" variant="ghost" aria-label="New side question" title="New question"
					onClick={() => { store.openNew(); setHistoryOpen(false); }}><PlusIcon /></Button>
				<Button size="icon-sm" variant="ghost" aria-label="Close side questions" title="Close"
					onClick={() => store.setOpen(false)}><XIcon /></Button>
			</header>
			<p className="shrink-0 px-4 py-2 font-ui text-xs text-muted-foreground">Not shared with the teacher</p>
			{historyOpen ? (
				<nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" aria-label="Side question history">
					<h2 className="mb-2 px-1 font-ui text-xs uppercase text-muted-foreground">This session</h2>
					{Object.entries(state.entries).filter(([, item]) => item.thread).sort(([, a], [, b]) => byRecentActivity(a.thread!, b.thread!)).map(([key, item]) => (
						<button key={key} type="button" className="mb-1 block w-full rounded-md p-2 text-left hover:bg-accent"
							onClick={() => { store.setActive(key); setHistoryOpen(false); }}>
							<span className="line-clamp-2 font-prose text-base">{threadTitle(item.thread!)}</span>
							{item.answer !== undefined && <span className="font-ui text-xs text-muted-foreground">Answering…</span>}
						</button>
					))}
					{Object.entries(state.entries).filter(([, item]) => !item.thread).reverse().map(([key, item]) => (
						<button key={key} type="button" className="mb-1 block w-full rounded-md p-2 text-left hover:bg-accent"
							onClick={() => { store.setActive(key); setHistoryOpen(false); }}>
							<span className="line-clamp-2 font-prose text-base">{item.draft?.text || item.draft?.quotes[0]?.text || "New question"}</span>
							<span className="font-ui text-xs text-muted-foreground">Draft</span>
						</button>
					))}
				</nav>
			) : (
				<>
					<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-2" data-testid="side-chat-scroll"
						onScroll={(event) => { const element = event.currentTarget; following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32; }}>
						{messages.map((message) => <SideMessage key={message.id} message={message} navigate={navigate} />)}
						{liveText !== undefined && (liveText ? (
							<div className="lh-prose mb-4" data-testid="side-chat-streaming"><MessageResponse isAnimating>{liveText}</MessageResponse></div>
						) : <p className="mb-3 flex items-center gap-2 font-ui text-xs text-muted-foreground"><BrailleSpinner label="Answering" />Answering…</p>)}
						{canRetry && <Button type="button" size="sm" variant="outline" data-testid="side-chat-retry" onClick={() => ask(true)}>Retry answer</Button>}
						{error && <p role="alert" className="mt-2 font-prose text-sm text-destructive">{error}</p>}
					</div>
					{active && <form className="shrink-0 border-t border-border p-3" onSubmit={(event) => { event.preventDefault(); ask(); }}>
						<div className="max-h-40 overflow-y-auto overscroll-contain">
							{draft.quotes.map((quote, index) => <QuoteChip key={index} quote={quote} navigate={navigate}
								onRemove={() => saveDraft({ ...draft, quotes: draft.quotes.filter((_, i) => i !== index) })} />)}
						</div>
						<Textarea ref={inputRef} aria-label="Side question" data-testid="side-chat-input" rows={2}
							value={draft.text} placeholder={messages.length ? "Ask a follow-up…" : "Ask a side question…"}
							className="field-sizing-content lh-input max-h-48 min-h-20 resize-none"
							onChange={(event) => saveDraft({ ...draft, text: event.target.value })}
							onKeyDown={(event) => {
								if (event.nativeEvent.isComposing) return;
								if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); ask(); }
							}} />
						<div className="mt-2 flex items-center justify-between gap-2">
							<span className="font-ui text-xs text-muted-foreground">Enter sends · ⇧Enter newline</span>
							{busy ? <Button type="button" size="sm" variant="secondary" data-testid="side-chat-stop" onClick={() => void store.stop(active)}><SquareIcon className="size-3" />{entry?.sending ? "Cancel" : "Stop"}</Button>
								: <Button type="submit" size="sm" data-testid="side-chat-send" disabled={busy || !draft.text.trim() || last?.role === "user"}>Ask</Button>}
						</div>
					</form>}
				</>
			)}
			{(thread || isDraft) && <div className="shrink-0 px-3 pb-3">
				{confirmDelete ? <div role="alertdialog" aria-label={isDraft ? "Discard side question draft" : "Delete side conversation"} className="rounded-lg border border-border bg-card p-3">
					<p className="mb-2 font-prose text-sm">{isDraft ? "Discard this draft?" : "Delete this side conversation? This also stops a running answer."}</p>
					<div className="flex justify-end gap-2"><Button ref={cancelDeleteRef} size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button>
						<Button size="sm" variant="destructive" disabled={isDraft && busy} onClick={() => { if (!active || (isDraft && busy)) return; setConfirmDelete(false); void store.remove(active); }}>{isDraft ? "Discard" : "Delete"}</Button></div>
				</div> : <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" disabled={isDraft && busy} onClick={() => setConfirmDelete(true)}><Trash2Icon className="size-3.5" />{isDraft ? "Discard draft" : "Delete conversation"}</Button>}
			</div>}
		</SessionSecondaryPanel>
	);
}

function threadTitle(thread: SideChatThread): string {
	return thread.messages.find((message) => message.role === "user")?.text || "Side question";
}
function byRecentActivity(a: SideChatThread, b: SideChatThread): number {
	return (b.messages.at(-1)?.at ?? b.createdAt).localeCompare(a.messages.at(-1)?.at ?? a.createdAt);
}
function SideMessage({ message, navigate }: { message: SideChatMessage; navigate: (quote: SideChatQuote) => boolean }) {
	return <article className="mb-4" data-side-role={message.role}>
		<div className="mb-1 font-ui text-xs font-medium uppercase text-muted-foreground">{message.role === "user" ? "You" : "Answer"}</div>
		{message.quotes?.map((quote, index) => <QuoteChip key={index} quote={quote} navigate={navigate} />)}
		{message.role === "user" ? <p className="lh-prose whitespace-pre-wrap">{message.text}</p> : message.text && <MessageResponse>{message.text}</MessageResponse>}
		{message.error !== undefined && <p role="alert" className="mt-1 font-prose text-sm text-destructive">The answer failed: {message.error}</p>}
		{message.stopped && <p className="mt-1 font-ui text-xs text-muted-foreground">Stopped.</p>}
	</article>;
}
function QuoteChip({ quote, onRemove, navigate }: { quote: SideChatQuote; onRemove?: () => void; navigate: (quote: SideChatQuote) => boolean }) {
	const [unavailable, setUnavailable] = useState(false);
	return <div className="mb-2 flex items-start gap-2 rounded-md border border-border bg-card p-2">
		<div className="min-w-0 flex-1"><button type="button" className="mb-1 block text-left font-ui text-xs text-muted-foreground underline" onClick={() => setUnavailable(!navigate(quote))}>Go to source</button>
			<SideQuoteContent quote={quote} />
			{unavailable && <p role="status" className="mt-1 font-prose text-xs text-muted-foreground">Source unavailable or ambiguous in this lesson view.</p>}</div>
		{onRemove && <Button type="button" variant="ghost" size="icon-xs" aria-label="Remove quote" onClick={onRemove}><XIcon /></Button>}
	</div>;
}
