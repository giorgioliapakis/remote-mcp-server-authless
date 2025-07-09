import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWeeklyReportTool } from "./weekly-report";
import { registerCampaignAnalysisTool } from "./campaign-analysis";
import { registerCreativeAnalysisTool } from "./creative-analysis";
import { registerRegionalComparisonTool } from "./regional-comparison";
import { registerFlexibleQueryTool } from "./get-performance";
import { registerAnomalyDetectionTool } from "./anomaly-detection";

// Export individual tool registration functions
export { registerWeeklyReportTool } from "./weekly-report";
export { registerCampaignAnalysisTool } from "./campaign-analysis";
export { registerCreativeAnalysisTool } from "./creative-analysis";
export { registerRegionalComparisonTool } from "./regional-comparison";
export { registerFlexibleQueryTool } from "./get-performance";
export { registerAnomalyDetectionTool } from "./anomaly-detection";

// Export SQL utilities for direct use if needed
export * from "./sql-utils";

/**
 * Register all tools with the server
 */
export function registerAllTools(server: McpServer) {
	// Analytics template tools (prioritized by LLM) - now with centralized settings
	registerWeeklyReportTool(server);
	registerCampaignAnalysisTool(server);
	registerCreativeAnalysisTool(server);
	registerRegionalComparisonTool(server);
	registerAnomalyDetectionTool(server);
	
	// Flexible fallback tool
	registerFlexibleQueryTool(server);
} 