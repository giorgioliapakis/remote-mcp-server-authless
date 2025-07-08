import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	createCampaignMatchConditions,
	getComparisonDays,
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
 * Register the campaign analysis tool - deep dive into specific campaign performance
 */
export function registerCampaignAnalysisTool(server: McpServer) {
	server.tool(
		"campaign_analysis",
		{
			campaign_names: z.array(z.string()).describe(
				"Campaign names to analyze. Use partial matches (e.g., ['Podcast', 'AU Launch']). Can infer from user mentions like 'The Imperfects campaign' or 'podcast campaigns'"
			),
			comparison_period: z.enum(["week_over_week", "month_over_month"]).default("week_over_week").describe(
				"Comparison timeframe. Use 'week_over_week' for recent changes, 'month_over_month' for longer trends"
			),
			include_creatives: z.boolean().default(false).describe(
				"Include creative-level analysis for Meta campaigns. Set true when user asks about 'ads', 'creatives', or 'creative performance'"
			),
		},
		async ({ campaign_names, comparison_period, include_creatives }: {
			campaign_names: string[];
			comparison_period: "week_over_week" | "month_over_month";
			include_creatives: boolean;
		}) => {
			try {
				// Validate and clean inputs
				const cleanCampaignNames = validateAndCleanInput(campaign_names) as string[];
				
				// Get period configuration
				const { current: currentDays, comparison: comparisonDays } = getComparisonDays(comparison_period);
				
				// Build safe SQL components
				const campaignMatchCondition = createCampaignMatchConditions(cleanCampaignNames);
				const currentDateFilter = buildDateFilter(currentDays);
				const comparisonDateFilter = buildComparisonDateFilter(currentDays, comparisonDays);
				
				const query = `
-- Campaign Deep Dive Analysis - FIXED VERSION
-- Eliminates subquery aggregation issues by using direct values instead of CTEs
-- Safe parameter injection and simplified structure

WITH 
-- Step 1: Find matching campaigns (simplified, no config CTE)
campaign_matches AS (
  SELECT DISTINCT
    campaign_id,
    campaign,
    platform,
    country
  FROM ${BLENDED_SUMMARY_TABLE}
  WHERE 
    ${buildDateFilter(comparisonDays)}
    AND ${campaignMatchCondition}
    AND spend > 0
),

-- Step 2: Current period performance
current_period_data AS (
  SELECT
    cm.campaign_id,
    cm.campaign,
    cm.platform,
    cm.country,
    SUM(bd.spend) as spend_current,
    SUM(bd.conversions) as conversions_current,
    ${safeCpaCalculation('SUM(bd.spend)', 'SUM(bd.conversions)')} as cpa_current,
    ${safeCtrCalculation('SUM(bd.clicks)', 'SUM(bd.impressions)')} as ctr_current,
    ${safeCvrCalculation('SUM(bd.conversions)', 'SUM(bd.clicks)')} as cvr_current
  FROM campaign_matches cm
  JOIN ${BLENDED_SUMMARY_TABLE} bd ON cm.campaign_id = bd.campaign_id
  WHERE ${buildDateFilter(currentDays, 'bd')}
  GROUP BY cm.campaign_id, cm.campaign, cm.platform, cm.country
),

-- Step 3: Comparison period performance
comparison_period_data AS (
  SELECT
    cm.campaign_id,
    SUM(bd.spend) as spend_comparison,
    SUM(bd.conversions) as conversions_comparison,
    ${safeCpaCalculation('SUM(bd.spend)', 'SUM(bd.conversions)')} as cpa_comparison,
    ${safeCtrCalculation('SUM(bd.clicks)', 'SUM(bd.impressions)')} as ctr_comparison,
    ${safeCvrCalculation('SUM(bd.conversions)', 'SUM(bd.clicks)')} as cvr_comparison
  FROM campaign_matches cm
  JOIN ${BLENDED_SUMMARY_TABLE} bd ON cm.campaign_id = bd.campaign_id
  WHERE ${comparisonDateFilter.replace('date >', 'bd.date >')}
  GROUP BY cm.campaign_id
),

-- Step 4: Combined performance with classifications
campaign_performance AS (
  SELECT
    cp.*,
    comp.spend_comparison,
    comp.conversions_comparison,
    comp.cpa_comparison,
    comp.ctr_comparison,
    comp.cvr_comparison,
    -- Calculate changes safely
    CASE 
      WHEN comp.cpa_comparison IS NOT NULL AND comp.cpa_comparison > 0 THEN
        ROUND((cp.cpa_current - comp.cpa_comparison) / comp.cpa_comparison * 100, 1)
      ELSE NULL
    END as cpa_change_pct,
    CASE 
      WHEN comp.ctr_comparison IS NOT NULL AND comp.ctr_comparison > 0 THEN
        ROUND((cp.ctr_current - comp.ctr_comparison) / comp.ctr_comparison * 100, 1)
      ELSE NULL
    END as ctr_change_pct,
    CASE 
      WHEN comp.cvr_comparison IS NOT NULL AND comp.cvr_comparison > 0 THEN
        ROUND((cp.cvr_current - comp.cvr_comparison) / comp.cvr_comparison * 100, 1)
      ELSE NULL
    END as cvr_change_pct,
    -- Performance classification
    ${getPerformanceRatingCase('cp.cpa_current')} as performance_rating
  FROM current_period_data cp
  LEFT JOIN comparison_period_data comp ON cp.campaign_id = comp.campaign_id
),

-- Step 5: Pre-filter top performers to avoid LIMIT in UNION
top_performers_filtered AS (
  SELECT *
  FROM campaign_performance
  WHERE performance_rating IN ('EXCELLENT', 'GOOD')
    AND spend_current >= 200
  ORDER BY spend_current DESC
  LIMIT 10
)${include_creatives ? `,

-- Step 6: Pre-filter creative data to avoid LIMIT in UNION  
creative_filtered AS (
  SELECT 
    bd.ad_name,
    bd.campaign_id,
    SUM(bd.spend) as creative_spend,
    SUM(bd.conversions) as creative_conversions,
    ${safeCpaCalculation('SUM(bd.spend)', 'SUM(bd.conversions)')} as creative_cpa
  FROM campaign_matches cm
  JOIN ${BLENDED_SUMMARY_TABLE} bd ON cm.campaign_id = bd.campaign_id
  WHERE ${buildDateFilter(currentDays, 'bd')}
    AND bd.platform = 'Meta'
    AND bd.ad_name IS NOT NULL
  GROUP BY bd.ad_name, bd.campaign_id
  HAVING SUM(bd.spend) >= 100 AND SUM(bd.conversions) >= 2
  ORDER BY ${safeCpaCalculation('SUM(bd.spend)', 'SUM(bd.conversions)')} ASC
  LIMIT 10
)` : ''}

-- Output 1: Executive Summary
SELECT 
  'EXECUTIVE_SUMMARY' as section,
  JSON_OBJECT(
    'analysis_type', '${comparison_period}',
    'search_terms', ARRAY[${cleanCampaignNames.map(name => `'${name.replace(/'/g, "\\'")}'`).join(', ')}],
    'period_days', ${currentDays},
    'total_campaigns', COUNT(*),
    'total_spend', ROUND(SUM(spend_current), 2),
    'total_conversions', SUM(conversions_current),
    'blended_cpa', ROUND(${safeCpaCalculation('SUM(spend_current)', 'SUM(conversions_current)')}, 2),
    'performance_breakdown', JSON_OBJECT(
      'excellent', COUNT(CASE WHEN performance_rating = 'EXCELLENT' THEN 1 END),
      'good', COUNT(CASE WHEN performance_rating = 'GOOD' THEN 1 END),
      'acceptable', COUNT(CASE WHEN performance_rating = 'ACCEPTABLE' THEN 1 END),
      'needs_attention', COUNT(CASE WHEN performance_rating = 'NEEDS_ATTENTION' THEN 1 END)
    ),
    'platform_breakdown', JSON_OBJECT(
      'meta', COUNT(CASE WHEN platform = 'Meta' THEN 1 END),
      'google', COUNT(CASE WHEN platform = 'Google' THEN 1 END),
      'tiktok', COUNT(CASE WHEN platform = 'tiktok' THEN 1 END),
      'other', COUNT(CASE WHEN platform NOT IN ('Meta', 'Google', 'tiktok') THEN 1 END)
    )
  ) as summary_data
FROM campaign_performance

UNION ALL

-- Output 2: Problem Campaigns (High spend, poor performance)
SELECT 
  'PROBLEM_CAMPAIGNS' as section,
  JSON_OBJECT(
    'campaigns_needing_attention', ARRAY_AGG(
      JSON_OBJECT(
        'campaign_name', SUBSTR(campaign, 1, 80),
        'platform', platform,
        'country', country,
        'current_spend', ROUND(spend_current, 2),
        'current_conversions', conversions_current,
        'current_cpa', ROUND(cpa_current, 2),
        'comparison_cpa', ROUND(COALESCE(cpa_comparison, 0), 2),
        'cpa_change_pct', COALESCE(cpa_change_pct, 0),
        'performance_rating', performance_rating
      ) ORDER BY spend_current DESC
    )
  ) as summary_data
FROM campaign_performance
WHERE performance_rating = 'NEEDS_ATTENTION'
   OR (spend_current > 1000 AND cpa_current > 50)

UNION ALL

-- Output 3: Top Performers (Scale opportunities)
SELECT 
  'TOP_PERFORMERS' as section,
  JSON_OBJECT(
    'excellent_campaigns', ARRAY_AGG(
      JSON_OBJECT(
        'campaign_name', SUBSTR(campaign, 1, 80),
        'platform', platform,
        'country', country,
        'spend', ROUND(spend_current, 2),
        'conversions', conversions_current,
        'cpa', ROUND(cpa_current, 2),
        'cpa_change_pct', COALESCE(cpa_change_pct, 0)
      ) ORDER BY spend_current DESC
    )
  ) as summary_data
FROM top_performers_filtered

${include_creatives ? `
UNION ALL

-- Output 4: Creative Analysis (if requested)
SELECT 
  'CREATIVE_ANALYSIS' as section,
  JSON_OBJECT(
    'note', 'Meta creative performance analysis included',
    'top_creatives', ARRAY_AGG(
      JSON_OBJECT(
        'ad_name', SUBSTR(ad_name, 1, 100),
        'creative_concept', CASE 
          WHEN ad_name IS NOT NULL THEN SUBSTR(SPLIT(ad_name, ' // ')[SAFE_OFFSET(0)], 1, 50)
          ELSE 'Unknown'
        END,
        'spend', ROUND(creative_spend, 2),
        'conversions', creative_conversions,
        'cpa', ROUND(creative_cpa, 2)
      ) ORDER BY creative_cpa ASC
    )
  ) as summary_data
FROM creative_filtered
` : ''}

ORDER BY section;
`;

				const webhookUrl = "https://n8n.wibci.dev/webhook/40df3a90-da64-4939-8813-839f12a43cee";
				
				const response = await fetch(webhookUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"User-Agent": "MCP-Campaign-Analysis-Tool/1.0",
					},
					body: JSON.stringify({
						query: query
					}),
				});

				if (!response.ok) {
					return {
						content: [{
							type: "text",
							text: `Error: Failed to execute campaign analysis. Status: ${response.status} ${response.statusText}`
						}]
					};
				}

				const data = await response.text();
				
				return {
					content: [{
						type: "text",
						text: `Campaign Analysis (${comparison_period})\nSearch terms: ${cleanCampaignNames.join(', ')}\nCreative analysis: ${include_creatives ? 'Included' : 'Not included'}\n\nResults:\n${data}`
					}]
				};
			} catch (error) {
				return {
					content: [{
						type: "text",
						text: `Error generating campaign analysis: ${error instanceof Error ? error.message : String(error)}`
					}]
				};
			}
		}
	);
} 