/**
 * Utility functions for encoding and decoding repository slugs
 * Uses base64url encoding (URL-safe base64) for owner/repo format
 */

/**
 * Encodes owner and repo into a URL-safe base64 slug
 * @param owner - Repository owner/organization name
 * @param repo - Repository name
 * @returns URL-safe base64 encoded slug
 */
export function encodeRepoSlug(owner: string, repo: string): string {
  const data = `${owner}/${repo}`;
  // Convert to base64 and make it URL-safe
  const base64 = Buffer.from(data).toString('base64');
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Decodes a repository slug back to owner and repo
 * @param slug - URL-safe base64 encoded slug
 * @returns Object with owner and repo, or null if invalid
 */
export function decodeRepoSlug(slug: string): { owner: string; repo: string } | null {
  try {
    // Restore base64 padding and characters
    let base64 = slug
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    
    // Add padding if needed
    while (base64.length % 4) {
      base64 += '=';
    }
    
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    const [owner, repo] = decoded.split('/');
    
    if (!owner || !repo) {
      return null;
    }
    
    return { owner, repo };
  } catch (error) {
    console.error('Failed to decode repo slug:', error);
    return null;
  }
}

/**
 * Extracts owner and repo from a GitHub URL
 * @param url - GitHub repository URL
 * @returns Object with owner and repo, or null if invalid
 */
export function extractOwnerRepoFromUrl(url: string): { owner: string; repo: string } | null {
  try {
    // Handle various GitHub URL formats
    // https://github.com/owner/repo
    // https://github.com/owner/repo.git
    // git@github.com:owner/repo.git
    
    // Match HTTPS URLs - allow dots in repo name, optionally strip .git suffix
    const httpsMatch = url.match(/github\.com\/([^\/]+)\/(.+?)(?:\.git)?$/);
    if (httpsMatch) {
      return {
        owner: httpsMatch[1],
        repo: httpsMatch[2],
      };
    }
    
    // Match SSH URLs - allow dots in repo name, optionally strip .git suffix
    const sshMatch = url.match(/github\.com:([^\/]+)\/(.+?)(?:\.git)?$/);
    if (sshMatch) {
      return {
        owner: sshMatch[1],
        repo: sshMatch[2],
      };
    }
    
    return null;
  } catch (error) {
    console.error('Failed to extract owner/repo from URL:', error);
    return null;
  }
}

