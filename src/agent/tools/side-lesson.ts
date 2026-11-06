import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import type { SideLessonItem } from "../../core/side-chat.ts";

export const SIDE_LESSON_PAGE_CHARS = 8_000;
export const SIDE_LESSON_SEARCH_HITS = 5;

export const sideLessonTools: Tool[] = [
	{
		name: "search_lesson",
		description: "Search earlier learner-visible lesson material, up to this side thread's source boundary. Returns at most five bounded excerpts with item IDs and character offsets. No later lesson content, hidden keys, or hidden solutions is accessible. Use read_lesson to read more of a matching item.",
		parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: SIDE_LESSON_PAGE_CHARS }) }),
	},
	{
		name: "read_lesson",
		description: "Read one learner-visible lesson item by its ID from initial context or search_lesson. Returns a page of at most 8,000 characters with an explicit next offset. offset is a zero-based character offset. Only material within this side thread's source boundary is accessible.",
		parameters: Type.Object({
			id: Type.String({ minLength: 1 }),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
		}),
	},
];

/** Only accepts the already-authorized projection, never a chat store or raw model history. */
export function lookupSideLesson(items: readonly SideLessonItem[], name: string, input: Record<string, unknown>): string {
	if (name === "read_lesson") {
		const item = items.find((item) => item.id === input.id);
		if (!item) throw new Error("Lesson item is unavailable within this thread's source boundary.");
		const offset = input.offset ?? 0;
		if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > item.text.length) throw new Error("offset must be a valid zero-based character offset within the item.");
		const header = `[${item.id}] offset=${offset}; total=${item.text.length} characters\n`;
		// Leave room for the continuation notice inside the same result budget.
		const maxNotice = `\n\n[More content: call read_lesson with id="${item.id}", offset=${item.text.length}.]`;
		const page = item.text.slice(offset, offset + Math.max(0, SIDE_LESSON_PAGE_CHARS - header.length - maxNotice.length));
		const next = offset + page.length;
		return header + page + (next < item.text.length ? `\n\n[More content: call read_lesson with id="${item.id}", offset=${next}.]` : "\n[End of item.]");
	}
	if (name === "search_lesson") {
		if (typeof input.query !== "string" || !input.query.trim() || input.query.length > SIDE_LESSON_PAGE_CHARS) throw new Error("query must be a non-empty string of at most 8,000 characters.");
		const query = input.query.trim().toLowerCase();
		const matches = items.flatMap((item) => {
			const offset = item.text.toLowerCase().indexOf(query);
			return offset < 0 ? [] : [{ item, offset }];
		});
		if (!matches.length) return "No matching earlier lesson items.";
		const hits = matches.slice(0, SIDE_LESSON_SEARCH_HITS);
		const notice = `\n[Showing ${hits.length} of ${matches.length} matching items. Excerpts only; use read_lesson for more or narrow the query.]`;
		const headers = hits.map(({ item, offset }) => `[${item.id}] offset=${Math.max(0, offset - 100)}\n`);
		const excerptChars = Math.max(0, Math.floor((SIDE_LESSON_PAGE_CHARS - notice.length - headers.join("").length - hits.length * 2) / hits.length));
		return hits.map(({ item, offset }, index) => headers[index] + item.text.slice(Math.max(0, offset - 100), Math.max(0, offset - 100) + excerptChars)).join("\n\n") + notice;
	}
	throw new Error("Unknown side-chat tool. Only search_lesson and read_lesson are available.");
}
