import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAddTool } from "./add";
import { registerCalculatorTool } from "./calculator";
import { registerGetPerformanceTool } from "./get-performance";

// Export individual tool registration functions
export { registerAddTool } from "./add";
export { registerCalculatorTool } from "./calculator";
export { registerGetPerformanceTool } from "./get-performance";

/**
 * Register all tools with the server
 */
export function registerAllTools(server: McpServer) {
	registerAddTool(server);
	registerCalculatorTool(server);
	registerGetPerformanceTool(server);
} 