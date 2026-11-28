/**
 * The only UI surface plugin code may import (enforced by scripts/dev/test-plugin-imports.mjs). It re-exports the shared owners named in
 * docs/UX-CONTRACT.md, so their behavior, theming and checks carry over, plus the plugin compositions below.
 */
export * from "@/components/ui/button";
export * from "@/components/ui/badge";
export * from "@/components/ui/card";
export * from "@/components/ui/table";
export * from "@/components/ui/empty";
export * from "@/components/ui/field";
export * from "@/components/ui/input";
export * from "@/components/ui/textarea";
export * from "@/components/ui/select";
export * from "@/components/ui/switch";
export * from "@/components/ui/checkbox";
export * from "@/components/ui/tabs";
export * from "@/components/ui/tooltip";
export * from "@/components/ui/dialog";
export * from "@/components/ui/alert-dialog";
export * from "@/components/ui/sheet";
export * from "@/components/ui/dropdown-menu";
export * from "@/components/ui/skeleton";
export * from "@/components/ui/kbd";
export { toast } from "sonner";
export { cn } from "cn";

export { VoicePlayer, type VoicePlayerProps } from "@/components/audio/voice-player";
export { claimPlayback, decodeWaveform, nextPlaybackRate, placeholderPeaks, PLAYBACK_RATES, WAVEFORM_BARS } from "@/lib/audio-playback";
export { PluginPage } from "./plugin-page";
export { PluginState, type PluginStateKind, type PluginStateProps } from "./plugin-state";
export { PluginSettingsForm } from "./plugin-settings-form";
export { ExternalTaskRow, StatusCategoryBadge, STATUS_CATEGORY_LABEL } from "./external-task-row";
export { PluginBoundary, usePlugins, usePluginEvent, usePluginApi } from "@/plugins/host";
export { resolvePluginIcon } from "@/plugins/icons";
export { usePluginDownload } from "./plugin-download";
