import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Spec 6.6/6.7: ReminderPolicy's TodoNudge half (see plan-mode-and-todo-gate.test.ts for the TodoGate
 * half). Default: enabled, nudge after 3 turns without a todo_write, re-nudge no sooner than every 5 turns.
 * The nudge is injected as a `custom`/"todo-nudge" message (see agent-session.ts), not a fake user/system message.
 */
describe("TodoNudge (M9 eval: reminder-policy)", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	function hasTodoNudge(harness: Harness): boolean {
		return harness.session.messages.some((m) => (m as { customType?: string }).customType === "todo-nudge");
	}

	async function plainTurn(harness: Harness, text: string) {
		harness.setResponses([fauxAssistantMessage(text)]);
		await harness.session.prompt(`turn: ${text}`);
	}

	it("does not nudge before turns_since_todo_write (default 3) is exceeded", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["todo_write"] });
		harnesses.push(harness);
		await plainTurn(harness, "one");
		await plainTurn(harness, "two");
		expect(hasTodoNudge(harness)).toBe(false);
	});

	it("nudges once turns_since_todo_write is exceeded, by default", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["todo_write"] });
		harnesses.push(harness);
		for (let i = 0; i < 4; i++) await plainTurn(harness, `turn ${i}`);
		expect(hasTodoNudge(harness)).toBe(true);
	});

	it("is disabled entirely when reminder.todoNudge.enabled=false", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["todo_write"],
			settings: { reminder: { todoNudge: { enabled: false } } },
		});
		harnesses.push(harness);
		for (let i = 0; i < 6; i++) await plainTurn(harness, `turn ${i}`);
		expect(hasTodoNudge(harness)).toBe(false);
	});

	it("disables todo nudge through the reminder master switch", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["todo_write"],
			settings: { reminder: { enabled: false, todoNudge: { enabled: true } } },
		});
		harnesses.push(harness);
		for (let i = 0; i < 6; i++) await plainTurn(harness, `turn ${i}`);
		expect(hasTodoNudge(harness)).toBe(false);
	});
});
