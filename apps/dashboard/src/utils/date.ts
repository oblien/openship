/**
 * Utility functions for handling dates consistently across the application
 * This will help when connecting to the API
 */

/**
 * Safely parses a date string into a Date object
 * @param dateString The date string to parse
 * @returns A valid Date object or null if invalid
 */
export function parseDate(dateString: string | null | undefined): Date | null {
  if (!dateString) return null;
  
  try {
    const date = new Date(dateString);
    return isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

/**
 * Formats a date for display with a fallback for invalid dates
 * @param dateString The date string to format
 * @param options DateTimeFormat options
 * @param fallback Fallback string for invalid dates
 * @returns Formatted date string or fallback
 */
export function formatDate(
  dateString: string | null | undefined, 
  options: Intl.DateTimeFormatOptions = { 
    year: 'numeric', 
    month: 'short', 
    day: 'numeric' 
  },
  fallback: string = 'N/A',
  getSince: boolean = false
): string {
  const date = parseDate(dateString);
  if (!date) return fallback;

  if (getSince) {
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const months = Math.floor(days / 30); // Approximate month length
    const years = Math.floor(months / 12); // Approximate year length

    if (years > 0) {
      return `${years} year${years > 1 ? 's' : ''} ago`;
    } else if (months > 0) {
      return `${months} month${months > 1 ? 's' : ''} ago`;
    } else if (days > 0) {
      return `${days} day${days > 1 ? 's' : ''} ago`;
    } else if (hours > 0) {
      return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    } else if (minutes > 0) {
      return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    } else {
      return `${seconds} second${seconds > 1 ? 's' : ''} ago`;
    }
  }

  return new Intl.DateTimeFormat('en-US', options).format(date);
}


/**
 * Calculates days difference between a date and today
 * @param dateString The date string to compare with today
 * @returns Number of days difference or null if invalid
 */
export function getDaysDifference(dateString: string | null | undefined): number | null {
  const date = parseDate(dateString);
  if (!date) return null;
  
  const today = new Date();
  const diffTime = date.getTime() - today.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Formats a date showing relative time for near dates
 * @param dateString The date to format
 * @param threshold Days threshold to show relative time instead of date
 * @returns Formatted string
 */
export function formatRelativeDate(
  dateString: string | null | undefined, 
  threshold: number = 30
): string {
  const days = getDaysDifference(dateString);
  
  if (days === null) return 'Invalid date';
  
  if (days < 0) {
    return 'Expired';
  } else if (days === 0) {
    return 'Today';
  } else if (days === 1) {
    return 'Tomorrow';
  } else if (days <= threshold) {
    return `In ${days} days`;
  } else {
    return formatDate(dateString);
  }
}

/**
 * Serializes a Date object to ISO string format for API requests
 * @param date The date to serialize
 * @returns ISO string or null if invalid
 */
export function serializeDate(date: Date | null | undefined): string | null {
  if (!date || isNaN(date.getTime())) return null;
  return date.toISOString();
} 