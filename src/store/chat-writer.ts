import * as fs from "node:fs";
import * as path from "node:path";

/** One server process owns a chat directory. Atomic rename is NOT a CAS lock.
 * A PID-named child lets only the successful stale-owner remover remove the
 * directory. An empty/unreadable claim fails closed (never steals a live lock).
 * Globals survive Next development module re-evaluation. */
const owners = (globalThis as typeof globalThis & { __lhChatWriters?: Set<string> }).__lhChatWriters ??= new Set<string>();

export function claimChatWriter(directory: string): void {
	const lock = path.join(directory, ".writer");
	if (owners.has(lock)) return;
	fs.mkdirSync(directory, { recursive: true });
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			fs.mkdirSync(lock);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const entries = fs.readdirSync(lock);
			const pid = entries.length === 1 && /^\d+$/.test(entries[0]!) ? Number(entries[0]) : null;
			if (pid) {
				let dead = false;
				try { process.kill(pid, 0); } catch (reason) { dead = (reason as NodeJS.ErrnoException).code === "ESRCH"; }
				if (dead) {
					try { fs.unlinkSync(path.join(lock, String(pid))); fs.rmdirSync(lock); } catch { /* another claimant won; retry, never remove its child */ }
					continue;
				}
			}
			throw new Error(`Another LearnHarness server owns ${directory}. Use one server process per data directory. If a crashed process left an empty .writer directory, remove that empty directory with all servers stopped.`);
		}
		const marker = path.join(lock, String(process.pid));
		fs.writeFileSync(marker, "", { flag: "wx" });
		owners.add(lock);
		process.once("exit", () => {
			try { fs.unlinkSync(marker); fs.rmdirSync(lock); } catch { /* data directory may have been removed */ }
			owners.delete(lock);
		});
		return;
	}
	throw new Error("Could not claim the LearnHarness chat directory. Another server may be starting.");
}
