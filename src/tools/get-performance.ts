import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BLENDED_SUMMARY_TABLE, IMPRESSION_SHARE_TABLE, validateAndCleanSqlQuery } from "./sql-utils";

/**
 * Register the flexible query tool - fallback for custom analysis not covered by templates
 */
export function registerFlexibleQueryTool(server: McpServer) {
	server.tool(
		"flexible_query",
		{
			query: z.string().describe(`
FLEXIBLE BIGQUERY ANALYSIS (Use as Fallback Only):

⚠️ CRITICAL SECURITY NOTICE:
- This tool accepts raw SQL queries and should be used with extreme caution
- Only use when specialized templates cannot handle the request
- AI should validate queries before sending to prevent SQL injection

⚠️ WHEN TO USE THIS TOOL (Fallback only):
Only use when user requests don't fit these specialized templates:
- weekly_performance_report: Business intelligence overviews, platform summaries
- campaign_analysis: Specific campaign deep dives with comparisons  
- creative_analysis: Meta creative performance and concept analysis
- regional_comparison: Country/platform performance comparisons

VALID USE CASES:
- Custom date ranges (e.g., "performance for Q4 2023")
- Unique analysis requests (e.g., "hourly performance patterns")
- Specific metrics combinations not in templates
- Ad-hoc exploratory queries for data discovery

SECURITY REQUIREMENTS:
- Queries must ONLY access: ${BLENDED_SUMMARY_TABLE} OR ${IMPRESSION_SHARE_TABLE}
- No DDL operations (CREATE, DROP, ALTER, etc.)
- No DML operations (INSERT, UPDATE, DELETE)
- Use LIMIT clauses to prevent resource exhaustion
- Avoid user-provided string literals in WHERE clauses
- NO JOINS between tables - analyze each table separately

⚠️ COMMON BIGQUERY ERRORS TO AVOID:
- Aggregations of aggregations: DON'T use MAX(SUM(...)) or similar nested aggregates
- Window functions in aggregates: DON'T use SUM(RANK() OVER(...))
- LIMIT in UNION: DON'T put LIMIT on individual SELECT statements within UNION ALL

✅ SAFE PATTERNS:
- Conditional aggregation: SUM(CASE WHEN platform = 'Google' THEN spend END)
- Safe division: SAFE_DIVIDE(SUM(spend), SUM(conversions))
- Platform pivots: Use conditional SUM instead of MAX(CASE...SUM)

AVAILABLE TABLES & SCHEMAS:

1. PERFORMANCE DATA (${BLENDED_SUMMARY_TABLE}):
account_name: STRING, datasource: STRING, source: STRING, date: DATE, 
campaign: STRING, campaign_id: STRING, adset_name: STRING, adset_id: STRING, 
ad_name: STRING, ad_id: STRING, ad_group_name: STRING, ad_group_id: STRING, 
impressions: BIGNUMERIC, clicks: BIGNUMERIC, spend: BIGNUMERIC, 
conversions: BIGNUMERIC, preview_url: STRING, country: STRING, 
campaign_objective: STRING, funnel_stage: STRING, targeting_type: STRING, 
product_focus: STRING, platform: STRING, ctr_percent: BIGNUMERIC, 
cpc: BIGNUMERIC, conversion_rate_percent: BIGNUMERIC, cpa: BIGNUMERIC

2. IMPRESSION SHARE DATA (${IMPRESSION_SHARE_TABLE}):
date: DATE, account_name: STRING, campaign: STRING, campaign_type: STRING, 
region: STRING, campaign_category: STRING, funnel_stage: STRING, 
clicks: NUMERIC, spend: NUMERIC, conversions: NUMERIC, budget_amount: NUMERIC,
search_impression_share_pct: NUMERIC, search_top_impression_share_pct: NUMERIC,
search_absolute_top_impression_share_pct: NUMERIC, budget_lost_impression_share_pct: NUMERIC,
rank_lost_impression_share_pct: NUMERIC, budget_lost_top_impression_share_pct: NUMERIC,
rank_lost_top_impression_share_pct: NUMERIC, budget_lost_absolute_top_impression_share_pct: NUMERIC,
rank_lost_absolute_top_impression_share_pct: NUMERIC, market_size_impressions: NUMERIC,
search_click_share_pct: NUMERIC, content_impression_share_pct: NUMERIC,
content_market_size_impressions: NUMERIC, avg_cpc: NUMERIC, conversion_rate_pct: NUMERIC,
cost_per_conversion: NUMERIC, budget_utilization_pct: NUMERIC, total_lost_impression_share_pct: NUMERIC,
actual_impressions: NUMERIC, budget_lost_impressions: NUMERIC, rank_lost_impressions: NUMERIC,
market_position: STRING, performance_diagnosis: STRING, is_brand_campaign: BOOLEAN,
prev_week_impression_share: NUMERIC, wow_impression_share_change: NUMERIC,
estimated_budget_needed_for_lost_impressions: NUMERIC, estimated_clicks_from_rank_improvement: NUMERIC

EXAMPLE SAFE QUERIES:

-- Performance table: Time-based analysis
SELECT DATE_TRUNC(date, WEEK) as week, platform, SUM(spend) as weekly_spend
FROM ${BLENDED_SUMMARY_TABLE}
WHERE date >= '2024-01-01' AND date <= '2024-03-31'
GROUP BY week, platform ORDER BY week LIMIT 20;

-- Performance table: Platform comparison
SELECT platform, AVG(cpa) as avg_cpa, SUM(conversions) as total_conversions
FROM ${BLENDED_SUMMARY_TABLE} 
WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
GROUP BY platform ORDER BY avg_cpa LIMIT 10;

-- Impression share table: Search visibility analysis
SELECT region, campaign_type, AVG(search_impression_share_pct) as avg_impression_share,
       AVG(budget_lost_impression_share_pct) as avg_budget_lost
FROM ${IMPRESSION_SHARE_TABLE}
WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 14 DAY)
GROUP BY region, campaign_type ORDER BY avg_impression_share DESC LIMIT 15;

-- Impression share table: Opportunity identification
SELECT campaign, region, budget_utilization_pct, budget_lost_impression_share_pct,
       rank_lost_impression_share_pct, estimated_budget_needed_for_lost_impressions
FROM ${IMPRESSION_SHARE_TABLE}
WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY) 
  AND budget_lost_impression_share_pct > 20
ORDER BY estimated_budget_needed_for_lost_impressions DESC LIMIT 10;

CONTEXT:
- Current date: ${new Date().toISOString().split('T')[0]}
- Timezone: Melbourne (AEDT/AEST)
- Use date literals in 'YYYY-MM-DD' format for safety
			`),
		},
		async ({ query }: { query: string }) => {
			try {
				// Validate and clean the query input
				let cleanQuery: string;
				try {
					cleanQuery = validateAndCleanSqlQuery(query);
				} catch (validationError) {
					return {
						content: [{
							type: "text",
							text: `Input Validation Error: ${validationError instanceof Error ? validationError.message : String(validationError)}\n\nPlease ensure your query follows proper SQL syntax and security guidelines.`
						}]
					};
				}
				
				// Basic security validation
				const securityChecks = [
					{
						test: /\b(DROP|CREATE|ALTER|INSERT|UPDATE|DELETE|TRUNCATE)\b/i,
						message: "DDL/DML operations are not allowed"
					},
					{
						test: /\b(INFORMATION_SCHEMA|mysql|pg_|sys\.)\b/i,
						message: "System schema access is not allowed"
					},
					{
						test: /\b(LOAD|OUTFILE|DUMPFILE|EXPORT)\b/i,
						message: "File operations are not allowed"
					}
				];
				
				// Run security checks
				for (const check of securityChecks) {
					if (check.test.test(cleanQuery)) {
						return {
							content: [{
								type: "text",
								text: `Security Error: ${check.message}\n\nQuery rejected for security reasons. Please use the specialized template tools or modify your query to comply with security requirements.`
							}]
						};
					}
				}
				
				// Validate table reference - check that query only references authorized tables
				const authorizedTables = [
					'exemplary-terra-463404-m1.linktree_analytics.blended_summary',
					'`exemplary-terra-463404-m1.linktree_analytics.blended_summary`',
					'exemplary-terra-463404-m1.linktree_analytics.impression_share_report',
					'`exemplary-terra-463404-m1.linktree_analytics.impression_share_report`'
				];
				
				// Extract all table references (looking for database.schema.table patterns)
				const tableReferences = cleanQuery.match(/(?:`[^`]+`\.`[^`]+`\.`[^`]+`|[\w-]+\.[\w-]+\.[\w-]+)/gi) || [];
				const unauthorizedTables = tableReferences.filter(table => 
					!authorizedTables.some(authTable => table.includes(authTable.replace(/`/g, '')))
				);
				
				if (unauthorizedTables.length > 0) {
					return {
						content: [{
							type: "text",
							text: `Security Error: Only the specified analytics tables are allowed\n\nUnauthorized tables detected: ${unauthorizedTables.join(', ')}\nAllowed tables: ${BLENDED_SUMMARY_TABLE}, ${IMPRESSION_SHARE_TABLE}\nQuery rejected for security reasons. Please use the specialized template tools or modify your query to comply with security requirements.`
						}]
					};
				}
				
				// Check for JOIN operations between tables (not allowed)
				const hasJoin = /\bJOIN\b/i.test(cleanQuery);
				if (hasJoin && tableReferences.length > 1) {
					return {
						content: [{
							type: "text",
							text: `Security Error: JOINs between different tables are not allowed\n\nAnalyze each table separately using the specialized tools instead. Query rejected for security reasons.`
						}]
					};
				}
				
				// Check for LIMIT clause to prevent resource exhaustion - improved regex
				const hasLimit = /\bLIMIT\s+\d+\b/i.test(cleanQuery);
				const hasCount = /\bCOUNT\s*\(\s*[*\w]+\s*\)/i.test(cleanQuery);
				const hasAggregation = /\b(SUM|AVG|MAX|MIN|COUNT)\s*\(/i.test(cleanQuery);
				
				if (!hasLimit && !hasCount && !hasAggregation) {
					return {
						content: [{
							type: "text",
							text: `Query Validation Error: Queries must include a LIMIT clause to prevent resource exhaustion.\n\nExample: Add 'LIMIT 100' to your query, or use COUNT(*) for aggregations.`
						}]
					};
				}
				
				// Validate table reference exists in query
				const hasValidTable = authorizedTables.some(table => cleanQuery.includes(table));
				if (!hasValidTable) {
					return {
						content: [{
							type: "text",
							text: `Table Reference Error: Query must reference one of the authorized tables: ${BLENDED_SUMMARY_TABLE} or ${IMPRESSION_SHARE_TABLE}\n\nPlease update your query to use the correct table reference.`
						}]
					};
				}
				
				const webhookUrl = "https://n8n.wibci.dev/webhook/40df3a90-da64-4939-8813-839f12a43cee";
				
				const response = await fetch(webhookUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"User-Agent": "MCP-Flexible-Query-Tool/1.0",
						"X-Query-Length": cleanQuery.length.toString(),
					},
					body: JSON.stringify({
						query: cleanQuery,
						timestamp: new Date().toISOString(),
						validation_passed: true
					}),
				});

				if (!response.ok) {
					return {
						content: [{
							type: "text",
							text: `Error: Failed to execute flexible query. Status: ${response.status} ${response.statusText}\n\nThis may indicate an issue with the query syntax or the analytics service. Please check your SQL syntax and try again.`
						}]
					};
				}

				const data = await response.text();
				
				return {
					content: [{
						type: "text",
						text: `Flexible Query Results\nQuery validation: Passed\nQuery length: ${cleanQuery.length} characters\n\n--- QUERY ---\n${cleanQuery.substring(0, 500)}${cleanQuery.length > 500 ? '...' : ''}\n\n--- RESULTS ---\n${data}`
					}]
				};
			} catch (error) {
				return {
					content: [{
						type: "text",
						text: `Error executing flexible query: ${error instanceof Error ? error.message : String(error)}\n\nPlease check your query syntax and ensure it follows the security guidelines. Consider using one of the specialized template tools instead.`
					}]
				};
			}
		}
	);
} 