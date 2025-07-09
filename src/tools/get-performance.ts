import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BLENDED_SUMMARY_TABLE, validateAndCleanSqlQuery } from "./sql-utils";

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
- Queries must ONLY access: ${BLENDED_SUMMARY_TABLE}
- No DDL operations (CREATE, DROP, ALTER, etc.)
- No DML operations (INSERT, UPDATE, DELETE)
- Use LIMIT clauses to prevent resource exhaustion
- Avoid user-provided string literals in WHERE clauses

⚠️ COMMON BIGQUERY ERRORS TO AVOID:
- Aggregations of aggregations: DON'T use MAX(SUM(...)) or similar nested aggregates
- Window functions in aggregates: DON'T use SUM(RANK() OVER(...))
- LIMIT in UNION: DON'T put LIMIT on individual SELECT statements within UNION ALL

✅ SAFE PATTERNS:
- Conditional aggregation: SUM(CASE WHEN platform = 'Google' THEN spend END)
- Safe division: SAFE_DIVIDE(SUM(spend), SUM(conversions))
- Platform pivots: Use conditional SUM instead of MAX(CASE...SUM)

TABLE SCHEMA (${BLENDED_SUMMARY_TABLE}):
account_name: STRING, datasource: STRING, source: STRING, date: DATE, 
campaign: STRING, campaign_id: STRING, adset_name: STRING, adset_id: STRING, 
ad_name: STRING, ad_id: STRING, ad_group_name: STRING, ad_group_id: STRING, 
impressions: BIGNUMERIC, clicks: BIGNUMERIC, spend: BIGNUMERIC, 
conversions: BIGNUMERIC, preview_url: STRING, country: STRING, 
campaign_objective: STRING, funnel_stage: STRING, targeting_type: STRING, 
product_focus: STRING, platform: STRING, ctr_percent: BIGNUMERIC, 
cpc: BIGNUMERIC, conversion_rate_percent: BIGNUMERIC, cpa: BIGNUMERIC

EXAMPLE SAFE QUERIES:
-- Time-based analysis
SELECT DATE_TRUNC(date, WEEK) as week, platform, SUM(spend) as weekly_spend
FROM ${BLENDED_SUMMARY_TABLE}
WHERE date >= '2024-01-01' AND date <= '2024-03-31'
GROUP BY week, platform ORDER BY week LIMIT 20;

-- Platform comparison
SELECT platform, AVG(cpa) as avg_cpa, SUM(conversions) as total_conversions
FROM ${BLENDED_SUMMARY_TABLE} 
WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
GROUP BY platform ORDER BY avg_cpa LIMIT 10;

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
				
				// Validate table reference - check that query only references authorized table
				const authorizedTable1 = 'exemplary-terra-463404-m1.linktree_analytics.blended_summary';
				const authorizedTable2 = '`exemplary-terra-463404-m1.linktree_analytics.blended_summary`';
				
				// Extract all table references (looking for database.schema.table patterns)
				const tableReferences = cleanQuery.match(/(?:`[^`]+`\.`[^`]+`\.`[^`]+`|[\w-]+\.[\w-]+\.[\w-]+)/gi) || [];
				const unauthorizedTables = tableReferences.filter(table => 
					!table.includes('exemplary-terra-463404-m1.linktree_analytics.blended_summary')
				);
				
				if (unauthorizedTables.length > 0) {
					return {
						content: [{
							type: "text",
							text: `Security Error: Only the specified analytics table is allowed\n\nUnauthorized tables detected: ${unauthorizedTables.join(', ')}\nQuery rejected for security reasons. Please use the specialized template tools or modify your query to comply with security requirements.`
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
				if (!cleanQuery.includes(authorizedTable1) && !cleanQuery.includes(authorizedTable2)) {
					return {
						content: [{
							type: "text",
							text: `Table Reference Error: Query must reference the authorized table: ${BLENDED_SUMMARY_TABLE}\n\nPlease update your query to use the correct table reference.`
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