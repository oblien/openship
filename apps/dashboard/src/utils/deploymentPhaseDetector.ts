export type DeploymentPhase = "cloning" | "installing" | "building" | "deploying" | "ready";

export interface PhaseInfo {
  phase: DeploymentPhase;
  progress: number;
  stepIndex: number;
}

export interface BuildLog {
  type: "info" | "success" | "error";
  text: string;
  time: string;
}

export interface SSEMessage {
  type: string;
  data: string;
  timestamp: string;
}

/**
 * Analyzes a log message and determines the current deployment phase and progress
 */
export function detectPhase(logText: string): PhaseInfo {
  const lowerText = logText.toLowerCase();
  
  // Check for explicit phase markers (---PHASE: xxx---)
  const phaseMarker = logText.match(/---PHASE:\s*(\w+)---/i);
  if (phaseMarker) {
    const phaseName = phaseMarker[1].toLowerCase();
    return getPhaseInfoFromName(phaseName);
  }
  
  // Phase detection patterns
  const patterns = {
    cloning: [
      /clon(ing|e)/i,
      /git clone/i,
      /fetch(ing)? repository/i,
      /download(ing)? (from )?repository/i
    ],
    installing: [
      /install(ing)? dependencies/i,
      /npm install/i,
      /yarn install/i,
      /pnpm install/i,
      /packages? installed/i,
      /node_modules/i,
      /dependencies/i
    ],
    building: [
      /build(ing)?/i,
      /compil(ing|e)/i,
      /bundl(ing|e)/i,
      /optimiz(ing|e)/i,
      /webpack/i,
      /production build/i
    ],
    deploying: [
      /deploy(ing)?/i,
      /upload(ing)?/i,
      /publishing/i,
      /edge network/i,
      /global regions/i,
      /distribution/i
    ],
    ready: [
      /deployment (complete|ready|successful)/i,
      /successfully deployed/i,
      /live and running/i,
      /🎉/,
      /deployment ready/i,
      /done/i
    ]
  };

  // Detect phase
  let phase: DeploymentPhase = "cloning";
  let stepIndex = 0;

  if (patterns.ready.some(p => p.test(lowerText))) {
    phase = "ready";
    stepIndex = 4;
  } else if (patterns.deploying.some(p => p.test(lowerText))) {
    phase = "deploying";
    stepIndex = 3;
  } else if (patterns.building.some(p => p.test(lowerText))) {
    phase = "building";
    stepIndex = 2;
  } else if (patterns.installing.some(p => p.test(lowerText))) {
    phase = "installing";
    stepIndex = 1;
  } else if (patterns.cloning.some(p => p.test(lowerText))) {
    phase = "cloning";
    stepIndex = 0;
  }

  // Calculate progress based on phase
  const progress = calculateProgress(phase, lowerText);

  return { phase, progress, stepIndex };
}

/**
 * Maps phase name to PhaseInfo
 */
function getPhaseInfoFromName(phaseName: string): PhaseInfo {
  const phaseMap: Record<string, { phase: DeploymentPhase; stepIndex: number; progress: number }> = {
    clone: { phase: "cloning", stepIndex: 0, progress: 5 },
    cloning: { phase: "cloning", stepIndex: 0, progress: 5 },
    install: { phase: "installing", stepIndex: 1, progress: 25 },
    installing: { phase: "installing", stepIndex: 1, progress: 25 },
    dependencies: { phase: "installing", stepIndex: 1, progress: 25 },
    build: { phase: "building", stepIndex: 2, progress: 50 },
    building: { phase: "building", stepIndex: 2, progress: 50 },
    deploy: { phase: "deploying", stepIndex: 3, progress: 75 },
    deploying: { phase: "deploying", stepIndex: 3, progress: 75 },
    upload: { phase: "deploying", stepIndex: 3, progress: 75 },
    ready: { phase: "ready", stepIndex: 4, progress: 100 },
    done: { phase: "ready", stepIndex: 4, progress: 100 },
    complete: { phase: "ready", stepIndex: 4, progress: 100 },
  };

  return phaseMap[phaseName] || { phase: "cloning", stepIndex: 0, progress: 0 };
}

/**
 * Calculates progress percentage based on phase and log content
 */
function calculateProgress(phase: DeploymentPhase, logText: string): number {
  const baseProgress = {
    cloning: 0,
    installing: 25,
    building: 50,
    deploying: 75,
    ready: 100
  };

  const baseValue = baseProgress[phase];

  // Try to extract percentage from log text
  const percentMatch = logText.match(/(\d+)%/);
  if (percentMatch) {
    const extractedPercent = parseInt(percentMatch[1]);
    // Scale the extracted percentage within the phase range
    const phaseRange = 25; // Each phase is roughly 25% of total
    return baseValue + (extractedPercent / 100) * phaseRange;
  }

  // Check for completion indicators
  if (logText.includes('✓') || logText.includes('complete') || logText.includes('success')) {
    return Math.min(baseValue + 20, 100);
  }

  // Default to base progress
  return baseValue;
}

/**
 * Converts raw log text to BuildLog format
 */
export function parseLogEntry(text: string, timestamp: string, startTime: number): BuildLog {
  const lowerText = text.toLowerCase();
  
  // Skip phase markers in the log display
  if (text.match(/---PHASE:\s*\w+---/i)) {
    // Return a special marker that can be filtered out if needed
    const currentTime = Math.floor((new Date(timestamp).getTime() - startTime) / 1000);
    const mins = Math.floor(currentTime / 60);
    const secs = currentTime % 60;
    const time = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    
    return { type: "info", text: "", time }; // Empty text to hide phase markers
  }
  
  // Determine log type
  let type: "info" | "success" | "error" = "info";
  
  if (
    text.includes('✓') || 
    lowerText.includes('success') || 
    lowerText.includes('complete') ||
    lowerText.includes('deployed') ||
    lowerText.includes('done') ||
    text.includes('🎉')
  ) {
    type = "success";
  } else if (
    lowerText.includes('error') || 
    lowerText.includes('fail') || 
    lowerText.includes('✗') ||
    text.includes('❌')
  ) {
    type = "error";
  }

  // Calculate time from timestamp
  const currentTime = Math.floor((new Date(timestamp).getTime() - startTime) / 1000);
  const mins = Math.floor(currentTime / 60);
  const secs = currentTime % 60;
  const time = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

  // Clean up the text (remove extra whitespace, line breaks)
  const cleanText = text.trim();

  return { type, text: cleanText, time };
}

/**
 * Aggregates phase information from multiple logs to determine overall state
 */
export function aggregatePhaseInfo(logs: BuildLog[]): PhaseInfo {
  if (logs.length === 0) {
    return { phase: "cloning", progress: 0, stepIndex: 0 };
  }

  // Get phase info from the last few logs to determine current phase
  const recentLogs = logs.slice(-5);
  let maxProgress = 0;
  let currentPhase: PhaseInfo = { phase: "cloning", progress: 0, stepIndex: 0 };

  for (const log of recentLogs) {
    const phaseInfo = detectPhase(log.text);
    if (phaseInfo.progress > maxProgress) {
      maxProgress = phaseInfo.progress;
      currentPhase = phaseInfo;
    }
  }

  return currentPhase;
}

