import { z } from "zod";
import { normalizeBaseUrl } from "@/lib/runtime/client";

function isHttpUrl(value: string): boolean {
    try {
        const url = new URL(normalizeBaseUrl(value));
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

export const emailSchema = z.object({
    serverUrl: z
        .string()
        .trim()
        .min(1, "Enter the runtime URL")
        .refine(isHttpUrl, "Enter a valid http(s) URL"),
    email: z.string().trim().min(1, "Enter your email").email("Enter a valid email"),
});
export type EmailValues = z.infer<typeof emailSchema>;

export const passwordSchema = z.object({
    password: z.string().min(1, "Enter your password"),
});
export type PasswordValues = z.infer<typeof passwordSchema>;

export const MIN_PASSWORD = 12;

export const setupSchema = z
    .object({
        name: z.string().trim().max(100, "Name is too long").optional(),
        password: z
            .string()
            .min(MIN_PASSWORD, `At least ${MIN_PASSWORD} characters.`)
            .max(128, "At most 128 characters."),
        confirm: z.string(),
    })
    .refine((v) => v.confirm === v.password, {
        path: ["confirm"],
        message: "Passwords don't match",
    });
export type SetupValues = z.infer<typeof setupSchema>;
