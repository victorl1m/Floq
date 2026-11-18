import {
  IconAlertTriangle, IconBell, IconBolt, IconBrandAzure, IconBrandGithub, IconBrandWhatsapp, IconBug, IconCalendar, IconChartBar, IconChecklist, IconClipboardList,
  IconCloud, IconCode, IconDatabase, IconFileText, IconFolder, IconHeadset, IconInbox, IconLink, IconListDetails, IconMail, IconMessage, IconMessages, IconPlug,
  IconPlugConnected, IconRefresh, IconSearch, IconSend, IconSettings, IconStar, IconTag, IconTicket, IconTrash, IconUsers, IconWorld,
} from "@tabler/icons-react";

type Icon = typeof IconPlug;

/**
 * Manifests name Tabler icons as strings. A curated map (not `import *`) keeps the bundle tree-shaken; add an icon here when a plugin needs one.
 * Unknown names fall back to the plug icon.
 */
export const PLUGIN_ICONS: Record<string, Icon> = {
  IconAlertTriangle, IconBell, IconBolt, IconBrandAzure, IconBrandGithub, IconBrandWhatsapp, IconBug, IconCalendar, IconChartBar, IconChecklist, IconClipboardList,
  IconCloud, IconCode, IconDatabase, IconFileText, IconFolder, IconHeadset, IconInbox, IconLink, IconListDetails, IconMail, IconMessage, IconMessages, IconPlug,
  IconPlugConnected, IconRefresh, IconSearch, IconSend, IconSettings, IconStar, IconTag, IconTicket, IconTrash, IconUsers, IconWorld,
};

export const resolvePluginIcon = (name?: string): Icon => (name && Object.prototype.hasOwnProperty.call(PLUGIN_ICONS, name) ? PLUGIN_ICONS[name] : IconPlug);
