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

// Full static class strings so Tailwind keeps them.
const sky = "text-sky-600 dark:text-sky-400";
const blue = "text-blue-600 dark:text-blue-400";
const amber = "text-amber-600 dark:text-amber-400";
const yellow = "text-yellow-600 dark:text-yellow-400";
const emerald = "text-emerald-600 dark:text-emerald-400";
const orange = "text-orange-600 dark:text-orange-400";
const purple = "text-purple-600 dark:text-purple-400";
const pink = "text-pink-600 dark:text-pink-400";
const cyan = "text-cyan-600 dark:text-cyan-400";
const red = "text-red-600 dark:text-red-400";
const slate = "text-slate-500 dark:text-slate-400";
const muted = "text-muted-foreground/70";

const BY_EXTENSION: Record<string, Visual> = {
  ts: { icon: IconBrandTypescript, tone: blue },
  tsx: { icon: IconBrandTypescript, tone: sky },
  mts: { icon: IconBrandTypescript, tone: blue },
  cts: { icon: IconBrandTypescript, tone: blue },
  js: { icon: IconBrandJavascript, tone: yellow },
  jsx: { icon: IconBrandJavascript, tone: yellow },
  mjs: { icon: IconBrandJavascript, tone: yellow },
  cjs: { icon: IconBrandJavascript, tone: yellow },
  json: { icon: IconJson, tone: amber },
  jsonc: { icon: IconJson, tone: amber },
  md: { icon: IconMarkdown, tone: sky },
  mdx: { icon: IconMarkdown, tone: sky },
  txt: { icon: IconFileText, tone: slate },
  css: { icon: IconBrandCss3, tone: purple },
  scss: { icon: IconBrandCss3, tone: pink },
  html: { icon: IconBrandHtml5, tone: orange },
  py: { icon: IconBrandPython, tone: emerald },
  rs: { icon: IconBrandRust, tone: orange },
  go: { icon: IconBrandGolang, tone: cyan },
  yml: { icon: IconSettings, tone: slate },
  yaml: { icon: IconSettings, tone: slate },
  toml: { icon: IconSettings, tone: slate },
  ini: { icon: IconSettings, tone: slate },
  env: { icon: IconSettings, tone: slate },
  lock: { icon: IconLock, tone: muted },
  sh: { icon: IconTerminal2, tone: emerald },
  bash: { icon: IconTerminal2, tone: emerald },
  ps1: { icon: IconTerminal2, tone: blue },
  sql: { icon: IconDatabase, tone: amber },
  png: { icon: IconPhoto, tone: emerald },
  jpg: { icon: IconPhoto, tone: emerald },
  jpeg: { icon: IconPhoto, tone: emerald },
  gif: { icon: IconPhoto, tone: emerald },
  webp: { icon: IconPhoto, tone: emerald },
  svg: { icon: IconPhoto, tone: amber },
  ico: { icon: IconPhoto, tone: emerald },
  zip: { icon: IconFileZip, tone: red },
  gz: { icon: IconFileZip, tone: red },
  tar: { icon: IconFileZip, tone: red },
  java: { icon: IconFileCode, tone: red },
  c: { icon: IconFileCode, tone: blue },
  h: { icon: IconFileCode, tone: purple },
  cpp: { icon: IconFileCode, tone: blue },
  cs: { icon: IconFileCode, tone: purple },
  rb: { icon: IconFileCode, tone: red },
  php: { icon: IconFileCode, tone: purple },
  swift: { icon: IconFileCode, tone: orange },
  kt: { icon: IconFileCode, tone: purple },
  vue: { icon: IconFileCode, tone: emerald },
};

const BY_NAME: Record<string, Visual> = {
  dockerfile: { icon: IconBrandDocker, tone: sky },
  ".gitignore": { icon: IconSettings, tone: orange },
  ".gitattributes": { icon: IconSettings, tone: orange },
  "package.json": { icon: IconJson, tone: emerald },
  license: { icon: IconFileText, tone: amber },
  makefile: { icon: IconTerminal2, tone: orange },
};

function visualFor(name: string): Visual {
  const lower = name.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return byName;
  if (lower.startsWith(".env")) return { icon: IconSettings, tone: yellow };
  const dot = lower.lastIndexOf(".");
  return (dot > 0 ? BY_EXTENSION[lower.slice(dot + 1)] : undefined) ?? { icon: IconFile, tone: slate };
}

export function FileIcon({ name, className }: { name: string; className?: string }) {
  const { icon: Icon, tone } = visualFor(name);
  return <Icon className={cn("size-3.5 shrink-0", tone, className)} />;
}

export function FolderIcon({ open, className }: { open?: boolean; className?: string }) {
  const Icon = open ? IconFolderOpen : IconFolder;
  return <Icon className={cn("size-3.5 shrink-0 text-amber-600 dark:text-amber-400", className)} />;
}
