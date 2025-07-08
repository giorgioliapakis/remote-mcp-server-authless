import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Register the creative analysis tool - Meta creative performance insights
 */
export function registerCreativeAnalysisTool(server: McpServer) {
	server.tool(
		"creative_analysis",
		{
			date_range: z.enum(["7d", "14d", "30d"]).default("14d").describe(
				"Analysis period. Use '7d' for recent performance, '14d' for balanced view, '30d' for longer trends"
			),
			countries: z.array(z.string()).default(["US", "AU", "UK"]).describe(
				"Countries to analyze. Use specific countries when user mentions regions (e.g., ['US'] for America, ['AU'] for Australia)"
			),
			min_spend: z.number().default(300).describe(
				"Minimum spend threshold for creative inclusion. Use 100 for broader view, 500+ for high-spend creatives only"
			),
			sort_by: z.enum(["cpa", "spend", "conversions"]).default("cpa").describe(
				"Sort creatives by: 'cpa' for efficiency, 'spend' for scale, 'conversions' for volume"
			),
		},
		async ({ date_range, countries, min_spend, sort_by }) => {
			try {
				const query = `
-- Meta Creative Performance Analysis
-- Summarized creative insights to avoid context overload
-- Focus on concept patterns and performance distribution

WITH 
config AS (
  SELECT
    ${date_range === "7d" ? "7" : date_range === "14d" ? "14" : "30"} as analysis_days,
    ${JSON.stringify(countries)} as target_countries,
    ${min_spend} as min_spend_threshold,
    '${sort_by}' as sort_metric
),

creative_data AS (
  SELECT
    bd.ad_id,
    bd.ad_name,
    bd.country,
    -- Parse Meta creative components
    CASE 
      WHEN bd.ad_name IS NOT NULL THEN
        TRIM(SPLIT(bd.ad_name, ' // ')[SAFE_OFFSET(0)])
      ELSE 'Unknown_Concept'
    END as creative_concept,
    CASE 
      WHEN bd.ad_name IS NOT NULL THEN
        TRIM(SPLIT(bd.ad_name, ' // ')[SAFE_OFFSET(2)])
      ELSE NULL
    END as creative_format,
    CASE 
      WHEN bd.ad_name IS NOT NULL THEN
        TRIM(SPLIT(bd.ad_name, ' // ')[SAFE_OFFSET(3)])
      ELSE NULL
    END as creative_creator,
    SUM(bd.spend) as total_spend,
    SUM(bd.conversions) as total_conversions,
    SAFE_DIVIDE(SUM(bd.spend), NULLIF(SUM(bd.conversions), 0)) as cpa,
    SAFE_DIVIDE(SUM(bd.clicks), NULLIF(SUM(bd.impressions), 0)) * 100 as ctr,
    SAFE_DIVIDE(SUM(bd.conversions), NULLIF(SUM(bd.clicks), 0)) * 100 as cvr
  FROM \`exemplary-terra-463404-m1.linktree_analytics.blended_summary\` bd
  WHERE 
    bd.date >= DATE_SUB(CURRENT_DATE(), INTERVAL (SELECT analysis_days FROM config) DAY)
    AND bd.platform = 'Meta'
    AND bd.country IN UNNEST((SELECT target_countries FROM config))
    AND bd.spend > 0
  GROUP BY 
    bd.ad_id, bd.ad_name, bd.country, creative_concept, creative_format, creative_creator
  HAVING 
    total_spend >= (SELECT min_spend_threshold FROM config)
    AND total_conversions >= 2
),

concept_summary AS (
  SELECT
    creative_concept,
    COUNT(*) as ad_count,
    SUM(total_spend) as concept_spend,
    SUM(total_conversions) as concept_conversions,
    SAFE_DIVIDE(SUM(total_spend), NULLIF(SUM(total_conversions), 0)) as concept_cpa,
    AVG(ctr) as avg_ctr,
    AVG(cvr) as avg_cvr,
    -- Performance classification
    CASE
      WHEN SAFE_DIVIDE(SUM(total_spend), NULLIF(SUM(total_conversions), 0)) <= 25 THEN 'EXCELLENT'
      WHEN SAFE_DIVIDE(SUM(total_spend), NULLIF(SUM(total_conversions), 0)) <= 40 THEN 'GOOD'
      WHEN SAFE_DIVIDE(SUM(total_spend), NULLIF(SUM(total_conversions), 0)) <= 60 THEN 'ACCEPTABLE'
      ELSE 'NEEDS_ATTENTION'
    END as performance_tier
  FROM creative_data
  WHERE creative_concept IS NOT NULL
  GROUP BY creative_concept
  HAVING concept_spend >= (SELECT min_spend_threshold FROM config) * 2
),

top_performers AS (
  SELECT
    ad_name,
    creative_concept,
    creative_format,
    creative_creator,
    country,
    total_spend,
    total_conversions,
    cpa,
    ctr,
    cvr,
    -- Rank by selected metric
    ROW_NUMBER() OVER (
      ORDER BY 
        CASE '${sort_by}'
          WHEN 'cpa' THEN cpa
          WHEN 'spend' THEN -total_spend
          WHEN 'conversions' THEN -total_conversions
        END
    ) as performance_rank
  FROM creative_data
  ORDER BY performance_rank
  LIMIT 10
),

performance_distribution AS (
  SELECT
    performance_tier,
    COUNT(*) as concept_count,
    SUM(concept_spend) as tier_spend,
    AVG(concept_cpa) as avg_tier_cpa
  FROM concept_summary
  GROUP BY performance_tier
)

-- Output creative analysis summary
SELECT 
  'CREATIVE_OVERVIEW' as section,
  JSON_OBJECT(
    'analysis_period', CONCAT((SELECT analysis_days FROM config), ' days'),
    'countries_analyzed', (SELECT target_countries FROM config),
    'min_spend_threshold', (SELECT min_spend_threshold FROM config),
    'sort_criteria', (SELECT sort_metric FROM config),
    'total_creatives_analyzed', (SELECT COUNT(*) FROM creative_data),
    'total_concepts', (SELECT COUNT(*) FROM concept_summary),
    'performance_distribution', ARRAY_AGG(JSON_OBJECT(
      'tier', performance_tier,
      'concept_count', concept_count,
      'total_spend', ROUND(tier_spend, 2),
      'avg_cpa', ROUND(avg_tier_cpa, 2)
    ))
  ) as summary_data
FROM performance_distribution

UNION ALL

SELECT 
  'TOP_CONCEPTS' as section,
  JSON_OBJECT(
    'best_performing_concepts', ARRAY_AGG(JSON_OBJECT(
      'concept', creative_concept,
      'ad_count', ad_count,
      'total_spend', ROUND(concept_spend, 2),
      'conversions', concept_conversions,
      'cpa', ROUND(concept_cpa, 2),
      'avg_ctr', ROUND(avg_ctr, 2),
      'avg_cvr', ROUND(avg_cvr, 2),
      'performance_tier', performance_tier
    ))
  ) as summary_data
FROM concept_summary
ORDER BY concept_cpa ASC
LIMIT 8

UNION ALL

SELECT 
  'TOP_INDIVIDUAL_ADS' as section,
  JSON_OBJECT(
    'top_performers', ARRAY_AGG(JSON_OBJECT(
      'ad_name', ad_name,
      'concept', creative_concept,
      'format', creative_format,
      'creator', creative_creator,
      'country', country,
      'spend', ROUND(total_spend, 2),
      'conversions', total_conversions,
      'cpa', ROUND(cpa, 2),
      'ctr', ROUND(ctr, 2),
      'cvr', ROUND(cvr, 2),
      'rank', performance_rank
    ))
  ) as summary_data
FROM top_performers

ORDER BY section;
`;

				const webhookUrl = "https://n8n.wibci.dev/webhook-test/40df3a90-da64-4939-8813-839f12a43cee";
				
				const response = await fetch(webhookUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"User-Agent": "MCP-Creative-Analysis-Tool/1.0",
					},
					body: JSON.stringify({
						query: query
					}),
				});

				if (!response.ok) {
					return {
						content: [{
							type: "text",
							text: `Error: Failed to execute creative analysis. Status: ${response.status} ${response.statusText}`
						}]
					};
				}

				const data = await response.text();
				
				return {
					content: [{
						type: "text",
						text: `Creative Analysis Report (${date_range})\nCountries: ${countries.join(', ')}\nMin spend: $${min_spend}\nSorted by: ${sort_by}\n\nResults:\n${data}`
					}]
				};
			} catch (error) {
				return {
					content: [{
						type: "text",
						text: `Error analyzing creatives: ${error instanceof Error ? error.message : String(error)}`
					}]
				};
			}
		}
	);
} 