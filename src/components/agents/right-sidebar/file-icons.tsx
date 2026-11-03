import type { ComponentType } from "react";
import {
  IconBrandCss3,
  IconBrandDocker,
  IconBrandGolang,
  IconBrandHtml5,
  IconBrandJavascript,
  IconBrandPython,
  IconBrandRust,
  IconBrandTypescript,
  IconDatabase,
  IconFile,
  IconFileCode,
  IconFileText,
  IconFileZip,
  IconFolder,
  IconFolderOpen,
  IconJson,
  IconLock,
  IconMarkdown,
  IconPhoto,
  IconSettings,
  IconTerminal2,
} from "@tabler/icons-react";
import { cn } from "cn";

type Icon = ComponentType<{ className?: string }>;
interface Visual { icon: Icon; tone: string }

const sky = "text-sky-600 dark:text-sky-400";
const amber = "text-amber-600 dark:text-amber-400";
const emerald = "text-emerald-600 dark:text-emerald-400";
const orange = "text-orange-600 dark:text-orange-400";
const muted = "text-muted-foreground";

const BY_EXTENSION: Record<string, Visual> = {
  ts: { icon: IconBrandTypescript, tone: sky },
  tsx: { icon: IconBrandTypescript, tone: sky },
  mts: { icon: IconBrandTypescript, tone: sky },
  cts: { icon: IconBrandTypescript, tone: sky },
  js: { icon: IconBrandJavascript, tone: amber },
  jsx: { icon: IconBrandJavascript, tone: amber },
  mjs: { icon: IconBrandJavascript, tone: amber },
  cjs: { icon: IconBrandJavascript, tone: amber },
  json: { icon: IconJson, tone: amber },
  jsonc: { icon: IconJson, tone: amber },
  md: { icon: IconMarkdown, tone: muted },
  mdx: { icon: IconMarkdown, tone: muted },
  txt: { icon: IconFileText, tone: muted },
  css: { icon: IconBrandCss3, tone: sky },
  scss: { icon: IconBrandCss3, tone: sky },
  html: { icon: IconBrandHtml5, tone: orange },
  py: { icon: IconBrandPython, tone: emerald },
  rs: { icon: IconBrandRust, tone: orange },
  go: { icon: IconBrandGolang, tone: sky },
  yml: { icon: IconSettings, tone: muted },
  yaml: { icon: IconSettings, tone: muted },
  toml: { icon: IconSettings, tone: muted },
  ini: { icon: IconSettings, tone: muted },
  env: { icon: IconSettings, tone: muted },
  lock: { icon: IconLock, tone: muted },
  sh: { icon: IconTerminal2, tone: emerald },
  bash: { icon: IconTerminal2, tone: emerald },
  ps1: { icon: IconTerminal2, tone: emerald },
  sql: { icon: IconDatabase, tone: muted },
  png: { icon: IconPhoto, tone: emerald },
  jpg: { icon: IconPhoto, tone: emerald },
  jpeg: { icon: IconPhoto, tone: emerald },
  gif: { icon: IconPhoto, tone: emerald },
  webp: { icon: IconPhoto, tone: emerald },
  svg: { icon: IconPhoto, tone: amber },
  ico: { icon: IconPhoto, tone: emerald },
  zip: { icon: IconFileZip, tone: muted },
  gz: { icon: IconFileZip, tone: muted },
  tar: { icon: IconFileZip, tone: muted },
  java: { icon: IconFileCode, tone: orange },
  c: { icon: IconFileCode, tone: sky },
  h: { icon: IconFileCode, tone: sky },
  cpp: { icon: IconFileCode, tone: sky },
  cs: { icon: IconFileCode, tone: emerald },
  rb: { icon: IconFileCode, tone: orange },
  php: { icon: IconFileCode, tone: sky },
  swift: { icon: IconFileCode, tone: orange },
  kt: { icon: IconFileCode, tone: orange },
  vue: { icon: IconFileCode, tone: emerald },
};

const BY_NAME: Record<string, Visual> = {
  dockerfile: { icon: IconBrandDocker, tone: sky },
  ".gitignore": { icon: IconSettings, tone: muted },
  ".gitattributes": { icon: IconSettings, tone: muted },
  "package.json": { icon: IconJson, tone: emerald },
  license: { icon: IconFileText, tone: muted },
  makefile: { icon: IconTerminal2, tone: muted },
};

function visualFor(name: string): Visual {
  const lower = name.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return byName;
  if (lower.startsWith(".env")) return { icon: IconSettings, tone: muted };
  const dot = lower.lastIndexOf(".");
  return (dot > 0 ? BY_EXTENSION[lower.slice(dot + 1)] : undefined) ?? { icon: IconFile, tone: muted };
}

export function FileIcon({ name, className }: { name: string; className?: string }) {
  const { icon: Icon, tone } = visualFor(name);
  return <Icon className={cn("size-3.5 shrink-0", tone, className)} />;
}

export function FolderIcon({ open, className }: { open?: boolean; className?: string }) {
  const Icon = open ? IconFolderOpen : IconFolder;
  return <Icon className={cn("size-3.5 shrink-0 text-sky-600/80 dark:text-sky-400/80", className)} />;
}
