import { type AgentMessage, type QueuedAgentMessage, uuidv7 } from "@earendil-works/pi-agent-core";
import type { PendingDeliveryChannel, PendingDeliveryEntry, SessionManager } from "./session-manager.ts";

export interface PendingDeliverySnapshot {
	readonly revision: string;
	readonly items: ReadonlyArray<{
		queueItemId: string;
		channel: PendingDeliveryChannel;
		message: AgentMessage;
	}>;
}

export interface PendingDeliveryStoreOptions {
	createDeliveryId?: () => string;
}

/** Durable projection of queue entries on the current Session branch. */
export class PendingDeliveryStore {
	private readonly sessionManager: SessionManager;
	private readonly createDeliveryId: () => string;

	constructor(sessionManager: SessionManager, options: PendingDeliveryStoreOptions = {}) {
		this.sessionManager = sessionManager;
		this.createDeliveryId = options.createDeliveryId ?? uuidv7;
	}

	enqueue(channel: PendingDeliveryChannel, message: AgentMessage): QueuedAgentMessage {
		const serialized = JSON.stringify(message);
		if (serialized === undefined) {
			throw new Error("Pending delivery message is not serializable");
		}
		const persistedMessage = JSON.parse(serialized) as AgentMessage;
		const deliveryId = this.createDeliveryId();
		if (
			this.sessionManager
				.getBranch()
				.some(
					(entry) =>
						(entry.type === "pending_delivery" ||
							entry.type === "delivery_receipt" ||
							entry.type === "delivery_cancelled") &&
						entry.deliveryId === deliveryId,
				)
		) {
			throw new Error(`Duplicate pending delivery ID: ${deliveryId}`);
		}
		this.sessionManager.appendPendingDelivery(deliveryId, channel, persistedMessage);
		return { queueItemId: deliveryId, message: persistedMessage };
	}

	snapshot(): PendingDeliverySnapshot {
		const items = this.pendingEntries().map((entry) => ({
			queueItemId: entry.deliveryId,
			channel: entry.channel,
			message: structuredClone(entry.message),
		}));
		return Object.freeze({
			revision: fingerprint(items),
			items: Object.freeze(items),
		});
	}

	markDelivered(queueItemId: string, preparationId?: string): void {
		if (!this.pendingEntries().some((entry) => entry.deliveryId === queueItemId)) {
			throw new Error(`Pending delivery not found: ${queueItemId}`);
		}
		this.sessionManager.appendDeliveryReceipt(queueItemId, preparationId);
	}

	cancel(queueItemId: string): void {
		if (!this.pendingEntries().some((entry) => entry.deliveryId === queueItemId)) {
			throw new Error(`Pending delivery not found: ${queueItemId}`);
		}
		this.sessionManager.appendDeliveryCancelled(queueItemId);
	}

	private pendingEntries(): PendingDeliveryEntry[] {
		const pending = new Map<string, PendingDeliveryEntry>();
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type === "pending_delivery") {
				pending.set(entry.deliveryId, entry);
			} else if (entry.type === "delivery_receipt" || entry.type === "delivery_cancelled") {
				pending.delete(entry.deliveryId);
			} else if (entry.type === "context_rollover_dispatch" && entry.state === "started") {
				for (const deliveryId of entry.reservedDeliveryIds ?? []) pending.delete(deliveryId);
			}
		}
		return [...pending.values()];
	}
}

function fingerprint(value: unknown): string {
	const serialized = JSON.stringify(value);
	let hash = 2166136261;
	for (let index = 0; index < serialized.length; index++) {
		hash ^= serialized.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}
