import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAddTool } from "./add";
import { registerCalculatorTool } from "./calculator";
import { registerWeeklyReportTool } from "./weekly-report";
import { registerCampaignAnalysisTool } from "./campaign-analysis";
import { registerCreativeAnalysisTool } from "./creative-analysis";
import { registerRegionalComparisonTool } from "./regional-comparison";
import { registerFlexibleQueryTool } from "./get-performance";

// Export individual tool registration functions
export { registerAddTool } from "./add";
export { registerCalculatorTool } from "./calculator";
export { registerWeeklyReportTool } from "./weekly-report";
export { registerCampaignAnalysisTool } from "./campaign-analysis";
export { registerCreativeAnalysisTool } from "./creative-analysis";
export { registerRegionalComparisonTool } from "./regional-comparison";
export { registerFlexibleQueryTool } from "./get-performance";

/**
 * Register all tools with the server
 */
export function registerAllTools(server: McpServer) {
	// Basic utility tools
	registerAddTool(server);
	registerCalculatorTool(server);
	
	// Analytics template tools (prioritized by LLM)
	registerWeeklyReportTool(server);
	registerCampaignAnalysisTool(server);
	registerCreativeAnalysisTool(server);
	registerRegionalComparisonTool(server);
	
	// Flexible fallback tool
	registerFlexibleQueryTool(server);
} 