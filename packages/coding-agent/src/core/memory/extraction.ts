import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const memoryExtractionSchema = Type.Object(
	{
		facts: Type.Array(
			Type.Object(
				{
					text: Type.String({ minLength: 1 }),
					sourceNoteIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export type MemoryExtraction = Static<typeof memoryExtractionSchema>;

export function validateMemoryExtraction(value: unknown, sourceIds: ReadonlySet<string>): MemoryExtraction {
	if (
		!Value.Check(memoryExtractionSchema, value) ||
		value.facts.some((fact) => !fact.text.trim() || fact.sourceNoteIds.some((id) => !sourceIds.has(id)))
	) {
		throw new Error("invalid_memory_extraction");
	}
	return value;
}
