"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import styles from "./how-it-works.module.css";

export type TerminalLine = {
  text: string;
  tone?: "muted" | "accent" | "success" | "warning" | "error";
  delay?: number;
};

type InteractiveTerminalProps = {
  title: string;
  command: string;
  lines: TerminalLine[];
};

function normalizeCommand(command: string) {
  return command.trim().replace(/^\$\s*/, "").replace(/\s+/g, " ");
}

export function InteractiveTerminal({
  title,
  command: expectedCommand,
  lines: script,
}: InteractiveTerminalProps) {
  const [command, setCommand] = useState(expectedCommand);
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [running, setRunning] = useState(false);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach(window.clearTimeout);
    },
    [],
  );

  function runCommand(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    timers.current.forEach(window.clearTimeout);
    timers.current = [];
    setLines([]);

    const enteredCommand = normalizeCommand(command);
    if (!enteredCommand) {
      setLines([{ text: "Enter a command to continue.", tone: "warning" }]);
      setRunning(false);
      return;
    }

    if (enteredCommand !== normalizeCommand(expectedCommand)) {
      setLines([
        { text: `openship: command not found: ${enteredCommand}`, tone: "error" },
      ]);
      setRunning(false);
      return;
    }

    setRunning(true);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let elapsed = 0;

    script.forEach((line, index) => {
      elapsed += reduceMotion ? 0 : (line.delay ?? 220);
      timers.current.push(
        window.setTimeout(() => {
          setLines((current) => [...current, line]);
          if (index === script.length - 1) setRunning(false);
        }, elapsed),
      );
    });
  }

  return (
    <div className={styles.terminalWindow}>
      <div className={styles.terminalChrome}>
        <span className={styles.windowDots} aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className={styles.windowPath}>~/storefront</span>
        <span className={styles.windowState} data-running={running}>
          {running ? "running" : "ready"}
        </span>
      </div>

      <div className={styles.terminalBody}>
        <p className={styles.loginLine}>Last login: today on openship</p>
        <form className={styles.commandForm} onSubmit={runCommand}>
          <span className={styles.prompt} aria-hidden="true">$</span>
          <input
            aria-label={`Terminal command: ${title}`}
            className={styles.commandInput}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            disabled={running}
          />
        </form>

        <div
          className={styles.output}
          role="log"
          aria-label={`${title} output`}
          aria-live="polite"
        >
          {lines.length === 0 ? (
            <span className={styles.outputHint}>Press Enter or run the command.</span>
          ) : (
            lines.map((line, index) => (
              <span
                key={`${index}-${line.text}`}
                className={`${styles.outputLine} ${line.tone ? styles[line.tone] : ""}`}
              >
                {line.text}
              </span>
            ))
          )}
        </div>
      </div>

      <button
        className={styles.runButton}
        type="button"
        onClick={() => runCommand()}
        disabled={running}
      >
        <span aria-hidden="true">↵</span>
        {running ? "running command" : "run command"}
      </button>
    </div>
  );
}
