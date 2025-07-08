import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	createInClause,
	getDaysFromRange,
	buildDateFilter,
	BLENDED_SUMMARY_TABLE,
	getPerformanceRatingCase,
	safeCpaCalculation,
	safeCtrCalculation,
	safeCvrCalculation,
	validateAndCleanInput
} from "./sql-utils";

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
		async ({ date_range, countries, min_spend, sort_by }: {
			date_range: "7d" | "14d" | "30d";
			countries: string[];
			min_spend: number;
			sort_by: "cpa" | "spend" | "conversions";
		}) => {
			try {
				// Validate and clean inputs
				const cleanCountries = validateAndCleanInput(countries) as string[];
				const analysisDays = getDaysFromRange(date_range);
				const safeMinSpend = Math.max(50, Math.min(min_spend, 10000)); // Constrain min_spend
				
				// Build safe SQL components
				const countryFilter = createInClause(cleanCountries, 'country');
				const dateFilter = buildDateFilter(analysisDays);
				
				const query = `
-- Meta Creative Performance Analysis - FIXED VERSION
-- Eliminates subquery aggregation issues and uses safe parameter handling
-- Focus on creative concept patterns and performance distribution

WITH 
-- Step 1: Creative data with safe parsing and filtering
creative_data AS (
  SELECT
    ad_id,
    ad_name,
    country,
    -- Parse Meta creative components safely
    CASE 
      WHEN ad_name IS NOT NULL AND STRPOS(ad_name, ' // ') > 0 THEN
        TRIM(SPLIT(ad_name, ' // ')[SAFE_OFFSET(0)])
      WHEN ad_name IS NOT NULL THEN
        SUBSTR(ad_name, 1, 50)  -- Fallback for non-standard format
      ELSE 'Unknown_Concept'
    END as creative_concept,
    CASE 
      WHEN ad_name IS NOT NULL AND ARRAY_LENGTH(SPLIT(ad_name, ' // ')) > 2 THEN
        TRIM(SPLIT(ad_name, ' // ')[SAFE_OFFSET(2)])
      ELSE NULL
    END as creative_format,
    CASE 
      WHEN ad_name IS NOT NULL AND ARRAY_LENGTH(SPLIT(ad_name, ' // ')) > 3 THEN
        TRIM(SPLIT(ad_name, ' // ')[SAFE_OFFSET(3)])
      ELSE NULL
    END as creative_creator,
    SUM(spend) as total_spend,
    SUM(conversions) as total_conversions,
    ${safeCpaCalculation('SUM(spend)', 'SUM(conversions)')} as cpa,
    ${safeCtrCalculation('SUM(clicks)', 'SUM(impressions)')} as ctr,
    ${safeCvrCalculation('SUM(conversions)', 'SUM(clicks)')} as cvr
  FROM ${BLENDED_SUMMARY_TABLE}
  WHERE 
    ${dateFilter}
    AND platform = 'Meta'
    AND ${countryFilter}
    AND spend > 0
  GROUP BY 
    ad_id, ad_name, country, creative_concept, creative_format, creative_creator
  HAVING 
    total_spend >= ${safeMinSpend}
    AND total_conversions >= 2
),

-- Step 2: Concept-level summary with performance classification
concept_summary AS (
  SELECT
    creative_concept,
    COUNT(*) as ad_count,
    SUM(total_spend) as concept_spend,
    SUM(total_conversions) as concept_conversions,
    ${safeCpaCalculation('SUM(total_spend)', 'SUM(total_conversions)')} as concept_cpa,
    AVG(ctr) as avg_ctr,
    AVG(cvr) as avg_cvr,
    -- Performance classification using safe CPA calculation
    CASE
      WHEN ${safeCpaCalculation('SUM(total_spend)', 'SUM(total_conversions)')} <= 25 THEN 'EXCELLENT'
      WHEN ${safeCpaCalculation('SUM(total_spend)', 'SUM(total_conversions)')} <= 40 THEN 'GOOD'
      WHEN ${safeCpaCalculation('SUM(total_spend)', 'SUM(total_conversions)')} <= 60 THEN 'ACCEPTABLE'
      ELSE 'NEEDS_ATTENTION'
    END as performance_tier
  FROM creative_data
  WHERE creative_concept IS NOT NULL
  GROUP BY creative_concept
  HAVING concept_spend >= ${safeMinSpend} * 2  -- Concepts need 2x minimum spend
),

-- Step 3: Top individual performers with dynamic sorting
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
    -- Rank by selected metric safely
    ROW_NUMBER() OVER (
      ORDER BY 
        CASE '${sort_by}'
          WHEN 'cpa' THEN cpa
          WHEN 'spend' THEN -total_spend
          WHEN 'conversions' THEN -total_conversions
          ELSE cpa  -- Default fallback
        END
    ) as performance_rank
  FROM creative_data
  ORDER BY performance_rank
  LIMIT 10
),

-- Step 4: Performance distribution summary
performance_distribution AS (
  SELECT
    performance_tier,
    COUNT(*) as concept_count,
    SUM(concept_spend) as tier_spend,
    AVG(concept_cpa) as avg_tier_cpa
  FROM concept_summary
  GROUP BY performance_tier
),

-- Step 5: Pre-filter top concepts to avoid LIMIT in UNION
top_concepts_filtered AS (
  SELECT *
  FROM concept_summary
  ORDER BY concept_cpa ASC
  LIMIT 8
)

-- Output 1: Creative Overview
SELECT 
  'CREATIVE_OVERVIEW' as section,
  JSON_OBJECT(
    'analysis_period', '${date_range} (${analysisDays} days)',
    'countries_analyzed', ARRAY[${cleanCountries.map(c => `'${c.replace(/'/g, "\\'")}'`).join(', ')}],
    'min_spend_threshold', ${safeMinSpend},
    'sort_criteria', '${sort_by}',
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

-- Output 2: Top Performing Concepts
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
    ) ORDER BY concept_cpa ASC)
  ) as summary_data
FROM top_concepts_filtered

UNION ALL

-- Output 3: Top Individual Ads
SELECT 
  'TOP_INDIVIDUAL_ADS' as section,
  JSON_OBJECT(
    'sorting_note', 'Sorted by ${sort_by}',
    'top_performers', ARRAY_AGG(JSON_OBJECT(
      'ad_name', SUBSTR(ad_name, 1, 120),  -- Truncate long ad names
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
    ) ORDER BY performance_rank)
  ) as summary_data
FROM top_performers

ORDER BY section;
`;

				const webhookUrl = "https://n8n.wibci.dev/webhook/40df3a90-da64-4939-8813-839f12a43cee";
				
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
						text: `Creative Analysis Report (${date_range})\nCountries: ${cleanCountries.join(', ')}\nMin spend: $${safeMinSpend}\nSorted by: ${sort_by}\n\nResults:\n${data}`
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