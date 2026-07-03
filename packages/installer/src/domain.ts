import { z } from "zod";

const safeRelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.startsWith("/") && !value.startsWith("\\"), {
    message: "Path must be relative"
  })
  .refine(
    (value) =>
      value
        .split(/[\\/]/)
        .every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    { message: "Path contains an unsafe segment" }
  );

const publicHttpsUrlSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Git URL must use HTTPS" });
  }
  if (url.username || url.password) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Git URL must not contain credentials"
    });
  }
});

export const installationSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("folder"),
    label: z.string().min(1).max(200)
  }),
  z.object({
    kind: z.literal("zip"),
    fileName: z.string().min(1).max(255)
  }),
  z.object({
    kind: z.literal("git"),
    url: publicHttpsUrlSchema,
    ref: z.string().min(1).max(200).optional(),
    subdirectory: safeRelativePathSchema.optional()
  })
]);

export type InstallationSource = z.infer<typeof installationSourceSchema>;

export class InstallerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InstallerError";
    this.code = code;
  }
}
