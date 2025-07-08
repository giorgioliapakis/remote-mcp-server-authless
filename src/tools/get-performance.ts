import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Register the flexible query tool - fallback for custom analysis not covered by templates
 */
export function registerFlexibleQueryTool(server: McpServer) {
	server.tool(
		"flexible_query",
		{
			query: z.string().describe(`
FLEXIBLE BIGQUERY ANALYSIS (Use as Fallback):

⚠️ IMPORTANT: Only use this tool when user requests don't fit these specialized templates:
- weekly_performance_report: Business intelligence overviews, platform summaries
- campaign_analysis: Specific campaign deep dives with comparisons  
- creative_analysis: Meta creative performance and concept analysis
- regional_comparison: Country/platform performance comparisons

WHEN TO USE THIS TOOL:
- Custom date ranges (e.g., "last 3 months", "Q4 2023")
- Unique analysis requests (e.g., "hourly performance", "weekend vs weekday")
- Specific metrics combinations not in templates
- Ad-hoc exploratory queries

CRITICAL REQUIREMENTS:
- YOUR RESPONSE MUST ONLY BE THE BIGQUERY QUERY
- YOU MUST ONLY EVER QUERY THIS TABLE: exemplary-terra-463404-m1.linktree_analytics.blended_summary
- LIMIT RESULTS TO AVOID CONTEXT OVERLOAD (use LIMIT 20, aggregation, summarization)
- Focus on actionable insights, not raw data dumps

TABLE SCHEMA:
account_name: STRING, datasource: STRING, source: STRING, date: DATE, campaign: STRING, campaign_id: STRING, 
adset_name: STRING, adset_id: STRING, ad_name: STRING, ad_id: STRING, ad_group_name: STRING, ad_group_id: STRING, 
impressions: BIGNUMERIC, clicks: BIGNUMERIC, spend: BIGNUMERIC, conversions: BIGNUMERIC, preview_url: STRING, 
country: STRING, campaign_objective: STRING, funnel_stage: STRING, targeting_type: STRING, product_focus: STRING, 
platform: STRING, ctr_percent: BIGNUMERIC, cpc: BIGNUMERIC, conversion_rate_percent: BIGNUMERIC, cpa: BIGNUMERIC

EXAMPLE CUSTOM QUERIES:
- Time-of-day performance patterns
- Specific campaign objective analysis
- Custom attribution windows  
- Seasonal trends (Christmas, Black Friday)

CONTEXT:
- Current date: ${new Date().toISOString().split('T')[0]}
- User timezone: Melbourne
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