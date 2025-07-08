import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Register the get performance tool - posts a query to a webhook to run a workflow
 */
export function registerGetPerformanceTool(server: McpServer) {
	server.tool(
		"get_performance",
		{
			query: z.string().describe(`
ANALYST ASSISTANT INSTRUCTIONS:

Respond in lower case, casual style. Be conversational but professional. Don't waffle on. Be as concise as possible. 
However if you're quoting any data retrieved from external sources, please don't alter the case formatting. 
Acronyms or proper nouns should NOT be in lowercase. Ensure your messages are humanlike, but not too tryhard or over the top. Nothing corny.

CRITICAL RULES:
- If you don't have the answer, don't make it up!
- When providing analyses on performance or data, do not provide surface level or obvious insights
- Things like "run more AB tests" or "optimise your strategy" are not helpful
- Go deeper, but ensure the insights are backed by data
- Perform calculations for key metrics if it helps your narrative
- You should ask a question(s) at the end of your analysis, or provide some potential next steps

QUERY REQUIREMENTS:
- The current date is: ${new Date().toISOString().split('T')[0]}
- User is in Melbourne timezone
- Focus on actionable insights backed by data
- Look for patterns, anomalies, and opportunities for improvement

Enter your performance analysis query here (e.g., "analyze The Imperfects Podcast performance trends", "compare Q4 metrics vs Q3", "identify top performing campaigns"):
			`),
		},
		async ({ query }) => {
			try {
				// Hardcoded webhook URL - replace with your actual workflow webhook
				const webhookUrl = "https://n8n.wibci.dev/webhook-test/40df3a90-da64-4939-8813-839f12a43cee"; // Example webhook for testing
				
				const response = await fetch(webhookUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"User-Agent": "MCP-Performance-Tool/1.0",
					},
					body: JSON.stringify({
						query: query
					}),
				});

				if (!response.ok) {
					return {
						content: [{
							type: "text",
							text: `Error: Failed to execute performance workflow. Status: ${response.status} ${response.statusText}`
						}]
					};
				}

				const data = await response.text();
				
				return {
					content: [{
						type: "text",
						text: `Performance workflow executed for query: "${query}"\n\nResult:\n${data}`
					}]
				};
			} catch (error) {
				return {
					content: [{
						type: "text",
						text: `Error calling performance webhook: ${error instanceof Error ? error.message : String(error)}`
					}]
				};
			}
		}
	);
} 