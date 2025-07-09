/**
 * Centralized Settings for MCP Analytics Tools
 * Configure thresholds, targets, and other variables here
 */

// Platform-specific CPA targets (in your currency)
export const PLATFORM_TARGETS = {
	Meta: 50.0,
	Google: 25.0,
	Bing: 25.0,
	TikTok: 50.0,
	Default: 40.0
} as const;

// Performance rating thresholds (CPA-based)
export const PERFORMANCE_THRESHOLDS = {
	EXCELLENT: 25.0,
	GOOD: 40.0,
	ACCEPTABLE: 60.0,
	// Above 60 = NEEDS_ATTENTION
} as const;

// Anomaly Detection Settings
export const ANOMALY_DETECTION = {
	// Sensitivity thresholds (percentage change)
	SENSITIVITY_LEVELS: {
		high: { 
			change_threshold: 0.15, // 15% change
			min_spend: 300, 
			min_conversions: 3 
		},
		medium: { 
			change_threshold: 0.25, // 25% change
			min_spend: 500, 
			min_conversions: 5 
		},
		low: { 
			change_threshold: 0.5, // 50% change
			min_spend: 1000, 
			min_conversions: 8 
		}
	},
	
	// Minimum impact thresholds
	MIN_EXCESS_COST: 500,
	MIN_REGIONAL_EXCESS_COST: 1000,
	MAX_CAMPAIGN_ANOMALIES: 15,
	MAX_REGIONAL_ANOMALIES: 10
} as const;

// Weekly Report Settings
export const WEEKLY_REPORT = {
	// Confidence scoring thresholds
	HIGH_CONFIDENCE: {
		spend: 2000,
		conversions: 20
	},
	MEDIUM_CONFIDENCE: {
		spend: 500,
		conversions: 8
	},
	LOW_CONFIDENCE: {
		spend: 100,
		conversions: 3
	},
	
	// Minimum spend for meaningful analysis
	MIN_SPEND_THRESHOLD: 500,
	MIN_CONVERSIONS_THRESHOLD: 5,
	
	// Scale calculation multipliers
	SCALE_MULTIPLIERS: {
		small_campaigns: 1.0,   // < 500 spend
		medium_campaigns: 0.5,  // 500-1500 spend
		large_campaigns: 0.2    // > 1500 spend
	}
} as const;

// Campaign Analysis Settings
export const CAMPAIGN_ANALYSIS = {
	// Minimum thresholds for campaign inclusion
	MIN_SPEND_FOR_ANALYSIS: 200,
	MIN_CONVERSIONS_FOR_ANALYSIS: 2,
	
	// Creative analysis thresholds
	CREATIVE_MIN_SPEND: 100,
	CREATIVE_MIN_CONVERSIONS: 2,
	
	// Top performer limits
	MAX_TOP_PERFORMERS: 10,
	MAX_CREATIVE_ANALYSIS: 10
} as const;

// Creative Analysis Settings
export const CREATIVE_ANALYSIS = {
	// Minimum thresholds for creative inclusion
	DEFAULT_MIN_SPEND: 300,
	MIN_CONVERSIONS: 2,
	
	// Concept analysis multiplier (concepts need more data)
	CONCEPT_SPEND_MULTIPLIER: 2,
	
	// Performance limits
	MAX_CREATIVE_CONCEPTS: 8,
	MAX_INDIVIDUAL_ADS: 10,
	
	// Confidence scoring for creatives
	HIGH_CONFIDENCE_MULTIPLIER: 3,
	MEDIUM_CONFIDENCE_MULTIPLIER: 1
} as const;

// Regional Comparison Settings
export const REGIONAL_COMPARISON = {
	// Minimum thresholds for regional segment inclusion
	MIN_SEGMENT_SPEND: 500,
	MIN_COUNTRY_SPEND: 1000,
	MIN_CAMPAIGNS_PER_REGION: 2,
	
	// Platform-country matrix minimum
	MIN_PLATFORM_COUNTRY_SPEND: 500
} as const;

// Flexible Query Settings
export const FLEXIBLE_QUERY = {
	// Query validation
	MAX_QUERY_LENGTH: 10000,
	
	// Security patterns (regex patterns to block)
	DANGEROUS_PATTERNS: [
		/;\s*(DROP|CREATE|ALTER|INSERT|UPDATE|DELETE|TRUNCATE)/i,
		/--[^\r\n]*$/m,
		/\/\*[\s\S]*?\*\//g,
		/\bxp_cmdshell\b/i,
		/\bsp_executesql\b/i
	]
} as const;

// Date Range Mappings
export const DATE_RANGES = {
	'7d': 7,
	'14d': 14,
	'30d': 30
} as const;

// Comparison Period Mappings
export const COMPARISON_PERIODS = {
	week_over_week: { current: 7, comparison: 14 },
	month_over_month: { current: 30, comparison: 60 }
} as const;

// Default Countries for Analysis
export const DEFAULT_COUNTRIES = ['US', 'AU', 'UK'] as const;

// Default Platforms for Analysis
export const DEFAULT_PLATFORMS = ['Meta', 'Google', 'Bing'] as const;

// BigQuery Configuration
export const BIGQUERY_CONFIG = {
	// Table reference
	BLENDED_SUMMARY_TABLE: '`exemplary-terra-463404-m1.linktree_analytics.blended_summary`',
	
	// Query optimization
	MAX_RESULTS_PER_SECTION: 20,
	DEFAULT_RESULT_LIMIT: 100
} as const;

// Webhook Configuration
export const WEBHOOK_CONFIG = {
	URL: 'https://n8n.wibci.dev/webhook/40df3a90-da64-4939-8813-839f12a43cee',
	
	// Headers
	HEADERS: {
		'Content-Type': 'application/json',
		'User-Agent-Prefix': 'MCP-Analytics-Tool'
	}
} as const;

// Export utility functions for common calculations
export const UTILITIES = {
	// Get platform target CPA
	getPlatformTarget: (platform: string): number => {
		return PLATFORM_TARGETS[platform as keyof typeof PLATFORM_TARGETS] || PLATFORM_TARGETS.Default;
	},
	
	// Get date range in days
	getDateRangeDays: (range: '7d' | '14d' | '30d'): number => {
		return DATE_RANGES[range];
	},
	
	// Get comparison period configuration
	getComparisonPeriod: (type: 'week_over_week' | 'month_over_month') => {
		return COMPARISON_PERIODS[type];
	},
	
	// Calculate scale potential
	calculateScalePotential: (currentSpend: number): number => {
		if (currentSpend < 500) return currentSpend * WEEKLY_REPORT.SCALE_MULTIPLIERS.small_campaigns;
		if (currentSpend < 1500) return currentSpend * WEEKLY_REPORT.SCALE_MULTIPLIERS.medium_campaigns;
		return currentSpend * WEEKLY_REPORT.SCALE_MULTIPLIERS.large_campaigns;
	}
} as const; 