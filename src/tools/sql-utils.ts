/**
 * SQL Utilities for BigQuery - Safe parameter handling and common patterns
 */

import { BIGQUERY_CONFIG, PERFORMANCE_THRESHOLDS, DATE_RANGES, COMPARISON_PERIODS, FLEXIBLE_QUERY, IMPRESSION_SHARE } from "../settings";

/**
 * Safely escape a string value for SQL LIKE queries
 */
export function escapeLikeValue(value: string): string {
	return value
		.replace(/\\/g, '\\\\')  // Escape backslashes first
		.replace(/'/g, "\\'")    // Escape single quotes
		.replace(/%/g, '\\%')    // Escape SQL LIKE wildcards
		.replace(/_/g, '\\_');   // Escape SQL LIKE wildcards
}

/**
 * Create safe SQL LIKE conditions for campaign name matching
 */
export function createCampaignMatchConditions(campaignNames: string[]): string {
	if (!campaignNames || campaignNames.length === 0) {
		return '1=0'; // No matches if empty array
	}
	
	const conditions = campaignNames.map(name => {
		const escaped = escapeLikeValue(name.trim());
		return `LOWER(campaign) LIKE LOWER('%${escaped}%')`;
	});
	
	return `(${conditions.join(' OR ')})`;
}

/**
 * Create safe IN clause for array parameters
 */
export function createInClause(values: string[], columnName: string): string {
	if (!values || values.length === 0) {
		return '1=0'; // No matches if empty array
	}
	
	const escapedValues = values.map(val => `'${val.replace(/'/g, "\\'")}'`);
	return `${columnName} IN (${escapedValues.join(', ')})`;
}

/**
 * Get numeric days value from date range enum
 */
export function getDaysFromRange(dateRange: '7d' | '14d' | '30d'): number {
	return DATE_RANGES[dateRange] || 7;
}

/**
 * Get comparison period days for trend analysis
 */
export function getComparisonDays(comparisonType: 'week_over_week' | 'month_over_month'): { current: number; comparison: number } {
	return COMPARISON_PERIODS[comparisonType] || COMPARISON_PERIODS.week_over_week;
}

/**
 * Build safe date filter for current period
 */
export function buildDateFilter(days: number, alias?: string): string {
	const tableRef = alias ? `${alias}.` : '';
	return `${tableRef}date >= DATE_SUB(CURRENT_DATE(), INTERVAL ${days} DAY)`;
}

/**
 * Build safe date filter for comparison period
 */
export function buildComparisonDateFilter(currentDays: number, totalDays: number, alias?: string): string {
	const tableRef = alias ? `${alias}.` : '';
	return `${tableRef}date >= DATE_SUB(CURRENT_DATE(), INTERVAL ${totalDays} DAY) AND ${tableRef}date < DATE_SUB(CURRENT_DATE(), INTERVAL ${currentDays} DAY)`;
}

/**
 * Standard BigQuery table references
 */
export const BLENDED_SUMMARY_TABLE = BIGQUERY_CONFIG.BLENDED_SUMMARY_TABLE;
export const IMPRESSION_SHARE_TABLE = BIGQUERY_CONFIG.IMPRESSION_SHARE_TABLE;

/**
 * Common performance rating classification
 */
export function getPerformanceRatingCase(cpaColumn: string = 'cpa'): string {
	return `CASE
		WHEN ${cpaColumn} <= ${PERFORMANCE_THRESHOLDS.EXCELLENT} THEN 'EXCELLENT'
		WHEN ${cpaColumn} <= ${PERFORMANCE_THRESHOLDS.GOOD} THEN 'GOOD'
		WHEN ${cpaColumn} <= ${PERFORMANCE_THRESHOLDS.ACCEPTABLE} THEN 'ACCEPTABLE'
		ELSE 'NEEDS_ATTENTION'
	END`;
}

/**
 * Standard CPA calculation with safety
 */
export function safeCpaCalculation(spendColumn: string = 'spend', conversionsColumn: string = 'conversions'): string {
	return `SAFE_DIVIDE(${spendColumn}, NULLIF(${conversionsColumn}, 0))`;
}

/**
 * Standard CTR calculation as percentage
 */
export function safeCtrCalculation(clicksColumn: string = 'clicks', impressionsColumn: string = 'impressions'): string {
	return `SAFE_DIVIDE(${clicksColumn}, NULLIF(${impressionsColumn}, 0)) * 100`;
}

/**
 * Standard CVR calculation as percentage
 */
export function safeCvrCalculation(conversionsColumn: string = 'conversions', clicksColumn: string = 'clicks'): string {
	return `SAFE_DIVIDE(${conversionsColumn}, NULLIF(${clicksColumn}, 0)) * 100`;
}

/**
 * Create safe platform pivot aggregation (avoids aggregations of aggregations error)
 * @param metric - The metric to aggregate (e.g., 'spend', 'conversions')
 * @param platforms - Array of platform names to pivot
 * @param precision - Number of decimal places for rounding (default: 2)
 */
export function createPlatformPivot(metric: string, platforms: string[], precision: number = 2): string {
	const pivotColumns = platforms.map(platform => {
		const safeColumnName = platform.toLowerCase().replace(/[^a-z0-9]/g, '_');
		if (precision === 0) {
			return `ROUND(SUM(CASE WHEN platform = '${platform}' THEN ${metric} END), 0) as ${safeColumnName}_${metric}`;
		} else {
			return `ROUND(SUM(CASE WHEN platform = '${platform}' THEN ${metric} END), ${precision}) as ${safeColumnName}_${metric}`;
		}
	});
	
	return pivotColumns.join(',\n  ');
}

/**
 * Create safe platform CPA pivot (handles division safely)
 */
export function createPlatformCpaPivot(platforms: string[]): string {
	const cpaPivots = platforms.map(platform => {
		const safeColumnName = platform.toLowerCase().replace(/[^a-z0-9]/g, '_');
		return `ROUND(SAFE_DIVIDE(
      SUM(CASE WHEN platform = '${platform}' THEN spend END), 
      SUM(CASE WHEN platform = '${platform}' THEN conversions END)
    ), 2) as ${safeColumnName}_cpa`;
	});
	
	return cpaPivots.join(',\n  ');
}

/**
 * Validate and clean user input
 */
export function validateAndCleanInput(input: any): any {
	if (typeof input === 'string') {
		return input.trim().substring(0, 200); // Limit length
	}
	if (Array.isArray(input)) {
		return input.slice(0, 20).map(item => validateAndCleanInput(item)); // Limit array size
	}
	return input;
}

/**
 * Validate and clean SQL query input - allows longer queries for complex analytics
 */
export function validateAndCleanSqlQuery(query: string): string {
	if (typeof query !== 'string') {
		throw new Error('Query must be a string');
	}
	
	// Trim whitespace
	const cleaned = query.trim();
	
	// Reasonable length limit for SQL queries from settings
	if (cleaned.length > FLEXIBLE_QUERY.MAX_QUERY_LENGTH) {
		throw new Error(`Query too long - maximum ${FLEXIBLE_QUERY.MAX_QUERY_LENGTH} characters allowed`);
	}
	
	// Basic SQL injection patterns from settings
	const dangerousPatterns = FLEXIBLE_QUERY.DANGEROUS_PATTERNS;
	
	for (const pattern of dangerousPatterns) {
		if (pattern.test(cleaned)) {
			throw new Error('Query contains potentially dangerous SQL patterns');
		}
	}
	
	return cleaned;
}

/**
 * Impression Share Analysis Utilities
 */

/**
 * Calculate total lost impression share safely
 */
export function getTotalLostImpressionShare(): string {
	return `COALESCE(budget_lost_impression_share_pct, 0) + COALESCE(rank_lost_impression_share_pct, 0)`;
}

/**
 * Get opportunity type based on lost impression share breakdown
 */
export function getOpportunityTypeCase(): string {
	return `CASE 
		WHEN COALESCE(budget_lost_impression_share_pct, 0) >= ${IMPRESSION_SHARE.HIGH_BUDGET_LOST} THEN 'BUDGET_OPPORTUNITY'
		WHEN COALESCE(rank_lost_impression_share_pct, 0) >= ${IMPRESSION_SHARE.HIGH_RANK_LOST} THEN 'RANK_OPPORTUNITY'
		WHEN COALESCE(budget_lost_impression_share_pct, 0) >= ${IMPRESSION_SHARE.ACTIONABLE_THRESHOLD} THEN 'BUDGET_CONSTRAINED'
		WHEN COALESCE(rank_lost_impression_share_pct, 0) >= ${IMPRESSION_SHARE.ACTIONABLE_THRESHOLD} THEN 'RANK_IMPROVEMENT'
		WHEN ${getTotalLostImpressionShare()} >= ${IMPRESSION_SHARE.ACTIONABLE_THRESHOLD} THEN 'MIXED_OPPORTUNITY'
		ELSE 'OPTIMIZED'
	END`;
}

/**
 * Get budget utilization status
 */
export function getBudgetUtilizationStatus(): string {
	return `CASE 
		WHEN budget_utilization_pct >= ${IMPRESSION_SHARE.HIGH_BUDGET_UTILIZATION} THEN 'CONSTRAINED'
		WHEN budget_utilization_pct <= ${IMPRESSION_SHARE.LOW_BUDGET_UTILIZATION} THEN 'UNDERUTILIZED'
		ELSE 'BALANCED'
	END`;
}

/**
 * Safe impression share change calculation
 */
export function safeImpressionShareChange(currentColumn: string, previousColumn: string): string {
	return `CASE 
		WHEN ${previousColumn} IS NOT NULL AND ${previousColumn} > 0 THEN
			ROUND((${currentColumn} - ${previousColumn}) / ${previousColumn} * 100, 1)
		ELSE NULL
	END`;
}

/**
 * Calculate market opportunity score (0-100 scale)
 */
export function getMarketOpportunityScore(): string {
	return `CASE 
		WHEN ${getTotalLostImpressionShare()} >= 50 THEN 90 + (COALESCE(market_size_impressions, 0) / 100000)
		WHEN ${getTotalLostImpressionShare()} >= 30 THEN 70 + (${getTotalLostImpressionShare()} * 0.5)
		WHEN ${getTotalLostImpressionShare()} >= 15 THEN 50 + (${getTotalLostImpressionShare()} * 0.8)
		ELSE 20 + (${getTotalLostImpressionShare()} * 1.5)
	END`;
} 