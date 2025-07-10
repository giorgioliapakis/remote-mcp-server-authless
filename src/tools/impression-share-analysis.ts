import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	createInClause,
	getDaysFromRange,
	buildDateFilter,
	buildComparisonDateFilter,
	IMPRESSION_SHARE_TABLE,
	getOpportunityTypeCase,
	getBudgetUtilizationStatus,
	getTotalLostImpressionShare,
	getMarketOpportunityScore,
	safeCpaCalculation,
	validateAndCleanInput
} from "./sql-utils";
import { 
	IMPRESSION_SHARE, 
	WEBHOOK_CONFIG, 
	DEFAULT_COUNTRIES, 
	UTILITIES 
} from "../settings";

/**
 * Register the impression share analysis tool - Google Ads search performance optimization
 */
export function registerImpressionShareAnalysisTool(server: McpServer) {
	server.tool(
		"impression_share_analysis",
		{
			analysis_type: z.enum(["overview", "budget_opportunities", "rank_opportunities", "regional_comparison"]).default("overview").describe(
				"Analysis focus: 'overview' for comprehensive insights, 'budget_opportunities' for budget-constrained campaigns, 'rank_opportunities' for quality score issues, 'regional_comparison' for geographic performance"
			),
			date_range: z.enum(["7d", "14d", "30d"]).default("14d").describe(
				"Analysis period. Use '7d' for recent trends, '14d' for balanced view, '30d' for longer patterns"
			),
			regions: z.array(z.string()).default(DEFAULT_COUNTRIES).describe(
				"Regions to analyze. Default: ['US', 'AU', 'UK']. Use specific regions when user mentions geography"
			),
			include_brand_campaigns: z.boolean().default(true).describe(
				"Include brand campaigns in analysis. Set false when focusing on non-brand/competitor campaigns only"
			),
			min_spend_threshold: z.number().default(500).describe(
				"Minimum spend threshold for campaign inclusion. Use 200 for broader view, 1000+ for high-impact campaigns only"
			),
		},
		async ({ analysis_type, date_range, regions, include_brand_campaigns, min_spend_threshold }: {
			analysis_type: "overview" | "budget_opportunities" | "rank_opportunities" | "regional_comparison";
			date_range: "7d" | "14d" | "30d";
			regions: string[];
			include_brand_campaigns: boolean;
			min_spend_threshold: number;
		}) => {
			try {
				// Validate and clean inputs
				const cleanRegions = validateAndCleanInput(regions) as string[];
				const analysisDays = getDaysFromRange(date_range);
				const safeMinSpend = Math.max(100, Math.min(min_spend_threshold, 10000));
				
				// Build safe SQL components
				const regionFilter = createInClause(cleanRegions, 'region');
				const currentDateFilter = buildDateFilter(analysisDays);
				const comparisonDateFilter = buildComparisonDateFilter(analysisDays, analysisDays * 2);
				const brandFilter = include_brand_campaigns ? '1=1' : 'COALESCE(is_brand_campaign, FALSE) = FALSE';

				const query = `
-- Google Ads Impression Share Analysis - ${analysis_type.toUpperCase()}
-- Identifies search visibility opportunities and optimization strategies
-- Analysis Type: ${analysis_type} | Period: ${date_range} (${analysisDays} days)

WITH 
-- Step 1: Base impression share data with filtering
base_impression_data AS (
  SELECT
    region,
    campaign,
    campaign_type,
    campaign_category,
    funnel_stage,
    is_brand_campaign,
    SUM(spend) as total_spend,
    SUM(conversions) as total_conversions,
    SUM(clicks) as total_clicks,
    SUM(actual_impressions) as total_impressions,
    SUM(market_size_impressions) as total_market_size,
    ${safeCpaCalculation('SUM(spend)', 'SUM(conversions)')} as blended_cpa,
    
    -- Impression share metrics (weighted averages)
    SAFE_DIVIDE(
      SUM(search_impression_share_pct * actual_impressions), 
      SUM(actual_impressions)
    ) as weighted_impression_share,
    SAFE_DIVIDE(
      SUM(search_top_impression_share_pct * actual_impressions), 
      SUM(actual_impressions)
    ) as weighted_top_impression_share,
    SAFE_DIVIDE(
      SUM(search_absolute_top_impression_share_pct * actual_impressions), 
      SUM(actual_impressions)
    ) as weighted_absolute_top_share,
    
    -- Lost impression share metrics
    SAFE_DIVIDE(
      SUM(budget_lost_impression_share_pct * market_size_impressions), 
      SUM(market_size_impressions)
    ) as weighted_budget_lost,
    SAFE_DIVIDE(
      SUM(rank_lost_impression_share_pct * market_size_impressions), 
      SUM(market_size_impressions)
    ) as weighted_rank_lost,
    
    -- Budget and utilization
    AVG(budget_utilization_pct) as avg_budget_utilization,
    SUM(estimated_budget_needed_for_lost_impressions) as additional_budget_needed,
    SUM(estimated_clicks_from_rank_improvement) as potential_clicks_from_rank,
    
    -- Trend analysis
    AVG(wow_impression_share_change) as avg_wow_change,
    
    -- Market position (get most common value per campaign)
    APPROX_TOP_COUNT(market_position, 1)[OFFSET(0)].value as primary_market_position,
    APPROX_TOP_COUNT(performance_diagnosis, 1)[OFFSET(0)].value as primary_diagnosis
    
  FROM ${IMPRESSION_SHARE_TABLE}
  WHERE 
    ${currentDateFilter}
    AND ${regionFilter}
    AND ${brandFilter}
    AND spend > 0
    AND actual_impressions > ${IMPRESSION_SHARE.MIN_IMPRESSIONS_THRESHOLD}
  GROUP BY 
    region, campaign, campaign_type, campaign_category, funnel_stage, is_brand_campaign
  HAVING 
    total_spend >= ${safeMinSpend}
    AND total_clicks >= ${IMPRESSION_SHARE.MIN_CLICKS_THRESHOLD}
),

-- Step 2: Enhanced performance classification
performance_classified AS (
  SELECT
    *,
    -- Performance classification
    ${getOpportunityTypeCase().replace(/budget_lost_impression_share_pct/g, 'weighted_budget_lost').replace(/rank_lost_impression_share_pct/g, 'weighted_rank_lost')} as opportunity_type,
    ${getBudgetUtilizationStatus().replace(/budget_utilization_pct/g, 'avg_budget_utilization')} as budget_status,
    
    -- Calculate opportunity scores
    ROUND(${getMarketOpportunityScore().replace(/budget_lost_impression_share_pct/g, 'weighted_budget_lost').replace(/rank_lost_impression_share_pct/g, 'weighted_rank_lost').replace(/market_size_impressions/g, 'total_market_size')}, 1) as opportunity_score,
    
    -- Total lost impression share
    COALESCE(weighted_budget_lost, 0) + COALESCE(weighted_rank_lost, 0) as total_lost_share,
    
    -- Market share calculation
    CASE 
      WHEN total_market_size > 0 THEN ROUND(total_impressions / total_market_size * 100, 2)
      ELSE NULL 
    END as calculated_market_share
    
  FROM base_impression_data
),

-- Step 3: Analysis-specific filtering and ranking
filtered_opportunities AS (
  SELECT *,
    -- Create ranking for different analysis types
    ROW_NUMBER() OVER (
      ORDER BY 
        CASE 
          WHEN '${analysis_type}' = 'budget_opportunities' THEN additional_budget_needed
          WHEN '${analysis_type}' = 'rank_opportunities' THEN potential_clicks_from_rank
          ELSE opportunity_score
        END DESC
    ) as analysis_rank
  FROM performance_classified
  WHERE 
    CASE 
      WHEN '${analysis_type}' = 'budget_opportunities' THEN 
        weighted_budget_lost >= ${IMPRESSION_SHARE.ACTIONABLE_THRESHOLD} 
        AND budget_status IN ('CONSTRAINED', 'BALANCED')
      WHEN '${analysis_type}' = 'rank_opportunities' THEN 
        weighted_rank_lost >= ${IMPRESSION_SHARE.ACTIONABLE_THRESHOLD}
        AND opportunity_type IN ('RANK_OPPORTUNITY', 'RANK_IMPROVEMENT')
      WHEN '${analysis_type}' = 'regional_comparison' THEN 
        total_spend >= ${safeMinSpend * 2}  -- Higher threshold for regional
      ELSE 
        total_lost_share >= ${IMPRESSION_SHARE.ACTIONABLE_THRESHOLD / 2}  -- Overview includes all
    END
),

-- Step 3b: Apply analysis-specific limits
limited_opportunities AS (
  SELECT * FROM filtered_opportunities
  WHERE analysis_rank <= 
    CASE 
      WHEN '${analysis_type}' = 'budget_opportunities' THEN ${IMPRESSION_SHARE.MAX_BUDGET_CONSTRAINED}
      WHEN '${analysis_type}' = 'rank_opportunities' THEN ${IMPRESSION_SHARE.MAX_RANK_OPPORTUNITIES}
      WHEN '${analysis_type}' = 'regional_comparison' THEN ${IMPRESSION_SHARE.MAX_REGIONAL_COMPARISONS}
      ELSE ${IMPRESSION_SHARE.MAX_OPPORTUNITY_CAMPAIGNS}
    END
),

-- Step 4: Regional summary (for regional_comparison and overview)
regional_summary AS (
  SELECT
    region,
    COUNT(*) as campaign_count,
    SUM(total_spend) as region_spend,
    SUM(total_conversions) as region_conversions,
    ${safeCpaCalculation('SUM(total_spend)', 'SUM(total_conversions)')} as region_cpa,
    
    -- Regional impression share aggregation
    SAFE_DIVIDE(
      SUM(weighted_impression_share * total_impressions), 
      SUM(total_impressions)
    ) as region_impression_share,
    SAFE_DIVIDE(
      SUM(weighted_budget_lost * total_market_size), 
      SUM(total_market_size)
    ) as region_budget_lost,
    SAFE_DIVIDE(
      SUM(weighted_rank_lost * total_market_size), 
      SUM(total_market_size)
    ) as region_rank_lost,
    
    -- Regional opportunities
    SUM(additional_budget_needed) as total_additional_budget,
    SUM(potential_clicks_from_rank) as total_potential_clicks,
    AVG(opportunity_score) as avg_opportunity_score,
    
    -- Performance distribution
    COUNT(CASE WHEN opportunity_type = 'OPTIMIZED' THEN 1 END) as optimized_campaigns,
    COUNT(CASE WHEN total_lost_share >= ${IMPRESSION_SHARE.HIGH_BUDGET_LOST} OR total_lost_share >= ${IMPRESSION_SHARE.HIGH_RANK_LOST} THEN 1 END) as high_opportunity_campaigns
    
  FROM limited_opportunities
  GROUP BY region
),

-- Step 5: Overall summary metrics
overall_summary AS (
  SELECT
    COUNT(*) as total_campaigns_analyzed,
    SUM(total_spend) as total_spend_analyzed,
    SUM(total_conversions) as total_conversions_analyzed,
    ${safeCpaCalculation('SUM(total_spend)', 'SUM(total_conversions)')} as overall_cpa,
    
    -- Performance distribution by opportunity type
    COUNT(CASE WHEN opportunity_type = 'OPTIMIZED' THEN 1 END) as optimized_count,
    COUNT(CASE WHEN total_lost_share >= ${IMPRESSION_SHARE.HIGH_BUDGET_LOST} OR total_lost_share >= ${IMPRESSION_SHARE.HIGH_RANK_LOST} THEN 1 END) as high_opportunity_count,
    COUNT(CASE WHEN total_lost_share >= ${IMPRESSION_SHARE.ACTIONABLE_THRESHOLD} THEN 1 END) as actionable_opportunity_count,
    
    -- Opportunity distribution
    COUNT(CASE WHEN opportunity_type = 'BUDGET_OPPORTUNITY' THEN 1 END) as budget_opportunities,
    COUNT(CASE WHEN opportunity_type = 'RANK_OPPORTUNITY' THEN 1 END) as rank_opportunities,
    COUNT(CASE WHEN opportunity_type = 'OPTIMIZED' THEN 1 END) as optimized_campaigns,
    
    -- Total opportunity value
    SUM(additional_budget_needed) as total_budget_opportunity,
    SUM(potential_clicks_from_rank) as total_rank_opportunity,
    AVG(opportunity_score) as average_opportunity_score
    
  FROM limited_opportunities
)

-- Output 1: Analysis Summary
SELECT 
  'ANALYSIS_SUMMARY' as section,
  JSON_OBJECT(
    'analysis_type', '${analysis_type}',
    'analysis_period', '${date_range} (${analysisDays} days)',
    'regions_analyzed', ARRAY[${cleanRegions.map(r => `'${r.replace(/'/g, "\\'")}'`).join(', ')}],
    'include_brand_campaigns', ${include_brand_campaigns},
    'min_spend_threshold', ${safeMinSpend},
    'total_campaigns', total_campaigns_analyzed,
    'total_spend', ROUND(total_spend_analyzed, 2),
    'total_conversions', total_conversions_analyzed,
    'overall_cpa', ROUND(overall_cpa, 2),
    'performance_distribution', JSON_OBJECT(
      'optimized_campaigns', optimized_count,
      'high_opportunity_campaigns', high_opportunity_count,
      'actionable_opportunities', actionable_opportunity_count
    ),
    'opportunity_breakdown', JSON_OBJECT(
      'budget_constrained', budget_opportunities,
      'rank_improvement_needed', rank_opportunities,
      'already_optimized', optimized_campaigns
    ),
    'total_opportunity_value', JSON_OBJECT(
      'additional_budget_needed', ROUND(total_budget_opportunity, 2),
      'potential_clicks_from_rank', total_rank_opportunity,
      'average_opportunity_score', ROUND(average_opportunity_score, 1)
    )
  ) as summary_data
FROM overall_summary

UNION ALL

-- Output 2: Primary Analysis Results
SELECT 
  '${analysis_type.toUpperCase()}_RESULTS' as section,
  JSON_OBJECT(
    'analysis_focus', '${analysis_type}',
    'campaigns', ARRAY_AGG(JSON_OBJECT(
      'campaign_name', SUBSTR(campaign, 1, 80),
      'region', region,
      'campaign_type', campaign_type,
      'campaign_category', campaign_category,
      'funnel_stage', funnel_stage,
      'is_brand_campaign', is_brand_campaign,
      'spend', ROUND(total_spend, 2),
      'conversions', total_conversions,
      'cpa', ROUND(blended_cpa, 2),
      'impression_share_pct', ROUND(weighted_impression_share, 1),
      'top_impression_share_pct', ROUND(weighted_top_impression_share, 1),
      'absolute_top_share_pct', ROUND(weighted_absolute_top_share, 1),
      'budget_lost_pct', ROUND(weighted_budget_lost, 1),
      'rank_lost_pct', ROUND(weighted_rank_lost, 1),
      'total_lost_share_pct', ROUND(total_lost_share, 1),
      'budget_utilization_pct', ROUND(avg_budget_utilization, 1),
      'opportunity_type', opportunity_type,
      'budget_status', budget_status,
      'opportunity_score', opportunity_score,
      'market_position', primary_market_position,
      'performance_diagnosis', primary_diagnosis,
      'additional_budget_needed', ROUND(additional_budget_needed, 2),
      'potential_clicks_from_rank', potential_clicks_from_rank,
      'wow_change_pct', ROUND(avg_wow_change, 1)
    ) ORDER BY opportunity_score DESC)
  ) as summary_data
FROM limited_opportunities

${analysis_type === 'regional_comparison' || analysis_type === 'overview' ? `
UNION ALL

-- Output 3: Regional Comparison (when applicable)
SELECT 
  'REGIONAL_INSIGHTS' as section,
  JSON_OBJECT(
    'regional_performance', ARRAY_AGG(JSON_OBJECT(
      'region', region,
      'campaign_count', campaign_count,
      'total_spend', ROUND(region_spend, 2),
      'total_conversions', region_conversions,
      'regional_cpa', ROUND(region_cpa, 2),
      'avg_impression_share_pct', ROUND(region_impression_share, 1),
      'budget_lost_pct', ROUND(region_budget_lost, 1),
      'rank_lost_pct', ROUND(region_rank_lost, 1),
      'total_budget_opportunity', ROUND(total_additional_budget, 2),
      'total_potential_clicks', total_potential_clicks,
      'avg_opportunity_score', ROUND(avg_opportunity_score, 1),
      'optimized_campaigns', optimized_campaigns,
      'high_opportunity_campaigns', high_opportunity_campaigns
    ) ORDER BY region_spend DESC)
  ) as summary_data
FROM regional_summary
` : ''}

ORDER BY section;
`;

				const response = await fetch(WEBHOOK_CONFIG.URL, {
					method: "POST",
					headers: {
						"Content-Type": WEBHOOK_CONFIG.HEADERS['Content-Type'],
						"User-Agent": `${WEBHOOK_CONFIG.HEADERS['User-Agent-Prefix']}-Impression-Share-Analysis/1.0`,
					},
					body: JSON.stringify({
						query: query
					}),
				});

				if (!response.ok) {
					return {
						content: [{
							type: "text",
							text: `Error: Failed to execute impression share analysis. Status: ${response.status} ${response.statusText}`
						}]
					};
				}

				const data = await response.text();
				
				return {
					content: [{
						type: "text",
						text: `Impression Share Analysis Report (${analysis_type})\nPeriod: ${date_range}\nRegions: ${cleanRegions.join(', ')}\nBrand campaigns: ${include_brand_campaigns ? 'included' : 'excluded'}\nMin spend: $${safeMinSpend}\n\nResults:\n${data}`
					}]
				};
			} catch (error) {
				return {
					content: [{
						type: "text",
						text: `Error analyzing impression share: ${error instanceof Error ? error.message : String(error)}`
					}]
				};
			}
		}
	);
} 