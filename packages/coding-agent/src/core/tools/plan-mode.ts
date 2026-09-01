import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { buildPlanArtifact, formatPlanArtifact, type PlanArtifact } from "../plan/plan-state.ts";

const enterPlanModeSchema = Type.Object({});

/** Controller interface a host (AgentSession) implements to back the enter/exit plan mode tools. */
export interface PlanModeController {
	enterPlanMode(): { alreadyPlanning: boolean };
	/** Returns whether the exit was approved. Fail-closed: no approval channel => not approved. */
	requestExitPlanMode(plan: PlanArtifact): Promise<{ approved: boolean; reason?: string }>;
}

export function createEnterPlanModeToolDefinition(
	controller: PlanModeController,
): ToolDefinition<typeof enterPlanModeSchema> {
	return {
		name: "enter_plan_mode",
		label: "enter_plan_mode",
		description:
			"Enter plan mode: a read-only exploration mode for safely analyzing the codebase before making changes. " +
			"Write tools and mutating bash are disabled until exit_plan_mode is approved.",
		promptSnippet: "Enter read-only plan mode before making changes",
		parameters: enterPlanModeSchema,
		async execute() {
			const { alreadyPlanning } = controller.enterPlanMode();
			return {
				content: [
					{
						type: "text",
						text: alreadyPlanning
							? "Already in plan mode."
							: "Entered plan mode. Only read-only tools are available. Call exit_plan_mode with your plan when ready.",
					},
				],
				details: undefined,
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("enter_plan_mode")), 0, 0);
		},
	};
}

const exitPlanModeSchema = Type.Object({
	title: Type.String({ description: "Short title for the plan." }),
	objective: Type.String({ description: "What this plan accomplishes." }),
	steps: Type.Array(Type.String(), { description: "Ordered implementation steps." }),
	assumptions: Type.Optional(Type.Array(Type.String())),
	affected_paths: Type.Optional(Type.Array(Type.String(), { description: "Files/paths this plan will touch." })),
	risks: Type.Optional(Type.Array(Type.String())),
	verification: Type.Optional(Type.Array(Type.String(), { description: "How to verify the plan succeeded." })),
});

export type ExitPlanModeToolInput = Static<typeof exitPlanModeSchema>;

export function createExitPlanModeToolDefinition(
	controller: PlanModeController,
): ToolDefinition<typeof exitPlanModeSchema, { plan: PlanArtifact }> {
	return {
		name: "exit_plan_mode",
		label: "exit_plan_mode",
		description:
			"Present your plan and request approval to exit plan mode and start making changes. " +
			"Requires user (or RPC) approval; if no approval channel is available, this fails closed and plan mode stays active.",
		promptSnippet: "Present a plan and request approval to start executing",
		parameters: exitPlanModeSchema,
		async execute(_toolCallId, input: ExitPlanModeToolInput) {
			const plan = buildPlanArtifact(input);
			const { approved, reason } = await controller.requestExitPlanMode(plan);
			if (!approved) {
				throw new Error(
					`Plan not approved${reason ? `: ${reason}` : ""}. Still in plan mode; only read-only tools are available.`,
				);
			}
			return {
				content: [{ type: "text", text: `Plan approved. Exiting plan mode.\n\n${formatPlanArtifact(plan)}` }],
				details: { plan },
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("exit_plan_mode")), 0, 0);
		},
	};
}
