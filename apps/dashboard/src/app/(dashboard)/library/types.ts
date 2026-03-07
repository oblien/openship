export interface Repository {
  id: number;
  full_name: string;
  name: string;
  description: string;
  private: boolean;
  stars: number;
  forks: number;
  language: string;
  updated_at: string;
  default_branch: string;
  owner: string;
  html_url?: string;
  deployed?: string;
}

export interface Account {
  login: string;
  avatar_url: string;
  type: "User" | "Organization";
  name?: string;
}

export type VisibilityFilter = "all" | "public" | "private";
export type SortBy = "name" | "updated" | "stars";

