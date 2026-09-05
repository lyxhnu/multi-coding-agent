import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PendingDeliveryStore } from "../../src/core/pending-delivery.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("PendingDeliveryStore", () => {
	it("DQ01 persists a complete pending delivery before returning it", () => {
		const sessionManager = SessionManager.inMemory("C:/workspace");
		const store = new PendingDeliveryStore(sessionManager, {
			createDeliveryId: () => "delivery-1",
		});
		const message = {
			role: "user" as const,
			content: [
				{ type: "text" as const, text: "keep the image" },
				{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" },
			],
			timestamp: 1,
		};

		const queued = store.enqueue("steering", message);

		expect(queued).toEqual({ queueItemId: "delivery-1", message });
		expect(sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "pending_delivery",
				deliveryId: "delivery-1",
				channel: "steering",
				message,
			}),
		);
		expect(store.snapshot().items).toEqual([{ queueItemId: "delivery-1", channel: "steering", message }]);
	});

	it("DQ02 restores an undelivered item after the process state is discarded", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-pending-delivery-"));
		try {
			const firstManager = SessionManager.create("C:/workspace", root);
			const firstStore = new PendingDeliveryStore(firstManager, {
				createDeliveryId: () => "delivery-1",
			});
			firstStore.enqueue("follow_up", { role: "user", content: "resume me", timestamp: 1 });
			const sessionFile = firstManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session file");

			const resumedManager = SessionManager.open(sessionFile, root);
			const resumedStore = new PendingDeliveryStore(resumedManager);

			expect(resumedStore.snapshot().items).toEqual([
				{
					queueItemId: "delivery-1",
					channel: "follow_up",
					message: { role: "user", content: "resume me", timestamp: 1 },
				},
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("DQ03 projects a receipted message exactly once and does not requeue it", () => {
		const sessionManager = SessionManager.inMemory("C:/workspace");
		const store = new PendingDeliveryStore(sessionManager, {
			createDeliveryId: () => "delivery-1",
		});
		const message = { role: "user" as const, content: "delivered", timestamp: 1 };
		store.enqueue("steering", message);

		store.markDelivered("delivery-1", "preparation-1");

		expect(store.snapshot().items).toEqual([]);
		expect(sessionManager.buildSessionContext().messages).toEqual([message]);
	});

	it("rejects reusing a delivery ID after it has reached a terminal state", () => {
		const sessionManager = SessionManager.inMemory("C:/workspace");
		let nextId = "delivery-1";
		const store = new PendingDeliveryStore(sessionManager, {
			createDeliveryId: () => nextId,
		});

		store.enqueue("steering", { role: "user", content: "first", timestamp: 1 });
		store.markDelivered("delivery-1");
		nextId = "delivery-1";

		expect(() => store.enqueue("steering", { role: "user", content: "second", timestamp: 2 })).toThrow(
			"Duplicate pending delivery ID",
		);
	});
});
