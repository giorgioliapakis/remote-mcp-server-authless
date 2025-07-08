import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Register the addition tool
 */
export function registerAddTool(server: McpServer) {
	server.tool(
		"add",
		{ a: z.number(), b: z.number() },
		async ({ a, b }) => ({
			content: [{ type: "text", text: String(a + b) }],
		})
	);
} 