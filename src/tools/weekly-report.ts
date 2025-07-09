import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	createInClause,
	getDaysFromRange,
	buildDateFilter,
	BLENDED_SUMMARY_TABLE,
	getPerformanceRatingCase,
	safeCpaCalculation,
	validateAndCleanInput
} from "./sql-utils";
import { 
	WEEKLY_REPORT, 
	PLATFORM_TARGETS, 
	WEBHOOK_CONFIG, 
	DEFAULT_COUNTRIES, 
	DEFAULT_PLATFORMS,
	UTILITIES 
} from "../settings";

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
			platforms: z.array(z.enum(["Meta", "Google", "Bing"])).default(DEFAULT_PLATFORMS).describe(
				"Platforms to include in analysis. Default includes all platforms. Common: ['Meta', 'Google'] for paid social + search"
			),
			countries: z.array(z.string()).default(DEFAULT_COUNTRIES).describe(
				"Countries to analyze. Default: ['US', 'AU', 'UK']. Use ['US'] for US-only analysis, ['AU'] for Australia-only, etc."
			),
		},
		async ({ date_range, platforms, countries }: {
			date_range: "7d" | "14d" | "30d";
			platforms: ("Meta" | "Google" | "Bing")[];
			countries: string[];
		}) => {
			try {
				// Validate and clean inputs
				const cleanPlatforms = validateAndCleanInput(platforms) as string[];
				const cleanCountries = validateAndCleanInput(countries) as string[];
				const analysisDays = getDaysFromRange(date_range);
				
				// Build safe SQL components
				const platformFilter = createInClause(cleanPlatforms, 'platform');
				const countryFilter = createInClause(cleanCountries, 'country');
				const dateFilter = buildDateFilter(analysisDays);
				
				// Platform target CPAs from settings
				const platformTargets = PLATFORM_TARGETS;

				const query = `
-- Weekly Business Intelligence Report - FIXED VERSION
-- Eliminates subquery aggregation issues and uses safe parameter injection
-- Focus: Platform overview, regional performance, actionable insights

WITH 
-- Step 1: Base performance data with filters applied directly
base_data AS (
  SELECT
    platform, 
    country, 
    campaign_objective,
    SUM(spend) as total_spend,
    SUM(conversions) as total_conversions,
    ${safeCpaCalculation('SUM(spend)', 'SUM(conversions)')} as blended_cpa,
    COUNT(DISTINCT campaign_id) as campaign_count
  FROM ${BLENDED_SUMMARY_TABLE}
  WHERE 
    ${dateFilter}
    AND ${platformFilter}
    AND ${countryFilter}
    AND spend > 0
  GROUP BY platform, country, campaign_objective
  HAVING 
    total_spend >= ${WEEKLY_REPORT.MIN_SPEND_THRESHOLD}
    AND total_conversions >= ${WEEKLY_REPORT.MIN_CONVERSIONS_THRESHOLD}
),

-- Step 2: Platform summary with target comparisons
platform_summary AS (
  SELECT
    platform,
    -- Platform targets as direct values
    CASE platform 
      WHEN 'Meta' THEN ${platformTargets.Meta}
      WHEN 'Google' THEN ${platformTargets.Google} 
      WHEN 'Bing' THEN ${platformTargets.Bing}
      ELSE 40.0  -- Default target for other platforms
    END as target_cpa,
    SUM(total_spend) as platform_spend,
    SUM(total_conversions) as platform_conversions,
    ${safeCpaCalculation('SUM(total_spend)', 'SUM(total_conversions)')} as platform_cpa,
    SUM(campaign_count) as total_campaigns
  FROM base_data
  GROUP BY platform
),

-- Step 3: Regional summary
regional_summary AS (
  SELECT
    country,
    SUM(total_spend) as country_spend,
    SUM(total_conversions) as country_conversions,
    ${safeCpaCalculation('SUM(total_spend)', 'SUM(total_conversions)')} as country_cpa,
    COUNT(DISTINCT platform) as active_platforms
  FROM base_data
  GROUP BY country
),

-- Step 3b: Add efficiency ranking to regional data
regional_with_rank AS (
  SELECT 
    *,
    RANK() OVER (ORDER BY country_cpa ASC) as efficiency_rank
  FROM regional_summary
),

-- Step 4: Performance issues (over target by 20%+)
performance_issues AS (
  SELECT
    CONCAT(platform, ' - ', country) as description,
    blended_cpa as current_cpa,
    CASE platform 
      WHEN 'Meta' THEN ${platformTargets.Meta}
      WHEN 'Google' THEN ${platformTargets.Google} 
      WHEN 'Bing' THEN ${platformTargets.Bing}
      ELSE 40.0
    END as target_cpa,
    total_spend as financial_impact
  FROM base_data
  WHERE blended_cpa > CASE platform 
    WHEN 'Meta' THEN ${platformTargets.Meta} * 1.2
    WHEN 'Google' THEN ${platformTargets.Google} * 1.2 
    WHEN 'Bing' THEN ${platformTargets.Bing} * 1.2
    ELSE 40.0 * 1.2
  END
  ORDER BY total_spend DESC
  LIMIT 5
),

-- Step 5: Scale opportunities (performing well under target)
opportunities AS (
  SELECT
    CONCAT(platform, ' - ', country, ' - ', campaign_objective) as description,
    blended_cpa as current_cpa,
    CASE platform 
      WHEN 'Meta' THEN ${platformTargets.Meta}
      WHEN 'Google' THEN ${platformTargets.Google} 
      WHEN 'Bing' THEN ${platformTargets.Bing}
      ELSE 40.0
    END as target_cpa,
    total_spend as current_spend,
    -- Conservative scale potential calculation
    CASE 
      WHEN total_spend < 500 THEN ROUND(total_spend * 1.0, 0)
      WHEN total_spend < 1500 THEN ROUND(total_spend * 0.5, 0)
      ELSE ROUND(total_spend * 0.2, 0)
    END as scale_potential
  FROM base_data
  WHERE blended_cpa <= CASE platform 
    WHEN 'Meta' THEN ${platformTargets.Meta} * 0.8
    WHEN 'Google' THEN ${platformTargets.Google} * 0.8 
    WHEN 'Bing' THEN ${platformTargets.Bing} * 0.8
    ELSE 40.0 * 0.8
  END
  ORDER BY scale_potential DESC
  LIMIT 5
)

-- Output 1: Platform Overview
SELECT 
  'PLATFORM_OVERVIEW' as section,
  JSON_OBJECT(
    'analysis_period', '${date_range} (${analysisDays} days)',
    'platforms_analyzed', ARRAY[${cleanPlatforms.map(p => `'${p.replace(/'/g, "\\'")}'`).join(', ')}],
    'countries_analyzed', ARRAY[${cleanCountries.map(c => `'${c.replace(/'/g, "\\'")}'`).join(', ')}],
    'platform_performance', ARRAY_AGG(JSON_OBJECT(
      'platform', platform,
      'spend', ROUND(platform_spend, 2),
      'conversions', platform_conversions,
      'cpa', ROUND(platform_cpa, 2),
      'target_cpa', target_cpa,
      'vs_target_pct', ROUND((platform_cpa - target_cpa) / target_cpa * 100, 1),
      'campaigns', total_campaigns,
      'status', CASE 
        WHEN platform_cpa <= target_cpa * 0.8 THEN 'EXCELLENT'
        WHEN platform_cpa <= target_cpa THEN 'ON_TARGET'
        WHEN platform_cpa <= target_cpa * 1.2 THEN 'ACCEPTABLE'
        ELSE 'NEEDS_ATTENTION'
      END
    ))
  ) as summary_data
FROM platform_summary

UNION ALL

-- Output 2: Regional Overview
SELECT 
  'REGIONAL_OVERVIEW' as section,
  JSON_OBJECT(
    'regional_performance', ARRAY_AGG(JSON_OBJECT(
      'country', country,
      'spend', ROUND(country_spend, 2),
      'conversions', country_conversions,
      'cpa', ROUND(country_cpa, 2),
      'active_platforms', active_platforms,
      'efficiency_rank', efficiency_rank
    ) ORDER BY country_spend DESC)
  ) as summary_data
FROM regional_with_rank

UNION ALL

-- Output 3: Performance Issues
SELECT 
  'TOP_ISSUES' as section,
  JSON_OBJECT(
    'performance_issues', ARRAY_AGG(JSON_OBJECT(
      'description', description,
      'current_cpa', ROUND(current_cpa, 2),
      'target_cpa', target_cpa,
      'overspend_pct', ROUND((current_cpa - target_cpa) / target_cpa * 100, 1),
      'financial_impact', ROUND(financial_impact, 2)
    ))
  ) as summary_data
FROM performance_issues

UNION ALL

-- Output 4: Scale Opportunities
SELECT 
  'SCALE_OPPORTUNITIES' as section,
  JSON_OBJECT(
    'opportunities', ARRAY_AGG(JSON_OBJECT(
      'description', description,
      'current_cpa', ROUND(current_cpa, 2),
      'target_cpa', target_cpa,
      'efficiency_margin', ROUND((target_cpa - current_cpa) / target_cpa * 100, 1),
      'current_spend', ROUND(current_spend, 2),
      'additional_spend_potential', scale_potential
    ))
  ) as summary_data
FROM opportunities

ORDER BY section;
`;

				const response = await fetch(WEBHOOK_CONFIG.URL, {
					method: "POST",
					headers: {
						"Content-Type": WEBHOOK_CONFIG.HEADERS['Content-Type'],
						"User-Agent": `${WEBHOOK_CONFIG.HEADERS['User-Agent-Prefix']}-Weekly-Report/1.0`,
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
						text: `Weekly Performance Report (${date_range} analysis)\nPlatforms: ${cleanPlatforms.join(', ')}\nCountries: ${cleanCountries.join(', ')}\n\nResults:\n${data}`
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