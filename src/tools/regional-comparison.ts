import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Register the regional comparison tool - compare performance across regions/countries
 */
export function registerRegionalComparisonTool(server: McpServer) {
	server.tool(
		"regional_comparison",
		{
			platforms: z.array(z.enum(["Meta", "Google", "Bing"])).default(["Meta", "Google"]).describe(
				"Platforms to compare across regions. Use ['Meta'] for social focus, ['Google', 'Bing'] for search focus"
			),
			comparison_type: z.enum(["country", "platform_by_country"]).default("country").describe(
				"Comparison type: 'country' for overall regional performance, 'platform_by_country' for platform performance per region"
			),
			date_range: z.enum(["7d", "14d", "30d"]).default("14d").describe(
				"Analysis period for regional comparison. Use '14d' for balanced view, '7d' for recent trends"
			),
			include_trends: z.boolean().default(true).describe(
				"Include week-over-week trend analysis. Set false for simpler comparison"
			),
		},
		async ({ platforms, comparison_type, date_range, include_trends }) => {
			try {
				const query = `
-- Regional Performance Comparison
-- Summarized regional insights with trend analysis
-- Limited results to avoid context overload

WITH 
config AS (
  SELECT
    ${JSON.stringify(platforms)} as target_platforms,
    '${comparison_type}' as comparison_mode,
    ${date_range === "7d" ? "7" : date_range === "14d" ? "14" : "30"} as analysis_days,
    ${include_trends} as include_trend_analysis
),

current_period AS (
  SELECT
    bd.platform,
    bd.country,
    bd.campaign_objective,
    SUM(bd.spend) as spend_current,
    SUM(bd.conversions) as conversions_current,
    SAFE_DIVIDE(SUM(bd.spend), NULLIF(SUM(bd.conversions), 0)) as cpa_current,
    SAFE_DIVIDE(SUM(bd.clicks), NULLIF(SUM(bd.impressions), 0)) * 100 as ctr_current,
    COUNT(DISTINCT bd.campaign_id) as campaign_count_current
  FROM \`exemplary-terra-463404-m1.linktree_analytics.blended_summary\` bd
  WHERE 
    bd.date >= DATE_SUB(CURRENT_DATE(), INTERVAL (SELECT analysis_days FROM config) DAY)
    AND bd.platform IN UNNEST((SELECT target_platforms FROM config))
    AND bd.spend > 0
  GROUP BY bd.platform, bd.country, bd.campaign_objective
),

previous_period AS (
  SELECT
    bd.platform,
    bd.country,
    bd.campaign_objective,
    SUM(bd.spend) as spend_previous,
    SUM(bd.conversions) as conversions_previous,
    SAFE_DIVIDE(SUM(bd.spend), NULLIF(SUM(bd.conversions), 0)) as cpa_previous
  FROM \`exemplary-terra-463404-m1.linktree_analytics.blended_summary\` bd
  WHERE 
    bd.date >= DATE_SUB(CURRENT_DATE(), INTERVAL (SELECT analysis_days FROM config) * 2 DAY)
    AND bd.date < DATE_SUB(CURRENT_DATE(), INTERVAL (SELECT analysis_days FROM config) DAY)
    AND bd.platform IN UNNEST((SELECT target_platforms FROM config))
    AND bd.spend > 0
  GROUP BY bd.platform, bd.country, bd.campaign_objective
),

regional_performance AS (
  SELECT
    cp.platform,
    cp.country,
    cp.campaign_objective,
    cp.spend_current,
    cp.conversions_current,
    cp.cpa_current,
    cp.ctr_current,
    cp.campaign_count_current,
    pp.spend_previous,
    pp.conversions_previous,
    pp.cpa_previous,
    -- Calculate trends
    CASE 
      WHEN (SELECT include_trend_analysis FROM config) AND pp.cpa_previous IS NOT NULL AND pp.cpa_previous > 0 THEN
        ROUND((cp.cpa_current - pp.cpa_previous) / pp.cpa_previous * 100, 1)
      ELSE NULL
    END as cpa_change_pct,
    -- Performance classification
    CASE
      WHEN cp.cpa_current <= 25 THEN 'EXCELLENT'
      WHEN cp.cpa_current <= 40 THEN 'GOOD' 
      WHEN cp.cpa_current <= 60 THEN 'ACCEPTABLE'
      ELSE 'NEEDS_ATTENTION'
    END as performance_rating
  FROM current_period cp
  LEFT JOIN previous_period pp 
    ON cp.platform = pp.platform 
    AND cp.country = pp.country 
    AND cp.campaign_objective = pp.campaign_objective
  WHERE cp.spend_current >= 500  -- Minimum threshold for meaningful comparison
),

country_summary AS (
  SELECT
    country,
    SUM(spend_current) as total_spend,
    SUM(conversions_current) as total_conversions,
    SAFE_DIVIDE(SUM(spend_current), NULLIF(SUM(conversions_current), 0)) as blended_cpa,
    AVG(ctr_current) as avg_ctr,
    SUM(campaign_count_current) as total_campaigns,
    COUNT(DISTINCT platform) as active_platforms,
    AVG(cpa_change_pct) as avg_cpa_change,
    -- Count performance ratings
    COUNT(CASE WHEN performance_rating IN ('EXCELLENT', 'GOOD') THEN 1 END) as strong_segments,
    COUNT(CASE WHEN performance_rating = 'NEEDS_ATTENTION' THEN 1 END) as weak_segments
  FROM regional_performance
  GROUP BY country
  HAVING total_spend >= 1000  -- Country-level minimum
),

platform_country_summary AS (
  SELECT
    platform,
    country,
    SUM(spend_current) as platform_country_spend,
    SUM(conversions_current) as platform_country_conversions,
    SAFE_DIVIDE(SUM(spend_current), NULLIF(SUM(conversions_current), 0)) as platform_country_cpa,
    AVG(ctr_current) as platform_country_ctr,
    AVG(cpa_change_pct) as platform_country_change,
    COUNT(*) as segment_count
  FROM regional_performance
  GROUP BY platform, country
  HAVING platform_country_spend >= 500
)

-- Output based on comparison type
SELECT 
  'COUNTRY_COMPARISON' as section,
  JSON_OBJECT(
    'analysis_type', (SELECT comparison_mode FROM config),
    'platforms_analyzed', (SELECT target_platforms FROM config),
    'period', CONCAT((SELECT analysis_days FROM config), ' days'),
    'trend_analysis_included', (SELECT include_trend_analysis FROM config),
    'country_performance', ARRAY_AGG(JSON_OBJECT(
      'country', country,
      'total_spend', ROUND(total_spend, 2),
      'total_conversions', total_conversions,
      'blended_cpa', ROUND(blended_cpa, 2),
      'avg_ctr', ROUND(avg_ctr, 2),
      'total_campaigns', total_campaigns,
      'active_platforms', active_platforms,
      'avg_cpa_change_pct', ROUND(COALESCE(avg_cpa_change, 0), 1),
      'strong_segments', strong_segments,
      'weak_segments', weak_segments,
      'efficiency_rank', ROW_NUMBER() OVER (ORDER BY blended_cpa ASC)
    ) ORDER BY total_spend DESC)
  ) as summary_data
FROM country_summary
WHERE '${comparison_type}' = 'country'

UNION ALL

SELECT 
  'PLATFORM_BY_COUNTRY' as section,
  JSON_OBJECT(
    'analysis_note', 'Platform performance breakdown by country',
    'platform_country_matrix', ARRAY_AGG(JSON_OBJECT(
      'platform', platform,
      'country', country,
      'spend', ROUND(platform_country_spend, 2),
      'conversions', platform_country_conversions,
      'cpa', ROUND(platform_country_cpa, 2),
      'ctr', ROUND(platform_country_ctr, 2),
      'cpa_change_pct', ROUND(COALESCE(platform_country_change, 0), 1),
      'segments_analyzed', segment_count
    ) ORDER BY platform, platform_country_cpa ASC)
  ) as summary_data
FROM platform_country_summary
WHERE '${comparison_type}' = 'platform_by_country'

UNION ALL

SELECT 
  'REGIONAL_INSIGHTS' as section,
  JSON_OBJECT(
    'key_findings', JSON_OBJECT(
      'best_performing_country', (SELECT country FROM country_summary ORDER BY blended_cpa ASC LIMIT 1),
      'highest_spend_country', (SELECT country FROM country_summary ORDER BY total_spend DESC LIMIT 1),
      'most_improved', CASE 
        WHEN (SELECT include_trend_analysis FROM config) THEN
          (SELECT country FROM country_summary WHERE avg_cpa_change IS NOT NULL ORDER BY avg_cpa_change ASC LIMIT 1)
        ELSE 'Trend analysis disabled'
      END,
      'needs_attention', ARRAY_AGG(
        CASE WHEN weak_segments >= 2 THEN country ELSE NULL END IGNORE NULLS
      )
    )
  ) as summary_data
FROM country_summary

ORDER BY section;
`;

				const webhookUrl = "https://n8n.wibci.dev/webhook-test/40df3a90-da64-4939-8813-839f12a43cee";
				
				const response = await fetch(webhookUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"User-Agent": "MCP-Regional-Comparison-Tool/1.0",
					},
					body: JSON.stringify({
						query: query
					}),
				});

				if (!response.ok) {
					return {
						content: [{
							type: "text",
							text: `Error: Failed to execute regional comparison. Status: ${response.status} ${response.statusText}`
						}]
					};
				}

				const data = await response.text();
				
				return {
					content: [{
						type: "text",
						text: `Regional Comparison Analysis\nPlatforms: ${platforms.join(', ')}\nComparison: ${comparison_type}\nPeriod: ${date_range}\nTrends: ${include_trends ? 'included' : 'excluded'}\n\nResults:\n${data}`
					}]
				};
			} catch (error) {
				return {
					content: [{
						type: "text",
						text: `Error comparing regions: ${error instanceof Error ? error.message : String(error)}`
					}]
				};
			}
		}
	);
} 