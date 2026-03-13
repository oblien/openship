import { useState } from "react";

export interface projectDataType {
  name: string;
  description: string;
  framework: string;
  domains: {
    id: number;
    domain: string;
    primary: boolean;
    verified: boolean;
  }[];
  envVars: {
    development: {
      id: number;
      key: string;
      value: string;
      encrypted: boolean;
    }[];
    preview: {
      id: number;
      key: string;
      value: string;
      encrypted: boolean;
    }[];
    production: {
      id: number;
      key: string;
      value: string;
      encrypted: boolean;
    }[];
  };
  git: {
    connected: boolean;
    repo: string;
    branch: string;
    provider: string;
  };
  build: {
    command: string;
    outputDir: string;
    autoDeploy: boolean;
  };
}

const initialProjectData = {
  name: "my-awesome-app",
  description: "A modern web application built with Next.js",
  framework: "nextjs",
  domains: [
    {
      id: 1,
      domain: "my-awesome-app.opsh.io",
      primary: true,
      verified: true,
    },
    { id: 2, domain: "myapp.com", primary: false, verified: true },
    { id: 3, domain: "www.myapp.com", primary: false, verified: false },
  ],
  envVars: {
    development: [
      {
        id: 1,
        key: "DATABASE_URL",
        value: "postgresql://localhost:5432/dev",
        encrypted: false,
      },
      { id: 2, key: "API_KEY", value: "sk_test_123456789", encrypted: true },
    ],
    preview: [
      {
        id: 3,
        key: "DATABASE_URL",
        value: "postgresql://staging.db.com:5432/preview",
        encrypted: false,
      },
      {
        id: 4,
        key: "API_KEY",
        value: "sk_preview_987654321",
        encrypted: true,
      },
    ],
    production: [
      {
        id: 5,
        key: "DATABASE_URL",
        value: "postgresql://prod.db.com:5432/main",
        encrypted: false,
      },
      { id: 6, key: "API_KEY", value: "sk_live_abcdef123", encrypted: true },
    ],
  },
  git: {
    connected: true,
    repo: "username/my-awesome-app",
    branch: "main",
    provider: "GitHub",
  },
  build: {
    command: "npm run build",
    outputDir: ".next",
    autoDeploy: true,
  },
};

export const useProjectData = () => {
  const [projectData, setProjectData] = useState(initialProjectData);
  return { projectData, setProjectData };
};
