// Research API Integration Utilities

import { SearchRequest, ExtractRequest, CrawlRequest, ResearchResult } from '@/types/research';

const API_BASE_URL = process.env.NEXT_PUBLIC_TAVILY_API_URL || 'https://api.tavily.com';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Search the web for information
 */
export async function searchWeb(
  request: SearchRequest,
  apiKey: string
): Promise<ApiResponse<ResearchResult>> {
  try {
    const response = await fetch(`${API_BASE_URL}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`);
    }

    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    console.error('Search API error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

/**
 * Extract content from URLs
 */
export async function extractContent(
  request: ExtractRequest,
  apiKey: string
): Promise<ApiResponse<ResearchResult>> {
  try {
    const response = await fetch(`${API_BASE_URL}/extract`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`);
    }

    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    console.error('Extract API error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

/**
 * Crawl a website
 */
export async function crawlWebsite(
  request: CrawlRequest,
  apiKey: string
): Promise<ApiResponse<ResearchResult>> {
  try {
    const response = await fetch(`${API_BASE_URL}/crawl`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`);
    }

    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    console.error('Crawl API error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

/**
 * Generate mock data for testing
 */
export function generateMockSearchResponse(query: string): ResearchResult {
  return {
    base_url: 'https://www.example.com',
    results: [
      {
        url: 'https://www.example.com/article1',
        raw_content: `Sample content related to: ${query}. This is a demonstration of search results.`,
        title: 'Example Article 1'
      },
      {
        url: 'https://www.example.com/article2',
        raw_content: `More information about: ${query}. Additional context and details here.`,
        title: 'Example Article 2'
      }
    ],
    answer: `This is a generated answer about: ${query}`
  };
}

export function generateMockExtractResponse(urls: string[]): ResearchResult {
  return {
    results: urls.map((url, index) => ({
      url,
      raw_content: `Extracted content from ${url}. This includes the main text, headings, and relevant information.`,
      title: `Content from ${new URL(url).hostname} - Page ${index + 1}`
    }))
  };
}

export function generateMockCrawlResponse(url: string): ResearchResult {
  return {
    base_url: url,
    results: [
      {
        url: url,
        raw_content: 'Main page content with navigation and key information.',
        title: `Homepage - ${new URL(url).hostname}`
      },
      {
        url: `${url}/about`,
        raw_content: 'About page with company information and team details.',
        title: 'About Us'
      },
      {
        url: `${url}/services`,
        raw_content: 'Services page listing all available offerings.',
        title: 'Our Services'
      }
    ]
  };
}

