import { describe, expect, it } from "vitest";
import {
	DEFAULT_REMINDER_POLICY,
	resolveReminderPolicy,
	shouldFireTodoGate,
	TodoNudgeTracker,
} from "../src/core/todo/reminder-policy.ts";

describe("resolveReminderPolicy defaults", () => {
	it("matches the Grok-aligned defaults when no settings are provided", () => {
		expect(resolveReminderPolicy(undefined)).toEqual(DEFAULT_REMINDER_POLICY);
	});

	it("merges partial settings over the defaults field-by-field", () => {
		const policy = resolveReminderPolicy({ todoGate: { enabled: true } });
		expect(policy.todoGate).toEqual({ enabled: true, maxFiresPerPrompt: 2 });
		expect(policy.todoNudge).toEqual(DEFAULT_REMINDER_POLICY.todoNudge);
	});
});

describe("TodoNudgeTracker", () => {
	const policy = { enabled: true, turnsSinceTodoWrite: 3, turnsBetweenReminders: 5 };

	it("does not nudge before the turn threshold is reached", () => {
		const tracker = new TodoNudgeTracker(policy);
		tracker.recordTurnEnd(false);
		tracker.recordTurnEnd(false);
		expect(tracker.shouldNudge()).toBe(false);
	});

	it("nudges once the turn threshold is reached", () => {
		const tracker = new TodoNudgeTracker(policy);
		tracker.recordTurnEnd(false);
		tracker.recordTurnEnd(false);
		tracker.recordTurnEnd(false);
		expect(tracker.shouldNudge()).toBe(true);
	});

	it("resets the turn counter when todo_write is called", () => {
		const tracker = new TodoNudgeTracker(policy);
		tracker.recordTurnEnd(false);
		tracker.recordTurnEnd(false);
		tracker.recordTurnEnd(true); // todo_write called on this turn
		expect(tracker.shouldNudge()).toBe(false);
	});

	it("does not nudge again until turnsBetweenReminders have passed", () => {
		const tracker = new TodoNudgeTracker(policy);
		tracker.recordTurnEnd(false);
		tracker.recordTurnEnd(false);
		tracker.recordTurnEnd(false);
		expect(tracker.shouldNudge()).toBe(true);
		tracker.recordNudgeFired();
		expect(tracker.shouldNudge()).toBe(false);

		for (let i = 0; i < 4; i++) tracker.recordTurnEnd(false);
		expect(tracker.shouldNudge()).toBe(false);

		tracker.recordTurnEnd(false);
		expect(tracker.shouldNudge()).toBe(true);
	});

	it("never nudges when disabled", () => {
		const tracker = new TodoNudgeTracker({ ...policy, enabled: false });
		for (let i = 0; i < 10; i++) tracker.recordTurnEnd(false);
		expect(tracker.shouldNudge()).toBe(false);
	});
});

describe("shouldFireTodoGate", () => {
	const enabledConfig = { enabled: true, maxFiresPerPrompt: 2 };

	it("never fires when disabled, even with pending work", () => {
		expect(
			shouldFireTodoGate(
				{ enabled: false, maxFiresPerPrompt: 2 },
				{ firesForCurrentPrompt: 0, hasPendingWork: true, cancelled: false },
			),
		).toBe(false);
	});

	it("does not fire when there is no pending work", () => {
		expect(
			shouldFireTodoGate(enabledConfig, { firesForCurrentPrompt: 0, hasPendingWork: false, cancelled: false }),
		).toBe(false);
	});

	it("does not fire after the user has cancelled", () => {
		expect(
			shouldFireTodoGate(enabledConfig, { firesForCurrentPrompt: 0, hasPendingWork: true, cancelled: true }),
		).toBe(false);
	});

	it("fires while under the per-prompt budget", () => {
		expect(
			shouldFireTodoGate(enabledConfig, { firesForCurrentPrompt: 1, hasPendingWork: true, cancelled: false }),
		).toBe(true);
	});

	it("stops firing once the per-prompt budget is exhausted", () => {
		expect(
			shouldFireTodoGate(enabledConfig, { firesForCurrentPrompt: 2, hasPendingWork: true, cancelled: false }),
		).toBe(false);
	});
});
