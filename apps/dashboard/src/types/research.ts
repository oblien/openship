/**
 * Type definitions for the Tavily Research API integration.
 */

export interface SearchRequest {
  query: string;
  search_depth?: "basic" | "advanced";
  include_answer?: boolean;
  include_images?: boolean;
  include_raw_content?: boolean;
  max_results?: number;
  include_domains?: string[];
  exclude_domains?: string[];
}

export interface ExtractRequest {
  urls: string[];
  include_images?: boolean;
}

export interface CrawlRequest {
  url: string;
  max_depth?: number;
  max_pages?: number;
  include_images?: boolean;
}

export interface ResearchResultItem {
  url: string;
  title?: string;
  raw_content?: string;
  content?: string;
  score?: number;
}

export interface ResearchResult {
  results: ResearchResultItem[];
  base_url?: string;
  answer?: string;
  images?: string[];
  query?: string;
}
