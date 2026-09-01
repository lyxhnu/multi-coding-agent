/**
 * System reminder policy for the todo list, aligned with Grok Build's
 * `ReminderPolicy` (see xai-grok-agent/src/system_reminder.rs): same two
 * mechanisms (TodoNudge, TodoGate), same default values.
 *
 * - TodoNudge: a periodic, informational reminder injected before a turn
 *   when the model hasn't called `todo_write` in a while. Enabled by
 *   default; never blocks or forces anything.
 * - TodoGate: a stronger mechanism that forces another turn when pending
 *   todos remain at the end of a run. Disabled by default (opt-in) because
 *   forcing continuations has real cost/risk; the session uses the bounded
 *   `shouldFireTodoGate` decision before queuing each continuation.
 */

export interface TodoNudgeConfig {
	enabled: boolean;
	turnsSinceTodoWrite: number;
	turnsBetweenReminders: number;
}

export interface TodoGateConfig {
	enabled: boolean;
	maxFiresPerPrompt: number;
}

export interface ReminderPolicy {
	enabled: boolean;
	todoNudge: TodoNudgeConfig;
	todoGate: TodoGateConfig;
}

export interface ReminderSettings {
	enabled?: boolean;
	todoNudge?: Partial<TodoNudgeConfig>;
	todoGate?: Partial<TodoGateConfig>;
}

export const DEFAULT_TODO_GATE_MAX_FIRES = 2;

export const DEFAULT_REMINDER_POLICY: ReminderPolicy = {
	enabled: true,
	todoNudge: { enabled: true, turnsSinceTodoWrite: 3, turnsBetweenReminders: 5 },
	todoGate: { enabled: false, maxFiresPerPrompt: DEFAULT_TODO_GATE_MAX_FIRES },
};

/** Merge user-provided settings over the Grok-aligned defaults. Missing fields fall back individually. */
export function resolveReminderPolicy(settings: ReminderSettings | undefined): ReminderPolicy {
	return {
		enabled: settings?.enabled ?? DEFAULT_REMINDER_POLICY.enabled,
		todoNudge: {
			enabled: settings?.todoNudge?.enabled ?? DEFAULT_REMINDER_POLICY.todoNudge.enabled,
			turnsSinceTodoWrite:
				settings?.todoNudge?.turnsSinceTodoWrite ?? DEFAULT_REMINDER_POLICY.todoNudge.turnsSinceTodoWrite,
			turnsBetweenReminders:
				settings?.todoNudge?.turnsBetweenReminders ?? DEFAULT_REMINDER_POLICY.todoNudge.turnsBetweenReminders,
		},
		todoGate: {
			enabled: settings?.todoGate?.enabled ?? DEFAULT_REMINDER_POLICY.todoGate.enabled,
			maxFiresPerPrompt: settings?.todoGate?.maxFiresPerPrompt ?? DEFAULT_REMINDER_POLICY.todoGate.maxFiresPerPrompt,
		},
	};
}

const REMINDER_TEXT =
	"<system-reminder>You have not called todo_write in a while. If you're in the middle of a multi-step " +
	"task, use todo_write to keep the visible task list current before continuing.</system-reminder>";

/** The exact hidden-message text TodoNudge injects. Exported so callers/tests don't need to duplicate it. */
export function todoNudgeReminderText(): string {
	return REMINDER_TEXT;
}

const TODO_GATE_TEXT =
	"<system-reminder>You have pending or in_progress todo items. Continue working on them, or call " +
	"todo_write to mark them completed or cancelled if they are no longer relevant.</system-reminder>";

/** The exact message text TodoGate injects as a forced follow-up. */
export function todoGateReminderText(): string {
	return TODO_GATE_TEXT;
}

/**
 * Tracks turns-since-todo_write and turns-since-last-nudge for one session,
 * and decides when TodoNudge should fire. Pure/stateful but has no I/O —
 * the caller is responsible for actually injecting the reminder and calling
 * `recordNudgeFired()`.
 */
export class TodoNudgeTracker {
	private turnsSinceTodoWrite = 0;
	private turnsSinceNudge = Number.POSITIVE_INFINITY;
	private policy: TodoNudgeConfig;

	constructor(policy: TodoNudgeConfig) {
		this.policy = policy;
	}

	updatePolicy(policy: TodoNudgeConfig): void {
		this.policy = policy;
	}

	/** Call once per completed agent turn. `calledTodoWrite` = did this turn include a `todo_write` call. */
	recordTurnEnd(calledTodoWrite: boolean): void {
		if (calledTodoWrite) {
			this.turnsSinceTodoWrite = 0;
		} else {
			this.turnsSinceTodoWrite++;
		}
		if (this.turnsSinceNudge !== Number.POSITIVE_INFINITY) {
			this.turnsSinceNudge++;
		}
	}

	shouldNudge(): boolean {
		if (!this.policy.enabled) return false;
		if (this.turnsSinceTodoWrite < this.policy.turnsSinceTodoWrite) return false;
		if (this.turnsSinceNudge < this.policy.turnsBetweenReminders) return false;
		return true;
	}

	/** Call after actually injecting the reminder, to reset the between-reminders cooldown. */
	recordNudgeFired(): void {
		this.turnsSinceNudge = 0;
	}
}

export interface TodoGateState {
	/** How many times the gate has already fired for the current user prompt. */
	firesForCurrentPrompt: number;
	/** Whether any tracked todo is still pending/in_progress. */
	hasPendingWork: boolean;
	/** True once the user has cancelled/aborted the current run. */
	cancelled: boolean;
}

/**
 * Pure TodoGate decision: should another turn be forced right now?
 * Deliberately does not perform the continuation itself (see module doc).
 */
export function shouldFireTodoGate(config: TodoGateConfig, state: TodoGateState): boolean {
	if (!config.enabled) return false;
	if (state.cancelled) return false;
	if (!state.hasPendingWork) return false;
	return state.firesForCurrentPrompt < config.maxFiresPerPrompt;
}
