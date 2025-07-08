import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	createInClause,
	getDaysFromRange,
	buildDateFilter,
	buildComparisonDateFilter,
	BLENDED_SUMMARY_TABLE,
	getPerformanceRatingCase,
	safeCpaCalculation,
	safeCtrCalculation,
	safeCvrCalculation,
	validateAndCleanInput
} from "./sql-utils";

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
		async ({ platforms, comparison_type, date_range, include_trends }: {
			platforms: ("Meta" | "Google" | "Bing")[];
			comparison_type: "country" | "platform_by_country";
			date_range: "7d" | "14d" | "30d";
			include_trends: boolean;
		}) => {
			try {
				// Validate and clean inputs
				const cleanPlatforms = validateAndCleanInput(platforms) as string[];
				const analysisDays = getDaysFromRange(date_range);
				
				// Build safe SQL components
				const platformFilter = createInClause(cleanPlatforms, 'platform');
				const currentDateFilter = buildDateFilter(analysisDays);
				const comparisonDateFilter = buildComparisonDateFilter(analysisDays, analysisDays * 2);
				
				const query = `
-- Regional Performance Comparison - FIXED VERSION
-- Eliminates subquery aggregation issues and uses safe parameter handling
-- Focus: Regional insights with optional trend analysis

WITH 
-- Step 1: Current period performance by region/platform
current_period AS (
  SELECT
    platform,
    country,
    campaign_objective,
    SUM(spend) as spend_current,
    SUM(conversions) as conversions_current,
    ${safeCpaCalculation('SUM(spend)', 'SUM(conversions)')} as cpa_current,
    ${safeCtrCalculation('SUM(clicks)', 'SUM(impressions)')} as ctr_current,
    COUNT(DISTINCT campaign_id) as campaign_count_current
  FROM ${BLENDED_SUMMARY_TABLE}
  WHERE 
    ${currentDateFilter}
    AND ${platformFilter}
    AND spend > 0
  GROUP BY platform, country, campaign_objective
),

-- Step 2: Previous period for trend analysis (conditional)
${include_trends ? `
previous_period AS (
  SELECT
    platform,
    country,
    campaign_objective,
    SUM(spend) as spend_previous,
    SUM(conversions) as conversions_previous,
    ${safeCpaCalculation('SUM(spend)', 'SUM(conversions)')} as cpa_previous
  FROM ${BLENDED_SUMMARY_TABLE}
  WHERE 
    ${comparisonDateFilter.replace(/\bdate\b/g, 'date')}
    AND ${platformFilter}
    AND spend > 0
  GROUP BY platform, country, campaign_objective
),
` : ''}

-- Step 3: Combined regional performance with classifications
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
    ${include_trends ? `pp.spend_previous,
    pp.conversions_previous,
    pp.cpa_previous,
    -- Calculate trends safely
    CASE 
      WHEN pp.cpa_previous IS NOT NULL AND pp.cpa_previous > 0 THEN
        ROUND((cp.cpa_current - pp.cpa_previous) / pp.cpa_previous * 100, 1)
      ELSE NULL
    END as cpa_change_pct,` : `NULL as spend_previous,
    NULL as conversions_previous,
    NULL as cpa_previous,
    NULL as cpa_change_pct,`}
    -- Performance classification
    ${getPerformanceRatingCase('cp.cpa_current')} as performance_rating
  FROM current_period cp
  ${include_trends ? `LEFT JOIN previous_period pp 
    ON cp.platform = pp.platform 
    AND cp.country = pp.country 
    AND cp.campaign_objective = pp.campaign_objective` : ''}
  WHERE cp.spend_current >= 500  -- Minimum threshold for meaningful comparison
),

-- Step 4: Country-level summary
country_summary AS (
  SELECT
    country,
    SUM(spend_current) as total_spend,
    SUM(conversions_current) as total_conversions,
    ${safeCpaCalculation('SUM(spend_current)', 'SUM(conversions_current)')} as blended_cpa,
    AVG(ctr_current) as avg_ctr,
    SUM(campaign_count_current) as total_campaigns,
    COUNT(DISTINCT platform) as active_platforms,
    ${include_trends ? 'AVG(cpa_change_pct) as avg_cpa_change,' : 'NULL as avg_cpa_change,'}
    -- Count performance ratings
    COUNT(CASE WHEN performance_rating IN ('EXCELLENT', 'GOOD') THEN 1 END) as strong_segments,
    COUNT(CASE WHEN performance_rating = 'NEEDS_ATTENTION' THEN 1 END) as weak_segments
  FROM regional_performance
  GROUP BY country
  HAVING total_spend >= 1000  -- Country-level minimum
),

-- Step 5: Platform-country matrix (conditional)
platform_country_summary AS (
  SELECT
    platform,
    country,
    SUM(spend_current) as platform_country_spend,
    SUM(conversions_current) as platform_country_conversions,
    ${safeCpaCalculation('SUM(spend_current)', 'SUM(conversions_current)')} as platform_country_cpa,
    AVG(ctr_current) as platform_country_ctr,
    ${include_trends ? 'AVG(cpa_change_pct) as platform_country_change,' : 'NULL as platform_country_change,'}
    COUNT(*) as segment_count
  FROM regional_performance
  GROUP BY platform, country
  HAVING platform_country_spend >= 500
)

-- Output 1: Country Comparison (when comparison_type = 'country')
SELECT 
  'COUNTRY_COMPARISON' as section,
  JSON_OBJECT(
    'analysis_type', '${comparison_type}',
    'platforms_analyzed', ARRAY[${cleanPlatforms.map(p => `'${p.replace(/'/g, "\\'")}'`).join(', ')}],
    'period', '${date_range} (${analysisDays} days)',
    'trend_analysis_included', ${include_trends},
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

-- Output 2: Platform by Country Matrix (when comparison_type = 'platform_by_country')
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

-- Output 3: Regional Insights (always included)
SELECT 
  'REGIONAL_INSIGHTS' as section,
  JSON_OBJECT(
    'key_findings', JSON_OBJECT(
      'best_performing_country', (SELECT country FROM country_summary ORDER BY blended_cpa ASC LIMIT 1),
      'highest_spend_country', (SELECT country FROM country_summary ORDER BY total_spend DESC LIMIT 1),
      'most_improved', CASE 
        WHEN ${include_trends} THEN
          (SELECT country FROM country_summary WHERE avg_cpa_change IS NOT NULL ORDER BY avg_cpa_change ASC LIMIT 1)
        ELSE 'Trend analysis disabled'
      END,
      'needs_attention', ARRAY_AGG(
        CASE WHEN weak_segments >= 2 THEN country ELSE NULL END IGNORE NULLS
      ),
      'total_countries_analyzed', COUNT(*)
    )
  ) as summary_data
FROM country_summary

ORDER BY section;
`;

				const webhookUrl = "https://n8n.wibci.dev/webhook/40df3a90-da64-4939-8813-839f12a43cee";
				
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
						text: `Regional Comparison Analysis\nPlatforms: ${cleanPlatforms.join(', ')}\nComparison: ${comparison_type}\nPeriod: ${date_range}\nTrends: ${include_trends ? 'included' : 'excluded'}\n\nResults:\n${data}`
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