import { describe, expect, it, vi } from "vitest";
import { createDefaultWebSearchOperations, createTavilyWebSearchOperations } from "../src/core/tools/web-search.ts";

describe("Tavily web search", () => {
	it("is disabled when TAVILY_API_KEY is absent", () => {
		expect(createDefaultWebSearchOperations({}, vi.fn())).toBeUndefined();
	});

	it("maps Tavily results and sends a bounded basic-search request", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [{ title: "Official docs", url: "https://example.com/docs", content: "Documentation snippet" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const operations = createTavilyWebSearchOperations("test-key", fetchMock);

		await expect(operations.search("pi coding agent", 99)).resolves.toEqual([
			{ title: "Official docs", url: "https://example.com/docs", snippet: "Documentation snippet" },
		]);
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.tavily.com/search");
		expect(init?.headers).toEqual({ Authorization: "Bearer test-key", "Content-Type": "application/json" });
		expect(JSON.parse(String(init?.body))).toEqual({
			query: "pi coding agent",
			search_depth: "basic",
			include_answer: false,
			include_raw_content: false,
			max_results: 20,
		});
	});

	it("surfaces Tavily HTTP errors without exposing the API key", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("upstream rejected secret-key", { status: 429 }));
		const operations = createTavilyWebSearchOperations("secret-key", fetchMock);
		const request = operations.search("query", 5);

		await expect(request).rejects.toThrow("Tavily search failed with HTTP 429: upstream rejected [redacted]");
		await expect(request).rejects.not.toThrow("secret-key");
	});
});
