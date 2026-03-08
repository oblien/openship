"use client";

import React, { useState } from "react";
import {
  Settings2,
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Upload,
} from "lucide-react";
import type { ProjectConfig, ProjectSource, EnvVariable } from "../types";
import { frameworks, getFrameworkConfig } from "@/components/import-project/Frameworks";

/* ── Props ───────────────────────────────────────────────────────── */

interface ConfigureProjectProps {
  source: ProjectSource;
  config: ProjectConfig;
  onChange: (config: ProjectConfig) => void;
}

/* ── Main component ──────────────────────────────────────────────── */

export default function ConfigureProject({
  source,
  config,
  onChange,
}: ConfigureProjectProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const set = <K extends keyof ProjectConfig>(key: K, value: ProjectConfig[K]) =>
    onChange({ ...config, [key]: value });

  const fw = getFrameworkConfig(config.framework);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2
          className="text-xl font-semibold text-foreground"
          style={{ letterSpacing: "-0.3px" }}
        >
          Configure
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Review settings before deploying
          {source.kind === "github" && (
            <span className="text-foreground font-medium"> {source.owner}/{source.repo}</span>
          )}
          {source.kind === "url" && (
            <span className="text-foreground font-medium"> {source.owner}/{source.repo}</span>
          )}
          {source.kind === "upload" && (
            <span className="text-foreground font-medium"> {source.rootName}</span>
          )}
          {source.kind === "template" && (
            <span className="text-foreground font-medium"> {source.templateName} template</span>
          )}
        </p>
      </div>

      {/* Project basics */}
      <div className="bg-card rounded-2xl border border-border/50 divide-y divide-border/50">
        {/* Project name */}
        <div className="p-5">
          <label className="text-sm font-medium text-foreground mb-2 block">
            Project Name
          </label>
          <input
            type="text"
            value={config.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="my-project"
            className="w-full px-4 py-2.5 bg-background border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
          />
        </div>

        {/* Framework */}
        <div className="p-5">
          <label className="text-sm font-medium text-foreground mb-3 block">
            Framework
          </label>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
            {frameworks.map((f) => {
              const isSelected = config.framework === f.id;
              return (
                <button
                  key={f.id}
                  onClick={() => {
                    set("framework", f.id);
                    // Auto-fill build defaults from framework
                    onChange({
                      ...config,
                      framework: f.id,
                      buildCommand: f.options.buildCommand,
                      installCommand: f.options.installCommand,
                      outputDirectory: f.options.outputDirectory,
                    });
                  }}
                  className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${
                    isSelected
                      ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                      : "border-border/50 hover:border-border hover:bg-muted/30"
                  }`}
                >
                  <div className="w-8 h-8 flex items-center justify-center">
                    {f.icon("hsl(var(--foreground))")}
                  </div>
                  <span className={`text-xs font-medium ${isSelected ? "text-primary" : "text-muted-foreground"}`}>
                    {f.name}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Domain */}
        <div className="p-5">
          <label className="text-sm font-medium text-foreground mb-2 block">
            Domain
          </label>
          <div className="flex gap-2">
            <div className="flex-1 flex items-center bg-background border border-border/50 rounded-xl overflow-hidden focus-within:ring-2 focus-within:ring-primary/20 transition-all">
              <input
                type="text"
                value={config.domain}
                onChange={(e) => set("domain", e.target.value.replace(/[^a-z0-9-]/gi, "").toLowerCase())}
                placeholder={config.name || "my-project"}
                className="flex-1 px-4 py-2.5 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
              />
              <span className="pr-4 text-sm text-muted-foreground">.obl.ee</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground/60 mt-1.5">
            You can add a custom domain later in project settings
          </p>
        </div>
      </div>

      {/* Build settings (advanced) */}
      <div className="bg-card rounded-2xl border border-border/50">
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="w-full flex items-center justify-between px-5 py-4 text-left"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-muted/60 flex items-center justify-center">
              <Settings2 className="size-[18px] text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">Build Settings</p>
              <p className="text-xs text-muted-foreground">
                {fw.name} defaults applied
              </p>
            </div>
          </div>
          {showAdvanced ? (
            <ChevronUp className="size-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 text-muted-foreground" />
          )}
        </button>

        {showAdvanced && (
          <div className="px-5 pb-5 space-y-4 border-t border-border/50 pt-4">
            <Field
              label="Install Command"
              value={config.installCommand}
              onChange={(v) => set("installCommand", v)}
              placeholder="npm install"
            />
            <Field
              label="Build Command"
              value={config.buildCommand}
              onChange={(v) => set("buildCommand", v)}
              placeholder="npm run build"
            />
            <Field
              label="Output Directory"
              value={config.outputDirectory}
              onChange={(v) => set("outputDirectory", v)}
              placeholder="dist"
            />
            <Field
              label="Start Command"
              value={config.startCommand}
              onChange={(v) => set("startCommand", v)}
              placeholder="npm start"
            />
            <div className="grid grid-cols-2 gap-4">
              <Field
                label="Root Directory"
                value={config.rootDirectory}
                onChange={(v) => set("rootDirectory", v)}
                placeholder="./"
              />
              <Field
                label="Port"
                value={String(config.port)}
                onChange={(v) => set("port", parseInt(v) || 3000)}
                placeholder="3000"
                type="number"
              />
            </div>
          </div>
        )}
      </div>

      {/* Environment variables */}
      <EnvironmentSection
        envVars={config.envVars}
        onChange={(envVars) => set("envVars", envVars)}
      />
    </div>
  );
}

/* ── Field ────────────────────────────────────────────────────────── */

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  type?: string;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 bg-background border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
      />
    </div>
  );
}

/* ── Environment Variables section ────────────────────────────────── */

function EnvironmentSection({
  envVars,
  onChange,
}: {
  envVars: EnvVariable[];
  onChange: (vars: EnvVariable[]) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const addVar = () =>
    onChange([...envVars, { key: "", value: "", visible: false }]);

  const removeVar = (index: number) =>
    onChange(envVars.filter((_, i) => i !== index));

  const updateVar = (index: number, field: keyof EnvVariable, val: string | boolean) =>
    onChange(
      envVars.map((v, i) => (i === index ? { ...v, [field]: val } : v))
    );

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const parsed = text
        .split("\n")
        .filter((line) => line.trim() && !line.startsWith("#"))
        .map((line) => {
          const [key, ...rest] = line.split("=");
          return { key: key!.trim(), value: rest.join("=").trim(), visible: false };
        });
      onChange([...envVars, ...parsed]);
      setExpanded(true);
    };
    reader.readAsText(file);
  };

  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-5 py-4 text-left"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-muted/60 flex items-center justify-center">
            <span className="text-sm font-mono text-muted-foreground">{ }</span>
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">Environment Variables</p>
            <p className="text-xs text-muted-foreground">
              {envVars.length === 0 ? "None set" : `${envVars.length} variable${envVars.length !== 1 ? "s" : ""}`}
            </p>
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="size-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-4 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="px-5 pb-5 border-t border-border/50 pt-4 space-y-3">
          {envVars.map((v, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={v.key}
                onChange={(e) => updateVar(i, "key", e.target.value)}
                placeholder="KEY"
                className="flex-1 px-3 py-2 bg-background border border-border/50 rounded-lg text-sm font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              <div className="relative flex-1">
                <input
                  type={v.visible ? "text" : "password"}
                  value={v.value}
                  onChange={(e) => updateVar(i, "value", e.target.value)}
                  placeholder="value"
                  className="w-full px-3 py-2 pr-9 bg-background border border-border/50 rounded-lg text-sm font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <button
                  type="button"
                  onClick={() => updateVar(i, "visible", !v.visible)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground"
                >
                  {v.visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </button>
              </div>
              <button
                onClick={() => removeVar(i)}
                className="flex size-8 items-center justify-center rounded-lg text-muted-foreground/50 hover:text-red-500 hover:bg-red-500/10 transition-colors"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}

          <div className="flex items-center gap-2">
            <button
              onClick={addVar}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-lg transition-colors"
            >
              <Plus className="size-3.5" />
              Add Variable
            </button>
            <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-lg transition-colors cursor-pointer">
              <Upload className="size-3.5" />
              Import .env
              <input
                type="file"
                accept=".env,.env.local,.env.production"
                className="hidden"
                onChange={handleFileUpload}
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
