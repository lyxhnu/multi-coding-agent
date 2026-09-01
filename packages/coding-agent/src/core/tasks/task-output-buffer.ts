/**
 * Append-only output buffer with a monotonically increasing byte cursor, so
 * `get_task_output` can page through a running task's output incrementally
 * instead of re-reading everything each poll.
 *
 * Bounded in memory: once `maxBytes` is exceeded, the oldest bytes are
 * dropped and a marker records how much was discarded. This is a simpler,
 * memory-only variant of the truncation `OutputAccumulator` already used by
 * the foreground bash path (see ../tools/output-accumulator.ts) — tasks are
 * expected to be polled incrementally, so unbounded spooling to disk is not
 * needed here.
 */

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB retained in memory
const MAX_READ_BYTES = 256 * 1024; // per get_task_output call

export class TaskOutputBuffer {
	private retained = Buffer.alloc(0);
	/** Total bytes ever appended, including bytes since dropped. Used as the cursor space. */
	private totalBytes = 0;
	/** Byte offset (in the `totalBytes` space) of the first byte still retained in `chunks`. */
	private retainedFrom = 0;
	private readonly maxBytes: number;

	constructor(maxBytes: number = DEFAULT_MAX_BYTES) {
		this.maxBytes = maxBytes;
	}

	append(chunk: string): void {
		if (chunk.length === 0) return;
		const bytes = Buffer.from(chunk, "utf-8");
		this.retained = Buffer.concat([this.retained, bytes]);
		this.totalBytes += bytes.length;
		this.trim();
	}

	private trim(): void {
		if (this.retained.length <= this.maxBytes) return;
		let dropBytes = this.retained.length - this.maxBytes;
		while (dropBytes < this.retained.length && (this.retained[dropBytes]! & 0xc0) === 0x80) dropBytes++;
		this.retained = this.retained.subarray(dropBytes);
		this.retainedFrom += dropBytes;
	}

	/** Full retained text (for final formatting once a task completes). */
	full(): string {
		return this.retained.toString("utf-8");
	}

	/**
	 * Read starting at byte cursor `from` (default: from the start of what's
	 * still retained). Returns at most `MAX_READ_BYTES`. `nextCursor` is the
	 * cursor to pass on the next call to continue reading.
	 */
	read(from = 0): { text: string; nextCursor: number; hasMore: boolean } {
		const start = Math.min(this.totalBytes, Math.max(from, this.retainedFrom));
		const startInBuffer = start - this.retainedFrom;
		const available = this.retained.subarray(startInBuffer);
		let pageBytes = Math.min(available.length, MAX_READ_BYTES);
		while (pageBytes > 0 && pageBytes < available.length && (available[pageBytes]! & 0xc0) === 0x80) pageBytes--;
		const text = available.subarray(0, pageBytes).toString("utf-8");
		const nextCursor = start + pageBytes;
		return { text, nextCursor, hasMore: nextCursor < this.totalBytes };
	}

	cursorEnd(): number {
		return this.totalBytes;
	}
}
