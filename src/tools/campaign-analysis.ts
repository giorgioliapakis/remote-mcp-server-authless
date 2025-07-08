import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

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
		async ({ campaign_names, comparison_period, include_creatives }) => {
			try {
				const query = `
-- Campaign Deep Dive Analysis - READABLE FORMAT
-- Executive summary + grouped insights to reduce cognitive load
-- Only detailed breakdowns for problem areas

WITH 
config AS (
  SELECT
    ${JSON.stringify(campaign_names)} as target_campaigns,
    '${comparison_period}' as comparison_type,
    ${include_creatives} as include_creative_analysis,
    -- Period definitions
    CASE '${comparison_period}'
      WHEN 'week_over_week' THEN 7
      WHEN 'month_over_month' THEN 30
    END as current_period_days,
    CASE '${comparison_period}'
      WHEN 'week_over_week' THEN 14  -- Previous 7 days
      WHEN 'month_over_month' THEN 60  -- Previous 30 days
    END as comparison_period_days
),

campaign_matches AS (
  SELECT DISTINCT
    campaign_id,
    campaign,
    platform,
    country
  FROM \`exemplary-terra-463404-m1.linktree_analytics.blended_summary\`
  WHERE 
    date >= DATE_SUB(CURRENT_DATE(), INTERVAL (SELECT comparison_period_days FROM config) DAY)
    AND (
      ${campaign_names.map(name => `LOWER(campaign) LIKE LOWER('%${name}%')`).join(' OR ')}
    )
    AND spend > 0
),

current_period_data AS (
  SELECT
    cm.campaign_id,
    cm.campaign,
    cm.platform,
    cm.country,
    SUM(bd.spend) as spend_current,
    SUM(bd.conversions) as conversions_current,
    SAFE_DIVIDE(SUM(bd.spend), NULLIF(SUM(bd.conversions), 0)) as cpa_current,
    SAFE_DIVIDE(SUM(bd.clicks), NULLIF(SUM(bd.impressions), 0)) * 100 as ctr_current,
    SAFE_DIVIDE(SUM(bd.conversions), NULLIF(SUM(bd.clicks), 0)) * 100 as cvr_current
  FROM campaign_matches cm
  JOIN \`exemplary-terra-463404-m1.linktree_analytics.blended_summary\` bd
    ON cm.campaign_id = bd.campaign_id
  WHERE 
    bd.date >= DATE_SUB(CURRENT_DATE(), INTERVAL (SELECT current_period_days FROM config) DAY)
  GROUP BY cm.campaign_id, cm.campaign, cm.platform, cm.country
),

comparison_period_data AS (
  SELECT
    cm.campaign_id,
    SUM(bd.spend) as spend_comparison,
    SUM(bd.conversions) as conversions_comparison,
    SAFE_DIVIDE(SUM(bd.spend), NULLIF(SUM(bd.conversions), 0)) as cpa_comparison,
    SAFE_DIVIDE(SUM(bd.clicks), NULLIF(SUM(bd.impressions), 0)) * 100 as ctr_comparison,
    SAFE_DIVIDE(SUM(bd.conversions), NULLIF(SUM(bd.clicks), 0)) * 100 as cvr_comparison
  FROM campaign_matches cm
  JOIN \`exemplary-terra-463404-m1.linktree_analytics.blended_summary\` bd
    ON cm.campaign_id = bd.campaign_id
  WHERE 
    bd.date >= DATE_SUB(CURRENT_DATE(), INTERVAL (SELECT comparison_period_days FROM config) DAY)
    AND bd.date < DATE_SUB(CURRENT_DATE(), INTERVAL (SELECT current_period_days FROM config) DAY)
  GROUP BY cm.campaign_id
),

campaign_performance AS (
  SELECT
    cp.*,
    comp.spend_comparison,
    comp.conversions_comparison,
    comp.cpa_comparison,
    comp.ctr_comparison,
    comp.cvr_comparison,
    -- Calculate changes
    SAFE_DIVIDE((cp.cpa_current - comp.cpa_comparison), NULLIF(comp.cpa_comparison, 0)) * 100 as cpa_change_pct,
    SAFE_DIVIDE((cp.ctr_current - comp.ctr_comparison), NULLIF(comp.ctr_comparison, 0)) * 100 as ctr_change_pct,
    SAFE_DIVIDE((cp.cvr_current - comp.cvr_comparison), NULLIF(comp.cvr_comparison, 0)) * 100 as cvr_change_pct,
    -- Performance classification
    CASE
      WHEN cp.cpa_current <= 25 THEN 'EXCELLENT'
      WHEN cp.cpa_current <= 40 THEN 'GOOD'
      WHEN cp.cpa_current <= 60 THEN 'ACCEPTABLE'
      ELSE 'NEEDS_ATTENTION'
    END as performance_rating
  FROM current_period_data cp
  LEFT JOIN comparison_period_data comp ON cp.campaign_id = comp.campaign_id
),

executive_summary AS (
  SELECT
    COUNT(*) as total_campaigns,
    SUM(spend_current) as total_spend,
    SUM(conversions_current) as total_conversions,
    SAFE_DIVIDE(SUM(spend_current), NULLIF(SUM(conversions_current), 0)) as blended_cpa,
    -- Performance breakdown
    COUNTIF(performance_rating = 'EXCELLENT') as excellent_count,
    COUNTIF(performance_rating = 'GOOD') as good_count,
    COUNTIF(performance_rating = 'ACCEPTABLE') as acceptable_count,
    COUNTIF(performance_rating = 'NEEDS_ATTENTION') as needs_attention_count,
    -- Platform breakdown
    COUNTIF(platform = 'Meta') as meta_count,
    COUNTIF(platform = 'Google') as google_count,
    COUNTIF(platform = 'tiktok') as tiktok_count,
    -- Country breakdown
    COUNTIF(country = 'US') as us_count,
    COUNTIF(country = 'UK') as uk_count,
    COUNTIF(country = 'CA') as ca_count,
    COUNTIF(country = 'AU') as au_count
  FROM campaign_performance
),

platform_groups AS (
  SELECT
    platform,
    performance_rating,
    COUNT(*) as campaign_count,
    ROUND(SUM(spend_current), 0) as group_spend,
    ROUND(SUM(conversions_current), 0) as group_conversions,
    ROUND(SAFE_DIVIDE(SUM(spend_current), NULLIF(SUM(conversions_current), 0)), 2) as group_cpa,
    -- Best and worst performers in group
    STRING_AGG(
      CASE WHEN performance_rating = 'NEEDS_ATTENTION' 
      THEN CONCAT(SUBSTR(campaign, 1, 50), '... ($', CAST(ROUND(spend_current) AS STRING), ', CPA: $', CAST(ROUND(cpa_current, 2) AS STRING), ')')
      END, 
      ' | ' 
      LIMIT 3
    ) as problem_campaigns
  FROM campaign_performance
  GROUP BY platform, performance_rating
),

creative_analysis AS (
  SELECT
    bd.campaign_id,
    bd.ad_name,
    -- Parse Meta creative components
    CASE 
      WHEN bd.platform = 'Meta' AND bd.ad_name IS NOT NULL THEN
        TRIM(SPLIT(bd.ad_name, ' // ')[SAFE_OFFSET(0)])
      ELSE NULL
    END as creative_concept,
    SUM(bd.spend) as creative_spend,
    SUM(bd.conversions) as creative_conversions,
    SAFE_DIVIDE(SUM(bd.spend), NULLIF(SUM(bd.conversions), 0)) as creative_cpa
  FROM \`exemplary-terra-463404-m1.linktree_analytics.blended_summary\` bd
  WHERE 
    bd.campaign_id IN (SELECT campaign_id FROM campaign_matches)
    AND bd.date >= DATE_SUB(CURRENT_DATE(), INTERVAL (SELECT current_period_days FROM config) DAY)
    AND bd.platform = 'Meta'
    AND (SELECT include_creative_analysis FROM config) = true
  GROUP BY bd.campaign_id, bd.ad_name, creative_concept
  HAVING creative_spend >= 100 AND creative_conversions >= 2
  ORDER BY creative_cpa ASC
  LIMIT 10
)

-- 1. EXECUTIVE SUMMARY
SELECT 
  'EXECUTIVE_SUMMARY' as section,
  JSON_OBJECT(
    'analysis_type', (SELECT comparison_type FROM config),
    'search_terms', (SELECT target_campaigns FROM config),
    'totals', JSON_OBJECT(
      'campaigns', (SELECT total_campaigns FROM executive_summary),
      'spend', (SELECT ROUND(total_spend, 2) FROM executive_summary),
      'conversions', (SELECT total_conversions FROM executive_summary),
      'blended_cpa', (SELECT ROUND(blended_cpa, 2) FROM executive_summary)
    ),
    'performance_distribution', JSON_OBJECT(
      'excellent', (SELECT excellent_count FROM executive_summary),
      'good', (SELECT good_count FROM executive_summary), 
      'acceptable', (SELECT acceptable_count FROM executive_summary),
      'needs_attention', (SELECT needs_attention_count FROM executive_summary)
    ),
    'platform_distribution', JSON_OBJECT(
      'meta', (SELECT meta_count FROM executive_summary),
      'google', (SELECT google_count FROM executive_summary),
      'tiktok', (SELECT tiktok_count FROM executive_summary)
    ),
    'country_distribution', JSON_OBJECT(
      'us', (SELECT us_count FROM executive_summary),
      'uk', (SELECT uk_count FROM executive_summary),
      'ca', (SELECT ca_count FROM executive_summary),
      'au', (SELECT au_count FROM executive_summary)
    )
  ) as summary_data

UNION ALL

-- 2. PLATFORM PERFORMANCE GROUPS
SELECT 
  'PLATFORM_PERFORMANCE' as section,
  JSON_OBJECT(
    'platform_groups', ARRAY_AGG(JSON_OBJECT(
      'platform', platform,
      'performance_tier', performance_rating,
      'campaign_count', campaign_count,
      'total_spend', group_spend,
      'total_conversions', group_conversions,
      'avg_cpa', group_cpa,
      'sample_problem_campaigns', CASE WHEN performance_rating = 'NEEDS_ATTENTION' THEN problem_campaigns ELSE NULL END
    ))
  ) as summary_data
FROM platform_groups

UNION ALL

-- 3. DETAILED CAMPAIGN DATA (Only for problem campaigns)
SELECT 
  'PROBLEM_CAMPAIGNS_DETAIL' as section,
  JSON_OBJECT(
    'campaigns_needing_attention', ARRAY_AGG(JSON_OBJECT(
      'campaign_name', campaign,
      'platform', platform,
      'country', country,
      'current_period', JSON_OBJECT(
        'spend', ROUND(spend_current, 2),
        'conversions', conversions_current,
        'cpa', ROUND(cpa_current, 2),
        'ctr', ROUND(ctr_current, 2),
        'cvr', ROUND(cvr_current, 2)
      ),
      'comparison_period', JSON_OBJECT(
        'spend', ROUND(COALESCE(spend_comparison, 0), 2),
        'conversions', COALESCE(conversions_comparison, 0),
        'cpa', ROUND(COALESCE(cpa_comparison, 0), 2)
      ),
      'changes', JSON_OBJECT(
        'cpa_change_pct', ROUND(COALESCE(cpa_change_pct, 0), 1),
        'ctr_change_pct', ROUND(COALESCE(ctr_change_pct, 0), 1),
        'cvr_change_pct', ROUND(COALESCE(cvr_change_pct, 0), 1)
      ),
      'performance_rating', performance_rating
    ))
  ) as summary_data
FROM campaign_performance
WHERE performance_rating = 'NEEDS_ATTENTION'
ORDER BY spend_current DESC
LIMIT 15

UNION ALL

-- 4. TOP PERFORMERS (Brief list)
SELECT 
  'TOP_PERFORMERS' as section,
  JSON_OBJECT(
    'excellent_campaigns', ARRAY_AGG(JSON_OBJECT(
      'campaign_name', SUBSTR(campaign, 1, 80),
      'platform', platform,
      'country', country,
      'cpa', ROUND(cpa_current, 2),
      'spend', ROUND(spend_current, 2),
      'conversions', conversions_current
    ))
  ) as summary_data
FROM campaign_performance
WHERE performance_rating = 'EXCELLENT'
ORDER BY spend_current DESC
LIMIT 10

UNION ALL

-- 5. CREATIVE ANALYSIS (if requested)
SELECT 
  'CREATIVE_ANALYSIS' as section,
  JSON_OBJECT(
    'note', CASE WHEN (SELECT include_creative_analysis FROM config) THEN 'Meta creative performance included' ELSE 'Creative analysis not requested' END,
    'top_creatives', CASE 
      WHEN (SELECT include_creative_analysis FROM config) THEN
        ARRAY_AGG(JSON_OBJECT(
          'ad_name', ad_name,
          'creative_concept', creative_concept,
          'spend', ROUND(creative_spend, 2),
          'conversions', creative_conversions,
          'cpa', ROUND(creative_cpa, 2)
        ))
      ELSE []
    END
  ) as summary_data
FROM creative_analysis

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
						text: `Campaign Analysis (${comparison_period})\nSearch terms: ${campaign_names.join(', ')}\nCreative analysis: ${include_creatives ? 'Included' : 'Not included'}\n\nResults:\n${data}`
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