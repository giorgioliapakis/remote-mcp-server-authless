/**
 * SQL Utilities for BigQuery - Safe parameter handling and common patterns
 */

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
	switch (dateRange) {
		case '7d': return 7;
		case '14d': return 14;
		case '30d': return 30;
		default: return 7;
	}
}

/**
 * Get comparison period days for trend analysis
 */
export function getComparisonDays(comparisonType: 'week_over_week' | 'month_over_month'): { current: number; comparison: number } {
	switch (comparisonType) {
		case 'week_over_week':
			return { current: 7, comparison: 14 };
		case 'month_over_month':
			return { current: 30, comparison: 60 };
		default:
			return { current: 7, comparison: 14 };
	}
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
 * Standard BigQuery table reference
 */
export const BLENDED_SUMMARY_TABLE = '`exemplary-terra-463404-m1.linktree_analytics.blended_summary`';

/**
 * Common performance rating classification
 */
export function getPerformanceRatingCase(cpaColumn: string = 'cpa'): string {
	return `CASE
		WHEN ${cpaColumn} <= 25 THEN 'EXCELLENT'
		WHEN ${cpaColumn} <= 40 THEN 'GOOD'
		WHEN ${cpaColumn} <= 60 THEN 'ACCEPTABLE'
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
	
	// Reasonable length limit for SQL queries (10KB)
	if (cleaned.length > 10000) {
		throw new Error('Query too long - maximum 10,000 characters allowed');
	}
	
	// Basic SQL injection patterns (beyond what we check in security validation)
	const dangerousPatterns = [
		/;\s*(DROP|CREATE|ALTER|INSERT|UPDATE|DELETE|TRUNCATE)/i,
		/--[^\r\n]*$/m, // SQL comments that might hide malicious code
		/\/\*[\s\S]*?\*\//g, // Multi-line SQL comments
		/\bxp_cmdshell\b/i,
		/\bsp_executesql\b/i
	];
	
	for (const pattern of dangerousPatterns) {
		if (pattern.test(cleaned)) {
			throw new Error('Query contains potentially dangerous SQL patterns');
		}
	}
	
	return cleaned;
} 