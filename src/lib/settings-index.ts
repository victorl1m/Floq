/** Search index behind the Settings group of the Ctrl+K palette.
 *  One entry per Settings section plus one per SettingRow worth finding. A row entry's `id` is the
 *  `settingId` its SettingRow declares (src/components/settings/ui.tsx); e2e/settings-index.unit.mts
 *  fails when a literal SettingRow label or settingId drifts away from this list. Keep it free of
 *  React so it stays unit-testable. */
export type SettingsVisibility = { admin: boolean; desktopWindows: boolean };

export type SettingsEntry = {
    /** Section id (openSettings argument). */
    section: string;
    /** SettingRow `settingId`; absent for a section entry. */
    id?: string;
    sectionLabel: string;
    /** Row label, or the section label. */
    label: string;
    description?: string;
    keywords?: string;
    admin?: boolean;
    windowsDesktop?: boolean;
};

const SECTIONS: { section: string; label: string; keywords: string; admin?: boolean; windowsDesktop?: boolean }[] = [
    { section: "account", label: "Account", keywords: "profile name email password sign out logout" },
    { section: "organization", label: "Organization", keywords: "team workspace members role invite owner" },
    { section: "accounts", label: "LLM Providers", keywords: "claude codex openai anthropic antigravity agy gemini google login connections usage limit fallback" },
    { section: "appearance", label: "Appearance", keywords: "theme dark light material acrylic avatars cursor font" },
    { section: "performance", label: "Performance", keywords: "terminal memory scrollback motion animation speed" },
    { section: "plugins", label: "Plugins", keywords: "extensions install catalog" },
    { section: "agents", label: "Agents", keywords: "subagents approvals auto-approve default agent limits" },
    { section: "browser", label: "Browser", keywords: "chromium cookies proxy egress ip" },
    { section: "git", label: "Git & GitHub", keywords: "github repositories clone push token" },
    { section: "integrations", label: "Integrations", keywords: "whatsapp waha messages chat phone server connect built-in" },
    { section: "desktop", label: "Desktop", keywords: "windows tray startup", windowsDesktop: true },
    { section: "runtime", label: "Runtime", keywords: "server status version sessions providers" },
    { section: "advanced", label: "Advanced", keywords: "resume coauthor commits update version upgrade" },
    { section: "about", label: "About", keywords: "version updates website release" },
    { section: "users", label: "Users", keywords: "administration admin members accounts", admin: true },
];

const ROWS: { section: string; id: string; label: string; description: string; keywords?: string }[] = [
    { section: "account", id: "account-name", label: "Name", description: "Shown in the app and greetings.", keywords: "display name profile" },
    { section: "account", id: "account-password", label: "Change password", description: "Use at least 12 characters.", keywords: "security credentials" },
    { section: "account", id: "account-signout", label: "Sign out", description: "Sign out of this device.", keywords: "log out logout" },
    { section: "appearance", id: "appearance-material", label: "Material", description: "Window material: acrylic, mica or solid.", keywords: "acrylic mica blur transparency glass solid" },
    { section: "appearance", id: "appearance-theme", label: "Theme", description: "Follow the system or force light or dark.", keywords: "dark light mode color system" },
    { section: "appearance", id: "appearance-cursors", label: "Custom cursors", description: "Floq's own pointer set inside this window.", keywords: "mouse pointer system cursors" },
    { section: "appearance", id: "appearance-robot-avatars", label: "Robot avatars", description: "Give each agent its own generated Floq avatar.", keywords: "avatar agent picture icon provider logo badge" },
    { section: "appearance", id: "appearance-canvas-scroll", label: "Canvas scroll", description: "Touchpad scroll pans, pinch zooms; choose Auto, Trackpad or Mouse.", keywords: "touchpad trackpad mouse wheel pinch zoom pan gesture notebook laptop canvas memory graph" },
    { section: "appearance", id: "appearance-font-size", label: "Font size", description: "Terminal font size.", keywords: "text zoom terminal" },
    { section: "appearance", id: "appearance-cursor-style", label: "Cursor style", description: "Terminal cursor shape.", keywords: "block bar underline caret terminal" },
    { section: "appearance", id: "appearance-cursor-blink", label: "Cursor blink", description: "Terminal cursor blinking.", keywords: "caret terminal" },
    { section: "performance", id: "performance-history", label: "History profile", description: "Lines kept per terminal.", keywords: "memory ram scrollback automatic" },
    { section: "performance", id: "performance-scrollback", label: "Scrollback lines", description: "Older output is removed as new lines arrive.", keywords: "history buffer terminal" },
    { section: "performance", id: "performance-background-terminals", label: "Background terminals", description: "Hidden tabs kept loaded.", keywords: "tabs memory reload" },
    { section: "performance", id: "performance-reduce-motion", label: "Reduce interface motion", description: "Reduces interface transitions and animations.", keywords: "animation accessibility transitions" },
    { section: "performance", id: "performance-smooth-scroll", label: "Smooth terminal scrolling", description: "Adds a brief animation as new output scrolls.", keywords: "animation scroll" },
    { section: "performance", id: "performance-reduce-refresh", label: "Reduce background refresh", description: "Checks status every 30 seconds while the app is hidden.", keywords: "battery polling hidden" },
    { section: "agents", id: "agents-default", label: "Default agent", description: "Preselected in the Home composer.", keywords: "provider claude codex" },
    { section: "agents", id: "agents-always-recruit", label: "Always recruit subagents", description: "Agents split independent work across Floq subagents.", keywords: "delegate orchestrate" },
    { section: "agents", id: "agents-cross-project", label: "Allow agents to talk across projects", description: "Agents can find and message agents in other projects.", keywords: "messaging floq ask" },
    { section: "agents", id: "agents-active", label: "Active agents at once", description: "How many direct subagents one agent may have at the same time.", keywords: "limit concurrent parallel children subagents" },
    { section: "agents", id: "agents-total", label: "Total agents", description: "Most subagents across all your agents, awake or sleeping.", keywords: "limit maximum subagents" },
    { section: "agents", id: "agents-approval", label: "Your approval for irreversible actions", description: "Merging, pushing, deploying or deleting needs your approval.", keywords: "permission confirm allow deny push merge" },
    { section: "agents", id: "agents-claude-auto-approve", label: "Claude auto-approve", description: "Let Claude agents run without permission prompts.", keywords: "auto approve permissions yolo bypass" },
    { section: "agents", id: "agents-codex-auto-approve", label: "Codex auto-approve", description: "Let Codex agents run without approval prompts.", keywords: "auto approve permissions yolo bypass" },
    { section: "agents", id: "agents-opencode-auto-approve", label: "OpenCode auto-approve", description: "Let OpenCode agents run without approval prompts.", keywords: "auto approve permissions yolo bypass opencode" },
    { section: "agents", id: "agents-antigravity-auto-approve", label: "Antigravity auto-approve", description: "Let Antigravity agents run without approval prompts.", keywords: "auto approve permissions yolo bypass antigravity agy gemini" },
    { section: "browser", id: "browser-agent", label: "Agent browser", description: "One shared headless browser for your agents.", keywords: "chromium playwright mcp headless" },
    { section: "browser", id: "browser-egress", label: "Route browser traffic through this computer", description: "Websites see your own internet connection instead of Floq's server.", keywords: "ip proxy egress vpn location network" },
    { section: "browser", id: "browser-restart", label: "Restart browser", description: "Closes and reopens the browser.", keywords: "reload chromium" },
    { section: "browser", id: "browser-import", label: "Import cookies & data", description: "Import a cookies.txt, JSON cookie export or bookmarks file.", keywords: "cookies bookmarks login session cookie import" },
    { section: "browser", id: "browser-clear", label: "Clear browser data", description: "Deletes the browser profile: cookies, logins and site data.", keywords: "cookies reset delete logout" },
    { section: "accounts", id: "accounts-fallback", label: "Keep agents working", description: "When Claude hits its limit, try these in order. Otherwise the agent waits for the reset.", keywords: "usage limit fallback chain rate limit plan" },
    { section: "accounts", id: "accounts-swapback", label: "Switch back after the reset", description: "Once the agent is idle.", keywords: "usage fallback limit reset model" },
    { section: "accounts", id: "accounts-connectors", label: "Use my claude.ai connectors", description: "Claude agents can use the connectors you added at claude.ai.", keywords: "claude.ai mcp mail drive calendar" },
    { section: "accounts", id: "accounts-antigravity-google", label: "Sign in to Antigravity with Google", description: "Use your Google account (Gemini subscription) instead of an API key.", keywords: "antigravity agy gemini google oauth sign in login account disconnect api key" },
    { section: "accounts", id: "accounts-add-claude", label: "Add another Claude account", description: "A second login stays in reserve for usage limits.", keywords: "second account login switch" },
    { section: "git", id: "git-github", label: "GitHub", description: "Connect GitHub so agents can clone private repositories and push.", keywords: "git login oauth device token" },
    { section: "advanced", id: "advanced-auto-resume", label: "Resume sleeping agents when opened", description: "Clicking a sleeping agent resumes it right away.", keywords: "wake sleep click" },
    { section: "about", id: "about-app-update", label: "Check for updates", description: "Current app version, check for updates and restart into a new version.", keywords: "update upgrade version release restart app desktop" },
    { section: "about", id: "about-auto-update", label: "Update automatically", description: "Download new versions in the background.", keywords: "auto update upgrade" },
    { section: "advanced", id: "advanced-coauthor", label: "Floq co-author on commits", description: "Add a Floq co-author trailer to agent commits.", keywords: "git trailer attribution" },
    { section: "about", id: "about-updates", label: "Check for updates", description: "Compares installed versions with the latest releases.", keywords: "update upgrade version release" },
    { section: "runtime", id: "runtime-whatsapp-auto-update", label: "Update the WhatsApp server automatically", description: "Checks once a day and updates when WhatsApp has been quiet.", keywords: "whatsapp waha server update upgrade auto" },
];

export const SETTINGS_INDEX: SettingsEntry[] = (() => {
    const labelOf = new Map(SECTIONS.map((s) => [s.section, s.label]));
    const sections: SettingsEntry[] = SECTIONS.map((s) => ({
        section: s.section, sectionLabel: s.label, label: s.label, keywords: s.keywords, admin: s.admin, windowsDesktop: s.windowsDesktop,
    }));
    const rows: SettingsEntry[] = ROWS.map((r) => ({ ...r, sectionLabel: labelOf.get(r.section) ?? r.section }));
    return [...sections, ...rows];
})();

const NOISE = new Set(["settings", "setting", "preferences", "options", "config"]);
const tokens = (text: string) => text.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);

function tokenScore(token: string, words: string[], text: string): number {
    if (words.some((w) => w === token)) return 4;
    if (words.some((w) => w.startsWith(token))) return 3;
    if (token.length > 2 && text.includes(token)) return 1;
    return 0;
}

/** Score one entry for a query: 0 = no match. Every token must hit label, section, keywords or description. */
export function scoreEntry(entry: SettingsEntry, query: string): number {
    const all = tokens(query);
    const isSection = !entry.id;
    const useful = all.filter((t) => !NOISE.has(t));
    // "settings" alone lists the sections; row entries need a real term.
    if (!isSection && useful.length === 0) return 0;
    const toks = isSection ? all : useful;
    if (toks.length === 0) return 0;
    const labelWords = tokens(entry.label);
    const sectionWords = tokens(entry.sectionLabel);
    const keyWords = tokens(entry.keywords ?? "");
    const descText = (entry.description ?? "").toLowerCase();
    let total = 0;
    for (const t of toks) {
        const isNoise = NOISE.has(t);
        let best = Math.max(
            tokenScore(t, labelWords, entry.label.toLowerCase()) * 3,
            tokenScore(t, keyWords, (entry.keywords ?? "").toLowerCase()) * (isSection ? 1 : 2),
            tokenScore(t, sectionWords, entry.sectionLabel.toLowerCase()) * (isSection ? 3 : 1),
            descText.includes(t) ? 1 : 0,
        );
        if (isNoise) best = Math.max(best, 4); // sections are always "settings"
        if (best === 0) return 0;
        total += best;
    }
    const byName = toks.every((t) => NOISE.has(t) || tokenScore(t, labelWords, entry.label.toLowerCase()) > 0);
    return total + (isSection && byName ? 6 : 0);
}

export function visibleEntries(vis: SettingsVisibility): SettingsEntry[] {
    const hidden = new Set(SECTIONS.filter((s) => (s.admin && !vis.admin) || (s.windowsDesktop && !vis.desktopWindows)).map((s) => s.section));
    return SETTINGS_INDEX.filter((e) => !hidden.has(e.section));
}

export function searchSettings(query: string, vis: SettingsVisibility, limit = 8): SettingsEntry[] {
    if (!query.trim()) return [];
    return visibleEntries(vis)
        .map((entry, order) => ({ entry, order, score: scoreEntry(entry, query) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .slice(0, limit)
        .map((r) => r.entry);
}

/** Row waiting to be scrolled to once the Settings dialog has rendered its section. */
let pending: string | null = null;
export const SETTING_FOCUS_EVENT = "floq:setting-focus";
export function requestSettingFocus(id: string | undefined): void {
    pending = id ?? null;
    if (typeof window !== "undefined") window.dispatchEvent(new Event(SETTING_FOCUS_EVENT));
}
export function takeSettingFocus(): string | null {
    const id = pending;
    pending = null;
    return id;
}
export function peekSettingFocus(): string | null {
    return pending;
}
