/**
 * Utility functions for handling dates consistently across the application
 * This will help when connecting to the API
 */

/**
 * Safely parses a date string into a Date object
 * @param dateString The date string to parse
 * @returns A valid Date object or null if invalid
 */
import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
export function parseDate(dateString: string | null | undefined): Date | null {
  if (!dateString) return null;
  
  try {
    const date = new Date(dateString);
    return isNaN(date.getTime()) ? null : date;
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "dashboard/utils/date");
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
