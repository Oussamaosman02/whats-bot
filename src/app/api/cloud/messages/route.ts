import { route, ok, z } from "@/lib/api";
import { metaCloud } from "@/lib/meta/cloud";

/** POST /api/cloud/messages {to, text | template:{name,language,components}, group?} */
export const POST = route(async ({ body }) => {
  const b = await body(z.object({ to: z.string(), text: z.string().optional(), template: z.object({ name: z.string(), language: z.string(), components: z.array(z.unknown()).optional() }).optional(), group: z.boolean().default(false), previewUrl: z.boolean().optional() }).refine((v) => v.text || v.template, "Provide text or template"));
  const res = b.template ? await metaCloud.sendTemplate(b.to, b.template, { group: b.group }) : await metaCloud.sendText(b.to, b.text!, { group: b.group, previewUrl: b.previewUrl });
  return ok(res);
});
