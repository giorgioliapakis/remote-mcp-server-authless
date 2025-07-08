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
Your response must ONLY be the bigquery query.

YOU MUST DO AS MUCH PROCESSING VIA BIGQUERY AS YOU CAN!
We can't afford to return MASSIVE amounts of data, so let this be handled in your BigQuery queries.

YOU MUST ONLY EVER QUERY THIS TABLE:
exemplary-terra-463404-m1.linktree_analytics.blended_summary

Here is the schema for reference:

account_name: STRING
datasource: STRING
source: STRING
date: DATE
campaign: STRING
campaign_id: STRING
adset_name: STRING
adset_id: STRING
ad_name: STRING
ad_id: STRING
ad_group_name: STRING
ad_group_id: STRING
impressions: BIGNUMERIC
clicks: BIGNUMERIC
spend: BIGNUMERIC
conversions: BIGNUMERIC
preview_url: STRING
country: STRING
campaign_objective: STRING
funnel_stage: STRING
targeting_type: STRING
product_focus: STRING
platform: STRING
ctr_percent: BIGNUMERIC
cpc: BIGNUMERIC
conversion_rate_percent: BIGNUMERIC
cpa: BIGNUMERIC

When providing analyses on performance or data, do not provide surface level or obvious insights. Things like "run more AB tests" or "optimise your strategy" are not helpful. Go deeper, but ensure the insights are backed by data. Perform calculations for key metrics if it helps your narrative.

Your response must ONLY be the bigquery query.


EXAMPLE QUERY:
SELECT date, SUM(impressions) as total_impressions, SUM(clicks) as total_clicks, SUM(spend) as total_spend 
FROM exemplary-terra-463404-m1.linktree_analytics.blended_summary 
WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY) 
GROUP BY date ORDER BY date DESC

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