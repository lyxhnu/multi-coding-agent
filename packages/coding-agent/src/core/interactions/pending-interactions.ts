/**
 * Registry of blocking, human-in-the-loop interactions: permission asks,
 * ask_user_question, plan-exit approval, global-memory-write approval.
 * Aligned with Grok's "blocking ACP reverse-request" model (see
 * xai-grok-shell/src/session/pending_interaction.rs): the agent parks a
 * future on this registry and waits for the driver (TUI/RPC) to resolve it.
 *
 * This registry only tracks *that* something is pending and lets a caller
 * await its resolution — it does not render UI. A TUI/RPC layer is expected
 * to observe new entries (e.g. via `list()`/events) and call `resolve()`.
 */

export type PendingKind = "permission" | "question" | "plan_approval" | "memory_global_write";

export interface PendingInteraction {
	toolCallId: string;
	kind: PendingKind;
	sessionId?: string;
	rootPromptId?: string;
	createdAt: number;
	expiresAt: number;
	/** Free-form payload for the driver to render (e.g. the redacted operation, the plan). */
	payload?: unknown;
}

export type PendingInteractionResolution<T> = { outcome: "resolved"; value: T } | { outcome: "timeout" | "cancelled" };

const DEFAULT_TIMEOUT_MS = 120_000;

interface Entry<T> {
	interaction: PendingInteraction;
	resolve: (resolution: PendingInteractionResolution<T>) => void;
	timer: NodeJS.Timeout;
}

/**
 * One registry per session. Every entry fails closed: disconnect, timeout,
 * session switch, or explicit cancellation all resolve as "not approved" —
 * callers must treat anything other than `{ outcome: "resolved" }` as deny.
 */
export class PendingInteractionRegistry {
	private entries = new Map<string, Entry<unknown>>();

	/**
	 * Registers a pending interaction and returns a promise that resolves once
	 * `resolve()`/`cancel()` is called for this `toolCallId`, or the timeout elapses.
	 */
	create<T>(
		toolCallId: string,
		kind: PendingKind,
		options?: { sessionId?: string; rootPromptId?: string; payload?: unknown; timeoutMs?: number },
	): Promise<PendingInteractionResolution<T>> {
		if (this.entries.has(toolCallId)) {
			throw new Error(`A pending interaction already exists for toolCallId ${toolCallId}`);
		}
		const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const now = Date.now();
		const interaction: PendingInteraction = {
			toolCallId,
			kind,
			sessionId: options?.sessionId,
			rootPromptId: options?.rootPromptId,
			createdAt: now,
			expiresAt: now + timeoutMs,
			payload: options?.payload,
		};

		return new Promise<PendingInteractionResolution<T>>((resolvePromise) => {
			const timer = setTimeout(() => {
				this.entries.delete(toolCallId);
				resolvePromise({ outcome: "timeout" });
			}, timeoutMs);
			this.entries.set(toolCallId, {
				interaction,
				resolve: resolvePromise as (resolution: PendingInteractionResolution<unknown>) => void,
				timer,
			});
		});
	}

	/** Resolves a pending interaction with a value (e.g. the user's approval decision). */
	resolve<T>(toolCallId: string, value: T): boolean {
		const entry = this.entries.get(toolCallId);
		if (!entry) return false;
		clearTimeout(entry.timer);
		this.entries.delete(toolCallId);
		entry.resolve({ outcome: "resolved", value });
		return true;
	}

	/** Cancels a pending interaction (user cancelled, session switched, connection dropped). */
	cancel(toolCallId: string): boolean {
		const entry = this.entries.get(toolCallId);
		if (!entry) return false;
		clearTimeout(entry.timer);
		this.entries.delete(toolCallId);
		entry.resolve({ outcome: "cancelled" });
		return true;
	}

	/** Cancels every pending interaction for a session (session switch/shutdown). */
	cancelBySession(sessionId: string): void {
		for (const toolCallId of [...this.entries.keys()]) {
			const entry = this.entries.get(toolCallId);
			if (entry?.interaction.sessionId === sessionId) this.cancel(toolCallId);
		}
	}

	cancelAll(): void {
		for (const toolCallId of [...this.entries.keys()]) this.cancel(toolCallId);
	}

	get(toolCallId: string): PendingInteraction | undefined {
		return this.entries.get(toolCallId)?.interaction;
	}

	list(): PendingInteraction[] {
		return [...this.entries.values()].map((entry) => entry.interaction);
	}
}
