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
import { 
	ANOMALY_DETECTION, 
	PLATFORM_TARGETS, 
	WEBHOOK_CONFIG, 
	DEFAULT_COUNTRIES, 
	DEFAULT_PLATFORMS,
	UTILITIES 
} from "../settings";

/**
 * Register the anomaly detection tool - identifies performance anomalies and unusual patterns
 */
export function registerAnomalyDetectionTool(server: McpServer) {
	server.tool(
		"anomaly_detection",
		{
			sensitivity: z.enum(["high", "medium", "low"]).default("medium").describe(
				"Detection sensitivity: 'high' catches minor anomalies, 'medium' for notable changes, 'low' for major issues only"
			),
			platforms: z.array(z.enum(["Meta", "Google", "Bing"])).default(DEFAULT_PLATFORMS).describe(
				"Platforms to analyze for anomalies. Default includes all platforms"
			),
			countries: z.array(z.string()).default(DEFAULT_COUNTRIES).describe(
				"Countries to analyze. Default: ['US', 'AU', 'UK']"
			),
			min_impact_threshold: z.number().default(1000).describe(
				"Minimum spend threshold for anomaly inclusion. Use 500 for broader detection, 2000+ for high-impact only"
			),
		},
		async ({ sensitivity, platforms, countries, min_impact_threshold }: {
			sensitivity: "high" | "medium" | "low";
			platforms: ("Meta" | "Google" | "Bing")[];
			countries: string[];
			min_impact_threshold: number;
		}) => {
			try {
				// Validate and clean inputs
				const cleanPlatforms = validateAndCleanInput(platforms) as string[];
				const cleanCountries = validateAndCleanInput(countries) as string[];
				const safeMinImpact = Math.max(100, Math.min(min_impact_threshold, 50000));
				
				// Get sensitivity configuration from settings
				const config = ANOMALY_DETECTION.SENSITIVITY_LEVELS[sensitivity];
				
				// Build safe SQL components
				const platformFilter = createInClause(cleanPlatforms, 'platform');
				const countryFilter = createInClause(cleanCountries, 'country');
				const currentDateFilter = buildDateFilter(7);
				const comparisonDateFilter = buildComparisonDateFilter(7, 14);

				const query = `
-- Anomaly Detection Analysis - Performance Pattern Detection
-- Identifies unusual patterns and performance shifts requiring investigation
-- Sensitivity: ${sensitivity} (${config.change_threshold * 100}% threshold)

WITH 
-- Step 1: Current period performance (last 7 days)
current_period AS (
  SELECT
    platform,
    country,
    campaign_objective,
    campaign_id,
    campaign,
    SUM(spend) as spend_current,
    SUM(conversions) as conversions_current,
    ${safeCpaCalculation('SUM(spend)', 'SUM(conversions)')} as cpa_current,
    ${safeCtrCalculation('SUM(clicks)', 'SUM(impressions)')} as ctr_current,
    ${safeCvrCalculation('SUM(conversions)', 'SUM(clicks)')} as cvr_current,
    COUNT(DISTINCT date) as active_days_current
  FROM ${BLENDED_SUMMARY_TABLE}
  WHERE 
    ${currentDateFilter}
    AND ${platformFilter}
    AND ${countryFilter}
    AND spend > 0
  GROUP BY platform, country, campaign_objective, campaign_id, campaign
),

-- Step 2: Comparison period performance (7-14 days ago)
comparison_period AS (
  SELECT
    platform,
    country,
    campaign_objective,
    campaign_id,
    campaign,
    SUM(spend) as spend_comparison,
    SUM(conversions) as conversions_comparison,
    ${safeCpaCalculation('SUM(spend)', 'SUM(conversions)')} as cpa_comparison,
    ${safeCtrCalculation('SUM(clicks)', 'SUM(impressions)')} as ctr_comparison,
    ${safeCvrCalculation('SUM(conversions)', 'SUM(clicks)')} as cvr_comparison,
    COUNT(DISTINCT date) as active_days_comparison
  FROM ${BLENDED_SUMMARY_TABLE}
  WHERE 
    ${comparisonDateFilter}
    AND ${platformFilter}
    AND ${countryFilter}
    AND spend > 0
  GROUP BY platform, country, campaign_objective, campaign_id, campaign
),

-- Step 3: Campaign-level anomaly detection
campaign_anomalies AS (
  SELECT
    cp.platform,
    cp.country,
    cp.campaign_objective,
    cp.campaign_id,
    cp.campaign,
    cp.spend_current,
    cp.conversions_current,
    cp.cpa_current,
    cp.ctr_current,
    cp.cvr_current,
    comp.spend_comparison,
    comp.conversions_comparison,
    comp.cpa_comparison,
    comp.ctr_comparison,
    comp.cvr_comparison,
    
    -- Platform targets from settings
    CASE cp.platform 
      WHEN 'Meta' THEN ${PLATFORM_TARGETS.Meta}
      WHEN 'Google' THEN ${PLATFORM_TARGETS.Google}
      WHEN 'Bing' THEN ${PLATFORM_TARGETS.Bing}
      ELSE ${PLATFORM_TARGETS.Default}
    END as target_cpa,
    
    -- Calculate changes safely
    CASE 
      WHEN comp.cpa_comparison IS NOT NULL AND comp.cpa_comparison > 0 THEN
        (cp.cpa_current - comp.cpa_comparison) / comp.cpa_comparison
      ELSE NULL
    END as cpa_change_pct,
    
    CASE 
      WHEN comp.ctr_comparison IS NOT NULL AND comp.ctr_comparison > 0 THEN
        (cp.ctr_current - comp.ctr_comparison) / comp.ctr_comparison
      ELSE NULL
    END as ctr_change_pct,
    
    CASE 
      WHEN comp.cvr_comparison IS NOT NULL AND comp.cvr_comparison > 0 THEN
        (cp.cvr_current - comp.cvr_comparison) / comp.cvr_comparison
      ELSE NULL
    END as cvr_change_pct,
    
    CASE 
      WHEN comp.spend_comparison IS NOT NULL AND comp.spend_comparison > 0 THEN
        (cp.spend_current - comp.spend_comparison) / comp.spend_comparison
      ELSE NULL
    END as spend_change_pct,
    
    -- Confidence scoring using settings
    CASE
      WHEN cp.spend_current >= ${config.min_spend * 4} AND cp.conversions_current >= ${config.min_conversions * 3} THEN 'HIGH'
      WHEN cp.spend_current >= ${config.min_spend * 2} AND cp.conversions_current >= ${config.min_conversions * 2} THEN 'MEDIUM'
      WHEN cp.spend_current >= ${config.min_spend} AND cp.conversions_current >= ${config.min_conversions} THEN 'LOW'
      ELSE 'INSUFFICIENT'
    END as confidence_level,
    
    -- Excess cost calculation using settings
    CASE 
      WHEN cp.cpa_current > (CASE cp.platform 
        WHEN 'Meta' THEN ${PLATFORM_TARGETS.Meta}
        WHEN 'Google' THEN ${PLATFORM_TARGETS.Google}
        WHEN 'Bing' THEN ${PLATFORM_TARGETS.Bing}
        ELSE ${PLATFORM_TARGETS.Default}
      END) THEN
        (cp.cpa_current - (CASE cp.platform 
          WHEN 'Meta' THEN ${PLATFORM_TARGETS.Meta}
          WHEN 'Google' THEN ${PLATFORM_TARGETS.Google}
          WHEN 'Bing' THEN ${PLATFORM_TARGETS.Bing}
          ELSE ${PLATFORM_TARGETS.Default}
        END)) * cp.conversions_current
      ELSE 0
    END as excess_cost
    
  FROM current_period cp
  LEFT JOIN comparison_period comp 
    ON cp.campaign_id = comp.campaign_id
    AND cp.platform = comp.platform
    AND cp.country = comp.country
  WHERE cp.spend_current >= ${safeMinImpact}
),

-- Step 4: Regional anomaly patterns
regional_anomalies AS (
  SELECT
    platform,
    country,
    SUM(spend_current) as total_spend_current,
    SUM(conversions_current) as total_conversions_current,
    ${safeCpaCalculation('SUM(spend_current)', 'SUM(conversions_current)')} as blended_cpa_current,
    SUM(spend_comparison) as total_spend_comparison,
    SUM(conversions_comparison) as total_conversions_comparison,
    ${safeCpaCalculation('SUM(spend_comparison)', 'SUM(conversions_comparison)')} as blended_cpa_comparison,
    
    -- Regional change calculation
    CASE 
      WHEN ${safeCpaCalculation('SUM(spend_comparison)', 'SUM(conversions_comparison)')} IS NOT NULL 
           AND ${safeCpaCalculation('SUM(spend_comparison)', 'SUM(conversions_comparison)')} > 0 THEN
        (${safeCpaCalculation('SUM(spend_current)', 'SUM(conversions_current)')} - 
         ${safeCpaCalculation('SUM(spend_comparison)', 'SUM(conversions_comparison)')}) /
        ${safeCpaCalculation('SUM(spend_comparison)', 'SUM(conversions_comparison)')}
      ELSE NULL
    END as regional_cpa_change,
    
    -- Campaign distribution
    COUNT(*) as campaign_count,
    COUNT(CASE WHEN confidence_level = 'HIGH' THEN 1 END) as high_confidence_campaigns,
    COUNT(CASE WHEN ABS(COALESCE(cpa_change_pct, 0)) >= ${config.change_threshold} THEN 1 END) as volatile_campaigns,
    SUM(excess_cost) as total_excess_cost
    
  FROM campaign_anomalies
  WHERE confidence_level != 'INSUFFICIENT'
  GROUP BY platform, country
),

-- Step 5: Pre-filter anomalies to avoid LIMIT in UNION
significant_campaign_anomalies AS (
  SELECT *
  FROM campaign_anomalies
  WHERE confidence_level != 'INSUFFICIENT'
    AND (
      ABS(COALESCE(cpa_change_pct, 0)) >= ${config.change_threshold}
      OR ABS(COALESCE(ctr_change_pct, 0)) >= ${config.change_threshold}
      OR ABS(COALESCE(cvr_change_pct, 0)) >= ${config.change_threshold}
      OR ABS(COALESCE(spend_change_pct, 0)) >= ${config.change_threshold * 2}
      OR excess_cost >= ${ANOMALY_DETECTION.MIN_EXCESS_COST}
    )
  ORDER BY 
    CASE 
      WHEN excess_cost > 0 THEN excess_cost
      ELSE ABS(COALESCE(cpa_change_pct, 0)) * spend_current
    END DESC
  LIMIT ${ANOMALY_DETECTION.MAX_CAMPAIGN_ANOMALIES}
),

significant_regional_anomalies AS (
  SELECT *
  FROM regional_anomalies
  WHERE total_spend_current >= ${safeMinImpact}
    AND (
      ABS(COALESCE(regional_cpa_change, 0)) >= ${config.change_threshold}
      OR volatile_campaigns >= 2
      OR total_excess_cost >= ${ANOMALY_DETECTION.MIN_REGIONAL_EXCESS_COST}
    )
  ORDER BY 
    CASE 
      WHEN total_excess_cost > 0 THEN total_excess_cost
      ELSE ABS(COALESCE(regional_cpa_change, 0)) * total_spend_current
    END DESC
  LIMIT ${ANOMALY_DETECTION.MAX_REGIONAL_ANOMALIES}
)

-- Output 1: Anomaly Summary
SELECT 
  'ANOMALY_SUMMARY' as section,
  JSON_OBJECT(
    'detection_sensitivity', '${sensitivity}',
    'change_threshold_pct', ${config.change_threshold * 100},
    'platforms_analyzed', ARRAY[${cleanPlatforms.map(p => `'${p.replace(/'/g, "\\'")}'`).join(', ')}],
    'countries_analyzed', ARRAY[${cleanCountries.map(c => `'${c.replace(/'/g, "\\'")}'`).join(', ')}],
    'min_impact_threshold', ${safeMinImpact},
    'total_campaign_anomalies', (SELECT COUNT(*) FROM significant_campaign_anomalies),
    'total_regional_anomalies', (SELECT COUNT(*) FROM significant_regional_anomalies),
    'total_excess_cost', ROUND((SELECT SUM(excess_cost) FROM significant_campaign_anomalies), 2)
  ) as summary_data

UNION ALL

-- Output 2: Campaign-Level Anomalies
SELECT 
  'CAMPAIGN_ANOMALIES' as section,
  JSON_OBJECT(
    'significant_campaign_changes', ARRAY_AGG(
      JSON_OBJECT(
        'campaign_name', SUBSTR(campaign, 1, 80),
        'platform', platform,
        'country', country,
        'campaign_objective', campaign_objective,
        'current_spend', ROUND(spend_current, 2),
        'current_conversions', conversions_current,
        'current_cpa', ROUND(cpa_current, 2),
        'target_cpa', target_cpa,
        'cpa_change_pct', ROUND(COALESCE(cpa_change_pct, 0) * 100, 1),
        'ctr_change_pct', ROUND(COALESCE(ctr_change_pct, 0) * 100, 1),
        'cvr_change_pct', ROUND(COALESCE(cvr_change_pct, 0) * 100, 1),
        'spend_change_pct', ROUND(COALESCE(spend_change_pct, 0) * 100, 1),
        'confidence_level', confidence_level,
        'excess_cost', ROUND(excess_cost, 2),
        'anomaly_type', CASE 
          WHEN ABS(COALESCE(cpa_change_pct, 0)) >= ${config.change_threshold} THEN 'CPA_SHIFT'
          WHEN ABS(COALESCE(ctr_change_pct, 0)) >= ${config.change_threshold} THEN 'CTR_SHIFT'
          WHEN ABS(COALESCE(cvr_change_pct, 0)) >= ${config.change_threshold} THEN 'CVR_SHIFT'
          WHEN ABS(COALESCE(spend_change_pct, 0)) >= ${config.change_threshold * 2} THEN 'SPEND_SHIFT'
          WHEN excess_cost >= ${ANOMALY_DETECTION.MIN_EXCESS_COST} THEN 'COST_OVERRUN'
          ELSE 'MULTIPLE_SIGNALS'
        END
      ) ORDER BY 
        CASE 
          WHEN excess_cost > 0 THEN excess_cost
          ELSE ABS(COALESCE(cpa_change_pct, 0)) * spend_current
        END DESC
    )
  ) as summary_data
FROM significant_campaign_anomalies

UNION ALL

-- Output 3: Regional Pattern Anomalies
SELECT 
  'REGIONAL_ANOMALIES' as section,
  JSON_OBJECT(
    'regional_pattern_changes', ARRAY_AGG(
      JSON_OBJECT(
        'platform', platform,
        'country', country,
        'total_spend_current', ROUND(total_spend_current, 2),
        'total_conversions_current', total_conversions_current,
        'blended_cpa_current', ROUND(blended_cpa_current, 2),
        'blended_cpa_comparison', ROUND(COALESCE(blended_cpa_comparison, 0), 2),
        'regional_cpa_change_pct', ROUND(COALESCE(regional_cpa_change, 0) * 100, 1),
        'campaign_count', campaign_count,
        'high_confidence_campaigns', high_confidence_campaigns,
        'volatile_campaigns', volatile_campaigns,
        'total_excess_cost', ROUND(total_excess_cost, 2),
        'pattern_type', CASE 
          WHEN volatile_campaigns >= campaign_count * 0.5 THEN 'WIDESPREAD_VOLATILITY'
          WHEN ABS(COALESCE(regional_cpa_change, 0)) >= ${config.change_threshold * 1.5} THEN 'MAJOR_SHIFT'
          WHEN total_excess_cost >= 2000 THEN 'HIGH_COST_IMPACT'
          ELSE 'NOTABLE_CHANGE'
        END
      ) ORDER BY 
        CASE 
          WHEN total_excess_cost > 0 THEN total_excess_cost
          ELSE ABS(COALESCE(regional_cpa_change, 0)) * total_spend_current
        END DESC
    )
  ) as summary_data
FROM significant_regional_anomalies

ORDER BY section;
`;

				const response = await fetch(WEBHOOK_CONFIG.URL, {
					method: "POST",
					headers: {
						"Content-Type": WEBHOOK_CONFIG.HEADERS['Content-Type'],
						"User-Agent": `${WEBHOOK_CONFIG.HEADERS['User-Agent-Prefix']}-Anomaly-Detection/1.0`,
					},
					body: JSON.stringify({
						query: query
					}),
				});

				if (!response.ok) {
					return {
						content: [{
							type: "text",
							text: `Error: Failed to execute anomaly detection. Status: ${response.status} ${response.statusText}`
						}]
					};
				}

				const data = await response.text();
				
				return {
					content: [{
						type: "text",
						text: `Anomaly Detection Report\nSensitivity: ${sensitivity} (${config.change_threshold * 100}% threshold)\nPlatforms: ${cleanPlatforms.join(', ')}\nCountries: ${cleanCountries.join(', ')}\nMin Impact: $${safeMinImpact}\n\nResults:\n${data}`
					}]
				};
			} catch (error) {
				return {
					content: [{
						type: "text",
						text: `Error detecting anomalies: ${error instanceof Error ? error.message : String(error)}`
					}]
				};
			}
		}
	);
} 