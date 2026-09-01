import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { LspManager, LspOperationError } from "../lsp/lsp-manager.ts";

const lspSchema = Type.Object({
	operation: Type.Union(
		[
			Type.Literal("goToDefinition"),
			Type.Literal("findReferences"),
			Type.Literal("hover"),
			Type.Literal("goToImplementation"),
			Type.Literal("documentSymbol"),
			Type.Literal("workspaceSymbol"),
		],
		{ description: "Which LSP operation to run." },
	),
	file_path: Type.Optional(
		Type.String({ description: "File to operate on (required for all operations except workspaceSymbol)." }),
	),
	line: Type.Optional(Type.Number({ description: "0-based line number (required for position-based operations)." })),
	character: Type.Optional(
		Type.Number({ description: "0-based character offset (required for position-based operations)." }),
	),
	query: Type.Optional(Type.String({ description: "Symbol query (required for workspaceSymbol)." })),
});

export type LspToolInput = Static<typeof lspSchema>;

function isLspOperationError(error: unknown): error is LspOperationError {
	return typeof error === "object" && error !== null && "code" in error && "message" in error;
}

export function createLspToolDefinition(manager: LspManager): ToolDefinition<typeof lspSchema, { operation: string }> {
	return {
		name: "lsp",
		label: "lsp",
		description:
			"Query a language server for semantic code intelligence: goToDefinition, findReferences, hover, " +
			"goToImplementation, documentSymbol, or workspaceSymbol. Requires a configured language server for the file's language.",
		promptSnippet: "Query semantic code intelligence (definitions, references, hover, symbols)",
		parameters: lspSchema,
		async execute(_toolCallId, input: LspToolInput) {
			try {
				const result = await runOperation(manager, input);
				return {
					content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }],
					details: { operation: input.operation },
				};
			} catch (error) {
				const message = isLspOperationError(error)
					? error.message
					: error instanceof Error
						? error.message
						: String(error);
				throw new Error(`lsp ${input.operation} failed: ${message}`);
			}
		},
		renderCall(args, theme) {
			const operation = typeof args?.operation === "string" ? args.operation : "lsp";
			return new Text(theme.fg("toolTitle", theme.bold(`lsp ${operation}`)), 0, 0);
		},
	};
}

async function runOperation(manager: LspManager, input: LspToolInput): Promise<unknown> {
	switch (input.operation) {
		case "goToDefinition":
			requirePosition(input);
			return manager.goToDefinition(input.file_path!, input.line!, input.character!);
		case "findReferences":
			requirePosition(input);
			return manager.findReferences(input.file_path!, input.line!, input.character!);
		case "hover":
			requirePosition(input);
			return manager.hover(input.file_path!, input.line!, input.character!);
		case "goToImplementation":
			requirePosition(input);
			return manager.goToImplementation(input.file_path!, input.line!, input.character!);
		case "documentSymbol":
			if (!input.file_path) throw new Error("file_path is required for documentSymbol");
			return manager.documentSymbol(input.file_path);
		case "workspaceSymbol":
			if (!input.query) throw new Error("query is required for workspaceSymbol");
			return manager.workspaceSymbol(input.query);
	}
}

function requirePosition(input: LspToolInput): void {
	if (!input.file_path) throw new Error(`file_path is required for ${input.operation}`);
	if (input.line === undefined) throw new Error(`line is required for ${input.operation}`);
	if (input.character === undefined) throw new Error(`character is required for ${input.operation}`);
}
