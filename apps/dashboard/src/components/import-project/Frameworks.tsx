import { generateIcon } from "@/utils/icons";
import { FrameworkId } from "./types";

export interface FrameworkConfig {
  id: FrameworkId;
  name: string;
  options: {
    buildCommand: string;
    installCommand: string;
    outputDirectory: string;
    isStatic?: boolean;
  };
  icon: (color: string) => React.ReactNode;
}

export const frameworks: FrameworkConfig[] = [
  { 
    id: "next", 
    name: "Next.js", 
    options: {
      buildCommand: "npm run build",
      installCommand: "bun install",
      outputDirectory: ".next",
    },
    icon: (color) => generateIcon("https://uxwing.com/wp-content/themes/uxwing/download/brands-and-social-media/nextjs-icon.png", 30, color, {}, true) 
  },
  { 
    id: "nuxt", 
    name: "Nuxt", 
    options: {
      buildCommand: "npm run build",
      installCommand: "bun install",
      outputDirectory: ".nuxt",
    },
    icon: (color) => generateIcon("https://img.icons8.com/?size=1200&id=nvrsJYs7j9Vb&format=png", 30, color, {}, true) 
  },
  { 
    id: "astro", 
    name: "Astro", 
    options: {
      buildCommand: "npm run build",
      installCommand: "bun install",
      outputDirectory: "dist",
      isStatic: true,
    },
    icon: (color) => generateIcon("https://raw.githubusercontent.com/github/explore/5cc0a03a302ec862c4aeac2a22a513ae31c35432/topics/astro/astro.png", 30, color, {}, true) 
  },
  { 
    id: "vite", 
    name: "Vite", 
    options: {
      buildCommand: "npm run build",
      installCommand: "bun install",
      outputDirectory: "dist",
      isStatic: true,
    },
    icon: (color) => generateIcon("https://upload.wikimedia.org/wikipedia/commons/f/f1/Vitejs-logo.svg", 30, color, {}, true) 
  },
  { 
    id: "sveltekit", 
    name: "SvelteKit", 
    options: {
      buildCommand: "npm run build",
      installCommand: "bun install",
      outputDirectory: ".svelte-kit",
      isStatic: true,
    },
    icon: (color) => generateIcon("https://upload.wikimedia.org/wikipedia/commons/1/1b/Svelte_Logo.svg", 30, color, {}, true) 
  },
  { 
    id: "angular", 
    name: "Angular", 
    options: {
      buildCommand: "npm run build",
      installCommand: "bun install",
      outputDirectory: "dist",
      isStatic: true,
    },
    icon: (color) => generateIcon("https://angular.dev/assets/images/press-kit/angular_icon_gradient.gif", 30, color, {}, true) 
  },
  { 
    id: "vue", 
    name: "Vue.js", 
    options: {
      buildCommand: "npm run build",
      installCommand: "bun install",
      outputDirectory: "dist",
      isStatic: true,
    },
    icon: (color) => generateIcon("https://upload.wikimedia.org/wikipedia/commons/9/95/Vue.js_Logo_2.svg", 30, color, {}, true) 
  },
  { 
    id: "react", 
    name: "React (CRA)", 
    options: {
      buildCommand: "npm run build",
      installCommand: "bun install",
      outputDirectory: "build",
      isStatic: true,
    },
    icon: (color) => generateIcon("https://upload.wikimedia.org/wikipedia/commons/a/a7/React-icon.svg", 30, color, {}, true) 
  },
  { 
    id: "static", 
    name: "Static", 
    options: {
      buildCommand: "",
      installCommand: "bun install",
      outputDirectory: ".",
      isStatic: true,
    },
    icon: (color) => generateIcon("https://www.w3.org/html/logo/downloads/HTML5_Badge_512.png", 30, color, {}, true) 
  },
  { 
    id: "node", 
    name: "Node.js", 
    options: {
      buildCommand: "",
      installCommand: "bun install",
      outputDirectory: ".",
    },
    icon: (color) => generateIcon("https://nodejs.org/static/logos/nodejsHex.svg", 30, color, {}, true) 
  },
];

/**
 * Get framework configuration by ID
 */
export const getFrameworkConfig = (frameworkId: any): FrameworkConfig => {
  return frameworks.find(fw => fw.id === frameworkId) || frameworks.find(fw => fw.id === "static")!;
};

