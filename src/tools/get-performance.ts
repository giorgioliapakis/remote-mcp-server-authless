import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Register the get performance tool - posts a query to a webhook to run a workflow
 */
export function registerGetPerformanceTool(server: McpServer) {
	server.tool(
		"get_performance",
		{
			title: "Performance Workflow Runner",
			description: "Use this tool to send a query to a performance workflow",
			inputSchema: {
				query: z.string().describe("The query to send to the performance workflow"),
			},
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