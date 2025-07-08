import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Register the weekly performance report tool - generates comprehensive business intelligence
 */
export function registerWeeklyReportTool(server: McpServer) {
	server.tool(
		"weekly_performance_report",
		{
			date_range: z.enum(["7d", "14d", "30d"]).default("7d").describe(
				"Time period for analysis. Use '7d' for weekly reports, '14d' for bi-weekly, '30d' for monthly. Default: 7d"
			),
			platforms: z.array(z.enum(["Meta", "Google", "Bing"])).default(["Meta", "Google", "Bing"]).describe(
				"Platforms to include in analysis. Default includes all platforms. Common: ['Meta', 'Google'] for paid social + search"
			),
			countries: z.array(z.string()).default(["US", "AU", "UK"]).describe(
				"Countries to analyze. Default: ['US', 'AU', 'UK']. Use ['US'] for US-only analysis, ['AU'] for Australia-only, etc."
			),
		},
		async ({ date_range, platforms, countries }) => {
			try {
				// Build comprehensive BI query with parameters
				const query = `
-- Weekly Business Intelligence Report
-- Aggregated insights to avoid context overload
-- Focus: Platform overview, regional shifts, top issues/opportunities

WITH 
config AS (
  SELECT
    ${date_range === "7d" ? "7" : date_range === "14d" ? "14" : "30"} as analysis_days,
    ${JSON.stringify(platforms)} as target_platforms,
    ${JSON.stringify(countries)} as target_countries,
    -- Thresholds for significance
    500 as min_spend_threshold,
    5 as min_conversions_threshold,
    0.25 as significant_change_threshold,
    -- Platform targets (AUD)
    50.0 as meta_target_cpa,
    25.0 as google_target_cpa,
    25.0 as bing_target_cpa
),

base_data AS (
  SELECT
    platform, country, campaign_objective,
    SUM(spend) as total_spend,
    SUM(conversions) as total_conversions,
    SAFE_DIVIDE(SUM(spend), NULLIF(SUM(conversions), 0)) as blended_cpa,
    COUNT(DISTINCT campaign_id) as campaign_count
  FROM \`exemplary-terra-463404-m1.linktree_analytics.blended_summary\`
  WHERE 
    date >= DATE_SUB(CURRENT_DATE(), INTERVAL (SELECT analysis_days FROM config) DAY)
    AND platform IN UNNEST((SELECT target_platforms FROM config))
    AND country IN UNNEST((SELECT target_countries FROM config))
    AND spend > 0
  GROUP BY platform, country, campaign_objective
  HAVING 
    total_spend >= (SELECT min_spend_threshold FROM config)
    AND total_conversions >= (SELECT min_conversions_threshold FROM config)
),

platform_summary AS (
  SELECT
    platform,
    CASE platform 
      WHEN 'Meta' THEN (SELECT meta_target_cpa FROM config)
      WHEN 'Google' THEN (SELECT google_target_cpa FROM config) 
      WHEN 'Bing' THEN (SELECT bing_target_cpa FROM config)
    END as target_cpa,
    SUM(total_spend) as platform_spend,
    SUM(total_conversions) as platform_conversions,
    SAFE_DIVIDE(SUM(total_spend), NULLIF(SUM(total_conversions), 0)) as platform_cpa,
    SUM(campaign_count) as total_campaigns
  FROM base_data
  GROUP BY platform
),

regional_summary AS (
  SELECT
    country,
    SUM(total_spend) as country_spend,
    SUM(total_conversions) as country_conversions,
    SAFE_DIVIDE(SUM(total_spend), NULLIF(SUM(total_conversions), 0)) as country_cpa,
    COUNT(DISTINCT platform) as active_platforms
  FROM base_data
  GROUP BY country
),

performance_issues AS (
  SELECT
    'OVER_TARGET' as issue_type,
    CONCAT(platform, ' - ', country) as description,
    blended_cpa as current_value,
    CASE platform 
      WHEN 'Meta' THEN (SELECT meta_target_cpa FROM config)
      WHEN 'Google' THEN (SELECT google_target_cpa FROM config) 
      WHEN 'Bing' THEN (SELECT bing_target_cpa FROM config)
    END as target_value,
    total_spend as financial_impact
  FROM base_data bd
  WHERE blended_cpa > CASE platform 
    WHEN 'Meta' THEN (SELECT meta_target_cpa FROM config) * 1.2
    WHEN 'Google' THEN (SELECT google_target_cpa FROM config) * 1.2 
    WHEN 'Bing' THEN (SELECT bing_target_cpa FROM config) * 1.2
  END
  ORDER BY total_spend DESC
  LIMIT 5
),

opportunities AS (
  SELECT
    'STRONG_PERFORMER' as opportunity_type,
    CONCAT(platform, ' - ', country, ' - ', campaign_objective) as description,
    blended_cpa as current_value,
    CASE platform 
      WHEN 'Meta' THEN (SELECT meta_target_cpa FROM config)
      WHEN 'Google' THEN (SELECT google_target_cpa FROM config) 
      WHEN 'Bing' THEN (SELECT bing_target_cpa FROM config)
    END as target_value,
    total_spend as current_spend,
    -- Scale potential calculation
    CASE 
      WHEN total_spend < 500 THEN total_spend * 1.0
      WHEN total_spend < 1500 THEN total_spend * 0.5
      ELSE total_spend * 0.2
    END as scale_potential
  FROM base_data bd
  WHERE blended_cpa <= CASE platform 
    WHEN 'Meta' THEN (SELECT meta_target_cpa FROM config) * 0.8
    WHEN 'Google' THEN (SELECT google_target_cpa FROM config) * 0.8 
    WHEN 'Bing' THEN (SELECT bing_target_cpa FROM config) * 0.8
  END
  ORDER BY scale_potential DESC
  LIMIT 5
)

-- Output summarized results
SELECT 
  'PLATFORM_OVERVIEW' as section,
  JSON_OBJECT(
    'analysis_period', CONCAT((SELECT analysis_days FROM config), ' days'),
    'platforms_analyzed', (SELECT target_platforms FROM config),
    'countries_analyzed', (SELECT target_countries FROM config),
    'platform_performance', ARRAY_AGG(JSON_OBJECT(
      'platform', platform,
      'spend', ROUND(platform_spend, 2),
      'conversions', platform_conversions,
      'cpa', ROUND(platform_cpa, 2),
      'target_cpa', target_cpa,
      'vs_target', ROUND((platform_cpa - target_cpa) / target_cpa * 100, 1),
      'campaigns', total_campaigns
    ))
  ) as summary_data
FROM platform_summary

UNION ALL

SELECT 
  'REGIONAL_OVERVIEW' as section,
  JSON_OBJECT(
    'regional_performance', ARRAY_AGG(JSON_OBJECT(
      'country', country,
      'spend', ROUND(country_spend, 2),
      'conversions', country_conversions,
      'cpa', ROUND(country_cpa, 2),
      'active_platforms', active_platforms
    ))
  ) as summary_data
FROM regional_summary

UNION ALL

SELECT 
  'TOP_ISSUES' as section,
  JSON_OBJECT(
    'performance_issues', ARRAY_AGG(JSON_OBJECT(
      'type', issue_type,
      'description', description,
      'current_cpa', ROUND(current_value, 2),
      'target_cpa', target_value,
      'overspend_impact', ROUND(financial_impact, 2)
    ))
  ) as summary_data
FROM performance_issues

UNION ALL

SELECT 
  'SCALE_OPPORTUNITIES' as section,
  JSON_OBJECT(
    'opportunities', ARRAY_AGG(JSON_OBJECT(
      'type', opportunity_type,
      'description', description,
      'current_cpa', ROUND(current_value, 2),
      'target_cpa', target_value,
      'current_spend', ROUND(current_spend, 2),
      'additional_spend_potential', ROUND(scale_potential, 2)
    ))
  ) as summary_data
FROM opportunities

ORDER BY section;
`;

				const webhookUrl = "https://n8n.wibci.dev/webhook/40df3a90-da64-4939-8813-839f12a43cee";
				
				const response = await fetch(webhookUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"User-Agent": "MCP-Weekly-Report-Tool/1.0",
					},
					body: JSON.stringify({
						query: query
					}),
				});

				if (!response.ok) {
					return {
						content: [{
							type: "text",
							text: `Error: Failed to execute weekly report. Status: ${response.status} ${response.statusText}`
						}]
					};
				}

				const data = await response.text();
				
				return {
					content: [{
						type: "text",
						text: `Weekly Performance Report (${date_range} analysis)\nPlatforms: ${platforms.join(', ')}\nCountries: ${countries.join(', ')}\n\nResults:\n${data}`
					}]
				};
			} catch (error) {
				return {
					content: [{
						type: "text",
						text: `Error generating weekly report: ${error instanceof Error ? error.message : String(error)}`
					}]
				};
			}
		}
	);
} 